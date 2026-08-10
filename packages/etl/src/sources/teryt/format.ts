/**
 * Parsowanie katalogow TERYT (GUS).
 *
 * TERYT ma DWA kanaly dostepu i oba trzeba obsluzyc:
 *
 *  1. Pliki z eteryt.stat.gov.pl - bez rejestracji, ale strona to ASP.NET
 *     WebForms z `__doPostBack()`. Nie ma stabilnych URL-i, wiec automatyzacja
 *     jest krucha. Uzywamy do pierwszego zaladunku i jako fallback.
 *
 *  2. Usluga sieciowa (SOAP ws1) - wymaga rejestracji mailowej, ale ma
 *     `DataStanu` (deterministyczne, powtarzalne pobrania) i PLIKI ROZNICOWE,
 *     ktorych PRG nie ma. To jest wlasciwy kanal produkcyjny.
 *
 * Oba zwracaja te same struktury CSV, wiec parsowanie jest wspolne.
 *
 * FORMAT: CSV rozdzielany srednikiem, UTF-8, pierwszy wiersz to naglowek,
 * wartosci moga byc w cudzyslowach.
 */

export type TerytCatalog = 'TERC' | 'SIMC' | 'ULIC' | 'WMRODZ';

/** Wiersz TERC - jednostki podzialu terytorialnego. */
export interface TercRow {
  woj: string;
  pow?: string;
  gmi?: string;
  kind?: string;
  name: string;
  nameAdded: string;
  asOf: string;
  /** Zlozony identyfikator 7-znakowy: WOJ(2) + POW(2) + GMI(2) + RODZ(1). */
  terc: string;
  /** 1 = wojewodztwo, 2 = powiat, 3 = gmina. */
  level: 1 | 2 | 3;
  parentTerc?: string;
}

/** Wiersz SIMC - miejscowosci. */
export interface SimcRow {
  woj: string;
  pow: string;
  gmi: string;
  gminaKind: string;
  /** Rodzaj miejscowosci - kod ze slownika WMRODZ. */
  rm: string;
  /** Czy nazwa jest zwyczajowa (1) czy urzedowa (0). */
  mz: string;
  name: string;
  /** Identyfikator miejscowosci - to jest SIMC. */
  sym: string;
  /** Identyfikator miejscowosci nadrzednej. Rowny `sym` dla miejscowosci samodzielnych. */
  sympod: string;
  asOf: string;
  gminaTerc: string;
}

/** Wiersz ULIC - Centralny Katalog Ulic. */
export interface UlicRow {
  woj: string;
  pow: string;
  gmi: string;
  gminaKind: string;
  /** SIMC miejscowosci, w ktorej lezy ulica. */
  sym: string;
  /** Identyfikator ulicy w katalogu. */
  symUl: string;
  /** Cecha: ul., al., pl., os., rondo... */
  streetType: string;
  /** Czlon glowny nazwy, np. "Kosciuszki". */
  name1: string;
  /** Czlon poprzedzajacy, np. "Tadeusza". Czesto pusty. */
  name2: string;
  asOf: string;
  gminaTerc: string;
  /**
   * Pelna nazwa zlozona z czlonow.
   * UWAGA na kolejnosc: w ULIC `NAZWA_2` to czlon POPRZEDZAJACY
   * (imie, tytul), a `NAZWA_1` to czlon glowny (nazwisko).
   * "Tadeusza Kosciuszki" = NAZWA_2 + NAZWA_1, nie odwrotnie.
   */
  fullName: string;
}

export interface WmrodzRow {
  rm: string;
  nameRemoved: string;
  asOf: string;
}

/**
 * Parser CSV odporny na cudzyslowy i srednik wewnatrz pola.
 * Nie uzywamy zewnetrznej biblioteki - format jest prosty, a zaleznosc
 * w pakiecie ETL to kolejna rzecz do utrzymania.
 */
