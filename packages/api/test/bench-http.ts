/**
 * Pomiar czasu odpowiedzi przez PELNY cykl zycia zadania w Fastify.
 *
 * PO CO OSOBNY PRZYRZAD
 *
 * docs/STAN-PRAC.md i deploy/alerty.yaml podaja wiersz "pelna sciezka HTTP"
 * (p50 1,71 / p95 9,41 / p99 27,94 ms) i przypisuja go skryptowi
 * packages/etl/test/bench-realny.ts. Ten skrypt NIE MOZE tych liczb dac:
 * importuje SearchIndex i mierzy idx.search() bezposrednio, bez routingu,
 * bez hookow i bez serializacji odpowiedzi (grep po "fastify" w tamtym pliku
 * nie daje ani jednego trafienia).
 *
 * Konsekwencja jest praktyczna i grozna dla zadania 8.8: uwierzytelnianie
 * z etapu 8A siedzi w hooku onRequest, ktory w bench-realny.ts w ogole sie
 * nie wykonuje. Ktos uruchomilby go przed zmiana i po niej, zobaczyl roznice
 * zero i uznal prog "+0,3 ms do p99" za spelniony, nie zmierzywszy niczego.
 *
 * CO DOKLADNIE MIERZYMY
 *
 * app.inject(), czyli pelny cykl zycia zadania: onRequest (a wiec wszystkie
 * hooki, w tym limiter i - od 8.4b - uwierzytelnianie), routing, walidacja
 * schematu, uchwyt trasy, serializacja, onResponse.
 *
 * CZEGO NIE MIERZYMY i dlaczego tak jest LEPIEJ: gniazda, jadra systemu i TLS.
 * Prawdziwe gniazdo dokladaloby rzad 0,5-1 ms wlasnego szumu - czyli wiecej
 * niz caly prog, ktory mamy wykryc. Koszt hooka jest kosztem po stronie
 * aplikacji i tam go mierzymy.
 *
 * JAK MIERZYMY CZULOSC PRZYRZADU
 *
 * Puszczamy DWIE IDENTYCZNE serie przeplotem. Skoro roznia sie wylacznie
 * szumem, delta miedzy nimi JEST podloga szumu tego przyrzadu na tej maszynie.
 * Jesli podloga przekracza prog, progu nie da sie zmierzyc przy tej liczbie
 * zadan - i lepiej wiedziec o tym PRZED napisaniem kodu, ktory ma go spelnic.
 *
 * Przeplot, a nie serie blokami: dryf termiczny maszyny i cykle odsmiecania
 * trafilyby w calosci w jedna serie i wygladaly jak roznica miedzy nimi.
 *
 *   npm run bench
 *   npm run bench -- --zadan 40000 --zapisz
 *   npm run bench -- --prog 0.3
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServer, loadConfig, type ServerConfig } from '../src/server.ts';
import { zapiszAtrapeIndeksu } from './atrapa-indeksu.ts';

const tu = dirname(fileURLToPath(import.meta.url));
const PLIK_ODNIESIENIA = join(tu, 'odniesienie-wydajnosc.json');

function arg(nazwa: string, domyslnie: number): number {
  const i = process.argv.indexOf(`--${nazwa}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : domyslnie;
}
/**
 * DOMYSLNA PROBA NIE JEST DOWOLNA - zmierzona krzywa czulosci na tej maszynie:
 *
 *     zadan na serie   podloga szumu p99   prog 0,3 ms
 *          3 000            6,030 ms        niemierzalny
 *         60 000            0,659 ms        niemierzalny
 *        180 000       0,039 i 0,187 ms     mierzalny
 *
 * Dwie wartosci przy 180 tys. to dwa kolejne przebiegi na tej samej maszynie:
 * sama podloga szumu waha sie piecikrotnie, wiec zapas nad progiem to 1,6-7,7x,
 * a nie stala. Przy wyniku bliskim progu powtorzyc pomiar, zanim uzna sie
 * regresje za stwierdzona.
 *
 * Ogon rozkladu przy malej probie rzadza pauzy odsmiecania i szeregowanie
 * procesow, nie koszt obslugi zadania: przy 3 tys. probek p99 to trzydziesty
 * najgorszy pomiar. Kto zmierzy prog na malej probie, dostanie liczbe bez
 * zadnej wartosci - i wlasnie dlatego domyslka jest kosztowna (okolo 7 minut).
 * p50 i p95 sa stabilne duzo wczesniej (szum odpowiednio 0,002 i 0,026 ms).
 */
