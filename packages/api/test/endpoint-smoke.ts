/**
 * Proba dymna KAZDEJ trasy na zywej bazie.
 *
 * PO CO
 *
 * `/v1/numbers` zwracalo 500 przez trzy kolumny, ktorych po migracji 005 juz
 * nie ma: `p.nr_key`, `p.nr_sort`, `p.wycofany_od`. Nie zlapal tego ani
 * typecheck (SQL jest napisem), ani zestawy hermetyczne (nie maja bazy), ani
 * `openapi-conformance` (porownuje sciezki, nie wykonuje ich), ani `quality`
 * (idzie po suggest i validate). Trasa byla martwa i nikt tego nie widzial.
 *
 * Ten zestaw nie sprawdza tresci - od tego jest zbior wzorcowy. Sprawdza rzecz
 * grubsza i tansza: ze KAZDA trasa w ogole odpowiada, a nie wywraca sie na
 * pierwszym zapytaniu do bazy.
 *
 * SAMOPILNUJACY SIE: lista przypadkow jest porownywana z trasami zarejestro-
 * wanymi w Fastify. Nowa trasa bez przypadku przewraca ten zestaw, zamiast
 * po cichu zostac nieprzetestowana.
 *
 *   DATABASE_URL=... node --experimental-strip-types packages/api/test/endpoint-smoke.ts
 */
import { buildServer, loadConfig } from '../src/server.ts';
import { errorDef } from '@adres-pl/core';

const ADMIN_TOKEN = 'token-wylacznie-do-proby-dymnej-endpointow';

interface Case {
  /** Trasa tak, jak widzi ja router - z parametrem, nie z wartoscia. */
  route: string;
  method: 'GET' | 'POST' | 'DELETE';
  /** Adres wywolania, juz z podstawionymi wartosciami. */
  url: string;
  payload?: unknown;
  admin?: boolean;
  /** Kody uznane za poprawna odpowiedz. 5xx nigdy tu nie trafia. */
  ok: number[];
}

/**
 * SIMC Warszawy. Istnieje w komplecie krajowym; przy pustej bazie trasy i tak
 * maja odpowiedziec 404 albo pusta lista, a nie kodem 5xx - i to jest badane.
 */
const SIMC = '0918123';

const CASES: Case[] = [
  { route: '/v1/suggest',        method: 'GET',  url: '/v1/suggest?q=marszalkowska&limit=5', ok: [200] },
  { route: '/v1/localities',     method: 'GET',  url: '/v1/localities?q=warszawa&limit=5',   ok: [200] },
  { route: '/v1/streets',        method: 'GET',  url: `/v1/streets?simc=${SIMC}&q=marsz`,    ok: [200] },
  { route: '/v1/numbers',        method: 'GET',  url: `/v1/numbers?simc=${SIMC}&limit=3`,    ok: [200] },
  { route: '/v1/postal-code',    method: 'GET',  url: `/v1/postal-code?simc=${SIMC}&nr=1`,   ok: [200] },
  { route: '/v1/reverse',        method: 'GET',  url: '/v1/reverse?lat=52.2297&lon=21.0122', ok: [200] },
  { route: '/v1/locality/:simc', method: 'GET',  url: `/v1/locality/${SIMC}`,                ok: [200, 404] },
  { route: '/v1/meta',           method: 'GET',  url: '/v1/meta',                            ok: [200] },
  { route: '/v1/parse',          method: 'POST', url: '/v1/parse',
    payload: { raw: 'ul. Marszalkowska 1, 00-624 Warszawa' }, ok: [200] },
  { route: '/v1/validate',       method: 'POST', url: '/v1/validate',
    payload: { raw: 'ul. Marszalkowska 1, 00-624 Warszawa' }, ok: [200] },
  { route: '/v1/batch',          method: 'POST', url: '/v1/batch',
    payload: { items: [{ raw: 'ul. Marszalkowska 1, 00-624 Warszawa' }] }, ok: [200] },

  { route: '/health',  method: 'GET', url: '/health',  ok: [200] },
  { route: '/ready',   method: 'GET', url: '/ready',   ok: [200, 503] },
  { route: '/metrics', method: 'GET', url: '/metrics', ok: [200] },
  { route: '/status',  method: 'GET', url: '/status',  ok: [200] },

  // Trasy administracyjne: interesuje nas wylacznie to, ze odpowiadaja.
  // Cykl zycia kluczy sprawdza key-lifecycle.ts, uprawnienia - admin.ts.
  { route: '/admin/clients',     method: 'GET',  url: '/admin/clients', admin: true, ok: [200] },
  { route: '/admin/clients',     method: 'POST', url: '/admin/clients', admin: true,
    payload: { name: `proba-dymna-${Date.now()}` }, ok: [201] },
  { route: '/admin/keys',        method: 'GET',  url: '/admin/keys',    admin: true, ok: [200] },
  { route: '/admin/keys',        method: 'POST', url: '/admin/keys',    admin: true,
    payload: { clientId: -1 }, ok: [201, 400, 404, 409] },
  { route: '/admin/keys/rotate', method: 'POST', url: '/admin/keys/rotate', admin: true,
    payload: { keyId: -1 }, ok: [200, 400, 404] },
  { route: '/admin/keys/revoke', method: 'POST', url: '/admin/keys/revoke', admin: true,
    payload: { keyId: -1 }, ok: [200, 400, 404] },
];

const inCode = new Set<string>();
const app = await buildServer(
  loadConfig({
    ...process.env,
    LOG_LEVEL: 'error',
    API_KEY_MODE: 'disabled',
    RATE_LIMIT_MAX: '1000000',
    ADMIN_TOKEN,
    API_KEY_PEPPER_1: 'pieprz-wylacznie-do-proby-dymnej',
  }),
  {
    onRoute: ({ method, url }) => {
      for (const m of Array.isArray(method) ? method : [method]) {
        const met = m.toLowerCase();
        if (met === 'head' || met === 'options') continue;
        inCode.add(`${met} ${url}`);
      }
    },
  },
);

