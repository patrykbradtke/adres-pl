/**
 * Klucz API klienta - generowanie, format i rozbior.
 *
 * KSZTALT: `adr_live_<32 znaki sekretu>_<6 znakow sumy>`, dlugosc zawsze 48.
 *
 * DLACZEGO 24 BAJTY, A NIE 20 CZY 22
 * 24 dzieli sie przez 3, wiec base64url daje DOKLADNIE 32 znaki bez znakow
 * wyrownania. Kazda inna dlugosc wprowadza wyrownanie albo znosi stala dlugosc
 * klucza, a to ona jest najtanszym krokiem odrzucenia - porownanie liczby
 * przed czymkolwiek innym. Przy okazji 24 bajty to 192 bity entropii.
 *
 * DLACZEGO SUMA KONTROLNA JEST LICZONA BEZ PIEPRZA
 * Suma jest WYKRYWACZEM LITEROWEK, nie kontrola bezpieczenstwa. Zewnetrzny
 * skaner wyciekow (zadanie 8.9) musi umiec potwierdzic ksztalt klucza
 * znalezionego w cudzym repozytorium BEZ naszego sekretu. Suma liczona
 * z pieprzem stalaby sie wyrocznia: kto ma probki, ten odroznia klucze nasze
 * od losowych ciagow, a my nie zyskujemy nic, bo bezpieczenstwo daje entropia
 * sekretu, nie utajnienie sumy.
 *
 * DLACZEGO TEN MODUL NIE IMPORTUJE NICZEGO Z node:
 * Caly pakiet core jest wolny od zaleznosci srodowiskowych i ma taki zostac -
 * ten sam kod ma dzialac w przegladarce w panelu administracyjnym. Losowosc
 * bierzemy z Web Crypto (`globalThis.crypto`), obecnego i w Node 22, i w
 * przegladarkach. HMAC z pieprzem to osobna sprawa i mieszka po stronie
 * serwera - patrz packages/api/src/keys/pepper.ts.
 */

export type ApiKeyEnvironment = 'test' | 'live';

export const API_KEY_PREFIX_TEST = 'adr_test_';
export const API_KEY_PREFIX_LIVE = 'adr_live_';

/** Bajty losowe sekretu. Patrz naglowek - liczba nie jest dowolna. */
export const API_KEY_SECRET_BYTES = 24;
/** 24 bajty -> 32 znaki base64url. */
export const API_KEY_SECRET_CHARS = 32;
/** Suma kontrolna: 4 bajty CRC32 -> 6 znakow base64url. */
export const API_KEY_CHECKSUM_CHARS = 6;
/**
 * Oba prefiksy maja ROWNA dlugosc i to jest warunek rozbioru: sekret wycinamy
 * po stalym przesunieciu, bez sprawdzania, ktory prefiks wystapil.
 */
export const API_KEY_PREFIX_CHARS = API_KEY_PREFIX_LIVE.length;

/** prefiks + sekret + separator + suma. Liczone, nie wpisane - patrz nizej. */
export const API_KEY_LENGTH =
  API_KEY_PREFIX_CHARS + API_KEY_SECRET_CHARS + 1 + API_KEY_CHECKSUM_CHARS;

/**
 * Wzorzec BUDOWANY ze stalych, nie wpisany.
 *
 * Format byl zapisany trzy razy niezaleznie: w stalych, w recznie policzonej
 * dlugosci 48 i w literale wyrazenia regularnego. Zmiana ktorejkolwiek stalej
 * nie ruszala pozostalych dwoch, a rozjazd bylby CICHY - generator wytwarzalby
 * klucze, ktorych wlasny rozbior juz by nie przyjmowal.
 */
export const RE_API_KEY = new RegExp(
  '^adr_(live|test)_[A-Za-z0-9_-]{' + API_KEY_SECRET_CHARS + '}' +
  '_[A-Za-z0-9_-]{' + API_KEY_CHECKSUM_CHARS + '}$');

export interface ApiKeyParts {
  environment: ApiKeyEnvironment;
  /** 32 znaki base64url - czesc tajna. Nigdy nie trafia do logu ani do bazy. */
  secret: string;
  /** 6 znakow base64url - jawny wykrywacz literowek. */
  checksum: string;
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * base64url bez znakow wyrownania, na czystym TS.
 *
 * Nie uzywamy Buffer.toString('base64url'): Buffer nie istnieje w przegladarce,
 * a btoa nie istnieje w starszych srodowiskach serwerowych. Dwanascie linii
 * wlasnego kodu jest tansze niz zaleznosc albo rozgalezienie na srodowisko.
 */
function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += B64URL[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += B64URL[b2 & 0x3f];
  }
  return out;
}

/** Tablica CRC32 liczona raz przy wczytaniu modulu. */
const CRC32_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(s: string): number {
  let c = 0xffffffff;
  for (let i = 0; i < s.length; i++) {
    // Sekret jest z alfabetu base64url, czyli wylacznie ASCII - charCodeAt
    // wystarcza i nie ma potrzeby kodowania UTF-8.
    c = CRC32_TABLE[(c ^ s.charCodeAt(i)) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Suma kontrolna sekretu. Jawna, liczona bez pieprza - patrz naglowek. */
export function apiKeyChecksum(secret: string): string {
  const n = crc32(secret);
  const bytes = new Uint8Array([n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  return toBase64Url(bytes).slice(0, API_KEY_CHECKSUM_CHARS);
}

export function formatApiKey(environment: ApiKeyEnvironment, secret: string): string {
  const prefix = environment === 'live' ? API_KEY_PREFIX_LIVE : API_KEY_PREFIX_TEST;
  return `${prefix}${secret}_${apiKeyChecksum(secret)}`;
}

/** Nowy klucz jawny. Wolajacy widzi go RAZ - dalej zyje juz tylko skrot. */
export function generateApiKey(environment: ApiKeyEnvironment): string {
  const bytes = new Uint8Array(API_KEY_SECRET_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return formatApiKey(environment, toBase64Url(bytes));
}

/**
 * Rozbior klucza. Zwraca null dla czegokolwiek niepoprawnego i NIGDY nie rzuca -
 * wejscie pochodzi z naglowka HTTP, wiec wyjatek bylby kodem 500 sterowanym
 * przez klienta. Konwencja jak parseNumber i normalizePostalCode.
 *
 * Kolejnosc odrzucania jest od najtanszego kroku do najdrozszego, bo ta funkcja
 * stoi na sciezce KAZDEGO zadania, takze zalewu losowymi kluczami.
 */
export function parseApiKey(raw: unknown): ApiKeyParts | null {
  if (typeof raw !== 'string') return null;
  if (raw.length !== API_KEY_LENGTH) return null;

  const environment: ApiKeyEnvironment | null =
    raw.startsWith(API_KEY_PREFIX_LIVE) ? 'live'
      : raw.startsWith(API_KEY_PREFIX_TEST) ? 'test'
        : null;
  if (!environment) return null;

  if (!RE_API_KEY.test(raw)) return null;

  const secret = raw.slice(API_KEY_PREFIX_LIVE.length, API_KEY_PREFIX_LIVE.length + API_KEY_SECRET_CHARS);
  const checksum = raw.slice(raw.length - API_KEY_CHECKSUM_CHARS);

  // Porownanie zwyklym === jest tu wlasciwe: suma jest wartoscia JAWNA,
  // policzalna przez kazdego, kto ma klucz. Nie ma tajemnicy do wycieku
  // przez czas porownania.
  if (apiKeyChecksum(secret) !== checksum) return null;

  return { environment, secret, checksum };
}
