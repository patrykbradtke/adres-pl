/**
 * Klient uslugi sieciowej TERYT (GUS, ws1).
 *
 * DLACZEGO WLASNY KLIENT, A NIE BIBLIOTEKA SOAP:
 * Uzywamy czterech metod o identycznym ksztalcie. Pelna biblioteka SOAP
 * (parsowanie WSDL, generowanie typow) to kilkanascie megabajtow zaleznosci
 * i wlasny zestaw problemow przy WS-Security. Recznie sklecona koperta
 * to ~40 linii i pelna kontrola.
 *
 * DOSTEP:
 *  - produkcja: rejestracja mailowa na teryt_ws1@stat.gov.pl (bezplatnie)
 *  - test: konto publiczne TestPubliczny / 1234abcd
 *
 * CO DAJE PRZEWAGE NAD PLIKAMI:
 *  - `DataStanu` - pobranie jest deterministyczne i powtarzalne
 *  - pliki roznicowe (aktualizacyjne), ktorych PRG nie ma w ogole
 *
 * ODPOWIEDZ: pole `plik_zawartosc` zawiera ZIP zakodowany base64,
 * w srodku CSV rozdzielany srednikiem w UTF-8.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import yauzl from 'yauzl';
import type { TerytCatalog } from './format.ts';

export interface TerytConfig {
  endpoint: string;
  username: string;
  password: string;
  /** Limit czasu pojedynczego zadania. Katalogi TERC/SIMC/ULIC sa duze. */
  timeoutMs?: number;
}

/** Konto testowe GUS - publiczne, do weryfikacji integracji przed rejestracja. */
export const TERYT_TEST: TerytConfig = {
  endpoint: 'https://uslugaterytws1test.stat.gov.pl/terytws1.svc',
  username: 'TestPubliczny',
  password: '1234abcd',
};

export const TERYT_PROD: Omit<TerytConfig, 'username' | 'password'> = {
  endpoint: 'https://uslugaterytws1.stat.gov.pl/terytws1.svc',
};

export function configFromEnv(env = process.env): TerytConfig {
  const user = env.TERYT_USER;
  const pass = env.TERYT_PASSWORD;
  if (!user || !pass) return TERYT_TEST;
  return {
    endpoint: env.TERYT_ENDPOINT ?? TERYT_PROD.endpoint,
    username: user,
    password: pass,
    timeoutMs: env.TERYT_TIMEOUT_MS ? Number(env.TERYT_TIMEOUT_MS) : undefined,
  };
}

const NS = {
  soap: 'http://schemas.xmlsoap.org/soap/envelope/',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  ter: 'http://tempuri.org/',
  arr: 'http://schemas.microsoft.com/2003/10/Serialization/Arrays',
};

const PASSWORD_TEXT =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText';

/**
 * Koperta SOAP z naglowkiem WS-Security UsernameToken.
 *
 * Uwaga: GUS oczekuje PasswordText (haslo jawne) po HTTPS, nie PasswordDigest.
 * `wsu:Timestamp` jest wymagany przez WCF - bez niego zwraca blad
 * bezpieczenstwa, a nie blad uwierzytelnienia, co myli przy diagnostyce.
 */
