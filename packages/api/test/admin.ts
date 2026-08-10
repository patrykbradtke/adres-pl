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
import { writeIndexStub } from './index-stub.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://adres:adres@localhost:5432/adres';
const TOKEN = randomBytes(32).toString('base64url');
const PEPPER = 'pieprz-admin-8.7b';

let errors = 0;
const report = (ok: boolean, description: string) => {
  console.log(`${ok ? 'OK  ' : 'ERROR'} ${description}`);
  if (!ok) errors++;
};

const artifact = await writeIndexStub(
  join(await mkdtemp(join(tmpdir(), 'adres-admin-')), 'current.bin'));

function environment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LOG_LEVEL: 'error',
    DATABASE_URL,
    INDEX_SOURCE: artifact,
    INDEX_POLL_MS: '0',
    API_KEY_MODE: 'required',
    API_KEY_PEPPER_1: PEPPER,
    API_KEY_PEPPER_ACTIVE: '1',
    KEYS_REFRESH_MS: '400',
    ADMIN_TOKEN: TOKEN,
    ...overrides,
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
const routesWithoutToken: string[] = [];
const withoutToken = await buildServer(
  loadConfig({ ...environment(), ADMIN_TOKEN: '' }),
  { onRoute: ({ url }) => { if (url.startsWith('/admin')) routesWithoutToken.push(url); } },
);
await withoutToken.ready();
report(routesWithoutToken.length === 0,
  `bez ADMIN_TOKEN zadna trasa /admin nie trafia do routera (znaleziono: ${routesWithoutToken.length})`);
await withoutToken.close();

// --- serwer z tokenem ------------------------------------------------
const app = await buildServer(loadConfig(environment()));

// --- 2. Brak naglowka -> 401 -----------------------------------------
const withoutHeader = await app.inject({ url: '/admin/clients' });
report(withoutHeader.statusCode === 401 && withoutHeader.json().code === 'MISSING_TOKEN',
  `bez naglowka => ${withoutHeader.statusCode} ${withoutHeader.json().code}`);

// --- 3. Token o INNEJ dlugosci -> 401, nie 500 -----------------------
//
// timingSafeEqual rzuca RangeError przy roznych dlugosciach. Gdyby porownanie
// szlo po surowych wartosciach, klient wywolywalby kod 500 samym podaniem
// krotszego tokenu - czyli mialby darmowy sposob na halasowanie w logach.
const krotki = await app.inject({ url: '/admin/clients', headers: bearer('x') });
const dlugi = await app.inject({ url: '/admin/clients', headers: bearer('y'.repeat(500)) });
report(krotki.statusCode === 401 && dlugi.statusCode === 401,
  `token o innej dlugosci: krotki ${krotki.statusCode}, dlugi ${dlugi.statusCode} (zaden nie jest 500)`);

// --- utworzenie klienta i klucza -------------------------------------
const client = await app.inject({
  method: 'POST', url: '/admin/clients', headers: bearer(TOKEN),
  payload: { name: `admin-8a-${Date.now()}`, limitNaMinute: 100 },
});
const clientId = (client.json() as { id: number }).id;

const issued = await app.inject({
  method: 'POST', url: '/admin/keys', headers: bearer(TOKEN),
  payload: { clientId, name: 'klucz z testu' },
});
const plaintextKey = (issued.json() as { key: string }).key;

// --- 4. Rozdzielnosc mechanizmow - NAJWAZNIEJSZA ---------------------
const keyOnAdmin = await app.inject({ url: '/admin/keys', headers: bearer(plaintextKey) });
const tokenNaV1 = await app.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': TOKEN } });
report(keyOnAdmin.statusCode === 401 && tokenNaV1.statusCode === 401,
  `klucz kliencki na /admin => ${keyOnAdmin.statusCode}, ` +
  `token operatora jako x-api-key => ${tokenNaV1.statusCode}`);

// --- 5. Wystawiony klucz dziala na /v1 -------------------------------
await new Promise((r) => setTimeout(r, 900));
const naV1 = await app.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': plaintextKey } });
report(issued.statusCode === 201 && naV1.statusCode === 200
  && issued.headers['cache-control'] === 'no-store',
  `wystawienie ${issued.statusCode}, klucz dziala na /v1 ${naV1.statusCode}, ` +
  `cache-control: ${issued.headers['cache-control']}`);

// --- 6. Lista nie zdradza klucza ani skrotu --------------------------
//
// Prefiks (dokladnie "adr_live_", 9 znakow) jest jawny z zalozenia - sluzy
// do rozpoznania klucza w logu. Szukamy PELNEGO klucza i skrotu w hex.
const lista = await app.inject({ url: '/admin/keys', headers: bearer(TOKEN) });
const hasPlaintextKey = /adr_(live|test)_[A-Za-z0-9_-]{32}_[A-Za-z0-9_-]{6}/.test(lista.body);
const hasHash = /[0-9a-f]{64}/.test(lista.body);
report(lista.statusCode === 200 && !hasPlaintextKey && !hasHash,
  `lista kluczy: ${lista.statusCode}, zawiera klucz jawny: ${hasPlaintextKey}, skrot: ${hasHash}`);

// --- 7. Rotacja i uniewaznienie --------------------------------------
const keyId = (issued.json() as { id: number }).id;
const rotation = await app.inject({
  method: 'POST', url: '/admin/keys/rotate', headers: bearer(TOKEN),
  payload: { keyId, periodDays: 3 },
});
const nastepca = (rotation.json() as { key: string }).key;
await new Promise((r) => setTimeout(r, 900));
const oldAfterRotation = await app.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': plaintextKey } });
const newAfterRotation = await app.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': nastepca } });
report(rotation.statusCode === 201 && oldAfterRotation.statusCode === 200
  && newAfterRotation.statusCode === 200,
  `rotacja: oba klucze dzialaja w okresie przejsciowym ` +
  `(stary ${oldAfterRotation.statusCode}, nowy ${newAfterRotation.statusCode})`);

const revocation = await app.inject({
  method: 'POST', url: '/admin/keys/revoke', headers: bearer(TOKEN),
  payload: { keyId, reason: 'test' },
});
await new Promise((r) => setTimeout(r, 900));
const afterRevocation = await app.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': plaintextKey } });
report(revocation.statusCode === 200 && afterRevocation.statusCode === 403
  && afterRevocation.json().code === 'REVOKED',
  `uniewaznienie przez API => klucz ${afterRevocation.statusCode} ${afterRevocation.json().code} ` +
  'w mniej niz sekunde');

await app.close();
console.log(errors === 0 ? '\nWszystkie kontrole przeszly.' : `\n${errors} kontroli nie przeszlo.`);
process.exit(errors === 0 ? 0 : 1);
