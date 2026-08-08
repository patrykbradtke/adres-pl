/**
 * Pomiar czasow odpowiedzi na RZECZYWISTYM artefakcie.
 *
 * Odpowiednik bench-index.ts, ale zamiast budowac zbior syntetyczny wczytuje
 * artefakt zbudowany z danych PRG. Zapytania sa te same, ktore raport podaje
 * w rozdziale 8.6, zeby wyniki dalo sie porownac miedzy wydaniami.
 *
 *   node --experimental-strip-types packages/etl/test/bench-realny.ts [sciezka]
 */
import { readFileSync } from 'node:fs';
import { SearchIndex } from '../../api/src/search/engine.ts';

const sciezka = process.argv[2] ?? './data/index/current.bin';
const memBefore = process.memoryUsage().rss;
const buf = readFileSync(sciezka);
const idx = new SearchIndex(buf);
const rss = (process.memoryUsage().rss - memBefore) / 1048576;

console.log(`artefakt:   ${sciezka}  ${(buf.length / 1048576).toFixed(1)} MB`);
console.log(`RSS delta:  ${rss.toFixed(0)} MB`);

/** Zapytania z rozdzialu 8.6 raportu, w tej samej kolejnosci. */
const QUERIES: Array<[string, string]> = [
  ['grojecka',   'nazwa jednoznaczna'],
  ['pulawska',   'nazwa jednoznaczna'],
  ['polna',      'nazwa czesta'],
  ['3 maja',     'nazwa czesta'],
  ['krakowska',  'nazwa czesta'],
  ['kosciuszki', 'nazwa patronacka'],
  ['mickievicza','zapytanie z literowka'],
  ['nowa wies',  'nazwa masowo powtarzalna'],
];

const ITER = 200;
console.log(`\n--- latencje (${ITER} iteracji na zapytanie) ---`);
const all: number[] = [];
for (const [q, opis] of QUERIES) {
  idx.search(q, { limit: 10 });                    // rozgrzewka, poza pomiarem
  const times: number[] = [];
  for (let i = 0; i < ITER; i++) {
    const t = process.hrtime.bigint();
    idx.search(q, { limit: 10 });
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  times.sort((a, b) => a - b);
  all.push(...times);
  const n = idx.search(q, { limit: 10 }).length;
  console.log(
    `  ${q.padEnd(14)} ${opis.padEnd(26)} p50 ${times[Math.floor(ITER * 0.5)].toFixed(2).padStart(7)} ms` +
    `  p95 ${times[Math.floor(ITER * 0.95)].toFixed(2).padStart(7)} ms  wynikow: ${n}`);
}
all.sort((a, b) => a - b);
const p = (q: number) => all[Math.floor(all.length * q)].toFixed(2);
console.log(`\n  RAZEM  p50 ${p(0.5)} ms   p95 ${p(0.95)} ms   p99 ${p(0.99)} ms`);

console.log('\n--- jakosc wynikow ---');
for (const q of ['warszawa', 'kosciuszki warszawa', 'mickievicza', 'nowa wies']) {
  console.log(`  "${q}":`);
  for (const s of idx.search(q, { limit: 3 })) {
    console.log(`      ${String(s.score).padStart(5)}  ${s.label}   [${s.type}, pkt=${s.liczbaPunktow}]`);
  }
}
