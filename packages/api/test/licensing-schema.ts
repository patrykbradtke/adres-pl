/**
 * Schemat licencji - ksztalt, wiezy i channel powiadomien (zadanie 8.2).
 *
 * WYMAGA BAZY z wgrana migracja 004_licencje.sql. Nie wymaga danych krajowych:
 *
 *   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f db/migrations/004_licencje.sql
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

let errors = 0;
const report = (ok: boolean, description: string) => {
  console.log(`${ok ? 'OK  ' : 'ERROR'} ${description}`);
  if (!ok) errors++;
};

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const stamp = `test-8a-${Date.now()}-${randomBytes(3).toString('hex')}`;
const randomHash = () => randomBytes(32);

// --- 1. Obiekty istnieja ------------------------------------------------
const { rows: [obiekty] } = await pool.query<{ k: string; ka: string; z: string }>(`
  SELECT to_regclass('licensing.client')::text    AS k,
         to_regclass('licensing.api_key')::text AS ka,
         to_regclass('licensing.usage')::text   AS z`);
const brakuje = Object.entries(obiekty).filter(([, v]) => v === null).map(([k]) => k);
report(brakuje.length === 0,
  `tabele licensing.client, api_key, usage istnieja${brakuje.length ? ' - brakuje: ' + brakuje.join(', ') : ''}`);
if (brakuje.length) {
  console.log('\n  Wgraj migracje: psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f db/migrations/004_licencje.sql oraz 005_english_naming.sql');
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
   WHERE c.relname = 'ux_api_key_hash'`);
report(idx?.indisunique === true && idx?.indpred === null,
  `ux_api_key_hash: unikatowy=${idx?.indisunique}, warunek czesciowy=${idx?.indpred ?? 'brak'}`);

// --- klient i klucz na potrzeby dalszych kontroli -----------------------
const { rows: [client] } = await pool.query<{ id: string }>(
  `INSERT INTO licensing.client (name, plan, rate_limit_per_min)
   VALUES ($1, 'test', 60) RETURNING id`, [stamp]);

const hashWspolny = randomHash();
const { rows: [key] } = await pool.query<{ id: string }>(
  `INSERT INTO licensing.api_key (client_id, environment, prefix, hash, revoked_at)
   VALUES ($1, 'live', 'adr_live_', $2, now()) RETURNING id`,
  [client.id, hashWspolny]);

// --- 3. Unikat obowiazuje TAKZE dla klucza uniewaznionego --------------
let secondInserted = false;
try {
  await pool.query(
    `INSERT INTO licensing.api_key (client_id, environment, prefix, hash)
     VALUES ($1, 'live', 'adr_live_', $2)`, [client.id, hashWspolny]);
  secondInserted = true;
} catch { /* oczekiwane */ }
report(!secondInserted, 'drugi klucz o tym samym skrocie odrzucony mimo uniewaznienia pierwszego');

// --- 4. CHECK na srodowisku --------------------------------------------
let wrongEnvironment = false;
try {
  await pool.query(
    `INSERT INTO licensing.api_key (client_id, environment, prefix, hash)
     VALUES ($1, 'Live', 'adr_live_', $2)`, [client.id, randomHash()]);
  wrongEnvironment = true;
} catch { /* oczekiwane */ }
report(!wrongEnvironment, "srodowisko 'Live' odrzucone przez CHECK (dopuszczalne: test, live)");

// --- 5. Funkcje maja przypiety search_path -----------------------------
//
// Bez tego funkcja bierze sciezke z sesji wolajacego: dziala z psql,
// a z puli aplikacji wycofuje transakcje. Przy uniewaznianiu klucza po
// wycieku oznacza to, ze operacja CICHO nie dziala.
const { rows: funkcje } = await pool.query<{ proname: string; proconfig: string[] | null }>(`
  SELECT p.proname, p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'licensing'`);
const withoutSearchPath = funkcje
  .filter((f) => !(f.proconfig ?? []).some((c) => c.startsWith('search_path=')))
  .map((f) => f.proname);
report(funkcje.length >= 3 && withoutSearchPath.length === 0,
  `${funkcje.length} funkcji w schemacie, wszystkie z przypietym search_path` +
  `${withoutSearchPath.length ? ' - without: ' + withoutSearchPath.join(', ') : ''}`);

// --- 6/7. Kanal powiadomien: klucz ORAZ klient -------------------------
//
// Powiadomienie o zmianie KLIENTA jest osobnym wyzwalaczem i latwo je pominac.
// Bez niego zawieszenie klienta i obnizenie limitu nigdy nie docieraja do
// repliki w procesie - wiersz klucza pozostaje przeciez nietkniety.
const listener = new pg.Client({ connectionString: DATABASE_URL });
await listener.connect();
const received: string[] = [];
listener.on('notification', (n) => { if (n.payload) received.push(n.payload); });
await listener.query('LISTEN licensing_change');

await pool.query(`UPDATE licensing.api_key SET revocation_reason = 'test' WHERE id = $1`, [key.id]);
await pool.query(`UPDATE licensing.client SET suspended_at = now() WHERE id = $1`, [client.id]);
await new Promise((r) => setTimeout(r, 500));

const keyNotice = received.find((p) => p.startsWith("key:"));
const clientNotice = received.find((p) => p.startsWith("client:"));
const hexWspolny = hashWspolny.toString('hex');

report(keyNotice === `key:${hexWspolny}`,
  `powiadomienie o zmianie klucza dotarlo z hex skrotu (${keyNotice ? 'tak' : 'BRAK'})`);
report(clientNotice === `client:${client.id}`,
  `powiadomienie o zmianie klienta dotarlo (${clientNotice ?? 'BRAK'})`);

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
   WHERE c.contype = 'f' AND ns.nspname = 'licensing' AND nd.nspname <> 'licensing'`);
report(obce.n === '0', `kluczy obcych z licencje.* poza schemat: ${obce.n}`);

// --- 9. Zrzut nie zawiera niczego odwracalnego -------------------------
//
// Straznik zasady 2 z naglowka migracji: gdyby ktos dolozyl kolumne
// z kluczem jawnym "na chwile, do debugowania", zrzut bazy stalby sie
// lista dzialajacych poswiadczen.
const { rows: columns } = await pool.query<{ column_name: string }>(`
  SELECT column_name FROM information_schema.columns
   WHERE table_schema = 'licensing' AND table_name = 'api_key'`);
const suspicious = columns
  .map((k) => k.column_name)
  .filter((n) => /jawn|plain|secret|sekret|klucz_api_key|token/.test(n));
report(suspicious.length === 0,
  `brak kolumn na klucz jawny${suspicious.length ? ' - suspicious: ' + suspicious.join(', ') : ''}`);

await listener.end();
await pool.end();
console.log(errors === 0 ? '\nWszystkie kontrole przeszly.' : `\n${errors} kontroli nie przeszlo.`);
process.exit(errors === 0 ? 0 : 1);
