/**
 * Uwierzytelnianie kluczem API i dwupoziomowe limitowanie (zadanie 8.4b).
 *
 * WYMAGA BAZY z migracja 004_licencje.sql. Artefakt indeksu buduje sobie sam (atrapa).
 *
 * NAJWAZNIEJSZA KONTROLA CALEGO ETAPU to nr 11: kubelek limitu jest PER
 * ZWERYFIKOWANY KLIENT. Etap 8A przywraca klucze API jako klucz limitowania,
 * czyli wraca dokladnie w miejsce luki z zadania 8.1 - a zasada brzmi, ze
 * kluczem limitowania moze byc wylacznie wartosc wczesniej zweryfikowana.
 *
 * ODWROCENIA - kazde wykonane i sprawdzone:
 *   - registerAuth przestawiony z onRequest na preHandler  -> kontrola 11
 *   - keyGenerator kluczujacy po kluczId zamiast klientId   -> kontrola 11
 *   - jednakowe cialo 401 zastapione roznymi komunikatami   -> kontrola 4
 *   - usuniete '/metrics' z listy tras bez klucza           -> kontrola 8
 *   - usuniete wywolanie limitera adresu w odmowie          -> kontrola 12
 *
 *   node --experimental-strip-types packages/api/test/uwierzytelnianie.ts
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { generateApiKey } from '@adres-pl/core';
import { buildServer, loadConfig } from '../src/server.ts';
import { Peppers } from '../src/keys/pepper.ts';
import { writeIndexStub } from './index-stub.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://adres:adres@localhost:5432/adres';
const PEPPER = 'pieprz-testowy-8.4b';
const peppers = new Peppers(new Map([[1, PEPPER]]), 1);

let errors = 0;
const report = (ok: boolean, description: string) => {
  console.log(`${ok ? 'OK  ' : 'ERROR'} ${description}`);
  if (!ok) errors++;
};

const artifact = await writeIndexStub(
  join(await mkdtemp(join(tmpdir(), 'adres-auth-')), 'current.bin'));

// --- przygotowanie danych ----------------------------------------------
//
// Kazdy przebieg zaklada wlasnych klientow i generuje wlasne sekrety - w tym
// schemacie nie kasujemy rekordow, a skrot ma unikat, wiec inaczej drugi
// przebieg lamalby wiez.
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
const stamp = `auth-8a-${Date.now()}`;

async function createClient(name: string, limitMin: number): Promise<number> {
  const { rows: [r] } = await db.query<{ id: string }>(
    `INSERT INTO licensing.client (name, plan, rate_limit_per_min)
     VALUES ($1, 'test', $2) RETURNING id`, [`${stamp}-${name}`, limitMin]);
  return Number(r.id);
}

interface IssuedKey { plaintext: string; id: number }

// Daty liczymy w JS i przekazujemy jako parametry. Wyrazenie SQL w miejscu
// parametru (np. "now() - interval '1 day'") trafia do bazy jako LITERAL
// tekstowy i konczy sie bledem parsowania daty - parametr nie jest kodem.
async function issueKey(
  clientId: number,
  opcje: { validFrom?: Date; validTo?: Date; revokedAt?: Date; keyLimit?: number } = {},
): Promise<IssuedKey> {
  const plaintext = generateApiKey('live');
  const hash = Buffer.from(peppers.hash(plaintext).hex, 'hex');
  const { rows: [r] } = await db.query<{ id: string }>(
    `INSERT INTO licensing.api_key
       (client_id, environment, prefix, hash, valid_from, valid_to, revoked_at, rate_limit_per_min)
     VALUES ($1, 'live', 'adr_live_', $2, coalesce($3, now()), $4, $5, $6) RETURNING id`,
    [clientId, hash, opcje.validFrom ?? null, opcje.validTo ?? null,
      opcje.revokedAt ?? null, opcje.keyLimit ?? null]);
  return { plaintext, id: Number(r.id) };
}

const clientA = await createClient('A', 600);
const clientB = await createClient('B', 600);
const keyA1 = await issueKey(clientA);
const keyA2 = await issueKey(clientA);
const keyB = await issueKey(clientB);
const expiredKey = await issueKey(clientA, { validTo: new Date(Date.now() - 86_400_000) });
const revokedKey = await issueKey(clientA, { revokedAt: new Date(Date.now() - 1000) });

const suspendedClient = await createClient('suspended', 600);
const suspendedClientKey = await issueKey(suspendedClient);
await db.query(`UPDATE licensing.client SET suspended_at = now() WHERE id = $1`,
  [suspendedClient]);

function environment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LOG_LEVEL: 'error',
    DATABASE_URL,
    INDEX_SOURCE: artifact,
    INDEX_POLL_MS: '0',
    API_KEY_PEPPER_1: PEPPER,
    API_KEY_PEPPER_ACTIVE: '1',
    KEYS_REFRESH_MS: '500',
    ...overrides,
  };
}

// --- 1. Tryb wylaczony: zerowa zmiana zachowania -----------------------
const disabled = await buildServer(loadConfig(environment({ API_KEY_MODE: 'disabled' })));
const withoutKeyDisabled = await disabled.inject({ url: '/v1/suggest?q=marszalkowska' });
report(withoutKeyDisabled.statusCode === 200,
  `tryb wylaczony: zadanie bez klucza => ${withoutKeyDisabled.statusCode}`);
await disabled.close();

// --- serwer w trybie wymaganym -----------------------------------------
const app = await buildServer(loadConfig(environment({
  API_KEY_MODE: 'required',
  RATE_LIMIT_UNAUTHENTICATED: '20',
})));

/** Licznik zapytan do bazy - straznik przeslanki "baza poza sciezka zadania". */
let dbQueryCount = 0;
const oryginalneQuery = app.pool.query.bind(app.pool);
app.pool.query = ((...a: unknown[]) => {
  dbQueryCount++;
  return (oryginalneQuery as (...x: unknown[]) => unknown)(...a);
}) as typeof app.pool.query;

