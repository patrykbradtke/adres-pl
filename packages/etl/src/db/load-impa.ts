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
  source: string;
  sourceVersion: string;
  /**
   * Gdy false (domyslnie), dane trafiaja WYLACZNIE do tabeli porownawczej
   * i nie modyfikuja danych produktowych.
   */
  uzupelniaj?: boolean;
  onProgress?: (n: number) => void;
}

export interface ImpaLoadStats {
  rows: number;
  loaded: number;
  rejected: number;
  rejectReasons: Record<string, number>;
  geometryMissing: number;
  tabular: TabularStats;
  durationSeconds: number;
}

/** Tabela porownawcza - tworzona na zadanie, nie w migracji podstawowej. */
export const SQL_COMPARE_TABLE = `
CREATE SCHEMA IF NOT EXISTS porownanie;

CREATE TABLE IF NOT EXISTS porownanie.punkt_zewnetrzny (
  id            bigserial PRIMARY KEY,
  source        text NOT NULL,
  source_version text NOT NULL,
  zrodlo_id     text,
  simc          char(7),
  locality   text,
  miejscowosc_norm text,
  street         text,
  street_norm    text,
  street_type         text,
  building_number    text NOT NULL,
  building_number_key        text NOT NULL,
  postal_code  char(6),
  geom          geography(Point, 4326),
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  -- DWA klucze dopasowania, nie jeden.
  --
  -- Zrodla zewnetrzne bywaja niekompletne: jedne podaja SIMC, inne tylko
  -- nazwe localities. Pojedynczy klucz zmusza do wyboru, ktory oznacza
  -- ciche zgubienie dopasowan dla drugiej grupy.
  --
  -- Dopasowujemy najpierw po SIMC (jednoznaczne, odporne na duplikaty nazw
  -- typu "Nowa Wies"), a gdy go brak - po znormalizowanej nazwie.
  klucz_simc    text,
  klucz_nazwa   text NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_pz_ksimc  ON porownanie.punkt_zewnetrzny(klucz_simc);
CREATE INDEX IF NOT EXISTS ix_pz_knazwa ON porownanie.punkt_zewnetrzny(klucz_nazwa);
CREATE INDEX IF NOT EXISTS ix_pz_zrodlo ON porownanie.punkt_zewnetrzny(source, source_version);
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
  street: string | undefined,
  buildingNumber: string,
): string {
  return [simc, street ? normalizeText(street) : '', buildingNumberKey(buildingNumber)].join('|');
}

export function matchKeyName(
  locality: string,
  street: string | undefined,
  buildingNumber: string,
): string {
  return [
    normalizeText(locality),
    street ? normalizeText(street) : '',
    buildingNumberKey(buildingNumber),
  ].join('|');
}

export async function loadTabularSource(
  openStream: () => Promise<Readable>,
  opts: ImpaLoadOptions,
): Promise<ImpaLoadStats> {
  const t0 = Date.now();
  const stats: ImpaLoadStats = {
    rows: 0, loaded: 0, rejected: 0, rejectReasons: {},
    geometryMissing: 0, tabular: null as any, durationSeconds: 0,
  };

  await opts.pool.query(SQL_COMPARE_TABLE);
  const client = await opts.pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM porownanie.punkt_zewnetrzny WHERE source = $1 AND source_version = $2`,
      [opts.source, opts.sourceVersion],
    );

    const reject = (reason: string) => {
      stats.rejected++;
      stats.rejectReasons[reason] = (stats.rejectReasons[reason] ?? 0) + 1;
    };

    stats.tabular = await readTabular(await openStream(), opts.profile, async (row) => {
      const nrRaw = row.get('buildingNumber');
      if (!nrRaw) { reject('brak numeru'); return; }

      const localityRaw = row.get('locality');
      const simc = row.get('simc')?.replace(/\D/g, '').padStart(7, '0');
      if (!localityRaw && !simc) { reject('brak miejscowosci i SIMC'); return; }

      const locality = localityRaw ? titleCasePl(cleanText(localityRaw)) : '';
      const streetRaw = row.get('street');
      const street = streetRaw ? titleCasePl(cleanText(streetRaw)) : undefined;
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
      if (lat === undefined || lon === undefined) stats.geometryMissing++;

      const code = row.get('postalCode')?.replace(/\s/g, '');
      const kSimc = simc && /^\d{7}$/.test(simc) ? matchKeySimc(simc, street, nr) : null;
      const nameKey = matchKeyName(locality, street, nr);

      await client.query(
        `INSERT INTO porownanie.punkt_zewnetrzny
           (source, source_version, zrodlo_id, simc, locality, miejscowosc_norm,
            street, street_norm, street_type, building_number, building_number_key, postal_code, geom,
            klucz_simc, klucz_nazwa)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          opts.source, opts.sourceVersion, row.get('id') ?? null,
          simc && /^\d{7}$/.test(simc) ? simc : null,
          locality || null, locality ? normalizeText(locality) : null,
          street ?? null, street ? normalizeText(street) : null,
          row.get('streetType') ?? null,
          nr, buildingNumberKey(nr),
          code && /^\d{2}-\d{3}$/.test(code) ? code : null,
          lat !== undefined && lon !== undefined ? `SRID=4326;POINT(${lon} ${lat})` : null,
          kSimc, nameKey,
        ],
      );
      stats.loaded++;
      if (stats.loaded % 50_000 === 0) opts.onProgress?.(stats.loaded);
    });

    stats.rows = stats.tabular.rows;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  stats.durationSeconds = Math.round((Date.now() - t0) / 1000);
  return stats;
}

export interface DiffReport {
  source: string;
  version: string;
  inSource: number;
  wPrg: number;
  /** Punkty obecne w obu zrodlach. */
  shared: number;
  /** Obecne tylko w zrodle zapasowym - potencjalne luki w PRG. */
  sourceOnly: number;
  sourceOnlyFrac: number;
  /** Rozbieznosci kodu pocztowego dla tego samego adresu. */
  differentCodes: number;
  /** Reprezentatywna probka luk do przegladu recznego. */
  sample: Array<{ locality: string; street: string | null; nr: string; code: string | null }>;
  /** Gminy z najwieksza liczba luk - wskazuja, gdzie PRG nie nadaza. */
  gminy: Array<{ gmina: string; luk: number }>;
  warnings: string[];
}

/**
 * Porownanie zrodla zapasowego z PRG.
 *
 * To jest glowna wartosc tego modulu: odpowiada na pytanie "czego PRG nie ma",
 * nie modyfikujac przy tym niczego w danych produktowych.
 */
export async function diffAgainstPrg(
  pool: pg.Pool,
  source: string,
  version: string,
): Promise<DiffReport> {
  // Widok PRG z OBOMA kluczami - odpowiedniki matchKeySimc / matchKeyNazwa
  const PRG_KEYS = `
    SELECT
      concat_ws('|', p.simc, COALESCE(u.name_norm,''), p.building_number_key)     AS klucz_simc,
      concat_ws('|', m.name_norm, COALESCE(u.name_norm,''), p.building_number_key) AS klucz_nazwa
      FROM address.address_point p
      JOIN address.locality m ON m.simc = p.simc
      LEFT JOIN address.street u  ON u.ulic_id = p.ulic_id
     WHERE p.withdrawn_at IS NULL`;

  /** Warunek "ten punkt zrodla ma odpowiednik w PRG". */
  const MATCH = `EXISTS (
      SELECT 1 FROM (${PRG_KEYS}) k
       WHERE (z.klucz_simc IS NOT NULL AND k.klucz_simc = z.klucz_simc)
          OR (z.klucz_simc IS NULL     AND k.klucz_nazwa = z.klucz_nazwa))`;

  const { rows: [c] } = await pool.query<{ in_source: string; w_prg: string; shared: string }>(`
    SELECT
      (SELECT count(*) FROM porownanie.punkt_zewnetrzny z
        WHERE z.source = $1 AND z.source_version = $2)::text AS in_source,
      (SELECT count(*) FROM (${PRG_KEYS}) q)::text          AS w_prg,
      (SELECT count(*) FROM porownanie.punkt_zewnetrzny z
        WHERE z.source = $1 AND z.source_version = $2 AND ${MATCH})::text AS shared
  `, [source, version]);

  const inSource = Number(c.in_source);
  const wPrg = Number(c.w_prg);
  const shared = Number(c.shared);
  const sourceOnly = inSource - shared;

  const { rows: sample } = await pool.query<{
    locality: string; street: string | null; building_number: string; postal_code: string | null;
  }>(`
    SELECT z.locality, z.street, z.building_number, z.postal_code
      FROM porownanie.punkt_zewnetrzny z
     WHERE z.source = $1 AND z.source_version = $2 AND NOT ${MATCH}
     ORDER BY z.locality, z.street, z.building_number
     LIMIT 25
  `, [source, version]);

  const { rows: gminy } = await pool.query<{ gmina: string; luk: string }>(`
    SELECT COALESCE(g.name, z.locality, '(nieznana)') AS gmina, count(*)::text AS luk
      FROM porownanie.punkt_zewnetrzny z
      LEFT JOIN address.locality m ON m.simc = z.simc
      LEFT JOIN address.teryt_unit g ON g.terc = m.gmina_terc
     WHERE z.source = $1 AND z.source_version = $2 AND NOT ${MATCH}
     GROUP BY 1 ORDER BY count(*) DESC LIMIT 10
  `, [source, version]);

  const { rows: [k] } = await pool.query<{ n: string }>(`
    SELECT count(*)::text n
      FROM porownanie.punkt_zewnetrzny z
      JOIN address.address_point p ON p.withdrawn_at IS NULL
      JOIN address.locality m ON m.simc = p.simc
      LEFT JOIN address.street u  ON u.ulic_id = p.ulic_id
     WHERE z.source = $1 AND z.source_version = $2
       AND ((z.klucz_simc IS NOT NULL
             AND concat_ws('|', p.simc, COALESCE(u.name_norm,''), p.building_number_key) = z.klucz_simc)
         OR (z.klucz_simc IS NULL
             AND concat_ws('|', m.name_norm, COALESCE(u.name_norm,''), p.building_number_key) = z.klucz_nazwa))
       AND z.postal_code IS NOT NULL AND p.postal_code IS NOT NULL
       AND z.postal_code <> p.postal_code
  `, [source, version]);

  const frac = inSource > 0 ? sourceOnly / inSource : 0;
  const warnings: string[] = [];

  if (frac > IMPA_MAX_ONLY_FRAC) {
    warnings.push(
      `${(frac * 100).toFixed(1)}% punktow zrodla nie ma odpowiednika w PRG ` +
      `(prog ${(IMPA_MAX_ONLY_FRAC * 100).toFixed(0)}%). ` +
      `Przy tej skali bardziej prawdopodobne jest rozjechane dopasowanie kluczy ` +
      `niz realna luka w rejestrze panstwowym. Sprawdz normalizacje nazw ulic ` +
      `i numerow po obu stronach, zanim uznasz to za luki.`,
    );
  }
  if (Number(k.n) > 0) {
    warnings.push(
      `${Number(k.n).toLocaleString('pl')} adresow ma rozny kod pocztowy w obu zrodlach. ` +
      `To zjawisko normalne - kody w PRG pochodza z ewidencji gminnych, nie od Poczty Polskiej.`,
    );
  }
  if (statsBefore(inSource)) {
    warnings.push('Zrodlo nie zawiera zadnych punktow - sprawdz profile kolumn trybem rozpoznawania.');
  }

  return {
    source, version, inSource, wPrg, shared, sourceOnly,
    sourceOnlyFrac: frac,
    differentCodes: Number(k.n),
    sample: sample.map((p) => ({
      locality: p.locality, street: p.street, nr: p.building_number, code: p.postal_code,
    })),
    gminy: gminy.map((g) => ({ gmina: g.gmina, luk: Number(g.luk) })),
    warnings,
  };
}

function statsBefore(n: number): boolean { return n === 0; }

export function formatDiffReport(r: DiffReport): string {
  const l: string[] = [];
  l.push(`Porownanie: ${r.source} (${r.version}) vs PRG`);
  l.push('');
  l.push(`  punktow w zrodle:      ${r.inSource.toLocaleString('pl')}`);
  l.push(`  punktow w PRG:         ${r.wPrg.toLocaleString('pl')}`);
  l.push(`  wspolnych:             ${r.shared.toLocaleString('pl')}`);
  l.push(`  tylko w zrodle:        ${r.sourceOnly.toLocaleString('pl')} (${(r.sourceOnlyFrac * 100).toFixed(2)}%)`);
  l.push(`  rozny kod pocztowy:    ${r.differentCodes.toLocaleString('pl')}`);

  if (r.gminy.length) {
    l.push('');
    l.push('  Gminy z najwieksza liczba luk:');
    for (const g of r.gminy) l.push(`    ${String(g.luk).padStart(8)}  ${g.gmina}`);
  }
  if (r.sample.length) {
    l.push('');
    l.push('  Probka adresow nieobecnych w PRG:');
    for (const p of r.sample.slice(0, 10)) {
      l.push(`    ${[p.locality, p.street, p.nr].filter(Boolean).join(', ')}${p.code ? '  ' + p.code : ''}`);
    }
  }
  if (r.warnings.length) {
    l.push('');
    l.push('  Ostrzezenia:');
    for (const o of r.warnings) l.push(`    ! ${o}`);
  }
  return l.join('\n');
}
