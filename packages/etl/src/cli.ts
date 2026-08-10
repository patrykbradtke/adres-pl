#!/usr/bin/env node
/**
 * CLI ETL.
 *
 *   npm run etl -- discover <plik.gml|zip>      rozpoznaj strukture nieznanego pliku
 *   npm run etl -- probe                        sprawdz, czy zrodlo sie zmienilo (HEAD)
 *   npm run etl -- download [--voivodeship 14] [--all]  pobierz do archiwum
 *   npm run etl -- parse <plik> [--limit N]     sparsuj i wypisz statystyki
 *   npm run etl -- load <plik> --voivodeship 14         zaladuj do staging
 *   npm run etl -- check                        uruchom sanity checks
 *   npm run etl -- publish                      atomowa podmiana + build artefaktu
 *   npm run etl -- build-index [--out plik]     zbuduj artefakt z biezacej bazy
 */
import { createReadStream } from 'node:fs';
import { writeFile, mkdir, readFile, symlink, unlink, copyFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createGunzip } from 'node:zlib';
import type { Readable } from 'node:stream';
import pg from 'pg';

import { discoverGml, formatDiscoveryReport } from './gml/discover.ts';
import { parseGmlStream } from './gml/parser.ts';
import { mapFeature } from './gml/mapper.ts';
import { runSanityChecks, formatSanityReport } from './db/sanity.ts';
import { loadGmlToStaging, publish, clearStaging } from './db/load.ts';
import { loadTeryt } from './db/load-teryt.ts';
import { fetchCatalog, archiveTeryt, testConnection, configFromEnv } from './sources/teryt/soap.ts';
import { runCycle, notify, formatCycleSummary } from './orchestrate.ts';
import { discoverTabular, formatTabularDiscovery } from './sources/tabular.ts';
import { IMPA_ADRUNI } from './sources/impa.ts';
import { loadTabularSource, diffAgainstPrg, formatDiffReport } from './db/load-impa.ts';
import { buildIndex, SQL_INDEX_DOCS, type IndexDoc } from './index-builder/build.ts';
import {
  VOIVODESHIPS, VOIVODESHIP_NAMES, voivodeshipUrl, probe, download,
  listZipEntries, pickGmlEntry, archivePath,
} from './sources/prg.ts';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const ARCHIVE_ROOT = process.env.ARCHIVE_ROOT ?? './data/archive';
const INDEX_ROOT = process.env.INDEX_ROOT ?? './data/index';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://adres:adres@localhost:5432/adres';

/**
 * Otwiera plik .gml, .xml, .gz albo wybiera wlasciwy wpis z .zip.
 *
 * Sprawdzone i odrzucone: wpiecie PassThrough z progiem 8 MB miedzy
 * rozpakowywanie a parser, w nadziei na wykorzystanie 19% czasu, ktore
 * profile CPU pokazuje jako bezczynnosc. Nie dalo poprawy (467 -> 436 rek/s,
 * czyli w granicach szumu) - bezczynnosc nie bierze sie z braku odczytu
 * z wyprzedzeniem. Nie warto placic za to pamiecia.
 */
async function openSource(path: string): Promise<Readable> {
  if (/\.zip$/i.test(path)) {
    const entries = await listZipEntries(path);
    const entry = pickGmlEntry(entries, !has('stara-struktura'));
    if (!entry) throw new Error(`Brak pliku GML/XML w archiwum ${path}`);
    console.error(`# wpis z archiwum: ${entry.name} (${(entry.size / 1048576).toFixed(0)} MB)`);
    return entry.open();
  }
  const stream = createReadStream(path);
  return /\.gz$/i.test(path) ? (stream.pipe(createGunzip()) as unknown as Readable) : stream;
}

