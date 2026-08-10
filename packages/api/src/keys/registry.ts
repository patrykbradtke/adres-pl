/**
 * Rejestr kluczy API - PELNA REPLIKA tabeli w pamieci procesu.
 *
 * DLACZEGO REPLIKA, A NIE CACHE
 *
 * Cache z chybieniami mialby trzy wady naraz, a kazda z nich boli inaczej:
 *   - chybienie to zapytanie do bazy, wiec ZGADYWANIE KLUCZY generuje ruch
 *     do Postgresa; napastnik dostaje darmowy kanal obciazania bazy,
 *   - zimny start poda to burza zapytan przy pierwszym ruchu,
 *   - przy awarii bazy operator nie odroznia "chybienie cache" od "baza padla",
 *     bo objaw jest ten sam.
 *
 * Replika usuwa wszystkie trzy: baza znika ze sciezki zadania CALKOWICIE,
 * a jej stan sprowadza sie do jednej mierzalnej liczby - wieku repliki.
 * Koszt jest zaniedbywalny: setki do tysiecy kluczy po ok. 200 B to ~2 MB
 * wobec 239 MB RSS procesu.
 *
 * DWA ZRODLA ODSWIEZANIA I DLACZEGO OBA SA KONIECZNE
 *
 * LISTEN/NOTIFY jest PRZYSPIESZACZEM: uniewaznienie klucza po wycieku dociera
 * w kilkadziesiat milisekund. Ale NOTIFY ginie przy zerwaniu polaczenia,
 * restarcie bazy i przelaczeniu na replike - i ginie CICHO. Klucz uniewazniony
 * po prostu dziala dalej, a nikt tego nie widzi.
 *
 * Dlatego odpytywanie co KLUCZE_ODSWIEZANIE_MS jest GWARANCJA. Kontrakt
 * zbieznosci do zapisania w umowie: typowo ponizej 100 ms, gwarantowanie
 * ponizej okresu odpytywania plus czas zapytania, czyli okolo 10 s.
 *
 * Nasluch siedzi na WLASNYM polaczeniu poza pula: pula recyklinguje polaczenia
 * i nasluch zniknalby bez sladu, a przy PG_POOL_MAX=10 zajecie jednego watku
 * puli to 10% pojemnosci.
 */
import pg from 'pg';
import { NotifyListener } from './notify-listener.ts';

export interface KeyEntry {
  kluczId: number;
  klientId: number;
  prefiks: string;
  srodowisko: 'test' | 'live';
  pieprzWersja: number;
  /** null = wez limit z klienta. Zero znaczy "zablokuj", i to co innego. */
  limitKluczaNaMinute: number | null;
  limitKlientaNaMinute: number;
  kwotaMiesieczna: number | null;
  licencja: string;
  waznyOd: Date;
  waznyDo: Date | null;
  uniewaznionyOd: Date | null;
  zawieszonyOd: Date | null;
}

export interface RegistryConfig {
  pool: pg.Pool;
  connectionString: string;
  /** 0 wylacza odpytywanie - wylacznie do testow kanalu NOTIFY. */
  odswiezanieMs?: number;
  /** Odrzuc przeladowanie, ktore zmniejsza liczbe kluczy o wiecej niz tyle procent. */
  maxSpadekProc?: number;
  onError?: (err: Error, gdzie: string) => void;
  onInfo?: (msg: string) => void;
}

const SQL_WPISY = `
  SELECT k.id                AS klucz_id,
         k.klient_id,
         k.prefiks,
         k.srodowisko,
         k.pieprz_wersja,
         k.limit_zapytan_min AS limit_klucza,
         k.wazny_od,
         k.wazny_do,
         k.uniewazniony_od,
         encode(k.hash, 'hex') AS hash_hex,
         c.limit_zapytan_min AS limit_klienta,
         c.kwota_miesieczna,
         c.licencja,
         c.zawieszony_od
    FROM licencje.klucz_api k
    JOIN licencje.klient c ON c.id = k.klient_id`;

/**
 * Znacznik zmian liczony z OBU tabel.
 *
 * Sam max(zmieniony) z klucz_api nie wystarcza: zawieszenie klienta i obnizenie
 * jego limitu nie dotykaja ani jednego wiersza klucza, wiec instancja nigdy by
 * sie o nich nie dowiedziala. Klient zawieszony pracowalby do restartu poda.
 */
/**
 * Zuzycie biezacego okresu rozliczeniowego, zsumowane per klient.
 *
 * date_trunc po stronie bazy, a nie w kodzie: okres jest wlasnoscia danych,
 * a nie stanu procesu, wiec instancje w roznych strefach czasowych musza
 * widziec ten sam miesiac.
 */
const SQL_ZUZYCIE = `
  SELECT k.klient_id, coalesce(sum(z.jednostek), 0)::text AS jednostek
    FROM licencje.zuzycie z
    JOIN licencje.klucz_api k ON k.id = z.klucz_id
   WHERE z.okres = date_trunc('month', now() AT TIME ZONE 'UTC')::date
   GROUP BY k.klient_id`;

