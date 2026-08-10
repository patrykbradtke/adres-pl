/**
 * Rejestr kluczy API - PELNA REPLIKA tabeli w pamieci procesu.
 *
 * DLACZEGO REPLIKA, A NIE CACHE
 *
 * Cache z chybieniami mialby trzy wady naraz, a kazda z nich boli inaczej:
 *   - chybienie to zapytanie do bazy, wiec ZGADYWANIE KLUCZY generuje ruch
 *     do Postgresa; napastnik dostaje darmowy channel obciazania bazy,
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
 * Dlatego odpytywanie co KEYS_REFRESH_MS jest GWARANCJA. Kontrakt
 * zbieznosci do zapisania w umowie: typowo ponizej 100 ms, gwarantowanie
 * ponizej okresu odpytywania plus czas zapytania, czyli okolo 10 s.
 *
 * Nasluch siedzi na WLASNYM polaczeniu poza pula: pula recyklinguje polaczenia
 * i listener zniknalby bez sladu, a przy PG_POOL_MAX=10 zajecie jednego watku
 * puli to 10% pojemnosci.
 */
import pg from 'pg';
import { NotifyListener } from './notify-listener.ts';

export interface KeyEntry {
  keyId: number;
  clientId: number;
  prefix: string;
  environment: 'test' | 'live';
  pepperVersion: number;
  /** null = wez limit z klienta. Zero znaczy "zablokuj", i to co innego. */
  keyRateLimitPerMin: number | null;
  clientRateLimitPerMin: number;
  monthlyQuota: number | null;
  license: string;
  validFrom: Date;
  validTo: Date | null;
  revokedAt: Date | null;
  suspendedAt: Date | null;
}

export interface RegistryConfig {
  pool: pg.Pool;
  connectionString: string;
  /** 0 wylacza odpytywanie - wylacznie do testow kanalu NOTIFY. */
  refreshMs?: number;
  /** Odrzuc przeladowanie, ktore zmniejsza liczbe kluczy o wiecej niz tyle procent. */
  maxSpadekProc?: number;
  onError?: (err: Error, where: string) => void;
  onInfo?: (msg: string) => void;
}

