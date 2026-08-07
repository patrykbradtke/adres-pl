/**
 * Mapowanie surowych feature'ow GML na rekordy do zaladowania do bazy.
 *
 * Tu mieszka cala wiedza o roznicach miedzy struktura 2012 i 2021,
 * w tym o atrybutach, ktore znikaja 1.09.2026.
 */
import { readField, readFieldAll, type RawFeature } from './parser.ts';
import { RODZAJ_MIEJSCOWOSCI, RODZAJ_OBIEKTU_CECHA } from './profiles.ts';
import { cleanText, titleCasePl, normalizeText } from '@adres-pl/core';
import { buildingNumberKey, normalizeBuildingNumber } from '@adres-pl/core';

export interface PointRecord {
  prgLocalId: string;
  wersjaId?: string;
  poczatekWersji?: string;
  /** SIMC miejscowosci - moze byc referencja do rozwiazania na etapie ladowania. */
  simcRef?: string;
  /** ULIC ulicy lub lokalnyId AD_UlicaPlac. */
  ulicRef?: string;
  nrBudynku: string;
  nrKey: string;
  kodPocztowy?: string;
  /** ZNIKA z PRG 1.09.2026 - po tej dacie zawsze undefined. */
  status?: string;
  /** ZNIKA z PRG 1.09.2026. */
  tercRef?: string;
  lon?: number;
  lat?: number;
}

export interface LocalityRecord {
  prgLocalId: string;
  wersjaId?: string;
  simc?: string;
  nazwa: string;
  nazwaNorm: string;
  rodzaj?: number;
  rodzajRaw?: string;
  tercGminy?: string;
  identyfikatorPRNG?: string;
  lon?: number;
  lat?: number;
}

export interface StreetRecord {
  prgLocalId: string;
  wersjaId?: string;
  symUl?: string;
  simcRef?: string;
  cecha?: string;
  rodzajRaw?: string;
  nazwa: string;
  nazwaNorm: string;
  /** TERYTNazwa1 / nazwaGlownaCzesc. */
  nazwa1?: string;
  /** TERYTNazwa2 / nazwaCzesc. */
  nazwa2?: string;
}

export interface MapWarning {
  featureId?: string;
  kind: string;
  reason: string;
}

export type MapResult =
  | { kind: 'point'; record: PointRecord }
  | { kind: 'locality'; record: LocalityRecord }
  | { kind: 'street'; record: StreetRecord }
  | { kind: 'skipped'; warning: MapWarning };

/**
 * Numery, ktore PRG zapisuje, a ktore nie sa realnymi adresami.
 * Filtr przejety z produkcyjnego pipeline'u gugik2osm.
 */
function isGarbageNumber(nr: string): boolean {
  const t = nr.trim();
  if (t.length === 0) return true;
  if (/,/.test(t)) return true;                 // "12, 14, 16"
  if (/\bdo\b/i.test(t)) return true;           // "12 do 18"
  if (/\d\s{2,}\d/.test(t)) return true;        // wielokrotne spacje miedzy cyframi
  if (/^b\.?\s?n\.?$/i.test(t)) return true;    // "B.N." = brak numeru
  if (/^[^0-9a-zA-Z]+$/.test(t)) return true;   // same znaki specjalne
  if (/^0+$/.test(t)) return true;
  return false;
}

export function mapFeature(f: RawFeature): MapResult {
  switch (f.kind) {
    case 'point': return mapPoint(f);
    case 'locality': return mapLocality(f);
    case 'street': return mapStreet(f);
  }
}

function mapPoint(f: RawFeature): MapResult {
  const m = f.profile.point.fields;
  const lokalnyId = readField(f, m.lokalnyId) ?? f.gmlId;
  if (!lokalnyId) {
    return { kind: 'skipped', warning: { kind: 'point', reason: 'brak lokalnyId i gml:id' } };
  }

  const nrRaw = readField(f, m.numerPorzadkowy);
  if (!nrRaw || isGarbageNumber(nrRaw)) {
    return { kind: 'skipped', warning: { featureId: lokalnyId, kind: 'point', reason: `odrzucony numer: "${nrRaw ?? ''}"` } };
  }

  const nrBudynku = normalizeBuildingNumber(cleanText(nrRaw));
  const kod = readField(f, m.kodPocztowy)?.trim();

  // jednostkaAdministracyjna wystepuje do 3x (woj/pow/gmina) - bierzemy najdluzszy
  // kod TERYT, czyli poziom gminy. W strukturze 2021 tego pola nie ma.
  const jednostki = m.jednostkaAdministracyjna ? readFieldAll(f, m.jednostkaAdministracyjna) : [];
  const tercRef = jednostki
    .filter((s) => /^\d{2,7}$/.test(s.trim()))
    .sort((a, b) => b.length - a.length)[0];

  return {
    kind: 'point',
    record: {
      prgLocalId: lokalnyId,
      wersjaId: readField(f, m.wersjaId),
      poczatekWersji: readField(f, m.poczatekWersji),
      simcRef: readField(f, m.miejscowosc),
      ulicRef: m.ulica ? readField(f, m.ulica) : undefined,
      nrBudynku,
      nrKey: buildingNumberKey(nrBudynku),
      kodPocztowy: kod && /^\d{2}-\d{3}$/.test(kod) ? kod : undefined,
      status: m.status ? readField(f, m.status) : undefined,
      tercRef,
      lon: f.lon,
      lat: f.lat,
    },
  };
}

