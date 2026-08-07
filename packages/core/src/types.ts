/**
 * @adres-pl/core — wspólne typy dla serwisu i klienta.
 *
 * Ten pakiet jest IZOMORFICZNY i nie ma zależności runtime.
 * Te same reguły normalizacji muszą działać w przeglądarce i na serwerze —
 * inaczej podpowiedzi i walidacja wsadowa zaczną się rozjeżdżać.
 */

/** Poziom pewności dopasowania adresu do rejestru. */
export type Confidence =
  /** Pełne dopasowanie do PRG — mamy prgLocalId i współrzędne. */
  | 'zweryfikowany_rejestr'
  /** Miejscowość i ulica z rejestru, numer nie. */
  | 'zweryfikowany_czesciowo'
  /** Użytkownik świadomie potwierdził adres spoza bazy (nowe budownictwo). */
  | 'poza_rejestrem'
  /** Tryb ręczny: skrytka pocztowa, adres tymczasowy, nietypowy. */
  | 'nietypowy'
  /** Import bez walidacji. */
  | 'niezweryfikowany';

/** Kanoniczny adres polski. */
export interface PlAddress {
  /** Zawsze 'PL' w tej wersji. */
  kraj: 'PL';
  /** Identyfikator SIMC miejscowości (7 znaków, wiodące zera znaczące). */
  simc?: string;
  miejscowosc: string;
  /** Identyfikator ULIC (5 znaków) — NULL dla ulic obecnych tylko w PRG. */
  symUl?: string;
  /** Cecha ulicy: 'ul.', 'al.', 'pl.', 'os.', 'rondo'… */
  cecha?: string;
  /** Nazwa ulicy w formie oficjalnej, np. 'Tadeusza Kościuszki'. */
  ulica?: string;
  nrBudynku: string;
  /**
   * Numer lokalu — ZAWSZE wolny tekst.
   * PRG traci atrybut `numerLokalu` wraz ze zmianą struktury 1.09.2026,
   * więc nie ma i nie będzie sensownej walidacji rejestrowej tego pola.
   */
  nrLokalu?: string;
  /** Format NN-NNN. */
  kodPocztowy?: string;
  /** TERC gminy (7 znaków) — wyprowadzany z SIMC. */
  tercGminy?: string;
  lat?: number;
  lon?: number;
  /** lokalnyId z PRG — trwały klucz między kolejnymi zrzutami. */
  prgLocalId?: string;
  confidence: Confidence;
  /** Oryginalny, niezmodyfikowany input użytkownika. Do audytu. */
  raw?: string;
}

/** Wynik parsowania adresu podanego jednym ciągiem. */
export interface ParsedAddressLine {
  kodPocztowy?: string;
  miejscowosc?: string;
  cecha?: string;
  ulica?: string;
  nrBudynku?: string;
  nrLokalu?: string;
  /** Fragmenty, których nie udało się zakwalifikować. */
  reszta: string[];
  raw: string;
}

/** Rozbicie numeru na budynek i lokal. */
export interface ParsedNumber {
  nrBudynku: string;
  nrLokalu?: string;
  /**
   * true, gdy zapis jest z natury dwuznaczny (np. `12/14`) i rozstrzygnięcie
   * wymaga sprawdzenia w rejestrze: jeśli punkt `12/14` istnieje w PRG,
   * to jest to numer budynku, a nie budynek 12 / lokal 14.
   */
  ambiguous: boolean;
  /**
   * Alternatywne odczyty do sprawdzenia w rejestrze, gdy `ambiguous === true`.
   * Kolejność: od najbardziej do najmniej prawdopodobnego.
   */
  alternatives?: Array<{ nrBudynku: string; nrLokalu?: string }>;
}

/** Kod problemu wykrytego przez walidację. */
export type IssueCode =
  | 'BRAK_MIEJSCOWOSCI'
  | 'BRAK_NUMERU'
  | 'ZLY_FORMAT_KODU'
  | 'ZLY_FORMAT_NUMERU'
  | 'ULICA_W_MIEJSCOWOSCI_BEZ_ULIC'
  | 'BRAK_ULICY_W_MIEJSCOWOSCI_Z_ULICAMI'
  | 'MIEJSCOWOSC_SPOZA_REJESTRU'
  | 'ULICA_SPOZA_REJESTRU'
  | 'NUMER_SPOZA_REJESTRU'
  | 'KOD_NIEZGODNY_Z_REJESTREM'
  | 'NUMER_PROGNOZOWANY'
  | 'WIELE_KANDYDATOW';

export interface Issue {
  code: IssueCode;
  /** `error` blokuje tylko wtedy, gdy aplikacja konsumencka tak zdecyduje. */
  severity: 'error' | 'warning' | 'info';
  field: keyof PlAddress | 'adres';
  message: string;
  /** Wartość sugerowana przez rejestr, jeśli istnieje. */
  suggested?: string;
}

export interface ValidationResult {
  address: PlAddress;
  issues: Issue[];
  confidence: Confidence;
}

/** Rekord miejscowości zwracany przez API. */
export interface Locality {
  simc: string;
  nazwa: string;
  /** Kod WMRODZ. */
  rodzaj: number;
  rodzajNazwa: string;
  tercGminy: string;
  gmina: string;
  powiat: string;
  wojewodztwo: string;
  /**
   * Czy w tej miejscowości w ogóle istnieją ulice.
   * Steruje pokazaniem/ukryciem pola ulicy w UI — bez tego użytkownik
   * ze wsi wpatruje się w puste, wymagane pole „ulica".
   */
  maUlice: boolean;
  lat?: number;
  lon?: number;
}

export interface Street {
  ulicId: number;
  simc: string;
  symUl?: string;
  cecha?: string;
  nazwa: string;
  /** Forma potoczna do matchowania: 'Kościuszki' dla 'Tadeusza Kościuszki'. */
  nazwaSkrocona?: string;
}

export interface AddressPoint {
  id: number;
  prgLocalId?: string;
  simc: string;
  ulicId?: number;
  nrBudynku: string;
  kodPocztowy?: string;
  lat?: number;
  lon?: number;
  /** Zamrożony snapshot sprzed 1.09.2026 — po tej dacie PRG go nie publikuje. */
  status?: string;
}

/** Podpowiedź z wyszukiwarki. */
export interface Suggestion {
  type: 'locality' | 'street';
  /** Etykieta do wyświetlenia, np. 'ul. Tadeusza Kościuszki, Warszawa'. */
  label: string;
  score: number;
  simc: string;
  ulicId?: number;
  locality: string;
  street?: string;
  cecha?: string;
  gmina?: string;
  powiat?: string;
  wojewodztwo?: string;
  maUlice?: boolean;
  /** Ile punktów adresowych kryje się pod tą pozycją. */
  liczbaPunktow?: number;
}
