/**
 * Pieprz do skrotow kluczy API - HMAC-SHA256 z sekretem trzymanym POZA baza.
 *
 * DLACZEGO HMAC, A NIE BCRYPT ANI ARGON2
 * Powolne funkcje skrotu chronia przed slabymi haslami ludzi. Klucz API to
 * 24 bajty z generatora kryptograficznego (192 bity) - nie do zlamania sila
 * niezaleznie od tego, czy skrot liczy sie mikrosekunde, czy sekunde.
 * HMAC jest za to DETERMINISTYCZNY, wiec kolumne ze skrotem mozna zaindeksowac
 * unikatowo i trafiac jednym zapytaniem zamiast skanowac tabele i sprawdzac
 * kazdy wiersz osobno - przy bcrypt weryfikacja klucza wymagalaby N porownan.
 *
 * DLACZEGO PIEPRZ, SKORO SKROT JUZ JEST
 * Sam skrot w bazie wystarcza przeciw wyciekowi zrzutu do czasu, gdy ktos
 * zestawi tablice dla calej przestrzeni prefiksu. Pieprz trzymany poza baza
 * sprawia, ze zrzut bazy - kopia zapasowa, replika, zrzut diagnostyczny -
 * jest bezwartosciowy bez drugiego sekretu, ktory nigdy w tej bazie nie byl.
 * Stad tez ZAKAZ liczenia HMAC funkcja pgcrypto: wstawiloby to pieprz
 * do tekstu zapytania, czyli do pg_stat_statements i do logu wolnych zapytan.
 *
 * ROTACJA
 * Instancja zna WIELE wersji pieprza naraz i sprawdza klucz kazda z nich.
 * HMAC-SHA256 na 48 bajtach to okolo mikrosekundy, wiec dwie wersje w czasie
 * rotacji sa szumem wobec p50 1,71 ms. Uwaga, ktora latwo przeoczyc: NIE DA
 * SIE przeliczyc istniejacego skrotu na nowy pieprz, bo wymagaloby to klucza
 * JAWNEGO, ktorego z zalozenia nie mamy. Rotacja pieprza to zawsze wymiana
 * kluczy - patrz docs/runbook-klucze.md (zadanie 8.6).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Skrot klucza wraz z wersja pieprza, ktora go policzyla. */
export interface KeyHash {
  version: number;
  /** 64 znaki hex - postac uzywana jako klucz mapy i w kolumnie bytea. */
  hex: string;
}

export class Peppers {
  private readonly secrets: ReadonlyMap<number, string>;
  readonly activeVersion: number;

  constructor(secrets: ReadonlyMap<number, string>, activeVersion: number) {
    if (secrets.size === 0) throw new Error('Zestaw pieprzy nie moze byc pusty');
    if (!secrets.has(activeVersion)) {
      throw new Error(`Wersja aktywna ${activeVersion} nie ma sekretu w zestawie`);
    }
    this.secrets = secrets;
    this.activeVersion = activeVersion;
  }

  get versions(): number[] {
    return [...this.secrets.keys()].sort((a, b) => a - b);
  }

  /**
   * Skrot klucza JAWNEGO wskazana wersja pieprza.
   *
   * Skracamy caly klucz, nie sam sekret: to dokladnie ta wartosc, ktora
   * przysyla klient, wiec nie ma miejsca na pomylke "ktora czesc skracamy",
   * a zmiana formatu klucza i tak oznacza wymiane kluczy.
   */
  hash(plainKey: string, version = this.activeVersion): KeyHash {
    const secret = this.secrets.get(version);
    if (secret === undefined) throw new Error(`Brak sekretu dla wersji pieprza ${version}`);
    return { version, hex: createHmac('sha256', secret).update(plainKey).digest('hex') };
  }

  /** Skroty wszystkimi znanymi wersjami - do wyszukania w replice rejestru. */
  hashAll(plainKey: string): KeyHash[] {
    return this.versions.map((v) => this.hash(plainKey, v));
  }

  /**
   * Odcisk zestawu do porownania instancji miedzy soba (`/status`).
   *
   * Nie ujawnia sekretu: to HMAC ze stalej etykiety, obciety. Bez tego
   * sprawdzenie "czy wszystkie pody maja juz nowy pieprz" wymagaloby
   * zgadywania, bo odpowiedz 401 jest celowo nieodroznialna.
   */
  fingerprint(): Array<{ version: number; odcisk: string }> {
    return this.versions.map((v) => ({
      version: v,
      odcisk: createHmac('sha256', this.secrets.get(v)!).update('odcisk').digest('hex').slice(0, 8),
    }));
  }
}

/** Nowy sekret pieprza do wpisania w konfiguracje wdrozenia. */
export function newPepperSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Porownanie stalo-czasowe DWOCH SKROTOW - obie strony maja 64 znaki hex.
 *
 * timingSafeEqual CELOWO nie jest uzywane na danych prosto z sieci: rzuca
 * RangeError przy roznych dlugosciach, wiec klient wysylajacy krotszy ciag
 * dostawalby kod 500 wlasnej roboty. Tu dlugosc jest nasza i stala, bo
 * porownujemy wynik HMAC z wynikiem HMAC.
 */
export function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Odczyt zestawu pieprzy ze zmiennych srodowiskowych: API_KEY_PEPPER_<n>
 * oraz API_KEY_PEPPER_AKTYWNY (domyslnie najwyzszy numer).
 *
 * Zwraca null, gdy nie ma ani jednego pieprza - decyzja, czy to blad, nalezy
 * do wolajacego. loadConfig zostaje CZYSTA i nie rzuca; kontrola spojnosci
 * ("tryb inny niz wylaczony wymaga pieprza") mieszka w buildServer, zeby dalo
 * sie zbadac sama konfiguracje bez stawiania serwera.
 */
export function peppersFromEnv(env: NodeJS.ProcessEnv = process.env): Peppers | null {
  const { sekrety, aktywna } = pepperEntriesFromEnv(env);
  if (sekrety.length === 0 || aktywna === null) return null;
  return new Peppers(new Map(sekrety), aktywna);
}

/**
 * Ten sam odczyt, ale w postaci ZWYKLYCH DANYCH.
 *
 * Potrzebny, bo konfiguracja serwera jest budowana z przekazanego otoczenia
 * (loadConfig(env)), a nie z process.env - inaczej kazdy test musialby
 * zanieczyszczac globalne process.env, zeby podac pieprz.
 */
export function pepperEntriesFromEnv(env: NodeJS.ProcessEnv = process.env): {
  sekrety: Array<[number, string]>;
  aktywna: number | null;
} {
  const sekrety: Array<[number, string]> = [];
  for (const [nazwa, wartosc] of Object.entries(env)) {
    const m = /^API_KEY_PEPPER_(\d+)$/.exec(nazwa);
    if (m && wartosc) sekrety.push([Number(m[1]), wartosc]);
  }
  sekrety.sort((a, b) => a[0] - b[0]);
  if (sekrety.length === 0) return { sekrety, aktywna: null };

  const numery = sekrety.map(([n]) => n);
  const zEnv = Number(env.API_KEY_PEPPER_AKTYWNY);
  const aktywna = Number.isInteger(zEnv) && numery.includes(zEnv)
    ? zEnv
    : Math.max(...numery);
  return { sekrety, aktywna };
}
