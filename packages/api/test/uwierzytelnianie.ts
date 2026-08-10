/**
 * Uwierzytelnianie kluczem API i dwupoziomowe limitowanie (zadanie 8.4b).
 *
 * WYMAGA BAZY z migracja 003. Artefakt indeksu buduje sobie sam (atrapa).
 *
 * NAJWAZNIEJSZA KONTROLA CALEGO ETAPU to nr 11: kubelek limitu jest PER
 * ZWERYFIKOWANY KLIENT. Etap 8A przywraca klucze API jako klucz limitowania,
 * czyli wraca dokladnie w miejsce luki z zadania 8.1 - a zasada brzmi, ze
 * kluczem limitowania moze byc wylacznie wartosc wczesniej zweryfikowana.
 *
 * ODWROCENIA - kazde wykonane i sprawdzone:
 *   - registerAuth przestawiony z onRequest na preHandler  -> kontrola 11
 *   - keyGenerator kluczujacy po kluczId zamiast klientId   -> kontrola 11
 *   - jednakowe cialo 401 zastapione roznymi komunikatami   -> kontrola 4
 *   - usuniete '/metrics' z listy tras bez klucza           -> kontrola 8
 *   - usuniete wywolanie limitera adresu w odmowie          -> kontrola 12
 *
 *   node --experimental-strip-types packages/api/test/uwierzytelnianie.ts
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { generateApiKey } from '@adres-pl/core';
import { buildServer, loadConfig } from '../src/server.ts';
import { Peppers } from '../src/keys/pepper.ts';
import { zapiszAtrapeIndeksu } from './atrapa-indeksu.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://adres:adres@localhost:5432/adres';
const PIEPRZ = 'pieprz-testowy-8.4b';
const pieprze = new Peppers(new Map([[1, PIEPRZ]]), 1);

let bledy = 0;
const zglos = (ok: boolean, opis: string) => {
  console.log(`${ok ? 'OK  ' : 'BLAD'} ${opis}`);
  if (!ok) bledy++;
};

const artefakt = await zapiszAtrapeIndeksu(
  join(await mkdtemp(join(tmpdir(), 'adres-auth-')), 'current.bin'));

// --- przygotowanie danych ----------------------------------------------
//
// Kazdy przebieg zaklada wlasnych klientow i generuje wlasne sekrety - w tym
// schemacie nie kasujemy rekordow, a skrot ma unikat, wiec inaczej drugi
// przebieg lamalby wiez.
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
const stempel = `auth-8a-${Date.now()}`;

async function zalozKlienta(nazwa: string, limitMin: number): Promise<number> {
  const { rows: [r] } = await db.query<{ id: string }>(
    `INSERT INTO licencje.klient (nazwa, pakiet, limit_zapytan_min)
     VALUES ($1, 'test', $2) RETURNING id`, [`${stempel}-${nazwa}`, limitMin]);
  return Number(r.id);
}

interface WystawionyKlucz { jawny: string; id: number }

// Daty liczymy w JS i przekazujemy jako parametry. Wyrazenie SQL w miejscu
// parametru (np. "now() - interval '1 day'") trafia do bazy jako LITERAL
// tekstowy i konczy sie bledem parsowania daty - parametr nie jest kodem.
async function wystawKlucz(
  klientId: number,
  opcje: { waznyOd?: Date; waznyDo?: Date; uniewaznionyOd?: Date; limitKlucza?: number } = {},
): Promise<WystawionyKlucz> {
  const jawny = generateApiKey('live');
  const hash = Buffer.from(pieprze.hash(jawny).hex, 'hex');
  const { rows: [r] } = await db.query<{ id: string }>(
    `INSERT INTO licencje.klucz_api
       (klient_id, srodowisko, prefiks, hash, wazny_od, wazny_do, uniewazniony_od, limit_zapytan_min)
     VALUES ($1, 'live', 'adr_live_', $2, coalesce($3, now()), $4, $5, $6) RETURNING id`,
    [klientId, hash, opcje.waznyOd ?? null, opcje.waznyDo ?? null,
      opcje.uniewaznionyOd ?? null, opcje.limitKlucza ?? null]);
  return { jawny, id: Number(r.id) };
}

const klientA = await zalozKlienta('A', 600);
const klientB = await zalozKlienta('B', 600);
const kluczA1 = await wystawKlucz(klientA);
const kluczA2 = await wystawKlucz(klientA);
const kluczB = await wystawKlucz(klientB);
const kluczWygasly = await wystawKlucz(klientA, { waznyDo: new Date(Date.now() - 86_400_000) });
const kluczUniewazniony = await wystawKlucz(klientA, { uniewaznionyOd: new Date(Date.now() - 1000) });

const klientZawieszony = await zalozKlienta('zawieszony', 600);
const kluczZawieszonego = await wystawKlucz(klientZawieszony);
await db.query(`UPDATE licencje.klient SET zawieszony_od = now() WHERE id = $1`,
  [klientZawieszony]);

function srodowisko(nadpisz: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LOG_LEVEL: 'error',
    DATABASE_URL,
    INDEX_SOURCE: artefakt,
    INDEX_POLL_MS: '0',
    API_KEY_PEPPER_1: PIEPRZ,
    API_KEY_PEPPER_AKTYWNY: '1',
    KLUCZE_ODSWIEZANIE_MS: '500',
    ...nadpisz,
  };
}

// --- 1. Tryb wylaczony: zerowa zmiana zachowania -----------------------
const wylaczony = await buildServer(loadConfig(srodowisko({ API_KEY_MODE: 'wylaczony' })));
const bezKluczaWyl = await wylaczony.inject({ url: '/v1/suggest?q=marszalkowska' });
zglos(bezKluczaWyl.statusCode === 200,
  `tryb wylaczony: zadanie bez klucza => ${bezKluczaWyl.statusCode}`);
await wylaczony.close();

// --- serwer w trybie wymaganym -----------------------------------------
const app = await buildServer(loadConfig(srodowisko({
  API_KEY_MODE: 'wymagany',
  RATE_LIMIT_NIEUWIERZYTELNIONY: '20',
})));

/** Licznik zapytan do bazy - straznik przeslanki "baza poza sciezka zadania". */
let zapytanDoBazy = 0;
const oryginalneQuery = app.pool.query.bind(app.pool);
app.pool.query = ((...a: unknown[]) => {
  zapytanDoBazy++;
  return (oryginalneQuery as (...x: unknown[]) => unknown)(...a);
}) as typeof app.pool.query;

