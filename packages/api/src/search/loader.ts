/**
 * Ladowanie i gorąca podmiana artefaktu indeksu.
 *
 * MODEL: pod API jest BEZSTANOWY wzgledem danych. Przy starcie pobiera
 * artefakt (z dysku, S3/MinIO albo HTTP), laduje do RAM i serwuje.
 *
 * Podmiana wersji bez restartu:
 *   1. pobierz nowy artefakt obok starego
 *   2. zbuduj SearchIndex
 *   3. przestaw wskaznik (atomowe przypisanie referencji w JS)
 *   4. stary indeks zbiera GC, gdy skoncza sie trwajace zapytania
 * Zero downtime, zero koordynacji miedzy podami.
 */
import { readFile } from 'node:fs/promises';
import { SearchIndex } from './engine.ts';

export interface LoaderConfig {
  /** Sciezka lokalna albo URL http(s) do artefaktu. */
  source: string;
  /**
   * Wskaznik biezacej wersji - plik JSON `{ "current": "idx-2026-08-05-ab12.bin" }`.
   * Gdy podany, loader odpytuje go cyklicznie i podmienia indeks po zmianie.
   */
  pointer?: string;
  /** Co ile sprawdzac wskaznik. 0 = nie sprawdzac. */
  pollIntervalMs?: number;
  onSwap?: (from: string | undefined, to: string) => void;
  onError?: (err: Error) => void;
}

export class IndexHolder {
  private index: SearchIndex | null = null;
  private timer: NodeJS.Timeout | null = null;
  private loading = false;
  private cfg: LoaderConfig;
  /** Sciezka artefaktu, ktory faktycznie siedzi w pamieci. */
  private loadedFrom: string | null = null;

  // Jawne przypisanie zamiast parameter property - Node w trybie
  // --experimental-strip-types wycina tylko typy i nie generuje kodu,
  // wiec `constructor(private cfg)` nie zadziala bez kroku kompilacji.
  constructor(cfg: LoaderConfig) {
    this.cfg = cfg;
  }

  get current(): SearchIndex {
    if (!this.index) throw new Error('Indeks nie jest zaladowany');
    return this.index;
  }

  get ready(): boolean { return this.index !== null; }

  async start(): Promise<void> {
    // Wskaznik jest zrodlem prawdy o biezacej wersji, wiec pytamy o niego
    // juz przy starcie - inaczej pod wstawal na `source` i dopiero pierwszy
    // cykl pollingu (domyslnie po minucie) przestawial go na wlasciwy
    // artefakt. Gdy wskaznika nie ma albo jest niepoprawny, zostaje `source`.
    const zrodlo = await this.rozwiazZrodlo();
    try {
      await this.load(zrodlo);
    } catch (e) {
      // Wskaznik moze pokazywac na artefakt, ktorego jeszcze nie ma obok
      // (np. replikacja z S3 w toku). Lepiej wstac na starszym artefakcie
      // i podmienic go przy najblizszym pollingu, niz nie wstac wcale.
      if (zrodlo === this.cfg.source) throw e;
      this.cfg.onError?.(e as Error);
      await this.load(this.cfg.source);
    }
    const interval = this.cfg.pollIntervalMs ?? 0;
    if (this.cfg.pointer && interval > 0) {
      this.timer = setInterval(() => { void this.checkPointer(); }, interval);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Sciezka artefaktu wskazana przez wskaznik, albo `source` jako zapasowa. */
  private async rozwiazZrodlo(): Promise<string> {
    if (!this.cfg.pointer) return this.cfg.source;
    try {
      const { current } = JSON.parse(await fetchText(this.cfg.pointer)) as { current?: string };
      if (current) return resolveSibling(this.cfg.source, current);
    } catch (e) {
      this.cfg.onError?.(e as Error);
    }
    return this.cfg.source;
  }

  private async checkPointer(): Promise<void> {
    if (this.loading || !this.cfg.pointer) return;
    try {
      const raw = await fetchText(this.cfg.pointer);
      const { current, dataVersion } = JSON.parse(raw) as { current: string; dataVersion?: string };
      if (!current) return;
      const wanted = resolveSibling(this.cfg.source, current);

      // Porownanie musi isc po TYCH SAMYCH wielkosciach po obu stronach.
      //
      // Bylo: `this.index.dataVersion === current`, czyli wersja danych
      // ("2026-08-06") zestawiana z nazwa pliku ("idx-2026-08-06.bin").
      // Te dwie wartosci nie moga byc rowne nigdy, wiec warunek nie zatrzymywal
      // niczego i instancja przeladowywala artefakt przy KAZDYM odpytaniu
      // wskaznika - co 60 s pelny odczyt i parsowanie 109 MB, bez zmiany wersji.
      // W logu bylo to widoczne jako "podmieniono artefakt" z 2026-08-06
      // na 2026-08-06 w kolko. Wykryte dopiero po podpieciu monitoringu.
      const tenSamPlik = this.loadedFrom === wanted;
      const taSamaWersja = !dataVersion || this.index?.dataVersion === dataVersion;
      if (this.index && tenSamPlik && taSamaWersja) return;

      await this.load(wanted);
    } catch (e) {
      this.cfg.onError?.(e as Error);
    }
  }

  private async load(source: string): Promise<void> {
    this.loading = true;
    try {
      const buf = await fetchBuffer(source);
      const next = new SearchIndex(buf);
      const prev = this.index?.dataVersion;
      // Atomowe z punktu widzenia petli zdarzen Node - trwajace zapytania
      // dokoncza sie na starym indeksie.
      this.index = next;
      this.loadedFrom = source;
      this.cfg.onSwap?.(prev, next.dataVersion);
    } finally {
      this.loading = false;
    }
  }
}

async function fetchBuffer(source: string): Promise<Buffer> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Pobranie artefaktu ${source}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return readFile(source);
}

async function fetchText(source: string): Promise<string> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Pobranie wskaznika ${source}: HTTP ${res.status}`);
    return res.text();
  }
  return (await readFile(source)).toString('utf8');
}

function resolveSibling(source: string, filename: string): string {
  const idx = Math.max(source.lastIndexOf('/'), source.lastIndexOf('\\'));
  return idx < 0 ? filename : source.slice(0, idx + 1) + filename;
}
