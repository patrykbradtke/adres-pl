/**
 * Slowniki zrodlowe GML - klucze sa DANA Z PLIKU GUGiK, nie naszym nazewnictwem.
 *
 * PO CO OSOBNY ZESTAW
 *
 * `mapper.ts` robi LOCALITY_KINDS[kindRaw] i OBJECT_KIND_TO_STREET_TYPE[kindRaw],
 * gdzie kindRaw pochodzi wprost z pliku. Klucz, ktory przestanie sie zgadzac ze
 * zrodlem, nie powoduje bledu - daje `undefined`, czyli puste pole. Cicho.
 *
 * Refactor nazewnictwa z 10.08.2026 przetlumaczyl DZIEWIEC takich kluczy
 * (m.in. `ulica` -> `street`, `czescMiejscowosci` -> `localityPart`). Zadna
 * z istniejacych kontroli tego nie zlapala:
 *
 *  - sprawdzanie typow zglosilo JEDEN przypadek z dziewieciu, i to tylko
 *    dlatego, ze dwa klucze przetlumaczyly sie na ten sam. Mapa jest
 *    Record<string, number>, wiec `hamlet: 3` jest poprawne typowo;
 *  - `scripts/e2e.sh` przechodzil na zielono nawet po zepsuciu `ulica`
 *    (sprawdzone doswiadczalnie). Fixture TERYT niesie CECHA w ULIC.csv
 *    i RM w SIMC.csv, a TERYT ma pierwszenstwo - wiec te pola nie pochodza
 *    wtedy ze slownika GML i przebieg ich nie dotyka.
 *
 * Stad kontrola bezposrednia: zamrozony slownik porownywany co do klucza.
 *
 * ZASADA: to jest slownik ZEWNETRZNY. Zmiana klucza jest dopuszczalna tylko
 * wtedy, gdy zmienilo sie ZRODLO - i wtedy trzeba poprawic tez ten plik,
 * swiadomie. Konwencja nazewnictwa wymienia te wartosci wprost jako zostajace
 * po polsku (docs/konwencja-nazewnictwa.md, rozdz. 1).
 *
 *   node --experimental-strip-types packages/etl/test/gml-dictionaries.ts
 */
import { LOCALITY_KINDS, OBJECT_KIND_TO_STREET_TYPE } from '../src/gml/profiles.ts';

let errors = 0;
const report = (ok: boolean, description: string) => {
  console.log(`${ok ? 'OK  ' : 'ERROR'} ${description}`);
  if (!ok) errors++;
};

/**
 * AD_RodzajMiejscowosci -> kod WMRODZ.
 * Wartosci tak, jak zapisuje je GUGiK - razem z literowka, ktora wystepuje
 * w zrodlach i ktorej NIE poprawiamy, bo plik ma prawo ja zawierac.
 */
const EXPECTED_LOCALITY_KINDS: Record<string, number> = {
  czescMiejscowosci: 0,
  czescMiejcowosci: 0,
  wies: 1,
  kolonia: 2,
  przysiolek: 3,
  osada: 4,
  osadaLesna: 5,
  osiedle: 6,
  schroniskoTurystyczne: 7,
  dzielnicaWarszawy: 95,
  miasto: 96,
  delegatura: 98,
  czescMiasta: 99,
};

/** AD_RodzajObiektu -> cecha ULIC. */
const EXPECTED_STREET_TYPES: Record<string, string> = {
  ulica: 'ul.',
  aleja: 'al.',
  plac: 'pl.',
  skwer: 'skwer',
  bulwar: 'bulw.',
  rondo: 'rondo',
  park: 'park',
  rynek: 'rynek',
  szosa: 'szosa',
  droga: 'droga',
  osiedle: 'os.',
  ogrod: 'ogr.',
  wyspa: 'wyspa',
  wybrzeze: 'wyb.',
  wawoz: 'wawoz',
  innyLiniowy: '',
  innyPowierzchniowy: '',
};

function compare(
  name: string,
  expected: Record<string, string | number>,
  actual: Record<string, string | number>,
): void {
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(actual);

  // Liczba kluczy PRZED porownaniem po nazwach: gdy dwa klucze zostana
  // przetlumaczone na ten sam, jeden przepada bezszelestnie i tylko licznik
  // to pokaze. Tak zniknal wariant z literowka `czescMiejcowosci`.
  report(
    actualKeys.length === expectedKeys.length,
    `${name}: pozycji ${actualKeys.length} (oczekiwane ${expectedKeys.length})`,
  );

  const missing = expectedKeys.filter((k) => !(k in actual));
  report(missing.length === 0,
    `${name}: brakujace klucze zrodlowe: ${missing.length ? missing.join(', ') : 'brak'}`);

  const extra = actualKeys.filter((k) => !(k in expected));
  report(extra.length === 0,
    `${name}: klucze spoza slownika zrodlowego: ${extra.length ? extra.join(', ') : 'brak'}`);

  const wrong = expectedKeys
    .filter((k) => k in actual && actual[k] !== expected[k])
    .map((k) => `${k}: ${actual[k]} zamiast ${expected[k]}`);
  report(wrong.length === 0,
    `${name}: bledne wartosci: ${wrong.length ? wrong.join('; ') : 'brak'}`);
}

console.log('--- slowniki zrodlowe GML ---');
compare('LOCALITY_KINDS', EXPECTED_LOCALITY_KINDS, LOCALITY_KINDS);
compare('OBJECT_KIND_TO_STREET_TYPE', EXPECTED_STREET_TYPES, OBJECT_KIND_TO_STREET_TYPE);

console.log(errors === 0
  ? '\nSlowniki zgodne ze zrodlem.'
  : `\n${errors} niezgodnosci. Klucz w tych mapach to wartosc z pliku GUGiK - ` +
    'jego tlumaczenie zrywa dopasowanie po cichu.');
process.exit(errors === 0 ? 0 : 1);
