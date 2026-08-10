/**
 * Regresja jakosci wyszukiwania i walidacji (zadanie 6.8).
 *
 * Zbior wzorcowy: reference-set.yaml. Kazdy przypadek opisuje odpowiedz
 * POPRAWNA, nie biezaca - uzasadnienia sa w pliku obok przypadkow.
 *
 * Przypadki oznaczone `knownDeviation` to udokumentowane wady, ktore czekaja
 * na naprawe. Nie przewracaja zestawu, ale sa wypisywane, a gdy przestana
 * wystepowac - zestaw upomina sie o zdjecie znacznika. Dzieki temu lista
 * odstepstw nie moze po cichu ani urosnac, ani sklamac.
 *
 *   node --experimental-strip-types packages/api/test/search-quality.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { buildServer, loadConfig } from '../src/server.ts';

interface SuggestionCase {
  q: string;
  expected?: { label?: string; type?: string };
  expectedContains?: string;
  expectedLocality?: string;
  differentSimcs?: number;
  withoutDeadEnds?: boolean;
  inTop: number;
  why?: string;
  knownDeviation?: string;
}
interface ValidationCase {
  raw: string;
  expected?: Record<string, string>;
  containsNote?: string;
  why?: string;
  knownDeviation?: string;
}

const tu = dirname(fileURLToPath(import.meta.url));
const dataset = parse(readFileSync(join(tu, 'reference-set.yaml'), 'utf8')) as {
  dataVersion: string;
  suggestions: SuggestionCase[];
  validation: ValidationCase[];
};

const app = await buildServer(loadConfig({
  ...process.env,
  LOG_LEVEL: 'error',
  RATE_LIMIT_MAX: '1000000',
  // Tryb przypiety JAWNIE: ten zestaw mierzy JAKOSC WYNIKOW, a nie
  // uwierzytelnianie. Bez tego po zmianie domyslki w zadaniu 8.9 kazde
  // zapytanie konczyloby sie kodem 401, a zestaw raportowalby kilkanascie
  // rzekomych regresji jakosci.
  API_KEY_MODE: 'disabled',
}));

const version = (await app.inject({ method: 'GET', url: '/v1/suggest?q=warszawa&limit=1' })
  .then((r) => r.json())).dataVersion;

/**
 * Kontrola wstepna: zbior mierzy POZYCJE W RANKINGU wsrod 380 tys. ulic.
 *
 * Uruchomiony na innych danych - w szczegolnosci na atrapie artefaktu, ktorej
 * uzywaja pozostale zestawy - wypisuje kilkanascie bledow, ktore NIE SA
 * regresja jakosci, tylko brakiem danych. Wczesniej byla tu tylko uwaga
 * i przebieg lecial dalej: 19 czerwonych linii, z ktorych zadna nie mowila,
 * co naprawde jest nie tak. Tak wyglada sygnal, ktory uczy ludzi go ignorowac.
 *
 * Przy swiadomym uruchomieniu na nowszym zrzucie (np. po aktualizacji danych,
 * zeby zobaczyc, co sie zmienilo) DATASET_FORCE=1 przywraca dawne zachowanie.
 */
if (version !== dataset.dataVersion) {
  if (process.env.DATASET_FORCE !== '1') {
    console.log(`WARUNEK WSTEPNY NIESPELNIONY: zbior zamrozono na danych ${dataset.dataVersion}, ` +
      `a zaladowane sa "${version}".`);
    console.log('  Ten zestaw wymaga pelnych danych krajowych w indeksie ORAZ w bazie.');
    console.log('  Nie jest to regresja jakosci - to brak danych do pomiaru.');
    console.log('  Uruchom go w srodowisku po przebiegu ETL albo wymus: DATASET_FORCE=1 npm run quality');
    await app.close();
    process.exit(2);
  }
  console.log(`UWAGA: zbior zamrozono na danych ${dataset.dataVersion}, a zaladowane sa ${version}.`);
  console.log('       Rozbieznosci moga wynikac ze zmiany danych, nie z regresji.\n');
}

let errors = 0;
const deviationsRemaining: string[] = [];
const deviationsFixed: string[] = [];

function result(ok: boolean, description: string, deviation?: string) {
  if (deviation) {
    // Przypadek udokumentowany jako wadliwy: nie liczymy bledu, ale sledzimy stan.
    if (ok) deviationsFixed.push(description);
    else deviationsRemaining.push(description);
    console.log(`${ok ? 'NAPRAWIONE' : 'deviation'}  ${description}`);
    return;
  }
  console.log(`${ok ? 'OK  ' : 'ERROR'}        ${description}`);
  if (!ok) errors++;
}

