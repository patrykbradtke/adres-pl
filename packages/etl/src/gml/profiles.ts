/**
 * Profile struktury GML dla danych adresowych PRG.
 *
 * KLUCZOWA DECYZJA PROJEKTOWA: dopasowujemy po LOCAL NAME, ignorujac
 * namespace URI.
 *
 * Powod: namespace nowego schematu EMUiA 2021 nie jest publicznie znany,
 * a GUGiK jest w tym niekonsekwentny. Z kodu wlasnego walidatora GUGiK
 * (WalidatorPlikowGML/utils.py) wynika, ze schematy z rozporzadzen 2021
 * rozeszly sie w trzy strony:
 *
 *   egb -> 'ewidencjaGruntowIBudynkow:1.0'                       (bez urn:, dodane "I")
 *   ges -> 'geodezyjnaEwidencjaSieciUzbrojeniaTerenu:1.0'        (bez urn:)
 *   ot  -> 'bazaDanychObiektowTopograficznych500:1.0'            (bez urn:)
 *   ot  -> 'urn:gugik:...:bazaDanychObiektowTopograficznych10k:2.0'  (z urn:, wersja 2.0)
 *
 * Nie da sie z tego wyprowadzic EMUiA. Zgadywanie namespace = pewny bug.
 * Parser loguje faktyczny URI przy pierwszym feature - potwierdzenie zajmie
 * 5 sekund, gdy dostaniemy prawdziwy plik.
 */

export type ProfileName = 'prg-2012' | 'emuia-2021' | 'unknown';

/** Sciezka do pola: lista local name'ow od korzenia feature'a. */
export type FieldPath = string[];

export interface FeatureMapping {
  /** Local name elementu feature'a. */
  localName: string;
  /** Mapowanie: nazwa pola docelowego -> lista kandydujacych sciezek. */
  fields: Record<string, FieldPath[]>;
  /** Local name elementu z geometria. */
  geometryFields: string[];
}

export interface GmlProfile {
  name: ProfileName;
  /** Namespace zaobserwowany w pliku - wypelniany w runtime, do logu. */
  observedNamespace?: string;
  point: FeatureMapping;
  locality: FeatureMapping;
  street: FeatureMapping;
}

/**
 * Struktura publikowana do 1.09.2026.
 * Zweryfikowana na produkcyjnym parserze gugik2osm (processing/parsers/prg.py).
 */
export const PROFILE_PRG_2012: GmlProfile = {
  name: 'prg-2012',
  point: {
    localName: 'PRG_PunktAdresowy',
    fields: {
      localId: [['lokalnyId']],
      namespace: [['przestrzenNazw']],
      versionId: [['wersjaId']],
      versionStart: [['poczatekWersjiObiektu']],
      versionEnd: [['koniecWersjiObiektu']],
      locality: [['miejscowosc']],
      localityPart: [['czescMiejscowosci']],
      street: [['ulica']],
      buildingNumber: [['numerPorzadkowy']],
      postalCode: [['kodPocztowy']],
      status: [['status']],
      adminUnit: [['jednostkaAdministracyjna']],
      emuiaObject: [['obiektEMUiA']],
    },
    geometryFields: ['pozycja', 'geometria'],
  },
  locality: {
    localName: 'PRG_MiejscowoscNazwa',
    fields: {
      localId: [['lokalnyId']],
      name: [['nazwa']],
      idTERYT: [['idTERYT']],
      kind: [['rodzaj'], ['typ']],
    },
    geometryFields: ['pozycja', 'geometria'],
  },
  street: {
    localName: 'PRG_UlicaNazwa',
    fields: {
      localId: [['lokalnyId']],
      name: [['nazwa']],
      mainNamePart: [['nazwaGlownaCzesc']],
      namePart: [['nazwaCzesc']],
      streetTypePrefix: [['przedrostek1Czesc'], ['przedrostek2Czesc']],
      idTERYT: [['idTERYT']],
      typ: [['typ']],
      locality: [['miejscowosc']],
    },
    geometryFields: ['geometria', 'pozycja'],
  },
};

/**
 * Struktura wg rozporzadzenia Dz.U. 2021 poz. 1368 (od 1.09.2026 jedyna).
 *
 * Nazwy klas i atrybutow: [POTWIERDZONE] z Zalacznika nr 1 rozporzadzenia
 * oraz z oficjalnej tabeli konwersji EMUiA 2012->2021.
 * Sposob zagniezdzenia i namespace: [NIEZNANE] - stad wiele kandydujacych
 * sciezek dla kazdego pola i dopasowanie po sufiksie sciezki.
 *
 * Zmiany wzgledem 2012, ktore trzeba obsluzyc:
 *   AD_Ulica            -> AD_UlicaPlac
 *   pozycja             -> georeferencja
 *   nazwa               -> nazwaPelna
 *   typ                 -> rodzaj
 *   idTERYT (miejsc.)   -> identyfikatorSIMC
 *   idTERYT (ulica)     -> identyfikatorULIC
 *   nazwaGlownaCzesc    -> TERYTNazwa1
 *   nazwaCzesc          -> TERYTNazwa2
 *   BT_Identyfikator    -> AD_IdentyfikatorIIP
 *   cyklZycia/*         -> poczatekWersjiObiektu / koniecWersjiObiektu
 *
 * DO ARCHIWUM (znikaja - patrz raport, rozdz. 0):
 *   status, numerLokalu, jednostkaAdministracyjna,
 *   przedrostek1Czesc, przedrostek2Czesc
 */
