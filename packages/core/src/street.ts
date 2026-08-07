/**
 * Cechy ulic (prefiksy rodzajowe) i normalizacja nazw ulic.
 *
 * W TERYT/ULIC nazwa jest rozbita na CECHA + NAZWA_1 + NAZWA_2.
 * W modelu EMUiA 2021 odpowiada temu `rodzaj` + `TERYTNazwa1` + `TERYTNazwa2`,
 * a pelna nazwa siedzi w `nazwaPelna`.
 */

export interface StreetPrefix {
  /** Forma kanoniczna do zapisu. */
  canonical: string;
  /** Pelna nazwa rodzaju (zgodna ze slownikiem AD_RodzajObiektu). */
  full: string;
  /** Warianty akceptowane na wejsciu (znormalizowane). */
  variants: string[];
}

export const STREET_PREFIXES: StreetPrefix[] = [
  { canonical: 'ul.',    full: 'ulica',    variants: ['ul', 'ulica', 'ulicy', 'ulic'] },
  { canonical: 'al.',    full: 'aleja',    variants: ['al', 'aleja', 'aleje', 'alei', 'aleji'] },
  { canonical: 'pl.',    full: 'plac',     variants: ['pl', 'plac', 'placu'] },
  { canonical: 'os.',    full: 'osiedle',  variants: ['os', 'osiedle', 'osiedla', 'oś'] },
  { canonical: 'rondo',  full: 'rondo',    variants: ['rondo', 'ronda', 'ryn'] },
  { canonical: 'skwer',  full: 'skwer',    variants: ['skwer', 'skweru', 'skw'] },
  { canonical: 'park',   full: 'park',     variants: ['park', 'parku'] },
  { canonical: 'rynek',  full: 'rynek',    variants: ['rynek', 'rynku'] },
  { canonical: 'bulw.',  full: 'bulwar',   variants: ['bulw', 'bulwar', 'bulwary', 'bulwaru'] },
  { canonical: 'wyb.',   full: 'wybrzeze', variants: ['wyb', 'wybrzeze', 'wybrzeza'] },
  { canonical: 'ogr.',   full: 'ogrod',    variants: ['ogr', 'ogrod', 'ogrody'] },
  { canonical: 'wyspa',  full: 'wyspa',    variants: ['wyspa', 'wyspy'] },
  { canonical: 'szosa',  full: 'szosa',    variants: ['szosa', 'szosy'] },
  { canonical: 'droga',  full: 'droga',    variants: ['droga', 'drogi', 'dr'] },
  { canonical: 'wawoz',  full: 'wawoz',    variants: ['wawoz', 'wawozu'] },
];

const VARIANT_MAP = new Map<string, StreetPrefix>();
for (const p of STREET_PREFIXES) {
  for (const v of p.variants) VARIANT_MAP.set(v, p);
}

/**
 * Wydziela cechy z poczatku nazwy ulicy.
 * `"ulica Marszalkowska"` -> `{ cecha: 'ul.', nazwa: 'Marszalkowska' }`
 */
export function splitStreetPrefix(input: string): { cecha?: string; nazwa: string } {
  const trimmed = input.trim();
  const m = trimmed.match(/^([A-Za-zÀ-ɏ]+)\.?\s+(.+)$/);
  if (!m) return { nazwa: trimmed };

  const head = m[1]
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l');
  const prefix = VARIANT_MAP.get(head);
  if (!prefix) return { nazwa: trimmed };
  return { cecha: prefix.canonical, nazwa: m[2].trim() };
}

/**
 * Tytuly, stopnie i skroty wystepujace w nazwach patronackich.
 * Sluza do wyliczenia formy potocznej: "gen. Wladyslawa Andersa" -> "Andersa".
 */
const HONORIFICS = new Set([
  'gen', 'plk', 'ppłk', 'pplk', 'mjr', 'kpt', 'por', 'ppor', 'sierz', 'kpr',
  'marsz', 'adm', 'kmdr', 'ks', 'bp', 'abp', 'kard', 'sw', 'o', 'br', 'siostry',
  'prof', 'dr', 'hab', 'inz', 'mgr', 'red', 'gm', 'krola', 'krolowej',
  'prezydenta', 'premiera', 'ministra', 'papieza', 'biskupa', 'hrabiego',
  'ojca', 'matki', 'doktora', 'profesora', 'generala', 'pulkownika', 'majora',
  'kapitana', 'porucznika', 'admirala', 'marszalka', 'swietego', 'swietej',
]);

/** Koncowki typowe dla imion w dopelniaczu (odrzucane przy skracaniu). */
const GIVEN_NAME_ENDINGS = /(?:a|y|i|ego|owej|ow)$/;

/**
 * Forma potoczna nazwy ulicy - to, co uzytkownik faktycznie wpisze.
 *
 * "Tadeusza Kosciuszki"           -> "Kosciuszki"
 * "gen. Wladyslawa Andersa"       -> "Andersa"
 * "Jana Pawla II"                 -> "Jana Pawla II"  (bez zmian, ostatni czlon to liczebnik)
 * "Marszalkowska"                 -> undefined        (jednoczlonowa, nie ma co skracac)
 *
 * Zwraca undefined, gdy skracanie nie ma sensu. Wynik trafia do indeksu
 * JAKO DODATKOWY klucz - nigdy nie zastepuje formy oficjalnej.
 */
export function shortStreetName(nazwa: string): string | undefined {
  const parts = nazwa.trim().split(/\s+/);
  if (parts.length < 2) return undefined;

  const last = parts[parts.length - 1];
  // liczebniki rzymskie / arabskie na koncu: "Jana Pawla II", "3 Maja"
  if (/^(?:[IVXLCDM]+|\d+)$/.test(last)) return undefined;

  // odrzucamy tytuly z przodu
  let start = 0;
  while (start < parts.length - 1) {
    const p = parts[start]
      .replace(/\.$/, '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/ł/g, 'l');
    if (HONORIFICS.has(p)) { start++; continue; }
    break;
  }

  const rest = parts.slice(start);
  if (rest.length < 2) return rest.length === 1 && start > 0 ? rest[0] : undefined;

  // heurystyka: jesli przedostatni czlon wyglada jak imie w dopelniaczu,
  // forma potoczna to sam nazwisko
  const candidate = rest[rest.length - 1];
  const prev = rest[rest.length - 2];
  if (GIVEN_NAME_ENDINGS.test(prev.toLowerCase()) && candidate.length > 3) {
    return candidate;
  }
  return start > 0 ? rest.join(' ') : undefined;
}

/**
 * Warianty liczebnikowe w nazwach ulic - "1 Maja" / "1-go Maja" / "Pierwszego Maja".
 * Generuje dodatkowe klucze do indeksu.
 */
const ORDINALS: Array<[RegExp, string[]]> = [
  [/\b1\s*(?:-?go)?\b/i, ['pierwszego', '1', '1 go']],
  [/\b3\s*(?:-?go)?\b/i, ['trzeciego', '3', '3 go']],
  [/\bpierwszego\b/i, ['1', '1 go']],
  [/\btrzeciego\b/i, ['3', '3 go']],
  [/\bxx\s*-?\s*lecia\b/i, ['20 lecia', 'dwudziestolecia']],
];

export function ordinalVariants(nazwa: string): string[] {
  const out: string[] = [];
  for (const [re, replacements] of ORDINALS) {
    if (re.test(nazwa)) {
      for (const r of replacements) out.push(nazwa.replace(re, r));
    }
  }
  return out;
}
