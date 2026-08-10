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
  points: arg('punktow', PRG_REALNA_SKALA.points),
  localities: arg('miejscowosci', PRG_REALNA_SKALA.localities),
  ulic: arg('ulic', PRG_REALNA_SKALA.ulic),
  gmin: PRG_REALNA_SKALA.gmin,
  outDir: '/tmp/scale',
};

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:54329/adres';
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });

const timed = async <T>(etykieta: string, fn: () => Promise<T>): Promise<T> => {
  const t = Date.now();
  const r = await fn();
  const s = (Date.now() - t) / 1000;
  console.log(`  ${etykieta.padEnd(42)} ${s.toFixed(1).padStart(8)} s`);
  return r;
};

async function copyFile(tabela: string, columns: string, file: string): Promise<void> {
  const client = await pool.connect();
  try {
    await pipeline(createReadStream(file), client.query(copyFrom(`COPY ${tabela} (${columns}) FROM STDIN`)));
  } finally {
    client.release();
  }
}

const MB = (b: number) => (b / 1048576).toFixed(0) + ' MB';

console.log('=========================================================');
console.log(' TEST SKALI - zbior o wielkosci realnego PRG');
console.log('=========================================================');
console.log(`  punktow adresowych:  ${SKALA.points.toLocaleString('pl')}`);
console.log(`  miejscowosci:        ${SKALA.localities.toLocaleString('pl')}`);
console.log(`  ulic:                ${SKALA.ulic.toLocaleString('pl')}`);
console.log('');

// --- 1. generowanie -------------------------------------------------
console.log('1. GENEROWANIE');
const files = await timed('generowanie plikow TSV', () => generuj(SKALA));
for (const [k, v] of Object.entries(files)) {
  if (k.startsWith('_')) continue;
  console.log(`     ${k.padEnd(14)} ${MB(statSync(v).size)}`);
}

// --- 2. czyszczenie i zasilenie wymiarow ----------------------------
console.log('');
console.log('2. WYMIARY');
await timed('czyszczenie bazy', async () => {
  await pool.query(`
    TRUNCATE staging.address_point, staging.locality, staging.street;
    TRUNCATE address.address_point, address.street, address.locality,
             address.teryt_unit, address.snapshot CASCADE;
  `);
});
await timed('COPY teryt_unit', () =>
  copyFile('address.teryt_unit', 'terc,name,level,gmina_kind,parent_terc,as_of', files.terc));
await timed('COPY locality', () =>
  copyFile('address.locality',
    'simc,name,name_norm,kind,gmina_terc,parent_simc,prng_id,has_streets,point_count,centroid,source,source_version,prg_local_id',
    files.locality));
await timed('COPY street', () =>
  copyFile('address.street',
    'ulic_id,simc,sym_ul,street_type,name,name_norm,short_name,short_name_norm,name_1,name_2,point_count,source,source_version,prg_local_id',
    files.street));
await pool.query(`SELECT setval('address.ulica_ulic_id_seq', (SELECT max(ulic_id) FROM address.street))`);

// --- 3. COPY punktow do obszaru przejsciowego -----------------------
console.log('');
console.log('3. OBSZAR PRZEJSCIOWY');
await timed('zdjecie indeksow staging', () => pool.query('SELECT staging.before_load()') as any);
await timed(`COPY ${SKALA.points.toLocaleString('pl')} punktow`, () =>
  copyFile('staging.address_point',
    'prg_local_id,version_id,version_start,simc,ulic_id,building_number,building_number_key,building_number_sort,postal_code,status,terc_ref,geom,source,source_version,content_hash,voivodeship',
    files.point));
await timed('odtworzenie indeksow + ANALYZE', () => pool.query('SELECT staging.after_load()') as any);

// --- 4. kontrole jakosci --------------------------------------------
console.log('');
console.log('4. KONTROLE JAKOSCI');
const sanity = await timed('runSanityChecks', () => runSanityChecks(pool, {
  maxDeltaFrac: 1, maxGminaDropFrac: 0.9, minPoints: 1, staleDays: 30,
}));
console.log('');
console.log(formatSanityReport(sanity).split('\n').map((l) => '     ' + l).join('\n'));

// --- 5. publikacja ---------------------------------------------------
console.log('');
console.log('5. PUBLIKACJA');
await pool.query(
  `INSERT INTO address.snapshot (source, version, status) VALUES ('prg','skala','pobrany')
     ON CONFLICT DO NOTHING`);
const delta = await timed('publikuj_zrzut (transakcyjnie)', async () => {
  const { rows } = await pool.query('SELECT * FROM address.publish_snapshot($1,$2,$3)', ['prg', 'skala', null]);
  return rows[0];
});
console.log(`     dodane ${Number(delta.added).toLocaleString('pl')}, zmienione ${delta.changed}, wycofane ${delta.withdrawn}`);

