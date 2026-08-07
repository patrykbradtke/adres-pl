/**
 * Ladowanie zrodla zapasowego (iMPA i inne zrodla tabelaryczne)
 * oraz raport rozbieznosci wobec PRG.
 *
 * Zrodlo zapasowe pelni DWIE role i warto je rozroznic:
 *
 *  1. RAPORT ROZBIEZNOSCI - domyslna. Nie zmienia danych produktowych,
 *     tylko pokazuje, czego PRG nie ma. To jest bezpieczne i przydatne
 *     nawet zanim wyjasnimy licencje.
 *
 *  2. UZUPELNIENIE - opcjonalna, wlaczana jawnie. Punkty obecne wylacznie
 *     w zrodle zapasowym trafiaja do bazy z oznaczeniem zrodla.
 *     Wymaga potwierdzonej licencji.
 *
 * Domyslnie dziala tylko rola pierwsza.
 */
import type pg from 'pg';
import type { Readable } from 'node:stream';
import { readTabular, type TabularProfile, type TabularStats } from '../sources/tabular.ts';
import { IMPA_MAX_ONLY_FRAC } from '../sources/impa.ts';
import { toWgs84, srsToEpsg } from '../gml/parser.ts';
import {
  normalizeText, titleCasePl, cleanText,
  normalizeBuildingNumber, buildingNumberKey, buildingSortKey,
} from '@adres-pl/core';

export interface ImpaLoadOptions {
  pool: pg.Pool;
  profile: TabularProfile;
  zrodlo: string;
  zrodloWersja: string;
  /**
   * Gdy false (domyslnie), dane trafiaja WYLACZNIE do tabeli porownawczej
   * i nie modyfikuja danych produktowych.
   */
  uzupelniaj?: boolean;
  onProgress?: (n: number) => void;
}

export interface ImpaLoadStats {
  wierszy: number;
  zaladowane: number;
  odrzucone: number;
  powodyOdrzucen: Record<string, number>;
  bezGeometrii: number;
  tabular: TabularStats;
  czasS: number;
}

/** Tabela porownawcza - tworzona na zadanie, nie w migracji podstawowej. */
export const SQL_COMPARE_TABLE = `
CREATE SCHEMA IF NOT EXISTS porownanie;

CREATE TABLE IF NOT EXISTS porownanie.punkt_zewnetrzny (
  id            bigserial PRIMARY KEY,
  zrodlo        text NOT NULL,
  zrodlo_wersja text NOT NULL,
  zrodlo_id     text,
  simc          char(7),
  miejscowosc   text,
  miejscowosc_norm text,
  ulica         text,
  ulica_norm    text,
  cecha         text,
  nr_budynku    text NOT NULL,
  nr_key        text NOT NULL,
  kod_pocztowy  char(6),
  geom          geography(Point, 4326),
  pobrano       timestamptz NOT NULL DEFAULT now(),
  -- DWA klucze dopasowania, nie jeden.
  --
  -- Zrodla zewnetrzne bywaja niekompletne: jedne podaja SIMC, inne tylko
  -- nazwe miejscowosci. Pojedynczy klucz zmusza do wyboru, ktory oznacza
  -- ciche zgubienie dopasowan dla drugiej grupy.
  --
  -- Dopasowujemy najpierw po SIMC (jednoznaczne, odporne na duplikaty nazw
  -- typu "Nowa Wies"), a gdy go brak - po znormalizowanej nazwie.
  klucz_simc    text,
  klucz_nazwa   text NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_pz_ksimc  ON porownanie.punkt_zewnetrzny(klucz_simc);
CREATE INDEX IF NOT EXISTS ix_pz_knazwa ON porownanie.punkt_zewnetrzny(klucz_nazwa);
CREATE INDEX IF NOT EXISTS ix_pz_zrodlo ON porownanie.punkt_zewnetrzny(zrodlo, zrodlo_wersja);
CREATE INDEX IF NOT EXISTS ix_pz_simc   ON porownanie.punkt_zewnetrzny(simc);

COMMENT ON SCHEMA porownanie IS
  'Dane ze zrodel zapasowych i porownawczych. Domyslnie NIE zasilaja danych '
  'produktowych - sluza do wykrywania luk w rejestrze PRG. Zrodla o niejasnej '
  'lub restrykcyjnej licencji (iMPA, ODbL) moga trafiac wylacznie tutaj.';
`;

