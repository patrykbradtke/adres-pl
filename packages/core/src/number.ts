/**
 * Parsowanie i normalizacja numeru budynku / lokalu.
 *
 * To najtrudniejszy element polskiego adresu, bo zapis `12/14` jest
 * strukturalnie dwuznaczny:
 *   - budynek narozny o numerze "12/14"          (Marszalkowska 12/14)
 *   - budynek 12, lokal 14                       (Marszalkowska 12 m. 14)
 * Rozstrzyga WYLACZNIE rejestr: jesli w PRG istnieje punkt o numerze
 * budynku "12/14" przy tej ulicy, to jest to numer budynku.
 *
 * Dlatego parser zwraca interpretacje glowna PLUS alternatywy, a flaga
 * `ambiguous` mowi wolajacemu, ze musi odpytac rejestr o obie.
 */
import type { ParsedNumber } from './types.ts';

const LETTER = 'A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż';

/** Pojedynczy czlon: cyfry + opcjonalna litera. `12`, `12A`, `12 a` */
const PART = new RegExp(`^\\d{1,5}\\s?[${LETTER}]?$`);

/**
 * Numery oznaczajace brak danych albo blad wprowadzenia.
 * Filtr przejety z produkcyjnego pipeline'u gugik2osm.
 */
const RE_GARBAGE = /^(?:b\.?\s?n\.?|bn|brak|nd|n\/d|0+|[-.\s]+)$/i;

/** Jawny separator lokalu. */
const RE_EXPLICIT = new RegExp(
  `^(?<b>.+?)\\s*(?:m\\.?|lok\\.?|mieszk\\.?|mieszkanie)\\s*(?<l>\\d{1,5}\\s?[${LETTER}]?)$`,
  'i',
);

/** Zakres numerow: `12-14` - to zawsze jeden budynek, nigdy lokal. */
const RE_RANGE = new RegExp(`^(\\d{1,5}\\s?[${LETTER}]?)\\s*-\\s*(\\d{1,5}\\s?[${LETTER}]?)$`);

/** Potrojny zapis: `12/14/5` = budynek narozny 12/14, lokal 5. */
const RE_TRIPLE = new RegExp(
  `^(\\d{1,5}\\s?[${LETTER}]?\\s*/\\s*\\d{1,5}\\s?[${LETTER}]?)\\s*/\\s*(\\d{1,5}\\s?[${LETTER}]?)$`,
);

/** Podwojny zapis z ukosnikiem: `12/14`, `12A/5`. */
const RE_SLASH = new RegExp(`^(\\d{1,5}\\s?[${LETTER}]?)\\s*/\\s*(\\d{1,5}\\s?[${LETTER}]?)$`);

/**
 * Rozbija ciag numeryczny na budynek i lokal.
 *
 * | wejscie     | nrBudynku | nrLokalu | ambiguous | alternatywy          |
 * |-------------|-----------|----------|-----------|----------------------|
 * | `12`        | 12        | -        | nie       | -                    |
 * | `12A`       | 12A       | -        | nie       | -                    |
 * | `12-14`     | 12-14     | -        | nie       | -                    |
 * | `12 m. 5`   | 12        | 5        | nie       | -                    |
 * | `12A/5`     | 12A       | 5        | nie       | -                    |
 * | `12/14`     | 12        | 14       | TAK       | budynek `12/14`      |
 * | `12/14/5`   | 12/14     | 5        | nie       | -                    |
 */
export function parseNumber(input: string): ParsedNumber | null {
  const s = input.trim().replace(/\s+/g, ' ');
  if (s.length === 0 || RE_GARBAGE.test(s)) return null;

  // 1. jawny marker lokalu - jednoznaczne
  const explicit = RE_EXPLICIT.exec(s);
  if (explicit?.groups) {
    const b = explicit.groups.b.trim();
    if (isBuildingLike(b)) {
      return {
        buildingNumber: normalizeBuildingNumber(b),
        unitNumber: normalizeUnitNumber(explicit.groups.l),
        ambiguous: false,
      };
    }
  }

  // 2. zakres - zawsze budynek
  if (RE_RANGE.test(s)) {
    return { buildingNumber: normalizeBuildingNumber(s), ambiguous: false };
  }

  // 3. potrojny - budynek narozny + lokal
  const triple = RE_TRIPLE.exec(s);
  if (triple) {
    return {
      buildingNumber: normalizeBuildingNumber(triple[1]),
      unitNumber: normalizeUnitNumber(triple[2]),
      ambiguous: false,
    };
  }

  // 4. podwojny z ukosnikiem - tu mieszka dwuznacznosc
  const slash = RE_SLASH.exec(s);
  if (slash) {
    const left = slash[1].replace(/\s+/g, '');
    const right = slash[2].replace(/\s+/g, '');
    const bothNumeric = /^\d+$/.test(left) && /^\d+$/.test(right);

    return {
      buildingNumber: normalizeBuildingNumber(left),
      unitNumber: normalizeUnitNumber(right),
      // Litera po lewej ("12A/5") praktycznie przesadza o odczycie
      // budynek+lokal. Dwie czyste liczby - trzeba zapytac rejestr.
      ambiguous: bothNumeric,
      alternatives: bothNumeric
        ? [{ buildingNumber: normalizeBuildingNumber(s) }]
        : undefined,
    };
  }

  // 5. sam numer budynku
  if (PART.test(s)) {
    return { buildingNumber: normalizeBuildingNumber(s), ambiguous: false };
  }

  return null;
}

function isBuildingLike(s: string): boolean {
  const t = s.replace(/\s+/g, '');
  return PART.test(t) || RE_RANGE.test(t) || RE_SLASH.test(t);
}

/**
 * Forma kanoniczna numeru budynku: bez spacji, litera wielka.
 * `"12 a"` -> `"12A"`, `"12 / 14"` -> `"12/14"`
 */
export function normalizeBuildingNumber(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, '')
    .replace(/([0-9])([a-ząćęłńóśźż])/gi, (_, d: string, l: string) => d + l.toUpperCase());
}

/** Numer lokalu - wolny tekst, tylko przyciety i z wielka litera. */
export function normalizeUnitNumber(input: string): string {
  return input.trim().replace(/\s+/g, '').toUpperCase();
}

/**
 * Klucz porownawczy numeru budynku - do JOIN-ow i deduplikacji.
 * `12a` = `12 A` = `12A`
 */
export function buildingNumberKey(input: string): string {
  return input.toLowerCase().replace(/[^0-9a-ząćęłńóśźż/-]/gi, '');
}

/** Czy ciag wyglada jak sam numer budynku (bez lokalu). */
export function looksLikeBuildingNumber(s: string): boolean {
  const t = s.trim().replace(/\s+/g, '');
  if (RE_GARBAGE.test(t)) return false;
  return PART.test(t) || RE_RANGE.test(t) || RE_SLASH.test(t);
}

/**
 * Klucz sortowania naturalnego: `2` przed `10`, `10A` po `10`.
 * Bez tego lista numerow na ulicy wyglada jak 1, 10, 100, 11, 2...
 */
export function buildingSortKey(input: string): string {
  return input.replace(/\d+/g, (d) => d.padStart(6, '0')).toLowerCase();
}
