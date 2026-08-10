/**
 * Replika rejestru kluczy - zbieznosc obiema drogami (zadanie 8.4a).
 *
 * WYMAGA BAZY z migracja 004_licencje.sql. Nie wymaga danych krajowych ani artefaktu.
 *
 * Sedno tego zestawu: udowodnic, ze DWA zrodla odswiezania sa potrzebne i ze
 * kazde dziala osobno. NOTIFY jest przyspieszaczem, odpytywanie gwarancja -
 * dlatego kontrole 1-3 mierza droge powiadomien w waskim oknie, a kontrola 4
 * mierzy droge odpytywania PO ZERWANIU nasluchu.
 *
 * ODWROCENIA - kazde wykonane i sprawdzone:
 *   - DROP TRIGGER tg_klucz_powiadom       -> kontrole 1-2 czerwone, 4 zielona
 *   - znacznik liczony tylko z klucz_api   -> kontrola 3 czerwona
 *   - wylaczona kontrola rozsadku          -> kontrola 6 czerwona
 *
 * Dwie wady tego zestawu wyszly dopiero przy wykonywaniu odwrocen i obie
 * sprawialy, ze kontrola swiecila na zielono, nie badajac niczego:
 *   - okno 900 ms dla drogi NOTIFY miescilo w sobie cykl odpytywania (750 ms
 *     przy jitterze), wiec usuniecie wyzwalacza nie czerwienilo kontroli;
 *   - kontrola zmiany klienta stala PO zerwaniu nasluchu, a ponowne
 *     podlaczenie wymusza pelne przeladowanie repliki, ktore zaciagalo te
 *     zmiane niezaleznie od tego, co liczy znacznik.
 *
 *   node --experimental-strip-types packages/api/test/replika-kluczy.ts
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { KeyRegistry } from '../src/keys/registry.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://adres:adres@localhost:5432/adres';
const REFRESH_MS = 1_000;

/**
 * Okno dla drogi POWIADOMIEN musi byc wyraznie krotsze niz najkrotszy mozliwy
 * cykl odpytywania, inaczej kontrola nie izoluje badanej drogi.
 *
 * Odswiezanie ma jitter +/-25%, wiec przy 1000 ms najwczesniejsze odpytanie
 * wypada po 750 ms. Okno 900 ms - takie bylo tu najpierw - przepuszczalo wynik
 * uzyskany ODPYTYWANIEM: po usunieciu wyzwalacza NOTIFY kontrola nadal
 * swiecila na zielono (895 ms). Zmierzona zbieznosc kanalem NOTIFY to 25-100 ms,
 * wiec 300 ms zostawia zapas i nie da sie go pomylic z odpytywaniem.
 */
const NOTIFICATION_WINDOW_MS = 300;

let errors = 0;
const report = (ok: boolean, description: string) => {
  console.log(`${ok ? 'OK  ' : 'ERROR'} ${description}`);
  if (!ok) errors++;
};
const spij = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Czeka, az warunek bedzie spelniony; zwraca czas oczekiwania albo -1. */
async function waitFor(warunek: () => boolean, limitMs: number): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < limitMs) {
    if (warunek()) return Date.now() - t0;
    await spij(25);
  }
  return -1;
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
// Osobne polaczenie udajace operatora przy psql - zmiany MUSZA isc spoza puli
// serwisu, inaczej test sprawdzalby tylko sam siebie.
const operator = new pg.Client({ connectionString: DATABASE_URL });
await operator.connect();

const stamp = `replika-8a-${Date.now()}`;
const { rows: [client] } = await operator.query<{ id: string }>(
  `INSERT INTO licensing.client (name, plan, rate_limit_per_min, monthly_quota)
   VALUES ($1, 'test', 120, 1000) RETURNING id`, [stamp]);

const registry = new KeyRegistry({
  pool,
  connectionString: DATABASE_URL,
  refreshMs: REFRESH_MS,
  onError: (e, where) => console.log(`   [rejestr] ${where}: ${e.message}`),
});
await registry.start();
const atStart = registry.size;
report(registry.loaded, `replika zaladowana przy starcie (wpisow: ${atStart})`);

// --- 1. Nowy klucz dociera droga powiadomien ---------------------------
const hashA = randomBytes(32);
const hexA = hashA.toString('hex');
await operator.query(
  `INSERT INTO licensing.api_key (client_id, environment, prefix, hash)
   VALUES ($1, 'live', 'adr_live_', $2)`, [client.id, hashA]);
const insertTime = await waitFor(() => registry.find(hexA) !== undefined, NOTIFICATION_WINDOW_MS);
report(insertTime >= 0,
  `nowy klucz widoczny po ${insertTime} ms - droga NOTIFY (okno ${NOTIFICATION_WINDOW_MS} ms)`);

// --- 2. Uniewaznienie dociera droga powiadomien ------------------------
await operator.query(
  `UPDATE licensing.api_key SET revoked_at = now() WHERE hash = $1`, [hashA]);
const revocationTime = await waitFor(
  () => registry.find(hexA)?.revokedAt != null, NOTIFICATION_WINDOW_MS);
report(revocationTime >= 0,
  `uniewaznienie widoczne po ${revocationTime} ms`);

