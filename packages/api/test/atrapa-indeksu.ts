/**
 * Atrapa artefaktu indeksu na potrzeby testow.
 *
 * PO CO TO ISTNIEJE
 *
 * buildServer() nie wstaje bez artefaktu: IndexHolder.start() czyta plik
 * wskazany przez INDEX_SOURCE i rzuca ENOENT, gdy go nie ma (loader.ts).
 * Katalog data/ jest w .gitignore, wiec w swiezo sklonowanym repozytorium
 * ani w nowym drzewie roboczym artefaktu NIE MA - a to znaczy, ze pada nie
 * jeden test, tylko kazdy, ktory buduje serwer.
 *
 * Do 9.08.2026 baseline testow opieral sie na artefakcie zbudowanym recznie
 * z pelnych danych krajowych, lezacym poza repozytorium. Skutek: zestawy
 * przechodzily wylacznie na maszynie, na ktorej ktos wczesniej uruchomil ETL,
 * a "npm test zielony przed commitem" bylo regula niesprawdzalna dla kogos
 * nowego. Atrapa zamyka te dziure - budujemy ja TYM SAMYM kodem, ktorego
 * uzywa produkcyjny ETL (buildIndex), wiec format artefaktu z definicji
 * zgadza sie z tym, co potrafi odczytac silnik.
 *
 * CZEGO ATRAPA NIE ZASTEPUJE
 *
 * Zbior wzorcowy jakosci (zadanie 6.8) opisuje pozycje w rankingu wsrod
 * 380 tys. ulic - na dwunastu dokumentach takie asercje nie znacza nic.
 * jakosc-wyszukiwania.ts wymaga pelnych danych i bazy; atrapa sluzy trzem
 * pozostalym zestawom, ktore sprawdzaja mechanike, nie jakosc wynikow.
 *
 *   node --experimental-strip-types packages/api/test/atrapa-indeksu.ts [sciezka]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
// Import wzgledny, nie przez nazwe pakietu: @adres-pl/etl nie jest zaleznoscia
// @adres-pl/api i nie ma nia byc. Test siega po narzedzie budujace swiadomie
// i widac to w kodzie, zamiast udawac, ze API zalezy od ETL.
import { buildIndex, type IndexDoc } from '../../etl/src/index-builder/build.ts';

/** Wersja danych atrapy - CELOWO inna niz jakakolwiek wersja produkcyjna. */
export const WERSJA_ATRAPY = 'atrapa-testowa';

/**
 * Dokumenty dobrane pod istniejace testy, nie pod realizm.
 *
 * Marszalkowska w Warszawie jest tu dlatego, ze odpytuje ja limit-obejscie.ts,
 * a Kosciuszki - bo alias formy potocznej jest jedyna czescia mechaniki kluczy
 * rotacyjnych, ktora daloby sie zepsuc niezauwazenie przy tak malym zbiorze.
 */
const DOKUMENTY: IndexDoc[] = [
  {
    type: 'locality', label: 'Warszawa', simc: '0918123', liczbaPunktow: 500_000,
    gmina: 'Warszawa', powiat: 'Warszawa', wojewodztwo: 'mazowieckie',
    maUlice: true, lat: 52.2297, lon: 21.0122,
  },
  {
    type: 'locality', label: 'Krakow', simc: '0950960', liczbaPunktow: 200_000,
    gmina: 'Krakow', powiat: 'Krakow', wojewodztwo: 'malopolskie',
    maUlice: true, lat: 50.0647, lon: 19.945,
  },
  {
    type: 'locality', label: 'Wolka Pelkinska', simc: '0603632', liczbaPunktow: 300,
    gmina: 'Jaroslaw', powiat: 'jaroslawski', wojewodztwo: 'podkarpackie',
    maUlice: false, lat: 50.05, lon: 22.72,
  },
  {
    type: 'street', label: 'Marszalkowska, Warszawa', simc: '0918123', ulicId: 1,
    liczbaPunktow: 900, gmina: 'Warszawa', powiat: 'Warszawa',
    wojewodztwo: 'mazowieckie', lat: 52.2297, lon: 21.0122,
  },
  {
    type: 'street', label: 'Tadeusza Kosciuszki, Krakow', simc: '0950960', ulicId: 2,
    liczbaPunktow: 400, gmina: 'Krakow', powiat: 'Krakow',
    wojewodztwo: 'malopolskie', lat: 50.0647, lon: 19.945,
    aliases: ['Kosciuszki, Krakow'],
  },
  {
    type: 'street', label: 'Skrytkowa, Warszawa', simc: '0918123', ulicId: 3,
    liczbaPunktow: 12, gmina: 'Warszawa', powiat: 'Warszawa',
    wojewodztwo: 'mazowieckie', lat: 52.24, lon: 21.02,
  },
];

/** Zwraca gotowy artefakt w pamieci. */
export function zbudujAtrapeIndeksu(wersjaDanych = WERSJA_ATRAPY): Buffer {
  return buildIndex(DOKUMENTY, wersjaDanych).buffer;
}

/** Zapisuje artefakt pod wskazana sciezke, tworzac katalogi po drodze. */
export async function zapiszAtrapeIndeksu(
  sciezka: string,
  wersjaDanych = WERSJA_ATRAPY,
): Promise<string> {
  await mkdir(dirname(sciezka), { recursive: true });
  await writeFile(sciezka, zbudujAtrapeIndeksu(wersjaDanych));
  return sciezka;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cel = process.argv[2] ?? './data/index/current.bin';
  const { buffer, stats } = buildIndex(DOKUMENTY, WERSJA_ATRAPY);
  await mkdir(dirname(cel), { recursive: true });
  await writeFile(cel, buffer);
  console.log(`Atrapa artefaktu: ${cel} (${buffer.length} B)`);
  console.log(`  dokumentow: ${stats.docs}, kluczy: ${stats.keys}, ` +
    `miejscowosci: ${stats.localities}, ulic: ${stats.streets}`);
}
