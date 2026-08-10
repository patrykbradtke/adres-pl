/**
 * Limity per klient i kwota miesieczna (zadanie 8.5).
 *
 * WYMAGA BAZY z migracja 004_licencje.sql.
 *
 * Zestaw pilnuje rozroznienia, ktore plan produkcyjny sklein w jedno zdanie
 * ("limity i kwoty per klient, magazyn wspoldzielony"):
 *   LIMIT NA MINUTE - ochrona przed przeciazeniem, licznik LOKALNY,
 *   KWOTA MIESIECZNA - podstawa faktury, wspoldzielona przez Postgresa.
 *
 * ODWROCENIA - kazde wykonane i sprawdzone:
 *   - cofnij `max` do stalej cfg.rateLimitMax        -> kontrole 1 i 2
 *   - zamien Math.min na `klucz ?? klient`           -> kontrola 2 (druga czesc)
 *   - policz wsad jako 1 jednostke zamiast items.length -> kontrole 3 i 4
 *   - pomin lokalne niezrzucone jednostki w kontroli kwoty -> kontrola 4
 *
 *   node --experimental-strip-types packages/api/test/kwoty.ts
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { generateApiKey } from '@adres-pl/core';
import { buildServer, loadConfig } from '../src/server.ts';
import { Peppers } from '../src/keys/pepper.ts';
import { zapiszAtrapeIndeksu } from './atrapa-indeksu.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://adres:adres@localhost:5432/adres';
const PIEPRZ = 'pieprz-kwoty-8.5';
const pieprze = new Peppers(new Map([[1, PIEPRZ]]), 1);

let bledy = 0;
const zglos = (ok: boolean, opis: string) => {
  console.log(`${ok ? 'OK  ' : 'BLAD'} ${opis}`);
  if (!ok) bledy++;
};

const artefakt = await zapiszAtrapeIndeksu(
  join(await mkdtemp(join(tmpdir(), 'adres-kwoty-')), 'current.bin'));

const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
const stempel = `kwoty-8a-${Date.now()}`;

async function zalozKlienta(
  nazwa: string, limitMin: number, kwota: number | null = null,
): Promise<number> {
  const { rows: [r] } = await db.query<{ id: string }>(
    `INSERT INTO licencje.klient (nazwa, pakiet, limit_zapytan_min, kwota_miesieczna)
     VALUES ($1, 'test', $2, $3) RETURNING id`, [`${stempel}-${nazwa}`, limitMin, kwota]);
  return Number(r.id);
}

async function wystawKlucz(klientId: number, limitKlucza: number | null = null): Promise<string> {
  const jawny = generateApiKey('live');
  await db.query(
    `INSERT INTO licencje.klucz_api (klient_id, srodowisko, prefiks, hash, limit_zapytan_min)
     VALUES ($1, 'live', 'adr_live_', $2, $3)`,
    [klientId, Buffer.from(pieprze.hash(jawny).hex, 'hex'), limitKlucza]);
  return jawny;
}

const klientMaly = await zalozKlienta('maly', 3);
const klientDuzy = await zalozKlienta('duzy', 10);
const kluczMaly = await wystawKlucz(klientMaly);
const kluczDuzy = await wystawKlucz(klientDuzy);

const klientZLimitem = await zalozKlienta('zlimitem', 600);
const kluczOgraniczony = await wystawKlucz(klientZLimitem, 1);
const kluczRozdmuchany = await wystawKlucz(klientZLimitem, 10_000);

const klientZKwota = await zalozKlienta('zkwota', 600, 10);
const kluczKwotowy = await wystawKlucz(klientZKwota);

function srodowisko(nadpisz: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LOG_LEVEL: 'error',
    DATABASE_URL,
    INDEX_SOURCE: artefakt,
    INDEX_POLL_MS: '0',
    API_KEY_MODE: 'wymagany',
    API_KEY_PEPPER_1: PIEPRZ,
    API_KEY_PEPPER_AKTYWNY: '1',
    KLUCZE_ODSWIEZANIE_MS: '400',
    // Zrzut wyzwalamy w tescie recznie - inaczej kontrola 5 czekalaby minute.
    ZUZYCIE_FLUSH_MS: '0',
    ...nadpisz,
  };
}

const app = await buildServer(loadConfig(srodowisko()));
const strzel = (klucz: string) =>
  app.inject({ url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': klucz } });

// --- 1. Limit jest PER KLIENT, nie per adres --------------------------
//
// Oba zadania ida z tego samego adresu. Gdyby limit byl liczony po adresie,
// klient z wyzszym pakietem dostawalby odmowe przez sasiada.
const kodyMalego: number[] = [];
for (let i = 0; i < 5; i++) kodyMalego.push((await strzel(kluczMaly)).statusCode);
const duzyPoTym = await strzel(kluczDuzy);
zglos(kodyMalego.filter((k) => k === 200).length === 3
  && kodyMalego.filter((k) => k === 429).length === 2
  && duzyPoTym.statusCode === 200,
  `klient z limitem 3: ${kodyMalego.join(' ')}; klient z limitem 10 z tego samego ` +
  `adresu: ${duzyPoTym.statusCode}`);

// --- 2. Limit na kluczu moze wartosc klienta tylko OBNIZYC ------------
//
// Inaczej klient podnosilby sobie przepustowosc, wystawiajac klucz z wyzszym
// limitem - a limit z umowy przestalby cokolwiek znaczyc.
const kodyOgraniczonego: number[] = [];
for (let i = 0; i < 3; i++) kodyOgraniczonego.push((await strzel(kluczOgraniczony)).statusCode);

const pozostalo = (r: { headers: Record<string, unknown> }) =>
  Number(r.headers['x-ratelimit-limit']);
const rozdmuchany = await strzel(kluczRozdmuchany);

zglos(kodyOgraniczonego[0] === 200 && kodyOgraniczonego[1] === 429,
  `klucz z limitem 1 przy kliencie 600: ${kodyOgraniczonego.join(' ')}`);
zglos(pozostalo(rozdmuchany) === 600,
  `klucz z limitem 10000 przy kliencie 600 daje limit ${pozostalo(rozdmuchany)} (Math.min)`);

// --- 3. Wsad liczy POZYCJE, nie zadania -------------------------------
//
// Decyzji nie da sie dolozyc pozniej bez zmiany umow: wsad przyjmuje do 1000
// pozycji, wiec klient rozliczany w zadaniach obchodzi kwote, pakujac tysiac
// adresow w jedno zapytanie.
const klientWsadowy = await zalozKlienta('wsadowy', 600, 1000);
const kluczWsadowy = await wystawKlucz(klientWsadowy);
await new Promise((r) => setTimeout(r, 700));

await app.inject({
  method: 'POST', url: '/v1/batch',
  headers: { 'x-api-key': kluczWsadowy, 'content-type': 'application/json' },
  payload: { items: [{ raw: 'a' }, { raw: 'b' }, { raw: 'c' }, { raw: 'd' }, { raw: 'e' }] },
});
await app.zuzycie.flush();

const { rows: [wsad] } = await db.query<{ zapytan: string; jednostek: string }>(
  `SELECT sum(z.zapytan)::text AS zapytan, sum(z.jednostek)::text AS jednostek
     FROM licencje.zuzycie z JOIN licencje.klucz_api k ON k.id = z.klucz_id
    WHERE k.klient_id = $1`, [klientWsadowy]);
zglos(wsad.zapytan === '1' && wsad.jednostek === '5',
  `wsad z 5 pozycjami: zapytan ${wsad.zapytan}, jednostek ${wsad.jednostek}`);

// --- 4. Kwota wyczerpana -> 429 z wlasnym kodem -----------------------
//
// Liczona jako stan z bazy PLUS jednostki jeszcze niezrzucone: sam odczyt
// z repliki pokazywalby zuzycie sprzed calego okna zrzutu.
const kodyKwotowe: number[] = [];
for (let i = 0; i < 13; i++) kodyKwotowe.push((await strzel(kluczKwotowy)).statusCode);
const ostatnia = await strzel(kluczKwotowy);
const cialo = ostatnia.json() as { code?: string };
zglos(kodyKwotowe.filter((k) => k === 200).length === 10
  && ostatnia.statusCode === 429 && cialo.code === 'KWOTA_WYCZERPANA',
  `kwota 10 jednostek: przeszlo ${kodyKwotowe.filter((k) => k === 200).length}, ` +
  `potem ${ostatnia.statusCode} ${cialo.code}`);

// --- 5. Kwota jest WSPOLDZIELONA miedzy instancjami -------------------
//
// To jest ta czesc, ktora naprawde musi isc przez baze. Druga instancja ma
// wlasny, pusty licznik lokalny - jesli mimo to odmawia, znaczy ze zobaczyla
// zuzycie zapisane przez pierwsza.
await app.zuzycie.flush();
const druga = await buildServer(loadConfig(srodowisko()));
await druga.rejestr.odswiez(true);
const naDrugiej = await druga.inject({
  url: '/v1/suggest?q=marszalkowska', headers: { 'x-api-key': kluczKwotowy } });
zglos(naDrugiej.statusCode === 429,
  `druga instancja widzi zuzycie pierwszej i odmawia: ${naDrugiej.statusCode}`);
await druga.close();

await app.close();
await db.end();
console.log(bledy === 0 ? '\nWszystkie kontrole przeszly.' : `\n${bledy} kontroli nie przeszlo.`);
process.exit(bledy === 0 ? 0 : 1);
