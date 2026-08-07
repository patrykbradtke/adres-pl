/**
 * Test skali: pelna sciezka na zbiorze wielkosci realnego PRG.
 *
 * Mierzy to, czego nie da sie oszacowac z probek:
 *   COPY do obszaru przejsciowego -> kontrole jakosci -> publikacja
 *   -> budowa artefaktu -> latencja wyszukiwania
 *
 * Uruchomienie:
 *   DATABASE_URL=... node --experimental-strip-types packages/etl/test/scale-test.ts
 *   DATABASE_URL=... node ... scale-test.ts --punktow 2000000     (szybszy przebieg)
 */
import { createReadStream } from 'node:fs';
import { statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';

import { generuj, PRG_REALNA_SKALA } from './gen-scale.ts';
import { runSanityChecks, formatSanityReport } from '../src/db/sanity.ts';
import { buildIndex, SQL_INDEX_DOCS, type IndexDoc } from '../src/index-builder/build.ts';
import { SearchIndex } from '../../api/src/search/engine.ts';

const arg = (n: string, d: number): number => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};

const SKALA = {
  punktow: arg('punktow', PRG_REALNA_SKALA.punktow),
  miejscowosci: arg('miejscowosci', PRG_REALNA_SKALA.miejscowosci),
  ulic: arg('ulic', PRG_REALNA_SKALA.ulic),
  gmin: PRG_REALNA_SKALA.gmin,
  outDir: '/tmp/scale',
};

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:54329/adres';
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });

const czas = async <T>(etykieta: string, fn: () => Promise<T>): Promise<T> => {
  const t = Date.now();
  const r = await fn();
  const s = (Date.now() - t) / 1000;
  console.log(`  ${etykieta.padEnd(42)} ${s.toFixed(1).padStart(8)} s`);
  return r;
};

async function copyPlik(tabela: string, kolumny: string, plik: string): Promise<void> {
  const client = await pool.connect();
  try {
    await pipeline(createReadStream(plik), client.query(copyFrom(`COPY ${tabela} (${kolumny}) FROM STDIN`)));
  } finally {
    client.release();
  }
}

const MB = (b: number) => (b / 1048576).toFixed(0) + ' MB';

console.log('=========================================================');
console.log(' TEST SKALI - zbior o wielkosci realnego PRG');
console.log('=========================================================');
console.log(`  punktow adresowych:  ${SKALA.punktow.toLocaleString('pl')}`);
console.log(`  miejscowosci:        ${SKALA.miejscowosci.toLocaleString('pl')}`);
console.log(`  ulic:                ${SKALA.ulic.toLocaleString('pl')}`);
console.log('');

// --- 1. generowanie -------------------------------------------------
console.log('1. GENEROWANIE');
const pliki = await czas('generowanie plikow TSV', () => generuj(SKALA));
for (const [k, v] of Object.entries(pliki)) {
  if (k.startsWith('_')) continue;
  console.log(`     ${k.padEnd(14)} ${MB(statSync(v).size)}`);
}

// --- 2. czyszczenie i zasilenie wymiarow ----------------------------
console.log('');
console.log('2. WYMIARY');
await czas('czyszczenie bazy', async () => {
  await pool.query(`
    TRUNCATE staging.punkt_adresowy, staging.miejscowosc, staging.ulica;
    TRUNCATE adres.punkt_adresowy, adres.ulica, adres.miejscowosc,
             adres.teryt_jednostka, adres.zrzut CASCADE;
  `);
});
await czas('COPY teryt_jednostka', () =>
  copyPlik('adres.teryt_jednostka', 'terc,nazwa,poziom,rodzaj_gminy,parent_terc,stan_na', pliki.terc));
await czas('COPY miejscowosc', () =>
  copyPlik('adres.miejscowosc',
    'simc,nazwa,nazwa_norm,rodzaj,terc_gminy,simc_nadrzedna,identyfikator_prng,ma_ulice,liczba_punktow,centroid,zrodlo,zrodlo_wersja,prg_local_id',
    pliki.miejscowosc));
