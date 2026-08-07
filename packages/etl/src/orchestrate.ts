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
  WOJEWODZTWA, WOJ_NAZWY, wojewodztwoUrl, probe, download,
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
  wojewodztwa?: string[];
  /** Pomija sondaz i pobiera zawsze - do wymuszonego odswiezenia. */
  force?: boolean;
  /**
   * Ile wojewodztw ladowac naraz. Domyslnie 1 (sekwencyjnie).
   *
   * Powyzej 1 kazde wojewodztwo idzie w osobnym procesie, bo parsowanie
   * jest zwiazane procesorem i jeden watek JavaScriptu go nie rozlozy.
   * Kosztuje ~400 MB RSS na proces.
   */
  rownolegle?: number;
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
  wersja: string;
  pobrane: string[];
  pominiete: string[];
  bledy: Array<{ wojewodztwo: string; blad: string }>;
  delta?: { dodane: number; zmienione: number; wycofane: number; przywrocone: number };
  sanity?: string;
  artefakt?: { plik: string; rozmiarMB: number; dokumentow: number };
  czasS: number;
  /** Ostrzezenia niewstrzymujace publikacji, ale wymagajace uwagi. */
  ostrzezenia: string[];
}

export async function runCycle(opts: CycleOptions): Promise<CycleResult> {
  const t0 = Date.now();
  const log = opts.log ?? (() => {});
  const kody = opts.wojewodztwa ?? WOJEWODZTWA;
  const wersja = opts.fromArchive ?? new Date().toISOString().slice(0, 10);

  const result: CycleResult = {
    outcome: 'blad',
    exitCode: 1,
    wersja,
    pobrane: [],
    pominiete: [],
    bledy: [],
    ostrzezenia: [],
    czasS: 0,
  };

  const { rows: [run] } = await opts.pool.query<{ id: string }>(
    `INSERT INTO adres.etl_run (status) VALUES ('running') RETURNING id`,
  );
  result.runId = Number(run.id);

  try {
    // --- 1. sondaz ---------------------------------------------------
    const doPobrania: string[] = [];
    let bezNaglowkow = 0;

    if (opts.fromArchive) {
      log(`tryb archiwalny: przetwarzam wersje ${opts.fromArchive} bez pobierania`);
      for (const kod of kody) {
        if (await fileExists(archivePath(opts.archiveRoot, kod, opts.fromArchive))) doPobrania.push(kod);
        else result.pominiete.push(kod);
      }
      if (doPobrania.length === 0) {
        throw new Error(
          `Brak plikow wersji ${opts.fromArchive} w archiwum ${opts.archiveRoot}. ` +
          `Sprawdz katalog albo pobierz dane: etl download --all --wersja ${opts.fromArchive}`,
        );
      }
    } else {
    log('sondaz naglowkow HTTP');

    for (const kod of kody) {
      const url = wojewodztwoUrl(kod);
      const poprzedni = await lastSnapshot(opts.pool, kod);
      try {
        const p = await probe(url, poprzedni);
        if (p.headersUseless) bezNaglowkow++;
        if (!p.ok) {
          result.bledy.push({ wojewodztwo: kod, blad: `HTTP ${p.status}` });
          continue;
        }
        // Brak nagłowkow => nie da sie stwierdzic zmiany => pobieramy.
        if (opts.force || p.changed || p.headersUseless) doPobrania.push(kod);
        else result.pominiete.push(kod);
      } catch (e) {
        result.bledy.push({ wojewodztwo: kod, blad: e instanceof Error ? e.message : String(e) });
      }
    }

    } // koniec galezi z sondazem

    if (!opts.fromArchive && bezNaglowkow === kody.length) {
      result.ostrzezenia.push(
        'Serwer nie zwraca ETag ani Last-Modified - sondaz nie oszczedza transferu. ' +
        'Rozwaz przejscie na harmonogram tygodniowy i porownywanie sumy kontrolnej.',
      );
    }

    // Awaria wszystkich wojewodztw to problem po stronie zrodla, nie nasz.
    if (!opts.fromArchive && result.bledy.length === kody.length) {
      throw new Error(
        `Zadne z ${kody.length} wojewodztw nie odpowiedzialo poprawnie. ` +
        `Zrodlo prawdopodobnie jest niedostepne. Pierwszy blad: ${result.bledy[0].blad}`,
      );
    }

    if (doPobrania.length === 0) {
      log('brak zmian w zrodle');
      result.outcome = 'brak-zmian';
      result.exitCode = 5;
      await finishRun(opts.pool, result, 'brak-zmian');
      result.czasS = Math.round((Date.now() - t0) / 1000);
      return result;
    }

    // --- 2. pobranie i zaladowanie ------------------------------------
    if (!opts.dryRun) {
      await clearStaging(opts.pool);
      await beforeBulkLoad(opts.pool);
    }
    log(`do pobrania: ${doPobrania.length} z ${kody.length}`);

    // Pobranie idzie sekwencyjnie - ograniczeniem jest lacze, nie procesor,
    // a rownolegle ciagniecie 16 plikow po ~100 MB niczego nie przyspiesza.
    for (const kod of doPobrania) {
      const url = wojewodztwoUrl(kod);
      const dest = archivePath(opts.archiveRoot, kod, wersja);
      try {
        if (!(await fileExists(dest))) {
          log(`${kod} ${WOJ_NAZWY[kod]}: pobieranie`);
          const d = await download(url, dest);
          await recordSnapshot(opts.pool, kod, wersja, url, d.bytes, d.sha256);
        } else {
          log(`${kod} ${WOJ_NAZWY[kod]}: juz w archiwum`);
        }
      } catch (e) {
        result.bledy.push({ wojewodztwo: kod, blad: e instanceof Error ? e.message : String(e) });
      }
    }

    const doZaladowania = doPobrania.filter(
      (k) => !result.bledy.some((b) => b.wojewodztwo === k),
    );

    // Ladowanie jest zwiazane procesorem: parsowanie XML zajmuje jeden watek
    // i nie da sie go rozlozyc przez Promise.all, bo caly JavaScript siedzi
    // w jednym watku. Zmierzone na mazowieckim: 902 rekordy/s w pojedynczym
    // procesie, a cztery procesy rownolegle daly lacznie 3266 rek/s (3,6x)
    // przy spadku pojedynczego procesu tylko o 10-20%. Wspolnego waskiego
    // gardla nie ma - ani dysk, ani baza nie wysycaja sie przy czterech.
    //
    // Domyslnie 1, czyli zachowanie bez zmian. Wlaczenie kosztuje pamiec:
    // kazdy proces to ~400 MB RSS, wiec `--rownolegle 4` to ~1,6 GB.
    const rownolegle = Math.max(1, Math.min(opts.rownolegle ?? 1, doZaladowania.length));
    if (rownolegle > 1) log(`ladowanie ${doZaladowania.length} wojewodztw, po ${rownolegle} naraz`);

    const zaladuj = async (kod: string): Promise<void> => {
      const dest = archivePath(opts.archiveRoot, kod, wersja);
      try {
        const st = rownolegle > 1
          ? await zaladujPodprocesem(opts.pool, dest, kod, wersja)
          : await loadGmlToStaging(() => openZip(dest), {
              pool: opts.pool,
              zrodlo: 'prg',
              zrodloWersja: wersja,
              wojewodztwo: kod,
            });
        log(`${kod} ${WOJ_NAZWY[kod]}: ${st.punkty.toLocaleString('pl')} punktow`);
        result.pobrane.push(kod);

        if (st.punkty === 0) {
          result.ostrzezenia.push(
            `${kod} ${WOJ_NAZWY[kod]}: zero punktow. Prawdopodobna zmiana struktury pliku - ` +
            `uruchom "etl discover" na tym archiwum.`,
          );
        }
        if (st.osieOdwrocone > 0) {
          result.ostrzezenia.push(
            `${kod}: ${st.osieOdwrocone} punktow z odwrocona kolejnoscia osi wbrew deklaracji srsName.`,
          );
        }
        if (st.pozaPolska > 0) {
          result.ostrzezenia.push(`${kod}: ${st.pozaPolska} punktow poza granicami Polski.`);
        }
      } catch (e) {
        result.bledy.push({ wojewodztwo: kod, blad: e instanceof Error ? e.message : String(e) });
      }
    };

    const kolejka = [...doZaladowania];
    await Promise.all(
      Array.from({ length: rownolegle }, async () => {
        for (let kod = kolejka.shift(); kod; kod = kolejka.shift()) await zaladuj(kod);
      }),
    );

    if (result.pobrane.length === 0) {
      throw new Error('Nie udalo sie zaladowac zadnego wojewodztwa.');
    }

    // Indeksy i statystyki dopiero teraz - kontrole jakosci ich potrzebuja,
    // COPY nie.
    if (!opts.dryRun) await czasLog(log, 'odtwarzanie indeksow staging',
      () => afterBulkLoad(opts.pool));

    // --- 3. kontrole jakosci ------------------------------------------
    log('kontrole jakosci');
    const sanity = await runSanityChecks(opts.pool, thresholdsFromEnv());
    result.sanity = formatSanityReport(sanity);
    for (const c of sanity.checks) {
      if (!c.ok && c.poziom === 'ostrzezenie') result.ostrzezenia.push(`${c.nazwa}: ${c.komunikat}`);
    }

    if (!sanity.passed) {
      log('KONTROLE WSTRZYMALY PUBLIKACJE - poprzedni zrzut pozostaje aktywny');
      result.outcome = 'wstrzymano';
      result.exitCode = 3;
      await finishRun(opts.pool, result, 'wstrzymany',
        sanity.checks.filter((c) => !c.ok && c.poziom === 'blokujacy').map((c) => c.nazwa).join(', '));
      result.czasS = Math.round((Date.now() - t0) / 1000);
      return result;
    }

    if (opts.dryRun) {
      log('tryb probny - pomijam publikacje');
      result.outcome = 'brak-zmian';
      result.exitCode = 0;
      await finishRun(opts.pool, result, 'ok', 'tryb probny');
      result.czasS = Math.round((Date.now() - t0) / 1000);
      return result;
    }

    // --- 4. publikacja -------------------------------------------------
    log('publikacja');
    result.delta = await publish(opts.pool, 'prg', wersja, result.pobrane);
    log(`+${result.delta.dodane} / ~${result.delta.zmienione} / -${result.delta.wycofane}`);

    // --- 5. artefakt indeksu -------------------------------------------
    log('budowa artefaktu indeksu');
    result.artefakt = await buildAndPublishIndex(opts.pool, opts.indexRoot, wersja);
    log(`artefakt: ${result.artefakt.plik} (${result.artefakt.rozmiarMB} MB)`);

    await pruneArtifacts(opts.indexRoot, opts.keepArtifacts ?? 5, log);

    result.outcome = 'opublikowano';
    result.exitCode = 0;
    await finishRun(opts.pool, result, 'ok');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.bledy.push({ wojewodztwo: '-', blad: msg });
    result.outcome = 'blad';
    result.exitCode = 1;
    await finishRun(opts.pool, result, 'blad', msg).catch(() => {});
  }

  result.czasS = Math.round((Date.now() - t0) / 1000);
  return result;
}

