/**
 * Limity per klient i kwota miesieczna (zadanie 8.5).
 *
 * WYMAGA BAZY z migracja 004_licencje.sql.
 *
 * Zestaw pilnuje rozroznienia, ktore plan produkcyjny sklein w jedno zdanie
 * ("limity i kwoty per klient, magazyn wspoldzielony"):
 *   LIMIT NA MINUTE - ochrona przed przeciazeniem, licznik LOKALNY,
 *   KWOTA MIESIECZNA - podstawa faktury, wspoldzielona przez Postgresa.
 *
 * ODWROCENIA - kazde wykonane i sprawdzone:
 *   - cofnij `max` do stalej cfg.rateLimitMax        -> kontrole 1 i 2
 *   - zamien Math.min na `klucz ?? klient`           -> kontrola 2 (druga czesc)
 *   - policz wsad jako 1 jednostke zamiast items.length -> kontrole 3 i 4
 *   - pomin lokalne niezrzucone jednostki w kontroli kwoty -> kontrola 4
 *
 *   node --experimental-strip-types packages/api/test/kwoty.ts
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { generateApiKey } from '@adres-pl/core';
import { buildServer, loadConfig } from '../src/server.ts';
import { Peppers } from '../src/keys/pepper.ts';
import { writeIndexStub } from './index-stub.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://adres:adres@localhost:5432/adres';
const PEPPER = 'pieprz-kwoty-8.5';
const peppers = new Peppers(new Map([[1, PEPPER]]), 1);

let errors = 0;
const report = (ok: boolean, description: string) => {
  console.log(`${ok ? 'OK  ' : 'ERROR'} ${description}`);
  if (!ok) errors++;
};

const artifact = await writeIndexStub(
  join(await mkdtemp(join(tmpdir(), 'adres-kwoty-')), 'current.bin'));

const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
const stamp = `kwoty-8a-${Date.now()}`;

async function createClient(
  name: string, limitMin: number, quota: number | null = null,
): Promise<number> {
  const { rows: [r] } = await db.query<{ id: string }>(
    `INSERT INTO licensing.client (name, plan, rate_limit_per_min, monthly_quota)
     VALUES ($1, 'test', $2, $3) RETURNING id`, [`${stamp}-${name}`, limitMin, quota]);
  return Number(r.id);
}

async function issueKey(clientId: number, keyLimit: number | null = null): Promise<string> {
  const plaintext = generateApiKey('live');
  await db.query(
    `INSERT INTO licensing.api_key (client_id, environment, prefix, hash, rate_limit_per_min)
     VALUES ($1, 'live', 'adr_live_', $2, $3)`,
    [clientId, Buffer.from(peppers.hash(plaintext).hex, 'hex'), keyLimit]);
  return plaintext;
}

const smallClient = await createClient('maly', 3);
const largeClient = await createClient('duzy', 10);
const smallKey = await issueKey(smallClient);
const largeKey = await issueKey(largeClient);

const clientWithLimit = await createClient('zlimitem', 600);
const limitedKey = await issueKey(clientWithLimit, 1);
const inflatedKey = await issueKey(clientWithLimit, 10_000);

const clientWithQuota = await createClient('zkwota', 600, 10);
const quotaKey = await issueKey(clientWithQuota);

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
    // Zrzut wyzwalamy w tescie recznie - inaczej kontrola 5 czekalaby minute.
    USAGE_FLUSH_MS: '0',
    ...overrides,
  };
}

const app = await buildServer(loadConfig(environment()));
const hit = (key: string) =>
  app.inject({ url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': key } });

// --- 1. Limit jest PER KLIENT, nie per adres --------------------------
//
// Oba zadania ida z tego samego adresu. Gdyby limit byl liczony po adresie,
// klient z wyzszym pakietem dostawalby odmowe przez sasiada.
const smallClientCodes: number[] = [];
for (let i = 0; i < 5; i++) smallClientCodes.push((await hit(smallKey)).statusCode);
const duzyPoTym = await hit(largeKey);
report(smallClientCodes.filter((k) => k === 200).length === 3
  && smallClientCodes.filter((k) => k === 429).length === 2
  && duzyPoTym.statusCode === 200,
  `klient z limitem 3: ${smallClientCodes.join(' ')}; klient z limitem 10 z tego samego ` +
  `adresu: ${duzyPoTym.statusCode}`);

// --- 2. Limit na kluczu moze wartosc klienta tylko OBNIZYC ------------
//
// Inaczej klient podnosilby sobie przepustowosc, wystawiajac klucz z wyzszym
// limitem - a limit z umowy przestalby cokolwiek znaczyc.
const limitedKeyCodes: number[] = [];
for (let i = 0; i < 3; i++) limitedKeyCodes.push((await hit(limitedKey)).statusCode);

const remaining = (r: { headers: Record<string, unknown> }) =>
  Number(r.headers['x-ratelimit-limit']);
const rozdmuchany = await hit(inflatedKey);

report(limitedKeyCodes[0] === 200 && limitedKeyCodes[1] === 429,
  `klucz z limitem 1 przy kliencie 600: ${limitedKeyCodes.join(' ')}`);
report(remaining(rozdmuchany) === 600,
  `klucz z limitem 10000 przy kliencie 600 daje limit ${remaining(rozdmuchany)} (Math.min)`);

// --- 3. Wsad liczy POZYCJE, nie zadania -------------------------------
//
// Decyzji nie da sie dolozyc pozniej bez zmiany umow: wsad przyjmuje do 1000
// pozycji, wiec klient rozliczany w zadaniach obchodzi kwote, pakujac tysiac
// adresow w jedno zapytanie.
const batchClient = await createClient('wsadowy', 600, 1000);
const batchKey = await issueKey(batchClient);
await new Promise((r) => setTimeout(r, 700));

await app.inject({
  method: 'POST', url: '/v1/batch',
  headers: { 'x-api-key': batchKey, 'content-type': 'application/json' },
  payload: { items: [{ raw: 'a' }, { raw: 'b' }, { raw: 'c' }, { raw: 'd' }, { raw: 'e' }] },
});
await app.usage.flush();

const { rows: [batch] } = await db.query<{ requests: string; units: string }>(
  `SELECT sum(z.requests)::text AS requests, sum(z.units)::text AS units
     FROM licensing.usage z JOIN licensing.api_key k ON k.id = z.api_key_id
    WHERE k.client_id = $1`, [batchClient]);
report(batch.requests === '1' && batch.units === '5',
  `wsad z 5 pozycjami: zapytan ${batch.requests}, jednostek ${batch.units}`);

// --- 4. Kwota wyczerpana -> 429 z wlasnym kodem -----------------------
//
// Liczona jako stan z bazy PLUS jednostki jeszcze niezrzucone: sam odczyt
// z repliki pokazywalby zuzycie sprzed calego okna zrzutu.
const quotaCodes: number[] = [];
for (let i = 0; i < 13; i++) quotaCodes.push((await hit(quotaKey)).statusCode);
const lastOne = await hit(quotaKey);
const cialo = lastOne.json() as { code?: string };
report(quotaCodes.filter((k) => k === 200).length === 10
  && lastOne.statusCode === 429 && cialo.code === 'QUOTA_EXHAUSTED',
  `kwota 10 jednostek: przeszlo ${quotaCodes.filter((k) => k === 200).length}, ` +
  `potem ${lastOne.statusCode} ${cialo.code}`);

// --- 5. Kwota jest WSPOLDZIELONA miedzy instancjami -------------------
//
// To jest ta czesc, ktora naprawde musi isc przez baze. Druga instancja ma
// wlasny, pusty licznik lokalny - jesli mimo to odmawia, znaczy ze zobaczyla
// zuzycie zapisane przez pierwsza.
await app.usage.flush();
const second = await buildServer(loadConfig(environment()));
await second.registry.refresh(true);
const naDrugiej = await second.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': quotaKey } });
report(naDrugiej.statusCode === 429,
  `druga instancja widzi zuzycie pierwszej i odmawia: ${naDrugiej.statusCode}`);
await second.close();

await app.close();
await db.end();
console.log(errors === 0 ? '\nWszystkie kontrole przeszly.' : `\n${errors} kontroli nie przeszlo.`);
process.exit(errors === 0 ? 0 : 1);
