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

/**
 * Trasy zbieramy hookiem onRoute, a NIE z wydruku printRoutes.
 *
 * printRoutes rysuje drzewo dla czlowieka i ma trzy wlasciwosci, ktore przy
 * pierwszej trasie zagniezdzonej zamienialy ten test w zrodlo mylacych bledow:
 *
 *  - find-my-way zeruje prefiks po wypisaniu wezla bedacego trasa, wiec para
 *    /admin/keys i /admin/keys/:id wypisze dziecko jako "/:id". Test zglaszalby
 *    jednoczesnie "brak w specyfikacji: delete /:id" i "opisane, ale
 *    nieistniejace: delete /admin/keys/{id}" - a programista szukalby literowki
 *    w YAML-u, podczas gdy wada siedzi w parserze;
 *  - trasa wieloznacznikowa drukuje sie bez wiodacego ukosnika ("* (OPTIONS)"),
 *    wiec wyrazenie regularne jej nie lapie. To dzieje sie JUZ DZIS: @fastify/cors
 *    rejestruje options('*'), o czym test nie wiedzial;
 *  - licznik endpointow /v1 nie policzylby trasy wypisanej jako "/:id", czyli
 *    straznik milczalby dokladnie tam, gdzie powinien krzyczec.
 *
 * Hook musi powstac przed rejestracja tras, stad drugi argument buildServer.
 */
const wKodzie = new Set<string>();
const app = await buildServer(
  loadConfig({ ...process.env, LOG_LEVEL: 'error' }),
  {
    onRoute: ({ method, url }) => {
      for (const m of Array.isArray(method) ? method : [method]) {
        const met = m.toLowerCase();
        // HEAD i OPTIONS dokladaja Fastify i @fastify/cors, nie my.
        if (met === 'head' || met === 'options') continue;
        wKodzie.add(`${met} ${url}`);
      }
    },
  },
);
await app.ready();

/** OpenAPI uzywa {simc}, Fastify :simc - sprowadzamy do jednej postaci. */
const naFastify = (p: string) => p.replace(/\{([^}]+)\}/g, ':$1');

/**
 * OpenAPI 3.1 dopuszcza w obiekcie sciezki klucze, ktore NIE sa operacjami:
 * `parameters`, `summary`, `description`, `servers`, `$ref`. Sa naturalne przy
 * endpointach ze wspolnym parametrem, a bez filtrowania daja NARAZ dwa falszywe
 * bledy przy poprawnym kontrakcie: "opisane, ale nieistniejace: parameters ..."
 * oraz "PARAMETERS ... nie opisuje odpowiedzi 200".
 */
const METODY_HTTP = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const operacjeSciezki = (operacje: Record<string, unknown>) =>
  Object.entries(operacje).filter(([klucz]) => METODY_HTTP.has(klucz.toLowerCase()));

const wSpec = new Set<string>();
for (const [sciezka, operacje] of Object.entries(spec.paths)) {
  for (const [metoda] of operacjeSciezki(operacje)) {
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
  for (const [metoda, op] of operacjeSciezki(operacje)) {
    const odp = (op as { responses?: Record<string, unknown> }).responses ?? {};
    if (!odp['200']) zglos(false, `${metoda.toUpperCase()} ${sciezka} nie opisuje odpowiedzi 200`);
  }
}

// --- straznicy kontraktu bezpieczenstwa (etap 8A) ---------------------
//
// Bez nich najwazniejsza czesc kontraktu 8A bylaby jedynym fragmentem pliku,
// ktorego nic nie pilnuje: literowka w nazwie schematu albo zapomniane
// `security: []` na sondzie wychodzilyby dopiero na produkcji.
const SONDY = new Set(['/health', '/ready', '/metrics', '/status']);
const schematy = Object.keys(
  (spec as { components?: { securitySchemes?: Record<string, unknown> } })
    .components?.securitySchemes ?? {});

zglos(schematy.length > 0, `zdefiniowane schematy bezpieczenstwa: ${schematy.join(', ') || 'BRAK'}`);

const bezZwolnienia: string[] = [];
const zwolnioneNiepotrzebnie: string[] = [];
const bez401: string[] = [];
for (const [sciezka, operacje] of Object.entries(spec.paths)) {
  for (const [metoda, op] of operacjeSciezki(operacje)) {
    const o = op as { security?: unknown[]; responses?: Record<string, unknown> };
    const zwolniona = Array.isArray(o.security) && o.security.length === 0;
    if (SONDY.has(sciezka) && !zwolniona) bezZwolnienia.push(`${metoda} ${sciezka}`);
    if (!SONDY.has(sciezka) && zwolniona) zwolnioneNiepotrzebnie.push(`${metoda} ${sciezka}`);
    if (!SONDY.has(sciezka) && !o.responses?.['401']) bez401.push(`${metoda} ${sciezka}`);
  }
}

zglos(bezZwolnienia.length === 0,
  bezZwolnienia.length === 0
    ? 'sondy operacyjne maja jawne security: []'
    : `sondy BEZ jawnego security: [] (dostana 401 od Prometheusa i kubeleta): ${bezZwolnienia.join(', ')}`);
zglos(zwolnioneNiepotrzebnie.length === 0,
  zwolnioneNiepotrzebnie.length === 0
    ? 'zadna trasa poza sondami nie jest zwolniona z uwierzytelniania'
    : `zwolnione z uwierzytelniania mimo ze nie sa sondami: ${zwolnioneNiepotrzebnie.join(', ')}`);
zglos(bez401.length === 0,
  bez401.length === 0
    ? 'kazda chroniona operacja opisuje odpowiedz 401'
    : `chronione operacje bez opisu 401: ${bez401.join(', ')}`);

await app.close();
console.log(bledy === 0 ? '\nSpecyfikacja zgodna z kodem.' : `\n${bledy} niezgodnosci.`);
process.exit(bledy === 0 ? 0 : 1);
