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
 *   node --experimental-strip-types packages/api/test/openapi-conformance.ts
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

let errors = 0;
const report = (ok: boolean, description: string) => {
  console.log(`${ok ? 'OK  ' : 'ERROR'} ${description}`);
  if (!ok) errors++;
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
const inCode = new Set<string>();
const app = await buildServer(
  loadConfig({
    ...process.env,
    LOG_LEVEL: 'error',
    // Tryb przypiety JAWNIE, mimo ze do zadania 8.9 jest to takze domyslka.
    // Ten zestaw sprawdza KSZTALT kontraktu, a nie uwierzytelnianie, i nie ma
    // powodu, zeby wymagal zywej bazy z replika kluczy.
    API_KEY_MODE: 'disabled',
    // Trasy /admin istnieja w routerze WYLACZNIE przy ustawionym tokenie.
    // Bez tego szesc sciezek ze specyfikacji wygladaloby na nieistniejace,
    // a test bylby zielony u autora (ktory ma token w otoczeniu) i czerwony
    // w CI - najgorszy mozliwy rodzaj testu.
    ADMIN_TOKEN: 'token-wylacznie-do-testu-zgodnosci-kontraktu',
    // Token bez pieprza konczy start bledem: wystawienie klucza polega na
    // policzeniu skrotu, wiec endpoint bylby atrapa padajaca przy pierwszym
    // uzyciu. Tu chodzi wylacznie o to, zeby trasy trafily do routera.
    API_KEY_PEPPER_1: 'pieprz-wylacznie-do-testu-zgodnosci',
  }),
  {
    onRoute: ({ method, url }) => {
      for (const m of Array.isArray(method) ? method : [method]) {
        const met = m.toLowerCase();
        // HEAD i OPTIONS dokladaja Fastify i @fastify/cors, nie my.
        if (met === 'head' || met === 'options') continue;
        inCode.add(`${met} ${url}`);
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
const pathOperations = (operations: Record<string, unknown>) =>
  Object.entries(operations).filter(([key]) => METODY_HTTP.has(key.toLowerCase()));

const wSpec = new Set<string>();
for (const [path, operations] of Object.entries(spec.paths)) {
  for (const [metoda] of pathOperations(operations)) {
    wSpec.add(`${metoda.toLowerCase()} ${naFastify(path)}`);
  }
}

console.log(`tras w kodzie: ${inCode.size}, operacji w specyfikacji: ${wSpec.size}\n`);

const brakujace = [...inCode].filter((t) => !wSpec.has(t)).sort();
const surplus = [...wSpec].filter((t) => !inCode.has(t)).sort();

report(brakujace.length === 0,
  brakujace.length === 0
    ? 'kazda trasa z kodu jest w specyfikacji'
    : `trasy BEZ opisu w specyfikacji: ${brakujace.join(', ')}`);

report(surplus.length === 0,
  surplus.length === 0
    ? 'specyfikacja nie opisuje tras, ktorych nie ma'
    : `opisane, ale nieistniejace: ${surplus.join(', ')}`);

// Liczba endpointow /v1 krazy po dokumentacji i raporcie - niech test ja pilnuje.
const v1 = [...inCode].filter((t) => t.includes(' /v1/')).length;
report(v1 === 11, `endpointow /v1: ${v1} (dokumentacja i raport podaja 11)`);

// Powierzchnia administracyjna liczona OSOBNO od klienckiej.
//
// Licznik zlicza PARY metoda+sciezka, a nie sciezki: dzisiejsza rownosc
// "11 tras = 11 par" dla /v1 jest przypadkowa i rozjedzie sie przy pierwszej
// sciezce z dwiema metodami. /admin ma ich cztery i szesc operacji.
const admin = [...inCode].filter((t) => t.includes(' /admin/')).length;
report(admin === 6, `operacji /admin: ${admin} (cztery sciezki, szesc par metoda+sciezka)`);

// Kazda operacja musi opisywac odpowiedz 200 - inaczej kontrakt jest pusty.
for (const [path, operations] of Object.entries(spec.paths)) {
  for (const [metoda, op] of pathOperations(operations)) {
    const odp = (op as { responses?: Record<string, unknown> }).responses ?? {};
    if (!odp['200']) report(false, `${metoda.toUpperCase()} ${path} nie opisuje odpowiedzi 200`);
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

report(schematy.length > 0, `zdefiniowane schematy bezpieczenstwa: ${schematy.join(', ') || 'BRAK'}`);

const withoutExemption: string[] = [];
const exemptUnnecessarily: string[] = [];
const without401: string[] = [];
for (const [path, operations] of Object.entries(spec.paths)) {
  for (const [metoda, op] of pathOperations(operations)) {
    const o = op as { security?: unknown[]; responses?: Record<string, unknown> };
    const exempt = Array.isArray(o.security) && o.security.length === 0;
    if (SONDY.has(path) && !exempt) withoutExemption.push(`${metoda} ${path}`);
    if (!SONDY.has(path) && exempt) exemptUnnecessarily.push(`${metoda} ${path}`);
    if (!SONDY.has(path) && !o.responses?.['401']) without401.push(`${metoda} ${path}`);
  }
}

report(withoutExemption.length === 0,
  withoutExemption.length === 0
    ? 'sondy operacyjne maja jawne security: []'
    : `sondy BEZ jawnego security: [] (dostana 401 od Prometheusa i kubeleta): ${withoutExemption.join(', ')}`);
report(exemptUnnecessarily.length === 0,
  exemptUnnecessarily.length === 0
    ? 'zadna trasa poza sondami nie jest zwolniona z uwierzytelniania'
    : `zwolnione z uwierzytelniania mimo ze nie sa sondami: ${exemptUnnecessarily.join(', ')}`);
report(without401.length === 0,
  without401.length === 0
    ? 'kazda chroniona operacja opisuje odpowiedz 401'
    : `chronione operacje bez opisu 401: ${without401.join(', ')}`);

await app.close();
console.log(errors === 0 ? '\nSpecyfikacja zgodna z kodem.' : `\n${errors} niezgodnosci.`);
process.exit(errors === 0 ? 0 : 1);