// ---------------------------------------------------------------- suggestions
console.log('--- suggestions ---');
for (const p of dataset.suggestions) {
  const limit = Math.max(p.inTop, 10);
  const r = await app.inject({ method: 'GET', url: `/v1/suggest?q=${encodeURIComponent(p.q)}&limit=${limit}` });
  const results = (r.json().results ?? []) as Array<Record<string, unknown>>;
  const top = results.slice(0, p.inTop);

  let ok: boolean;
  let description: string;

  if (p.withoutDeadEnds) {
    // Miejscowosc bez punktow i bez ulic to slepy zaulek - po jej wybraniu
    // formularz nie ma czego zaproponowac. Ulic nie widzimy z poziomu
    // suggestions, ale `maUlice` odpowiada na to samo pytanie.
    const slepe = top.filter((x) => x.type === 'locality' && x.addressPointCount === 0 && x.hasStreets === false);
    ok = slepe.length === 0;
    description = `"${p.q}" — slepych zaulkow w top ${p.inTop}: ${slepe.length}` +
      (slepe.length ? ` (${slepe.map((x) => `${x.label}/${x.powiat}`).join(', ')})` : '');
  } else if (p.differentSimcs !== undefined) {
    const howMany = new Set(top.map((x) => x.simc)).size;
    ok = howMany >= p.differentSimcs;
    description = `"${p.q}" — roznych miejscowosci w top ${p.inTop}: ${howMany} (wymagane ${p.differentSimcs})`;
  } else if (p.expectedLocality) {
    const poz = results.findIndex((x) => x.locality === p.expectedLocality);
    ok = poz >= 0 && poz < p.inTop;
    description = `"${p.q}" — ${p.expectedLocality} na pozycji ${poz < 0 ? `poza top ${limit}` : poz + 1} (wymagane <= ${p.inTop})`;
  } else if (p.expectedContains) {
    const poz = top.findIndex((x) => String(x.label).includes(p.expectedContains!));
    ok = poz >= 0;
    description = `"${p.q}" — "${p.expectedContains}" ${ok ? `na position ${poz + 1}` : `brak w top ${p.inTop}`}`;
  } else {
    const chc = p.expected ?? {};
    const poz = top.findIndex((x) =>
      (chc.label === undefined || x.label === chc.label) &&
      (chc.type === undefined || x.type === chc.type));
    ok = poz >= 0;
    description = `"${p.q}" — "${chc.label ?? chc.type}" ${ok ? `na position ${poz + 1}` : `brak w top ${p.inTop}`}`;
  }
  result(ok, description, p.knownDeviation);
}

// ----------------------------------------------------------------- validation
console.log('\n--- validation ---');
for (const p of dataset.validation) {
  const r = await app.inject({
    method: 'POST', url: '/v1/validate',
    headers: { 'content-type': 'application/json' },
    payload: { raw: p.raw },
  });
  const body = r.json() as { address?: Record<string, unknown>; confidence?: string; issues?: Array<{ code: string }> };
  const address = body.address ?? {};
  const discrepancies: string[] = [];

  for (const [field, expectedValue] of Object.entries(p.expected ?? {})) {
    const jest = field === 'confidence' ? body.confidence : address[field];
    if (String(jest ?? '') !== expectedValue) discrepancies.push(`${field}: "${jest ?? ''}" zamiast "${expectedValue}"`);
  }
  if (p.containsNote && !(body.issues ?? []).some((i) => i.code === p.containsNote)) {
    discrepancies.push(`brak uwagi ${p.containsNote}`);
  }

  result(discrepancies.length === 0,
    `"${p.raw}"${discrepancies.length ? ' — ' + discrepancies.join('; ') : ''}`,
    p.knownDeviation);
}

// ----------------------------------------------------------------- podsumowanie
await app.close();

console.log(`\nPrzypadkow: ${dataset.suggestions.length + dataset.validation.length}`);
console.log(`Odstepstw nadal wystepujacych: ${deviationsRemaining.length}`);

if (deviationsFixed.length) {
  console.log('\nNAPRAWIONE ODSTEPSTWA - zdejmij znacznik `knownDeviation` w reference-set.yaml:');
  for (const o of deviationsFixed) console.log('  - ' + o);
  errors += deviationsFixed.length;
}

console.log(errors === 0
  ? '\nJakosc bez regresji.'
  : `\n${errors} problemow wymagajacych reakcji.`);
process.exit(errors === 0 ? 0 : 1);