const withKey = (key: string, url = '/v1/suggest?q=marszalkowska') =>
  app.inject({ url, headers: { 'x-api-key': key } });

// --- 2. Brak klucza --------------------------------------------------
const brak = await app.inject({ url: '/v1/suggest?q=marszalkowska' });
report(brak.statusCode === 401 && brak.json().code === 'MISSING_KEY',
  `brak naglowka => ${brak.statusCode} ${brak.json().code}`);

// --- 3-4. Zly format i klucz nieznany sa NIEODROZNIALNE ---------------
//
// Roznica w komunikacie zamienia odpowiedz w wyrocznie dla zgadujacego:
// mowilaby, ktory z 10 tys. probowanych kluczy ma poprawna sume, czyli
// pochodzi z naszego generatora.
const beforeFormat = dbQueryCount;
const wrongFormat = await withKey('adr_live_to-nie-jest-klucz');
const poFormacie = dbQueryCount;
const unknown = await withKey(generateApiKey('live'));

report(wrongFormat.statusCode === 401 && poFormacie === beforeFormat,
  `zly format => 401 bez ani jednego zapytania do bazy (zapytan: ${poFormacie - beforeFormat})`);
report(wrongFormat.body === unknown.body && wrongFormat.statusCode === unknown.statusCode,
  'zly format i klucz nieznany daja IDENTYCZNE cialo odpowiedzi');

// --- 5. Wazny klucz ---------------------------------------------------
const valid = await withKey(keyA1.plaintext);
report(valid.statusCode === 200, `wazny klucz => ${valid.statusCode}`);

// --- 6. Klucz w query stringu jest traktowany jak jego brak -----------
//
// Query string trafia do access logu ingressu, do naglowka Referer
// i do historii przegladarki.
const wQuery = await app.inject({
  url: `/v1/suggest?q=marszalkowska&api_key=${encodeURIComponent(keyA1.plaintext)}`,
});
report(wQuery.statusCode === 401, `klucz w query stringu => ${wQuery.statusCode}`);

// --- 7. Trzy rozne stany, trzy rozne kody 403 ------------------------
const wygasly = await withKey(expiredKey.plaintext);
const revoked = await withKey(revokedKey.plaintext);
const suspended = await withKey(suspendedClientKey.plaintext);
report(
  wygasly.statusCode === 403 && wygasly.json().code === 'EXPIRED' &&
  revoked.statusCode === 403 && revoked.json().code === 'REVOKED' &&
  suspended.statusCode === 403 && suspended.json().code === 'SUSPENDED',
  `wygasly/uniewazniony/zawieszony => ${wygasly.json().code}, ` +
  `${revoked.json().code}, ${suspended.json().code}`);

// --- 7b. Klucz jeszcze niewazny i klucz z innego srodowiska ----------
//
// Obie kontrole powstaly po przegladzie kodu: kolumna wazny_od istniala od
// migracji 003 i NIE byla sprawdzana (klucz wystawiony "od jutra" dzialal
// od razu), a prefiks adr_test_ wobec adr_live_ byl wylacznie ozdoba -
// skrot liczymy z calego ciagu, wiec klucz testowy uwierzytelnial sie na
// instalacji produkcyjnej dokladnie tak samo jak produkcyjny.
// Klucze zakladane PO starcie serwera musza najpierw dotrzec do repliki
// (kanalem NOTIFY, typowo kilkadziesiat ms). Bez tego oczekiwania kontrola
// mierzylaby nie stan klucza, tylko szybkosc propagacji.
const toReplica = () => new Promise((r) => setTimeout(r, 900));

