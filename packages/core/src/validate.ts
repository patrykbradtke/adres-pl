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

  const miejscowosc = address.miejscowosc ? cleanText(address.miejscowosc) : '';
  if (!miejscowosc) {
    issues.push({
      code: 'BRAK_MIEJSCOWOSCI',
      severity: 'error',
      field: 'miejscowosc',
      message: 'Podaj miejscowosc.',
    });
  }

  const nr = address.nrBudynku ? cleanText(address.nrBudynku) : '';
  if (!nr) {
    if (requireNumber) {
      issues.push({
        code: 'BRAK_NUMERU',
        severity: 'error',
        field: 'nrBudynku',
        message: 'Podaj numer budynku.',
      });
    }
  } else if (!looksLikeBuildingNumber(nr)) {
    issues.push({
      code: 'ZLY_FORMAT_NUMERU',
      severity: 'warning',
      field: 'nrBudynku',
      message: `Nietypowy zapis numeru: "${nr}". Sprawdz, czy jest poprawny.`,
    });
  }

  const kod = address.kodPocztowy?.trim();
  if (kod) {
    if (!isValidPostalFormat(kod)) {
      const suggested = normalizePostalCode(kod);
      issues.push({
        code: 'ZLY_FORMAT_KODU',
        severity: suggested ? 'warning' : 'error',
        field: 'kodPocztowy',
        message: suggested
          ? `Kod pocztowy powinien miec format NN-NNN.`
          : `"${kod}" nie jest poprawnym kodem pocztowym.`,
        suggested: suggested ?? undefined,
      });
    } else if (isPlaceholderPostalCode(kod)) {
      issues.push({
        code: 'ZLY_FORMAT_KODU',
        severity: 'warning',
        field: 'kodPocztowy',
        message: `"${kod}" wyglada na wartosc zastepcza, nie na realny kod.`,
      });
    }
  } else if (requirePostalCode) {
    issues.push({
      code: 'ZLY_FORMAT_KODU',
      severity: 'error',
      field: 'kodPocztowy',
      message: 'Podaj kod pocztowy.',
    });
  }

  return {
    address: toCanonical(address),
    issues,
    confidence: address.confidence ?? 'niezweryfikowany',
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
      code: 'MIEJSCOWOSC_SPOZA_REJESTRU',
      severity: 'warning',
      field: 'miejscowosc',
      message: 'Nie znalazlem tej miejscowosci w rejestrze TERYT.',
    });
  }

  if (ctx.candidateCount !== undefined && ctx.candidateCount > 1) {
    issues.push({
      code: 'WIELE_KANDYDATOW',
      severity: 'info',
      field: 'miejscowosc',
      message: `Znalazlem ${ctx.candidateCount} miejscowosci o tej nazwie. Wskaz gmine lub powiat.`,
    });
  }

  const hasStreet = Boolean(address.ulica?.trim());

  if (hasStreet && ctx.localityExists && !ctx.localityHasStreets) {
    issues.push({
      code: 'ULICA_W_MIEJSCOWOSCI_BEZ_ULIC',
      severity: 'warning',
      field: 'ulica',
      message: 'W tej miejscowosci nie ma ulic - numer odnosi sie bezposrednio do miejscowosci.',
    });
  }

  if (!hasStreet && ctx.localityHasStreets) {
    issues.push({
      code: 'BRAK_ULICY_W_MIEJSCOWOSCI_Z_ULICAMI',
      severity: 'warning',
      field: 'ulica',
      message: 'W tej miejscowosci sa ulice - podanie ulicy zwykle jest konieczne.',
    });
  }

  if (hasStreet && ctx.streetExists === false) {
    issues.push({
      code: 'ULICA_SPOZA_REJESTRU',
      severity: 'warning',
      field: 'ulica',
      message: 'Nie znalazlem tej ulicy w podanej miejscowosci.',
    });
  }

  if (ctx.numberExists === false) {
    issues.push({
      code: 'NUMER_SPOZA_REJESTRU',
      severity: 'warning',
      field: 'nrBudynku',
      message: 'Tego numeru nie ma w rejestrze. Jesli to nowy budynek, mozesz go zapisac mimo to.',
    });
  }

  if (ctx.pointStatus && ctx.pointStatus !== 'istniejacy') {
    issues.push({
      code: 'NUMER_PROGNOZOWANY',
      severity: 'info',
      field: 'nrBudynku',
      message: `Adres istnieje w rejestrze, ale budynek ma status "${ctx.pointStatus}".`,
    });
  }

  const kod = address.kodPocztowy?.trim();
  if (kod && ctx.registryPostalCode && kod !== ctx.registryPostalCode) {
    issues.push({
      code: 'KOD_NIEZGODNY_Z_REJESTREM',
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
  if (address.confidence === 'nietypowy') return 'nietypowy';
  if (issues.some((i) => i.severity === 'error')) return 'niezweryfikowany';

  const hasStreet = Boolean(address.ulica?.trim());
  const streetOk = !hasStreet || ctx.streetExists === true;

  if (ctx.localityExists && streetOk && ctx.numberExists === true) return 'zweryfikowany_rejestr';
  if (ctx.localityExists && streetOk && ctx.numberExists === false) return 'zweryfikowany_czesciowo';
  if (ctx.localityExists) return 'zweryfikowany_czesciowo';
  return 'niezweryfikowany';
}

/** Doprowadza czesciowy adres do formy kanonicznej. */
export function toCanonical(a: Partial<PlAddress>): PlAddress {
  return {
    kraj: 'PL',
    simc: a.simc,
    miejscowosc: a.miejscowosc ? cleanText(a.miejscowosc) : '',
    symUl: a.symUl,
    cecha: a.cecha,
    ulica: a.ulica ? cleanText(a.ulica) : undefined,
    nrBudynku: a.nrBudynku ? cleanText(a.nrBudynku) : '',
    nrLokalu: a.nrLokalu ? cleanText(a.nrLokalu) : undefined,
    kodPocztowy: a.kodPocztowy?.trim(),
    tercGminy: a.tercGminy,
    lat: a.lat,
    lon: a.lon,
    prgLocalId: a.prgLocalId,
    confidence: a.confidence ?? 'niezweryfikowany',
    raw: a.raw,
  };
}

/**
 * Jednolinijkowa reprezentacja adresu do wysylki.
 * Kolejnosc zgodna z zaleceniami pocztowymi.
 */
export function formatAddressLines(a: PlAddress): string[] {
  const lines: string[] = [];
  const street = [a.cecha, a.ulica].filter(Boolean).join(' ');
  const num = [a.nrBudynku, a.nrLokalu].filter(Boolean).join('/');

  if (street) lines.push(`${street} ${num}`.trim());
  else lines.push(`${a.miejscowosc} ${num}`.trim());

  lines.push([a.kodPocztowy, a.miejscowosc].filter(Boolean).join(' '));
  return lines.filter(Boolean);
}
