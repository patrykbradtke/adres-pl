/**
 * Pelny cykl aktualizacji - uruchamiany bez nadzoru.
 *
 * To jest to, co odpala CronJob w Kubernetes albo cron na maszynie.
 * Zadanie ma byc bezpieczne przy kazdym mozliwym wyniku: udanym,
 * wstrzymanym przez kontrole jakosci i zakonczonym bledem.
 *
 * PRZEBIEG
 *   1. sondaz naglowkow HTTP dla 16 plikow wojewodzkich
 *   2. pobranie tych, ktore sie zmienily (reszta pomijana)
 *   3. zaladowanie do obszaru przejsciowego
 *   4. kontrole jakosci
 *   5. publikacja transakcyjna - TYLKO gdy kontrole przeszly
 *   6. zbudowanie artefaktu indeksu i przestawienie wskaznika wersji
 *   7. powiadomienie
 *
 * KODY WYJSCIA (istotne dla harmonogramu i monitoringu)
 *   0  cykl zakonczony publikacja
 *   5  brak zmian w zrodle - nie blad, normalny wynik
 *   3  kontrole jakosci WSTRZYMALY publikacje - wymaga decyzji czlowieka
 *   1  blad techniczny
 *
 * Kod 3 celowo rozni sie od 1: wstrzymanie to zadzialanie zabezpieczenia,
 * a nie awaria. Monitoring powinien je traktowac inaczej.
 */
import type pg from 'pg';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import type { LoadStats } from './db/load.ts';

import {
  VOIVODESHIPS, VOIVODESHIP_NAMES, voivodeshipUrl, probe, download,
  listZipEntries, pickGmlEntry, archivePath, fileExists,
} from './sources/prg.ts';
import { loadGmlToStaging, publish, clearStaging, beforeBulkLoad, afterBulkLoad } from './db/load.ts';
import { runSanityChecks, formatSanityReport, thresholdsFromEnv } from './db/sanity.ts';
import { buildIndex, SQL_INDEX_DOCS, type IndexDoc } from './index-builder/build.ts';

export interface CycleOptions {
  pool: pg.Pool;
  archiveRoot: string;
  indexRoot: string;
  /** Ktore wojewodztwa. Domyslnie wszystkie. */
  voivodeships?: string[];
  /** Pomija sondaz i pobiera zawsze - do wymuszonego odswiezenia. */
  force?: boolean;
  /**
   * Ile wojewodztw ladowac naraz. Domyslnie 1 (sekwencyjnie).
   *
   * Powyzej 1 kazde wojewodztwo idzie w osobnym procesie, bo parsowanie
   * jest zwiazane procesorem i jeden watek JavaScriptu go nie rozlozy.
   * Kosztuje ~400 MB RSS na proces.
   */
  parallel?: number;
  /** Przechodzi caly cykl bez publikacji - do weryfikacji przed wdrozeniem. */
  dryRun?: boolean;
  /**
   * Pomija sondaz i pobieranie, przetwarza pliki juz obecne w archiwum.
   *
   * Potrzebne w dwoch sytuacjach:
   *  - ponowne przetworzenie po poprawce parsera, bez pobierania 900 MB
   *  - praca gdy zrodlo jest chwilowo niedostepne
   * Wymaga podania wersji, ktora ma zostac przetworzona.
   */
  fromArchive?: string;
  /** Ile poprzednich artefaktow indeksu zachowac. */
  keepArtifacts?: number;
  log?: (msg: string) => void;
}

export type CycleOutcome = 'opublikowano' | 'brak-zmian' | 'wstrzymano' | 'blad';

export interface CycleResult {
  outcome: CycleOutcome;
  exitCode: number;
  runId?: number;
  version: string;
  fetched: string[];
  skipped: string[];
  errors: Array<{ voivodeship: string; error: string }>;
  delta?: { added: number; changed: number; withdrawn: number; restored: number };
  sanity?: string;
  artifact?: { file: string; rozmiarMB: number; dokumentow: number };
  durationSeconds: number;
  /** Ostrzezenia niewstrzymujace publikacji, ale wymagajace uwagi. */
  warnings: string[];
}

