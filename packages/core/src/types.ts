/**
 * @adres-pl/core - wspolne typy dla serwisu i klienta.
 *
 * Ten pakiet jest IZOMORFICZNY i nie ma zaleznosci runtime.
 * Te same reguly normalizacji musza dzialac w przegladarce i na serwerze -
 * inaczej podpowiedzi i walidacja wsadowa zaczna sie rozjezdzac.
 */

/** Poziom pewnosci dopasowania adresu do rejestru. */
export type Confidence =
  /** Pelne dopasowanie do PRG - mamy prgLocalId i wspolrzedne. */
  | 'verified_registry'
  /** Miejscowosc i ulica z rejestru, numer nie. */
  | 'verified_partial'
  /** Uzytkownik swiadomie potwierdzil adres spoza bazy (nowe budownictwo). */
  | 'outside_registry'
  /** Tryb reczny: skrytka pocztowa, adres tymczasowy, nietypowy. */
  | 'irregular'
  /** Import bez walidacji. */
  | 'unverified';

/** Kanoniczny adres polski. */
export interface PlAddress {
  /** Zawsze 'PL' w tej wersji. */
  country: 'PL';
  /** Identyfikator SIMC miejscowosci (7 znakow, wiodace zera znaczace). */
  simc?: string;
  locality: string;
  /** Identyfikator ULIC (5 znakow) - NULL dla ulic obecnych tylko w PRG. */
  symUl?: string;
  /** Cecha ulicy: 'ul.', 'al.', 'pl.', 'os.', 'rondo'... */
  streetType?: string;
  /** Nazwa ulicy w formie oficjalnej, np. 'Tadeusza Kosciuszki'. */
  street?: string;
  buildingNumber: string;
  /**
   * Numer lokalu - ZAWSZE wolny tekst.
   * PRG traci atrybut `numerLokalu` wraz ze zmiana struktury 1.09.2026,
   * wiec nie ma i nie bedzie sensownej walidacji rejestrowej tego pola.
   */
  unitNumber?: string;
  /** Format NN-NNN. */
  postalCode?: string;
  /** TERC gminy (7 znakow) - wyprowadzany z SIMC. */
  gminaTerc?: string;
  lat?: number;
  lon?: number;
  /** lokalnyId z PRG - trwaly klucz miedzy kolejnymi zrzutami. */
  prgLocalId?: string;
  confidence: Confidence;
  /** Oryginalny, niezmodyfikowany input uzytkownika. Do audytu. */
  raw?: string;
}

/** Wynik parsowania adresu podanego jednym ciagiem. */
export interface ParsedAddressLine {
  postalCode?: string;
  locality?: string;
  streetType?: string;
  street?: string;
  buildingNumber?: string;
  unitNumber?: string;
  /** Fragmenty, ktorych nie udalo sie zakwalifikowac. */
  unparsed: string[];
  raw: string;
  /**
   * Adres nie jest punktem adresowym i nie ma odpowiednika w rejestrze -
   * dzis wylacznie skrytka pocztowa.
   *
   * Bez tego sygnalu "skr. poczt. 15, Warszawa" przechodzilo sciezka zwyklego
   * adresu: marker byl odrzucany jako nierozpoznany, numer skrytki trafial
   * w pole numeru budynku i adres dostawal `verified_registry` - najwyzszy
   * poziom pewnosci dla miejsca, ktore nie istnieje.
   */
  irregular?: 'post_office_box';
}

/** Rozbicie numeru na budynek i lokal. */
export interface ParsedNumber {
  buildingNumber: string;
  unitNumber?: string;
  /**
   * true, gdy zapis jest z natury dwuznaczny (np. `12/14`) i rozstrzygniecie
   * wymaga sprawdzenia w rejestrze: jesli punkt `12/14` istnieje w PRG,
   * to jest to numer budynku, a nie budynek 12 / lokal 14.
   */
  ambiguous: boolean;
  /**
   * Alternatywne odczyty do sprawdzenia w rejestrze, gdy `ambiguous === true`.
   * Kolejnosc: od najbardziej do najmniej prawdopodobnego.
   */
  alternatives?: Array<{ buildingNumber: string; unitNumber?: string }>;
}

/** Kod problemu wykrytego przez walidacje. */
export type IssueCode =
  | 'MISSING_LOCALITY'
  | 'MISSING_BUILDING_NUMBER'
  | 'INVALID_POSTAL_CODE_FORMAT'
  | 'INVALID_BUILDING_NUMBER_FORMAT'
  | 'STREET_IN_LOCALITY_WITHOUT_STREETS'
  | 'MISSING_STREET_IN_LOCALITY_WITH_STREETS'
  | 'LOCALITY_OUTSIDE_REGISTRY'
  | 'STREET_OUTSIDE_REGISTRY'
  | 'BUILDING_NUMBER_OUTSIDE_REGISTRY'
  | 'POSTAL_CODE_CONFLICTS_WITH_REGISTRY'
  | 'BUILDING_NUMBER_PROJECTED'
  | 'MULTIPLE_CANDIDATES';

export interface Issue {
  code: IssueCode;
  /** `error` blokuje tylko wtedy, gdy aplikacja konsumencka tak zdecyduje. */
  severity: 'error' | 'warning' | 'info';
  field: keyof PlAddress | 'adres';
  message: string;
  /** Wartosc sugerowana przez rejestr, jesli istnieje. */
  suggested?: string;
}

export interface ValidationResult {
  address: PlAddress;
  issues: Issue[];
  confidence: Confidence;
}

/** Rekord miejscowosci zwracany przez API. */
export interface Locality {
  simc: string;
  name: string;
  /** Kod WMRODZ. */
  kind: number;
  kindName: string;
  gminaTerc: string;
  gmina: string;
  powiat: string;
  voivodeship: string;
  /**
   * Czy w tej miejscowosci w ogole istnieja ulice.
   * Steruje pokazaniem/ukryciem pola ulicy w UI - bez tego uzytkownik
   * ze wsi wpatruje sie w puste, wymagane pole "ulica".
   */
  hasStreets: boolean;
  lat?: number;
  lon?: number;
}

export interface Street {
  ulicId: number;
  simc: string;
  symUl?: string;
  streetType?: string;
  name: string;
  /** Forma potoczna do matchowania: 'Kosciuszki' dla 'Tadeusza Kosciuszki'. */
  shortName?: string;
}

export interface AddressPoint {
  id: number;
  prgLocalId?: string;
  simc: string;
  ulicId?: number;
  buildingNumber: string;
  postalCode?: string;
  lat?: number;
  lon?: number;
  /** Zamrozony snapshot sprzed 1.09.2026 - po tej dacie PRG go nie publikuje. */
  status?: string;
}

/** Podpowiedz z wyszukiwarki. */
export interface Suggestion {
  type: 'locality' | 'street';
  /** Etykieta do wyswietlenia, np. 'ul. Tadeusza Kosciuszki, Warszawa'. */
  label: string;
  score: number;
  simc: string;
  ulicId?: number;
  locality: string;
  street?: string;
  streetType?: string;
  gmina?: string;
  powiat?: string;
  voivodeship?: string;
  hasStreets?: boolean;
  /** Ile punktow adresowych kryje sie pod ta pozycja. */
  addressPointCount?: number;
}
