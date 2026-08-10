/**
 * Endpointy administracyjne (zadanie 8.7b).
 *
 * WYMAGA BAZY z migracja 004_licencje.sql.
 *
 * NAJWAZNIEJSZA JEST KONTROLA 4: klucz kliencki nie otwiera zadnej trasy
 * /admin, a token operatora nie otwiera zadnej trasy /v1. Gdyby jeden mechanizm
 * obslugiwal oba, dowolny klient wystawilby sobie klucz bez limitow - czyli
 * jedna trasa dawalaby eskalacje uprawnien z klienta na operatora.
 *
 * ODWROCENIA - kazde wykonane i sprawdzone:
 *   - dopusc klucze klienckie do /admin            -> kontrola 4
 *   - rejestruj trasy bezwarunkowo (bez tokenu)    -> kontrola 1
 *   - dodaj pole hash do odpowiedzi listy kluczy   -> kontrola 6
 *   - zamien tokenZgodny na porownanie surowych buforow -> kontrola 3 (kod 500)
 *
 *   node --experimental-strip-types packages/api/test/admin.ts
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer, loadConfig } from '../src/server.ts';
import { zapiszAtrapeIndeksu } from './atrapa-indeksu.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://adres:adres@localhost:5432/adres';
const TOKEN = randomBytes(32).toString('base64url');
const PIEPRZ = 'pieprz-admin-8.7b';

let bledy = 0;
const zglos = (ok: boolean, opis: string) => {
  console.log(`${ok ? 'OK  ' : 'BLAD'} ${opis}`);
  if (!ok) bledy++;
};

const artefakt = await zapiszAtrapeIndeksu(
  join(await mkdtemp(join(tmpdir(), 'adres-admin-')), 'current.bin'));

function srodowisko(nadpisz: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LOG_LEVEL: 'error',
    DATABASE_URL,
    INDEX_SOURCE: artefakt,
    INDEX_POLL_MS: '0',
    API_KEY_MODE: 'wymagany',
    API_KEY_PEPPER_1: PIEPRZ,
    API_KEY_PEPPER_AKTYWNY: '1',
    KLUCZE_ODSWIEZANIE_MS: '400',
    ADMIN_TOKEN: TOKEN,
    ...nadpisz,
  };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

// --- 1. Bez tokenu trasy NIE TRAFIAJA DO ROUTERA ---------------------
//
// Sprawdzamy to na poziomie ROUTERA, a nie po kodzie odpowiedzi, i to jest
// istotne: zadanie na nieistniejaca sciezke trafia w kontekst 404, ktory
// od zadania 8.4b przechodzi przez uwierzytelnianie klienckie i konczy sie
// kodem 401. Sondujacy nie odrozni wiec "nie ma takiej trasy" od "nie masz
// uprawnien" - i dobrze - ale test musi patrzec glebiej niz on.
const trasyBezTokenu: string[] = [];
const bezTokenu = await buildServer(
  loadConfig({ ...srodowisko(), ADMIN_TOKEN: '' }),
  { onRoute: ({ url }) => { if (url.startsWith('/admin')) trasyBezTokenu.push(url); } },
);
await bezTokenu.ready();
zglos(trasyBezTokenu.length === 0,
  `bez ADMIN_TOKEN zadna trasa /admin nie trafia do routera (znaleziono: ${trasyBezTokenu.length})`);
await bezTokenu.close();

// --- serwer z tokenem ------------------------------------------------
const app = await buildServer(loadConfig(srodowisko()));

// --- 2. Brak naglowka -> 401 -----------------------------------------
const bezNaglowka = await app.inject({ url: '/admin/clients' });
zglos(bezNaglowka.statusCode === 401 && bezNaglowka.json().code === 'BRAK_TOKENU',
  `bez naglowka => ${bezNaglowka.statusCode} ${bezNaglowka.json().code}`);

// --- 3. Token o INNEJ dlugosci -> 401, nie 500 -----------------------
//
// timingSafeEqual rzuca RangeError przy roznych dlugosciach. Gdyby porownanie
// szlo po surowych wartosciach, klient wywolywalby kod 500 samym podaniem
// krotszego tokenu - czyli mialby darmowy sposob na halasowanie w logach.
const krotki = await app.inject({ url: '/admin/clients', headers: bearer('x') });
const dlugi = await app.inject({ url: '/admin/clients', headers: bearer('y'.repeat(500)) });
zglos(krotki.statusCode === 401 && dlugi.statusCode === 401,
  `token o innej dlugosci: krotki ${krotki.statusCode}, dlugi ${dlugi.statusCode} (zaden nie jest 500)`);

// --- utworzenie klienta i klucza -------------------------------------
const klient = await app.inject({
  method: 'POST', url: '/admin/clients', headers: bearer(TOKEN),
  payload: { nazwa: `admin-8a-${Date.now()}`, limitNaMinute: 100 },
});
const klientId = (klient.json() as { id: number }).id;

const wystawiony = await app.inject({
  method: 'POST', url: '/admin/keys', headers: bearer(TOKEN),
  payload: { klientId, nazwa: 'klucz z testu' },
});
const kluczJawny = (wystawiony.json() as { klucz: string }).klucz;

// --- 4. Rozdzielnosc mechanizmow - NAJWAZNIEJSZA ---------------------
const kluczNaAdmin = await app.inject({ url: '/admin/keys', headers: bearer(kluczJawny) });
const tokenNaV1 = await app.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': TOKEN } });
zglos(kluczNaAdmin.statusCode === 401 && tokenNaV1.statusCode === 401,
  `klucz kliencki na /admin => ${kluczNaAdmin.statusCode}, ` +
  `token operatora jako x-api-key => ${tokenNaV1.statusCode}`);

// --- 5. Wystawiony klucz dziala na /v1 -------------------------------
await new Promise((r) => setTimeout(r, 900));
const naV1 = await app.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': kluczJawny } });
zglos(wystawiony.statusCode === 201 && naV1.statusCode === 200
  && wystawiony.headers['cache-control'] === 'no-store',
  `wystawienie ${wystawiony.statusCode}, klucz dziala na /v1 ${naV1.statusCode}, ` +
  `cache-control: ${wystawiony.headers['cache-control']}`);

// --- 6. Lista nie zdradza klucza ani skrotu --------------------------
//
// Prefiks (dokladnie "adr_live_", 9 znakow) jest jawny z zalozenia - sluzy
// do rozpoznania klucza w logu. Szukamy PELNEGO klucza i skrotu w hex.
const lista = await app.inject({ url: '/admin/keys', headers: bearer(TOKEN) });
const maPelnyKlucz = /adr_(live|test)_[A-Za-z0-9_-]{32}_[A-Za-z0-9_-]{6}/.test(lista.body);
const maSkrot = /[0-9a-f]{64}/.test(lista.body);
zglos(lista.statusCode === 200 && !maPelnyKlucz && !maSkrot,
  `lista kluczy: ${lista.statusCode}, zawiera klucz jawny: ${maPelnyKlucz}, skrot: ${maSkrot}`);

// --- 7. Rotacja i uniewaznienie --------------------------------------
const kluczId = (wystawiony.json() as { id: number }).id;
const rotacja = await app.inject({
  method: 'POST', url: '/admin/keys/rotate', headers: bearer(TOKEN),
  payload: { kluczId, okresDni: 3 },
});
const nastepca = (rotacja.json() as { klucz: string }).klucz;
await new Promise((r) => setTimeout(r, 900));
const staryPoRotacji = await app.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': kluczJawny } });
const nowyPoRotacji = await app.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': nastepca } });
zglos(rotacja.statusCode === 201 && staryPoRotacji.statusCode === 200
  && nowyPoRotacji.statusCode === 200,
  `rotacja: oba klucze dzialaja w okresie przejsciowym ` +
  `(stary ${staryPoRotacji.statusCode}, nowy ${nowyPoRotacji.statusCode})`);

const uniewaznienie = await app.inject({
  method: 'POST', url: '/admin/keys/revoke', headers: bearer(TOKEN),
  payload: { kluczId, powod: 'test' },
});
await new Promise((r) => setTimeout(r, 900));
const poUniewaznieniu = await app.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': kluczJawny } });
zglos(uniewaznienie.statusCode === 200 && poUniewaznieniu.statusCode === 403
  && poUniewaznieniu.json().code === 'UNIEWAZNIONY',
  `uniewaznienie przez API => klucz ${poUniewaznieniu.statusCode} ${poUniewaznieniu.json().code} ` +
  'w mniej niz sekunde');

await app.close();
console.log(bledy === 0 ? '\nWszystkie kontrole przeszly.' : `\n${bledy} kontroli nie przeszlo.`);
process.exit(bledy === 0 ? 0 : 1);