export async function runCycle(opts: CycleOptions): Promise<CycleResult> {
  const t0 = Date.now();
  const log = opts.log ?? (() => {});
  const codes = opts.voivodeships ?? VOIVODESHIPS;
  const version = opts.fromArchive ?? new Date().toISOString().slice(0, 10);

  const result: CycleResult = {
    outcome: 'blad',
    exitCode: 1,
    version,
    fetched: [],
    skipped: [],
    errors: [],
    warnings: [],
    durationSeconds: 0,
  };

  const { rows: [run] } = await opts.pool.query<{ id: string }>(
    `INSERT INTO address.etl_run (status) VALUES ('running') RETURNING id`,
  );
  result.runId = Number(run.id);

  try {
    // --- 1. sondaz ---------------------------------------------------
    const toFetch: string[] = [];
    let withoutHeaders = 0;

    if (opts.fromArchive) {
      log(`tryb archiwalny: przetwarzam wersje ${opts.fromArchive} bez pobierania`);
      for (const code of codes) {
        if (await fileExists(archivePath(opts.archiveRoot, code, opts.fromArchive))) toFetch.push(code);
        else result.skipped.push(code);
      }
      if (toFetch.length === 0) {
        throw new Error(
          `Brak plikow wersji ${opts.fromArchive} w archiwum ${opts.archiveRoot}. ` +
          `Sprawdz katalog albo pobierz dane: etl download --all --version ${opts.fromArchive}`,
        );
      }
    } else {
    log('sondaz naglowkow HTTP');

    for (const code of codes) {
      const url = voivodeshipUrl(code);
      const previous = await lastSnapshot(opts.pool, code);
      try {
        const p = await probe(url, previous);
        if (p.headersUseless) withoutHeaders++;
        if (!p.ok) {
          result.errors.push({ voivodeship: code, error: `HTTP ${p.status}` });
          continue;
        }
        // Brak naglowkow => nie da sie stwierdzic zmiany => pobieramy.
        if (opts.force || p.changed || p.headersUseless) toFetch.push(code);
        else result.skipped.push(code);
      } catch (e) {
        result.errors.push({ voivodeship: code, error: e instanceof Error ? e.message : String(e) });
      }
    }

    } // koniec galezi z sondazem

    if (!opts.fromArchive && withoutHeaders === codes.length) {
      result.warnings.push(
        'Serwer nie zwraca ETag ani Last-Modified - sondaz nie oszczedza transferu. ' +
        'Rozwaz przejscie na harmonogram tygodniowy i porownywanie sumy kontrolnej.',
      );
    }

    // Awaria wszystkich wojewodztw to problem po stronie zrodla, nie nasz.
    if (!opts.fromArchive && result.errors.length === codes.length) {
      throw new Error(
        `Zadne z ${codes.length} wojewodztw nie odpowiedzialo poprawnie. ` +
        `Zrodlo prawdopodobnie jest niedostepne. Pierwszy blad: ${result.errors[0].error}`,
      );
    }

    if (toFetch.length === 0) {
      log('brak zmian w zrodle');
      result.outcome = 'brak-zmian';
      result.exitCode = 5;
      await finishRun(opts.pool, result, 'brak-zmian');
      result.durationSeconds = Math.round((Date.now() - t0) / 1000);
      return result;
    }

    // --- 2. pobranie i zaladowanie ------------------------------------
    if (!opts.dryRun) {
      await clearStaging(opts.pool);
      await beforeBulkLoad(opts.pool);
    }
    log(`do pobrania: ${toFetch.length} z ${codes.length}`);

    // Pobranie idzie sekwencyjnie - ograniczeniem jest lacze, nie procesor,
    // a rownolegle ciagniecie 16 plikow po ~100 MB niczego nie przyspiesza.
    for (const code of toFetch) {
      const url = voivodeshipUrl(code);
      const dest = archivePath(opts.archiveRoot, code, version);
      try {
        if (!(await fileExists(dest))) {
          log(`${code} ${VOIVODESHIP_NAMES[code]}: pobieranie`);
          const d = await download(url, dest);
          await recordSnapshot(opts.pool, code, version, url, d.bytes, d.sha256);
        } else {
          log(`${code} ${VOIVODESHIP_NAMES[code]}: juz w archiwum`);
        }
      } catch (e) {
        result.errors.push({ voivodeship: code, error: e instanceof Error ? e.message : String(e) });
      }
    }

    const toLoad = toFetch.filter(
      (k) => !result.errors.some((b) => b.voivodeship === k),
    );

    // Ladowanie jest zwiazane procesorem: parsowanie XML zajmuje jeden watek
    // i nie da sie go rozlozyc przez Promise.all, bo caly JavaScript siedzi
    // w jednym watku. Zmierzone na mazowieckim: 902 rekordy/s w pojedynczym
    // procesie, a cztery procesy rownolegle daly lacznie 3266 rek/s (3,6x)
    // przy spadku pojedynczego procesu tylko o 10-20%. Wspolnego waskiego
    // gardla nie ma - ani dysk, ani baza nie wysycaja sie przy czterech.
    //
    // Domyslnie 1, czyli zachowanie bez zmian. Wlaczenie kosztuje pamiec:
    // kazdy proces to ~400 MB RSS, wiec `--parallel 4` to ~1,6 GB.
    const parallel = Math.max(1, Math.min(opts.parallel ?? 1, toLoad.length));
    if (parallel > 1) log(`ladowanie ${toLoad.length} wojewodztw, po ${parallel} naraz`);

    const load = async (code: string): Promise<void> => {
      const dest = archivePath(opts.archiveRoot, code, version);
      try {
        const st = parallel > 1
          ? await loadInSubprocess(opts.pool, dest, code, version)
          : await loadGmlToStaging(() => openZip(dest), {
              pool: opts.pool,
              source: 'prg',
              sourceVersion: version,
              voivodeship: code,
            });
        log(`${code} ${VOIVODESHIP_NAMES[code]}: ${st.points.toLocaleString('pl')} punktow`);
        result.fetched.push(code);

        if (st.points === 0) {
          result.warnings.push(
            `${code} ${VOIVODESHIP_NAMES[code]}: zero punktow. Prawdopodobna zmiana struktury pliku - ` +
            `uruchom "etl discover" na tym archiwum.`,
          );
        }
        if (st.axisSwapped > 0) {
          result.warnings.push(
            `${code}: ${st.axisSwapped} punktow z odwrocona kolejnoscia osi wbrew deklaracji srsName.`,
          );
        }
        if (st.outsidePoland > 0) {
          result.warnings.push(`${code}: ${st.outsidePoland} punktow poza granicami Polski.`);
        }
      } catch (e) {
        result.errors.push({ voivodeship: code, error: e instanceof Error ? e.message : String(e) });
      }
    };

    const kolejka = [...toLoad];
    await Promise.all(
      Array.from({ length: parallel }, async () => {
        for (let code = kolejka.shift(); code; code = kolejka.shift()) await load(code);
      }),
    );

    if (result.fetched.length === 0) {
      throw new Error('Nie udalo sie zaladowac zadnego wojewodztwa.');
    }

    // Indeksy i statystyki dopiero teraz - kontrole jakosci ich potrzebuja,
    // COPY nie.
    if (!opts.dryRun) await logTime(log, 'odtwarzanie indeksow staging',
      () => afterBulkLoad(opts.pool));

    // --- 3. kontrole jakosci ------------------------------------------
    log('kontrole jakosci');
    const sanity = await runSanityChecks(opts.pool, thresholdsFromEnv());
    result.sanity = formatSanityReport(sanity);
    for (const c of sanity.checks) {
      if (!c.ok && c.level === 'ostrzezenie') result.warnings.push(`${c.name}: ${c.message}`);
    }

    if (!sanity.passed) {
      log('KONTROLE WSTRZYMALY PUBLIKACJE - poprzedni zrzut pozostaje aktywny');
      result.outcome = 'wstrzymano';
      result.exitCode = 3;
      await finishRun(opts.pool, result, 'wstrzymany',
        sanity.checks.filter((c) => !c.ok && c.level === 'blokujacy').map((c) => c.name).join(', '));
      result.durationSeconds = Math.round((Date.now() - t0) / 1000);
      return result;
    }

    if (opts.dryRun) {
      log('tryb probny - pomijam publikacje');
      result.outcome = 'brak-zmian';
      result.exitCode = 0;
      await finishRun(opts.pool, result, 'ok', 'tryb probny');
      result.durationSeconds = Math.round((Date.now() - t0) / 1000);
      return result;
    }

    // --- 4. publikacja -------------------------------------------------
    log('publikacja');
    result.delta = await publish(opts.pool, 'prg', version, result.fetched);
    log(`+${result.delta.added} / ~${result.delta.changed} / -${result.delta.withdrawn}`);

    // --- 5. artefakt indeksu -------------------------------------------
    log('budowa artefaktu indeksu');
    result.artifact = await buildAndPublishIndex(opts.pool, opts.indexRoot, version);
    log(`artefakt: ${result.artifact.file} (${result.artifact.rozmiarMB} MB)`);

    await pruneArtifacts(opts.indexRoot, opts.keepArtifacts ?? 5, log);

    result.outcome = 'opublikowano';
    result.exitCode = 0;
    await finishRun(opts.pool, result, 'ok');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push({ voivodeship: '-', error: msg });
    result.outcome = 'blad';
    result.exitCode = 1;
    await finishRun(opts.pool, result, 'blad', msg).catch(() => {});
  }

  result.durationSeconds = Math.round((Date.now() - t0) / 1000);
  return result;
}