export const PROFILE_EMUIA_2021: GmlProfile = {
  name: 'emuia-2021',
  point: {
    localName: 'AD_PunktAdresowy',
    fields: {
      localId: [['idIIP', 'AD_IdentyfikatorIIP', 'lokalnyId'], ['lokalnyId']],
      namespace: [['idIIP', 'AD_IdentyfikatorIIP', 'przestrzenNazw'], ['przestrzenNazw']],
      versionId: [['idIIP', 'AD_IdentyfikatorIIP', 'wersjaId'], ['wersjaId']],
      versionStart: [['poczatekWersjiObiektu']],
      versionEnd: [['koniecWersjiObiektu']],
      buildingNumber: [['numerPorzadkowy']],
      postalCode: [['kodPocztowy']],
      assignedDate: [['dataNadania']],
      // asocjacje - kodowanie [NIEZNANE], probujemy obu wariantow
      locality: [['miejsce'], ['miejscowosc'], ['miejsce', 'AD_Miejscowosc', 'identyfikatorSIMC']],
      street: [['ulica2'], ['ulica'], ['ulica2', 'AD_UlicaPlac', 'identyfikatorULIC']],
    },
    geometryFields: ['georeferencja', 'pozycja', 'geometria'],
  },
  locality: {
    localName: 'AD_Miejscowosc',
    fields: {
      localId: [['idIIP', 'AD_IdentyfikatorIIP', 'lokalnyId'], ['lokalnyId']],
      versionId: [['idIIP', 'AD_IdentyfikatorIIP', 'wersjaId'], ['wersjaId']],
      name: [['nazwa']],
      kind: [['rodzaj']],
      identyfikatorSIMC: [['identyfikatorSIMC']],
      prngId: [['prngId']],
      gminaTerc: [['TERYTGminy'], ['terytGminy']],
      minorityLanguageName: [['nazwaJezykMniejszosci']],
    },
    geometryFields: ['georeferencja', 'pozycja'],
  },
  street: {
    localName: 'AD_UlicaPlac',
    fields: {
      localId: [['idIIP', 'AD_IdentyfikatorIIP', 'lokalnyId'], ['lokalnyId']],
      versionId: [['idIIP', 'AD_IdentyfikatorIIP', 'wersjaId'], ['wersjaId']],
      fullName: [['nazwaPelna']],
      kind: [['rodzaj']],
      terytName1: [['TERYTNazwa1'], ['terytNazwa1']],
      terytName2: [['TERYTNazwa2'], ['terytNazwa2']],
      identyfikatorULIC: [['identyfikatorULIC']],
      minorityLanguageName: [['nazwaJezykMniejszosci']],
      // powiazanie z miejscowoscia idzie asocjacja - rola [WNIOSKOWANA]
      locality: [['ulica1'], ['miejscowosc'], ['miejsce']],
    },
    // AD_UlicaPlac.geometria to GM_Object - moze byc linia LUB poligon
    geometryFields: ['geometria', 'georeferencja'],
  },
};

export const PROFILES: GmlProfile[] = [PROFILE_EMUIA_2021, PROFILE_PRG_2012];

/**
 * Wszystkie local name'y feature'ow, ktore rozpoznajemy.
 * Uzywane przez auto-detekcje profilu.
 */
export const KNOWN_FEATURE_NAMES = new Map<string, { profile: GmlProfile; kind: 'point' | 'locality' | 'street' }>();
for (const p of PROFILES) {
  KNOWN_FEATURE_NAMES.set(p.point.localName, { profile: p, kind: 'point' });
  KNOWN_FEATURE_NAMES.set(p.locality.localName, { profile: p, kind: 'locality' });
  KNOWN_FEATURE_NAMES.set(p.street.localName, { profile: p, kind: 'street' });
}

/** Slownik AD_RodzajMiejscowosci -> kod WMRODZ (przyblizenie, do weryfikacji). */
export const LOCALITY_KINDS: Record<string, number> = {
  localityPart: 0,
  localityPart: 0, // literowka wystepuje w zrodlach GUGiK
  wies: 1,
  kolonia: 2,
  hamlet: 3,
  osada: 4,
  osadaLesna: 5,
  osiedle: 6,
  touristHostel: 7,
  warsawDistrict: 95,
  miasto: 96,
  delegatura: 98,
  cityPart: 99,
};

/** Slownik AD_RodzajObiektu -> cecha ULIC. */
export const OBJECT_KIND_TO_STREET_TYPE: Record<string, string> = {
  street: 'ul.',
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
  otherLinear: '',
  otherAreal: '',
};