function envelope(action: string, body: string, cfg: TerytConfig, now: Date): string {
  const created = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const expires = new Date(now.getTime() + 5 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const id = randomUUID();

  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="${NS.soap}" xmlns:ter="${NS.ter}">
  <s:Header>
    <wsse:Security xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}" s:mustUnderstand="1">
      <wsu:Timestamp wsu:Id="TS-${id}">
        <wsu:Created>${created}</wsu:Created>
        <wsu:Expires>${expires}</wsu:Expires>
      </wsu:Timestamp>
      <wsse:UsernameToken wsu:Id="UT-${id}">
        <wsse:Username>${esc(cfg.username)}</wsse:Username>
        <wsse:Password Type="${PASSWORD_TEXT}">${esc(cfg.password)}</wsse:Password>
      </wsse:UsernameToken>
    </wsse:Security>
  </s:Header>
  <s:Body>
    <ter:${action}>${body}</ter:${action}>
  </s:Body>
</s:Envelope>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export interface TerytFile {
  catalog: TerytCatalog;
  /** Data stanu, na ktora pobrano katalog. */
  asOfDate: string;
  /** Zawartosc CSV po rozpakowaniu. */
  csv: string;
  /** Nazwa pliku wewnatrz archiwum - do dziennika. */
  filename: string;
  bytes: number;
  sha256: string;
}

const METHOD: Record<TerytCatalog, string> = {
  TERC: 'PobierzKatalogTERC',
  SIMC: 'PobierzKatalogSIMC',
  ULIC: 'PobierzKatalogULIC',
  WMRODZ: 'PobierzKatalogWMRODZ',
};

/**
 * Pobiera pelny katalog na wskazana date stanu.
 *
 * `dataStanu` w formacie YYYY-MM-DD. Uzycie konkretnej daty zamiast "dzis"
 * jest istotne: pozwala odtworzyc dokladnie ten sam zbior przy ponownym
 * uruchomieniu, co jest warunkiem powtarzalnosci calego pipeline'u.
 */
export async function fetchCatalog(
  catalog: TerytCatalog,
  asOfDate: string,
  cfg: TerytConfig = configFromEnv(),
  now: Date = new Date(),
): Promise<TerytFile> {
  const action = METHOD[catalog];
  const body = `<ter:DataStanu>${asOfDate}</ter:DataStanu>`;
  const xml = envelope(action, body, cfg, now);

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 300_000);
  let res: Response;
  try {
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': `${NS.ter}ITerytWs1/${action}`,
      },
      body: xml,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`TERYT ${action}: HTTP ${res.status}. ${extractFault(text) ?? text.slice(0, 400)}`);
  }
  const fault = extractFault(text);
  if (fault) throw new Error(`TERYT ${action}: ${fault}`);

  const b64 = extractTag(text, 'plik_zawartosc');
  if (!b64) {
    throw new Error(
      `TERYT ${action}: odpowiedz bez pola plik_zawartosc. ` +
      `Najczestsza przyczyna to niepoprawne dane logowania albo data stanu ` +
      `spoza zakresu rejestru. Fragment: ${text.slice(0, 300)}`,
    );
  }

  const zipBuf = Buffer.from(b64, 'base64');
  const { csv, filename } = await unzipFirstText(zipBuf);
  return {
    catalog,
    asOfDate,
    csv,
    filename,
    bytes: zipBuf.length,
    sha256: createHash('sha256').update(zipBuf).digest('hex'),
  };
}

/** Zwraca komunikat bledu SOAP albo null. */
function extractFault(xml: string): string | null {
  const f = /<(?:\w+:)?Fault>([\s\S]*?)<\/(?:\w+:)?Fault>/.exec(xml);
  if (!f) return null;
  const reason = extractTag(f[1], 'Text') ?? extractTag(f[1], 'faultstring');
  return reason ?? f[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}

function extractTag(xml: string, local: string): string | null {
  const re = new RegExp(`<(?:\\w+:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${local}>`);
  const m = re.exec(xml);
  return m ? m[1] : null;
}

/** Rozpakowuje pierwszy plik tekstowy z archiwum w pamieci. */
async function unzipFirstText(buf: Buffer): Promise<{ csv: string; filename: string }> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('nie udalo sie otworzyc archiwum TERYT'));
      let done = false;
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) { zip.readEntry(); return; }
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e);
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            done = true;
            resolve({ csv: Buffer.concat(chunks).toString('utf8'), filename: entry.fileName });
          });
          stream.on('error', reject);
        });
      });
      zip.on('end', () => { if (!done) reject(new Error('archiwum TERYT jest puste')); });
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

/** Zapisuje pobrany katalog do archiwum lokalnego. */
export async function archiveTeryt(file: TerytFile, root: string): Promise<string> {
  const path = `${root}/teryt/${file.asOfDate}/${file.catalog}.csv`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, file.csv, 'utf8');
  return path;
}

/**
 * Sprawdza dostepnosc uslugi bez pobierania duzego katalogu.
 * WMRODZ ma kilkadziesiat wierszy, wiec jest idealny na test polaczenia.
 */
export async function testConnection(
  cfg: TerytConfig = configFromEnv(),
  asOfDate = new Date().toISOString().slice(0, 10),
): Promise<{ ok: boolean; message: string }> {
  try {
    const f = await fetchCatalog('WMRODZ', asOfDate, cfg);
    const lines = f.csv.split(/\r?\n/).filter((l) => l.trim()).length;
    return { ok: true, message: `Polaczenie dziala. WMRODZ: ${lines - 1} pozycji, stan ${f.asOfDate}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
