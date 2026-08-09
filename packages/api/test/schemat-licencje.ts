/**
 * Schemat licencji - ksztalt, wiezy i kanal powiadomien (zadanie 8.2).
 *
 * WYMAGA BAZY z wgrana migracja 003_licencje.sql. Nie wymaga danych krajowych:
 *
 *   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f db/migrations/003_licencje.sql
 *   node --experimental-strip-types packages/api/test/schemat-licencje.ts
 *
 * Kazdy przebieg zaklada WLASNEGO klienta i WLASNE klucze o losowych skrotach,
 * bo w tym schemacie - tak jak w adresowym - nie kasujemy rekordow. Dzieki
 * temu drugi przebieg pod rzad nie lamie unikatu na skrocie.
 *
 * ODWROCENIA - kazde wykonane i sprawdzone:
 *   - dopisz do ux_klucz_hash `WHERE uniewazniony_od IS NULL`  -> kontrole 2 i 3
 *   - usun SET search_path z powiadom_o_kluczu                 -> kontrola 5
 *   - usun wyzwalacz tg_klient_powiadom                        -> kontrola 7
 *   - dodaj do licencje.zuzycie kolumne REFERENCES adres.*     -> kontrola 8
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://adres:adres@localhost:5432/adres';

let bledy = 0;
const zglos = (ok: boolean, opis: string) => {
  console.log(`${ok ? 'OK  ' : 'BLAD'} ${opis}`);
  if (!ok) bledy++;
};

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const znacznik = `test-8a-${Date.now()}-${randomBytes(3).toString('hex')}`;
const losowyHash = () => randomBytes(32);

// --- 1. Obiekty istnieja ------------------------------------------------
const { rows: [obiekty] } = await pool.query<{ k: string; ka: string; z: string }>(`
  SELECT to_regclass('licencje.klient')::text    AS k,
         to_regclass('licencje.klucz_api')::text AS ka,
         to_regclass('licencje.zuzycie')::text   AS z`);
const brakuje = Object.entries(obiekty).filter(([, v]) => v === null).map(([k]) => k);
zglos(brakuje.length === 0,
  `tabele licencje.klient, klucz_api, zuzycie istnieja${brakuje.length ? ' - brakuje: ' + brakuje.join(', ') : ''}`);
if (brakuje.length) {
  console.log('\n  Wgraj migracje: psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f db/migrations/003_licencje.sql');
  await pool.end();
  process.exit(1);
}

// --- 2. Unikat na skrocie jest PELNY, nie czesciowy --------------------
//
// Z warunkiem czesciowym ten sam skrot wszedlby drugi raz po uniewaznieniu
// pierwszego wiersza, a wtedy wyszukanie po skrocie zwracaloby wiecej niz
// jeden wiersz i klucz UNIEWAZNIONY moglby wygrac.
const { rows: [idx] } = await pool.query<{ indisunique: boolean; indpred: string | null }>(`
  SELECT i.indisunique, pg_get_expr(i.indpred, i.indrelid) AS indpred
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'ux_klucz_hash'`);
zglos(idx?.indisunique === true && idx?.indpred === null,
  `ux_klucz_hash: unikatowy=${idx?.indisunique}, warunek czesciowy=${idx?.indpred ?? 'brak'}`);

// --- klient i klucz na potrzeby dalszych kontroli -----------------------
const { rows: [klient] } = await pool.query<{ id: string }>(
  `INSERT INTO licencje.klient (nazwa, pakiet, limit_zapytan_min)
   VALUES ($1, 'test', 60) RETURNING id`, [znacznik]);

const hashWspolny = losowyHash();
const { rows: [klucz] } = await pool.query<{ id: string }>(
  `INSERT INTO licencje.klucz_api (klient_id, srodowisko, prefiks, hash, uniewazniony_od)
   VALUES ($1, 'live', 'adr_live_', $2, now()) RETURNING id`,
  [klient.id, hashWspolny]);

// --- 3. Unikat obowiazuje TAKZE dla klucza uniewaznionego --------------
let drugiWszedl = false;
try {
  await pool.query(
    `INSERT INTO licencje.klucz_api (klient_id, srodowisko, prefiks, hash)
     VALUES ($1, 'live', 'adr_live_', $2)`, [klient.id, hashWspolny]);
  drugiWszedl = true;
} catch { /* oczekiwane */ }
zglos(!drugiWszedl, 'drugi klucz o tym samym skrocie odrzucony mimo uniewaznienia pierwszego');