// --- pomocnicze ----------------------------------------------------------

async function logTime<T>(log: (m: string) => void, etykieta: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  const r = await fn();
  log(`${etykieta}: ${((Date.now() - t) / 1000).toFixed(1)} s`);
  return r;
}

/**
 * Laduje jedno wojewodztwo w osobnym procesie.
 *
 * Osobny proces, a nie worker_threads: `load` ma juz gotowa sciezke w CLI
 * wraz z wlasna pula polaczen i zapisem do adres.zrzut, wiec nie trzeba
 * niczego przepinac miedzy watkami. `--append` jest tu obowiazkowy -
 * obszar przejsciowy czysci raz proces nadrzedny, przed rozdaniem pracy.
 */
async function loadInSubprocess(
  pool: pg.Pool,
  file: string,
  code: string,
  version: string,
): Promise<LoadStats> {
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      ['--experimental-strip-types', cli, 'load', file,
       '--voivodeship', code, '--version', version, '--append'],
      { maxBuffer: 64 * 1024 * 1024 },
      (err) => {
        // Kod 2 to "zaladowano zero punktow" - sygnal, ktory obsluguje
        // wyzej ostrzezeniem, a nie wywroceniem calego cyklu.
        if (err && (err as NodeJS.ErrnoException).code !== 2) {
          reject(new Error(`load ${code}: ${err.message.split('\n')[0]}`));
        } else resolve();
      },
    );
  });

  // Statystyki czytamy z adres.zrzut - `load` sam je tam zapisuje, wiec nie
  // ma potrzeby parsowac wyjscia podprocesu.
  const { rows } = await pool.query<{ stats: LoadStats }>(
    `SELECT stats FROM address.snapshot
      WHERE source = 'prg' AND version = $1 AND voivodeship = $2`,
    [version, code],
  );
  const st = rows[0]?.stats;
  if (!st) throw new Error(`load ${code}: proces zakonczyl sie bez zapisania statystyk`);
  return st;
}

