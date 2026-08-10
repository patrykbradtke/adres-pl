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
 *   node --experimental-strip-types packages/api/src/keys/cli.ts wystaw --client 1
 *   node --experimental-strip-types packages/api/src/keys/cli.ts wystaw --client 1 --replaces 7 --environment test
 *   node --experimental-strip-types packages/api/src/keys/cli.ts lista --client 1
 *
 * KLUCZ JAWNY JEST POKAZYWANY RAZ. Nie zapisujemy go nigdzie - w bazie ladzie
 * wylacznie skrot, a odtworzenie z niego klucza nie jest mozliwe.
 */
import pg from 'pg';
import { generateApiKey, type ApiKeyEnvironment } from '@adres-pl/core';
import { peppersFromEnv } from './pepper.ts';

function argument(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function exitWith(message: string): never {
  console.error(message);
  process.exit(1);
}

const command = process.argv[2];
const databaseUrl = process.env.DATABASE_URL
  ?? 'postgres://adres:adres@localhost:5432/adres';
const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();

if (command === 'wystaw') {
  const clientId = Number(argument('client'));
  if (!Number.isInteger(clientId)) exitWith('Podaj --client <ID>.');

  const environment = (argument('environment') ?? 'live') as ApiKeyEnvironment;
  if (environment !== 'live' && environment !== 'test') {
    exitWith("--environment przyjmuje 'live' albo 'test'.");
  }

  // Pieprz jest warunkiem, nie opcja: bez niego nie ma czym policzyc skrotu.
  const peppers = peppersFromEnv();
  if (!peppers) {
    exitWith('Brak pieprza. Ustaw API_KEY_PEPPER_1 - patrz .env.example.');
  }

  const replaces = argument('replaces') ? Number(argument('replaces')) : null;
  const plaintext = generateApiKey(environment);
  const { version, hex } = peppers.hash(plaintext);
  const prefix = environment === 'live' ? 'adr_live_' : 'adr_test_';

  const { rows: [row] } = await db.query<{ id: string }>(
    `INSERT INTO licensing.api_key
       (client_id, environment, prefix, hash, pepper_version, name, replaces_id, created_by)
     VALUES ($1, $2, $3, decode($4, 'hex'), $5, $6, $7, $8) RETURNING id`,
    [clientId, environment, prefix, hex, version,
      argument('name') ?? null, replaces, process.env.USER ?? 'cli']);

  console.log(`\nKlucz wystawiony. Identyfikator: ${row.id}, pieprz w wersji ${version}.`);
  console.log('\n  ' + plaintext + '\n');
  console.log('Ta wartosc NIE ZOSTANIE pokazana ponownie - w bazie lezy wylacznie skrot.');
  if (replaces !== null) {
    console.log(`\nRotacja: ustaw poprzednikowi koniec waznosci, zeby oba klucze dzialaly\n` +
      `przez okres przejsciowy (patrz docs/runbook-klucze.md):\n` +
      `  psql "$DATABASE_URL" -c "UPDATE licensing.api_key ` +
      `SET valid_to = now() + interval '7 days' WHERE id = ${replaces};"`);
  }
} else if (command === 'lista') {
  const clientId = argument('client') ? Number(argument('client')) : null;
  const { rows } = await db.query(
    `SELECT k.id, c.name AS client, k.environment, k.prefix, k.pepper_version,
            k.valid_from, k.valid_to, k.revoked_at, c.suspended_at
       FROM licensing.api_key k
       JOIN licensing.client c ON c.id = k.client_id
      WHERE ($1::bigint IS NULL OR k.client_id = $1)
      ORDER BY k.id`, [clientId]);
  // Skrotu ani klucza jawnego nie wypisujemy NIGDY - takze tutaj.
  console.table(rows);
} else {
  exitWith('Uzycie: cli.ts wystaw --client <ID> [--environment live|test] ' +
    '[--replaces <ID>] [--name <tekst>]\n       cli.ts lista [--client <ID>]');
}

await db.end();
