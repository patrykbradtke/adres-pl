/**
 * Cykl zycia klucza i pieprza (zadanie 8.6).
 *
 * WYMAGA BAZY z migracja 004_licencje.sql. Artefakt buduje sobie sam.
 *
 * Trzy rzeczy, ktorych nie sprawdza zaden inny zestaw:
 *   - rotacja BEZPRZERWOWA: przez okres przejsciowy dzialaja OBA klucze,
 *   - rotacja PIEPRZA: instancja zna wiele wersji naraz, a usuniecie starej
 *     z konfiguracji jest bezpiecznikiem ostatniej szansy,
 *   - awaria bazy to DWIE NIEZALEZNE DECYZJE: uwierzytelnianie przepuszcza
 *     (fail-open), a o kierowaniu ruchu rozstrzyga /ready.
 *
 * ODWROCENIA - kazde wykonane i sprawdzone:
 *   - ustaw poprzednikowi uniewazniony_od zamiast wazny_do  -> kontrola 1
 *   - zmien hashAll tak, by liczyl tylko wersja aktywna     -> kontrola 3
 *   - usun warunek wieku repliki z /ready                   -> kontrola 5
 *   - zamien fail-open na odmowe przy przeterminowanej replice -> kontrola 5
 *
 * Dwa ostatnie odwrocenia razem sa dowodem, ze decyzja jest zaimplementowana
 * jako DWIE niezalezne, a nie jedna.
 *
 *   node --experimental-strip-types packages/api/test/cykl-zycia-klucza.ts
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
const PEPPER_1 = 'pieprz-stary-8.6';
const PEPPER_2 = 'pieprz-nowy-8.6';
const REFRESH_MS = 400;
/** Okno na dotarcie zmiany kanalem NOTIFY - z zapasem wobec zmierzonych 25 ms. */
const NA_PROPAGACJE_MS = 900;

let errors = 0;
const report = (ok: boolean, description: string) => {
  console.log(`${ok ? 'OK  ' : 'ERROR'} ${description}`);
  if (!ok) errors++;
};
const spij = (ms: number) => new Promise((r) => setTimeout(r, ms));

const artifact = await writeIndexStub(
  join(await mkdtemp(join(tmpdir(), 'adres-cykl-')), 'current.bin'));

const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
const stamp = `cykl-8a-${Date.now()}`;

const { rows: [client] } = await db.query<{ id: string }>(
  `INSERT INTO licensing.client (name, plan, rate_limit_per_min)
   VALUES ($1, 'test', 600) RETURNING id`, [stamp]);
const clientId = Number(client.id);

/** Wystawia klucz skrotem liczonym WSKAZANA wersja pieprza. */
async function issue(
  pepperVersion: 1 | 2,
  opcje: { replaces?: number } = {},
): Promise<{ plaintext: string; id: number }> {
  const plaintext = generateApiKey('live');
  const pepper = pepperVersion === 1 ? PEPPER_1 : PEPPER_2;
  const set = new Peppers(new Map([[pepperVersion, pepper]]), pepperVersion);
  const hash = Buffer.from(set.hash(plaintext).hex, 'hex');
  const { rows: [r] } = await db.query<{ id: string }>(
    `INSERT INTO licensing.api_key
       (client_id, environment, prefix, hash, pepper_version, replaces_id)
     VALUES ($1, 'live', 'adr_live_', $2, $3, $4) RETURNING id`,
    [clientId, hash, pepperVersion, opcje.replaces ?? null]);
  return { plaintext, id: Number(r.id) };
}

const keyA = await issue(1);

function environment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LOG_LEVEL: 'error',
    DATABASE_URL,
    INDEX_SOURCE: artifact,
    INDEX_POLL_MS: '0',
    API_KEY_MODE: 'required',
    API_KEY_PEPPER_1: PEPPER_1,
    API_KEY_PEPPER_ACTIVE: '1',
    KEYS_REFRESH_MS: String(REFRESH_MS),
    ...overrides,
  };
}

