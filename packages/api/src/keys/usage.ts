/**
 * Zliczanie zuzycia - podstawa kwoty miesiecznej.
 *
 * DWIE ROZNE RZECZY, KTORE PLAN SKLEIL W JEDNO ZDANIE
 *
 * Zapis "limity i kwoty per klient, magazyn wspoldzielony miedzy instancjami"
 * laczy dwa mechanizmy o zupelnie roznych wymaganiach:
 *
 *   LIMIT NA MINUTE to ochrona przed przeciazeniem. Zostaje LOKALNY, w pamieci
 *   procesu (LocalStore wtyczki limitujacej). Wspoldzielony licznik oznaczalby
 *   obieg sieciowy na sciezce KAZDEGO zadania - dokladnie ten koszt, z powodu
 *   ktorego odrzucono Redisa przy weryfikacji klucza. Efektywny limit przy
 *   N instancjach to N x wartosc; to nie jest luka, tylko wlasciwosc do
 *   zapisania w umowie.
 *
 *   KWOTA MIESIECZNA to podstawa faktury. Musi byc wspoldzielona i trwala,
 *   ale NIE musi byc egzekwowana co do jednego zadania.
 *
 * DLACZEGO ZAPIS ZBIORCZY, A NIE UPDATE PRZY KAZDYM ZADANIU
 *
 * Pojedynczy UPDATE na goracej sciezce sam przekroczylby prog "+0,3 ms do p99"
 * z zadania 8.8. Projekt ma tez udokumentowana lekcje o wzmocnieniu zapisu:
 * 303 GB zapisow przy zbiorze 12 GB w cyklu ETL. Agregat w pamieci i jeden
 * INSERT ... ON CONFLICT co minute kosztuja tyle, co nic.
 *
 * Z tego samego powodu nie ma kolumny "ostatnie uzycie" aktualizowanej przy
 * kazdym zadaniu - wyprowadzamy je z tabeli zuzycia.
 *
 * JEDNOSTKA ROZLICZENIOWA
 *
 * /v1/batch liczy tyle jednostek, ile pozycji we wsadzie; kazda inna trasa 1.
 * Decyzji NIE DA SIE dolozyc pozniej bez zmiany umow: wsad przyjmuje do 1000
 * pozycji, wiec klient rozliczany w ZADANIACH obchodzi kwote, pakujac tysiac
 * adresow w jedno zapytanie.
 */
import type pg from 'pg';

interface Licznik {
  klientId: number;
  zapytan: number;
  jednostek: number;
}

export interface UsageMeterConfig {
  pool: pg.Pool;
  /** Co ile zrzucac agregat do bazy. */
  flushMs?: number;
  onError?: (err: Error) => void;
}

export class UsageMeter {
  private liczniki = new Map<number, Licznik>();
  private cfg: UsageMeterConfig;
  private timer: NodeJS.Timeout | null = null;

  liczbaZrzutow = 0;
  liczbaBledow = 0;

  // Jawne przypisanie zamiast parameter property - tryb strip-only nie generuje
  // kodu przypisania (patrz komentarz przy konstruktorze IndexHolder).
  constructor(cfg: UsageMeterConfig) {
    this.cfg = cfg;
  }

  zlicz(kluczId: number, klientId: number, jednostek: number): void {
    const l = this.liczniki.get(kluczId) ?? { klientId, zapytan: 0, jednostek: 0 };
    l.zapytan += 1;
    l.jednostek += jednostek;
    this.liczniki.set(kluczId, l);
  }

  /**
   * Jednostki JESZCZE NIEZRZUCONE dla danego klienta.
   *
   * Kontrola kwoty musi je doliczac do wartosci z bazy. Inaczej nadmiar nie
   * jest ograniczony jednym zadaniem, tylko calym oknem zrzutu: przy oknie
   * 60 s i wsadzie po 1000 pozycji klient przekraczalby kwote kilkusetkrotnie,
   * zanim ktokolwiek by to zobaczyl.
   */
  jednostkiKlienta(klientId: number): number {
    let suma = 0;
    for (const l of this.liczniki.values()) if (l.klientId === klientId) suma += l.jednostek;
    return suma;
  }

  start(): void {
    const okres = this.cfg.flushMs ?? 60_000;
    if (okres <= 0) return;
    this.timer = setInterval(() => { void this.flush(); }, okres);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    // Ostatni zrzut przy zamykaniu - inaczej zuzycie z ostatniej minuty pracy
    // poda przepada przy kazdym wdrozeniu kroczacym.
    await this.flush();
  }

  /**
   * Zrzut agregatu. Blad jest LOGOWANY, a licznik zostaje do nastepnej proby -
   * zadania nie moga dostawac kodu 500 dlatego, ze ksiegowanie chwilowo nie
   * dziala. To przeciwienstwo domyslnego zachowania wtyczki limitujacej
   * (skipOnError=false), ktore przy wspoldzielonym magazynie zamienia
   * chwilowa niedostepnosc bazy w "cale API padlo".
   */
  async flush(): Promise<void> {
    if (this.liczniki.size === 0) return;
    const doZrzutu = this.liczniki;
    this.liczniki = new Map();
    try {
      const wpisy = [...doZrzutu.entries()];
      await this.cfg.pool.query(
        `INSERT INTO licencje.zuzycie (klucz_id, okres, zapytan, jednostek)
         SELECT * FROM unnest($1::bigint[], $2::date[], $3::bigint[], $4::bigint[])
         ON CONFLICT (klucz_id, okres) DO UPDATE
           SET zapytan   = licencje.zuzycie.zapytan   + EXCLUDED.zapytan,
               jednostek = licencje.zuzycie.jednostek + EXCLUDED.jednostek,
               zmieniony = now()`,
        [
          wpisy.map(([id]) => id),
          wpisy.map(() => okresRozliczeniowy()),
          wpisy.map(([, l]) => l.zapytan),
          wpisy.map(([, l]) => l.jednostek),
        ]);
      this.liczbaZrzutow++;
    } catch (e) {
      this.liczbaBledow++;
      // Oddajemy liczniki z powrotem, doliczajac to, co przybylo w miedzyczasie.
      for (const [id, l] of doZrzutu) {
        const biezacy = this.liczniki.get(id);
        if (biezacy) { biezacy.zapytan += l.zapytan; biezacy.jednostek += l.jednostek; }
        else this.liczniki.set(id, l);
      }
      this.cfg.onError?.(e as Error);
    }
  }
}

/** Pierwszy dzien biezacego miesiaca w postaci YYYY-MM-DD. */
export function okresRozliczeniowy(teraz = new Date()): string {
  const rok = teraz.getUTCFullYear();
  const miesiac = String(teraz.getUTCMonth() + 1).padStart(2, '0');
  return `${rok}-${miesiac}-01`;
}

/**
 * Jednostki rozliczeniowe zadania.
 *
 * Wsad liczy pozycje, kazda inna trasa jeden. Wartosc czytamy z ciala zadania
 * dopiero w onResponse, bo w onRequest cialo nie jest jeszcze sparsowane.
 */
export function jednostkiZadania(trasa: string | undefined, cialo: unknown): number {
  if (trasa !== '/v1/batch') return 1;
  const items = (cialo as { items?: unknown[] } | undefined)?.items;
  return Array.isArray(items) && items.length > 0 ? items.length : 1;
}
