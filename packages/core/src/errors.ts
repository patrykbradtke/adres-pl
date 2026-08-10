/**
 * Katalog bledow HTTP - jedno miejsce, w ktorym mieszka kod, jego kod stanu
 * i tresc dla czlowieka.
 *
 * PO CO
 *
 * Do 10.08.2026 kody byly literalami rozsypanymi po trasach, a czesc
 * odpowiedzi w ogole ich nie miala. Skutki byly trzy:
 *
 *  - `POST /admin/keys` z nieistniejacym clientId zwracalo **500 z trescia
 *    bledu Postgresa**, razem z nazwa ograniczenia z bazy. Kod stanu klamal,
 *    a przy okazji wyciekala budowa schematu;
 *  - ksztalt ciala byl niespojny: raz `{error}`, raz `{error, code}`,
 *    a nieprzechwycone leacialy domyslnym ksztaltem Fastify
 *    (`{statusCode, code, error, message}`);
 *  - nie bylo listy kodow, wiec ani integrator, ani panel nie mial czego
 *    przetlumaczyc.
 *
 * TO NIE SA UWAGI WALIDACJI
 *
 * `IssueCode` (MISSING_LOCALITY, MULTIPLE_CANDIDATES i pozostale) opisuje
 * znaleziska WEWNATRZ poprawnej odpowiedzi 200 - adres da sie zwalidowac,
 * tylko ma zastrzezenia. Tu jest odwrotnie: zadanie NIE zostalo wykonane.
 * Mieszanie tych dwoch znaczen bylo zrodlem nieporozumien, wiec sa osobno.
 *
 * KATALOG JEST TA MAPA TLUMACZACA
 *
 * `message` to tekst domyslny, ktory serwis zwraca w polu `error`. Panel moze
 * go uzyc wprost albo przetlumaczyc sobie po `code` - dlatego kod jest
 * STABILNY i nigdy nie zmienia znaczenia, a tresc wolno poprawiac.
 */

export interface ErrorDef {
  readonly code: string;
  readonly status: number;
  /** Tresc domyslna. Po polsku, bez znakow diakrytycznych - jak reszta komunikatow. */
  readonly message: string;
}

/**
 * Pelny katalog. Kolejnosc wg kodu stanu, dla czytelnosci.
 *
 * Kody 401 maja CELOWO identyczna tresc dla wszystkich przyczyn - rozne
 * komunikaty zamienialyby odpowiedz w wyrocznie dla zgadujacego. Kody 403
 * sa juz konkretne, bo padaja po udowodnieniu posiadania calego sekretu.
 * Uzasadnienie w naglowku api/keys/auth.ts.
 */