const zKluczem = (klucz: string, url = '/v1/suggest?q=marszalkowska') =>
  app.inject({ url, headers: { 'x-api-key': klucz } });

// --- 2. Brak klucza --------------------------------------------------
const brak = await app.inject({ url: '/v1/suggest?q=marszalkowska' });
zglos(brak.statusCode === 401 && brak.json().code === 'BRAK_KLUCZA',
  `brak naglowka => ${brak.statusCode} ${brak.json().code}`);

// --- 3-4. Zly format i klucz nieznany sa NIEODROZNIALNE ---------------
//
// Roznica w komunikacie zamienia odpowiedz w wyrocznie dla zgadujacego:
// mowilaby, ktory z 10 tys. probowanych kluczy ma poprawna sume, czyli
// pochodzi z naszego generatora.
const przedFormatem = zapytanDoBazy;
const zlyFormat = await zKluczem('adr_live_to-nie-jest-klucz');
const poFormacie = zapytanDoBazy;
const nieznany = await zKluczem(generateApiKey('live'));

zglos(zlyFormat.statusCode === 401 && poFormacie === przedFormatem,
  `zly format => 401 bez ani jednego zapytania do bazy (zapytan: ${poFormacie - przedFormatem})`);
zglos(zlyFormat.body === nieznany.body && zlyFormat.statusCode === nieznany.statusCode,
  'zly format i klucz nieznany daja IDENTYCZNE cialo odpowiedzi');

