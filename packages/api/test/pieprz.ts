/**
 * Pieprz i skroty kluczy API (zadanie 8.3).
 *
 * Bez serwera, bez bazy, bez artefaktu - druga po tescie core pozycja
 * lancucha npm test.
 *
 * ODWROCENIA - kazde wykonane i sprawdzone:
 *   - zamien sekret w createHmac na stala             -> kontrole 2, 3 i 6
 *   - spraw, by hashAll liczyl tylko wersja aktywna   -> kontrola 3
 *   - usun straznik wersji aktywnej z konstruktora    -> kontrola 5
 *   - usun z hashesEqual porownanie dlugosci          -> kontrola 6
 *
 * Uwaga do kontroli 5: usuniecie samego straznika PUSTEGO ZESTAWU jej nie
 * czerwieni, bo pusta mape lapie potem warunek wersji aktywnej (has() na
 * pustej mapie jest falszem). Straznik pustego zestawu zostaje mimo to -
 * daje komunikat mowiacy, co jest nie tak, zamiast mylacego "wersja aktywna
 * nie ma sekretu" przy braku jakiejkolwiek konfiguracji.
 *
 *   node --experimental-strip-types packages/api/test/pieprz.ts
 */
import { Peppers, peppersFromEnv, newPepperSecret, hashesEqual } from '../src/keys/pepper.ts';
import { generateApiKey } from '@adres-pl/core';

let bledy = 0;
const zglos = (ok: boolean, opis: string) => {
  console.log(`${ok ? 'OK  ' : 'BLAD'} ${opis}`);
  if (!ok) bledy++;
};

const P1 = 'pieprz-testowy-jeden';
const P2 = 'pieprz-testowy-dwa';
const zestaw = new Peppers(new Map([[1, P1], [2, P2]]), 2);
const klucz = generateApiKey('live');

// --- 1. Determinizm -----------------------------------------------------
// Bez tego kolumna ze skrotem nie moglaby byc kluczem wyszukiwania.
const a = zestaw.hash(klucz);
const b = zestaw.hash(klucz);
zglos(a.hex === b.hex && a.hex.length === 64 && a.version === 2,
  `skrot deterministyczny, 64 znaki hex, wersja aktywna ${a.version}`);

// --- 2. Pieprz naprawde uczestniczy w skrocie --------------------------
//
// Straznik calego uzasadnienia pieprza: gdyby skrot go nie uwzglednial,
// zrzut bazy dalby sie rozwiazac tablica teczowa dla przestrzeni prefiksu,
// a rotacja pieprza nie zmienialaby niczego.
const inny = new Peppers(new Map([[1, 'zupelnie-inny-pieprz']]), 1);
zglos(inny.hash(klucz).hex !== zestaw.hash(klucz, 1).hex,
  'zmiana pieprza zmienia skrot tego samego klucza');

// --- 3. Wszystkie wersje naraz -----------------------------------------
// Warunek rotacji bezprzerwowej: klucz policzony starym pieprzem musi byc
// nadal odnajdywany, dopoki stara wersja jest w konfiguracji.
const wszystkie = zestaw.hashAll(klucz);
const wersje = wszystkie.map((h) => h.version).join(',');
zglos(wszystkie.length === 2 && wersje === '1,2'
  && wszystkie[0].hex !== wszystkie[1].hex,
  `hashAll liczy skrot kazda wersja (${wersje}), skroty rozne`);

// --- 4. Odcisk pozwala porownac instancje, nie ujawniajac sekretu ------
const odciski = zestaw.fingerprint();
const odciskiInnego = inny.fingerprint();
const zawieraSekret = JSON.stringify(odciski).includes(P1) || JSON.stringify(odciski).includes(P2);
zglos(odciski.length === 2 && !zawieraSekret
  && odciski[0].odcisk !== odciskiInnego[0].odcisk,
  'odcisk rozroznia zestawy i nie zawiera sekretu');

// --- 5. Konfiguracja niespojna jest odrzucana przy budowie -------------
//
// Wersja aktywna bez sekretu to stan, w ktorym serwis dziala i odrzuca
// wszystkie nowe klucze - lepiej nie wstac.
let rzucilPusty = false;
let rzucilBrakAktywnej = false;
try { new Peppers(new Map(), 1); } catch { rzucilPusty = true; }
try { new Peppers(new Map([[1, P1]]), 7); } catch { rzucilBrakAktywnej = true; }
zglos(rzucilPusty && rzucilBrakAktywnej,
  'pusty zestaw i wersja aktywna bez sekretu odrzucone przy budowie');

// --- 6. Porownanie skrotow ---------------------------------------------
//
// Straznik przed kodem 500 sterowanym przez klienta: timingSafeEqual rzuca
// RangeError przy roznych dlugosciach, wiec hashesEqual musi sprawdzic
// dlugosc SAM, zanim do niego siegnie.
let rzuciloNaRoznych = false;
try {
  hashesEqual(a.hex, a.hex.slice(0, 10));
} catch { rzuciloNaRoznych = true; }
zglos(hashesEqual(a.hex, b.hex)
  && !hashesEqual(a.hex, inny.hash(klucz).hex)
  && !rzuciloNaRoznych,
  'porownanie skrotow: rowne, rozne, oraz rozne dlugosci bez wyjatku');

// --- 7. Odczyt ze srodowiska -------------------------------------------
const zEnv = peppersFromEnv({
  API_KEY_PEPPER_1: 'a', API_KEY_PEPPER_3: 'c', API_KEY_PEPPER_AKTYWNY: '3',
} as NodeJS.ProcessEnv);
const bezAktywnej = peppersFromEnv({
  API_KEY_PEPPER_1: 'a', API_KEY_PEPPER_5: 'e',
} as NodeJS.ProcessEnv);
const pusty = peppersFromEnv({} as NodeJS.ProcessEnv);
zglos(zEnv?.activeVersion === 3 && zEnv?.versions.join(',') === '1,3'
  && bezAktywnej?.activeVersion === 5
  && pusty === null,
  'odczyt ze srodowiska: wersja aktywna, domyslka na najwyzsza, brak pieprza to null');

// --- 8. Generator sekretow ---------------------------------------------
const sekrety = new Set(Array.from({ length: 1000 }, () => newPepperSecret()));
zglos(sekrety.size === 1000 && [...sekrety][0].length >= 43,
  `1000 sekretow pieprza, wszystkie rozne, dlugosc ${[...sekrety][0].length}`);

console.log(bledy === 0 ? '\nWszystkie kontrole przeszly.' : `\n${bledy} kontroli nie przeszlo.`);
process.exit(bledy === 0 ? 0 : 1);