// --- 4. CHECK na srodowisku --------------------------------------------
let zleSrodowisko = false;
try {
  await pool.query(
    `INSERT INTO licencje.klucz_api (klient_id, srodowisko, prefiks, hash)
     VALUES ($1, 'Live', 'adr_live_', $2)`, [klient.id, losowyHash()]);
  zleSrodowisko = true;
} catch { /* oczekiwane */ }
zglos(!zleSrodowisko, "srodowisko 'Live' odrzucone przez CHECK (dopuszczalne: test, live)");

// --- 5. Funkcje maja przypiety search_path -----------------------------
//
// Bez tego funkcja bierze sciezke z sesji wolajacego: dziala z psql,
// a z puli aplikacji wycofuje transakcje. Przy uniewaznianiu klucza po
// wycieku oznacza to, ze operacja CICHO nie dziala.
const { rows: funkcje } = await pool.query<{ proname: string; proconfig: string[] | null }>(`
  SELECT p.proname, p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'licencje'`);
const bezSciezki = funkcje
  .filter((f) => !(f.proconfig ?? []).some((c) => c.startsWith('search_path=')))
  .map((f) => f.proname);
zglos(funkcje.length >= 3 && bezSciezki.length === 0,
  `${funkcje.length} funkcji w schemacie, wszystkie z przypietym search_path` +
  `${bezSciezki.length ? ' - bez: ' + bezSciezki.join(', ') : ''}`);

// --- 6/7. Kanal powiadomien: klucz ORAZ klient -------------------------
//
// Powiadomienie o zmianie KLIENTA jest osobnym wyzwalaczem i latwo je pominac.
// Bez niego zawieszenie klienta i obnizenie limitu nigdy nie docieraja do
// repliki w procesie - wiersz klucza pozostaje przeciez nietkniety.
const sluchacz = new pg.Client({ connectionString: DATABASE_URL });
await sluchacz.connect();
const odebrane: string[] = [];
sluchacz.on('notification', (n) => { if (n.payload) odebrane.push(n.payload); });
await sluchacz.query('LISTEN licencje_zmiana');

await pool.query(`UPDATE licencje.klucz_api SET powod_uniewaznienia = 'test' WHERE id = $1`, [klucz.id]);
await pool.query(`UPDATE licencje.klient SET zawieszony_od = now() WHERE id = $1`, [klient.id]);
await new Promise((r) => setTimeout(r, 500));

const oKluczu = odebrane.find((p) => p.startsWith('klucz:'));
const oKliencie = odebrane.find((p) => p.startsWith('klient:'));
const hexWspolny = hashWspolny.toString('hex');

zglos(oKluczu === `klucz:${hexWspolny}`,
  `powiadomienie o zmianie klucza dotarlo z hex skrotu (${oKluczu ? 'tak' : 'BRAK'})`);
zglos(oKliencie === `klient:${klient.id}`,
  `powiadomienie o zmianie klienta dotarlo (${oKliencie ?? 'BRAK'})`);

// --- 8. Zero kluczy obcych w strone schematu adres ---------------------
//
// scripts/e2e.sh robi TRUNCATE adres.* CASCADE przy kazdym przebiegu.
// Jeden klucz obcy w tamta strone zamienia zwykly test w kasowanie
// poswiadczen klientow.
const { rows: [obce] } = await pool.query<{ n: string }>(`
  SELECT count(*)::text AS n
    FROM pg_constraint c
    JOIN pg_class src ON src.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = src.relnamespace
    JOIN pg_class doc ON doc.oid = c.confrelid
    JOIN pg_namespace nd ON nd.oid = doc.relnamespace
   WHERE c.contype = 'f' AND ns.nspname = 'licencje' AND nd.nspname <> 'licencje'`);
zglos(obce.n === '0', `kluczy obcych z licencje.* poza schemat: ${obce.n}`);

// --- 9. Zrzut nie zawiera niczego odwracalnego -------------------------
//
// Straznik zasady 2 z naglowka migracji: gdyby ktos dolozyl kolumne
// z kluczem jawnym "na chwile, do debugowania", zrzut bazy stalby sie
// lista dzialajacych poswiadczen.
const { rows: kolumny } = await pool.query<{ column_name: string }>(`
  SELECT column_name FROM information_schema.columns
   WHERE table_schema = 'licencje' AND table_name = 'klucz_api'`);
const podejrzane = kolumny
  .map((k) => k.column_name)
  .filter((n) => /jawn|plain|secret|sekret|klucz_api_key|token/.test(n));
zglos(podejrzane.length === 0,
  `brak kolumn na klucz jawny${podejrzane.length ? ' - podejrzane: ' + podejrzane.join(', ') : ''}`);

await sluchacz.end();
await pool.end();
console.log(bledy === 0 ? '\nWszystkie kontrole przeszly.' : `\n${bledy} kontroli nie przeszlo.`);
process.exit(bledy === 0 ? 0 : 1);
