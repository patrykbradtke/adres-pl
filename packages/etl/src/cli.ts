#!/usr/bin/env node
/**
 * CLI ETL.
 *
 *   npm run etl -- discover <plik.gml|zip>      rozpoznaj strukture nieznanego pliku
 *   npm run etl -- probe                        sprawdz, czy zrodlo sie zmienilo (HEAD)
 *   npm run etl -- download [--woj 14] [--all]  pobierz do archiwum
 *   npm run etl -- parse <plik> [--limit N]     sparsuj i wypisz statystyki
 *   npm run etl -- load <plik> --woj 14         zaladuj do staging
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
import { pobierzKatalog, archiveTeryt, testConnection, configFromEnv } from './sources/teryt/soap.ts';
import { runCycle, notify, formatCycleSummary } from './orchestrate.ts';
import { discoverTabular, formatTabularDiscovery } from './sources/tabular.ts';
import { IMPA_ADRUNI } from './sources/impa.ts';
import { loadTabularSource, diffAgainstPrg, formatDiffReport } from './db/load-impa.ts';
import { buildIndex, SQL_INDEX_DOCS, type IndexDoc } from './index-builder/build.ts';
import {
  WOJEWODZTWA, WOJ_NAZWY, wojewodztwoUrl, probe, download,
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
 * profil CPU pokazuje jako bezczynnosc. Nie dalo poprawy (467 -> 436 rek/s,
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
      const kody = flag('woj') ? [flag('woj')!] : WOJEWODZTWA;
      let useless = 0;
      for (const kod of kody) {
        const r = await probe(wojewodztwoUrl(kod));
        if (r.headersUseless) useless++;
        console.log(
          `${kod} ${WOJ_NAZWY[kod].padEnd(20)} HTTP ${r.status}` +
          `  ${r.contentLength ? (r.contentLength / 1048576).toFixed(1) + ' MB' : '?'.padEnd(8)}` +
          `  etag=${r.etag ?? '-'}  last-mod=${r.lastModified ?? '-'}`,
        );
      }
      if (useless === kody.length) {
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
      const wersja = flag('wersja') ?? new Date().toISOString().slice(0, 10);
      const kody = has('all') ? WOJEWODZTWA : [flag('woj') ?? '14'];
      for (const kod of kody) {
        const url = wojewodztwoUrl(kod);
        const dest = archivePath(ARCHIVE_ROOT, kod, wersja);
        process.stderr.write(`${kod} ${WOJ_NAZWY[kod]} ... `);
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
          console.error(`# profil: ${p.name}\n# namespace: ${ns || '(brak)'}`),
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
        czasS: Math.round(sec),
        rekordowNaSekunde: Math.round(stats.features / Math.max(sec, 0.001)),
        ...counts,
        geometria: {
          brak: stats.geometryMissing,
          blad: stats.geometryFailed,
          osieOdwrocone: stats.axisSwapped,
          pozaPolska: stats.outsidePoland,
        },
        nierozpoznaneFeaturey: Object.fromEntries(stats.unknownFeatures),
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
        console.error('# Uruchom `discover` na tym pliku i popraw profil w gml/profiles.ts.');
        process.exitCode = 2;
      }
      break;
    }

    // -----------------------------------------------------------------
    case 'teryt': {
      const sub = args[1];
      const stanNa = flag('stan') ?? new Date().toISOString().slice(0, 10);

      if (sub === 'test') {
        const cfg = configFromEnv();
        console.error(`# endpoint: ${cfg.endpoint}`);
        console.error(`# uzytkownik: ${cfg.username}${cfg.username === 'TestPubliczny' ? ' (konto testowe GUS)' : ''}`);
        const r = await testConnection(cfg, stanNa);
        console.log(r.ok ? `OK. ${r.message}` : `BLAD. ${r.message}`);
        if (!r.ok) process.exitCode = 4;
        break;
      }

      if (sub === 'pobierz') {
        // Pobranie przez usluge sieciowa GUS do archiwum lokalnego.
        const cfg = configFromEnv();
        const katalogi = (flag('katalog')?.split(',') ?? ['WMRODZ', 'TERC', 'SIMC', 'ULIC']) as any[];
        for (const k of katalogi) {
          process.stderr.write(`${k} ... `);
          const f = await pobierzKatalog(k, stanNa, cfg);
          const path = await archiveTeryt(f, ARCHIVE_ROOT);
          const wierszy = f.csv.split(/\r?\n/).filter((l) => l.trim()).length - 1;
          console.error(`${wierszy} wierszy -> ${path}`);
        }
        break;
      }

      // domyslnie: zaladuj z katalogu plikow
      const dir = args[1] ?? `${ARCHIVE_ROOT}/teryt/${stanNa}`;
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
          `Pobierz je przez: npm run etl -- teryt pobierz --stan ${stanNa}\n` +
          `albo recznie z eteryt.stat.gov.pl i umiesc jako TERC.csv, SIMC.csv, ULIC.csv, WMRODZ.csv`,
        );
      }

      const pool = new pg.Pool({ connectionString: DATABASE_URL });
      const st = await loadTeryt(pool, input, {
        stanNa,
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
      const woj = flag('woj');
      const wersja = flag('wersja') ?? new Date().toISOString().slice(0, 10);
      const pool = new pg.Pool({ connectionString: DATABASE_URL });

      if (!has('append')) {
        console.error('# czyszczenie staging (uzyj --append przy ladowaniu kolejnych wojewodztw)');
        await clearStaging(pool);
      }

      const stats = await loadGmlToStaging(() => openSource(path), {
        pool, zrodlo: 'prg', zrodloWersja: wersja, wojewodztwo: woj,
        onProgress: (n) => process.stderr.write(`\r# punktow: ${n.toLocaleString('pl')}   `),
      });
      process.stderr.write('\n');
      console.log(JSON.stringify(stats, null, 2));

      await pool.query(
        `INSERT INTO adres.zrzut (zrodlo, wersja, wojewodztwo, profil, namespace_uri, statystyki, status)
         VALUES ('prg', $1, $2, $3, $4, $5, 'zaladowany')
         ON CONFLICT (zrodlo, wersja, wojewodztwo) DO UPDATE
           SET profil = EXCLUDED.profil, namespace_uri = EXCLUDED.namespace_uri,
               statystyki = EXCLUDED.statystyki, status = 'zaladowany', pobrano = now()`,
        [wersja, woj ?? null, stats.profil ?? null, stats.namespaceUri ?? null, JSON.stringify(stats)],
      );
      await pool.end();
      if (stats.punkty === 0) {
        console.error('# BLAD: zaladowano 0 punktow. Uruchom `discover` i popraw profil.');
        process.exitCode = 2;
      }
      break;
    }

    // -----------------------------------------------------------------
    case 'publish': {
      const wersja = flag('wersja') ?? new Date().toISOString().slice(0, 10);
      const woj = flag('woj') ? [flag('woj')!] : undefined;
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

      const r = await publish(pool, 'prg', wersja, woj);
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
      // Uwaga na kolejnosc argumentow: `impa <plik> --wersja W` ma plik na
      // pozycji 1, a `impa discover <plik>` na pozycji 2. Bez rozroznienia
      // podkomendy sciezka lapie flage.
      const SUBS = new Set(['discover', 'diff']);
      const sub = SUBS.has(args[1]) ? args[1] : undefined;
      const pozycyjne = args.slice(1).filter((a, i, arr) =>
        !a.startsWith('--') && !(i > 0 && arr[i - 1].startsWith('--')));
      const path = sub ? pozycyjne[1] : pozycyjne[0];
      const wersja = flag('wersja') ?? new Date().toISOString().slice(0, 10);

      if (sub === 'discover') {
        if (!path) throw new Error('Podaj sciezke do pliku.');
        const d = await discoverTabular(await openSource(path));
        console.log(formatTabularDiscovery(d, IMPA_ADRUNI));
        break;
      }

      if (sub === 'diff') {
        const pool = new pg.Pool({ connectionString: DATABASE_URL });
        const r = await diffAgainstPrg(pool, 'impa', wersja);
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
        zrodlo: 'impa',
        zrodloWersja: wersja,
        onProgress: (n) => process.stderr.write(`\r# wierszy: ${n.toLocaleString('pl')}   `),
      });
      process.stderr.write('\n');
      console.log(JSON.stringify({
        ...st,
        tabular: {
          wierszy: st.tabular.wierszy,
          separator: st.tabular.separator,
          brakujacePola: st.tabular.brakujace,
          nieuzyteKolumny: st.tabular.nieuzyte,
        },
      }, null, 2));

      if (st.zaladowane === 0) {
        console.error('\n# BLAD: zero rekordow. Uruchom `impa discover <plik>` i popraw profil.');
        process.exitCode = 2;
      } else if (st.tabular.brakujace.length) {
        console.error(`\n# UWAGA: brak kolumn dla pol: ${st.tabular.brakujace.join(', ')}`);
        console.error('# Uruchom `impa discover`, zeby sprawdzic, czy zrodlo ich nie ma,');
        console.error('# czy tylko nazywa je inaczej niz profil w sources/impa.ts');
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
        wojewodztwa: flag('woj')?.split(','),
        force: has('force'),
        dryRun: has('dry-run'),
        fromArchive: flag('z-archiwum'),
        keepArtifacts: flag('keep') ? Number(flag('keep')) : undefined,
        rownolegle: flag('rownolegle')
          ? Number(flag('rownolegle'))
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
      const { rows: [meta] } = await pool.query<{ wersja: string; punktow: string }>(`
        SELECT COALESCE(max(wersja), to_char(now(),'YYYY-MM-DD')) AS wersja,
               (SELECT count(*) FROM adres.punkt_adresowy WHERE wycofany_od IS NULL)::text AS punktow
          FROM adres.zrzut WHERE zrodlo='prg'
      `);
      const { rows } = await pool.query(SQL_INDEX_DOCS);
      const docs: IndexDoc[] = rows.map((r: any) => ({
        type: r.type,
        label: r.label,
        simc: r.simc,
        ulicId: r.ulic_id ? Number(r.ulic_id) : undefined,
        liczbaPunktow: Number(r.liczba_punktow ?? 0),
        liczbaPunktowMiejscowosci: Number(r.liczba_punktow_miejscowosci ?? r.liczba_punktow ?? 0),
        gmina: r.gmina, powiat: r.powiat, wojewodztwo: r.wojewodztwo,
        maUlice: r.ma_ulice,
        lat: r.lat ?? undefined, lon: r.lon ?? undefined,
        aliases: r.aliases ?? undefined,
      }));

      const built = buildIndex(docs, meta.wersja);
      const out = flag('out') ?? join(INDEX_ROOT, `idx-${meta.wersja}.bin`);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, built.buffer);
      // Nazwa z `out`, nie sklejana z wersji - przy --out jedno i drugie
      // sie rozjezdza i wskaznik pokazuje na nieistniejacy plik.
      await writeFile(join(dirname(out), 'current.json'),
        JSON.stringify({ current: basename(out), dataVersion: meta.wersja }, null, 2));
      const stabilna = await ustawStabilnaNazwe(out);

      console.log(JSON.stringify({
        plik: out,
        stabilna,
        ...built.stats,
        rozmiarMB: +(built.stats.totalBytes / 1048576).toFixed(1),
        punktowAdresowych: Number(meta.punktow),
      }, null, 2));
      await pool.end();
      break;
    }

    // -----------------------------------------------------------------
    default:
      console.log(`adres-pl ETL

  discover <plik>              rozpoznaj strukture nieznanego GML
                               (uzyj PRZED pierwszym importem nowej struktury)
  teryt test [--stan D]        sprawdz polaczenie z usluga GUS
  teryt pobierz [--stan D]     pobierz katalogi TERYT do archiwum
  teryt [<katalog>] [--stan D] zaladuj katalogi TERYT do bazy
  probe [--woj 14]             sprawdz naglowki HTTP zrodla
  download [--woj 14|--all]    pobierz do archiwum
  parse <plik> [--limit N]     sparsuj i wypisz statystyki
  load <plik> [--woj 14]       zaladuj do staging (--append dla kolejnych wojewodztw)
  check                        sanity checks przed publikacja
  publish [--woj 14] [--force] sanity checks + atomowa podmiana
  cycle [--force] [--dry-run]  PELNY CYKL bez nadzoru (dla CronJob)
        [--rownolegle N]       ile wojewodztw ladowac naraz (domyslnie 1;
                               4 daje ok. 3,6x, kosztem ~400 MB RAM na proces)
        [--z-archiwum WERSJA]  przetworz ponownie z archiwum, bez pobierania
                               kody wyjscia: 0 ok, 5 brak zmian,
                               3 wstrzymane przez kontrole, 1 blad
  impa discover <plik>         rozpoznaj uklad kolumn zrodla zapasowego
  impa <plik> [--wersja W]     zaladuj zrodlo zapasowe do tabeli porownawczej
  impa diff [--wersja W]       raport: czego PRG nie ma
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
async function ustawStabilnaNazwe(out: string): Promise<string | undefined> {
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
