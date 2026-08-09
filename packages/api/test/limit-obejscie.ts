/**
 * Straznik zasady zelaznej: KLUCZEM LIMITOWANIA MOZE BYC WYLACZNIE WARTOSC
 * WCZESNIEJ ZWERYFIKOWANA (zadania 8.1 i 8.4c).
 *
 * HISTORIA, KTORA TEN PLIK PILNUJE
 *
 * Do 8.08.2026 kluczem limitowania byl naglowek x-api-key z odwrotem na req.ip.
 * Nagowka nikt nie weryfikowal, wiec klient losujacy jego wartosc przy kazdym
 * zadaniu dostawal swiezy licznik i CALKOWICIE omijal limitowanie. Nie byl to
 * brak funkcji, tylko dzialajacy mechanizm obejscia. Zadanie 8.1 przestawilo
 * limitowanie na req.ip.
 *
 * Etap 8A przywraca klucze API jako klucz limitowania, czyli wraca dokladnie
 * w to miejsce - tyle ze teraz czytana wartoscia jest req.klient, ustawiane
 * jedynie przez hook weryfikujacy.
 *
 * DLACZEGO TEN ZESTAW NIE DOTYKA BAZY
 *
 * Sprawdza zachowanie limitera dla ruchu BEZ waznego klucza - a to jest
 * zachowanie, ktore nie wymaga ani rejestru kluczy, ani pieprza. Dzieki temu
 * zostaje w hermetycznym npm test i dziala w swiezym klonie repozytorium.
 * Odpowiednik dla ruchu UWIERZYTELNIONEGO (wspolny kubelek klienta, rozdzielne
 * kubelki roznych klientow) siedzi w packages/api/test/uwierzytelnianie.ts,
 * kontrola 11, i wymaga bazy.
 *
 * JAK ZOBACZYC, ZE TEN TEST COKOLWIEK LAPIE - cztery odwrocenia, kazde
 * odtwarzajace inna droge powrotu tej samej wady:
 *
 *   1. w server.ts zamien keyGenerator na
 *        (req) => String(req.headers['x-api-key'] ?? req.ip)
 *      -> kontrola 1 MUSI sczerwieniec (wraca luka 8.1 wprost)
 *   2. w server.ts zamien keyGenerator na (req) => req.headers['x-forwarded-for'] ?? req.ip
 *      -> kontrola 2 MUSI sczerwieniec (klient sam sobie ustawia kubelek)
 *   3. ustaw TRUST_PROXY=true w otoczeniu przebiegu
 *      -> kontrola 2 MUSI sczerwieniec (to samo, innymi drzwiami)
 *   4. w keys/auth.ts zamien hook z 'onRequest' na 'preHandler'
 *      -> kontrola 11 w uwierzytelnianie.ts MUSI sczerwieniec
 *
 * NIE OSLABIAC ASERCJI. Jesli ten test czerwienieje po zmianie w uwierzytelnianiu,
 * to znaczy, ze kubelek przestal byc liczony tak, jak zakladano - a nie, ze
 * asercja jest za ostra.
 *
 *   node --experimental-strip-types packages/api/test/limit-obejscie.ts
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer, loadConfig, parseTrustProxy } from '../src/server.ts';
import { zapiszAtrapeIndeksu } from './atrapa-indeksu.ts';

const LIMIT = 5;
const NADMIAR = 4;

const artefakt = await zapiszAtrapeIndeksu(
  join(await mkdtemp(join(tmpdir(), 'adres-limit-')), 'current.bin'));

const app = await buildServer(loadConfig({
  ...process.env,
  RATE_LIMIT_MAX: String(LIMIT),
  INDEX_SOURCE: artefakt,
  INDEX_POLL_MS: '0',
  LOG_LEVEL: 'error',
  // Jawnie, mimo ze to domyslka: przypina intencje przed zmiana domyslki
  // w zadaniu 8.9 i jest widoczne dla czytajacego.
  API_KEY_MODE: 'wylaczony',
}));

let bledy = 0;
const zglos = (ok: boolean, opis: string) => {
  console.log(`${ok ? 'OK  ' : 'BLAD'} ${opis}`);
  if (!ok) bledy++;
};

const strzel = (naglowki: Record<string, string>) =>
  app.inject({ method: 'GET', url: '/v1/suggest?q=marszalkowska', headers: naglowki });

// --- 1. Losowany naglowek nie resetuje licznika ------------------------
//
// To jest oryginalna asercja z zadania 8.1, nietknieta.
const kody: number[] = [];
for (let i = 0; i < LIMIT + NADMIAR; i++) {
  kody.push((await strzel({ 'x-api-key': `losowy-${i}-${'x'.repeat(i)}` })).statusCode);
}
const odrzucone = kody.filter((s) => s === 429).length;
console.log('   kody przy losowanym naglowku:', kody.join(' '));
zglos(odrzucone === NADMIAR,
  `limit odrzucil ${odrzucone} z ${NADMIAR} zadan ponad limit mimo zmiany naglowka`);

// --- 2. Losowany X-Forwarded-For tez nie resetuje licznika -------------
//
// Druga droga do tej samej luki. TRUST_PROXY jest domyslnie wylaczone, wiec
// Fastify ignoruje ten naglowek i req.ip zostaje adresem polaczenia. Gdyby
// ktos wlaczyl zaufanie "na wszelki wypadek", klient bez klucza zaczalby sam
// sobie ustawiac kubelek limitowania.
// SWIEZY serwer, bo kubelek zostal juz wyczerpany przez kontrole 1 (ten sam
// adres). Bez tego dziewiec odpowiedzi 429 przeszloby takze przy limiterze
// zepsutym tak, ze odrzuca wszystko - kontrola nie odroznialaby tych stanow.
const app2 = await buildServer(loadConfig({
  ...process.env,
  RATE_LIMIT_MAX: String(LIMIT),
  INDEX_SOURCE: artefakt,
  INDEX_POLL_MS: '0',
  LOG_LEVEL: 'error',
  API_KEY_MODE: 'wylaczony',
}));
const kodyProxy: number[] = [];
for (let i = 0; i < LIMIT + NADMIAR; i++) {
  kodyProxy.push((await app2.inject({
    method: 'GET', url: '/v1/suggest?q=marszalkowska',
    headers: { 'x-forwarded-for': `10.9.${i}.${i}` },
  })).statusCode);
}
await app2.close();
const odrzuconeProxy = kodyProxy.filter((s) => s === 429).length;
const przepuszczoneProxy = kodyProxy.filter((s) => s === 200).length;
console.log('   kody przy losowanym x-forwarded-for:', kodyProxy.join(' '));
zglos(przepuszczoneProxy === LIMIT && odrzuconeProxy === NADMIAR,
  `zmiana x-forwarded-for nie zalozyla nowych kubelkow: ${przepuszczoneProxy} przeszlo ` +
  `(limit ${LIMIT}), ${odrzuconeProxy} odrzuconych (oczekiwano ${NADMIAR})`);

// --- 3. Zaufanie do proxy domyslnie wylaczone --------------------------
const przypadki: Array<[string | undefined, boolean | number | string]> = [
  [undefined, false],
  ['false', false],
  ['true', true],
  ['1', 1],
  ['0', 0],
  ['10.0.0.0/8', '10.0.0.0/8'],
];
for (const [wejscie, oczekiwane] of przypadki) {
  const got = parseTrustProxy(wejscie);
  zglos(got === oczekiwane, `parseTrustProxy(${wejscie}) = ${JSON.stringify(got)}`);
}

await app.close();
console.log(bledy === 0 ? '\nWszystkie kontrole przeszly.' : `\n${bledy} kontroli nie przeszlo.`);
process.exit(bledy === 0 ? 0 : 1);
