/**
 * Biegacz migracji z rejestrem zastosowanych.
 *
 * PO CO
 *
 * Do 10.08.2026 migracje wgrywalo sie recznie przez psql albo przez
 * docker-entrypoint-initdb.d. Skutkiem byly trzy rzeczy naraz:
 *
 *  - `003_scalenie_ulic.sql` miala BEGIN bez COMMIT. psql wycofuje otwarta
 *    transakcje przy EOF i **zwraca kod 0**, wiec migracja "przechodzila",
 *    nie zmieniajac niczego. Nikt tego nie zauwazyl, bo nic tego nie liczylo;
 *  - swiezy `docker compose up -d db` nie wstawal, bo 003 wymaga indeksu,
 *    ktorego 001 i 002 nie zakladaja - a initdb nie ma jak tego obejsc;
 *  - nie bylo odpowiedzi na pytanie "ktore migracje ma ta baza".
 *
 * DLACZEGO WLASNY, A NIE node-pg-migrate
 *
 * Plan produkcyjny wskazywal node-pg-migrate. Nie pokrywa trzech rzeczy,
 * ktore sa tu potrzebne, wiec i tak trzeba by dopisac kod wokol niego:
 *
 *  - OZNACZENIE WSTECZNE (`baseline`): migracje 001-005 sa juz wgrane na
 *    dzialajacej bazie i nie wolno ich uruchomic drugi raz;
 *  - SUMY KONTROLNE: bez nich zmiana pliku, ktory juz przeszedl, jest
 *    niewidoczna. To nie jest hipotetyczne - do 003 dopisano COMMIT po tym,
 *    jak wgrano ja na produkcje;
 *  - pliki zostaja SUROWYM SQL-em. node-pg-migrate oczekuje znacznikow
 *    `-- Up Migration`, czyli przepisania historii, ktora juz przeszla.
 *
 * Cena: ~150 linii wlasnego kodu zamiast zaleznosci. Warta jej, bo caly ten
 * plik robi mniej niz jeden ekran logiki, a dopasowanie jest dokladne.
 *
 *   npm run migrate            -- wgraj brakujace
 *   npm run migrate status     -- co jest wgrane, co czeka
 *   npm run migrate baseline   -- oznacz wszystkie jako wgrane, NIE uruchamiajac
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, 'migrations');

/**
 * Blokada doradcza na czas calego przebiegu.
 *
 * Dwa procesy wgrywajace migracje jednoczesnie (wdrozenie i CI, albo dwa pody
 * wstajace naraz) to nie jest scenariusz teoretyczny. Bez blokady oba widza
 * ten sam zbior brakujacych i oba probuja go wgrac.
 */
const LOCK_ID = 8_150_724;

interface Applied {
  name: string;
  checksum: string;
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

async function ensureRegistry(c: pg.PoolClient): Promise<void> {
  await c.query(`
    CREATE SCHEMA IF NOT EXISTS migration;
    CREATE TABLE IF NOT EXISTS migration.applied (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      applied_by  text,
      duration_ms integer
    )`);
}

async function readMigrations(): Promise<{ name: string; sql: string }[]> {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(files.map(async (name) => ({
    name,
    sql: await readFile(join(MIGRATIONS, name), 'utf8'),
  })));
}

/**
 * Rozbieznosc sumy kontrolnej NIE jest bledem przerywajacym - jest
 * ostrzezeniem. Plik juz przeszedl, wiec ponowne wgranie niczego nie naprawi,
 * a zatrzymanie wdrozenia z tego powodu byloby gorsze niz sam problem.
 * Ale operator ma o tym wiedziec, bo to znaczy, ze historia i baza sie
 * rozjechaly.
 */
function reportDrift(applied: Map<string, Applied>, name: string, sum: string): void {
  const wpis = applied.get(name);
  if (wpis && wpis.checksum !== sum) {
    console.warn(
      `# UWAGA: ${name} zmienil sie od wgrania (${wpis.checksum} -> ${sum}). ` +
      'Baza ma STARA wersje. Jesli zmiana ma znaczenie, dopisz nowa migracje.',
    );
  }
}

async function zapiszWpis(
  c: pg.PoolClient, name: string, sql: string, t0: number,
): Promise<void> {
  await c.query(
    `INSERT INTO migration.applied (name, checksum, applied_by, duration_ms)
     VALUES ($1, $2, $3, $4)`,
    [name, checksum(sql), process.env.USER ?? 'migrate', Date.now() - t0]);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  if (!['up', 'status', 'baseline'].includes(command)) {
    throw new Error(`Nieznane polecenie: ${command}. Uzyj up | status | baseline.`);
  }

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://adres:adres@localhost:5432/adres',
  });
  const c = await pool.connect();
  try {
    await ensureRegistry(c);
    const pliki = await readMigrations();
    const { rows } = await c.query<Applied>('SELECT name, checksum FROM migration.applied');
    const applied = new Map(rows.map((r) => [r.name, r]));

    for (const { name, sql } of pliki) reportDrift(applied, name, checksum(sql));
    const pending = pliki.filter((m) => !applied.has(m.name));

    if (command === 'status') {
      for (const { name, sql } of pliki) {
        const wpis = applied.get(name);
        console.log(`${wpis ? 'wgrana ' : 'CZEKA  '} ${name}` +
          (wpis ? `  ${wpis.checksum}` : `  ${checksum(sql)}`));
      }
      console.log(`\nWgranych: ${applied.size}, czekajacych: ${pending.length}`);
      return;
    }

    if (command === 'baseline') {
      if (pending.length === 0) {
        console.log('Nie ma czego oznaczyc - rejestr jest kompletny.');
        return;
      }
      for (const { name, sql } of pending) {
        await c.query(
          `INSERT INTO migration.applied (name, checksum, applied_by, duration_ms)
           VALUES ($1, $2, 'baseline', 0)`,
          [name, checksum(sql)]);
        console.log(`oznaczona jako wgrana (bez uruchomienia): ${name}`);
      }
      console.log(`\nOznaczonych: ${pending.length}. ZADNA nie zostala uruchomiona.`);
      return;
    }

    if (pending.length === 0) {
      console.log('Baza jest aktualna.');
      return;
    }

    await c.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    try {
      for (const { name, sql } of pending) {
        const t0 = Date.now();
        process.stdout.write(`# ${name} ... `);

        // Czy plik prowadzi transakcje SAM.
        //
        // 003 ma wlasne BEGIN i COMMIT. Owiniecie go w kolejna transakcje
        // konczy sie tak, ze COMMIT ze srodka pliku zamyka NASZA - a wpis do
        // rejestru wykonuje sie juz poza nia. Zamiast zgadywac zagniezdzenie,
        // po prostu oddajemy takiemu plikowi sterowanie.
        const wlasnaTransakcja = /^\s*BEGIN\s*;/mi.test(sql);

        try {
          if (wlasnaTransakcja) {
            await c.query(sql);
            await zapiszWpis(c, name, sql, t0);
          } else {
            await c.query('BEGIN');
            await c.query(sql);
            await zapiszWpis(c, name, sql, t0);
            await c.query('COMMIT');
          }
        } catch (e) {
          if (!wlasnaTransakcja) await c.query('ROLLBACK').catch(() => {});
          console.log('BLAD');
          throw e;
        }
        console.log(`ok (${Date.now() - t0} ms)${wlasnaTransakcja ? ' [wlasna transakcja]' : ''}`);
      }
    } finally {
      await c.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
    console.log(`\nWgranych migracji: ${pending.length}`);
  } finally {
    c.release();
    await pool.end();
  }
}

await main();