/*
 * Rzutowanie na ::text jest KONIECZNE, nie kosmetyczne. Sterownik pg zamienia
 * timestamptz na obiekt Date, a wtedy `poprzedni !== biezacy` porownuje
 * REFERENCJE - zawsze rozne. Warunek "nic sie nie zmienilo" nie zatrzymywalby
 * niczego i replika przeladowywalaby sie przy kazdym odpytaniu, co 10 s,
 * w kazdej instancji. Ten sam blad co w loaderze artefaktu przed 9.08.2026
 * (porownanie wersji danych z nazwa pliku) - objaw jest cichy, bo wszystko
 * dziala, tylko drozej.
 */
const SQL_ZNACZNIK = `
  SELECT GREATEST(
           coalesce((SELECT max(zmieniony) FROM licencje.klucz_api), '-infinity'::timestamptz),
           coalesce((SELECT max(zmieniony) FROM licencje.klient),    '-infinity'::timestamptz)
         )::text AS znacznik`;

export class KeyRegistry {
  private wpisy: ReadonlyMap<string, KeyEntry> = new Map();
  private cfg: RegistryConfig;
  private timer: NodeJS.Timeout | null = null;
  private znacznik: string | null = null;
  private nasluch: NotifyListener | null = null;
  private odswiezaTrwa = false;

  /** Diagnostyka - wystawiana w /metrics i /status. */
  private ostatnieUdaneMs = 0;
  liczbaOdswiezen = 0;
  liczbaBledow = 0;
  get liczbaPowiadomien(): number { return this.nasluch?.liczbaPowiadomien ?? 0; }
  get liczbaPonowien(): number { return this.nasluch?.liczbaPonowien ?? 0; }
  zaladowana = false;

  constructor(cfg: RegistryConfig) {
    this.cfg = cfg;
  }

  get rozmiar(): number { return this.wpisy.size; }

  /** Milisekundy od ostatniego UDANEGO odswiezenia. Infinity, gdy nigdy. */
  get wiekMs(): number {
    return this.zaladowana ? Date.now() - this.ostatnieUdaneMs : Infinity;
  }

  znajdz(hashHex: string): KeyEntry | undefined {
    return this.wpisy.get(hashHex);
  }

  /**
   * Sonda schematu. Migracje wchodza wylacznie przy PUSTYM wolumenie
   * (docker-entrypoint-initdb.d), wiec na dzialajacej bazie 003 nie wejdzie
   * sam z siebie NIGDY. Bez tej sondy blad wyszedlby dopiero na goracej
   * sciezce, jako kod 500 na 100% ruchu.
   */
  static async sprawdzSchemat(pool: pg.Pool): Promise<void> {
    const { rows: [r] } = await pool.query<{ jest: string | null }>(
      `SELECT to_regclass('licencje.klucz_api')::text AS jest`);
    if (!r?.jest) {
      throw new Error(
        'Migracja 004_licencje.sql nie zostala wgrana do tej bazy. Uruchom:\n' +
        '  psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f db/migrations/004_licencje.sql');
    }
  }

  /**
   * Pierwsze zaladowanie i uruchomienie obu zrodel odswiezania.
   *
   * Brak schematu konczy proces: to blad wdrozenia, ktorego nie naprawi
   * ponawianie. Brak POLACZENIA z baza pozwala wstac - inaczej awaria bazy
   * zamienialaby sie w CrashLoopBackOff takze dla /v1/suggest, ktore bazy
   * w ogole nie dotyka (czyta artefakt z pamieci).
   */
  async start(): Promise<void> {
    await KeyRegistry.sprawdzSchemat(this.cfg.pool);
    try {
      await this.odswiez();
    } catch (e) {
      this.cfg.onError?.(e as Error, 'pierwsze ladowanie');
      this.cfg.onInfo?.('Rejestr kluczy niezaladowany - ponawianie w tle, /ready zwraca 503');
    }
    this.zaplanujOdswiezanie();
    // Czekamy na zestawienie nasluchu, zamiast puszczac go w tle: inaczej
    // powiadomienia z pierwszych setek milisekund po starcie przepadaja,
    // a uniewaznienie wykonane tuz po wdrozeniu czeka na pelny okres
    // odpytywania. Niepowodzenie nie blokuje startu - nasluch sam planuje
    // ponowienie.
    this.nasluch = new NotifyListener({
      connectionString: this.cfg.connectionString,
      kanal: 'licencje_zmiana',
      onPowiadomienie: () => {
        void this.odswiez().catch((e) => this.cfg.onError?.(e as Error, 'odswiezanie po NOTIFY'));
      },
      // Powiadomienia z czasu przerwy przepadly bezpowrotnie, wiec po powrocie
      // przeladowujemy replike w calosci, nie ogladajac sie na znacznik.
      onPrzywrocenie: () => {
        void this.odswiez(true).catch(() => { /* zglosi sie przy odpytywaniu */ });
      },
      onError: this.cfg.onError,
      onInfo: this.cfg.onInfo,
    });
    await this.nasluch.start();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.nasluch?.stop();
  }

