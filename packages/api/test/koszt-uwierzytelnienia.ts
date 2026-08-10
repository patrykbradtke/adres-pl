/**
 * Mikropomiar sciezki weryfikacji klucza (zadanie 8.8b).
 *
 * BEZ SERWERA, BEZ BAZY, BEZ ARTEFAKTU - dziala wszedzie i w sekundy, wiec
 * moze stac w npm test. Pelny pomiar HTTP (npm run bench) trwa kilkanascie
 * minut i jest bramka przed wdrozeniem, nie przed commitem.
 *
 * CO TEN ZESTAW MA ZLAPAC
 *
 * Regresje klasy "ktos wstawil zapytanie do bazy na goraca sciezke". Taka
 * zmiana nie przewraca zadnego testu funkcjonalnego - wszystko dziala, tylko
 * kazde zadanie kosztuje o rzad wielkosci wiecej.
 *
 * DLACZEGO PROG JEST BEZWZGLEDNY, MIMO ZE ZALEZY OD MASZYNY
 *
 * Pierwsza wersja tego zestawu porownywala pelna weryfikacje ze sciezka
 * odniesienia (samym rozborem klucza), zeby prog byl niezalezny od maszyny.
 * Pomiar to obalil: rozbior kosztuje 1-5 us i sam waha sie piecikrotnie miedzy
 * przebiegami, wiec krotnosc skakala od 10x do 46x. Kotwica okazala sie za mala,
 * zeby cokolwiek na niej oprzec - prog wzgledny bylby losowy.
 *
 * Koszt bezwzgledny jest za to stabilny: 50-52 us na wywolanie w kolejnych
 * przebiegach. Prog 150 us zostawia trzykrotny zapas na wolniejsza maszyne,
 * a wciaz lapie to, co ma zlapac: obieg do bazy albo do Redisa kosztuje
 * 200-1000 us, czyli rzad wielkosci wiecej.
 *
 * Zgodnosc dwoch niezaleznych pomiarow: ten mikropomiar daje ~50 us, a pomiar
 * przez pelna sciezke HTTP (npm run bench) pokazuje delte p50 rzedu 0,048 ms.
 * To ta sama liczba zmierzona dwoma sposobami.
 *
 * ODWROCENIA - kazde wykonane i sprawdzone:
 *   - wstaw sztuczne opoznienie w Peppers.hash          -> kontrola 2
 *   - zamien wyszukanie w mapie na petle po wszystkich  -> kontrola 2
 *
 *   node --experimental-strip-types packages/api/test/koszt-uwierzytelnienia.ts
 */
import { generateApiKey, parseApiKey } from '@adres-pl/core';
import { Peppers } from '../src/keys/pepper.ts';

const N = 100_000;
/**
 * Gorna granica kosztu sciezki weryfikacji, w mikrosekundach na wywolanie.
 * Zmierzone: 50-52 us. Prog zostawia trzykrotny zapas na wolniejsza maszyne,
 * a obieg do bazy (200-1000 us) i tak go przekroczy.
 */
const PROG_US = 150;

let bledy = 0;
const zglos = (ok: boolean, opis: string) => {
  console.log(`${ok ? 'OK  ' : 'BLAD'} ${opis}`);
  if (!ok) bledy++;
};

const pieprze = new Peppers(new Map([[1, 'pieprz-mikropomiaru']]), 1);
const klucze = Array.from({ length: 1000 }, () => generateApiKey('live'));

// Replika w postaci, w jakiej uzywa jej hook: mapa hex -> wpis.
const replika = new Map<string, { kluczId: number }>();
klucze.forEach((k, i) => replika.set(pieprze.hash(k).hex, { kluczId: i }));

function mierz(nazwa: string, praca: (klucz: string) => unknown): number {
  // Rozgrzewka poza pomiarem - pierwsze wywolania sa rzedy wielkosci wolniejsze.
  for (let i = 0; i < 5_000; i++) praca(klucze[i % klucze.length]);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) praca(klucze[i % klucze.length]);
  const us = Number(process.hrtime.bigint() - t0) / 1000 / N;
  console.log(`   ${nazwa.padEnd(28)} ${us.toFixed(3)} us/wywolanie`);
  return us;
}

const odniesienie = mierz('rozbior klucza (czysty TS)', (k) => parseApiKey(k));
const pelna = mierz('pelna weryfikacja', (k) => {
  if (!parseApiKey(k)) return undefined;
  for (const { hex } of pieprze.hashAll(k)) {
    const wpis = replika.get(hex);
    if (wpis) return wpis;
  }
  return undefined;
});

// --- 1. Sciezka weryfikacji faktycznie cos znajduje -------------------
//
// Bez tej kontroli pomiar moglby mierzyc szybka sciezke bledu i wygladac
// swietnie, nie robiac tego, co ma.
const trafienia = klucze.filter((k) => {
  for (const { hex } of pieprze.hashAll(k)) if (replika.has(hex)) return true;
  return false;
}).length;
zglos(trafienia === klucze.length,
  `sciezka weryfikacji odnajduje ${trafienia} z ${klucze.length} kluczy`);

// --- 2. Koszt sciezki weryfikacji ------------------------------------
zglos(pelna <= PROG_US,
  `pelna weryfikacja ${pelna.toFixed(1)} us/wywolanie (prog ${PROG_US} us)`);

// --- 3. Krotnosc wobec rozbioru - INFORMACYJNIE, bez progu -----------
//
// Zostaje w wydruku, bo pokazuje strukture kosztu (kryptografia wobec czystego
// TypeScriptu), ale NIE jest asercja: wartosc odniesienia jest zbyt mala
// i zbyt zmienna, zeby cokolwiek na niej oprzec.
console.log(`   krotnosc wobec rozbioru      ${(pelna / odniesienie).toFixed(1)}x (informacyjnie)`);

console.log(bledy === 0 ? '\nWszystkie kontrole przeszly.' : `\n${bledy} kontroli nie przeszlo.`);
process.exit(bledy === 0 ? 0 : 1);
