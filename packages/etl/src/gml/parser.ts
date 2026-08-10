/**
 * Strumieniowy parser GML dla danych adresowych PRG.
 *
 * WYMAGANIA:
 *  - pliki wojewodzkie maja ~1,2 GB po rozpakowaniu (calosc ~20 GB),
 *    wiec parser MUSI byc strumieniowy i o stalym zuzyciu pamieci
 *  - musi dzialac dla struktury 2012 i 2021 bez przebudowy
 *  - musi przezyc nieznany namespace (dopasowanie po local name)
 *
 * Referencja wydajnosciowa: produkcyjny parser gugik2osm (SAX, Python)
 * miesci sie w 50-100 MB RAM na plikach 20 GB.
 */
import { SaxesParser, type SaxesTagNS } from 'saxes';
import type { Readable } from 'node:stream';
import proj4 from 'proj4';
import {
  KNOWN_FEATURE_NAMES,
  type GmlProfile,
  type FieldPath,
} from './profiles.ts';

// --- ukladu wspolrzednych ------------------------------------------------

proj4.defs(
  'EPSG:2180',
  '+proj=tmerc +lat_0=0 +lon_0=19 +k=0.9993 +x_0=500000 +y_0=-5300000 ' +
    '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
);
// PL-2000, strefy 5-8 (uzywane lokalnie przez czesc gmin)
proj4.defs('EPSG:2176', '+proj=tmerc +lat_0=0 +lon_0=15 +k=0.999923 +x_0=5500000 +y_0=0 +ellps=GRS80 +units=m +no_defs');
proj4.defs('EPSG:2177', '+proj=tmerc +lat_0=0 +lon_0=18 +k=0.999923 +x_0=6500000 +y_0=0 +ellps=GRS80 +units=m +no_defs');
proj4.defs('EPSG:2178', '+proj=tmerc +lat_0=0 +lon_0=21 +k=0.999923 +x_0=7500000 +y_0=0 +ellps=GRS80 +units=m +no_defs');
proj4.defs('EPSG:2179', '+proj=tmerc +lat_0=0 +lon_0=24 +k=0.999923 +x_0=8500000 +y_0=0 +ellps=GRS80 +units=m +no_defs');

/** Bounding box Polski w WGS84 - do wykrycia odwroconej kolejnosci osi. */
const PL_BBOX = { minLon: 13.9, maxLon: 24.3, minLat: 48.9, maxLat: 55.0 };

function inPoland(lon: number, lat: number): boolean {
  return lon >= PL_BBOX.minLon && lon <= PL_BBOX.maxLon &&
         lat >= PL_BBOX.minLat && lat <= PL_BBOX.maxLat;
}

/**
 * Normalizuje srsName do kodu EPSG.
 * Obsluguje `EPSG:2180`, `urn:ogc:def:crs:EPSG::2180`,
 * `http://www.opengis.net/def/crs/EPSG/0/2180`.
 */
export function srsToEpsg(srsName: string | undefined): string {
  if (!srsName) return 'EPSG:2180';
  const m = /(\d{4,5})\s*$/.exec(srsName.trim());
  return m ? `EPSG:${m[1]}` : 'EPSG:2180';
}

/**
 * Czy dana deklaracja srsName narzuca kolejnosc osi (northing, easting).
 *
 * TO JEST PULAPKA, KTORA CICHO PSUJE CALY ZBIOR.
 *
 * Uklady PL-1992 i PL-2000 maja w rejestrze EPSG kolejnosc osi (X=north, Y=east).
 * Formy `urn:ogc:def:crs:EPSG::2180` i `http://.../def/crs/EPSG/0/2180`
 * respektuja te kolejnosc. Forma skrocona `EPSG:2180` jest przez wiekszosc
 * narzedzi (GDAL, QGIS, proj4) traktowana jako (easting, northing).
 *
 * Nie da sie tego rozstrzygnac samym bounding boxem Polski, bo zakresy
 * easting (140-880 km) i northing (120-900 km) NACHODZA NA SIEBIE -
 * punkt z Warszawy odczytany odwrotnie laduje pod Bydgoszcza, czyli
 * nadal "w Polsce". Sprawdzone empirycznie na fixture'ach.
 */
export function axisOrderIsNorthEast(srsName: string | undefined): boolean {
  if (!srsName) return false;
  const s = srsName.trim().toLowerCase();
  return s.startsWith('urn:') || s.startsWith('http://') || s.startsWith('https://');
}

export interface TransformResult {
  lon: number;
  lat: number;
  /** true, gdy trzeba bylo odwrocic osie wbrew deklaracji srsName. */
  axisSwapped: boolean;
}