await czas('COPY ulica', () =>
  copyPlik('adres.ulica',
    'ulic_id,simc,sym_ul,cecha,nazwa,nazwa_norm,nazwa_skroc,nazwa_skroc_norm,nazwa_1,nazwa_2,liczba_punktow,zrodlo,zrodlo_wersja,prg_local_id',
    pliki.ulica));
await pool.query(`SELECT setval('adres.ulica_ulic_id_seq', (SELECT max(ulic_id) FROM adres.ulica))`);

// --- 3. COPY punktow do obszaru przejsciowego -----------------------
console.log('');
console.log('3. OBSZAR PRZEJSCIOWY');
await czas('zdjecie indeksow staging', () => pool.query('SELECT staging.przed_ladowaniem()') as any);
await czas(`COPY ${SKALA.punktow.toLocaleString('pl')} punktow`, () =>
  copyPlik('staging.punkt_adresowy',
    'prg_local_id,wersja_id,poczatek_wersji,simc,ulic_id,nr_budynku,nr_key,nr_sort,kod_pocztowy,status,terc_ref,geom,zrodlo,zrodlo_wersja,tresc_hash,wojewodztwo',
    pliki.punkt));
await czas('odtworzenie indeksow + ANALYZE', () => pool.query('SELECT staging.po_ladowaniu()') as any);

// --- 4. kontrole jakosci --------------------------------------------
console.log('');
console.log('4. KONTROLE JAKOSCI');
const sanity = await czas('runSanityChecks', () => runSanityChecks(pool, {
  maxDeltaFrac: 1, maxGminaDropFrac: 0.9, minPoints: 1, staleDays: 30,
}));
console.log('');
console.log(formatSanityReport(sanity).split('\n').map((l) => '     ' + l).join('\n'));

// --- 5. publikacja ---------------------------------------------------
console.log('');
console.log('5. PUBLIKACJA');
await pool.query(
  `INSERT INTO adres.zrzut (zrodlo, wersja, status) VALUES ('prg','skala','pobrany')
     ON CONFLICT DO NOTHING`);
const delta = await czas('publikuj_zrzut (transakcyjnie)', async () => {
  const { rows } = await pool.query('SELECT * FROM adres.publikuj_zrzut($1,$2,$3)', ['prg', 'skala', null]);
  return rows[0];
});
console.log(`     dodane ${Number(delta.dodane).toLocaleString('pl')}, zmienione ${delta.zmienione}, wycofane ${delta.wycofane}`);

const { rows: [rozmiary] } = await pool.query<{ t: string; i: string }>(`
  SELECT pg_size_pretty(pg_total_relation_size('adres.punkt_adresowy')) t,
         pg_size_pretty(pg_indexes_size('adres.punkt_adresowy')) i`);
console.log(`     tabela punktow: ${rozmiary.t} (w tym indeksy ${rozmiary.i})`);