const app = await buildServer(loadConfig(environment()));
const hit = (key: string) =>
  app.inject({ url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': key } });

// --- 1. Rotacja bezprzerwowa ------------------------------------------
//
// Definicja bezprzerwowosci: przez okres przejsciowy dzialaja OBA klucze.
// Gdyby wystawienie nastepcy uniewaznialo poprzednika natychmiast, kazda
// rotacja bylaby krotka awaria u klienta, ktory nie zdazyl podmienic klucza.
const keyB = await issue(1, { replaces: keyA.id });
await db.query(
  `UPDATE licensing.api_key SET valid_to = now() + interval '1 hour' WHERE id = $1`,
  [keyA.id]);
await spij(NA_PROPAGACJE_MS);

const a1 = await hit(keyA.plaintext);
const b1 = await hit(keyB.plaintext);
report(a1.statusCode === 200 && b1.statusCode === 200,
  `okres przejsciowy: poprzednik ${a1.statusCode}, nastepca ${b1.statusCode} (oba maja dzialac)`);

// --- 2. Koniec okresu przejsciowego -----------------------------------
await db.query(
  `UPDATE licensing.api_key SET valid_to = now() - interval '1 second' WHERE id = $1`,
  [keyA.id]);
await spij(NA_PROPAGACJE_MS);
const a2 = await hit(keyA.plaintext);
const b2 = await hit(keyB.plaintext);
report(a2.statusCode === 403 && a2.json().code === 'EXPIRED' && b2.statusCode === 200,
  `po okresie przejsciowym: poprzednik ${a2.statusCode} ${a2.json().code}, nastepca ${b2.statusCode}`);

// --- 3. Uniewaznienie natychmiastowe jednym UPDATE --------------------
//
// Sedno: NOTIFY siedzi w wyzwalaczu, nie w kodzie aplikacji, wiec reakcja
// na wyciek nie wymaga panelu ani wdrozenia - wystarczy psql.
await db.query(
  `UPDATE licensing.api_key SET revoked_at = now(), revocation_reason = 'test'
    WHERE id = $1`, [keyB.id]);
await spij(NA_PROPAGACJE_MS);
const b3 = await hit(keyB.plaintext);
report(b3.statusCode === 403 && b3.json().code === 'REVOKED',
  `uniewaznienie jednym UPDATE => ${b3.statusCode} ${b3.json().code}`);
await app.close();

// --- 4. Rotacja pieprza -----------------------------------------------
//
// Kluczowa wlasnosc: NIE DA SIE przeliczyc skrotu na nowy pieprz, bo wymagaloby
// to klucza JAWNEGO, ktorego z zalozenia nie mamy. Rotacja pieprza to zawsze
// wymiana kluczy, a wieloelementowy zestaw pozwala ja przeprowadzic bez przerwy.
const oldKey = await issue(1);
const newKey = await issue(2);

const twoPeppers = await buildServer(loadConfig(environment({
  API_KEY_PEPPER_2: PEPPER_2,
  API_KEY_PEPPER_ACTIVE: '2',
})));
const stary = await twoPeppers.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': oldKey.plaintext } });
const created = await twoPeppers.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': newKey.plaintext } });
report(stary.statusCode === 200 && created.statusCode === 200,
  `zestaw {1,2}: klucz na starym pieprzu ${stary.statusCode}, na nowym ${created.statusCode}`);
await twoPeppers.close();

// Bezpiecznik ostatniej szansy: usuniecie pieprza z konfiguracji uniewaznia
// NATYCHMIAST wszystkie klucze na nim policzone, we wszystkich instancjach,
// bez dotykania bazy. To FUNKCJA na wypadek wycieku pieprza, nie awaria.
const onlyNew = await buildServer(loadConfig({
  ...environment({ API_KEY_PEPPER_2: PEPPER_2, API_KEY_PEPPER_ACTIVE: '2' }),
  API_KEY_PEPPER_1: '',
}));
const afterRemoval = await onlyNew.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': oldKey.plaintext } });
const stillNew = await onlyNew.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': newKey.plaintext } });
report(afterRemoval.statusCode === 401 && stillNew.statusCode === 200,
  `po usunieciu pieprza 1: klucz na nim ${afterRemoval.statusCode}, klucz na pieprzu 2 ${stillNew.statusCode}`);
await onlyNew.close();

// --- 5. Awaria bazy: DWIE niezalezne decyzje --------------------------
//
// Uwierzytelnianie przepuszcza z repliki (fail-open), bo wpisy zostaly juz raz
// zweryfikowane. O wypadnieciu poda z ruchu rozstrzyga osobno /ready, patrzac
// na WIEK repliki. Gdyby to byla jedna decyzja, awaria bazy odcinalaby takze
// /v1/suggest, ktore bazy w ogole nie dotyka.
const withThreshold = await buildServer(loadConfig(environment({ KEYS_MAX_AGE_S: '1' })));
const liveKey = await issue(1);
await spij(NA_PROPAGACJE_MS);

const beforeFailure = await withThreshold.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': liveKey.plaintext } });
const readyBefore = await withThreshold.inject({ url: '/ready' });

// Zrywamy pule - z punktu widzenia procesu to jest awaria bazy.
await withThreshold.pool.end();
await spij(1500);

const poAwarii = await withThreshold.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': liveKey.plaintext } });
const readyPo = await withThreshold.inject({ url: '/ready' });

report(
  beforeFailure.statusCode === 200 && readyBefore.statusCode === 200 &&
  poAwarii.statusCode === 200 && readyPo.statusCode === 503,
  `awaria bazy: ruch ${beforeFailure.statusCode}->${poAwarii.statusCode} (fail-open), ` +
  `/ready ${readyBefore.statusCode}->${readyPo.statusCode} (kierowanie ruchu)`);
withThreshold.index.stop();

await db.end();
console.log(errors === 0 ? '\nWszystkie kontrole przeszly.' : `\n${errors} kontroli nie przeszlo.`);
process.exit(errors === 0 ? 0 : 1);
