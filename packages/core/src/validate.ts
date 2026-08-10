/**
 * Walidacja formatu adresu (warstwa 1 - bez dostepu do rejestru).
 *
 * ZASADA NADRZEDNA: walidacja NIGDY nie blokuje zapisu adresu.
 * PRG gubi nowe budownictwo (gminy dosylaja z opoznieniem), zawiera punkty
 * prognozowane, a niektore gminy zasilaja rejestr sporadycznie. Formularz,
 * ktory mowi "taki adres nie istnieje" komus, kto wlasnie sie tam wprowadzil,
 * jest bledem produktu, nie uzytkownika.
 *
 * Walidacja KLASYFIKUJE i OSTRZEGA. Decyzje o blokadzie podejmuje logika
 * biznesowa aplikacji konsumenckiej.
 */
import type { Issue, PlAddress, ValidationResult, Confidence } from './types.ts';
import { isValidPostalFormat, isPlaceholderPostalCode, normalizePostalCode } from './postal.ts';
import { looksLikeBuildingNumber } from './number.ts';
import { cleanText } from './normalize.ts';

export interface FormatValidationOptions {
  /** Czy numer budynku jest wymagany. Domyslnie true. */
  requireNumber?: boolean;
  /** Czy kod pocztowy jest wymagany. Domyslnie false (czesto uzupelniany z rejestru). */
  requirePostalCode?: boolean;
}

/**
 * Walidacja skladniowa. Nie wymaga polaczenia z baza.
 * Uruchamiana w przegladarce przy kazdym keystroke - musi byc tania.
 */
export function validateFormat(
  address: Partial<PlAddress>,
  opts: FormatValidationOptions = {},
): ValidationResult {
  const { requireNumber = true, requirePostalCode = false } = opts;
  const issues: Issue[] = [];

  const locality = address.locality ? cleanText(address.locality) : '';
  if (!locality) {
    issues.push({
      code: 'MISSING_LOCALITY',
      severity: 'error',
      field: 'miejscowosc',
      message: 'Podaj miejscowosc.',
    });
  }

  const nr = address.buildingNumber ? cleanText(address.buildingNumber) : '';
  if (!nr) {
    if (requireNumber) {
      issues.push({
        code: 'MISSING_BUILDING_NUMBER',
        severity: 'error',
        field: 'nrBudynku',
        message: 'Podaj numer budynku.',
      });
    }
  } else if (!looksLikeBuildingNumber(nr)) {
    issues.push({
      code: 'INVALID_BUILDING_NUMBER_FORMAT',
      severity: 'warning',
      field: 'nrBudynku',
      message: `Nietypowy zapis numeru: "${nr}". Sprawdz, czy jest poprawny.`,
    });
  }

  const code = address.postalCode?.trim();
  if (code) {
    if (!isValidPostalFormat(code)) {
      const suggested = normalizePostalCode(code);
      issues.push({
        code: 'INVALID_POSTAL_CODE_FORMAT',
        severity: suggested ? 'warning' : 'error',
        field: 'kodPocztowy',
        message: suggested
          ? `Kod pocztowy powinien miec format NN-NNN.`
          : `"${code}" nie jest poprawnym kodem pocztowym.`,
        suggested: suggested ?? undefined,
      });
    } else if (isPlaceholderPostalCode(code)) {
      issues.push({
        code: 'INVALID_POSTAL_CODE_FORMAT',
        severity: 'warning',
        field: 'kodPocztowy',
        message: `"${code}" wyglada na wartosc zastepcza, nie na realny kod.`,
      });
    }
  } else if (requirePostalCode) {
    issues.push({
      code: 'INVALID_POSTAL_CODE_FORMAT',
      severity: 'error',
      field: 'kodPocztowy',
      message: 'Podaj kod pocztowy.',
    });
  }

  return {
    address: toCanonical(address),
    issues,
    confidence: address.confidence ?? 'unverified',
  };
}

/**
 * Reguly zaleznosci miedzy polami - stosowane po pobraniu kontekstu z rejestru.
 *
 * Kotwica to MIEJSCOWOSC, nie kod pocztowy. To wbrew intuicji, ale PNA
 * nie determinuje gminy ani miejscowosci.
 */
export interface RegistryContext {
  /** Czy miejscowosc istnieje w SIMC. */
  localityExists: boolean;
  /** Czy w tej miejscowosci sa jakiekolwiek ulice. */
  localityHasStreets: boolean;
  /** Czy podana ulica istnieje w tej miejscowosci. */
  streetExists?: boolean;
  /** Czy podany numer istnieje pod ta ulica/miejscowoscia. */
  numberExists?: boolean;
  /** Kod pocztowy wyliczony z rejestru dla tego adresu. */
  registryPostalCode?: string;
  /** Status punktu z PRG (snapshot sprzed 1.09.2026). */
  pointStatus?: string;
  /** Liczba pasujacych kandydatow - >1 oznacza koniecznosc rozstrzygniecia. */
  candidateCount?: number;
}

