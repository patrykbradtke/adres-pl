/**
 * Nasluch kanalu powiadomien Postgresa, z ponawianiem polaczenia.
 *
 * DLACZEGO OSOBNY MODUL
 *
 * Rejestr kluczy odpowiada za STAN repliki. Utrzymanie polaczenia - nawiazanie,
 * wykrycie zerwania, ponawianie z narastajacym odstepem, wymuszone przeladowanie
 * po powrocie - to wlasny stan i wlasny harmonogram, ktore z tamtym stanem nie
 * maja nic wspolnego poza jednym wywolaniem zwrotnym.
 *
 * DLACZEGO WLASNE POLACZENIE, POZA PULA
 *
 * Pula recyklinguje polaczenia, wiec LISTEN zalozony na polaczeniu z puli
 * zniknalby przy pierwszym oddaniu go z powrotem - i zniknalby CICHO. Do tego
 * przy PG_POOL_MAX=10 trwale zajecie jednego polaczenia to 10% pojemnosci puli
 * odebranej obsludze zadan.
 *
 * DLACZEGO POWIADOMIENIA NIE WYSTARCZAJA SAME
 *
 * NOTIFY ginie przy zerwaniu polaczenia, restarcie bazy i przelaczeniu na
 * replike. Ginie przy tym BEZSZELESTNIE: uniewazniony klucz po prostu dziala
 * dalej, a nic tego nie sygnalizuje. Dlatego ten modul jest wylacznie
 * PRZYSPIESZACZEM, a gwarancje daje odpytywanie po stronie rejestru.
 *
 * Po kazdym PRZYWROCENIU nasluchu wolamy onReconnect: powiadomienia z czasu
 * przerwy przepadly bezpowrotnie, wiec jedynym poprawnym zachowaniem jest pelne
 * przeladowanie stanu.
 */
import pg from 'pg';

export interface NotifyListenerConfig {
  connectionString: string;
  channel: string;
  /** Wolane przy kazdym powiadomieniu. */
  onNotification: () => void;
  /** Wolane po PRZYWROCENIU nasluchu - stan trzeba przeladowac w calosci. */
  onReconnect: () => void;
  onError?: (err: Error, where: string) => void;
  onInfo?: (msg: string) => void;
}

export class NotifyListener {
  private cfg: NotifyListenerConfig;
  private client: pg.Client | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  notificationCount = 0;
  retryCount = 0;

  // Jawne przypisanie zamiast parameter property - tryb strip-only nie generuje
  // kodu przypisania (patrz komentarz przy konstruktorze IndexHolder).
  constructor(cfg: NotifyListenerConfig) {
    this.cfg = cfg;
  }

  get connected(): boolean {
    return this.client !== null;
  }

  /** Niepowodzenie NIE jest bledem krytycznym - planuje retryTimer i wraca. */
  async start(): Promise<void> {
    await this.connect(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const k = this.client;
    this.client = null;
    if (k) void k.end().catch(() => { /* zamykamy, blad bez znaczenia */ });
  }

  private async connect(attempt: number): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.cfg.connectionString });
    try {
      await client.connect();
      client.on('notification', () => {
        this.notificationCount++;
        this.cfg.onNotification();
      });
      client.on('error', (e) => {
        this.cfg.onError?.(e, 'listener');
        void this.drop();
      });
      await client.query(`LISTEN ${this.cfg.channel}`);
      this.client = client;

      if (attempt > 0) {
        this.cfg.onInfo?.('Nasluch przywrocony - pelne przeladowanie stanu');
        this.cfg.onReconnect();
      }
    } catch (e) {
      await client.end().catch(() => { /* i tak nie wstalo */ });
      if (this.stopped) return;
      this.cfg.onError?.(e as Error, 'podlaczenie nasluchu');
      this.scheduleRetry(attempt);
    }
  }

  private async drop(): Promise<void> {
    if (this.stopped || this.client === null) return;
    const k = this.client;
    this.client = null;
    await k.end().catch(() => { /* juz zerwane */ });
    this.scheduleRetry(0);
  }

  /**
   * Odstep narastajacy wykladniczo do 30 s, z jitterem +/-25%.
   *
   * Jitter nie jest ozdoba: bez niego wszystkie instancje, ktore stracily
   * polaczenie w tej samej chwili (bo baza sie restartowala), wracaja do niej
   * rownoczesnie i dokladaja szczyt obciazenia dokladnie wtedy, gdy wstaje.
   */
  private scheduleRetry(attempt: number): void {
    if (this.stopped) return;
    this.retryCount++;
    const basis = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
    const delay = Math.round(basis * (0.75 + Math.random() * 0.5));
    this.retryTimer = setTimeout(() => { void this.connect(attempt + 1); }, delay);
    this.retryTimer.unref();
  }
}
