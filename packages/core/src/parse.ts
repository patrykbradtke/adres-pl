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
 * Skrytka pocztowa. Nie jest punktem adresowym i nie ma odpowiednika w PRG.
 *
 * Rozpoznajemy ja PRZED reszta parsowania, bo inaczej marker zostaje odrzucony
 * jako nierozpoznany fragment, numer skrytki wpada w pole numeru budynku
 * i - jesli w tej miejscowosci istnieje budynek o tym numerze - adres dostaje
 * `verified_registry`. Tak bylo do 9.08.2026: "skr. poczt. 15, Warszawa"
 * wracalo z najwyzszym poziomem pewnosci i szlo do wysylki bez przegladu.
 */
const SKRYTKA = /\b(?:skr(?:ytka)?\.?\s*poczt(?:owa|\.)?|skrytka|p\.?\s?o\.?\s?box)\b/i;

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
  const out: ParsedAddressLine = { unparsed: [], raw };
  let work = cleanText(raw).replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
  if (!work) return out;

  // --- 0. skrytka pocztowa ---------------------------------------------
  // Wykrywamy przed wszystkim innym. Numer skrytki NIE jest numerem budynku,
  // wiec usuwamy marker razem z nim i nie probujemy dopasowac do rejestru.
  if (SKRYTKA.test(work)) {
    out.irregular = 'post_office_box';
    work = work.replace(SKRYTKA, ' ').replace(/(?:^|\s)\d{1,6}[A-Za-z]?(?=\s|$|,)/, ' ')
      .replace(/\s+/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '').trim();
  }

  // --- 1. kod pocztowy -------------------------------------------------
  const postal = extractPostalCode(work);
  // Podzial zapamietujemy PRZED wycieciem kodu - potem pozycje sie przesuwaja.
  let beforePostalCode = '';
  let afterPostalCode = '';
  if (postal) {
    out.postalCode = postal.code;
    beforePostalCode = work.slice(0, postal.index).replace(/\s+/g, ' ').replace(/[\s,]+$/, '').trim();
    afterPostalCode = work.slice(postal.index + postal.length).replace(/\s+/g, ' ').replace(/^[\s,]+/, '').trim();
    work = (work.slice(0, postal.index) + ' ' + work.slice(postal.index + postal.length))
      .replace(/\s+/g, ' ')
      .trim();
  }

  // --- 2. podzial na segmenty ------------------------------------------
  let segments = work.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);

  // Brak przecinkow, a byl kod pocztowy: dzielimy w miejscu, gdzie kod stal.
  //
  // Przecinek byl wczesniej JEDYNYM separatorem pol, wiec zapis bez niego -
  // "Marszalkowska 1 00-624 Warszawa" - ladowal w calosci w jednym polu jako
  // nazwa miejscowosci. Ksztalt czesty: adresy wklejane z faktur i PDF-ow gubia
  // przecinki, a REGON zwraca pola osobno i naiwne zlaczenie spacja daje
  // dokladnie to. Kod pocztowy stoi w polskim zapisie miedzy czescia ulicowa
  // a miejscowoscia, wiec jego pozycja jest wiarygodnym punktem podzialu.
  if (segments.length === 1 && beforePostalCode && afterPostalCode) {
    segments = [beforePostalCode, afterPostalCode];
  }

  // --- 3. cecha ulicy w ktoryms z segmentow ----------------------------
  let streetSegIdx = -1;
  for (let i = 0; i < segments.length; i++) {
    const { streetType } = splitStreetPrefix(segments[i]);
    if (streetType) { streetSegIdx = i; out.streetType = streetType; break; }
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
        out.buildingNumber = parsed.buildingNumber;
        out.unitNumber = parsed.unitNumber;
      }
      segments[numberHost] = seg.slice(0, tail.index).trim().replace(/[,;]+$/, '');
    }
  }

  // --- 5. przypisanie ulicy i miejscowosci ------------------------------
  const remaining = segments.map((s) => s.trim()).filter(Boolean);

  if (streetSegIdx >= 0 && remaining.length > 0) {
    const { name } = splitStreetPrefix(segments[streetSegIdx] || '');
    if (name) out.street = name;
    // miejscowosc: pierwszy segment inny niz ten z ulica
    for (let i = 0; i < segments.length; i++) {
      if (i === streetSegIdx) continue;
      if (segments[i]) { out.locality = segments[i]; break; }
    }
    for (let i = 0; i < segments.length; i++) {
      if (i !== streetSegIdx && segments[i] && segments[i] !== out.locality) {
        out.unparsed.push(segments[i]);
      }
    }
  } else if (remaining.length === 1) {
    // Jeden segment bez cechy: "Nowa Wies" albo "Marszalkowska".
    // Nie da sie rozstrzygnac bez rejestru - zapisujemy jako miejscowosc,
    // bo to statystycznie czestszy przypadek przy adresach wiejskich.
    out.locality = remaining[0];
  } else if (remaining.length >= 2) {
    // "Marszalkowska, Warszawa" - ostatni segment to zwykle miejscowosc
    out.street = remaining[0];
    out.locality = remaining[remaining.length - 1];
    out.unparsed.push(...remaining.slice(1, -1));
  }

  // "Nowa Wies 27, 05-123 Nowa Wies" - powtorzona nazwa oznacza miejscowosc
  // bez ulic, a nie ulice o nazwie identycznej z miejscowoscia.
  if (out.street && out.locality && !out.streetType && out.street === out.locality) {
    out.street = undefined;
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