export function validateAgainstRegistry(
  address: Partial<PlAddress>,
  ctx: RegistryContext,
): ValidationResult {
  const base = validateFormat(address);
  const issues = [...base.issues];

  if (!ctx.localityExists) {
    issues.push({
      code: 'LOCALITY_OUTSIDE_REGISTRY',
      severity: 'warning',
      field: 'miejscowosc',
      message: 'Nie znalazlem tej miejscowosci w rejestrze TERYT.',
    });
  }

  if (ctx.candidateCount !== undefined && ctx.candidateCount > 1) {
    issues.push({
      code: 'MULTIPLE_CANDIDATES',
      severity: 'info',
      field: 'miejscowosc',
      message: `Znalazlem ${ctx.candidateCount} miejscowosci o tej nazwie. Wskaz gmine lub powiat.`,
    });
  }

  const hasStreet = Boolean(address.street?.trim());

  if (hasStreet && ctx.localityExists && !ctx.localityHasStreets) {
    issues.push({
      code: 'STREET_IN_LOCALITY_WITHOUT_STREETS',
      severity: 'warning',
      field: 'ulica',
      message: 'W tej miejscowosci nie ma ulic - numer odnosi sie bezposrednio do miejscowosci.',
    });
  }

  if (!hasStreet && ctx.localityHasStreets) {
    issues.push({
      code: 'MISSING_STREET_IN_LOCALITY_WITH_STREETS',
      severity: 'warning',
      field: 'ulica',
      message: 'W tej miejscowosci sa ulice - podanie ulicy zwykle jest konieczne.',
    });
  }

  if (hasStreet && ctx.streetExists === false) {
    issues.push({
      code: 'STREET_OUTSIDE_REGISTRY',
      severity: 'warning',
      field: 'ulica',
      message: 'Nie znalazlem tej ulicy w podanej miejscowosci.',
    });
  }

  if (ctx.numberExists === false) {
    issues.push({
      code: 'BUILDING_NUMBER_OUTSIDE_REGISTRY',
      severity: 'warning',
      field: 'nrBudynku',
      message: 'Tego numeru nie ma w rejestrze. Jesli to nowy budynek, mozesz go zapisac mimo to.',
    });
  }

  if (ctx.pointStatus && ctx.pointStatus !== 'istniejacy') {
    issues.push({
      code: 'BUILDING_NUMBER_PROJECTED',
      severity: 'info',
      field: 'nrBudynku',
      message: `Adres istnieje w rejestrze, ale budynek ma status "${ctx.pointStatus}".`,
    });
  }

  const code = address.postalCode?.trim();
  if (code && ctx.registryPostalCode && code !== ctx.registryPostalCode) {
    issues.push({
      code: 'POSTAL_CODE_CONFLICTS_WITH_REGISTRY',
      severity: 'warning',
      field: 'kodPocztowy',
      message: `Rejestr podaje dla tego adresu ${ctx.registryPostalCode}. Zostawiam Twoj wpis.`,
      suggested: ctx.registryPostalCode,
    });
  }

  return {
    address: toCanonical(address),
    issues,
    confidence: deriveConfidence(address, ctx, issues),
  };
}

function deriveConfidence(
  address: Partial<PlAddress>,
  ctx: RegistryContext,
  issues: Issue[],
): Confidence {
  if (address.confidence === 'irregular') return 'irregular';
  if (issues.some((i) => i.severity === 'error')) return 'unverified';

  const hasStreet = Boolean(address.street?.trim());
  const streetOk = !hasStreet || ctx.streetExists === true;

  if (ctx.localityExists && streetOk && ctx.numberExists === true) return 'verified_registry';
  if (ctx.localityExists && streetOk && ctx.numberExists === false) return 'verified_partial';
  if (ctx.localityExists) return 'verified_partial';
  return 'unverified';
}

/** Doprowadza czesciowy adres do formy kanonicznej. */
export function toCanonical(a: Partial<PlAddress>): PlAddress {
  return {
    country: 'PL',
    simc: a.simc,
    locality: a.locality ? cleanText(a.locality) : '',
    symUl: a.symUl,
    streetType: a.streetType,
    street: a.street ? cleanText(a.street) : undefined,
    buildingNumber: a.buildingNumber ? cleanText(a.buildingNumber) : '',
    unitNumber: a.unitNumber ? cleanText(a.unitNumber) : undefined,
    postalCode: a.postalCode?.trim(),
    gminaTerc: a.gminaTerc,
    lat: a.lat,
    lon: a.lon,
    prgLocalId: a.prgLocalId,
    confidence: a.confidence ?? 'unverified',
    raw: a.raw,
  };
}

/**
 * Jednolinijkowa reprezentacja adresu do wysylki.
 * Kolejnosc zgodna z zaleceniami pocztowymi.
 */
export function formatAddressLines(a: PlAddress): string[] {
  const lines: string[] = [];
  const street = [a.streetType, a.street].filter(Boolean).join(' ');
  const num = [a.buildingNumber, a.unitNumber].filter(Boolean).join('/');

  if (street) lines.push(`${street} ${num}`.trim());
  else lines.push(`${a.locality} ${num}`.trim());

  lines.push([a.postalCode, a.locality].filter(Boolean).join(' '));
  return lines.filter(Boolean);
}