const SQL_WPISY = `
  SELECT k.id                AS api_key_id,
         k.client_id,
         k.prefix,
         k.environment,
         k.pepper_version,
         k.rate_limit_per_min AS key_limit,
         k.valid_from,
         k.valid_to,
         k.revoked_at,
         encode(k.hash, 'hex') AS hash_hex,
         c.rate_limit_per_min AS client_limit,
         c.monthly_quota,
         c.license,
         c.suspended_at
    FROM licensing.api_key k
    JOIN licensing.client c ON c.id = k.client_id`;

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
const SQL_USAGE = `
  SELECT k.client_id, coalesce(sum(z.units), 0)::text AS units
    FROM licensing.usage z
    JOIN licensing.api_key k ON k.id = z.api_key_id
   WHERE z.period = date_trunc('month', now() AT TIME ZONE 'UTC')::date
   GROUP BY k.client_id`;

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
           coalesce((SELECT max(updated_at) FROM licensing.api_key), '-infinity'::timestamptz),
           coalesce((SELECT max(updated_at) FROM licensing.client),    '-infinity'::timestamptz)
         )::text AS stamp`;

export class KeyRegistry {
  private entries: ReadonlyMap<string, KeyEntry> = new Map();
  private cfg: RegistryConfig;
  private timer: NodeJS.Timeout | null = null;
  private stamp: string | null = null;
  private listener: NotifyListener | null = null;
  private refreshInFlight = false;

  /** Diagnostyka - wystawiana w /metrics i /status. */
  private lastSuccessMs = 0;
  refreshCount = 0;
  errorCount = 0;
  get notificationCount(): number { return this.listener?.notificationCount ?? 0; }
  get retryCount(): number { return this.listener?.retryCount ?? 0; }
  loaded = false;

  constructor(cfg: RegistryConfig) {
    this.cfg = cfg;
  }

  get size(): number { return this.entries.size; }

  /** Milisekundy od ostatniego UDANEGO odswiezenia. Infinity, gdy nigdy. */
  get ageMs(): number {
    return this.loaded ? Date.now() - this.lastSuccessMs : Infinity;
  }

  find(hashHex: string): KeyEntry | undefined {
    return this.entries.get(hashHex);
  }

  /**
   * Sonda schematu. Migracje wchodza wylacznie przy PUSTYM wolumenie
   * (docker-entrypoint-initdb.d), wiec na dzialajacej bazie 003 nie wejdzie
   * sam z siebie NIGDY. Bez tej sondy blad wyszedlby dopiero na goracej
   * sciezce, jako kod 500 na 100% ruchu.
   */
  static async checkSchema(pool: pg.Pool): Promise<void> {
    const { rows: [r] } = await pool.query<{ exists: string | null }>(
      `SELECT to_regclass('licensing.api_key')::text AS exists`);
    if (!r?.exists) {
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
    await KeyRegistry.checkSchema(this.cfg.pool);
    try {
      await this.refresh();
    } catch (e) {
      this.cfg.onError?.(e as Error, 'pierwsze ladowanie');
      this.cfg.onInfo?.('Rejestr kluczy niezaladowany - ponawianie w tle, /ready zwraca 503');
    }
    this.scheduleRefresh();
    // Czekamy na zestawienie nasluchu, zamiast puszczac go w tle: inaczej
    // powiadomienia z pierwszych setek milisekund po starcie przepadaja,
    // a uniewaznienie wykonane tuz po wdrozeniu czeka na pelny okres
    // odpytywania. Niepowodzenie nie blokuje startu - listener sam planuje
    // retryTimer.
    this.listener = new NotifyListener({
      connectionString: this.cfg.connectionString,
      channel: 'licensing_change',
      onNotification: () => {
        void this.refresh().catch((e) => this.cfg.onError?.(e as Error, 'refresh po NOTIFY'));
      },
      // Powiadomienia z czasu przerwy przepadly bezpowrotnie, wiec po powrocie
      // przeladowujemy replike w calosci, nie ogladajac sie na znacznik.
      onReconnect: () => {
        void this.refresh(true).catch(() => { /* zglosi sie przy odpytywaniu */ });
      },
      onError: this.cfg.onError,
      onInfo: this.cfg.onInfo,
    });
    await this.listener.start();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.listener?.stop();
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
  private usage = new Map<number, number>();

  /** Jednostki zuzyte przez klienta w biezacym okresie, wedle stanu bazy. */
  usedUnits(clientId: number): number {
    return this.usage.get(clientId) ?? 0;
  }

  async refresh(force = false): Promise<boolean> {
    if (this.refreshInFlight) return false;
    this.refreshInFlight = true;
    try {
      const { rows: usageRows } = await this.cfg.pool.query<
        { client_id: string; units: string }>(SQL_USAGE);
      const newUsage = new Map<number, number>();
      for (const r of usageRows) newUsage.set(Number(r.client_id), Number(r.units));
      this.usage = newUsage;

      const { rows: [z] } = await this.cfg.pool.query<{ stamp: string }>(SQL_ZNACZNIK);
      if (!force && this.stamp !== null && z.stamp === this.stamp) {
        this.lastSuccessMs = Date.now();
        return false;
      }

      const { rows } = await this.cfg.pool.query(SQL_WPISY);
      const fresh = new Map<string, KeyEntry>();
      for (const r of rows) {
        fresh.set(r.hash_hex, {
          keyId: Number(r.api_key_id),
          clientId: Number(r.client_id),
          prefix: r.prefix,
          environment: r.environment,
          pepperVersion: Number(r.pepper_version),
          keyRateLimitPerMin: r.key_limit === null ? null : Number(r.key_limit),
          clientRateLimitPerMin: Number(r.client_limit),
          monthlyQuota: r.monthly_quota === null ? null : Number(r.monthly_quota),
          license: r.license,
          validFrom: r.valid_from,
          validTo: r.valid_to,
          revokedAt: r.revoked_at,
          suspendedAt: r.suspended_at,
        });
      }

      // Kontrola rozsadku wzorowana na kontrolach jakosci ETL: nagly ubytek
      // kluczy to objaw zlego polaczenia albo niedokonczonej migracji, a nie
      // decyzji operatora. Stara replika zostaje - lepiej dzialac na danych
      // sprzed minuty niz odciac wszystkich klientow.
      const spadek = this.loaded && this.entries.size > 0
        ? (1 - fresh.size / this.entries.size) * 100
        : 0;
      const threshold = this.cfg.maxSpadekProc ?? 50;
      if (spadek > threshold) {
        this.errorCount++;
        this.cfg.onError?.(
          new Error(`Przeladowanie zmniejszylo rejestr o ${spadek.toFixed(0)}% ` +
            `(${this.entries.size} -> ${fresh.size}) - odrzucone, zostaje poprzednia replika`),
          'kontrola rozsadku');
        return false;
      }

      // Podmiana REFERENCJI, nigdy czyszczenie mapy w miejscu: trwajace
      // zadania dokoncza sie na spojnym stanie.
      this.entries = fresh;
      this.stamp = z.stamp;
      this.lastSuccessMs = Date.now();
      this.loaded = true;
      this.refreshCount++;
      return true;
    } catch (e) {
      this.errorCount++;
      throw e;
    } finally {
      this.refreshInFlight = false;
    }
  }

  private scheduleRefresh(): void {
    const period = this.cfg.refreshMs ?? 10_000;
    if (period <= 0) return;
    // Jitter +/-25%: bez niego wszystkie pody odswiezaja sie w tej samej
    // milisekundzie po wdrozeniu kroczacym i baza dostaje falami.
    const withJitter = Math.round(period * (0.75 + Math.random() * 0.5));
    this.timer = setInterval(() => {
      void this.refresh().catch((e) => this.cfg.onError?.(e as Error, 'refresh'));
    }, withJitter);
    this.timer.unref();
  }

}