// --- 5. Wazny klucz ---------------------------------------------------
const wazny = await zKluczem(kluczA1.jawny);
zglos(wazny.statusCode === 200, `wazny klucz => ${wazny.statusCode}`);

// --- 6. Klucz w query stringu jest traktowany jak jego brak -----------
//
// Query string trafia do access logu ingressu, do naglowka Referer
// i do historii przegladarki.
const wQuery = await app.inject({
  url: `/v1/suggest?q=marszalkowska&api_key=${encodeURIComponent(kluczA1.jawny)}`,
});
zglos(wQuery.statusCode === 401, `klucz w query stringu => ${wQuery.statusCode}`);

// --- 7. Trzy rozne stany, trzy rozne kody 403 ------------------------
const wygasly = await zKluczem(kluczWygasly.jawny);
const uniewazniony = await zKluczem(kluczUniewazniony.jawny);
const zawieszony = await zKluczem(kluczZawieszonego.jawny);
zglos(
  wygasly.statusCode === 403 && wygasly.json().code === 'WYGASLY' &&
  uniewazniony.statusCode === 403 && uniewazniony.json().code === 'UNIEWAZNIONY' &&
  zawieszony.statusCode === 403 && zawieszony.json().code === 'ZAWIESZONY',
  `wygasly/uniewazniony/zawieszony => ${wygasly.json().code}, ` +
  `${uniewazniony.json().code}, ${zawieszony.json().code}`);

// --- 7b. Klucz jeszcze niewazny i klucz z innego srodowiska ----------
//
// Obie kontrole powstaly po przegladzie kodu: kolumna wazny_od istniala od
// migracji 003 i NIE byla sprawdzana (klucz wystawiony "od jutra" dzialal
// od razu), a prefiks adr_test_ wobec adr_live_ byl wylacznie ozdoba -
// skrot liczymy z calego ciagu, wiec klucz testowy uwierzytelnial sie na
// instalacji produkcyjnej dokladnie tak samo jak produkcyjny.
// Klucze zakladane PO starcie serwera musza najpierw dotrzec do repliki
// (kanalem NOTIFY, typowo kilkadziesiat ms). Bez tego oczekiwania kontrola
// mierzylaby nie stan klucza, tylko szybkosc propagacji.
const doRepliki = () => new Promise((r) => setTimeout(r, 900));

const kluczPrzyszly = await wystawKlucz(klientA, {
  waznyOd: new Date(Date.now() + 86_400_000),
});
await doRepliki();
const przyszly = await zKluczem(kluczPrzyszly.jawny);
zglos(przyszly.statusCode === 403 && przyszly.json().code === 'NIEWAZNY_JESZCZE',
  `klucz wazny od jutra => ${przyszly.statusCode} ${przyszly.json().code}`);

// Klucz zapisany w rejestrze jako 'live', ale przedstawiony z prefiksem test:
// skrot jest liczony z calego ciagu, wiec musi to byc INNY ciag - budujemy go,
// podmieniajac srodowisko w rejestrze, nie w kluczu.
const kluczTestowy = await wystawKlucz(klientA);
await db.query(`UPDATE licencje.klucz_api SET srodowisko = 'test' WHERE id = $1`,
  [kluczTestowy.id]);
await doRepliki();
const zleSrodowisko = await zKluczem(kluczTestowy.jawny);
zglos(zleSrodowisko.statusCode === 401,
  `klucz adr_live_ zapisany jako 'test' => ${zleSrodowisko.statusCode} ` +
  '(nieodroznialne od klucza nieznanego)');