const futureKey = await issueKey(clientA, {
  validFrom: new Date(Date.now() + 86_400_000),
});
await toReplica();
const future = await withKey(futureKey.plaintext);
report(future.statusCode === 403 && future.json().code === 'NOT_YET_VALID',
  `klucz wazny od jutra => ${future.statusCode} ${future.json().code}`);

// Klucz zapisany w rejestrze jako 'live', ale przedstawiony z prefiksem test:
// skrot jest liczony z calego ciagu, wiec musi to byc INNY ciag - budujemy go,
// podmieniajac srodowisko w rejestrze, nie w kluczu.
const testKey = await issueKey(clientA);
await db.query(`UPDATE licensing.api_key SET environment = 'test' WHERE id = $1`,
  [testKey.id]);
await toReplica();
const wrongEnvironment = await withKey(testKey.plaintext);
report(wrongEnvironment.statusCode === 401,
  `klucz adr_live_ zapisany jako 'test' => ${wrongEnvironment.statusCode} ` +
  '(nieodroznialne od klucza nieznanego)');

// --- 8. Sondy i metryki zostaja otwarte ------------------------------
//
// Kontrola ratujaca wdrozenie: gdyby /metrics dostawal 401, Prometheus
// przestalby zbierac, up{job="adres-api"} spadlby do zera i zapalilby sie
// krytyczny BrakMetrykZSerwisu - przy w pelni sprawnej usludze.
const sondy = await Promise.all(['/health', '/ready', '/metrics', '/status']
  .map((u) => app.inject({ url: u }).then((r) => `${u}:${r.statusCode}`)));
report(sondy.every((s) => s.endsWith(':200')), `sondy bez klucza => ${sondy.join(' ')}`);

// --- 9. Preflight CORS nie moze dostac 401 ---------------------------
const preflight = await app.inject({
  method: 'OPTIONS', url: '/v1/suggest',
  headers: { origin: 'https://przyklad.pl', 'access-control-request-method': 'GET' },
});
report(preflight.statusCode < 400, `preflight OPTIONS => ${preflight.statusCode}`);

// --- 10. Sondowanie nieistniejacych sciezek nie jest darmowe ---------
const fourHundred = await app.inject({ url: '/nie-ma-takiej-trasy' });
const fourHundredWithKey = await withKey(keyA1.plaintext, '/nie-ma-takiej-trasy');
report(fourHundred.statusCode === 401 && fourHundredWithKey.statusCode === 404,
  `nieznana sciezka: bez klucza ${fourHundred.statusCode}, z waznym ${fourHundredWithKey.statusCode}`);

// --- 11. ZASADA ZELAZNA: kubelek jest per ZWERYFIKOWANY KLIENT -------
//
// Dwa klucze tego samego klienta MUSZA dzielic jeden licznik - inaczej klient
// podnosi sobie przepustowosc, wystawiajac kolejne klucze. Klucze roznych
// klientow MUSZA miec counters rozdzielne.
const remaining = (r: { headers: Record<string, unknown> }) =>
  Number(r.headers['x-ratelimit-remaining']);

const a1 = await withKey(keyA1.plaintext);
const a2 = await withKey(keyA2.plaintext);
const b1 = await withKey(keyB.plaintext);

report(remaining(a2) === remaining(a1) - 1,
  `dwa klucze klienta A dziela kubelek (pozostalo ${remaining(a1)} -> ${remaining(a2)})`);
report(remaining(b1) > remaining(a2),
  `klient B ma wlasny kubelek (A: ${remaining(a2)}, B: ${remaining(b1)})`);

// --- 12. Zgadywanie kluczy jest limitowane i nie dotyka bazy ---------
//
// Zadanie odrzucone w onRequest nigdy nie dochodzi do limitera trasy, wiec
// bez drugiego poziomu limitu zgadywanie byloby CALKOWICIE nielimitowane.
const beforeGuessing = dbQueryCount;
const codes: number[] = [];
for (let i = 0; i < 40; i++) {
  codes.push((await withKey(generateApiKey('live'))).statusCode);
}
const rejectedByLimit = codes.filter((k) => k === 429).length;
report(rejectedByLimit > 0 && dbQueryCount === beforeGuessing,
  `40 prob nieznanymi kluczami: ${rejectedByLimit} odrzuconych limitem, ` +
  `zapytan do bazy: ${dbQueryCount - beforeGuessing}`);

// --- 13. Metryki nie zdradzaja klucza ani skrotu ---------------------
const metrics = (await app.inject({ url: '/metrics' })).body;
report(!metrics.includes('adr_live_') && !/[0-9a-f]{64}/.test(metrics)
  && metrics.includes('adres_auth_total'),
  'metryki zawieraja licznik uwierzytelnien i nie zawieraja klucza ani skrotu');

await app.close();
await db.end();
console.log(errors === 0 ? '\nWszystkie kontrole przeszly.' : `\n${errors} kontroli nie przeszlo.`);
process.exit(errors === 0 ? 0 : 1);