const ZADAN = arg('zadan', 360_000);
const ROZGRZEWKA = arg('rozgrzewka', 8_000);
const PROG_MS = arg('prog', 0.3);
const ZAPISZ = process.argv.includes('--zapisz');

/**
 * Zapytania z rozdzialu 8.6 raportu, te same co w bench-realny.ts - zeby dalo
 * sie zestawiac wyniki miedzy przyrzadami i miedzy wydaniami.
 */
const ZAPYTANIA = [
  'grojecka', 'pulawska', 'polna', '3 maja',
  'krakowska', 'kosciuszki', 'mickievicza', 'nowa wies',
];

interface Seria {
  id: string;
  opis: string;
  env: Record<string, string>;
  naglowki?: Record<string, string>;
}

/**
 * Na razie dwie serie IDENTYCZNE - to jest pomiar odniesienia i pomiar czulosci
 * przyrzadu, wykonany PRZED napisaniem hooka uwierzytelniajacego. Zadanie 8.8b
 * dolozy serie z waznym kluczem oraz serie kontrolna z wstrzyknietym
 * opoznieniem, ktora ma dowiesc, ze przyrzad rzeczywiscie cokolwiek wykrywa.
 */
const SERIE: Seria[] = [
  { id: 'A', opis: 'bez uwierzytelniania', env: {} },
  { id: 'A-kontrolna', opis: 'bez uwierzytelniania (podloga szumu)', env: {} },
];

function percentyl(posortowane: number[], p: number): number {
  if (posortowane.length === 0) return NaN;
  const i = Math.min(posortowane.length - 1, Math.floor(posortowane.length * p));
  return posortowane[i];
}

const artefakt = await zapiszAtrapeIndeksu(
  join(await mkdtemp(join(tmpdir(), 'adres-bench-')), 'current.bin'));

interface Wynik {
  id: string;
  opis: string;
  n: number;
  p50: number;
  p95: number;
  p99: number;
  kody: Record<string, number>;
}

const czasy = new Map<string, number[]>();
const kody = new Map<string, Map<number, number>>();
const serwery = new Map<string, Awaited<ReturnType<typeof buildServer>>>();

for (const s of SERIE) {
  const cfg: ServerConfig = loadConfig({
    ...process.env, ...s.env,
    LOG_LEVEL: 'error',
    INDEX_SOURCE: artefakt,
    INDEX_POLL_MS: '0',
    // Limit poza zasiegiem pomiaru - inaczej mierzylibysmy odrzucenia.
    RATE_LIMIT_MAX: String(ZADAN * 10),
  });
  serwery.set(s.id, await buildServer(cfg));
  czasy.set(s.id, []);
  kody.set(s.id, new Map());
}

/** Rozgrzewka JEST odrzucana z pomiaru - patrz naglowek. */
for (const s of SERIE) {
  const app = serwery.get(s.id)!;
  for (let i = 0; i < ROZGRZEWKA; i++) {
    await app.inject({
      method: 'GET',
      url: `/v1/suggest?q=${encodeURIComponent(ZAPYTANIA[i % ZAPYTANIA.length])}&limit=10`,
      headers: s.naglowki,
    });
  }
}

