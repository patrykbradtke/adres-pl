/**
 * Klucz API - generowanie, format, rozbior (zadanie 8.3).
 *
 * CZYSTO JEDNOSTKOWY: bez serwera, bez bazy, bez artefaktu indeksu. Dzieki
 * temu stoi jako PIERWSZY w lancuchu npm test - skrypt laczy pliki przez &&,
 * wiec zestaw wymagajacy czegokolwiek z zewnatrz przerywa ciag i wszystko za
 * nim nigdy sie nie uruchamia.
 *
 * ODWROCENIA - kazde wykonane i sprawdzone, nie zalozone:
 *   - usun z parseApiKey porownanie sumy               -> kontrola 3 (5000/5000)
 *   - zmien API_KEY_SECRET_BYTES z 24 na 22            -> kontrole 1 i 2
 *   - dodaj `import ... from 'node:crypto'` w core/src -> kontrola 6
 *   - zamien crc32(secret) na crc32(secret + pieprz)   -> kontrola 7
 *
 *   node --experimental-strip-types packages/core/test/api-key.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  generateApiKey, parseApiKey, formatApiKey, apiKeyChecksum,
  API_KEY_LENGTH, RE_API_KEY,
} from '../src/api-key.ts';

let errors = 0;
const report = (ok: boolean, description: string) => {
  console.log(`${ok ? 'OK  ' : 'ERROR'} ${description}`);
  if (!ok) errors++;
};

// --- 1. Ksztalt i unikalnosc -------------------------------------------
const N = 10_000;
const keys: string[] = [];
for (let i = 0; i < N; i++) keys.push(generateApiKey(i % 2 ? 'live' : 'test'));

const wrongLength = keys.filter((k) => k.length !== API_KEY_LENGTH).length;
const withPadding = keys.filter((k) => k.includes('=')).length;
const mismatched = keys.filter((k) => !RE_API_KEY.test(k)).length;
const unique = new Set(keys).size;

report(wrongLength === 0 && withPadding === 0 && mismatched === 0 && unique === N,
  `${N} kluczy: dlugosc ${API_KEY_LENGTH} bez wyrownania, zgodne ze wzorcem, ` +
  `unikalnych ${unique}`);

// --- 2. Round-trip ------------------------------------------------------
let parseOk = 0;
for (const k of keys) {
  const p = parseApiKey(k);
  if (p && formatApiKey(p.environment, p.secret) === k) parseOk++;
}
report(parseOk === N, `rozbior odtwarza srodowisko i sekret dla ${parseOk} z ${N}`);

// --- 3. Suma kontrolna lapie literowke ---------------------------------
//
// Bez tej kontroli kazda literowka w kluczu integratora konczylaby sie
// zapytaniem do rejestru zamiast odrzuceniem na wejsciu.
const ALFABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
let passedMutations = 0;
const PROB = 5_000;
for (let i = 0; i < PROB; i++) {
  const k = keys[i % keys.length];
  // mutujemy wylacznie sekret, nie prefiks i nie sume
  const poz = 9 + (i % 32);
  const stary = k[poz];
  let created = stary;
  while (created === stary) created = ALFABET[Math.floor(Math.random() * ALFABET.length)];
  const mutated = k.slice(0, poz) + created + k.slice(poz + 1);
  if (parseApiKey(mutated) !== null) passedMutations++;
}
report(passedMutations === 0,
  `${PROB} mutacji jednego znaku odrzuconych bez wyjatku (przepuszczonych: ${passedMutations})`);

// --- 4. Wejscia niepoprawne --------------------------------------------
const reference = keys[0];
const wrong: Array<[unknown, string]> = [
  ['', 'pusty ciag'],
  ['!!!!!!', 'smieci'],
  [reference.slice(0, 47), 'o znak za krotki'],
  [reference + 'x', 'o znak za dlugi'],
  ['adr_prod_' + reference.slice(9), 'nieznane srodowisko'],
  [reference.replace('_', '-'), 'zepsuty separator prefiksu'],
  [null, 'null'],
  [undefined, 'undefined'],
  [12345, 'liczba'],
  [{ key: reference }, 'obiekt'],
];
const passed = wrong.filter(([w]) => parseApiKey(w) !== null).map(([, description]) => description);
report(passed.length === 0,
  `${wrong.length} wejsc niepoprawnych odrzuconych${passed.length ? ' - passedCount: ' + passed.join(', ') : ''}`);

// --- 5. Fuzz: nigdy nie rzuca ------------------------------------------
//
// parseApiKey stoi na sciezce kazdego zadania, wiec wyjatek bylby kodem 500
// sterowanym przez klienta - a to zamienia walidacje wejscia w wektor ataku.
let throws = 0;
const FUZZ = 20_000;
for (let i = 0; i < FUZZ; i++) {
  const dl = Math.floor(Math.random() * 60);
  let s = '';
  for (let j = 0; j < dl; j++) s += String.fromCharCode(Math.floor(Math.random() * 0x2000));
  try { parseApiKey(s); } catch { throws++; }
}
report(throws === 0, `${FUZZ} losowych ciagow nie wywolalo ani jednego wyjatku`);

// --- 6. Core zostaje wolny od zaleznosci srodowiskowych ----------------
//
// Straznik przeslanki z naglowka api-key.ts: ten sam kod ma dzialac
// w przegladarce w panelu administracyjnym. Pierwszy import node:* w core
// przewraca to zalozenie po cichu - dopoki ktos nie sprobuje zbudowac panelu.
const srcCore = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const zNode = readdirSync(srcCore)
  .filter((f) => f.endsWith('.ts'))
  .filter((f) => /from\s+['"]node:/.test(readFileSync(join(srcCore, f), 'utf8')));
report(zNode.length === 0,
  `pakiet core bez importow node:*${zNode.length ? ' - found w: ' + zNode.join(', ') : ''}`);

// --- 7. Algorytm sumy jest PRZYPIETY do wartosci wzorcowych ------------
//
// Warunek wykonalnosci zgloszenia prefiksu do skanera wyciekow (zadanie 8.9):
// partner dostaje opis algorytmu i musi potwierdzic ksztalt znalezionego
// klucza BEZ naszego sekretu. Kazda pozniejsza zmiana algorytmu - w tym
// domieszanie pieprza do sumy - uniewaznia to, co zglosilismy, i robi
// z klucza produkcyjnego ciag, ktorego skaner juz nie rozpozna.
//
// Kontrola sprawdzajaca sam determinizm tego NIE lapie: suma z domieszanym
// pieprzem jest rownie deterministyczna. Lapie to dopiero wartosc wzorcowa.
// (Zweryfikowane odwroceniem: przy `crc32(secret + 'pieprz')` kontrola
// determinizmu swiecila na zielono, ta czerwienieje.)
const REFERENCE_VECTORS: Array<[string, string]> = [
  ['adres-pl-wzorzec', 'V8lyEg'],
  ['', 'AAAAAA'],
];
const checksumMismatches = REFERENCE_VECTORS.filter(([we, expectedValue]) => apiKeyChecksum(we) !== expectedValue)
  .map(([we, expectedValue]) => `"${we}" -> ${apiKeyChecksum(we)} zamiast ${expectedValue}`);
report(checksumMismatches.length === 0,
  `algorytm sumy zgodny z wartosciami wzorcowymi${checksumMismatches.length ? ' - ' + checksumMismatches.join('; ') : ''}`);

console.log(errors === 0 ? '\nWszystkie kontrole przeszly.' : `\n${errors} kontroli nie przeszlo.`);
process.exit(errors === 0 ? 0 : 1);
