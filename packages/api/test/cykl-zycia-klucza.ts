/**
 * Cykl zycia klucza i pieprza (zadanie 8.6).
 *
 * WYMAGA BAZY z migracja 003. Artefakt buduje sobie sam.
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
import { zapiszAtrapeIndeksu } from './atrapa-indeksu.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://adres:adres@localhost:5432/adres';
const PIEPRZ_1 = 'pieprz-stary-8.6';
const PIEPRZ_2 = 'pieprz-nowy-8.6';
const ODSWIEZANIE_MS = 400;
/** Okno na dotarcie zmiany kanalem NOTIFY - z zapasem wobec zmierzonych 25 ms. */
const NA_PROPAGACJE_MS = 900;

let bledy = 0;
const zglos = (ok: boolean, opis: string) => {
  console.log(`${ok ? 'OK  ' : 'BLAD'} ${opis}`);
  if (!ok) bledy++;
};
const spij = (ms: number) => new Promise((r) => setTimeout(r, ms));

const artefakt = await zapiszAtrapeIndeksu(
  join(await mkdtemp(join(tmpdir(), 'adres-cykl-')), 'current.bin'));

const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
const stempel = `cykl-8a-${Date.now()}`;

const { rows: [klient] } = await db.query<{ id: string }>(
  `INSERT INTO licencje.klient (nazwa, pakiet, limit_zapytan_min)
   VALUES ($1, 'test', 600) RETURNING id`, [stempel]);
const klientId = Number(klient.id);

/** Wystawia klucz skrotem liczonym WSKAZANA wersja pieprza. */
async function wystaw(
  wersjaPieprza: 1 | 2,
  opcje: { zastepuje?: number } = {},
): Promise<{ jawny: string; id: number }> {
  const jawny = generateApiKey('live');
  const pieprz = wersjaPieprza === 1 ? PIEPRZ_1 : PIEPRZ_2;
  const zestaw = new Peppers(new Map([[wersjaPieprza, pieprz]]), wersjaPieprza);
  const hash = Buffer.from(zestaw.hash(jawny).hex, 'hex');
  const { rows: [r] } = await db.query<{ id: string }>(
    `INSERT INTO licencje.klucz_api
       (klient_id, srodowisko, prefiks, hash, pieprz_wersja, zastepuje_id)
     VALUES ($1, 'live', 'adr_live_', $2, $3, $4) RETURNING id`,
    [klientId, hash, wersjaPieprza, opcje.zastepuje ?? null]);
  return { jawny, id: Number(r.id) };
}

const kluczA = await wystaw(1);

function srodowisko(nadpisz: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LOG_LEVEL: 'error',
    DATABASE_URL,
    INDEX_SOURCE: artefakt,
    INDEX_POLL_MS: '0',
    API_KEY_MODE: 'wymagany',
    API_KEY_PEPPER_1: PIEPRZ_1,
    API_KEY_PEPPER_AKTYWNY: '1',
    KLUCZE_ODSWIEZANIE_MS: String(ODSWIEZANIE_MS),
    ...nadpisz,
  };
}