/**
 * Klucze dopasowania miedzy zrodlami.
 *
 * MUSZA byc liczone IDENTYCZNIE po obu stronach - w SQL nizej sa dokladne
 * odpowiedniki tych wyrazen. Rozjechanie sie ich daje diff pokazujacy
 * 100% rozbieznosci przy danych, ktore sa w rzeczywistosci zgodne.
 */
export function matchKeySimc(
  simc: string,
  ulica: string | undefined,
  nrBudynku: string,
): string {
  return [simc, ulica ? normalizeText(ulica) : '', buildingNumberKey(nrBudynku)].join('|');
}

export function matchKeyNazwa(
  miejscowosc: string,
  ulica: string | undefined,
  nrBudynku: string,
): string {
  return [
    normalizeText(miejscowosc),
    ulica ? normalizeText(ulica) : '',
    buildingNumberKey(nrBudynku),
  ].join('|');
}

export async function loadTabularSource(
  openStream: () => Promise<Readable>,
  opts: ImpaLoadOptions,
): Promise<ImpaLoadStats> {
  const t0 = Date.now();
  const stats: ImpaLoadStats = {
    wierszy: 0, zaladowane: 0, odrzucone: 0, powodyOdrzucen: {},
    bezGeometrii: 0, tabular: null as any, czasS: 0,
  };

  await opts.pool.query(SQL_COMPARE_TABLE);
  const client = await opts.pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM porownanie.punkt_zewnetrzny WHERE zrodlo = $1 AND zrodlo_wersja = $2`,
      [opts.zrodlo, opts.zrodloWersja],
    );

    const odrzuc = (powod: string) => {
      stats.odrzucone++;
      stats.powodyOdrzucen[powod] = (stats.powodyOdrzucen[powod] ?? 0) + 1;
    };

    stats.tabular = await readTabular(await openStream(), opts.profile, async (row) => {
      const nrRaw = row.get('nrBudynku');
      if (!nrRaw) { odrzuc('brak numeru'); return; }

      const miejscowoscRaw = row.get('miejscowosc');
      const simc = row.get('simc')?.replace(/\D/g, '').padStart(7, '0');
      if (!miejscowoscRaw && !simc) { odrzuc('brak miejscowosci i SIMC'); return; }

      const miejscowosc = miejscowoscRaw ? titleCasePl(cleanText(miejscowoscRaw)) : '';
      const ulicaRaw = row.get('ulica');
      const ulica = ulicaRaw ? titleCasePl(cleanText(ulicaRaw)) : undefined;
      const nr = normalizeBuildingNumber(cleanText(nrRaw));

      // Wspolrzedne: albo gotowe lat/lon, albo X/Y w ukladzie lokalnym
      let lat = row.num('lat');
      let lon = row.num('lon');
      if (lat === undefined || lon === undefined) {
        const x = row.num('x');
        const y = row.num('y');
        if (x !== undefined && y !== undefined) {
          const srid = row.num('srid') ?? opts.profile.defaultSrid ?? 2180;
          // Pliki tabelaryczne nie niosa deklaracji kolejnosci osi, wiec
          // opieramy sie wylacznie na weryfikacji zasiegiem Polski.
          const w = toWgs84(x, y, srsToEpsg(String(srid)));
          if (w) { lat = w.lat; lon = w.lon; }
        }
      }
      if (lat === undefined || lon === undefined) stats.bezGeometrii++;

      const kod = row.get('kodPocztowy')?.replace(/\s/g, '');
      const kSimc = simc && /^\d{7}$/.test(simc) ? matchKeySimc(simc, ulica, nr) : null;
      const kNazwa = matchKeyNazwa(miejscowosc, ulica, nr);

      await client.query(
        `INSERT INTO porownanie.punkt_zewnetrzny
           (zrodlo, zrodlo_wersja, zrodlo_id, simc, miejscowosc, miejscowosc_norm,
            ulica, ulica_norm, cecha, nr_budynku, nr_key, kod_pocztowy, geom,
            klucz_simc, klucz_nazwa)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          opts.zrodlo, opts.zrodloWersja, row.get('id') ?? null,
          simc && /^\d{7}$/.test(simc) ? simc : null,
          miejscowosc || null, miejscowosc ? normalizeText(miejscowosc) : null,
          ulica ?? null, ulica ? normalizeText(ulica) : null,
          row.get('cecha') ?? null,
          nr, buildingNumberKey(nr),
          kod && /^\d{2}-\d{3}$/.test(kod) ? kod : null,
          lat !== undefined && lon !== undefined ? `SRID=4326;POINT(${lon} ${lat})` : null,
          kSimc, kNazwa,
        ],
      );
      stats.zaladowane++;
      if (stats.zaladowane % 50_000 === 0) opts.onProgress?.(stats.zaladowane);
    });

    stats.wierszy = stats.tabular.wierszy;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  stats.czasS = Math.round((Date.now() - t0) / 1000);
  return stats;
}