const { rows: [rozmiary] } = await pool.query<{ t: string; i: string }>(`
  SELECT pg_size_pretty(pg_total_relation_size('address.address_point')) t,
         pg_size_pretty(pg_indexes_size('address.address_point')) i`);
console.log(`     tabela punktow: ${rozmiary.t} (w tym indeksy ${rozmiary.i})`);

// --- 6. zapytania produkcyjne ---------------------------------------
console.log('');
console.log('6. ZAPYTANIA PRODUKCYJNE (mediana z 20)');
const measure = async (etykieta: string, sql: string, params: unknown[]) => {
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
const { rows: [attempts] } = await pool.query<{ ulic_id: string; simc: string }>(
  `SELECT ulic_id, simc FROM address.address_point WHERE ulic_id IS NOT NULL LIMIT 1`);
await measure('numery na ulicy', `SELECT building_number, postal_code FROM address.address_point
   WHERE ulic_id = $1 AND withdrawn_at IS NULL ORDER BY building_number_sort LIMIT 500`, [attempts.ulic_id]);
await measure('punkt po ulicy i numerze', `SELECT prg_local_id, postal_code FROM address.address_point
   WHERE ulic_id = $1 AND building_number_key = $2 AND withdrawn_at IS NULL LIMIT 1`, [attempts.ulic_id, '1']);
await measure('geokodowanie odwrotne (PostGIS)', `SELECT id FROM address.address_point
   WHERE withdrawn_at IS NULL AND ST_DWithin(geom, $1::geography, 500)
   ORDER BY geom <-> $1::geography LIMIT 5`, ['SRID=4326;POINT(21.0 52.2)']);

// --- 7. artefakt indeksu ---------------------------------------------
console.log('');
console.log('7. ARTEFAKT INDEKSU');
const rssBefore = process.memoryUsage().rss;
const docs = await timed('SELECT dokumentow z bazy', async () => {
  const { rows } = await pool.query(SQL_INDEX_DOCS);
  return rows.map((r: any): IndexDoc => ({
    type: r.type, label: r.label, simc: r.simc,
    ulicId: r.ulic_id ? Number(r.ulic_id) : undefined,
    addressPointCount: Number(r.point_count ?? 0),
    gmina: r.gmina, powiat: r.powiat, voivodeship: r.voivodeship,
    hasStreets: r.has_streets, lat: r.lat ?? undefined, lon: r.lon ?? undefined,
    aliases: r.aliases ?? undefined,
  }));
});
console.log(`     dokumentow: ${docs.length.toLocaleString('pl')}`);

const built = await timed('buildIndex', async () => buildIndex(docs, 'skala'));
console.log(`     artefakt:   ${MB(built.stats.totalBytes)}  (${built.stats.keys.toLocaleString('pl')} kluczy)`);

const idx = new SearchIndex(built.buffer);
console.log(`     RSS po zaladowaniu: ${MB(process.memoryUsage().rss)}  (przyrost ${MB(process.memoryUsage().rss - rssBefore)})`);

// --- 8. latencja wyszukiwania ----------------------------------------
console.log('');
console.log('8. LATENCJA WYSZUKIWANIA (200 iteracji na zapytanie)');
const REQUESTS = ['war', 'nowa', 'nowa wies', 'kosciuszki', 'tadeusza kosciuszki',
  'mickiewicza', 'mickievicza', 'polna', 'zielona gora', 'jana pawla'];
const all: number[] = [];
for (const q of REQUESTS) {
  const t: number[] = [];
  for (let i = 0; i < 200; i++) {
    const s = process.hrtime.bigint();
    idx.search(q, { limit: 10 });
    t.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  t.sort((a, b) => a - b);
  all.push(...t);
  console.log(`     ${q.padEnd(24)} p50 ${t[100].toFixed(3)} ms   p95 ${t[190].toFixed(3)} ms   wynikow ${idx.search(q, { limit: 10 }).length}`);
}
all.sort((a, b) => a - b);
const pct = (p: number) => all[Math.floor(all.length * p)].toFixed(3);
console.log('');
console.log(`     RAZEM  p50 ${pct(0.5)} ms   p95 ${pct(0.95)} ms   p99 ${pct(0.99)} ms`);

console.log('');
console.log('     Przyklad wynikow dla "kosciuszki":');
for (const s of idx.search('kosciuszki', { limit: 3 })) {
  console.log(`       ${s.label}  [${s.gmina}, pkt=${s.addressPointCount}]`);
}

await pool.end();
console.log('');
console.log('=========================================================');