let errors = 0;
const report = (ok: boolean, description: string) => {
  console.log(`${ok ? 'OK  ' : 'ERROR'} ${description}`);
  if (!ok) errors++;
};

/**
 * KAZDA odpowiedz bledu ma ten sam ksztalt.
 *
 * Przed wprowadzeniem warstwy bledow bylo inaczej: czesc tras zwracala
 * `{error}`, czesc `{error, code}`, a nieprzechwycone leacialy domyslnym
 * ksztaltem Fastify. Klient nie mial jednego sposobu na odczytanie przyczyny.
 */
function checkErrorShape(r: { statusCode: number; body: string }, opis: string): void {
  if (r.statusCode < 400) return;
  let b: Record<string, unknown>;
  try { b = JSON.parse(r.body) as Record<string, unknown>; }
  catch { report(false, `${opis}: cialo bledu nie jest JSON-em`); return; }

  const brak = ['code', 'error', 'correlationId'].filter((k) => b[k] === undefined);
  report(brak.length === 0, `${opis}: ksztalt bledu${brak.length ? ' - brakuje ' + brak.join(', ') : ' pelny'}`);

  const def = errorDef(String(b.code));
  report(def !== undefined, `${opis}: kod ${b.code} jest w katalogu`);
  if (def) {
    report(def.status === r.statusCode,
      `${opis}: kod ${b.code} ma stan ${r.statusCode} (katalog: ${def.status})`);
  }
  // Tresc bledu bazy NIGDY nie moze wyjsc na zewnatrz - opisuje budowe schematu.
  report(!/constraint|violates|relation "|column "/i.test(r.body),
    `${opis}: bez wycieku szczegolu bazy`);
}

for (const c of CASES) {
  const r = await app.inject({
    method: c.method,
    url: c.url,
    headers: {
      ...(c.payload ? { 'content-type': 'application/json' } : {}),
      ...(c.admin ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {}),
    },
    ...(c.payload ? { payload: c.payload } : {}),
  });
  const przeszlo = c.ok.includes(r.statusCode);
  report(przeszlo,
    `${c.method} ${c.url} -> ${r.statusCode}` +
    (przeszlo ? '' : ` (oczekiwane ${c.ok.join('/')}): ${r.body.slice(0, 160)}`));
  checkErrorShape(r, `${c.method} ${c.url}`);
}

// --- bledy WYWOLANE CELOWO ------------------------------------------------
//
// Bez nich kontrakt bledow bylby sprawdzany tylko tam, gdzie blad wyjdzie
// przypadkiem - czyli prawie nigdzie, bo pozostale przypadki sa dobrane tak,
// zeby przechodzily.
console.log('\n--- kontrakt bledow ---');
const BLEDNE: { opis: string; method: 'GET' | 'POST'; url: string; payload?: unknown; admin?: boolean; status: number; code: string }[] = [
  { opis: 'nieznana trasa',       method: 'GET',  url: '/v1/nie-ma-takiej',            status: 404, code: 'NOT_FOUND' },
  { opis: 'zly format SIMC',      method: 'GET',  url: '/v1/locality/abc',             status: 400, code: 'VALIDATION_FAILED' },
  { opis: 'brak parametru',       method: 'GET',  url: '/v1/numbers',                  status: 400, code: 'INVALID_PARAMETER' },
  { opis: 'brak tokenu',          method: 'GET',  url: '/admin/clients',               status: 401, code: 'MISSING_TOKEN' },
  { opis: 'nieistniejacy klient', method: 'POST', url: '/admin/keys', admin: true,
    payload: { clientId: -1 }, status: 404, code: 'CLIENT_NOT_FOUND' },
  { opis: 'nieistniejacy klucz',  method: 'POST', url: '/admin/keys/revoke', admin: true,
    payload: { keyId: -1 }, status: 404, code: 'KEY_NOT_FOUND' },
];
for (const b of BLEDNE) {
  const r = await app.inject({
    method: b.method, url: b.url,
    headers: {
      ...(b.payload ? { 'content-type': 'application/json' } : {}),
      ...(b.admin ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {}),
    },
    ...(b.payload ? { payload: b.payload } : {}),
  });
  const body = r.json() as { code?: string };
  report(r.statusCode === b.status && body.code === b.code,
    `${b.opis}: ${r.statusCode} ${body.code} (oczekiwane ${b.status} ${b.code})`);
  checkErrorShape(r, b.opis);
  report(r.headers['x-correlation-id'] !== undefined, `${b.opis}: naglowek korelacji`);
}

// --- straznik kompletnosci -------------------------------------------------
const covered = new Set(CASES.map((c) => `${c.method.toLowerCase()} ${c.route}`));
const missing = [...inCode].filter((t) => !covered.has(t));
report(missing.length === 0,
  `kazda trasa ma przypadek: ${missing.length ? 'BRAK dla ' + missing.join(', ') : 'tak'}`);

const phantom = [...covered].filter((t) => !inCode.has(t));
report(phantom.length === 0,
  `zadnego przypadku dla nieistniejacej trasy: ${phantom.length ? phantom.join(', ') : 'tak'}`);

await app.close();
console.log(`\nTras w routerze: ${inCode.size}, przypadkow: ${CASES.length}`);
console.log(errors === 0 ? 'Wszystkie trasy odpowiadaja.' : `${errors} problemow.`);
process.exit(errors === 0 ? 0 : 1);