async function main(): Promise<void> {
  switch (cmd) {
    // -----------------------------------------------------------------
    case 'discover': {
      const path = args[1];
      if (!path) throw new Error('Podaj sciezke do pliku.');
      const report = await discoverGml(await openSource(path), Number(flag('max') ?? 200_000));
      console.log(formatDiscoveryReport(report));
      break;
    }

    // -----------------------------------------------------------------
    case 'probe': {
      const codes = flag('voivodeship') ? [flag('voivodeship')!] : VOIVODESHIPS;
      let useless = 0;
      for (const code of codes) {
        const r = await probe(voivodeshipUrl(code));
        if (r.headersUseless) useless++;
        console.log(
          `${code} ${VOIVODESHIP_NAMES[code].padEnd(20)} HTTP ${r.status}` +
          `  ${r.contentLength ? (r.contentLength / 1048576).toFixed(1) + ' MB' : '?'.padEnd(8)}` +
          `  etag=${r.etag ?? '-'}  last-mod=${r.lastModified ?? '-'}`,
        );
      }
      if (useless === codes.length) {
        console.error(
          '\n# UWAGA: serwer nie zwraca ani ETag, ani Last-Modified.\n' +
          '# Sondaz HEAD jest bezuzyteczny - przejdz na harmonogram tygodniowy\n' +
          '# i porownuj sha256 pobranego pliku.',
        );
      }
      break;
    }

    // -----------------------------------------------------------------
    case 'download': {
      const version = flag('version') ?? new Date().toISOString().slice(0, 10);
      const codes = has('all') ? VOIVODESHIPS : [flag('voivodeship') ?? '14'];
      for (const code of codes) {
        const url = voivodeshipUrl(code);
        const dest = archivePath(ARCHIVE_ROOT, code, version);
        process.stderr.write(`${code} ${VOIVODESHIP_NAMES[code]} ... `);
        const r = await download(url, dest);
        console.error(`${(r.bytes / 1048576).toFixed(1)} MB  sha256=${r.sha256.slice(0, 16)}`);
      }
      break;
    }

    // -----------------------------------------------------------------
    case 'parse': {
      const path = args[1];
      if (!path) throw new Error('Podaj sciezke do pliku.');
      const limit = flag('limit') ? Number(flag('limit')) : undefined;
      const counts = { point: 0, locality: 0, street: 0, skipped: 0 };
      const reasons = new Map<string, number>();
      const samples: unknown[] = [];

      const t0 = Date.now();
      const stats = await parseGmlStream(await openSource(path), {
        limit,
        onProfileDetected: (p, ns) =>
          console.error(`# profile: ${p.name}\n# namespace: ${ns || '(brak)'}`),
        onFeature: (f) => {
          const r = mapFeature(f);
          if (r.kind === 'skipped') {
            counts.skipped++;
            reasons.set(r.warning.reason.slice(0, 60), (reasons.get(r.warning.reason.slice(0, 60)) ?? 0) + 1);
          } else {
            counts[r.kind]++;
            if (samples.length < 3) samples.push({ [r.kind]: r.record });
          }
        },
      });
      const sec = (Date.now() - t0) / 1000;

      console.log(JSON.stringify({
        durationSeconds: Math.round(sec),
        rekordowNaSekunde: Math.round(stats.features / Math.max(sec, 0.001)),
        ...counts,
        geometry: {
          brak: stats.geometryMissing,
          error: stats.geometryFailed,
          axisSwapped: stats.axisSwapped,
          outsidePoland: stats.outsidePoland,
        },
        unrecognizedFeatures: Object.fromEntries(stats.unknownFeatures),
        namespaces: [...stats.namespaces],
      }, null, 2));

      if (reasons.size) {
        console.log('\n# powody pominiec:');
        for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
          console.log(`  ${String(n).padStart(8)}  ${r}`);
        }
      }
      // Sygnal, ze cos jest nie tak ze struktura - lepiej wyjsc bledem
      // niz zaladowac pusta baze.
      if (stats.features === 0) {
        console.error('\n# BLAD: nie rozpoznano ZADNEGO feature\'a.');
        console.error('# Uruchom `discover` na tym pliku i popraw profile w gml/profiles.ts.');
        process.exitCode = 2;
      }
      break;
    }

    // -----------------------------------------------------------------
    case 'teryt': {
      const sub = args[1];
      const asOf = flag('as-of') ?? new Date().toISOString().slice(0, 10);

      if (sub === 'test') {
        const cfg = configFromEnv();
        console.error(`# endpoint: ${cfg.endpoint}`);
        console.error(`# uzytkownik: ${cfg.username}${cfg.username === 'PublicTest' ? ' (konto testowe GUS)' : ''}`);
        const r = await testConnection(cfg, asOf);
        console.log(r.ok ? `OK. ${r.message}` : `BLAD. ${r.message}`);
        if (!r.ok) process.exitCode = 4;
        break;
      }

      if (sub === 'pobierz') {
        // Pobranie przez usluge sieciowa GUS do archiwum lokalnego.
        const cfg = configFromEnv();
        const directories = (flag('catalog')?.split(',') ?? ['WMRODZ', 'TERC', 'SIMC', 'ULIC']) as any[];
        for (const k of directories) {
          process.stderr.write(`${k} ... `);
          const f = await fetchCatalog(k, asOf, cfg);
          const path = await archiveTeryt(f, ARCHIVE_ROOT);
          const rows = f.csv.split(/\r?\n/).filter((l) => l.trim()).length - 1;
          console.error(`${rows} wierszy -> ${path}`);
        }
        break;
      }

      // domyslnie: zaladuj z katalogu plikow
      const dir = args[1] ?? `${ARCHIVE_ROOT}/teryt/${asOf}`;
      const read = async (name: string): Promise<string | undefined> => {
        for (const ext of ['.csv', '.xml', '.CSV', '.XML']) {
          try { return await readFile(`${dir}/${name}${ext}`, 'utf8'); } catch { /* nastepny */ }
        }
        return undefined;
      };
      const input = {
        wmrodz: await read('WMRODZ'),
        terc: await read('TERC'),
        simc: await read('SIMC'),
        ulic: await read('ULIC'),
      };
      if (!input.terc && !input.simc && !input.ulic && !input.wmrodz) {
        throw new Error(
          `Brak plikow TERYT w katalogu ${dir}.\n` +
          `Pobierz je przez: npm run etl -- teryt pobierz --as-of ${asOf}\n` +
          `albo recznie z eteryt.stat.gov.pl i umiesc jako TERC.csv, SIMC.csv, ULIC.csv, WMRODZ.csv`,
        );
      }

      const pool = new pg.Pool({ connectionString: DATABASE_URL });
      const st = await loadTeryt(pool, input, {
        asOf,
        onProgress: (m) => console.error(`# ${m}`),
      });
      console.log(JSON.stringify(st, null, 2));
      await pool.end();
      break;
    }

    // -----------------------------------------------------------------
    case 'load': {
      const path = args[1];
      if (!path) throw new Error('Podaj sciezke do pliku.');
      const woj = flag('voivodeship');
      const version = flag('version') ?? new Date().toISOString().slice(0, 10);
      const pool = new pg.Pool({ connectionString: DATABASE_URL });

      if (!has('append')) {
        console.error('# czyszczenie staging (uzyj --append przy ladowaniu kolejnych wojewodztw)');
        await clearStaging(pool);
      }

      const stats = await loadGmlToStaging(() => openSource(path), {
        pool, source: 'prg', sourceVersion: version, voivodeship: woj,
        onProgress: (n) => process.stderr.write(`\r# punktow: ${n.toLocaleString('pl')}   `),
      });
      process.stderr.write('\n');
      console.log(JSON.stringify(stats, null, 2));

      await pool.query(
        `INSERT INTO address.snapshot (source, version, voivodeship, profile, namespace_uri, stats, status)
         VALUES ('prg', $1, $2, $3, $4, $5, 'zaladowany')
         ON CONFLICT (source, version, voivodeship) DO UPDATE
           SET profile = EXCLUDED.profile, namespace_uri = EXCLUDED.namespace_uri,
               stats = EXCLUDED.stats, status = 'zaladowany', fetched_at = now()`,
        [version, woj ?? null, stats.profile ?? null, stats.namespaceUri ?? null, JSON.stringify(stats)],
      );
      await pool.end();
      if (stats.points === 0) {
        console.error('# BLAD: zaladowano 0 punktow. Uruchom `discover` i popraw profile.');
        process.exitCode = 2;
      }
      break;
    }

    // -----------------------------------------------------------------
    case 'publish': {
      const version = flag('version') ?? new Date().toISOString().slice(0, 10);
      const woj = flag('voivodeship') ? [flag('voivodeship')!] : undefined;
      const pool = new pg.Pool({ connectionString: DATABASE_URL });

      // Publikacja BEZ sanity checkow jest mozliwa tylko jawnie.
      // Domyslnie kontrola blokujaca wstrzymuje podmiane.
      if (!has('force')) {
        const report = await runSanityChecks(pool);
        console.log(formatSanityReport(report));
        if (!report.passed) {
          console.error('\n# Publikacja wstrzymana. Stary zrzut zostaje aktywny.');
          console.error('# Zweryfikuj recznie i uzyj --force, jesli swiadomie akceptujesz ryzyko.');
          await pool.end();
          process.exitCode = 3;
          break;
        }
        console.log('');
      }

      const r = await publish(pool, 'prg', version, woj);
      console.log(JSON.stringify(r, null, 2));
      await pool.end();
      break;
    }

    // -----------------------------------------------------------------
    case 'check': {
      const pool = new pg.Pool({ connectionString: DATABASE_URL });
      const report = await runSanityChecks(pool);
      console.log(formatSanityReport(report));
      await pool.end();
      if (!report.passed) process.exitCode = 3;
      break;
    }

    // -----------------------------------------------------------------
    case 'impa': {
      // Uwaga na kolejnosc argumentow: `impa <plik> --version W` ma plik na
      // pozycji 1, a `impa discover <plik>` na pozycji 2. Bez rozroznienia
      // podkomendy sciezka lapie flage.
      const SUBS = new Set(['discover', 'diff']);
      const sub = SUBS.has(args[1]) ? args[1] : undefined;
      const positional = args.slice(1).filter((a, i, arr) =>
        !a.startsWith('--') && !(i > 0 && arr[i - 1].startsWith('--')));
      const path = sub ? positional[1] : positional[0];
      const version = flag('version') ?? new Date().toISOString().slice(0, 10);

      if (sub === 'discover') {
        if (!path) throw new Error('Podaj sciezke do pliku.');
        const d = await discoverTabular(await openSource(path));
        console.log(formatTabularDiscovery(d, IMPA_ADRUNI));
        break;
      }

      if (sub === 'diff') {
        const pool = new pg.Pool({ connectionString: DATABASE_URL });
        const r = await diffAgainstPrg(pool, 'impa', version);
        console.log(formatDiffReport(r));
        await pool.end();
        break;
      }

      // domyslnie: zaladuj plik do tabeli porownawczej
      if (!path) throw new Error('Podaj sciezke do pliku albo podkomende discover/diff.');
      const pool = new pg.Pool({ connectionString: DATABASE_URL });
      const st = await loadTabularSource(() => openSource(path), {
        pool,
        profile: IMPA_ADRUNI,
        source: 'impa',
        sourceVersion: version,
        onProgress: (n) => process.stderr.write(`\r# wierszy: ${n.toLocaleString('pl')}   `),
      });
      process.stderr.write('\n');
      console.log(JSON.stringify({
        ...st,
        tabular: {
          rows: st.tabular.rows,
          separator: st.tabular.separator,
          brakujacePola: st.tabular.brakujace,
          unusedColumns: st.tabular.unused,
        },
      }, null, 2));

      if (st.loaded === 0) {
        console.error('\n# BLAD: zero rekordow. Uruchom `impa discover <plik>` i popraw profile.');
        process.exitCode = 2;
      } else if (st.tabular.brakujace.length) {
        console.error(`\n# UWAGA: brak kolumn dla pol: ${st.tabular.brakujace.join(', ')}`);
        console.error('# Uruchom `impa discover`, zeby sprawdzic, czy zrodlo ich nie ma,');
        console.error('# czy tylko nazywa je inaczej niz profile w sources/impa.ts');
      }
      await pool.end();
      break;
    }

    // -----------------------------------------------------------------
    case 'cycle': {
      // Pelny cykl bez nadzoru - to uruchamia CronJob.
      const pool = new pg.Pool({ connectionString: DATABASE_URL });
      const r = await runCycle({
        pool,
        archiveRoot: ARCHIVE_ROOT,
        indexRoot: INDEX_ROOT,
        voivodeships: flag('voivodeship')?.split(','),
        force: has('force'),
        dryRun: has('dry-run'),
        fromArchive: flag('from-archive'),
        keepArtifacts: flag('keep') ? Number(flag('keep')) : undefined,
        parallel: flag('parallel')
          ? Number(flag('parallel'))
          : (process.env.ETL_ROWNOLEGLE ? Number(process.env.ETL_ROWNOLEGLE) : undefined),
        log: (m) => console.error(`# ${m}`),
      });
      console.log(formatCycleSummary(r));
      await notify(r);
      await pool.end();
      process.exitCode = r.exitCode;
      break;
    }

    // -----------------------------------------------------------------
    case 'build-index': {
      const pool = new pg.Pool({ connectionString: DATABASE_URL });
      const { rows: [meta] } = await pool.query<{ version: string; points: string }>(`
        SELECT COALESCE(max(version), to_char(now(),'YYYY-MM-DD')) AS version,
               (SELECT count(*) FROM address.address_point WHERE withdrawn_at IS NULL)::text AS points
          FROM address.snapshot WHERE source='prg'
      `);
      const { rows } = await pool.query(SQL_INDEX_DOCS);
      const docs: IndexDoc[] = rows.map((r: any) => ({
        type: r.type,
        label: r.label,
        simc: r.simc,
        ulicId: r.ulic_id ? Number(r.ulic_id) : undefined,
        addressPointCount: Number(r.point_count ?? 0),
        localityPointCount: Number(r.locality_point_count ?? r.point_count ?? 0),
        gmina: r.gmina, powiat: r.powiat, voivodeship: r.voivodeship,
        hasStreets: r.has_streets,
        lat: r.lat ?? undefined, lon: r.lon ?? undefined,
        aliases: r.aliases ?? undefined,
      }));

      const built = buildIndex(docs, meta.version);
      const out = flag('out') ?? join(INDEX_ROOT, `idx-${meta.version}.bin`);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, built.buffer);
      // Nazwa z `out`, nie sklejana z wersji - przy --out jedno i drugie
      // sie rozjezdza i wskaznik pokazuje na nieistniejacy plik.
      await writeFile(join(dirname(out), 'current.json'),
        JSON.stringify({ current: basename(out), dataVersion: meta.version }, null, 2));
      const stabilna = await setStableName(out);

      console.log(JSON.stringify({
        file: out,
        stabilna,
        ...built.stats,
        rozmiarMB: +(built.stats.totalBytes / 1048576).toFixed(1),
        addressPoints: Number(meta.points),
      }, null, 2));
      await pool.end();
      break;
    }

    // -----------------------------------------------------------------
    default:
      console.log(`adres-pl ETL

  discover <plik>              rozpoznaj strukture nieznanego GML
                               (uzyj PRZED pierwszym importem nowej struktury)
  teryt test [--as-of D]        sprawdz polaczenie z usluga GUS
  teryt pobierz [--as-of D]     pobierz katalogi TERYT do archiwum
  teryt [<katalog>] [--as-of D] zaladuj katalogi TERYT do bazy
  probe [--voivodeship 14]             sprawdz naglowki HTTP zrodla
  download [--voivodeship 14|--all]    pobierz do archiwum
  parse <plik> [--limit N]     sparsuj i wypisz statystyki
  load <plik> [--voivodeship 14]       zaladuj do staging (--append dla kolejnych wojewodztw)
  check                        sanity checks przed publikacja
  publish [--voivodeship 14] [--force] sanity checks + atomowa podmiana
  cycle [--force] [--dry-run]  PELNY CYKL bez nadzoru (dla CronJob)
        [--parallel N]       ile wojewodztw ladowac naraz (domyslnie 1;
                               4 daje ok. 3,6x, kosztem ~400 MB RAM na proces)
        [--from-archive WERSJA]  przetworz ponownie z archiwum, bez pobierania
                               kody wyjscia: 0 ok, 5 brak zmian,
                               3 wstrzymane przez kontrole, 1 blad
  impa discover <plik>         rozpoznaj uklad kolumn zrodla zapasowego
  impa <plik> [--version W]     zaladuj zrodlo zapasowe do tabeli porownawczej
  impa diff [--version W]       raport: czego PRG nie ma
  build-index [--out plik]     zbuduj artefakt indeksu z bazy

Flagi: --stara-struktura wybiera z archiwum plik sprzed 1.09.2026.`);
      process.exitCode = cmd ? 1 : 0;
  }
}

/**
 * Artefakty sa wersjonowane i niemutowalne (idx-<wersja>.bin), ale README,
 * docker-compose i domyslny INDEX_SOURCE oczekuja stalej nazwy `current.bin`.
 * Bez tego API wstaje tylko wtedy, gdy ktos recznie poda nazwe z wersja.
 * Dowiazanie, bo kopia dublowalaby artefakt (przy pelnym PRG ~500 MB);
 * gdy system plikow nie wspiera dowiazan - kopiujemy.
 */
async function setStableName(out: string): Promise<string | undefined> {
  const link = join(dirname(out), 'current.bin');
  if (basename(out) === 'current.bin') return undefined;
  await unlink(link).catch(() => {});
  try {
    await symlink(basename(out), link);
  } catch {
    await copyFile(out, link);
  }
  return link;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
