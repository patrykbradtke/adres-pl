/**
 * Wystawianie i przegladanie kluczy API z wiersza polecen.
 *
 * PO CO, SKORO SA ENDPOINTY ADMINISTRACYJNE
 *
 * Skrotu klucza NIE DA SIE policzyc w psql: wymaga pieprza, ktory celowo nie
 * istnieje po stronie bazy (pgcrypto wstawiloby go do tekstu zapytania, czyli
 * do pg_stat_statements i do logu wolnych zapytan). Kazda procedura operacyjna
 * z runbooka poza wystawieniem klucza jest jednym UPDATE - to jest ta jedna,
 * ktora potrzebuje kodu.
 *
 * Przydaje sie takze na starcie: pierwszy klucz trzeba wystawic, zanim
 * ktokolwiek zdazy uzyc panelu.
 *
 *   node --experimental-strip-types packages/api/src/keys/cli.ts wystaw --klient 1
 *   node --experimental-strip-types packages/api/src/keys/cli.ts wystaw --klient 1 --zastepuje 7 --srodowisko test
 *   node --experimental-strip-types packages/api/src/keys/cli.ts lista --klient 1
 *
 * KLUCZ JAWNY JEST POKAZYWANY RAZ. Nie zapisujemy go nigdzie - w bazie ladzie
 * wylacznie skrot, a odtworzenie z niego klucza nie jest mozliwe.
 */
import pg from 'pg';
import { generateApiKey, type ApiKeyEnvironment } from '@adres-pl/core';
import { peppersFromEnv } from './pepper.ts';

function argument(nazwa: string): string | undefined {
  const i = process.argv.indexOf(`--${nazwa}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function zakoncz(komunikat: string): never {
  console.error(komunikat);
  process.exit(1);
}

const polecenie = process.argv[2];
const databaseUrl = process.env.DATABASE_URL
  ?? 'postgres://adres:adres@localhost:5432/adres';
const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();

if (polecenie === 'wystaw') {
  const klientId = Number(argument('klient'));
  if (!Number.isInteger(klientId)) zakoncz('Podaj --klient <ID>.');

  const srodowisko = (argument('srodowisko') ?? 'live') as ApiKeyEnvironment;
  if (srodowisko !== 'live' && srodowisko !== 'test') {
    zakoncz("--srodowisko przyjmuje 'live' albo 'test'.");
  }

  // Pieprz jest warunkiem, nie opcja: bez niego nie ma czym policzyc skrotu.
  const pieprze = peppersFromEnv();
  if (!pieprze) {
    zakoncz('Brak pieprza. Ustaw API_KEY_PEPPER_1 - patrz .env.example.');
  }

  const zastepuje = argument('zastepuje') ? Number(argument('zastepuje')) : null;
  const jawny = generateApiKey(srodowisko);
  const { version, hex } = pieprze.hash(jawny);
  const prefiks = srodowisko === 'live' ? 'adr_live_' : 'adr_test_';

  const { rows: [wiersz] } = await db.query<{ id: string }>(
    `INSERT INTO licencje.klucz_api
       (klient_id, srodowisko, prefiks, hash, pieprz_wersja, nazwa, zastepuje_id, utworzony_przez)
     VALUES ($1, $2, $3, decode($4, 'hex'), $5, $6, $7, $8) RETURNING id`,
    [klientId, srodowisko, prefiks, hex, version,
      argument('nazwa') ?? null, zastepuje, process.env.USER ?? 'cli']);

  console.log(`\nKlucz wystawiony. Identyfikator: ${wiersz.id}, pieprz w wersji ${version}.`);
  console.log('\n  ' + jawny + '\n');
  console.log('Ta wartosc NIE ZOSTANIE pokazana ponownie - w bazie lezy wylacznie skrot.');
  if (zastepuje !== null) {
    console.log(`\nRotacja: ustaw poprzednikowi koniec waznosci, zeby oba klucze dzialaly\n` +
      `przez okres przejsciowy (patrz docs/runbook-klucze.md):\n` +
      `  psql "$DATABASE_URL" -c "UPDATE licencje.klucz_api ` +
      `SET wazny_do = now() + interval '7 days' WHERE id = ${zastepuje};"`);
  }
} else if (polecenie === 'lista') {
  const klientId = argument('klient') ? Number(argument('klient')) : null;
  const { rows } = await db.query(
    `SELECT k.id, c.nazwa AS klient, k.srodowisko, k.prefiks, k.pieprz_wersja,
            k.wazny_od, k.wazny_do, k.uniewazniony_od, c.zawieszony_od
       FROM licencje.klucz_api k
       JOIN licencje.klient c ON c.id = k.klient_id
      WHERE ($1::bigint IS NULL OR k.klient_id = $1)
      ORDER BY k.id`, [klientId]);
  // Skrotu ani klucza jawnego nie wypisujemy NIGDY - takze tutaj.
  console.table(rows);
} else {
  zakoncz('Uzycie: cli.ts wystaw --klient <ID> [--srodowisko live|test] ' +
    '[--zastepuje <ID>] [--nazwa <tekst>]\n       cli.ts lista [--klient <ID>]');
}

await db.end();