export interface DiffReport {
  zrodlo: string;
  wersja: string;
  wZrodle: number;
  wPrg: number;
  /** Punkty obecne w obu zrodlach. */
  wspolne: number;
  /** Obecne tylko w zrodle zapasowym - potencjalne luki w PRG. */
  tylkoZrodlo: number;
  tylkoZrodloFrac: number;
  /** Rozbieznosci kodu pocztowego dla tego samego adresu. */
  rozneKody: number;
  /** Reprezentatywna probka luk do przegladu recznego. */
  probka: Array<{ miejscowosc: string; ulica: string | null; nr: string; kod: string | null }>;
  /** Gminy z najwieksza liczba luk - wskazuja, gdzie PRG nie nadaza. */
  gminy: Array<{ gmina: string; luk: number }>;
  ostrzezenia: string[];
}

/**
 * Porownanie zrodla zapasowego z PRG.
 *
 * To jest glowna wartosc tego modulu: odpowiada na pytanie "czego PRG nie ma",
 * nie modyfikujac przy tym niczego w danych produktowych.
 */
export async function diffAgainstPrg(
  pool: pg.Pool,
  zrodlo: string,
  wersja: string,
): Promise<DiffReport> {
  // Widok PRG z OBOMA kluczami - odpowiedniki matchKeySimc / matchKeyNazwa
  const PRG_KEYS = `
    SELECT
      concat_ws('|', p.simc, COALESCE(u.nazwa_norm,''), p.nr_key)     AS klucz_simc,
      concat_ws('|', m.nazwa_norm, COALESCE(u.nazwa_norm,''), p.nr_key) AS klucz_nazwa
      FROM adres.punkt_adresowy p
      JOIN adres.miejscowosc m ON m.simc = p.simc
      LEFT JOIN adres.ulica u  ON u.ulic_id = p.ulic_id
     WHERE p.wycofany_od IS NULL`;

  /** Warunek "ten punkt zrodla ma odpowiednik w PRG". */
  const MATCH = `EXISTS (
      SELECT 1 FROM (${PRG_KEYS}) k
       WHERE (z.klucz_simc IS NOT NULL AND k.klucz_simc = z.klucz_simc)
          OR (z.klucz_simc IS NULL     AND k.klucz_nazwa = z.klucz_nazwa))`;

  const { rows: [c] } = await pool.query<{ w_zrodle: string; w_prg: string; wspolne: string }>(`
    SELECT
      (SELECT count(*) FROM porownanie.punkt_zewnetrzny z
        WHERE z.zrodlo = $1 AND z.zrodlo_wersja = $2)::text AS w_zrodle,
      (SELECT count(*) FROM (${PRG_KEYS}) q)::text          AS w_prg,
      (SELECT count(*) FROM porownanie.punkt_zewnetrzny z
        WHERE z.zrodlo = $1 AND z.zrodlo_wersja = $2 AND ${MATCH})::text AS wspolne
  `, [zrodlo, wersja]);

  const wZrodle = Number(c.w_zrodle);
  const wPrg = Number(c.w_prg);
  const wspolne = Number(c.wspolne);
  const tylkoZrodlo = wZrodle - wspolne;

  const { rows: probka } = await pool.query<{
    miejscowosc: string; ulica: string | null; nr_budynku: string; kod_pocztowy: string | null;
  }>(`
    SELECT z.miejscowosc, z.ulica, z.nr_budynku, z.kod_pocztowy
      FROM porownanie.punkt_zewnetrzny z
     WHERE z.zrodlo = $1 AND z.zrodlo_wersja = $2 AND NOT ${MATCH}
     ORDER BY z.miejscowosc, z.ulica, z.nr_budynku
     LIMIT 25
  `, [zrodlo, wersja]);

  const { rows: gminy } = await pool.query<{ gmina: string; luk: string }>(`
    SELECT COALESCE(g.nazwa, z.miejscowosc, '(nieznana)') AS gmina, count(*)::text AS luk
      FROM porownanie.punkt_zewnetrzny z
      LEFT JOIN adres.miejscowosc m ON m.simc = z.simc
      LEFT JOIN adres.teryt_jednostka g ON g.terc = m.terc_gminy
     WHERE z.zrodlo = $1 AND z.zrodlo_wersja = $2 AND NOT ${MATCH}
     GROUP BY 1 ORDER BY count(*) DESC LIMIT 10
  `, [zrodlo, wersja]);

  const { rows: [k] } = await pool.query<{ n: string }>(`
    SELECT count(*)::text n
      FROM porownanie.punkt_zewnetrzny z
      JOIN adres.punkt_adresowy p ON p.wycofany_od IS NULL
      JOIN adres.miejscowosc m ON m.simc = p.simc
      LEFT JOIN adres.ulica u  ON u.ulic_id = p.ulic_id
     WHERE z.zrodlo = $1 AND z.zrodlo_wersja = $2
       AND ((z.klucz_simc IS NOT NULL
             AND concat_ws('|', p.simc, COALESCE(u.nazwa_norm,''), p.nr_key) = z.klucz_simc)
         OR (z.klucz_simc IS NULL
             AND concat_ws('|', m.nazwa_norm, COALESCE(u.nazwa_norm,''), p.nr_key) = z.klucz_nazwa))
       AND z.kod_pocztowy IS NOT NULL AND p.kod_pocztowy IS NOT NULL
       AND z.kod_pocztowy <> p.kod_pocztowy
  `, [zrodlo, wersja]);

  const frac = wZrodle > 0 ? tylkoZrodlo / wZrodle : 0;
  const ostrzezenia: string[] = [];

  if (frac > IMPA_MAX_ONLY_FRAC) {
    ostrzezenia.push(
      `${(frac * 100).toFixed(1)}% punktow zrodla nie ma odpowiednika w PRG ` +
      `(prog ${(IMPA_MAX_ONLY_FRAC * 100).toFixed(0)}%). ` +
      `Przy tej skali bardziej prawdopodobne jest rozjechane dopasowanie kluczy ` +
      `niz realna luka w rejestrze panstwowym. Sprawdz normalizacje nazw ulic ` +
      `i numerow po obu stronach, zanim uznasz to za luki.`,
    );
  }
  if (Number(k.n) > 0) {
    ostrzezenia.push(
      `${Number(k.n).toLocaleString('pl')} adresow ma rozny kod pocztowy w obu zrodlach. ` +
      `To zjawisko normalne - kody w PRG pochodza z ewidencji gminnych, nie od Poczty Polskiej.`,
    );
  }
  if (stats0(wZrodle)) {
    ostrzezenia.push('Zrodlo nie zawiera zadnych punktow - sprawdz profil kolumn trybem rozpoznawania.');
  }

  return {
    zrodlo, wersja, wZrodle, wPrg, wspolne, tylkoZrodlo,
    tylkoZrodloFrac: frac,
    rozneKody: Number(k.n),
    probka: probka.map((p) => ({
      miejscowosc: p.miejscowosc, ulica: p.ulica, nr: p.nr_budynku, kod: p.kod_pocztowy,
    })),
    gminy: gminy.map((g) => ({ gmina: g.gmina, luk: Number(g.luk) })),
    ostrzezenia,
  };
}

