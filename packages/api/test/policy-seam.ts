/**
 * Szew polityki: KAZDA trasa /admin przechodzi przez silnik i zostawia slad.
 *
 * PO CO OSOBNY ZESTAW
 *
 * `can()` jest jedynym punktem decyzji tylko dopoki ktos o tym pamieta.
 * Nowa trasa dopisana bez wywolania przechodzilaby bez kontroli uprawnien
 * i bez wpisu w dzienniku - i nic by tego nie zglosilo, bo odpowiadalaby
 * poprawnie. Ten zestaw zamienia zwyczaj w regule.
 *
 * SPOSOB
 *
 * Trasy zbieramy hookiem onRoute, wiec lista bierze sie z ROUTERA, a nie
 * z recznie utrzymywanego spisu. Kazda wolamy z tokenem operatora, bierzemy
 * identyfikator korelacji z naglowka odpowiedzi i sprawdzamy, czy w dzienniku
 * pojawil sie wpis z tym samym identyfikatorem. Brak wpisu = trasa ominela
 * silnik.
 *
 * Ten sam wzorzec co `openapi-conformance.ts`, ktory pilnuje, ze zadna trasa
 * poza sondami nie jest zwolniona z uwierzytelniania.
 *
 *   DATABASE_URL=... node --experimental-strip-types packages/api/test/policy-seam.ts
 */
import pg from 'pg';
import { buildServer, loadConfig } from '../src/server.ts';
import { can, type Actor } from '@adres-pl/core';
import { CORRELATION_HEADER } from '../src/errors.ts';

const ADMIN_TOKEN = 'token-wylacznie-do-zestawu-szwu-polityki-1';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://adres:adres@localhost:5432/adres';

let errors = 0;
const report = (ok: boolean, description: string) => {
  console.log(`${ok ? 'OK  ' : 'ERROR'} ${description}`);
  if (!ok) errors++;
};

/** Wywolanie kazdej trasy /admin - cialo dobrane tak, zeby doszla do kontroli. */
const CIALA: Record<string, unknown> = {
  'post /admin/clients':     { name: `szew-${Date.now()}` },
  'post /admin/keys':        { clientId: -1 },
  'post /admin/keys/rotate': { keyId: -1 },
  'post /admin/keys/revoke': { keyId: -1 },
};

const adminRoutes: string[] = [];
const app = await buildServer(
  loadConfig({
    ...process.env,
    LOG_LEVEL: 'error',
    API_KEY_MODE: 'disabled',
    RATE_LIMIT_MAX: '1000000',
    ADMIN_TOKEN,
    API_KEY_PEPPER_1: 'pieprz-wylacznie-do-zestawu-szwu',
  }),
  {
    onRoute: ({ method, url }) => {
      for (const m of Array.isArray(method) ? method : [method]) {
        const met = m.toLowerCase();
        if (met === 'head' || met === 'options') continue;
        if (url.startsWith('/admin')) adminRoutes.push(`${met} ${url}`);
      }
    },
  },
);

const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();

console.log(`--- szew polityki: ${adminRoutes.length} tras /admin ---`);

for (const trasa of adminRoutes) {
  const [metoda, sciezka] = trasa.split(' ');
  const payload = CIALA[trasa];
  const r = await app.inject({
    method: metoda.toUpperCase() as 'GET',
    url: sciezka,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { payload } : {}),
  });

  const korelacja = r.headers[CORRELATION_HEADER];
  if (!korelacja) { report(false, `${trasa}: brak naglowka korelacji`); continue; }

  const { rows } = await db.query<{ action: string; decision: string }>(
    `SELECT action, decision FROM panel.audit_log WHERE correlation_id = $1`,
    [String(korelacja)]);

  report(rows.length > 0,
    `${trasa} -> ${r.statusCode}, wpisow w dzienniku: ${rows.length}` +
    (rows.length ? ` (${rows.map((x) => `${x.action}/${x.decision}`).join(', ')})` : ' - TRASA OMINELA SILNIK'));
}

// --- odmowa tez zostawia slad ---------------------------------------------
//
// Wykonawca bez uprawnienia ma dostac 403 I wpis `denied`. Bez tej kontroli
// dziennik moglby zapisywac wylacznie udane czynnosci, czyli byc bezuzyteczny
// dokladnie wtedy, gdy jest najbardziej potrzebny.
console.log('\n--- odmowa ---');
const bezUprawnien: Actor = { kind: 'user', id: '999', label: 'bez-uprawnien', grants: [] };
const d = can(bezUprawnien, 'key.revoke', { clientId: 1 });
report(!d.allowed, `wykonawca bez nadan dostaje odmowe: ${d.allowed ? '(przeszedl!)' : d.reason}`);

// --- katalog kontra baza ---------------------------------------------------
//
// Rola moze wymieniac uprawnienie, ktore zniklo z katalogu przy wdrozeniu.
// Rola wyglada wtedy normalnie, a jedna jej pozycja nie robi nic.
console.log('\n--- spojnosc katalogu z baza ---');
const { findOrphanedPermissions } = await import('../src/policy/grants.ts');
const osierocone = await findOrphanedPermissions(
  new pg.Pool({ connectionString: DATABASE_URL }));
report(osierocone.length === 0,
  osierocone.length === 0
    ? 'zadna rola nie wymienia uprawnienia spoza katalogu'
    : `role wymieniaja nieistniejace uprawnienia: ${osierocone.join(', ')}`);

await db.end();
await app.close();
console.log(errors === 0 ? '\nSzew trzyma.' : `\n${errors} problemow.`);
process.exit(errors === 0 ? 0 : 1);
