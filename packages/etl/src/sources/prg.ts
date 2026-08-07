/**
 * Pobieranie danych adresowych PRG z opendata.geoportal.gov.pl.
 *
 * OSTRZEZENIA, KTORE TRZEBA MIEC Z TYLU GLOWY:
 *
 * 1. To NIE JEST udokumentowane API. GUGiK nigdzie nie gwarantuje
 *    stabilnosci tych URL-i. Uzywane produkcyjnie przez gugik2osm
 *    i OpenAddresses, ale to zwyczaj, nie kontrakt.
 *
 * 2. Od 1.09.2026 znika ogolnopolski plik GML - zostaje WYLACZNIE
 *    podzial na wojewodztwa. Pipeline pobierajacy jeden plik krajowy
 *    przestanie dzialac.
 *
 * 3. Dokladne nazwy plikow nowej struktury nie sa opublikowane. Dlatego
 *    wewnatrz archiwum dopasowujemy po WZORCU, a nie po stalej nazwie.
 *
 * 4. Zrzut potrafi cicho zamarznac (czerwiec 2024: 2 tygodnie bez
 *    aktualizacji, wykryte przez firme zewnetrzna) albo byc niekompletny
 *    (marzec 2016: zrzut bez Wroclawia). Samo HTTP 200 nic nie znaczy.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import yauzl from 'yauzl';

export const PRG_BASE = 'https://opendata.geoportal.gov.pl/prg/adresy/';

/** Kody TERYT wojewodztw: 02, 04, ... 32. */
export const WOJEWODZTWA = Array.from({ length: 16 }, (_, i) => String((i + 1) * 2).padStart(2, '0'));

export const WOJ_NAZWY: Record<string, string> = {
  '02': 'dolnoslaskie', '04': 'kujawsko-pomorskie', '06': 'lubelskie', '08': 'lubuskie',
  '10': 'lodzkie', '12': 'malopolskie', '14': 'mazowieckie', '16': 'opolskie',
  '18': 'podkarpackie', '20': 'podlaskie', '22': 'pomorskie', '24': 'slaskie',
  '26': 'swietokrzyskie', '28': 'warminsko-mazurskie', '30': 'wielkopolskie', '32': 'zachodniopomorskie',
};

export function wojewodztwoUrl(kod: string): string {
  return `${PRG_BASE}${kod}_Punkty_Adresowe.zip`;
}

export interface ProbeResult {
  url: string;
  ok: boolean;
  status: number;
  etag?: string;
  lastModified?: string;
  contentLength?: number;
  /** true, gdy nagłowki roznia sie od zapisanych - warto pobrac. */
  changed: boolean;
  /** Serwer nie zwrocil ani ETag, ani Last-Modified - probe bezuzyteczny. */
  headersUseless: boolean;
}

/**
 * Tani sondaz przed pobraniem ~60 MB (na wojewodztwo) lub ~900 MB (calosc).
 *
 * UWAGA: nie zostalo potwierdzone, czy serwer GUGiK zwraca ETag/Last-Modified.
 * Jesli nie - `headersUseless` bedzie true i trzeba zejsc na harmonogram
 * tygodniowy + hash pobranego pliku. To pierwsza rzecz do sprawdzenia
 * empirycznie przy wdrozeniu.
 */
export async function probe(
  url: string,
  previous?: { etag?: string; lastModified?: string; contentLength?: number },
): Promise<ProbeResult> {
  const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  const etag = res.headers.get('etag') ?? undefined;
  const lastModified = res.headers.get('last-modified') ?? undefined;
  const lenRaw = res.headers.get('content-length');
  const contentLength = lenRaw ? Number(lenRaw) : undefined;

  const headersUseless = !etag && !lastModified;
  let changed = true;
  if (previous && !headersUseless) {
    changed =
      (etag !== undefined && etag !== previous.etag) ||
      (lastModified !== undefined && lastModified !== previous.lastModified) ||
      (contentLength !== undefined && contentLength !== previous.contentLength);
  }

  return { url, ok: res.ok, status: res.status, etag, lastModified, contentLength, changed, headersUseless };
}

export interface DownloadResult {
  path: string;
  bytes: number;
  sha256: string;
}

/** Pobiera plik do archiwum lokalnego, licząc sha256 w locie. */
export async function download(url: string, destPath: string): Promise<DownloadResult> {
  await mkdir(dirname(destPath), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Pobranie ${url}: HTTP ${res.status}`);

  const hash = createHash('sha256');
  let bytes = 0;
  const source = Readable.fromWeb(res.body as any);
  source.on('data', (c: Buffer) => { hash.update(c); bytes += c.length; });
  await pipeline(source, createWriteStream(destPath));

  return { path: destPath, bytes, sha256: hash.digest('hex') };
}

export interface ZipEntry {
  name: string;
  size: number;
  open: () => Promise<Readable>;
}

/**
 * Otwiera archiwum i zwraca wpisy pasujace do wzorca.
 *
 * Wzorzec, NIE stala nazwa - bo nazwy plikow nowej struktury nie sa znane.
 * Do 1.09.2026 paczka zawiera rownolegle plik stary i nowy (z prefiksem
 * `NOWE_`), wiec `preferNew` decyduje, ktory brac.
 */
export async function listZipEntries(
  zipPath: string,
  pattern: RegExp = /\.(gml|xml)$/i,
): Promise<ZipEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('nie udalo sie otworzyc archiwum'));
      const entries: ZipEntry[] = [];
      zip.on('entry', (entry) => {
        if (pattern.test(entry.fileName)) {
          entries.push({
            name: entry.fileName,
            size: entry.uncompressedSize,
            open: () =>
              new Promise<Readable>((res2, rej2) => {
                zip.openReadStream(entry, (e, stream) => (e || !stream ? rej2(e) : res2(stream)));
              }),
          });
        }
        zip.readEntry();
      });
      zip.on('end', () => resolve(entries));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

/**
 * Wybiera wlasciwy plik GML z archiwum.
 *
 * Do 1.09.2026 preferujemy `NOWE_*` (nowa struktura), bo na niej ma
 * dzialac produkcja. Stary plik zostaje w archiwum jako zrodlo atrybutow,
 * ktore znikaja: `status`, `numerLokalu`, `jednostkaAdministracyjna`.
 */
export function pickGmlEntry(entries: ZipEntry[], preferNew = true): ZipEntry | undefined {
  if (entries.length === 0) return undefined;
  const nowe = entries.filter((e) => /(^|\/)NOWE_/i.test(e.name));
  const stare = entries.filter((e) => !/(^|\/)NOWE_/i.test(e.name));
  const pool = preferNew ? (nowe.length ? nowe : stare) : (stare.length ? stare : nowe);
  return pool.sort((a, b) => b.size - a.size)[0];
}

export function archivePath(root: string, wojewodztwo: string, wersja: string): string {
  return join(root, 'prg', wersja, `${wojewodztwo}_Punkty_Adresowe.zip`);
}

export async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}
