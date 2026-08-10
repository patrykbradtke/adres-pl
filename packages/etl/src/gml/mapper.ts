/**
 * Mapowanie surowych feature'ow GML na rekordy do zaladowania do bazy.
 *
 * Tu mieszka cala wiedza o roznicach miedzy struktura 2012 i 2021,
 * w tym o atrybutach, ktore znikaja 1.09.2026.
 */
import { readField, readFieldAll, type RawFeature } from './parser.ts';
import { LOCALITY_KINDS, OBJECT_KIND_TO_STREET_TYPE } from './profiles.ts';
import { cleanText, titleCasePl, normalizeText } from '@adres-pl/core';
import { buildingNumberKey, normalizeBuildingNumber } from '@adres-pl/core';

export interface PointRecord {
  prgLocalId: string;
  versionId?: string;
  versionStart?: string;
  /** SIMC miejscowosci - moze byc referencja do rozwiazania na etapie ladowania. */
  simcRef?: string;
  /** ULIC ulicy lub lokalnyId AD_UlicaPlac. */
  ulicRef?: string;
  buildingNumber: string;
  buildingNumberKey: string;
  postalCode?: string;
  /** ZNIKA z PRG 1.09.2026 - po tej dacie zawsze undefined. */
  status?: string;
  /** ZNIKA z PRG 1.09.2026. */
  tercRef?: string;
  lon?: number;
  lat?: number;
}

export interface LocalityRecord {
  prgLocalId: string;
  versionId?: string;
  simc?: string;
  name: string;
  nameNorm: string;
  kind?: number;
  kindRaw?: string;
  gminaTerc?: string;
  prngId?: string;
  lon?: number;
  lat?: number;
}

export interface StreetRecord {
  prgLocalId: string;
  versionId?: string;
  symUl?: string;
  simcRef?: string;
  streetType?: string;
  kindRaw?: string;
  name: string;
  nameNorm: string;
  /** TERYTNazwa1 / nazwaGlownaCzesc. */
  name1?: string;
  /** TERYTNazwa2 / nazwaCzesc. */
  name2?: string;
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
  const localId = readField(f, m.localId) ?? f.gmlId;
  if (!localId) {
    return { kind: 'skipped', warning: { kind: 'point', reason: 'brak lokalnyId i gml:id' } };
  }

  const nrRaw = readField(f, m.buildingNumber);
  if (!nrRaw || isGarbageNumber(nrRaw)) {
    return { kind: 'skipped', warning: { featureId: localId, kind: 'point', reason: `odrzucony numer: "${nrRaw ?? ''}"` } };
  }

  const buildingNumber = normalizeBuildingNumber(cleanText(nrRaw));
  const code = readField(f, m.postalCode)?.trim();

  // jednostkaAdministracyjna wystepuje do 3x (woj/pow/gmina) - bierzemy najdluzszy
  // kod TERYT, czyli poziom gminy. W strukturze 2021 tego pola nie ma.
  const units = m.adminUnit ? readFieldAll(f, m.adminUnit) : [];
  const tercRef = units
    .filter((s) => /^\d{2,7}$/.test(s.trim()))
    .sort((a, b) => b.length - a.length)[0];

  return {
    kind: 'point',
    record: {
      prgLocalId: localId,
      versionId: readField(f, m.versionId),
      versionStart: readField(f, m.versionStart),
      simcRef: readField(f, m.locality),
      ulicRef: m.street ? readField(f, m.street) : undefined,
      buildingNumber,
      buildingNumberKey: buildingNumberKey(buildingNumber),
      postalCode: code && /^\d{2}-\d{3}$/.test(code) ? code : undefined,
      status: m.status ? readField(f, m.status) : undefined,
      tercRef,
      lon: f.lon,
      lat: f.lat,
    },
  };
}

function mapLocality(f: RawFeature): MapResult {
  const m = f.profile.locality.fields;
  const localId = readField(f, m.localId) ?? f.gmlId;
  const nameRaw = readField(f, m.name);
  if (!localId || !nameRaw) {
    return { kind: 'skipped', warning: { featureId: localId, kind: 'locality', reason: 'brak lokalnyId lub nazwy' } };
  }

  const name = titleCasePl(cleanText(nameRaw));
  const kindRaw = readField(f, m.kind);
  // SIMC to CharacterString z wiodacymi zerami - NIE parsowac do liczby
  const simc = (m.identyfikatorSIMC ? readField(f, m.identyfikatorSIMC) : readField(f, m.idTERYT ?? []))
    ?.trim()
    .padStart(7, '0');

  return {
    kind: 'locality',
    record: {
      prgLocalId: localId,
      versionId: readField(f, m.versionId ?? []),
      simc: simc && /^\d{7}$/.test(simc) ? simc : undefined,
      name,
      nameNorm: normalizeText(name),
      kind: kindRaw ? LOCALITY_KINDS[kindRaw] : undefined,
      kindRaw,
      gminaTerc: m.gminaTerc ? readField(f, m.gminaTerc)?.trim().padStart(7, '0') : undefined,
      prngId: m.prngId ? readField(f, m.prngId) : undefined,
      lon: f.lon,
      lat: f.lat,
    },
  };
}

function mapStreet(f: RawFeature): MapResult {
  const m = f.profile.street.fields;
  const localId = readField(f, m.localId) ?? f.gmlId;
  // 2021: nazwaPelna, 2012: nazwa
  const nameRaw = readField(f, m.fullName ?? m.name ?? []);
  if (!localId || !nameRaw) {
    return { kind: 'skipped', warning: { featureId: localId, kind: 'street', reason: 'brak lokalnyId lub nazwy' } };
  }

  const kindRaw = readField(f, m.kind ?? m.typ ?? []);
  // 2012 mial osobne pole przedrostek1Czesc/przedrostek2Czesc; 2021 juz nie
  const streetTypePrefix = m.streetTypePrefix ? readField(f, m.streetTypePrefix) : undefined;
  const streetType = kindRaw ? OBJECT_KIND_TO_STREET_TYPE[kindRaw] : undefined;

  const nameClean = titleCasePl(cleanText(nameRaw));
  const symUl = (m.identyfikatorULIC ? readField(f, m.identyfikatorULIC) : readField(f, m.idTERYT ?? []))
    ?.trim()
    .padStart(5, '0');

  return {
    kind: 'street',
    record: {
      prgLocalId: localId,
      versionId: readField(f, m.versionId ?? []),
      symUl: symUl && /^\d{5}$/.test(symUl) ? symUl : undefined,
      simcRef: m.locality ? readField(f, m.locality) : undefined,
      streetType: streetType || streetTypePrefix || undefined,
      kindRaw,
      name: nameClean,
      nameNorm: normalizeText(nameClean),
      name1: m.terytName1 ? readField(f, m.terytName1) : readField(f, m.mainNamePart ?? []),
      name2: m.terytName2 ? readField(f, m.terytName2) : readField(f, m.namePart ?? []),
    },
  };
}