/**
 * Transformacja do WGS84.
 *
 * Kolejnosc: (1) interpretacja zgodna z konwencja srsName, (2) weryfikacja
 * bounding boxem Polski, (3) dopiero gdy zawiedzie - zamiana osi z flaga
 * `axisSwapped`, ktora ETL raportuje jako ostrzezenie.
 *
 * Flaga jest istotna: masowe swapowanie oznacza, ze producent pliku zlamal
 * wlasna deklaracje i trzeba to zglosic, a nie po cichu "naprawiac".
 */
/**
 * Konwertery proj4 budowane raz na uklad, nie raz na punkt.
 *
 * Wywolanie proj4(from, to, coords) za kazdym razem parsuje definicje obu
 * ukladow i konstruuje obiekt Projection. Przy 8,5 mln punktow to 8,5 mln
 * niepotrzebnych konstrukcji - w profilu CPU `Projection` bylo widoczna
 * pozycja mimo ze liczy sie tylko raz na uklad.
 */
// proj4.Converter, a NIE ReturnType<typeof proj4>: proj4 jest przeciazone,
// a ReturnType bierze ostatnie przeciazenie - to zwracajace wspolrzedne,
// nie konwerter. Stad "Property 'forward' does not exist".
const konwertery = new Map<string, proj4.Converter>();

function konwerter(epsg: string): proj4.Converter {
  let c = konwertery.get(epsg);
  if (!c) {
    c = proj4(epsg, 'EPSG:4326');
    konwertery.set(epsg, c);
  }
  return c;
}

export function toWgs84(
  a: number,
  b: number,
  epsg: string,
  srsName?: string,
): TransformResult | null {
  const tryOrder = (x: number, y: number) => {
    try {
      const [lon, lat] = konwerter(epsg).forward([x, y]) as [number, number];
      return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
    } catch { return null; }
  };

  const northFirst = axisOrderIsNorthEast(srsName);
  // wg konwencji: northFirst => (a,b) = (northing, easting) => proj4 chce (east, north)
  const primary = northFirst ? tryOrder(b, a) : tryOrder(a, b);
  if (primary && inPoland(primary.lon, primary.lat)) {
    return { ...primary, axisSwapped: false };
  }

  const secondary = northFirst ? tryOrder(a, b) : tryOrder(b, a);
  if (secondary && inPoland(secondary.lon, secondary.lat)) {
    return { ...secondary, axisSwapped: true };
  }

  // Zaden wariant nie trafil w Polske - zwracamy interpretacje wg konwencji
  // i zostawiamy walidacji do odrzucenia. Nie zgadujemy.
  return primary ? { ...primary, axisSwapped: false } : null;
}

// --- surowy feature ------------------------------------------------------

export interface RawFeature {
  kind: 'point' | 'locality' | 'street';
  profile: GmlProfile;
  localName: string;
  gmlId?: string;
  /** Wartosci tekstowe, kluczowane pelna sciezka local name'ow od feature'a. */
  fields: Map<string, string[]>;
  /** Wartosci xlink:href, kluczowane tak samo - dla asocjacji. */
  refs: Map<string, string[]>;
  lon?: number;
  lat?: number;
  /** Surowe wspolrzedne przed transformacja - do diagnostyki. */
  srcCoords?: [number, number];
  srsName?: string;
}

export interface ParseStats {
  features: number;
  byKind: Record<string, number>;
  namespaces: Set<string>;
  profileDetected?: string;
  geometryMissing: number;
  geometryFailed: number;
  /** Ile razy trzeba bylo odwrocic osie wbrew deklaracji srsName. */
  axisSwapped: number;
  /** Ile punktow wypadlo poza granice Polski - sygnal bledu w zrodle. */
  outsidePoland: number;
  unknownFeatures: Map<string, number>;
}

export interface ParseOptions {
  /** Wywolywane dla kazdego rozpoznanego feature'a. */
  onFeature: (f: RawFeature) => void | Promise<void>;
  /** Wywolywane raz, po wykryciu profilu. */
  onProfileDetected?: (profile: GmlProfile, namespace: string) => void;
  /** Zatrzymanie po N feature'ach - do trybu discover. */
  limit?: number;
}

const GEOM_ELEMENTS = new Set(['Point', 'LineString', 'Curve', 'Polygon', 'Surface', 'MultiSurface', 'MultiCurve']);
const COORD_ELEMENTS = new Set(['pos', 'posList', 'coordinates', 'lowerCorner', 'upperCorner']);

/**
 * Parsuje strumien GML, emitujac feature'y przez callback.
 * Zuzycie pamieci jest stale - nie buforujemy calego dokumentu.
 */