// --- 8. Sondy i metryki zostaja otwarte ------------------------------
//
// Kontrola ratujaca wdrozenie: gdyby /metrics dostawal 401, Prometheus
// przestalby zbierac, up{job="adres-api"} spadlby do zera i zapalilby sie
// krytyczny BrakMetrykZSerwisu - przy w pelni sprawnej usludze.
const sondy = await Promise.all(['/health', '/ready', '/metrics', '/status']
  .map((u) => app.inject({ url: u }).then((r) => `${u}:${r.statusCode}`)));
zglos(sondy.every((s) => s.endsWith(':200')), `sondy bez klucza => ${sondy.join(' ')}`);

// --- 9. Preflight CORS nie moze dostac 401 ---------------------------
const preflight = await app.inject({
  method: 'OPTIONS', url: '/v1/suggest',
  headers: { origin: 'https://przyklad.pl', 'access-control-request-method': 'GET' },
});
zglos(preflight.statusCode < 400, `preflight OPTIONS => ${preflight.statusCode}`);

// --- 10. Sondowanie nieistniejacych sciezek nie jest darmowe ---------
const czterysta = await app.inject({ url: '/nie-ma-takiej-trasy' });
const czterystaZKluczem = await zKluczem(kluczA1.jawny, '/nie-ma-takiej-trasy');
zglos(czterysta.statusCode === 401 && czterystaZKluczem.statusCode === 404,
  `nieznana sciezka: bez klucza ${czterysta.statusCode}, z waznym ${czterystaZKluczem.statusCode}`);

// --- 11. ZASADA ZELAZNA: kubelek jest per ZWERYFIKOWANY KLIENT -------
//
// Dwa klucze tego samego klienta MUSZA dzielic jeden licznik - inaczej klient
// podnosi sobie przepustowosc, wystawiajac kolejne klucze. Klucze roznych
// klientow MUSZA miec liczniki rozdzielne.
const pozostalo = (r: { headers: Record<string, unknown> }) =>
  Number(r.headers['x-ratelimit-remaining']);

const a1 = await zKluczem(kluczA1.jawny);
const a2 = await zKluczem(kluczA2.jawny);
const b1 = await zKluczem(kluczB.jawny);

zglos(pozostalo(a2) === pozostalo(a1) - 1,
  `dwa klucze klienta A dziela kubelek (pozostalo ${pozostalo(a1)} -> ${pozostalo(a2)})`);
zglos(pozostalo(b1) > pozostalo(a2),
  `klient B ma wlasny kubelek (A: ${pozostalo(a2)}, B: ${pozostalo(b1)})`);

// --- 12. Zgadywanie kluczy jest limitowane i nie dotyka bazy ---------
//
// Zadanie odrzucone w onRequest nigdy nie dochodzi do limitera trasy, wiec
// bez drugiego poziomu limitu zgadywanie byloby CALKOWICIE nielimitowane.
const przedZgadywaniem = zapytanDoBazy;
const kody: number[] = [];
for (let i = 0; i < 40; i++) {
  kody.push((await zKluczem(generateApiKey('live'))).statusCode);
}
const odrzuconeLimitem = kody.filter((k) => k === 429).length;
zglos(odrzuconeLimitem > 0 && zapytanDoBazy === przedZgadywaniem,
  `40 prob nieznanymi kluczami: ${odrzuconeLimitem} odrzuconych limitem, ` +
  `zapytan do bazy: ${zapytanDoBazy - przedZgadywaniem}`);

// --- 13. Metryki nie zdradzaja klucza ani skrotu ---------------------
const metryki = (await app.inject({ url: '/metrics' })).body;
zglos(!metryki.includes('adr_live_') && !/[0-9a-f]{64}/.test(metryki)
  && metryki.includes('adres_uwierzytelnienie_total'),
  'metryki zawieraja licznik uwierzytelnien i nie zawieraja klucza ani skrotu');

await app.close();
await db.end();
console.log(bledy === 0 ? '\nWszystkie kontrole przeszly.' : `\n${bledy} kontroli nie przeszlo.`);
process.exit(bledy === 0 ? 0 : 1);
