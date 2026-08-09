/**
 * Replika rejestru kluczy - zbieznosc obiema drogami (zadanie 8.4a).
 *
 * WYMAGA BAZY z migracja 003. Nie wymaga danych krajowych ani artefaktu.
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
const ODSWIEZANIE_MS = 1_000;

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
const OKNO_POWIADOMIENIA_MS = 300;

let bledy = 0;
const zglos = (ok: boolean, opis: string) => {
  console.log(`${ok ? 'OK  ' : 'BLAD'} ${opis}`);
  if (!ok) bledy++;
};
const spij = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Czeka, az warunek bedzie spelniony; zwraca czas oczekiwania albo -1. */
async function czekaj(warunek: () => boolean, limitMs: number): Promise<number> {
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

const znacznik = `replika-8a-${Date.now()}`;
const { rows: [klient] } = await operator.query<{ id: string }>(
  `INSERT INTO licencje.klient (nazwa, pakiet, limit_zapytan_min, kwota_miesieczna)
   VALUES ($1, 'test', 120, 1000) RETURNING id`, [znacznik]);

const rejestr = new KeyRegistry({
  pool,
  connectionString: DATABASE_URL,
  odswiezanieMs: ODSWIEZANIE_MS,
  onError: (e, gdzie) => console.log(`   [rejestr] ${gdzie}: ${e.message}`),
});
await rejestr.start();
const naStarcie = rejestr.rozmiar;
zglos(rejestr.zaladowana, `replika zaladowana przy starcie (wpisow: ${naStarcie})`);

// --- 1. Nowy klucz dociera droga powiadomien ---------------------------
const hashA = randomBytes(32);
const hexA = hashA.toString('hex');
await operator.query(
  `INSERT INTO licencje.klucz_api (klient_id, srodowisko, prefiks, hash)
   VALUES ($1, 'live', 'adr_live_', $2)`, [klient.id, hashA]);
const czasWstawienia = await czekaj(() => rejestr.znajdz(hexA) !== undefined, OKNO_POWIADOMIENIA_MS);
zglos(czasWstawienia >= 0,
  `nowy klucz widoczny po ${czasWstawienia} ms - droga NOTIFY (okno ${OKNO_POWIADOMIENIA_MS} ms)`);

// --- 2. Uniewaznienie dociera droga powiadomien ------------------------
await operator.query(
  `UPDATE licencje.klucz_api SET uniewazniony_od = now() WHERE hash = $1`, [hashA]);
const czasUniewaznienia = await czekaj(
  () => rejestr.znajdz(hexA)?.uniewaznionyOd != null, OKNO_POWIADOMIENIA_MS);
zglos(czasUniewaznienia >= 0,
  `uniewaznienie widoczne po ${czasUniewaznienia} ms`);

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
// Przy zywym nasluchu NOTIFY wola odswiez(), a o przeladowaniu decyduje juz
// wylacznie znacznik - i to jest badana logika.
await operator.query(`UPDATE licencje.klient SET zawieszony_od = now() WHERE id = $1`, [klient.id]);
const czasZawieszenia = await czekaj(
  () => rejestr.znajdz(hexA)?.zawieszonyOd != null, OKNO_POWIADOMIENIA_MS);
zglos(czasZawieszenia >= 0,
  `zawieszenie klienta widoczne po ${czasZawieszenia} ms mimo braku zmian w tabeli kluczy`);

// --- 4. Po ZERWANIU nasluchu ratuje odpytywanie ------------------------
//
// Symulacja restartu bazy albo przelaczenia na replike. Bez tej drogi
// uniewazniony klucz dzialalby dalej, a nikt by tego nie zauwazyl - NOTIFY
// ginie CICHO.
const powiadomieniaPrzed = rejestr.liczbaPowiadomien;
await operator.query(`
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity
   WHERE query LIKE 'LISTEN%' AND pid <> pg_backend_pid()`);
await spij(200);

const hashB = randomBytes(32);
const hexB = hashB.toString('hex');
await operator.query(
  `INSERT INTO licencje.klucz_api (klient_id, srodowisko, prefiks, hash)
   VALUES ($1, 'live', 'adr_live_', $2)`, [klient.id, hashB]);
const czasPoZerwaniu = await czekaj(() => rejestr.znajdz(hexB) !== undefined, ODSWIEZANIE_MS * 4);
zglos(czasPoZerwaniu >= 0,
  `po zerwaniu nasluchu zmiana dotarla po ${czasPoZerwaniu} ms droga odpytywania ` +
  `(powiadomien w tym czasie: ${rejestr.liczbaPowiadomien - powiadomieniaPrzed})`);

// --- 5. Odswiezenie bez zmian nie przeladowuje repliki -----------------
const odswiezenPrzed = rejestr.liczbaOdswiezen;
for (let i = 0; i < 5; i++) await rejestr.odswiez();
zglos(rejestr.liczbaOdswiezen === odswiezenPrzed,
  `piec odswiezen bez zmian nie przeladowalo repliki (przeladowan: ` +
  `${rejestr.liczbaOdswiezen - odswiezenPrzed})`);

// --- 6. Kontrola rozsadku odrzuca nagly ubytek -------------------------
//
// Zle skierowane polaczenie albo niedokonczona migracja nie moga odciac
// wszystkich klientow naraz.
const maly = new KeyRegistry({
  pool, connectionString: DATABASE_URL, odswiezanieMs: 0, maxSpadekProc: 50,
  onError: () => { /* oczekiwane */ },
});
await maly.start();
const przedUbytkiem = maly.rozmiar;
// Udajemy zapytanie zwracajace prawie nic: podmieniamy pule na taka, ktora
// filtruje wiekszosc wierszy.
const okrojona = {
  query: (tekst: string, param?: unknown[]) =>
    tekst.includes('AS znacznik')
      ? pool.query(tekst, param as never)
      : pool.query(`${tekst} WHERE k.id = -1`, param as never),
} as unknown as pg.Pool;
(maly as unknown as { cfg: { pool: pg.Pool } }).cfg.pool = okrojona;
await maly.odswiez(true);
zglos(maly.rozmiar === przedUbytkiem,
  `przeladowanie usuwajace wszystkie wpisy odrzucone, replika ma nadal ${maly.rozmiar}`);
maly.stop();

// --- 7. Brak schematu konczy sie czytelnym bledem ----------------------
let komunikat = '';
try {
  await KeyRegistry.sprawdzSchemat({
    query: async () => ({ rows: [{ jest: null }] }),
  } as unknown as pg.Pool);
} catch (e) { komunikat = (e as Error).message; }
zglos(komunikat.includes('003_licencje.sql') && komunikat.includes('psql'),
  'brak schematu daje komunikat wskazujacy plik migracji i polecenie');

rejestr.stop();
await operator.end();
await pool.end();
console.log(bledy === 0 ? '\nWszystkie kontrole przeszly.' : `\n${bledy} kontroli nie przeszlo.`);
process.exit(bledy === 0 ? 0 : 1);