export async function parseGmlStream(
  input: Readable,
  opts: ParseOptions,
): Promise<ParseStats> {
  const stats: ParseStats = {
    features: 0,
    byKind: {},
    namespaces: new Set(),
    geometryMissing: 0,
    geometryFailed: 0,
    axisSwapped: 0,
    outsidePoland: 0,
    unknownFeatures: new Map(),
  };

  const parser = new SaxesParser({ xmlns: true, position: false });

  /** Stos local name'ow WEWNATRZ biezacego feature'a. */
  let path: string[] = [];
  let current: RawFeature | null = null;
  /** Sciezka, na ktorej rozpoczal sie feature - do wykrycia jego konca. */
  let featureDepth = 0;
  let depth = 0;
  let text = '';
  let inCoords = false;
  let coordSrs: string | undefined;
  let detected = false;
  const pending: Array<RawFeature> = [];

  parser.on('opentag', (tag: SaxesTagNS) => {
    depth++;
    const local = (tag as any).local ?? tag.name.replace(/^.*:/, '');
    const uri: string = (tag as any).uri ?? '';

    if (current === null) {
      const known = KNOWN_FEATURE_NAMES.get(local);
      if (known) {
        if (uri) stats.namespaces.add(uri);
        current = {
          kind: known.kind,
          profile: known.profile,
          localName: local,
          gmlId: attr(tag, 'id'),
          fields: new Map(),
          refs: new Map(),
        };
        featureDepth = depth;
        path = [];
        if (!detected) {
          detected = true;
          stats.profileDetected = known.profile.name;
          known.profile.observedNamespace = uri;
          opts.onProfileDetected?.(known.profile, uri);
        }
        return;
      }
      // niezaklasyfikowany element na poziomie featureMember - policz
      if (local.startsWith('AD_') || local.startsWith('PRG_')) {
        stats.unknownFeatures.set(local, (stats.unknownFeatures.get(local) ?? 0) + 1);
      }
      return;
    }

    path.push(local);
    text = '';

    // xlink:href - asocjacje miedzy obiektami
    const href = attrHref(tag);
    if (href) {
      pushMulti(current.refs, path.join('/'), href.replace(/^#/, ''));
    }

    if (GEOM_ELEMENTS.has(local)) {
      coordSrs = attr(tag, 'srsName') ?? coordSrs;
      if (coordSrs) current.srsName = coordSrs;
    }
    if (COORD_ELEMENTS.has(local)) inCoords = true;
  });

  parser.on('text', (t: string) => {
    if (current !== null) text += t;
  });

  parser.on('closetag', (tag: SaxesTagNS) => {
    const local = (tag as any).local ?? tag.name.replace(/^.*:/, '');

    if (current !== null) {
      if (depth === featureDepth) {
        // koniec feature'a
        finishGeometry(current, stats);
        stats.features++;
        stats.byKind[current.kind] = (stats.byKind[current.kind] ?? 0) + 1;
        pending.push(current);
        current = null;
        path = [];
        coordSrs = undefined;
      } else {
        const value = text.trim();
        if (inCoords && COORD_ELEMENTS.has(local)) {
          if (value) pushMulti(current.fields, '@coords', value);
          inCoords = false;
        } else if (value) {
          pushMulti(current.fields, path.join('/'), value);
        }
        path.pop();
        text = '';
      }
    }
    depth--;
  });

  let error: Error | null = null;
  parser.on('error', (e: Error) => { error = e; });

  // setEncoding, a NIE chunk.toString('utf8') w petli.
  //
  // Granica chunka wypada w dowolnym miejscu bajtowym, wiec przy dekodowaniu
  // kazdego kawalka osobno wielobajtowy znak rozjezdza sie na dwa chunki
  // i zamienia w U+FFFD. Na mazowieckim (1,4 GB) dawalo to jedna uszkodzona
  // nazwe ulicy - cicho, bez ostrzezenia. setEncoding trzyma niedokonczona
  // sekwencje w StringDecoderze do nastepnego chunka. Przy okazji oszczedza
  // jedna kopie bufora na chunk.
  input.setEncoding('utf8');
  for await (const chunk of input) {
    parser.write(chunk as unknown as string);
    if (error) throw error;
    while (pending.length) {
      const f = pending.shift()!;
      await opts.onFeature(f);
      if (opts.limit && stats.features >= opts.limit) return stats;
    }
  }
  parser.close();
  while (pending.length) await opts.onFeature(pending.shift()!);

  if (error) throw error;
  return stats;
}

function finishGeometry(f: RawFeature, stats: ParseStats): void {
  const coords = f.fields.get('@coords');
  if (!coords?.length) { stats.geometryMissing++; return; }
  f.fields.delete('@coords');

  const nums = coords[0].trim().split(/[\s,]+/).map(Number);
  if (nums.length < 2 || !Number.isFinite(nums[0]) || !Number.isFinite(nums[1])) {
    stats.geometryFailed++;
    return;
  }
  // Dla linii/poligonow bierzemy pierwszy wierzcholek jako reprezentanta.
  f.srcCoords = [nums[0], nums[1]];
  const wgs = toWgs84(nums[0], nums[1], srsToEpsg(f.srsName), f.srsName);
  if (!wgs) { stats.geometryFailed++; return; }
  if (wgs.axisSwapped) stats.axisSwapped++;
  if (!inPoland(wgs.lon, wgs.lat)) stats.outsidePoland++;
  f.lon = round7(wgs.lon);
  f.lat = round7(wgs.lat);
}

function round7(n: number): number { return Math.round(n * 1e7) / 1e7; }

function pushMulti(map: Map<string, string[]>, key: string, value: string): void {
  const arr = map.get(key);
  if (arr) arr.push(value); else map.set(key, [value]);
}

// `for..in` zamiast `Object.keys` - to goraca sciezka wolana dla kazdego
// elementu dokumentu (a tych sa dziesiatki milionow), a Object.keys alokuje
// przy kazdym wywolaniu tablice, ktora natychmiast idzie do GC.
function attr(tag: SaxesTagNS, name: string): string | undefined {
  const attrs = tag.attributes as Record<string, any>;
  for (const k in attrs) {
    const a = attrs[k];
    const local = typeof a === 'object' && a !== null ? a.local ?? k : k;
    if (local === name || k === name || k.endsWith(`:${name}`)) {
      return typeof a === 'object' && a !== null ? a.value : a;
    }
  }
  return undefined;
}

/**
 * href w jednym przebiegu.
 *
 * Wczesniej bylo `attrNs(tag,'href') ?? attr(tag,'href')`, czyli dwa pelne
 * przejscia po atrybutach KAZDEGO elementu wewnatrz feature'a. Kolejnosc
 * preferencji zostaje ta sama: najpierw trafienie po nazwie lokalnej
 * (xlink:href z rozwiazanym namespace), potem po surowym kluczu.
 */
function attrHref(tag: SaxesTagNS): string | undefined {
  const attrs = tag.attributes as Record<string, any>;
  let fallback: string | undefined;
  for (const k in attrs) {
    const a = attrs[k];
    if (typeof a === 'object' && a !== null) {
      if (a.local === 'href') return a.value;
      if (fallback === undefined && (k === 'href' || k.endsWith(':href'))) fallback = a.value;
    } else if (fallback === undefined && (k === 'href' || k.endsWith(':href'))) {
      fallback = a;
    }
  }
  return fallback;
}

function attrNs(tag: SaxesTagNS, name: string): string | undefined {
  const attrs = tag.attributes as Record<string, any>;
  for (const k in attrs) {
    const a = attrs[k];
    if (typeof a === 'object' && a !== null && a.local === name) return a.value;
  }
  return undefined;
}

/**
 * Odczytuje pole z feature'a wg listy kandydujacych sciezek.
 *
 * Dopasowanie jest po SUFIKSIE sciezki, nie po pelnej rownosci - dzieki temu
 * dziala niezaleznie od tego, czy GUGiK opakuje wartosc w dodatkowy element
 * (`idIIP/AD_IdentyfikatorIIP/lokalnyId` vs samo `lokalnyId`).
 */
export function readField(f: RawFeature, candidates: FieldPath[]): string | undefined {
  for (const cand of candidates) {
    const suffix = cand.join('/');
    // 1. dokladne trafienie
    const exact = f.fields.get(suffix);
    if (exact?.length) return exact[0];
    // 2. sufiks sciezki
    for (const [key, values] of f.fields) {
      if (key === suffix || key.endsWith('/' + suffix)) {
        if (values.length) return values[0];
      }
    }
    // 3. referencja xlink
    const ref = f.refs.get(suffix);
    if (ref?.length) return ref[0];
    for (const [key, values] of f.refs) {
      if (key === suffix || key.endsWith('/' + suffix)) {
        if (values.length) return values[0];
      }
    }
  }
  return undefined;
}

/** Wszystkie wartosci dla pola (np. jednostkaAdministracyjna wystepuje 3x). */
export function readFieldAll(f: RawFeature, candidates: FieldPath[]): string[] {
  const out: string[] = [];
  for (const cand of candidates) {
    const suffix = cand.join('/');
    for (const [key, values] of f.fields) {
      if (key === suffix || key.endsWith('/' + suffix)) out.push(...values);
    }
    for (const [key, values] of f.refs) {
      if (key === suffix || key.endsWith('/' + suffix)) out.push(...values);
    }
    if (out.length) break;
  }
  return out;
}