  /**
   * Odswiezenie warunkowe: najpierw jeden tani SELECT po znacznik zmian,
   * pelne przeladowanie tylko wtedy, gdy cokolwiek sie ruszylo. Przy tysiacach
   * wpisow przeladowanie trwa ponizej 5 ms, wiec logika przyrostowa byla by
   * zlozonoscia bez pokrycia.
   */
  /**
   * Zuzycie biezacego okresu, zagregowane per klient.
   *
   * Czytane przy KAZDYM odswiezeniu, niezaleznie od znacznika zmian. Wciagniecie
   * go do znacznika uniewaznialoby sam mechanizm: zuzycie rosnie co minute
   * w kazdej instancji, wiec znacznik nigdy nie bylby rowny poprzedniemu
   * i replika przeladowywalaby sie w kolko.
   */
  private zuzycie = new Map<number, number>();

  /** Jednostki zuzyte przez klienta w biezacym okresie, wedle stanu bazy. */
  zuzyteJednostki(klientId: number): number {
    return this.zuzycie.get(klientId) ?? 0;
  }

  async odswiez(wymus = false): Promise<boolean> {
    if (this.odswiezaTrwa) return false;
    this.odswiezaTrwa = true;
    try {
      const { rows: zuzycieWierszy } = await this.cfg.pool.query<
        { klient_id: string; jednostek: string }>(SQL_ZUZYCIE);
      const noweZuzycie = new Map<number, number>();
      for (const r of zuzycieWierszy) noweZuzycie.set(Number(r.klient_id), Number(r.jednostek));
      this.zuzycie = noweZuzycie;

      const { rows: [z] } = await this.cfg.pool.query<{ znacznik: string }>(SQL_ZNACZNIK);
      if (!wymus && this.znacznik !== null && z.znacznik === this.znacznik) {
        this.ostatnieUdaneMs = Date.now();
        return false;
      }

      const { rows } = await this.cfg.pool.query(SQL_WPISY);
      const nowa = new Map<string, KeyEntry>();
      for (const r of rows) {
        nowa.set(r.hash_hex, {
          kluczId: Number(r.klucz_id),
          klientId: Number(r.klient_id),
          prefiks: r.prefiks,
          srodowisko: r.srodowisko,
          pieprzWersja: Number(r.pieprz_wersja),
          limitKluczaNaMinute: r.limit_klucza === null ? null : Number(r.limit_klucza),
          limitKlientaNaMinute: Number(r.limit_klienta),
          kwotaMiesieczna: r.kwota_miesieczna === null ? null : Number(r.kwota_miesieczna),
          licencja: r.licencja,
          waznyOd: r.wazny_od,
          waznyDo: r.wazny_do,
          uniewaznionyOd: r.uniewazniony_od,
          zawieszonyOd: r.zawieszony_od,
        });
      }

      // Kontrola rozsadku wzorowana na kontrolach jakosci ETL: nagly ubytek
      // kluczy to objaw zlego polaczenia albo niedokonczonej migracji, a nie
      // decyzji operatora. Stara replika zostaje - lepiej dzialac na danych
      // sprzed minuty niz odciac wszystkich klientow.
      const spadek = this.zaladowana && this.wpisy.size > 0
        ? (1 - nowa.size / this.wpisy.size) * 100
        : 0;
      const prog = this.cfg.maxSpadekProc ?? 50;
      if (spadek > prog) {
        this.liczbaBledow++;
        this.cfg.onError?.(
          new Error(`Przeladowanie zmniejszylo rejestr o ${spadek.toFixed(0)}% ` +
            `(${this.wpisy.size} -> ${nowa.size}) - odrzucone, zostaje poprzednia replika`),
          'kontrola rozsadku');
        return false;
      }

      // Podmiana REFERENCJI, nigdy czyszczenie mapy w miejscu: trwajace
      // zadania dokoncza sie na spojnym stanie.
      this.wpisy = nowa;
      this.znacznik = z.znacznik;
      this.ostatnieUdaneMs = Date.now();
      this.zaladowana = true;
      this.liczbaOdswiezen++;
      return true;
    } catch (e) {
      this.liczbaBledow++;
      throw e;
    } finally {
      this.odswiezaTrwa = false;
    }
  }

  private zaplanujOdswiezanie(): void {
    const okres = this.cfg.odswiezanieMs ?? 10_000;
    if (okres <= 0) return;
    // Jitter +/-25%: bez niego wszystkie pody odswiezaja sie w tej samej
    // milisekundzie po wdrozeniu kroczacym i baza dostaje falami.
    const zJitterem = Math.round(okres * (0.75 + Math.random() * 0.5));
    this.timer = setInterval(() => {
      void this.odswiez().catch((e) => this.cfg.onError?.(e as Error, 'odswiezanie'));
    }, zJitterem);
    this.timer.unref();
  }

}
