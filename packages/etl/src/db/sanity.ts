/**
 * Kontrole zdrowego rozsadku przed publikacja nowego zrzutu.
 *
 * KAZDA Z NICH ODPOWIADA REALNEMU, UDOKUMENTOWANEMU INCYDENTOWI:
 *
 *  - czerwiec 2024: paczki PRG nie byly odswiezane przez >=2 tygodnie.
 *    Wykryla to firma zewnetrzna (Geo-System), nie GUGiK.
 *      -> kontrola DELTA_ZERO
 *
 *  - marzec 2016: zrzut opublikowany bez Wroclawia. Podobnie Bialystok.
 *      -> kontrola SPADEK_W_GMINIE
 *
 *  - zmiana struktury / blad konwersji: parser zwraca ulamek rekordow.
 *      -> kontrola WIELKOSC_DELTY i MINIMUM_REKORDOW
 *
 * Kontrola, ktora nie przejdzie, WSTRZYMUJE publikacje. Stary zrzut
 * zostaje aktywny. Lepiej serwowac dane sprzed tygodnia niz polowe kraju.
 */
import type pg from 'pg';

export interface SanityThresholds {
  /** Maksymalna dopuszczalna zmiana liczby punktow, jako ulamek. */
  maxDeltaFrac: number;
  /** Maksymalny dopuszczalny spadek liczby punktow w pojedynczej gminie. */
  maxGminaDropFrac: number;
  /** Minimalna oczekiwana liczba punktow w calym kraju. */
  minPoints: number;
  /** Po ilu dniach bez zmian podnosimy alarm. */
  staleDays: number;
}

export const DEFAULT_THRESHOLDS: SanityThresholds = {
  // PRG rosnie o ~30 tys. punktow na kwartal przy bazie 8,5 mln,
  // czyli ~0,4%. Prog 2% daje spory zapas, a nadal lapie katastrofy.
  maxDeltaFrac: 0.02,
  maxGminaDropFrac: 0.10,
  // Stan na 31.03.2026: 8 560 617. Prog ustawiony z duzym marginesem w dol.
  minPoints: 7_500_000,
  staleDays: 30,
};

/**
 * Progi z ENV.
 *
 * Potrzebne w trzech sytuacjach:
 *  - dev/test na fixture'ach (SANITY_MIN_POINTS=1)
 *  - import pojedynczego wojewodztwa zamiast calego kraju
 *  - pierwszy zaladunek, gdy baza jest pusta
 *
 * NIE jest to obejscie kontroli - to jej parametryzacja. Do obejscia
 * sluzy jawna flaga --force, ktora zostawia slad w logu.
 */
export function thresholdsFromEnv(env = process.env): SanityThresholds {
  const num = (k: string, d: number): number => {
    const v = env[k];
    if (v === undefined || v === '') return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    maxDeltaFrac: num('SANITY_MAX_DELTA_FRAC', DEFAULT_THRESHOLDS.maxDeltaFrac),
    maxGminaDropFrac: num('SANITY_MAX_GMINA_DROP_FRAC', DEFAULT_THRESHOLDS.maxGminaDropFrac),
    minPoints: num('SANITY_MIN_POINTS', DEFAULT_THRESHOLDS.minPoints),
    staleDays: num('SANITY_STALE_DAYS', DEFAULT_THRESHOLDS.staleDays),
  };
}

export interface SanityCheck {
  nazwa: string;
  ok: boolean;
  poziom: 'blokujacy' | 'ostrzezenie';
  komunikat: string;
  szczegoly?: unknown;
}

export interface SanityReport {
  passed: boolean;
  checks: SanityCheck[];
  delta: {
    przed: number;
    po: number;
    dodane: number;
    usuniete: number;
    zmienione: number;
  };
}

/**
 * Uruchamiane po zaladowaniu danych do `staging`, PRZED atomowa podmiana.
 */
