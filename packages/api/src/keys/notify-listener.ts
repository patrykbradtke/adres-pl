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
 * Po kazdym PRZYWROCENIU nasluchu wolamy onPrzywrocenie: powiadomienia z czasu
 * przerwy przepadly bezpowrotnie, wiec jedynym poprawnym zachowaniem jest pelne
 * przeladowanie stanu.
 */
import pg from 'pg';

export interface NotifyListenerConfig {
  connectionString: string;
  kanal: string;
  /** Wolane przy kazdym powiadomieniu. */
  onPowiadomienie: () => void;
  /** Wolane po PRZYWROCENIU nasluchu - stan trzeba przeladowac w calosci. */
  onPrzywrocenie: () => void;
  onError?: (err: Error, gdzie: string) => void;
  onInfo?: (msg: string) => void;
}

export class NotifyListener {
  private cfg: NotifyListenerConfig;
  private klient: pg.Client | null = null;
  private ponowienie: NodeJS.Timeout | null = null;
  private zatrzymany = false;

  liczbaPowiadomien = 0;
  liczbaPonowien = 0;

  // Jawne przypisanie zamiast parameter property - tryb strip-only nie generuje
  // kodu przypisania (patrz komentarz przy konstruktorze IndexHolder).
  constructor(cfg: NotifyListenerConfig) {
    this.cfg = cfg;
  }

  get podlaczony(): boolean {
    return this.klient !== null;
  }

  /** Niepowodzenie NIE jest bledem krytycznym - planuje ponowienie i wraca. */
  async start(): Promise<void> {
    await this.podlacz(0);
  }

  stop(): void {
    this.zatrzymany = true;
    if (this.ponowienie) { clearTimeout(this.ponowienie); this.ponowienie = null; }
    const k = this.klient;
    this.klient = null;
    if (k) void k.end().catch(() => { /* zamykamy, blad bez znaczenia */ });
  }

  private async podlacz(proba: number): Promise<void> {
    if (this.zatrzymany) return;
    const klient = new pg.Client({ connectionString: this.cfg.connectionString });
    try {
      await klient.connect();
      klient.on('notification', () => {
        this.liczbaPowiadomien++;
        this.cfg.onPowiadomienie();
      });
      klient.on('error', (e) => {
        this.cfg.onError?.(e, 'nasluch');
        void this.zerwij();
      });
      await klient.query(`LISTEN ${this.cfg.kanal}`);
      this.klient = klient;

      if (proba > 0) {
        this.cfg.onInfo?.('Nasluch przywrocony - pelne przeladowanie stanu');
        this.cfg.onPrzywrocenie();
      }
    } catch (e) {
      await klient.end().catch(() => { /* i tak nie wstalo */ });
      if (this.zatrzymany) return;
      this.cfg.onError?.(e as Error, 'podlaczenie nasluchu');
      this.zaplanujPonowienie(proba);
    }
  }

  private async zerwij(): Promise<void> {
    if (this.zatrzymany || this.klient === null) return;
    const k = this.klient;
    this.klient = null;
    await k.end().catch(() => { /* juz zerwane */ });
    this.zaplanujPonowienie(0);
  }

  /**
   * Odstep narastajacy wykladniczo do 30 s, z jitterem +/-25%.
   *
   * Jitter nie jest ozdoba: bez niego wszystkie instancje, ktore stracily
   * polaczenie w tej samej chwili (bo baza sie restartowala), wracaja do niej
   * rownoczesnie i dokladaja szczyt obciazenia dokladnie wtedy, gdy wstaje.
   */
  private zaplanujPonowienie(proba: number): void {
    if (this.zatrzymany) return;
    this.liczbaPonowien++;
    const podstawa = Math.min(30_000, 1_000 * 2 ** Math.min(proba, 5));
    const odstep = Math.round(podstawa * (0.75 + Math.random() * 0.5));
    this.ponowienie = setTimeout(() => { void this.podlacz(proba + 1); }, odstep);
    this.ponowienie.unref();
  }
}