// Przeplot: w kazdej iteracji po jednym zadaniu na kazda serie.
const naSerie = Math.floor(ZADAN / SERIE.length);
for (let i = 0; i < naSerie; i++) {
  const q = ZAPYTANIA[i % ZAPYTANIA.length];
  for (const s of SERIE) {
    const app = serwery.get(s.id)!;
    const t0 = process.hrtime.bigint();
    const r = await app.inject({
      method: 'GET',
      url: `/v1/suggest?q=${encodeURIComponent(q)}&limit=10`,
      headers: s.naglowki,
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    czasy.get(s.id)!.push(ms);
    const k = kody.get(s.id)!;
    k.set(r.statusCode, (k.get(r.statusCode) ?? 0) + 1);
  }
}

const wyniki: Wynik[] = SERIE.map((s) => {
  const t = czasy.get(s.id)!.slice().sort((a, b) => a - b);
  return {
    id: s.id,
    opis: s.opis,
    n: t.length,
    p50: percentyl(t, 0.5),
    p95: percentyl(t, 0.95),
    p99: percentyl(t, 0.99),
    kody: Object.fromEntries([...kody.get(s.id)!].map(([k, v]) => [String(k), v])),
  };
});

for (const app of serwery.values()) await app.close();

// ------------------------------------------------------------------ wydruk
console.log(`\nzadan na serie: ${naSerie}, rozgrzewka odrzucona: ${ROZGRZEWKA}`);
console.log(`artefakt: atrapa (${SERIE.length} serie przeplotem)\n`);
console.log('seria           p50        p95        p99      kody');
for (const w of wyniki) {
  console.log(
    `${w.id.padEnd(14)} ${w.p50.toFixed(3).padStart(7)} ms ${w.p95.toFixed(3).padStart(7)} ms ` +
    `${w.p99.toFixed(3).padStart(7)} ms   ${JSON.stringify(w.kody)}`);
}

const bazowa = wyniki[0];
const kontrolna = wyniki[1];
const podlogaSzumu = {
  p50: Math.abs(kontrolna.p50 - bazowa.p50),
  p95: Math.abs(kontrolna.p95 - bazowa.p95),
  p99: Math.abs(kontrolna.p99 - bazowa.p99),
};

console.log(`\nPODLOGA SZUMU (dwie identyczne serie): ` +
  `p50 ${podlogaSzumu.p50.toFixed(3)} ms, p95 ${podlogaSzumu.p95.toFixed(3)} ms, ` +
  `p99 ${podlogaSzumu.p99.toFixed(3)} ms`);

const mierzalny = podlogaSzumu.p99 < PROG_MS;
console.log(mierzalny
  ? `Prog ${PROG_MS} ms jest MIERZALNY tym przyrzadem (podloga ${podlogaSzumu.p99.toFixed(3)} ms < ${PROG_MS} ms).`
  : `Prog ${PROG_MS} ms jest NIEMIERZALNY: sam szum daje ${podlogaSzumu.p99.toFixed(3)} ms.\n` +
    `  Zwieksz probe (--zadan) albo podnies prog - inaczej zadanie 8.8 bedzie fikcja.`);

// ------------------------------------------------------------- odniesienie
if (ZAPISZ) {
  const odniesienie = {
    opis: 'Wartosci odniesienia dla progu z zadania 8.8. Mierzone app.inject, ' +
      'czyli pelny cykl zycia zadania w Fastify bez gniazda systemowego.',
    zmierzono: new Date().toISOString(),
    etap: 'przed 8A (bez uwierzytelniania)',
    maszyna: `${process.platform}-${process.arch}, node ${process.version}`,
    artefakt: 'atrapa testowa',
    zadanNaSerie: naSerie,
    rozgrzewka: ROZGRZEWKA,
    czuloscMs: podlogaSzumu,
    serie: wyniki,
  };
  writeFileSync(PLIK_ODNIESIENIA, JSON.stringify(odniesienie, null, 2) + '\n');
  console.log(`\nZapisano odniesienie: ${PLIK_ODNIESIENIA}`);
} else if (existsSync(PLIK_ODNIESIENIA)) {
  const stare = JSON.parse(readFileSync(PLIK_ODNIESIENIA, 'utf8')) as {
    etap: string; serie: Wynik[];
  };
  const bazoweStare = stare.serie[0];
  const delta = bazowa.p99 - bazoweStare.p99;
  console.log(`\nWobec odniesienia (${stare.etap}): p99 ${bazoweStare.p99.toFixed(3)} ms ` +
    `-> ${bazowa.p99.toFixed(3)} ms, delta ${delta >= 0 ? '+' : ''}${delta.toFixed(3)} ms`);
}

process.exit(mierzalny ? 0 : 1);