// --- 6. zapytania produkcyjne ---------------------------------------
console.log('');
console.log('6. ZAPYTANIA PRODUKCYJNE (mediana z 20)');
const mierz = async (etykieta: string, sql: string, params: unknown[]) => {
  await pool.query(sql, params);   // rozgrzewka
  const t: number[] = [];
  for (let i = 0; i < 20; i++) {
    const s = process.hrtime.bigint();
    await pool.query(sql, params);
    t.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  t.sort((a, b) => a - b);
  console.log(`     ${etykieta.padEnd(40)} p50 ${t[10].toFixed(2)} ms   p95 ${t[19].toFixed(2)} ms`);
};
const { rows: [prob] } = await pool.query<{ ulic_id: string; simc: string }>(
  `SELECT ulic_id, simc FROM adres.punkt_adresowy WHERE ulic_id IS NOT NULL LIMIT 1`);
await mierz('numery na ulicy', `SELECT nr_budynku, kod_pocztowy FROM adres.punkt_adresowy
   WHERE ulic_id = $1 AND wycofany_od IS NULL ORDER BY nr_sort LIMIT 500`, [prob.ulic_id]);
await mierz('punkt po ulicy i numerze', `SELECT prg_local_id, kod_pocztowy FROM adres.punkt_adresowy
   WHERE ulic_id = $1 AND nr_key = $2 AND wycofany_od IS NULL LIMIT 1`, [prob.ulic_id, '1']);
await mierz('geokodowanie odwrotne (PostGIS)', `SELECT id FROM adres.punkt_adresowy
   WHERE wycofany_od IS NULL AND ST_DWithin(geom, $1::geography, 500)
   ORDER BY geom <-> $1::geography LIMIT 5`, ['SRID=4326;POINT(21.0 52.2)']);

// --- 7. artefakt indeksu ---------------------------------------------
console.log('');
console.log('7. ARTEFAKT INDEKSU');
const rssPrzed = process.memoryUsage().rss;
const docs = await czas('SELECT dokumentow z bazy', async () => {
  const { rows } = await pool.query(SQL_INDEX_DOCS);
  return rows.map((r: any): IndexDoc => ({
    type: r.type, label: r.label, simc: r.simc,
    ulicId: r.ulic_id ? Number(r.ulic_id) : undefined,
    liczbaPunktow: Number(r.liczba_punktow ?? 0),
    gmina: r.gmina, powiat: r.powiat, wojewodztwo: r.wojewodztwo,
    maUlice: r.ma_ulice, lat: r.lat ?? undefined, lon: r.lon ?? undefined,
    aliases: r.aliases ?? undefined,
  }));
});
console.log(`     dokumentow: ${docs.length.toLocaleString('pl')}`);

const built = await czas('buildIndex', async () => buildIndex(docs, 'skala'));
console.log(`     artefakt:   ${MB(built.stats.totalBytes)}  (${built.stats.keys.toLocaleString('pl')} kluczy)`);

const idx = new SearchIndex(built.buffer);
console.log(`     RSS po zaladowaniu: ${MB(process.memoryUsage().rss)}  (przyrost ${MB(process.memoryUsage().rss - rssPrzed)})`);

// --- 8. latencja wyszukiwania ----------------------------------------
console.log('');
console.log('8. LATENCJA WYSZUKIWANIA (200 iteracji na zapytanie)');
const ZAPYTANIA = ['war', 'nowa', 'nowa wies', 'kosciuszki', 'tadeusza kosciuszki',
  'mickiewicza', 'mickievicza', 'polna', 'zielona gora', 'jana pawla'];
const wszystkie: number[] = [];
for (const q of ZAPYTANIA) {
  const t: number[] = [];
  for (let i = 0; i < 200; i++) {
    const s = process.hrtime.bigint();
    idx.search(q, { limit: 10 });
    t.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  t.sort((a, b) => a - b);
  wszystkie.push(...t);
  console.log(`     ${q.padEnd(24)} p50 ${t[100].toFixed(3)} ms   p95 ${t[190].toFixed(3)} ms   wynikow ${idx.search(q, { limit: 10 }).length}`);
}
wszystkie.sort((a, b) => a - b);
const pct = (p: number) => wszystkie[Math.floor(wszystkie.length * p)].toFixed(3);
console.log('');
console.log(`     RAZEM  p50 ${pct(0.5)} ms   p95 ${pct(0.95)} ms   p99 ${pct(0.99)} ms`);

console.log('');
console.log('     Przyklad wynikow dla "kosciuszki":');
for (const s of idx.search('kosciuszki', { limit: 3 })) {
  console.log(`       ${s.label}  [${s.gmina}, pkt=${s.liczbaPunktow}]`);
}

await pool.end();
console.log('');
console.log('=========================================================');
