/**
 * Regresja jakosci wyszukiwania i walidacji (zadanie 6.8).
 *
 * Zbior wzorcowy: zbior-wzorcowy.yaml. Kazdy przypadek opisuje odpowiedz
 * POPRAWNA, nie biezaca - uzasadnienia sa w pliku obok przypadkow.
 *
 * Przypadki oznaczone `znaneOdstepstwo` to udokumentowane wady, ktore czekaja
 * na naprawe. Nie przewracaja zestawu, ale sa wypisywane, a gdy przestana
 * wystepowac - zestaw upomina sie o zdjecie znacznika. Dzieki temu lista
 * odstepstw nie moze po cichu ani urosnac, ani sklamac.
 *
 *   node --experimental-strip-types packages/api/test/jakosc-wyszukiwania.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { buildServer, loadConfig } from '../src/server.ts';

interface PrzypadekPodpowiedzi {
  q: string;
  oczekiwane?: { label?: string; type?: string };
  oczekiwaneZawiera?: string;
  oczekiwaneMiejscowosc?: string;
  roznychSimc?: number;
  wTop: number;
  dlaczego?: string;
  znaneOdstepstwo?: string;
}
interface PrzypadekWalidacji {
  raw: string;
  oczekiwane?: Record<string, string>;
  zawieraUwage?: string;
  dlaczego?: string;
  znaneOdstepstwo?: string;
}

const tu = dirname(fileURLToPath(import.meta.url));
const zbior = parse(readFileSync(join(tu, 'zbior-wzorcowy.yaml'), 'utf8')) as {
  wersjaDanych: string;
  podpowiedzi: PrzypadekPodpowiedzi[];
  walidacja: PrzypadekWalidacji[];
};

const app = await buildServer(loadConfig({
  ...process.env, LOG_LEVEL: 'error', RATE_LIMIT_MAX: '1000000',
}));

const wersja = (await app.inject({ method: 'GET', url: '/v1/suggest?q=warszawa&limit=1' })
  .then((r) => r.json())).wersjaDanych;
if (wersja !== zbior.wersjaDanych) {
  console.log(`UWAGA: zbior zamrozono na danych ${zbior.wersjaDanych}, a zaladowane sa ${wersja}.`);
  console.log('       Rozbieznosci moga wynikac ze zmiany danych, nie z regresji.\n');
}

let bledy = 0;
const odstepstwaNadal: string[] = [];
const odstepstwaNaprawione: string[] = [];

function wynik(ok: boolean, opis: string, odstepstwo?: string) {
  if (odstepstwo) {
    // Przypadek udokumentowany jako wadliwy: nie liczymy bledu, ale sledzimy stan.
    if (ok) odstepstwaNaprawione.push(opis);
    else odstepstwaNadal.push(opis);
    console.log(`${ok ? 'NAPRAWIONE' : 'odstepstwo'}  ${opis}`);
    return;
  }
  console.log(`${ok ? 'OK  ' : 'BLAD'}        ${opis}`);
  if (!ok) bledy++;
}

// ---------------------------------------------------------------- podpowiedzi
console.log('--- podpowiedzi ---');
for (const p of zbior.podpowiedzi) {
  const limit = Math.max(p.wTop, 10);
  const r = await app.inject({ method: 'GET', url: `/v1/suggest?q=${encodeURIComponent(p.q)}&limit=${limit}` });
  const wyniki = (r.json().results ?? []) as Array<Record<string, unknown>>;
  const top = wyniki.slice(0, p.wTop);

  let ok: boolean;
  let opis: string;

  if (p.roznychSimc !== undefined) {
    const ile = new Set(top.map((x) => x.simc)).size;
    ok = ile >= p.roznychSimc;
    opis = `"${p.q}" — roznych miejscowosci w top ${p.wTop}: ${ile} (wymagane ${p.roznychSimc})`;
  } else if (p.oczekiwaneMiejscowosc) {
    const poz = wyniki.findIndex((x) => x.locality === p.oczekiwaneMiejscowosc);
    ok = poz >= 0 && poz < p.wTop;
    opis = `"${p.q}" — ${p.oczekiwaneMiejscowosc} na pozycji ${poz < 0 ? `poza top ${limit}` : poz + 1} (wymagane <= ${p.wTop})`;
  } else if (p.oczekiwaneZawiera) {
    const poz = top.findIndex((x) => String(x.label).includes(p.oczekiwaneZawiera!));
    ok = poz >= 0;
    opis = `"${p.q}" — "${p.oczekiwaneZawiera}" ${ok ? `na pozycji ${poz + 1}` : `brak w top ${p.wTop}`}`;
  } else {
    const chc = p.oczekiwane ?? {};
    const poz = top.findIndex((x) =>
      (chc.label === undefined || x.label === chc.label) &&
      (chc.type === undefined || x.type === chc.type));
    ok = poz >= 0;
    opis = `"${p.q}" — "${chc.label ?? chc.type}" ${ok ? `na pozycji ${poz + 1}` : `brak w top ${p.wTop}`}`;
  }
  wynik(ok, opis, p.znaneOdstepstwo);
}

// ----------------------------------------------------------------- walidacja
console.log('\n--- walidacja ---');
for (const p of zbior.walidacja) {
  const r = await app.inject({
    method: 'POST', url: '/v1/validate',
    headers: { 'content-type': 'application/json' },
    payload: { raw: p.raw },
  });
  const body = r.json() as { address?: Record<string, unknown>; confidence?: string; issues?: Array<{ code: string }> };
  const adres = body.address ?? {};
  const rozbieznosci: string[] = [];

  for (const [pole, oczek] of Object.entries(p.oczekiwane ?? {})) {
    const jest = pole === 'confidence' ? body.confidence : adres[pole];
    if (String(jest ?? '') !== oczek) rozbieznosci.push(`${pole}: "${jest ?? ''}" zamiast "${oczek}"`);
  }
  if (p.zawieraUwage && !(body.issues ?? []).some((i) => i.code === p.zawieraUwage)) {
    rozbieznosci.push(`brak uwagi ${p.zawieraUwage}`);
  }

  wynik(rozbieznosci.length === 0,
    `"${p.raw}"${rozbieznosci.length ? ' — ' + rozbieznosci.join('; ') : ''}`,
    p.znaneOdstepstwo);
}

// ----------------------------------------------------------------- podsumowanie
await app.close();

console.log(`\nPrzypadkow: ${zbior.podpowiedzi.length + zbior.walidacja.length}`);
console.log(`Odstepstw nadal wystepujacych: ${odstepstwaNadal.length}`);

if (odstepstwaNaprawione.length) {
  console.log('\nNAPRAWIONE ODSTEPSTWA - zdejmij znacznik `znaneOdstepstwo` w zbior-wzorcowym:');
  for (const o of odstepstwaNaprawione) console.log('  - ' + o);
  bledy += odstepstwaNaprawione.length;
}

console.log(bledy === 0
  ? '\nJakosc bez regresji.'
  : `\n${bledy} problemow wymagajacych reakcji.`);
process.exit(bledy === 0 ? 0 : 1);
