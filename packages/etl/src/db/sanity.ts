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
  name: string;
  ok: boolean;
  level: 'blokujacy' | 'ostrzezenie';
  message: string;
  details?: unknown;
}

export interface SanityReport {
  passed: boolean;
  checks: SanityCheck[];
  delta: {
    before: number;
    after: number;
    added: number;
    removed: number;
    changed: number;
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

  // Referencje MUSZA byc rozwiazane, zanim cokolwiek policzymy.
  //
  // Parser zapisuje surowy `simc_ref`, a kolumne `simc` wypelnia dopiero
  // `resolve_refs()`. Wywolywala ja wylacznie `publikuj_zrzut()`, czyli JUZ PO
  // kontrolach - wiec w chwili liczenia kazdy punkt w staging mial simc = NULL.
  // SPADEK_W_GMINIE laczy staging ze slownikiem miejscowosci wlasnie po simc,
  // wiec dostawal zero punktow w kazdej gminie i raportowal spadek 100%.
  //
  // Blad nie ujawnil sie przy pierwszej publikacji, bo `adres.punkt_adresowy`
  // bylo puste i kontrola nie miala czego porownywac - przechodzila pusto.
  // Wyszedl dopiero przy drugiej publikacji, na komplecie 16 wojewodztw:
  // 20 gmin z Warszawa na czele "stracilo" 100% punktow, ktore w rzeczywistosci
  // byly w staging. Kontrola pilnujaca wzorca "zrzut bez miasta" nie dzialala
  // nigdy poza pusta baza.
  //
  // resolve_refs() jest idempotentne (kazdy UPDATE ma warunek `simc IS NULL`),
  // wiec ponowne wywolanie w publikuj_zrzut() nic nie kosztuje.
  await pool.query('SELECT staging.resolve_refs()');

  const { rows: [counts] } = await pool.query<{ before: string; after: string }>(`
    SELECT
      (SELECT count(*) FROM address.address_point WHERE withdrawn_at IS NULL) AS before,
      (SELECT count(*) FROM staging.address_point)                          AS after
  `);
  const before = Number(counts.before);
  const after = Number(counts.after);

  const { rows: [d] } = await pool.query<{ added: string; removed: string; changed: string }>(`
    SELECT
      (SELECT count(*) FROM staging.address_point s
         LEFT JOIN address.address_point p ON p.prg_local_id = s.prg_local_id
        WHERE p.prg_local_id IS NULL) AS added,
      (SELECT count(*) FROM address.address_point p
         LEFT JOIN staging.address_point s ON s.prg_local_id = p.prg_local_id
        WHERE s.prg_local_id IS NULL AND p.withdrawn_at IS NULL) AS removed,
      (SELECT count(*) FROM staging.address_point s
         JOIN address.address_point p ON p.prg_local_id = s.prg_local_id
        WHERE p.content_hash <> s.content_hash)                                   AS changed
  `);
  const delta = {
    before, after,
    added: Number(d.added),
    removed: Number(d.removed),
    changed: Number(d.changed),
  };

  // --- 1. minimum rekordow -------------------------------------------
  checks.push({
    name: 'MINIMUM_REKORDOW',
    ok: after >= thresholds.minPoints,
    level: 'blokujacy',
    message: after >= thresholds.minPoints
      ? `${after.toLocaleString('pl')} punktow - w normie.`
      : `Tylko ${after.toLocaleString('pl')} punktow, oczekiwano >= ${thresholds.minPoints.toLocaleString('pl')}. ` +
        `Prawdopodobnie zmienil sie format pliku albo zrzut jest niekompletny.`,
  });

  // --- 2. wielkosc delty ---------------------------------------------
  const deltaFrac = before > 0 ? Math.abs(after - before) / before : 0;
  checks.push({
    name: 'WIELKOSC_DELTY',
    ok: before === 0 || deltaFrac <= thresholds.maxDeltaFrac,
    level: 'blokujacy',
    message: `Zmiana ${(deltaFrac * 100).toFixed(2)}% (prog ${(thresholds.maxDeltaFrac * 100).toFixed(0)}%): ` +
      `+${delta.added.toLocaleString('pl')} / -${delta.removed.toLocaleString('pl')} / ~${delta.changed.toLocaleString('pl')}`,
    details: delta,
  });

  // --- 3. spadek w pojedynczej gminie --------------------------------
  // To jest kontrola na "zrzut bez Wroclawia".
  const { rows: drops } = await pool.query<{ terc: string; before: string; after: string; spadek: string }>(`
    WITH before AS (
      SELECT m.gmina_terc terc, count(*) n
        FROM address.address_point p JOIN address.locality m ON m.simc = p.simc
       WHERE p.withdrawn_at IS NULL GROUP BY 1
    ), after AS (
      SELECT m.gmina_terc terc, count(*) n
        FROM staging.address_point s JOIN address.locality m ON m.simc = s.simc
       GROUP BY 1
    )
    SELECT before.terc, before.n::text before, COALESCE(after.n,0)::text after,
           round((1 - COALESCE(after.n,0)::numeric / before.n) * 100, 1)::text spadek
      FROM before LEFT JOIN after USING (terc)
     WHERE before.n > 100
       AND COALESCE(after.n,0)::numeric / before.n < 1 - $1::numeric
     ORDER BY before.n DESC LIMIT 20
  `, [thresholds.maxGminaDropFrac]);

  checks.push({
    name: 'SPADEK_W_GMINIE',
    ok: drops.length === 0,
    level: 'blokujacy',
    message: drops.length === 0
      ? 'Zadna gmina nie stracila znaczacej liczby punktow.'
      : `${drops.length} gmin ze spadkiem > ${(thresholds.maxGminaDropFrac * 100).toFixed(0)}%. ` +
        `To wzorzec "zrzut bez miasta" - zweryfikuj recznie przed publikacja.`,
    details: drops,
  });

  // --- 4. dane zamrozone ---------------------------------------------
  const { rows: [stale] } = await pool.query<{ days: string | null }>(`
    SELECT EXTRACT(DAY FROM now() - max(fetched_at))::text AS days
      FROM address.snapshot WHERE source = 'prg' AND status = 'opublikowany'
  `);
  const days = stale?.days ? Number(stale.days) : null;
  const zeroDelta = delta.added === 0 && delta.removed === 0 && delta.changed === 0;
  checks.push({
    name: 'DELTA_ZERO',
    ok: !(zeroDelta && days !== null && days > thresholds.staleDays),
    level: 'ostrzezenie',
    message: zeroDelta
      ? `Zrzut identyczny z poprzednim${days !== null ? ` (lastOne change ${days} days ago)` : ''}. ` +
        `PRG aktualizuje sie na biezaco - brak zmian przez ${thresholds.staleDays}+ dni oznacza ` +
        `najpewniej problem po stronie zrodla, tak jak w czerwcu 2024.`
      : 'Zrzut zawiera zmiany.',
  });

  // --- 5. geometria ---------------------------------------------------
  const { rows: [geo] } = await pool.query<{ missing: string; outside: string }>(`
    SELECT
      count(*) FILTER (WHERE geom IS NULL)::text AS missing,
      count(*) FILTER (WHERE geom IS NOT NULL AND NOT ST_Within(
        geom::geometry, ST_MakeEnvelope(13.9, 48.9, 24.3, 55.0, 4326)))::text AS outside
      FROM staging.address_point
  `);
  const missingGeo = Number(geo.missing);
  const outsidePl = Number(geo.outside);
  checks.push({
    name: 'GEOMETRIA',
    ok: outsidePl === 0 && missingGeo / Math.max(after, 1) < 0.02,
    level: outsidePl > 0 ? 'blokujacy' : 'ostrzezenie',
    message: outsidePl > 0
      ? `${outsidePl.toLocaleString('pl')} punktow poza granicami Polski. ` +
        `Najczestsza przyczyna: odwrocona kolejnosc osi w srsName (patrz gml/parser.ts).`
      : `Bez geometrii: ${missingGeo.toLocaleString('pl')} (${((missingGeo / Math.max(after, 1)) * 100).toFixed(2)}%).`,
  });

  const passed = checks.every((c) => c.ok || c.level !== 'blokujacy');
  return { passed, checks, delta };
}

export function formatSanityReport(r: SanityReport): string {
  const lines = [`Delta: +${r.delta.added} / -${r.delta.removed} / ~${r.delta.changed}` +
    `  (${r.delta.before.toLocaleString('pl')} -> ${r.delta.after.toLocaleString('pl')})`, ''];
  for (const c of r.checks) {
    const mark = c.ok ? 'OK  ' : c.level === 'blokujacy' ? 'STOP' : 'UWAGA';
    lines.push(`  [${mark}] ${c.name.padEnd(20)} ${c.message}`);
  }
  lines.push('');
  lines.push(r.passed ? '  => publikacja dozwolona' : '  => PUBLIKACJA WSTRZYMANA');
  return lines.join('\n');
}