// --- pomocnicze ----------------------------------------------------------

async function czasLog<T>(log: (m: string) => void, etykieta: string, fn: () => Promise<T>): Promise<T> {
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
async function zaladujPodprocesem(
  pool: pg.Pool,
  plik: string,
  kod: string,
  wersja: string,
): Promise<LoadStats> {
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      ['--experimental-strip-types', cli, 'load', plik,
       '--woj', kod, '--wersja', wersja, '--append'],
      { maxBuffer: 64 * 1024 * 1024 },
      (err) => {
        // Kod 2 to "zaladowano zero punktow" - sygnal, ktory obsluguje
        // wyzej ostrzezeniem, a nie wywroceniem calego cyklu.
        if (err && (err as NodeJS.ErrnoException).code !== 2) {
          reject(new Error(`load ${kod}: ${err.message.split('\n')[0]}`));
        } else resolve();
      },
    );
  });

  // Statystyki czytamy z adres.zrzut - `load` sam je tam zapisuje, wiec nie
  // ma potrzeby parsowac wyjscia podprocesu.
  const { rows } = await pool.query<{ statystyki: LoadStats }>(
    `SELECT statystyki FROM adres.zrzut
      WHERE zrodlo = 'prg' AND wersja = $1 AND wojewodztwo = $2`,
    [wersja, kod],
  );
  const st = rows[0]?.statystyki;
  if (!st) throw new Error(`load ${kod}: proces zakonczyl sie bez zapisania statystyk`);
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
  wojewodztwo: string,
): Promise<{ etag?: string; lastModified?: string; contentLength?: number } | undefined> {
  const { rows } = await pool.query<{ etag: string | null; last_modified: Date | null; bajtow: string | null }>(
    `SELECT etag, last_modified, bajtow FROM adres.zrzut
      WHERE zrodlo = 'prg' AND wojewodztwo = $1
      ORDER BY pobrano DESC LIMIT 1`,
    [wojewodztwo],
  );
  if (rows.length === 0) return undefined;
  return {
    etag: rows[0].etag ?? undefined,
    lastModified: rows[0].last_modified?.toUTCString(),
    contentLength: rows[0].bajtow ? Number(rows[0].bajtow) : undefined,
  };
}

