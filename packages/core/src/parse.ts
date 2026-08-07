/**
 * Parser adresu podanego jednym ciagiem.
 *
 * STRATEGIA: od najbardziej jednoznacznego do najmniej.
 *   1. kod pocztowy  (jedyny wzorzec bez falszywych trafien)
 *   2. numer budynku/lokalu (rozpoznawalny po ksztalcie)
 *   3. cecha ulicy   (ul./al./pl. - jawny marker)
 *   4. reszta -> miejscowosc i nazwa ulicy (rozstrzyga rejestr)
 *
 * Parsowanie od lewej do prawej jest wyraznie gorsze, bo pierwsze slowo
 * moze byc rownie dobrze miejscowoscia, cecha, jak i imieniem patrona.
 */
import type { ParsedAddressLine } from './types.ts';
import { cleanText } from './normalize.ts';
import { extractPostalCode } from './postal.ts';
import { parseNumber, looksLikeBuildingNumber } from './number.ts';
import { splitStreetPrefix } from './street.ts';

/** Slowa, ktore nigdy nie sa czescia adresu - usuwane przed parsowaniem. */
const NOISE = /\b(?:polska|poland|pl|rzeczpospolita\s+polska)\b\.?/gi;

/**
 * Rozbija ciag adresowy na pola.
 *
 * Wejscie:  "ul. Marszalkowska 12/34, 00-026 Warszawa"
 * Wyjscie:  { cecha:'ul.', ulica:'Marszalkowska', nrBudynku:'12',
 *             nrLokalu:'34', kodPocztowy:'00-026', miejscowosc:'Warszawa' }
 *
 * Wynik jest HIPOTEZA. Dopiero dopasowanie do rejestru rozstrzyga,
 * czy "Nowa Wies 27" to miejscowosc bez ulic, czy ulica "Nowa" w jakiejs wsi.
 */
export function parseAddressLine(raw: string): ParsedAddressLine {
  const out: ParsedAddressLine = { reszta: [], raw };
  let work = cleanText(raw).replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
  if (!work) return out;

  // --- 1. kod pocztowy -------------------------------------------------
  const postal = extractPostalCode(work);
  if (postal) {
    out.kodPocztowy = postal.code;
    work = (work.slice(0, postal.index) + ' ' + work.slice(postal.index + postal.length))
      .replace(/\s+/g, ' ')
      .trim();
  }

  // --- 2. podzial na segmenty po przecinkach ---------------------------
  const segments = work.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);

  // --- 3. cecha ulicy w ktoryms z segmentow ----------------------------
  let streetSegIdx = -1;
  for (let i = 0; i < segments.length; i++) {
    const { cecha } = splitStreetPrefix(segments[i]);
    if (cecha) { streetSegIdx = i; out.cecha = cecha; break; }
  }

  // --- 4. numer budynku ------------------------------------------------
  // Szukamy od konca segmentu z cecha, a jesli jej nie ma - w calym ciagu.
  const numberHost = streetSegIdx >= 0 ? streetSegIdx : findNumberSegment(segments);
  if (numberHost >= 0) {
    const seg = segments[numberHost];
    const tail = extractTrailingNumber(seg);
    if (tail) {
      const parsed = parseNumber(tail.value);
      if (parsed) {
        out.nrBudynku = parsed.nrBudynku;
        out.nrLokalu = parsed.nrLokalu;
      }
      segments[numberHost] = seg.slice(0, tail.index).trim().replace(/[,;]+$/, '');
    }
  }

  // --- 5. przypisanie ulicy i miejscowosci ------------------------------
  const remaining = segments.map((s) => s.trim()).filter(Boolean);

  if (streetSegIdx >= 0 && remaining.length > 0) {
    const { nazwa } = splitStreetPrefix(segments[streetSegIdx] || '');
    if (nazwa) out.ulica = nazwa;
    // miejscowosc: pierwszy segment inny niz ten z ulica
    for (let i = 0; i < segments.length; i++) {
      if (i === streetSegIdx) continue;
      if (segments[i]) { out.miejscowosc = segments[i]; break; }
    }
    for (let i = 0; i < segments.length; i++) {
      if (i !== streetSegIdx && segments[i] && segments[i] !== out.miejscowosc) {
        out.reszta.push(segments[i]);
      }
    }
  } else if (remaining.length === 1) {
    // Jeden segment bez cechy: "Nowa Wies" albo "Marszalkowska".
    // Nie da sie rozstrzygnac bez rejestru - zapisujemy jako miejscowosc,
    // bo to statystycznie czestszy przypadek przy adresach wiejskich.
    out.miejscowosc = remaining[0];
  } else if (remaining.length >= 2) {
    // "Marszalkowska, Warszawa" - ostatni segment to zwykle miejscowosc
    out.ulica = remaining[0];
    out.miejscowosc = remaining[remaining.length - 1];
    out.reszta.push(...remaining.slice(1, -1));
  }

  // "Nowa Wies 27, 05-123 Nowa Wies" - powtorzona nazwa oznacza miejscowosc
  // bez ulic, a nie ulice o nazwie identycznej z miejscowoscia.
  if (out.ulica && out.miejscowosc && !out.cecha && out.ulica === out.miejscowosc) {
    out.ulica = undefined;
  }

  return out;
}

/** Segment zawierajacy numer na koncu - preferujemy pierwszy taki. */
function findNumberSegment(segments: string[]): number {
  for (let i = 0; i < segments.length; i++) {
    if (extractTrailingNumber(segments[i])) return i;
  }
  return -1;
}

/**
 * Wydziela numer z konca segmentu.
 * Wazne: "3 Maja 5" -> numer to "5", a nie "3". Dlatego szukamy od konca
 * i wymagamy, zeby po numerze nie bylo juz nic poza bialymi znakami.
 */
function extractTrailingNumber(segment: string): { value: string; index: number } | null {
  const m = /(?:^|\s)(\d{1,5}\s?[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]?(?:\s?[-/]\s?\d{1,5}\s?[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]?)?(?:\s*(?:\/|m\.?|lok\.?|mieszk\.?)\s*\d{1,5}[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]?)?)\s*$/
    .exec(segment);
  if (!m) return null;

  const value = m[1].trim();
  // "Jana Pawla II" - liczebnik rzymski nie jest numerem
  if (!looksLikeBuildingNumber(value) && !/\d/.test(value)) return null;
  // "3 Maja" - sam numer bez kontekstu na koncu segmentu jednowyrazowego
  if (segment.trim() === value && !/\d/.test(segment)) return null;

  return { value, index: m.index === 0 ? 0 : m.index };
}