const app = await buildServer(loadConfig(srodowisko()));
const strzel = (klucz: string) =>
  app.inject({ url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': klucz } });

// --- 1. Rotacja bezprzerwowa ------------------------------------------
//
// Definicja bezprzerwowosci: przez okres przejsciowy dzialaja OBA klucze.
// Gdyby wystawienie nastepcy uniewazniało poprzednika natychmiast, kazda
// rotacja bylaby krotka awaria u klienta, ktory nie zdazyl podmienic klucza.
const kluczB = await wystaw(1, { zastepuje: kluczA.id });
await db.query(
  `UPDATE licencje.klucz_api SET wazny_do = now() + interval '1 hour' WHERE id = $1`,
  [kluczA.id]);
await spij(NA_PROPAGACJE_MS);

const a1 = await strzel(kluczA.jawny);
const b1 = await strzel(kluczB.jawny);
zglos(a1.statusCode === 200 && b1.statusCode === 200,
  `okres przejsciowy: poprzednik ${a1.statusCode}, nastepca ${b1.statusCode} (oba maja dzialac)`);

// --- 2. Koniec okresu przejsciowego -----------------------------------
await db.query(
  `UPDATE licencje.klucz_api SET wazny_do = now() - interval '1 second' WHERE id = $1`,
  [kluczA.id]);
await spij(NA_PROPAGACJE_MS);
const a2 = await strzel(kluczA.jawny);
const b2 = await strzel(kluczB.jawny);
zglos(a2.statusCode === 403 && a2.json().code === 'WYGASLY' && b2.statusCode === 200,
  `po okresie przejsciowym: poprzednik ${a2.statusCode} ${a2.json().code}, nastepca ${b2.statusCode}`);

// --- 3. Uniewaznienie natychmiastowe jednym UPDATE --------------------
//
// Sedno: NOTIFY siedzi w wyzwalaczu, nie w kodzie aplikacji, wiec reakcja
// na wyciek nie wymaga panelu ani wdrozenia - wystarczy psql.
await db.query(
  `UPDATE licencje.klucz_api SET uniewazniony_od = now(), powod_uniewaznienia = 'test'
    WHERE id = $1`, [kluczB.id]);
await spij(NA_PROPAGACJE_MS);
const b3 = await strzel(kluczB.jawny);
zglos(b3.statusCode === 403 && b3.json().code === 'UNIEWAZNIONY',
  `uniewaznienie jednym UPDATE => ${b3.statusCode} ${b3.json().code}`);
await app.close();

// --- 4. Rotacja pieprza -----------------------------------------------
//
// Kluczowa wlasnosc: NIE DA SIE przeliczyc skrotu na nowy pieprz, bo wymagaloby
// to klucza JAWNEGO, ktorego z zalozenia nie mamy. Rotacja pieprza to zawsze
// wymiana kluczy, a wieloelementowy zestaw pozwala ja przeprowadzic bez przerwy.
const kluczStary = await wystaw(1);
const kluczNowy = await wystaw(2);

const dwaPieprze = await buildServer(loadConfig(srodowisko({
  API_KEY_PEPPER_2: PIEPRZ_2,
  API_KEY_PEPPER_AKTYWNY: '2',
})));
const stary = await dwaPieprze.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': kluczStary.jawny } });
const nowy = await dwaPieprze.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': kluczNowy.jawny } });
zglos(stary.statusCode === 200 && nowy.statusCode === 200,
  `zestaw {1,2}: klucz na starym pieprzu ${stary.statusCode}, na nowym ${nowy.statusCode}`);
await dwaPieprze.close();

// Bezpiecznik ostatniej szansy: usuniecie pieprza z konfiguracji uniewaznia
// NATYCHMIAST wszystkie klucze na nim policzone, we wszystkich instancjach,
// bez dotykania bazy. To FUNKCJA na wypadek wycieku pieprza, nie awaria.
const tylkoNowy = await buildServer(loadConfig({
  ...srodowisko({ API_KEY_PEPPER_2: PIEPRZ_2, API_KEY_PEPPER_AKTYWNY: '2' }),
  API_KEY_PEPPER_1: '',
}));
const poUsunieciu = await tylkoNowy.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': kluczStary.jawny } });
const nadalNowy = await tylkoNowy.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': kluczNowy.jawny } });
zglos(poUsunieciu.statusCode === 401 && nadalNowy.statusCode === 200,
  `po usunieciu pieprza 1: klucz na nim ${poUsunieciu.statusCode}, klucz na pieprzu 2 ${nadalNowy.statusCode}`);
await tylkoNowy.close();

// --- 5. Awaria bazy: DWIE niezalezne decyzje --------------------------
//
// Uwierzytelnianie przepuszcza z repliki (fail-open), bo wpisy zostaly juz raz
// zweryfikowane. O wypadnieciu poda z ruchu rozstrzyga osobno /ready, patrzac
// na WIEK repliki. Gdyby to byla jedna decyzja, awaria bazy odcinalaby takze
// /v1/suggest, ktore bazy w ogole nie dotyka.
const zProgiem = await buildServer(loadConfig(srodowisko({ KLUCZE_MAX_WIEK_S: '1' })));
const kluczZywy = await wystaw(1);
await spij(NA_PROPAGACJE_MS);

const przedAwaria = await zProgiem.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': kluczZywy.jawny } });
const readyPrzed = await zProgiem.inject({ url: '/ready' });

// Zrywamy pule - z punktu widzenia procesu to jest awaria bazy.
await zProgiem.pool.end();
await spij(1500);

const poAwarii = await zProgiem.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': kluczZywy.jawny } });
const readyPo = await zProgiem.inject({ url: '/ready' });

zglos(
  przedAwaria.statusCode === 200 && readyPrzed.statusCode === 200 &&
  poAwarii.statusCode === 200 && readyPo.statusCode === 503,
  `awaria bazy: ruch ${przedAwaria.statusCode}->${poAwarii.statusCode} (fail-open), ` +
  `/ready ${readyPrzed.statusCode}->${readyPo.statusCode} (kierowanie ruchu)`);
zProgiem.index.stop();

await db.end();
console.log(bledy === 0 ? '\nWszystkie kontrole przeszly.' : `\n${bledy} kontroli nie przeszlo.`);
process.exit(bledy === 0 ? 0 : 1);