export const ERRORS: readonly ErrorDef[] = [
  // --- 400: zadanie zle zbudowane ---------------------------------------
  { code: 'VALIDATION_FAILED', status: 400, message: 'Zadanie nie spelnia schematu.' },
  { code: 'INVALID_PARAMETER', status: 400, message: 'Nieprawidlowa wartosc parametru.' },

  // --- 401: nie wiadomo, kto pyta ---------------------------------------
  { code: 'MISSING_KEY',     status: 401, message: 'Klucz API nieprawidlowy.' },
  { code: 'INVALID',         status: 401, message: 'Klucz API nieprawidlowy.' },
  { code: 'MISSING_TOKEN',   status: 401, message: 'Wymagany token operatora.' },
  { code: 'SESSION_INVALID', status: 401, message: 'Sesja nieprawidlowa albo wygasla.' },

  // --- 403: wiadomo kto, ale nie wolno ----------------------------------
  { code: 'NOT_YET_VALID', status: 403, message: 'Klucz API nie jest jeszcze wazny.' },
  { code: 'EXPIRED',       status: 403, message: 'Klucz API wygasl.' },
  { code: 'REVOKED',       status: 403, message: 'Klucz API zostal uniewazniony.' },
  { code: 'SUSPENDED',     status: 403, message: 'Konto klienta jest zawieszone.' },
  { code: 'FORBIDDEN',     status: 403, message: 'Brak uprawnien do tej czynnosci.' },

  // --- 404: nie ma czego dotyczy zadanie --------------------------------
  { code: 'NOT_FOUND',          status: 404, message: 'Nie znaleziono.' },
  { code: 'CLIENT_NOT_FOUND',   status: 404, message: 'Nie ma klienta o podanym identyfikatorze.' },
  { code: 'KEY_NOT_FOUND',      status: 404, message: 'Nie ma klucza o podanym identyfikatorze.' },
  { code: 'LOCALITY_NOT_FOUND', status: 404, message: 'Nie znaleziono miejscowosci.' },
  { code: 'ACCOUNT_NOT_FOUND',  status: 404, message: 'Nie ma konta o podanym identyfikatorze.' },
  { code: 'ROLE_NOT_FOUND',     status: 404, message: 'Nie ma roli o podanym identyfikatorze.' },

  // --- 409: stan systemu nie pozwala ------------------------------------
  { code: 'ALREADY_EXISTS', status: 409, message: 'Taki wpis juz istnieje.' },
  { code: 'ROLE_IN_USE',    status: 409, message: 'Rola jest przypisana albo zawarta w innej roli.' },
  { code: 'ROLE_CYCLE',     status: 409, message: 'Rola zawieralaby sama siebie.' },
  { code: 'LAST_ADMIN',     status: 409, message: 'To ostatnie zrodlo uprawnienia do nadawania rol.' },
  { code: 'CONFLICT',       status: 409, message: 'Czynnosc koliduje z biezacym stanem.' },

  // --- 422: zbudowane poprawnie, ale nie do wykonania -------------------
  { code: 'UNPROCESSABLE', status: 422, message: 'Zadanie poprawne, ale nie da sie go wykonac.' },

  // --- 429: za duzo -----------------------------------------------------
  { code: 'RATE_LIMITED',     status: 429, message: 'Przekroczony limit zapytan.' },
  { code: 'QUOTA_EXHAUSTED',  status: 429, message: 'Wyczerpana kwota miesieczna.' },

  // --- 5xx --------------------------------------------------------------
  // Tresc jest CELOWO ogolna. Szczegoly ida do logu wraz z identyfikatorem
  // korelacji; klient dostaje ten identyfikator i nic ponadto, bo tresc bledu
  // wewnetrznego potrafi opisac budowe schematu.
  { code: 'INTERNAL',  status: 500, message: 'Blad wewnetrzny uslugi.' },
  { code: 'NOT_READY', status: 503, message: 'Usluga nie jest gotowa do obslugi ruchu.' },
] as const;

export type ErrorCode = (typeof ERRORS)[number]['code'];

const BY_CODE = new Map<string, ErrorDef>(ERRORS.map((e) => [e.code, e]));

export function errorDef(code: string): ErrorDef | undefined {
  return BY_CODE.get(code);
}

/** Kody o danym stanie - uzywane przez kontrole zgodnosci ze specyfikacja. */
export function errorCodesWithStatus(status: number): string[] {
  return ERRORS.filter((e) => e.status === status).map((e) => e.code);
}

/**
 * Ksztalt ciala KAZDEJ odpowiedzi bledu. Bez wyjatkow - takze dla 500.
 *
 * `info` niesie szczegol nadajacy sie do pokazania: ktore pole, ktory
 * identyfikator. NIGDY nie trafia tu tresc bledu bazy ani nic, czego klient
 * nie powinien wiedziec o budowie systemu.
 */
export interface ErrorBody {
  code: string;
  error: string;
  info?: Record<string, unknown>;
  /** Do zestawienia odpowiedzi z wpisem w logu i w dzienniku audytu. */
  correlationId?: string;
}

/**
 * Blad, ktory warstwa HTTP potrafi zamienic na odpowiedz bez zgadywania.
 *
 * Wszystko, co nie jest AppError, konczy sie jako INTERNAL - i tak ma byc.
 * Kod stanu ma wynikac ze SWIADOMEJ decyzji, a nie z tego, jaki wyjatek
 * akurat doleciał z biblioteki.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly info?: Record<string, unknown>;

  // Jawne przypisania zamiast parameter properties - Node w trybie
  // --experimental-strip-types wycina wylacznie typy i nie generuje kodu.
  constructor(code: ErrorCode, info?: Record<string, unknown>, message?: string) {
    const def = BY_CODE.get(code);
    if (!def) throw new Error(`Nieznany kod bledu: ${code}. Katalog jest w core/errors.ts.`);
    super(message ?? def.message);
    this.code = def.code;
    this.status = def.status;
    this.info = info;
  }
}

/** Skrot do rzucania: `throw appError('CLIENT_NOT_FOUND', { clientId })`. */
export function appError(
  code: ErrorCode,
  info?: Record<string, unknown>,
  message?: string,
): AppError {
  return new AppError(code, info, message);
}