export function parseCsvLine(line: string, sep = ';'): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === sep) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Rozpoznaje separator - GUS bywa niekonsekwentny miedzy kanalami. */
export function detectSeparator(headerLine: string): string {
  const semi = (headerLine.match(/;/g) ?? []).length;
  const comma = (headerLine.match(/,/g) ?? []).length;
  const tab = (headerLine.match(/\t/g) ?? []).length;
  if (tab > semi && tab > comma) return '\t';
  return comma > semi ? ',' : ';';
}

/** Mapa naglowek -> indeks kolumny, odporna na wielkosc liter i BOM. */
function headerMap(header: string[]): Map<string, number> {
  const m = new Map<string, number>();
  header.forEach((h, i) => {
    m.set(h.replace(/^﻿/, '').toUpperCase().replace(/[^A-Z0-9_]/g, ''), i);
  });
  return m;
}

function pick(cols: string[], m: Map<string, number>, ...names: string[]): string {
  for (const n of names) {
    const i = m.get(n);
    if (i !== undefined && cols[i] !== undefined) return cols[i];
  }
  return '';
}

/**
 * Buduje 7-znakowy identyfikator TERC.
 * WOJ(2) + POW(2) + GMI(2) + RODZ(1), dopelniony spacjami do 7 znakow
 * w postaci uzywanej przez GUS. My normalizujemy do zer wiodacych.
 */
export function buildTerc(woj: string, pow?: string, gmi?: string, kind?: string): string {
  const w = woj.padStart(2, '0');
  if (!pow) return (w + '00000');
  const p = pow.padStart(2, '0');
  if (!gmi) return (w + p + '000');
  const g = gmi.padStart(2, '0');
  const r = (kind ?? '0').padStart(1, '0');
  return w + p + g + r;
}

export function parseTerc(text: string): TercRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const sep = detectSeparator(lines[0]);
  const m = headerMap(parseCsvLine(lines[0], sep));
  const out: TercRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i], sep);
    const woj = pick(c, m, 'WOJ');
    if (!woj) continue;
    const pow = pick(c, m, 'POW') || undefined;
    const gmi = pick(c, m, 'GMI') || undefined;
    const kind = pick(c, m, 'RODZ') || undefined;
    const level: 1 | 2 | 3 = gmi ? 3 : pow ? 2 : 1;

    out.push({
      woj, pow, gmi, kind,
      name: pick(c, m, 'NAZWA'),
      nameAdded: pick(c, m, 'NAZWA_DOD', 'NAZWADOD'),
      asOf: pick(c, m, 'STAN_NA', 'STANNA'),
      terc: buildTerc(woj, pow, gmi, kind),
      level,
      parentTerc: level === 3 ? buildTerc(woj, pow) : level === 2 ? buildTerc(woj) : undefined,
    });
  }
  return out;
}

export function parseSimc(text: string): SimcRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const sep = detectSeparator(lines[0]);
  const m = headerMap(parseCsvLine(lines[0], sep));
  const out: SimcRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i], sep);
    const sym = pick(c, m, 'SYM');
    if (!sym) continue;
    const woj = pick(c, m, 'WOJ');
    const pow = pick(c, m, 'POW');
    const gmi = pick(c, m, 'GMI');
    const gminaKind = pick(c, m, 'RODZ_GMI', 'RODZGMI');

    out.push({
      woj, pow, gmi, gminaKind,
      rm: pick(c, m, 'RM'),
      mz: pick(c, m, 'MZ'),
      name: pick(c, m, 'NAZWA'),
      // SIMC to CharacterString z wiodacymi zerami - NIE parsowac do liczby
      sym: sym.padStart(7, '0'),
      sympod: (pick(c, m, 'SYMPOD') || sym).padStart(7, '0'),
      asOf: pick(c, m, 'STAN_NA', 'STANNA'),
      gminaTerc: buildTerc(woj, pow, gmi, gminaKind),
    });
  }
  return out;
}

