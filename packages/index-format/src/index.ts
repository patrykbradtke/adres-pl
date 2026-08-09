/**
 * Format binarny artefaktu indeksu wyszukiwania.
 *
 * DLACZEGO ARTEFAKT, A NIE ZAPYTANIA DO BAZY:
 *
 * Zmierzone na zbiorze o ksztalcie PRG (8,5 mln punktow):
 *   pg_trgm + ORDER BY similarity()  -> 4 922 ms   (nie nadaje sie)
 *   pg_trgm GIN, LIKE, 14 znakow     ->   117 ms   (rosnie z dlugoscia zapytania)
 *   indeks w pamieci, 373k etykiet   -> 0,3-0,7 ms (p99 6,7 ms)
 *
 * Klucz: NIE indeksujemy 8,5 mln pelnych adresow, tylko 373k etykiet
 * (miejscowosci + ulice). Numery domow zostaja w Postgresie - po wybraniu
 * ulicy jest ich 20-300 i wystarczy B-tree (0,22 ms).
 *
 * Artefakt jest NIEMUTOWALNY i WERSJONOWANY. Pody API pobieraja go przy
 * starcie. Skutki: skalowanie poziome bez wspoldzielonego stanu, rollback
 * przez zmiane wskaznika wersji, determinizm testow regresyjnych.
 *
 * UKLAD PLIKU
 *   magic       4B   'APL1'
 *   headerLen   4B   uint32 LE
 *   header      JSON (UTF-8) - metadane + offsety sekcji
 *   sekcje      w kolejnosci zadeklarowanej w naglowku
 */

export const MAGIC = 'APL1';
/**
 * 2 (9.08.2026): doszlo pole PUNKTOW_MIEJSCOWOSCI. Artefakty w wersji 1 nie
 * daja sie wczytac - przy podniesieniu wersji przebudowac artefakt.
 */
export const FORMAT_VERSION = 2;

/** Liczba pol int32 na jeden dokument w sekcji `docs`. */
export const DOC_STRIDE = 11;

export const DOC = {
  TYPE: 0,          // 0 = miejscowosc, 1 = ulica
  SIMC: 1,          // SIMC jako liczba (wiodace zera odtwarzane przy odczycie)
  ULIC_ID: 2,       // -1 dla miejscowosci
  PUNKTOW: 3,       // liczba punktow adresowych - proxy popularnosci w rankingu
  GMINA_IDX: 4,     // indeks w slowniku nazw
  POWIAT_IDX: 5,
  WOJ_IDX: 6,
  FLAGS: 7,         // bit0 = ma_ulice
  LAT_E6: 8,        // lat * 1e6, zaokraglone
  LON_E6: 9,
  /**
   * Liczba punktow adresowych CALEJ MIEJSCOWOSCI, nie samej ulicy.
   *
   * Dla ulic PUNKTOW mowi, ile adresow ma ta konkretna ulica - a to slaby
   * sygnal waznosci: ulica we wsi potrafi miec ich tyle samo, co fragment
   * ulicy w miescie. Zapytanie "marszalkowska" dawalo Cmolas (67 punktow)
   * i Warszawe (70) w praktycznym remisie, choc miejscowosci roznia sie
   * o trzy rzedy wielkosci. To pole dostarcza brakujacy kontekst.
   *
   * Dla miejscowosci rowne PUNKTOW.
   */
  PUNKTOW_MIEJSCOWOSCI: 10,
} as const;

export const FLAG_MA_ULICE = 1;

export interface ArtifactHeader {
  format: number;
  /** Wersja danych = data zrzutu + skrot. Ta sama wartosc trafia do /v1/meta. */
  dataVersion: string;
  builtAt: string;
  counts: {
    docs: number;
    keys: number;
    localities: number;
    streets: number;
    /** Laczna liczba punktow adresowych w bazie - do sanity check po stronie API. */
    addressPoints: number;
  };
  sections: Record<SectionName, { offset: number; length: number }>;
}

