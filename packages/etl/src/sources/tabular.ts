/**
 * Generyczny czytnik zrodel tabelarycznych (CSV / TSV) dla danych adresowych.
 *
 * PO CO OSOBNY MODUL:
 * Zrodla zapasowe - iMPA, otwarte dane miast, eksporty z EMUiA - publikuja
 * dane w plaskich plikach o roznych, nieudokumentowanych ukladach kolumn.
 * Nazwy kolumn zmieniaja sie miedzy gminami i miedzy wydaniami.
 *
 * Zamiast pisac parser per zrodlo, mamy jeden czytnik sterowany PROFILEM:
 * profile to mapa pola docelowego na liste kandydujacych nazw kolumn.
 * Jesli zadna nie pasuje, tryb rozpoznawania pokazuje, co faktycznie jest
 * w pliku - tak samo jak przy GML.
 */
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { parseCsvLine, detectSeparator } from './teryt/format.ts';

/** Pola, ktore potrafimy wykorzystac. Wszystkie opcjonalne poza numerem. */
export type AddressField =
  | 'id' | 'simc' | 'locality' | 'localityPart'
  | 'symUl' | 'streetType' | 'street'
  | 'buildingNumber' | 'unitNumber' | 'postalCode'
  | 'terc' | 'gmina' | 'powiat' | 'voivodeship'
  | 'x' | 'y' | 'lat' | 'lon' | 'srid'
  | 'status' | 'updatedAt';

export interface TabularProfile {
  name: string;
  /** Pole docelowe -> kandydujace nazwy kolumn (bez rozroznienia wielkosci liter). */
  columns: Partial<Record<AddressField, string[]>>;
  /** Domyslny uklad wspolrzednych, gdy plik go nie podaje. */
  defaultSrid?: number;
  separator?: string;
}

export interface TabularRow {
  raw: Record<string, string>;
  get(field: AddressField): string | undefined;
  num(field: AddressField): number | undefined;
}

export interface TabularStats {
  rows: number;
  /** Kolumny obecne w pliku. */
  columns: string[];
  /** Pola profilu, dla ktorych NIE znaleziono kolumny. */
  brakujace: AddressField[];
  /** Kolumny pliku, ktorych profile nie wykorzystuje. */
  unused: string[];
  separator: string;
}

/** Normalizacja nazwy kolumny do porownania: bez BOM, wielkosci liter i separatorow. */
function normHeader(h: string): string {
  return h
    .replace(/^﻿/, '')
    .trim()
    .toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/Ł/g, 'L')
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Czyta plik tabelaryczny strumieniowo, mapujac kolumny wg profilu.
 *
 * Strumieniowo, bo pliki iMPA dla calego kraju maja ~100 MB, a dla
 * pojedynczych gmin bywaja setki plikow.
 */
export async function readTabular(
  input: Readable,
  profile: TabularProfile,
  onRow: (row: TabularRow, index: number) => void | Promise<void>,
  opts: { limit?: number } = {},
): Promise<TabularStats> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  let header: string[] | null = null;
  let sep = profile.separator ?? ';';
  let index = 0;
  const stats: TabularStats = {
    rows: 0, columns: [], brakujace: [], unused: [], separator: sep,
  };
  /** pole docelowe -> indeks kolumny */
  let mapping = new Map<AddressField, number>();

  for await (const line of rl) {
    if (line.trim().length === 0) continue;

    if (header === null) {
      sep = profile.separator ?? detectSeparator(line);
      stats.separator = sep;
      header = parseCsvLine(line, sep);
      stats.columns = header.map((h) => h.replace(/^﻿/, '').trim());

      const byNorm = new Map<string, number>();
      header.forEach((h, i) => byNorm.set(normHeader(h), i));

      const uzyte = new Set<number>();
      for (const [field, candidates] of Object.entries(profile.columns) as Array<[AddressField, string[]]>) {
        let found = -1;
        for (const c of candidates) {
          const i = byNorm.get(normHeader(c));
          if (i !== undefined) { found = i; break; }
        }
        if (found >= 0) { mapping.set(field, found); uzyte.add(found); }
        else stats.brakujace.push(field);
      }
      stats.unused = stats.columns.filter((_, i) => !uzyte.has(i));
      continue;
    }

    const cols = parseCsvLine(line, sep);
    const row: TabularRow = {
      raw: Object.fromEntries(header.map((h, i) => [h, cols[i] ?? ''])),
      get(field) {
        const i = mapping.get(field);
        if (i === undefined) return undefined;
        const v = cols[i];
        return v === undefined || v === '' ? undefined : v.trim();
      },
      num(field) {
        const v = this.get(field);
        if (v === undefined) return undefined;
        // pliki polskie czesto uzywaja przecinka jako separatora dziesietnego
        const n = Number(v.replace(',', '.'));
        return Number.isFinite(n) ? n : undefined;
      },
    };

    await onRow(row, index++);
    stats.rows++;
    if (opts.limit && stats.rows >= opts.limit) break;
  }

  rl.close();
  return stats;
}

/**
 * Tryb rozpoznawania dla zrodel tabelarycznych.
 * Zwraca naglowek i probki wartosci, zeby dalo sie dopisac profile.
 */
export async function discoverTabular(
  input: Readable,
  sampleRows = 5,
): Promise<{ separator: string; columns: Array<{ name: string; samples: string[] }> }> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  let header: string[] | null = null;
  let sep = ';';
  const samples: string[][] = [];

  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    if (header === null) {
      sep = detectSeparator(line);
      header = parseCsvLine(line, sep).map((h) => h.replace(/^﻿/, '').trim());
      continue;
    }
    samples.push(parseCsvLine(line, sep));
    if (samples.length >= sampleRows) break;
  }
  rl.close();

  return {
    separator: sep,
    columns: (header ?? []).map((name, i) => ({
      name,
      samples: samples.map((p) => p[i] ?? '').filter((v) => v !== '').slice(0, 3),
    })),
  };
}

export function formatTabularDiscovery(
  d: Awaited<ReturnType<typeof discoverTabular>>,
  profile?: TabularProfile,
): string {
  const out: string[] = [];
  out.push(`separator: "${d.separator === '\t' ? '\\t' : d.separator}"`);
  out.push('');
  out.push('KOLUMNY W PLIKU:');
  const byNorm = new Map<string, AddressField>();
  if (profile) {
    for (const [f, cands] of Object.entries(profile.columns) as Array<[AddressField, string[]]>) {
      for (const c of cands) byNorm.set(normHeader(c), f);
    }
  }
  for (const k of d.columns) {
    const mapped = byNorm.get(normHeader(k.name));
    const tag = mapped ? `-> ${mapped}` : profile ? '   (nieuzywana)' : '';
    out.push(`  ${k.name.padEnd(28)} ${tag.padEnd(24)} ${k.samples.join(' | ')}`);
  }
  if (profile) {
    const found = new Set(
      d.columns.map((k) => byNorm.get(normHeader(k.name))).filter(Boolean) as AddressField[],
    );
    const brak = (Object.keys(profile.columns) as AddressField[]).filter((f) => !found.has(f));
    if (brak.length) {
      out.push('');
      out.push('POLA PROFILU BEZ ODPOWIEDNIKA W PLIKU:');
      out.push(`  ${brak.join(', ')}`);
      out.push('');
      out.push('  Dopisz brakujace nazwy kolumn do profilu w sources/impa.ts');
      out.push('  albo potwierdz, ze zrodlo faktycznie ich nie zawiera.');
    }
  }
  return out.join('\n');
}