function stats0(n: number): boolean { return n === 0; }

export function formatDiffReport(r: DiffReport): string {
  const l: string[] = [];
  l.push(`Porownanie: ${r.zrodlo} (${r.wersja}) vs PRG`);
  l.push('');
  l.push(`  punktow w zrodle:      ${r.wZrodle.toLocaleString('pl')}`);
  l.push(`  punktow w PRG:         ${r.wPrg.toLocaleString('pl')}`);
  l.push(`  wspolnych:             ${r.wspolne.toLocaleString('pl')}`);
  l.push(`  tylko w zrodle:        ${r.tylkoZrodlo.toLocaleString('pl')} (${(r.tylkoZrodloFrac * 100).toFixed(2)}%)`);
  l.push(`  rozny kod pocztowy:    ${r.rozneKody.toLocaleString('pl')}`);

  if (r.gminy.length) {
    l.push('');
    l.push('  Gminy z najwieksza liczba luk:');
    for (const g of r.gminy) l.push(`    ${String(g.luk).padStart(8)}  ${g.gmina}`);
  }
  if (r.probka.length) {
    l.push('');
    l.push('  Probka adresow nieobecnych w PRG:');
    for (const p of r.probka.slice(0, 10)) {
      l.push(`    ${[p.miejscowosc, p.ulica, p.nr].filter(Boolean).join(', ')}${p.kod ? '  ' + p.kod : ''}`);
    }
  }
  if (r.ostrzezenia.length) {
    l.push('');
    l.push('  Ostrzezenia:');
    for (const o of r.ostrzezenia) l.push(`    ! ${o}`);
  }
  return l.join('\n');
}
