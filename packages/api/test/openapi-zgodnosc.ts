/**
 * Pilnuje, zeby openapi.yaml nie rozjechal sie z kodem.
 *
 * Bez tego testu specyfikacja podzieli los raportu, ktory przez trzy wydania
 * opisywal stan inny niz repozytorium: kazdy nowy endpoint bylby udokumentowany
 * dopiero wtedy, gdy ktos o tym pamieta.
 *
 * Test porownuje trasy zarejestrowane w Fastify z pathami w specyfikacji
 * w OBIE strony - brak w specyfikacji i nadmiar w specyfikacji sa rownie zle.
 *
 *   node --experimental-strip-types packages/api/test/openapi-zgodnosc.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { buildServer, loadConfig } from '../src/server.ts';

const tu = dirname(fileURLToPath(import.meta.url));
const spec = parse(readFileSync(join(tu, '..', 'openapi.yaml'), 'utf8')) as {
  paths: Record<string, Record<string, unknown>>;
};

let bledy = 0;
const zglos = (ok: boolean, opis: string) => {
  console.log(`${ok ? 'OK  ' : 'BLAD'} ${opis}`);
  if (!ok) bledy++;
};

const app = await buildServer(loadConfig({ ...process.env, LOG_LEVEL: 'error' }));
await app.ready();

/** Fastify zwraca trasy w postaci "METODA /sciezka (/sciezka)". */
const wKodzie = new Set<string>();
for (const linia of app.printRoutes({ commonPrefix: false }).split('\n')) {
  const m = linia.match(/^\s*([├└│─\s]*)(\/\S*)\s+\((.+)\)\s*$/);
  if (!m) continue;
  const sciezka = m[2];
  for (const metoda of m[3].split(',')) {
    const met = metoda.trim().toLowerCase();
    if (met === 'head' || met === 'options') continue;   // dokladane przez Fastify
    wKodzie.add(`${met} ${sciezka}`);
  }
}

/** OpenAPI uzywa {simc}, Fastify :simc - sprowadzamy do jednej postaci. */
const naFastify = (p: string) => p.replace(/\{([^}]+)\}/g, ':$1');

const wSpec = new Set<string>();
for (const [sciezka, operacje] of Object.entries(spec.paths)) {
  for (const metoda of Object.keys(operacje)) {
    wSpec.add(`${metoda.toLowerCase()} ${naFastify(sciezka)}`);
  }
}

console.log(`tras w kodzie: ${wKodzie.size}, operacji w specyfikacji: ${wSpec.size}\n`);

const brakujace = [...wKodzie].filter((t) => !wSpec.has(t)).sort();
const nadmiarowe = [...wSpec].filter((t) => !wKodzie.has(t)).sort();

zglos(brakujace.length === 0,
  brakujace.length === 0
    ? 'kazda trasa z kodu jest w specyfikacji'
    : `trasy BEZ opisu w specyfikacji: ${brakujace.join(', ')}`);

zglos(nadmiarowe.length === 0,
  nadmiarowe.length === 0
    ? 'specyfikacja nie opisuje tras, ktorych nie ma'
    : `opisane, ale nieistniejace: ${nadmiarowe.join(', ')}`);

// Liczba endpointow /v1 krazy po dokumentacji i raporcie - niech test ja pilnuje.
const v1 = [...wKodzie].filter((t) => t.includes(' /v1/')).length;
zglos(v1 === 11, `endpointow /v1: ${v1} (dokumentacja i raport podaja 11)`);

// Kazda operacja musi opisywac odpowiedz 200 - inaczej kontrakt jest pusty.
for (const [sciezka, operacje] of Object.entries(spec.paths)) {
  for (const [metoda, op] of Object.entries(operacje)) {
    const odp = (op as { responses?: Record<string, unknown> }).responses ?? {};
    if (!odp['200']) zglos(false, `${metoda.toUpperCase()} ${sciezka} nie opisuje odpowiedzi 200`);
  }
}

await app.close();
console.log(bledy === 0 ? '\nSpecyfikacja zgodna z kodem.' : `\n${bledy} niezgodnosci.`);
process.exit(bledy === 0 ? 0 : 1);