async function recordSnapshot(
  pool: pg.Pool,
  wojewodztwo: string,
  wersja: string,
  url: string,
  bajtow: number,
  sha256: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO adres.zrzut (zrodlo, wersja, wojewodztwo, url, bajtow, sha256, status)
       VALUES ('prg', $1, $2, $3, $4, decode($5,'hex'), 'pobrany')
     ON CONFLICT (zrodlo, wersja, wojewodztwo) DO UPDATE
       SET url = EXCLUDED.url, bajtow = EXCLUDED.bajtow,
           sha256 = EXCLUDED.sha256, pobrano = now()`,
    [wersja, wojewodztwo, url, bajtow, sha256],
  );
}

async function finishRun(
  pool: pg.Pool,
  r: CycleResult,
  status: string,
  powod?: string,
): Promise<void> {
  await pool.query(
    `UPDATE adres.etl_run
        SET zakonczony = now(), status = $2, powod = $3,
            delta = $4, artefakt_wersja = $5
      WHERE id = $1`,
    [
      r.runId, status, powod ?? null,
      JSON.stringify({
        pobrane: r.pobrane, pominiete: r.pominiete,
        bledy: r.bledy, ostrzezenia: r.ostrzezenia, delta: r.delta,
      }),
      r.artefakt?.plik ?? null,
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
  wersja: string,
): Promise<{ plik: string; rozmiarMB: number; dokumentow: number }> {
  const { rows } = await pool.query(SQL_INDEX_DOCS);
  const docs: IndexDoc[] = rows.map((r: any) => ({
    type: r.type,
    label: r.label,
    simc: r.simc,
    ulicId: r.ulic_id ? Number(r.ulic_id) : undefined,
    liczbaPunktow: Number(r.liczba_punktow ?? 0),
    gmina: r.gmina, powiat: r.powiat, wojewodztwo: r.wojewodztwo,
    maUlice: r.ma_ulice,
    lat: r.lat ?? undefined, lon: r.lon ?? undefined,
    aliases: r.aliases ?? undefined,
  }));

  const built = buildIndex(docs, wersja);
  const nazwa = `idx-${wersja}.bin`;
  const plik = join(indexRoot, nazwa);
  await mkdir(dirname(plik), { recursive: true });
  await writeFile(plik, built.buffer);
  // dopiero teraz wskaznik
  await writeFile(
    join(indexRoot, 'current.json'),
    JSON.stringify({ current: nazwa, dataVersion: wersja, builtAt: new Date().toISOString() }, null, 2),
  );

  return {
    plik: nazwa,
    rozmiarMB: +(built.stats.totalBytes / 1048576).toFixed(1),
    dokumentow: built.stats.docs,
  };
}

/** Usuwa stare artefakty, zostawiajac N najnowszych plus biezacy. */
async function pruneArtifacts(indexRoot: string, keep: number, log: (m: string) => void): Promise<void> {
  const { readdir, readFile } = await import('node:fs/promises');
  let pliki: string[];
  try { pliki = await readdir(indexRoot); } catch { return; }

  let biezacy = '';
  try {
    biezacy = JSON.parse(await readFile(join(indexRoot, 'current.json'), 'utf8')).current ?? '';
  } catch { /* brak wskaznika */ }

  const artefakty = pliki.filter((f) => /^idx-.*\.bin$/.test(f)).sort().reverse();
  const doUsuniecia = artefakty.slice(keep).filter((f) => f !== biezacy);
  for (const f of doUsuniecia) {
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

  const ikona = { opublikowano: 'OK', 'brak-zmian': '--', wstrzymano: 'STOP', blad: 'BLAD' }[r.outcome];
  const naglowek = `[${ikona}] Aktualizacja bazy adresowej: ${r.outcome}`;
  const linie = [
    `wersja: ${r.wersja}`,
    `czas: ${r.czasS}s`,
    `wojewodztwa: pobrane ${r.pobrane.length}, pominiete ${r.pominiete.length}`,
  ];
  if (r.delta) linie.push(`zmiany: +${r.delta.dodane} / ~${r.delta.zmienione} / -${r.delta.wycofane}`);
  if (r.artefakt) linie.push(`artefakt: ${r.artefakt.plik} (${r.artefakt.rozmiarMB} MB, ${r.artefakt.dokumentow} pozycji)`);
  if (r.ostrzezenia.length) linie.push('', 'Ostrzezenia:', ...r.ostrzezenia.map((o) => `  - ${o}`));
  if (r.bledy.length) linie.push('', 'Bledy:', ...r.bledy.map((b) => `  - ${b.wojewodztwo}: ${b.blad}`));
  if (r.outcome === 'wstrzymano' && r.sanity) linie.push('', r.sanity);

  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `${naglowek}\n${linie.join('\n')}`, outcome: r.outcome, detale: r }),
    });
  } catch {
    // Nieudane powiadomienie nie moze wywrocic cyklu, ktory sie powiodl.
  }
}

export function formatCycleSummary(r: CycleResult): string {
  const l: string[] = [];
  l.push(`Wynik:      ${r.outcome}  (kod wyjscia ${r.exitCode})`);
  l.push(`Wersja:     ${r.wersja}`);
  l.push(`Czas:       ${r.czasS} s`);
  l.push(`Pobrane:    ${r.pobrane.length ? r.pobrane.join(' ') : '-'}`);
  l.push(`Pominiete:  ${r.pominiete.length ? r.pominiete.join(' ') : '-'}`);
  if (r.delta) l.push(`Zmiany:     +${r.delta.dodane} / ~${r.delta.zmienione} / -${r.delta.wycofane} / przywrocone ${r.delta.przywrocone}`);
  if (r.artefakt) l.push(`Artefakt:   ${r.artefakt.plik}  ${r.artefakt.rozmiarMB} MB  ${r.artefakt.dokumentow} pozycji`);
  if (r.ostrzezenia.length) { l.push('', 'Ostrzezenia:'); r.ostrzezenia.forEach((o) => l.push(`  ! ${o}`)); }
  if (r.bledy.length) { l.push('', 'Bledy:'); r.bledy.forEach((b) => l.push(`  x ${b.wojewodztwo}: ${b.blad}`)); }
  if (r.sanity) { l.push('', r.sanity); }
  return l.join('\n');
}