export async function runSanityChecks(
  pool: pg.Pool,
  thresholds: SanityThresholds = thresholdsFromEnv(),
): Promise<SanityReport> {
  const checks: SanityCheck[] = [];

  const { rows: [counts] } = await pool.query<{ przed: string; po: string }>(`
    SELECT
      (SELECT count(*) FROM adres.punkt_adresowy WHERE wycofany_od IS NULL) AS przed,
      (SELECT count(*) FROM staging.punkt_adresowy)                          AS po
  `);
  const przed = Number(counts.przed);
  const po = Number(counts.po);

  const { rows: [d] } = await pool.query<{ dodane: string; usuniete: string; zmienione: string }>(`
    SELECT
      (SELECT count(*) FROM staging.punkt_adresowy s
         LEFT JOIN adres.punkt_adresowy p ON p.prg_local_id = s.prg_local_id
        WHERE p.prg_local_id IS NULL)                                         AS dodane,
      (SELECT count(*) FROM adres.punkt_adresowy p
         LEFT JOIN staging.punkt_adresowy s ON s.prg_local_id = p.prg_local_id
        WHERE s.prg_local_id IS NULL AND p.wycofany_od IS NULL)               AS usuniete,
      (SELECT count(*) FROM staging.punkt_adresowy s
         JOIN adres.punkt_adresowy p ON p.prg_local_id = s.prg_local_id
        WHERE p.tresc_hash <> s.tresc_hash)                                   AS zmienione
  `);
  const delta = {
    przed, po,
    dodane: Number(d.dodane),
    usuniete: Number(d.usuniete),
    zmienione: Number(d.zmienione),
  };

  // --- 1. minimum rekordow -------------------------------------------
  checks.push({
    nazwa: 'MINIMUM_REKORDOW',
    ok: po >= thresholds.minPoints,
    poziom: 'blokujacy',
    komunikat: po >= thresholds.minPoints
      ? `${po.toLocaleString('pl')} punktow - w normie.`
      : `Tylko ${po.toLocaleString('pl')} punktow, oczekiwano >= ${thresholds.minPoints.toLocaleString('pl')}. ` +
        `Prawdopodobnie zmienil sie format pliku albo zrzut jest niekompletny.`,
  });

  // --- 2. wielkosc delty ---------------------------------------------
  const deltaFrac = przed > 0 ? Math.abs(po - przed) / przed : 0;
  checks.push({
    nazwa: 'WIELKOSC_DELTY',
    ok: przed === 0 || deltaFrac <= thresholds.maxDeltaFrac,
    poziom: 'blokujacy',
    komunikat: `Zmiana ${(deltaFrac * 100).toFixed(2)}% (prog ${(thresholds.maxDeltaFrac * 100).toFixed(0)}%): ` +
      `+${delta.dodane.toLocaleString('pl')} / -${delta.usuniete.toLocaleString('pl')} / ~${delta.zmienione.toLocaleString('pl')}`,
    szczegoly: delta,
  });

  // --- 3. spadek w pojedynczej gminie --------------------------------
  // To jest kontrola na "zrzut bez Wroclawia".
  const { rows: drops } = await pool.query<{ terc: string; przed: string; po: string; spadek: string }>(`
    WITH przed AS (
      SELECT m.terc_gminy terc, count(*) n
        FROM adres.punkt_adresowy p JOIN adres.miejscowosc m ON m.simc = p.simc
       WHERE p.wycofany_od IS NULL GROUP BY 1
    ), po AS (
      SELECT m.terc_gminy terc, count(*) n
        FROM staging.punkt_adresowy s JOIN adres.miejscowosc m ON m.simc = s.simc
       GROUP BY 1
    )
    SELECT przed.terc, przed.n::text przed, COALESCE(po.n,0)::text po,
           round((1 - COALESCE(po.n,0)::numeric / przed.n) * 100, 1)::text spadek
      FROM przed LEFT JOIN po USING (terc)
     WHERE przed.n > 100
       AND COALESCE(po.n,0)::numeric / przed.n < 1 - $1::numeric
     ORDER BY przed.n DESC LIMIT 20
  `, [thresholds.maxGminaDropFrac]);

  checks.push({
    nazwa: 'SPADEK_W_GMINIE',
    ok: drops.length === 0,
    poziom: 'blokujacy',
    komunikat: drops.length === 0
      ? 'Zadna gmina nie stracila znaczacej liczby punktow.'
      : `${drops.length} gmin ze spadkiem > ${(thresholds.maxGminaDropFrac * 100).toFixed(0)}%. ` +
        `To wzorzec "zrzut bez miasta" - zweryfikuj recznie przed publikacja.`,
    szczegoly: drops,
  });

  // --- 4. dane zamrozone ---------------------------------------------
  const { rows: [stale] } = await pool.query<{ dni: string | null }>(`
    SELECT EXTRACT(DAY FROM now() - max(pobrano))::text AS dni
      FROM adres.zrzut WHERE zrodlo = 'prg' AND status = 'opublikowany'
  `);
  const dni = stale?.dni ? Number(stale.dni) : null;
  const zeroDelta = delta.dodane === 0 && delta.usuniete === 0 && delta.zmienione === 0;
  checks.push({
    nazwa: 'DELTA_ZERO',
    ok: !(zeroDelta && dni !== null && dni > thresholds.staleDays),
    poziom: 'ostrzezenie',
    komunikat: zeroDelta
      ? `Zrzut identyczny z poprzednim${dni !== null ? ` (ostatnia zmiana ${dni} dni temu)` : ''}. ` +
        `PRG aktualizuje sie na biezaco - brak zmian przez ${thresholds.staleDays}+ dni oznacza ` +
        `najpewniej problem po stronie zrodla, tak jak w czerwcu 2024.`
      : 'Zrzut zawiera zmiany.',
  });

  // --- 5. geometria ---------------------------------------------------
  const { rows: [geo] } = await pool.query<{ brak: string; poza: string }>(`
    SELECT
      count(*) FILTER (WHERE geom IS NULL)::text AS brak,
      count(*) FILTER (WHERE geom IS NOT NULL AND NOT ST_Within(
        geom::geometry, ST_MakeEnvelope(13.9, 48.9, 24.3, 55.0, 4326)))::text AS poza
      FROM staging.punkt_adresowy
  `);
  const brakGeo = Number(geo.brak);
  const pozaPL = Number(geo.poza);
  checks.push({
    nazwa: 'GEOMETRIA',
    ok: pozaPL === 0 && brakGeo / Math.max(po, 1) < 0.02,
    poziom: pozaPL > 0 ? 'blokujacy' : 'ostrzezenie',
    komunikat: pozaPL > 0
      ? `${pozaPL.toLocaleString('pl')} punktow poza granicami Polski. ` +
        `Najczestsza przyczyna: odwrocona kolejnosc osi w srsName (patrz gml/parser.ts).`
      : `Bez geometrii: ${brakGeo.toLocaleString('pl')} (${((brakGeo / Math.max(po, 1)) * 100).toFixed(2)}%).`,
  });

  const passed = checks.every((c) => c.ok || c.poziom !== 'blokujacy');
  return { passed, checks, delta };
}

export function formatSanityReport(r: SanityReport): string {
  const lines = [`Delta: +${r.delta.dodane} / -${r.delta.usuniete} / ~${r.delta.zmienione}` +
    `  (${r.delta.przed.toLocaleString('pl')} -> ${r.delta.po.toLocaleString('pl')})`, ''];
  for (const c of r.checks) {
    const mark = c.ok ? 'OK  ' : c.poziom === 'blokujacy' ? 'STOP' : 'UWAGA';
    lines.push(`  [${mark}] ${c.nazwa.padEnd(20)} ${c.komunikat}`);
  }
  lines.push('');
  lines.push(r.passed ? '  => publikacja dozwolona' : '  => PUBLIKACJA WSTRZYMANA');
  return lines.join('\n');
}