export type SectionName =
  /** Blob UTF-8 z etykietami wyswietlanymi, sklejonymi bez separatora. */
  | 'labels'
  /** Int32Array(n+1) - offsety poczatkow etykiet w blobie. */
  | 'labelOffsets'
  /**
   * Znormalizowane etykiety (lower, bez diakrytykow) - liczone RAZ przy budowie.
   * Bez tego silnik wolalby normalizeText() dla kazdego z max 400 kandydatow
   * przy kazdym nacisnieciu klawisza: zmierzone 3,2 ms zamiast 0,2 ms.
   * Koszt: +~8 MB artefaktu. Oplaca sie bezdyskusyjnie.
   */
  | 'normLabels'
  | 'normLabelOffsets'
  /** Int32Array(n * DOC_STRIDE) - metadane dokumentow. */
  | 'docs'
  /** Blob UTF-8 z posortowanymi kluczami rotacyjnymi. */
  | 'keys'
  /** Int32Array(k+1) - offsety kluczy. */
  | 'keyOffsets'
  /** Int32Array(k) - docId dla kazdego klucza. */
  | 'keyDocs'
  /** Blob UTF-8 ze slownikiem nazw gmin/powiatow/wojewodztw. */
  | 'dict'
  /** Int32Array(d+1) - offsety slownika. */
  | 'dictOffsets';

export const SECTION_ORDER: SectionName[] = [
  'labels', 'labelOffsets', 'normLabels', 'normLabelOffsets',
  'docs', 'keys', 'keyOffsets', 'keyDocs', 'dict', 'dictOffsets',
];

/** Slownik stringow z deduplikacja - nazwy gmin powtarzaja sie tysiace razy. */
export class StringDict {
  private map = new Map<string, number>();
  private list: string[] = [];

  intern(s: string | null | undefined): number {
    if (!s) return -1;
    const existing = this.map.get(s);
    if (existing !== undefined) return existing;
    const idx = this.list.length;
    this.list.push(s);
    this.map.set(s, idx);
    return idx;
  }

  get size(): number { return this.list.length; }
  get entries(): readonly string[] { return this.list; }
}

/** Skleja stringi w blob + tablice offsetow. */
export function packStrings(items: readonly string[]): { blob: Buffer; offsets: Int32Array } {
  const encoded = items.map((s) => Buffer.from(s, 'utf8'));
  const offsets = new Int32Array(items.length + 1);
  let total = 0;
  for (let i = 0; i < encoded.length; i++) {
    offsets[i] = total;
    total += encoded[i].length;
  }
  offsets[encoded.length] = total;
  return { blob: Buffer.concat(encoded, total), offsets };
}

/**
 * Naglowek ma STALY rozmiar. Dzieki temu offsety sekcji sa znane z gory
 * i serializacja jest jednoprzebiegowa - bez pulapki "dlugosc naglowka
 * zmienia sie po wpisaniu offsetow, ktore od niej zaleza".
 * 4 KiB to z zapasem wiecej, niz potrzeba (realnie ~600 B).
 */
export const HEADER_SIZE = 4096;

export function serializeArtifact(
  header: Omit<ArtifactHeader, 'sections' | 'format'>,
  sections: Record<SectionName, Buffer>,
): Buffer {
  const full: ArtifactHeader = {
    format: FORMAT_VERSION,
    ...header,
    sections: {} as ArtifactHeader['sections'],
  };

  let offset = HEADER_SIZE;
  const chunks: Buffer[] = [];
  for (const name of SECTION_ORDER) {
    // Int32Array wymaga offsetu wyrownanego do 4 B w podkladowym ArrayBuffer
    const pad = (4 - (offset % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
    full.sections[name] = { offset, length: sections[name].length };
    chunks.push(sections[name]);
    offset += sections[name].length;
  }

  const headerJson = Buffer.from(JSON.stringify(full), 'utf8');
  if (headerJson.length + 8 > HEADER_SIZE) {
    throw new Error(`Naglowek nie miesci sie w ${HEADER_SIZE} B (${headerJson.length + 8} B)`);
  }

  const prefix = Buffer.alloc(HEADER_SIZE);
  prefix.write(MAGIC, 0, 'ascii');
  prefix.writeUInt32LE(headerJson.length, 4);
  headerJson.copy(prefix, 8);

  return Buffer.concat([prefix, ...chunks], offset);
}

/** Odczyt naglowka bez ladowania calego artefaktu. */
export function readHeader(buf: Buffer): ArtifactHeader {
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== MAGIC) throw new Error(`Zly magic: "${magic}", oczekiwano "${MAGIC}"`);
  const len = buf.readUInt32LE(4);
  const header = JSON.parse(buf.toString('utf8', 8, 8 + len)) as ArtifactHeader;
  if (header.format !== FORMAT_VERSION) {
    throw new Error(`Wersja formatu ${header.format}, obslugiwana ${FORMAT_VERSION}`);
  }
  return header;
}

/** Widok Int32Array na sekcje - bez kopiowania. */
export function int32View(buf: Buffer, section: { offset: number; length: number }): Int32Array {
  return new Int32Array(buf.buffer, buf.byteOffset + section.offset, section.length / 4);
}

export function bufferFromInt32(arr: Int32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}