// --- 3. Zmiana KLIENTA tez dociera -------------------------------------
//
// Znacznik zmian liczony wylacznie z klucz_api by tego nie zlapal: zawieszenie
// klienta nie dotyka ani jednego wiersza klucza.
//
// KOLEJNOSC MA ZNACZENIE. Ta kontrola stala najpierw PO zerwaniu nasluchu
// i wtedy nie izolowala niczego: ponowne podlaczenie wymusza pelne
// przeladowanie repliki (powiadomienia z czasu przerwy przepadly), wiec zmiana
// klienta zaciagala sie przy okazji, niezaleznie od tego, co liczy znacznik.
// Odwrocenie "znacznik tylko z klucz_api" swiecilo wtedy na zielono.
// Przy zywym nasluchu NOTIFY wola refresh(), a o przeladowaniu decyduje juz
// wylacznie znacznik - i to jest badana logika.
await operator.query(`UPDATE licensing.client SET suspended_at = now() WHERE id = $1`, [client.id]);
const suspensionTime = await waitFor(
  () => registry.find(hexA)?.suspendedAt != null, NOTIFICATION_WINDOW_MS);
report(suspensionTime >= 0,
  `zawieszenie klienta widoczne po ${suspensionTime} ms mimo braku zmian w tabeli kluczy`);

// --- 4. Po ZERWANIU nasluchu ratuje odpytywanie ------------------------
//
// Symulacja restartu bazy albo przelaczenia na replike. Bez tej drogi
// uniewazniony klucz dzialalby dalej, a nikt by tego nie zauwazyl - NOTIFY
// ginie CICHO.
const notificationsBefore = registry.notificationCount;
await operator.query(`
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity
   WHERE query LIKE 'LISTEN%' AND pid <> pg_backend_pid()`);
await spij(200);

const hashB = randomBytes(32);
const hexB = hashB.toString('hex');
await operator.query(
  `INSERT INTO licensing.api_key (client_id, environment, prefix, hash)
   VALUES ($1, 'live', 'adr_live_', $2)`, [client.id, hashB]);
const timeAfterDrop = await waitFor(() => registry.find(hexB) !== undefined, REFRESH_MS * 4);
report(timeAfterDrop >= 0,
  `po zerwaniu nasluchu zmiana dotarla po ${timeAfterDrop} ms droga odpytywania ` +
  `(powiadomien w tym czasie: ${registry.notificationCount - notificationsBefore})`);

// --- 5. Odswiezenie bez zmian nie przeladowuje repliki -----------------
const refreshesBefore = registry.refreshCount;
for (let i = 0; i < 5; i++) await registry.refresh();
report(registry.refreshCount === refreshesBefore,
  `piec odswiezen bez zmian nie przeladowalo repliki (przeladowan: ` +
  `${registry.refreshCount - refreshesBefore})`);

// --- 6. Kontrola rozsadku odrzuca nagly ubytek -------------------------
//
// Zle skierowane polaczenie albo niedokonczona migracja nie moga odciac
// wszystkich klientow naraz.
const maly = new KeyRegistry({
  pool, connectionString: DATABASE_URL, refreshMs: 0, maxSpadekProc: 50,
  onError: () => { /* oczekiwane */ },
});
await maly.start();
const beforeDrop = maly.size;
// Udajemy zapytanie zwracajace prawie nic: podmieniamy pule na taka, ktora
// filtruje wiekszosc wierszy.
// Atrapa celuje w JEDNO konkretne zapytanie - to, ktore pobiera wpisy kluczy
// (rozpoznawane po aliasie "AS klucz_id"). Wczesniej bylo odwrotnie: doklejala
// filtr do wszystkiego, co nie bylo zapytaniem o znacznik. Gdy refresh
// zaczelo pobierac takze zuzycie, filtr trafil w zapytanie majace juz wlasne
// WHERE i GROUP BY - i test padal na skladni SQL zamiast na badanej wlasnosci.
const okrojona = {
  query: (tekst: string, param?: unknown[]) =>
    tekst.includes('AS klucz_id')
      ? pool.query(`${tekst} WHERE k.id = -1`, param as never)
      : pool.query(tekst, param as never),
} as unknown as pg.Pool;
(maly as unknown as { cfg: { pool: pg.Pool } }).cfg.pool = okrojona;
await maly.refresh(true);
report(maly.size === beforeDrop,
  `przeladowanie usuwajace wszystkie wpisy odrzucone, replika ma nadal ${maly.size}`);
maly.stop();

// --- 7. Brak schematu konczy sie czytelnym bledem ----------------------
let message = '';
try {
  await KeyRegistry.checkSchema({
    query: async () => ({ rows: [{ exists: null }] }),
  } as unknown as pg.Pool);
} catch (e) { message = (e as Error).message; }
report(message.includes('004_licencje.sql') && message.includes('psql'),
  'brak schematu daje komunikat wskazujacy plik migracji i polecenie');

registry.stop();
await operator.end();
await pool.end();
console.log(errors === 0 ? '\nWszystkie kontrole przeszly.' : `\n${errors} kontroli nie przeszlo.`);
process.exit(errors === 0 ? 0 : 1);