export function parseUlic(text: string): UlicRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const sep = detectSeparator(lines[0]);
  const m = headerMap(parseCsvLine(lines[0], sep));
  const out: UlicRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i], sep);
    const symUl = pick(c, m, 'SYM_UL', 'SYMUL');
    if (!symUl) continue;
    const woj = pick(c, m, 'WOJ');
    const pow = pick(c, m, 'POW');
    const gmi = pick(c, m, 'GMI');
    const gminaKind = pick(c, m, 'RODZ_GMI', 'RODZGMI');
    const name1 = pick(c, m, 'NAZWA_1', 'NAZWA1');
    const name2 = pick(c, m, 'NAZWA_2', 'NAZWA2');

    out.push({
      woj, pow, gmi, gminaKind,
      sym: pick(c, m, 'SYM').padStart(7, '0'),
      symUl: symUl.padStart(5, '0'),
      streetType: normalizeStreetType(pick(c, m, 'CECHA')),
      name1, name2,
      asOf: pick(c, m, 'STAN_NA', 'STANNA'),
      gminaTerc: buildTerc(woj, pow, gmi, gminaKind),
      // NAZWA_2 poprzedza NAZWA_1: "Tadeusza" + "Kosciuszki"
      fullName: [name2, name1].filter(Boolean).join(' ').trim(),
    });
  }
  return out;
}

export function parseWmrodz(text: string): WmrodzRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const sep = detectSeparator(lines[0]);
  const m = headerMap(parseCsvLine(lines[0], sep));
  const out: WmrodzRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i], sep);
    const rm = pick(c, m, 'RM');
    if (!rm) continue;
    out.push({ rm, nameRemoved: pick(c, m, 'NAZWA_RM', 'NAZWARM'), asOf: pick(c, m, 'STAN_NA', 'STANNA') });
  }
  return out;
}

/**
 * Ujednolicenie cechy ulicy do formy kanonicznej.
 * GUS zapisuje "ul.", "ULICA", "Ul." - wszystkie oznaczaja to samo.
 */
const STREET_TYPE_MAP: Record<string, string> = {
  UL: 'ul.', STREET: 'ul.',
  AL: 'al.', ALEJA: 'al.', ALEJE: 'al.',
  PL: 'pl.', PLAC: 'pl.',
  OS: 'os.', OSIEDLE: 'os.',
  RONDO: 'rondo', SKWER: 'skwer', PARK: 'park', RYNEK: 'rynek',
  BULW: 'bulw.', BULWAR: 'bulw.',
  WYB: 'wyb.', WYBRZEZE: 'wyb.',
  OGR: 'ogr.', OGROD: 'ogr.',
  WYSPA: 'wyspa', SZOSA: 'szosa', DROGA: 'droga', WAWOZ: 'wawoz',
};

export function normalizeStreetType(raw: string): string {
  const key = raw.trim().replace(/\.$/, '').toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/Ł/g, 'L');
  return STREET_TYPE_MAP[key] ?? raw.trim();
}

/**
 * Parsowanie XML TERYT (alternatywny format plikow GUS).
 * Struktura: <catalog><row><col name="WOJ">14</col>...</row></catalog>
 * Zamieniamy na CSV, zeby dalej isc jedna sciezka kodu.
 */
export function terytXmlToCsv(xml: string): string {
  const rows: string[][] = [];
  let header: string[] | null = null;

  const rowRe = /<row>([\s\S]*?)<\/row>/g;
  const colRe = /<col\s+name="([^"]+)"\s*(?:\/>|>([\s\S]*?)<\/col>)/g;
  let rm: RegExpExecArray | null;

  while ((rm = rowRe.exec(xml)) !== null) {
    const names: string[] = [];
    const values: string[] = [];
    let cm: RegExpExecArray | null;
    colRe.lastIndex = 0;
    while ((cm = colRe.exec(rm[1])) !== null) {
      names.push(cm[1]);
      values.push(decodeXmlEntities(cm[2] ?? '').trim());
    }
    if (!header) header = names;
    rows.push(values);
  }

  if (!header) return '';
  const esc = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [header.join(';'), ...rows.map((r) => r.map(esc).join(';'))].join('\n');
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Auto-detekcja: XML czy CSV. */
export function toCsv(content: string): string {
  return /^\s*<\?xml|<row>/.test(content.slice(0, 500)) ? terytXmlToCsv(content) : content;
}