async function openZip(path: string): Promise<Readable> {
  if (/\.zip$/i.test(path)) {
    const entries = await listZipEntries(path);
    const entry = pickGmlEntry(entries, true);
    if (!entry) throw new Error(`Brak pliku GML w archiwum ${path}`);
    return entry.open();
  }
  return createReadStream(path);
}

async function lastSnapshot(
  pool: pg.Pool,
  voivodeship: string,
): Promise<{ etag?: string; lastModified?: string; contentLength?: number } | undefined> {
  const { rows } = await pool.query<{ etag: string | null; last_modified: Date | null; bytes: string | null }>(
    `SELECT etag, last_modified, bytes FROM address.snapshot
      WHERE source = 'prg' AND voivodeship = $1
      ORDER BY fetched_at DESC LIMIT 1`,
    [voivodeship],
  );
  if (rows.length === 0) return undefined;
  return {
    etag: rows[0].etag ?? undefined,
    lastModified: rows[0].last_modified?.toUTCString(),
    contentLength: rows[0].bytes ? Number(rows[0].bytes) : undefined,
  };
}

async function recordSnapshot(
  pool: pg.Pool,
  voivodeship: string,
  version: string,
  url: string,
  bytes: number,
  sha256: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO address.snapshot (source, version, voivodeship, url, bytes, sha256, status)
       VALUES ('prg', $1, $2, $3, $4, decode($5,'hex'), 'pobrany')
     ON CONFLICT (source, version, voivodeship) DO UPDATE
       SET url = EXCLUDED.url, bytes = EXCLUDED.bytes,
           sha256 = EXCLUDED.sha256, fetched_at = now()`,
    [version, voivodeship, url, bytes, sha256],
  );
}

async function finishRun(
  pool: pg.Pool,
  r: CycleResult,
  status: string,
  reason?: string,
): Promise<void> {
  await pool.query(
    `UPDATE address.etl_run
        SET finished_at = now(), status = $2, reason = $3,
            delta = $4, artifact_version = $5
      WHERE id = $1`,
    [
      r.runId, status, reason ?? null,
      JSON.stringify({
        fetched: r.fetched, skipped: r.skipped,
        errors: r.errors, warnings: r.warnings, delta: r.delta,
      }),
      r.artifact?.file ?? null,
    ],
  );
}

/**
 * Buduje artefakt i przestawia wskaznik wersji.
 *
 * Wskaznik jest zapisywany DOPIERO po pomyslnym zapisaniu artefaktu -
 * inaczej instancje mikroserwisu probowalyby pobrac plik, ktorego nie ma.
 */
async function buildAndPublishIndex(
  pool: pg.Pool,
  indexRoot: string,
  version: string,
): Promise<{ file: string; rozmiarMB: number; dokumentow: number }> {
  const { rows } = await pool.query(SQL_INDEX_DOCS);
  const docs: IndexDoc[] = rows.map((r: any) => ({
    type: r.type,
    label: r.label,
    simc: r.simc,
    ulicId: r.ulic_id ? Number(r.ulic_id) : undefined,
    addressPointCount: Number(r.point_count ?? 0),
    gmina: r.gmina, powiat: r.powiat, voivodeship: r.voivodeship,
    hasStreets: r.has_streets,
    lat: r.lat ?? undefined, lon: r.lon ?? undefined,
    aliases: r.aliases ?? undefined,
  }));

  const built = buildIndex(docs, version);
  const name = `idx-${version}.bin`;
  const file = join(indexRoot, name);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, built.buffer);
  // dopiero teraz wskaznik
  await writeFile(
    join(indexRoot, 'current.json'),
    JSON.stringify({ current: name, dataVersion: version, builtAt: new Date().toISOString() }, null, 2),
  );

  return {
    file: name,
    rozmiarMB: +(built.stats.totalBytes / 1048576).toFixed(1),
    dokumentow: built.stats.docs,
  };
}

/** Usuwa stare artefakty, zostawiajac N najnowszych plus biezacy. */
async function pruneArtifacts(indexRoot: string, keep: number, log: (m: string) => void): Promise<void> {
  const { readdir, readFile } = await import('node:fs/promises');
  let files: string[];
  try { files = await readdir(indexRoot); } catch { return; }

  let current = '';
  try {
    current = JSON.parse(await readFile(join(indexRoot, 'current.json'), 'utf8')).current ?? '';
  } catch { /* brak wskaznika */ }

  const artifacts = files.filter((f) => /^idx-.*\.bin$/.test(f)).sort().reverse();
  const toRemove = artifacts.slice(keep).filter((f) => f !== current);
  for (const f of toRemove) {
    await rm(join(indexRoot, f), { force: true });
    log(`usunieto stary artefakt: ${f}`);
  }
}

// --- powiadomienia -------------------------------------------------------

/**
 * Wysyla powiadomienie o wyniku cyklu.
 *
 * Celowo agnostyczne wobec dostawcy - webhook przyjmie i Slack, i Teams,
 * i wlasny endpoint. Brak konfiguracji nie jest bledem: cykl ma dzialac
 * takze bez powiadomien.
 */
export async function notify(r: CycleResult, webhook = process.env.NOTIFY_WEBHOOK): Promise<void> {
  if (!webhook) return;

  const ikona = { publishedAt: 'OK', 'brak-zmian': '--', halted: 'STOP', error: 'BLAD' }[r.outcome];
  const header = `[${ikona}] Aktualizacja bazy adresowej: ${r.outcome}`;
  const lines = [
    `wersja: ${r.version}`,
    `czas: ${r.durationSeconds}s`,
    `wojewodztwa: pobrane ${r.fetched.length}, pominiete ${r.skipped.length}`,
  ];
  if (r.delta) lines.push(`zmiany: +${r.delta.added} / ~${r.delta.changed} / -${r.delta.withdrawn}`);
  if (r.artifact) lines.push(`artefakt: ${r.artifact.file} (${r.artifact.rozmiarMB} MB, ${r.artifact.dokumentow} pozycji)`);
  if (r.warnings.length) lines.push('', 'Ostrzezenia:', ...r.warnings.map((o) => `  - ${o}`));
  if (r.errors.length) lines.push('', 'Bledy:', ...r.errors.map((b) => `  - ${b.voivodeship}: ${b.error}`));
  if (r.outcome === 'wstrzymano' && r.sanity) lines.push('', r.sanity);

  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `${header}\n${lines.join('\n')}`, outcome: r.outcome, detale: r }),
    });
  } catch {
    // Nieudane powiadomienie nie moze wywrocic cyklu, ktory sie powiodl.
  }
}

export function formatCycleSummary(r: CycleResult): string {
  const l: string[] = [];
  l.push(`Wynik:      ${r.outcome}  (kod wyjscia ${r.exitCode})`);
  l.push(`Wersja:     ${r.version}`);
  l.push(`Czas:       ${r.durationSeconds} s`);
  l.push(`Pobrane:    ${r.fetched.length ? r.fetched.join(' ') : '-'}`);
  l.push(`Pominiete:  ${r.skipped.length ? r.skipped.join(' ') : '-'}`);
  if (r.delta) l.push(`Zmiany:     +${r.delta.added} / ~${r.delta.changed} / -${r.delta.withdrawn} / przywrocone ${r.delta.restored}`);
  if (r.artifact) l.push(`Artefakt:   ${r.artifact.file}  ${r.artifact.rozmiarMB} MB  ${r.artifact.dokumentow} pozycji`);
  if (r.warnings.length) { l.push('', 'Ostrzezenia:'); r.warnings.forEach((o) => l.push(`  ! ${o}`)); }
  if (r.errors.length) { l.push('', 'Bledy:'); r.errors.forEach((b) => l.push(`  x ${b.voivodeship}: ${b.error}`)); }
  if (r.sanity) { l.push('', r.sanity); }
  return l.join('\n');
}