function mapLocality(f: RawFeature): MapResult {
  const m = f.profile.locality.fields;
  const lokalnyId = readField(f, m.lokalnyId) ?? f.gmlId;
  const nazwaRaw = readField(f, m.nazwa);
  if (!lokalnyId || !nazwaRaw) {
    return { kind: 'skipped', warning: { featureId: lokalnyId, kind: 'locality', reason: 'brak lokalnyId lub nazwy' } };
  }

  const nazwa = titleCasePl(cleanText(nazwaRaw));
  const rodzajRaw = readField(f, m.rodzaj);
  // SIMC to CharacterString z wiodacymi zerami - NIE parsowac do liczby
  const simc = (m.identyfikatorSIMC ? readField(f, m.identyfikatorSIMC) : readField(f, m.idTERYT ?? []))
    ?.trim()
    .padStart(7, '0');

  return {
    kind: 'locality',
    record: {
      prgLocalId: lokalnyId,
      wersjaId: readField(f, m.wersjaId ?? []),
      simc: simc && /^\d{7}$/.test(simc) ? simc : undefined,
      nazwa,
      nazwaNorm: normalizeText(nazwa),
      rodzaj: rodzajRaw ? RODZAJ_MIEJSCOWOSCI[rodzajRaw] : undefined,
      rodzajRaw,
      tercGminy: m.tercGminy ? readField(f, m.tercGminy)?.trim().padStart(7, '0') : undefined,
      identyfikatorPRNG: m.identyfikatorPRNG ? readField(f, m.identyfikatorPRNG) : undefined,
      lon: f.lon,
      lat: f.lat,
    },
  };
}

function mapStreet(f: RawFeature): MapResult {
  const m = f.profile.street.fields;
  const lokalnyId = readField(f, m.lokalnyId) ?? f.gmlId;
  // 2021: nazwaPelna, 2012: nazwa
  const nazwaRaw = readField(f, m.nazwaPelna ?? m.nazwa ?? []);
  if (!lokalnyId || !nazwaRaw) {
    return { kind: 'skipped', warning: { featureId: lokalnyId, kind: 'street', reason: 'brak lokalnyId lub nazwy' } };
  }

  const rodzajRaw = readField(f, m.rodzaj ?? m.typ ?? []);
  // 2012 mial osobne pole przedrostek1Czesc/przedrostek2Czesc; 2021 juz nie
  const przedrostek = m.przedrostek ? readField(f, m.przedrostek) : undefined;
  const cecha = rodzajRaw ? RODZAJ_OBIEKTU_CECHA[rodzajRaw] : undefined;

  const nazwaClean = titleCasePl(cleanText(nazwaRaw));
  const symUl = (m.identyfikatorULIC ? readField(f, m.identyfikatorULIC) : readField(f, m.idTERYT ?? []))
    ?.trim()
    .padStart(5, '0');

  return {
    kind: 'street',
    record: {
      prgLocalId: lokalnyId,
      wersjaId: readField(f, m.wersjaId ?? []),
      symUl: symUl && /^\d{5}$/.test(symUl) ? symUl : undefined,
      simcRef: m.miejscowosc ? readField(f, m.miejscowosc) : undefined,
      cecha: cecha || przedrostek || undefined,
      rodzajRaw,
      nazwa: nazwaClean,
      nazwaNorm: normalizeText(nazwaClean),
      nazwa1: m.terytNazwa1 ? readField(f, m.terytNazwa1) : readField(f, m.nazwaGlownaCzesc ?? []),
      nazwa2: m.terytNazwa2 ? readField(f, m.terytNazwa2) : readField(f, m.nazwaCzesc ?? []),
    },
  };
}
