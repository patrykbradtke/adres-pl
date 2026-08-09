/**
 * Test regresji dla podmiany artefaktu indeksu.
 *
 * Do 9.08.2026 loader porownywal wersje danych ("2026-08-06") z nazwa pliku
 * ze wskaznika ("idx-2026-08-06.bin"). Te wartosci nie moga byc rowne, wiec
 * warunek "nic sie nie zmienilo" nie zatrzymywal niczego: instancja czytala
 * i parsowala caly artefakt przy kazdym odpytaniu wskaznika - przy 109 MB
 * i domyslnym cyklu 60 s oznaczalo to stala, bezproduktywna prace.
 *
 * Test sprawdza obie strony: brak przeladowania bez zmiany oraz przeladowanie
 * po realnej zmianie wskaznika.
 *
 *   node --experimental-strip-types packages/api/test/loader-podmiana.ts
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHeader } from '@adres-pl/index-format';
import { IndexHolder } from '../src/search/loader.ts';
import { zbudujAtrapeIndeksu } from './atrapa-indeksu.ts';

let bledy = 0;
const zglos = (ok: boolean, opis: string) => {
  console.log(`${ok ? 'OK  ' : 'BLAD'} ${opis}`);
  if (!ok) bledy++;
};

const kat = await mkdtemp(join(tmpdir(), 'adres-loader-'));

// Domyslnie atrapa - test sprawdza logike wskaznika, a nie jakosc danych,
// wiec nie ma powodu, zeby wymagal artefaktu z pelnego przebiegu ETL.
// ARTEFAKT pozwala puscic te sama mechanike na artefakcie produkcyjnym.
const bin = process.env.ARTEFAKT ? readFileSync(process.env.ARTEFAKT) : zbudujAtrapeIndeksu();
await writeFile(join(kat, 'idx-A.bin'), bin);
await writeFile(join(kat, 'idx-B.bin'), bin);

// Wersje danych bierzemy Z ARTEFAKTU, nie ze stalej.
//
// Wczesniej bylo tu wpisane '2026-08-06'. Loader porownuje dataVersion ze
// wskaznika z wersja ZALADOWANEGO artefaktu, wiec przy artefakcie o innej
// wersji warunek "nic sie nie zmienilo" nie moze byc nigdy spelniony
// i kontrola 1 czerwieni sie z powodu niezwiazanego z badana logika.
// Stala robila z tego testu narzedzie dzialajace dla jednego pliku na jednej
// maszynie - czyli dokladnie ten rodzaj zaleznosci, ktory ten test tropi.
const WERSJA_DANYCH = readHeader(bin).dataVersion;

const wskaznik = join(kat, 'current.json');
const ustawWskaznik = (plik: string, wersja: string) =>
  writeFile(wskaznik, JSON.stringify({ current: plik, dataVersion: wersja }));

let podmiany = 0;
await ustawWskaznik('idx-A.bin', WERSJA_DANYCH);

const holder = new IndexHolder({
  source: join(kat, 'idx-A.bin'),
  pointer: wskaznik,
  pollIntervalMs: 0,                    // odpytujemy recznie, bez czekania
  onSwap: () => { podmiany++; },
  onError: (e) => { console.log('   blad loadera:', e.message); },
});

await holder.start();
zglos(podmiany === 1, `start laduje artefakt (podmian: ${podmiany})`);
zglos(holder.ready, 'indeks zgloszony jako gotowy');

// checkPointer jest prywatne - siegamy po nie tak, jak robi to timer.
const sprawdz = () => (holder as unknown as { checkPointer(): Promise<void> }).checkPointer();

// 1. Wskaznik bez zmian - piec odpytan nie moze nic przeladowac.
for (let i = 0; i < 5; i++) await sprawdz();
zglos(podmiany === 1, `piec odpytan bez zmiany wskaznika nie przeladowalo artefaktu (podmian: ${podmiany})`);

// 2. Zmiana pliku przy tej samej wersji danych - przeladowanie MA nastapic.
await ustawWskaznik('idx-B.bin', WERSJA_DANYCH);
await sprawdz();
zglos(podmiany === 2, `zmiana pliku we wskazniku przeladowala artefakt (podmian: ${podmiany})`);

// 3. Po podmianie znowu cisza.
for (let i = 0; i < 3; i++) await sprawdz();
zglos(podmiany === 2, `po podmianie kolejne odpytania sa bezczynne (podmian: ${podmiany})`);

holder.stop();
await rm(kat, { recursive: true, force: true });

console.log(bledy === 0 ? '\nWszystkie kontrole przeszly.' : `\n${bledy} kontroli nie przeszlo.`);
process.exit(bledy === 0 ? 0 : 1);
