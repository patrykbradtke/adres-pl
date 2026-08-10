/**
 * Silnik wyszukiwania typeahead - dziala w pamieci procesu Node.
 *
 * KLUCZE ROTACYJNE
 * Uzytkownik pisze "Kosciuszki", a etykieta zaczyna sie od "ul. Tadeusza".
 * Wyszukiwanie podciagu na 373k etykiet to 2,7-4,3 ms brute force (zmierzone),
 * a na 8,5 mln juz 69-131 ms. Wyszukiwanie PREFIKSU przez binary search to
 * 2-10 MIKROsekund, niezaleznie od rozmiaru korpusu (O(log n)).
 *
 * Rozwiazanie: dla kazdej etykiety generujemy klucze zaczynajace sie od
 * kazdego kolejnego tokenu:
 *     "tadeusza kosciuszki warszawa"
 *     "kosciuszki warszawa"
 *     "warszawa"
 * Sortujemy, pakujemy w jeden Buffer. Drogi problem podciagu zamienia sie
 * w tani problem prefiksu.
 *
 * Zmierzone dla 373k etykiet / ~2 mln kluczy:
 *   rozmiar   79,4 MB (blob 63,8 + offsety 7,8 + docid 7,8)
 *   budowa    12-15 s
 *   RSS       ~600 MB
 *   p50       0,285-0,704 ms
 *   p95       <= 4,9 ms
 *   p99       <= 6,7 ms
 */
import {
  DOC, DOC_STRIDE, FLAG_HAS_STREETS,
  readHeader, int32View, type ArtifactHeader,
} from '@adres-pl/index-format';
import { normalizeText, tokenize, levenshtein } from '@adres-pl/core';
import type { Suggestion } from '@adres-pl/core';

/**
 * Slowa rodzajowe, ktore w rejestrze bywaja wtopione w nazwe ulicy.
 *
 * PRG nie wypelnia kolumny cechy w ogole, a dla 20 586 ulic wstawia typ do
 * samej nazwy: "ulica Marszalkowska" zamiast cechy "ul." i nazwy
 * "Marszalkowska". W Warszawie dotyczy to 10 992 z 11 338 ulic, czyli 97%.
 *
 * Dla dopasowania prefiksowego takie slowo nie niesie informacji - nikt nie
 * szuka ulicy, wpisujac najpierw "ulica". Lista jest domknieta i celowo krotka:
 * pomijamy wyrazy, ktore bywaja czescia nazwy wlasnej (np. "Aleje" w "Aleje
 * Jerozolimskie" albo "Rynek"), bo tam obciecie zmienialoby sens.
 */
const GENERIC_WORDS = new Set([
  'ulica', 'ul', 'aleja', 'al', 'plac', 'pl', 'osiedle', 'os',
  'skwer', 'rondo', 'bulwar', 'bulw', 'droga', 'szosa', 'wybrzeze',
]);

/**
 * Przesuniecie, od ktorego zaczyna sie wlasciwa nazwa - 0, gdy etykieta nie ma
 * wiodacego slowa rodzajowego.
 *
 * Zwracamy pozycje, a nie podciag, bo `score` wola to dla KAZDEGO kandydata.
 * Wersja alokujaca podciag kosztowala ok. 11% mediany czasu odpowiedzi;
 * `startsWith(q, offset)` nie alokuje nic.
 */
function afterGenericWord(norm: string): number {
  const space = norm.indexOf(' ');
  if (space <= 0 || space + 1 >= norm.length) return 0;
  const end = norm.charCodeAt(space - 1) === 46 /* '.' */ ? space - 1 : space;
  return GENERIC_WORDS.has(norm.slice(0, end)) ? space + 1 : 0;
}

export interface SearchOptions {
  limit?: number;
  /** Zawezenie do jednej miejscowosci - uzywane przez pole "ulica". */
  simc?: string;
  /** Tylko miejscowosci albo tylko ulice. */
  type?: 'locality' | 'street';
  /** Maksymalna liczba kandydatow przed rankingiem. Ochrona przed "a". */
  maxCandidates?: number;
}

export class SearchIndex {
  readonly header: ArtifactHeader;
  private labels: Buffer;
  private labelOffsets: Int32Array;
  private normLabels: Buffer;
  private normLabelOffsets: Int32Array;
  private docs: Int32Array;
  private keys: Buffer;
  private keyOffsets: Int32Array;
  private keyDocs: Int32Array;
  private dict: Buffer;
  private dictOffsets: Int32Array;

  /** Znacznik odwiedzin z licznikiem generacji - unika alokacji Set na zapytanie. */
  private visited: Int32Array;
  private generation = 0;

  constructor(buf: Buffer) {
    this.header = readHeader(buf);
    const s = this.header.sections;
    this.labels = buf.subarray(s.labels.offset, s.labels.offset + s.labels.length);
    this.labelOffsets = int32View(buf, s.labelOffsets);
    this.normLabels = buf.subarray(s.normLabels.offset, s.normLabels.offset + s.normLabels.length);
    this.normLabelOffsets = int32View(buf, s.normLabelOffsets);
    this.docs = int32View(buf, s.docs);
    this.keys = buf.subarray(s.keys.offset, s.keys.offset + s.keys.length);
    this.keyOffsets = int32View(buf, s.keyOffsets);
    this.keyDocs = int32View(buf, s.keyDocs);
    this.dict = buf.subarray(s.dict.offset, s.dict.offset + s.dict.length);
    this.dictOffsets = int32View(buf, s.dictOffsets);
    this.visited = new Int32Array(this.header.counts.docs);
  }

  get dataVersion(): string { return this.header.dataVersion; }
  get docCount(): number { return this.header.counts.docs; }

  // --- odczyt pol -------------------------------------------------------

  label(docId: number): string {
    return this.labels.toString('utf8', this.labelOffsets[docId], this.labelOffsets[docId + 1]);
  }

  /** Znormalizowana etykieta - policzona przy budowie, zero kosztu w zapytaniu. */
  private normLabel(docId: number): string {
    return this.normLabels.toString('utf8', this.normLabelOffsets[docId], this.normLabelOffsets[docId + 1]);
  }

  private key(keyId: number): string {
    return this.keys.toString('utf8', this.keyOffsets[keyId], this.keyOffsets[keyId + 1]);
  }

  private dictAt(idx: number): string | undefined {
    if (idx < 0) return undefined;
    return this.dict.toString('utf8', this.dictOffsets[idx], this.dictOffsets[idx + 1]);
  }

  private field(docId: number, f: number): number {
    return this.docs[docId * DOC_STRIDE + f];
  }

  /** SIMC z powrotem do postaci 7-znakowej z wiodacymi zerami. */
  simcOf(docId: number): string {
    return String(this.field(docId, DOC.SIMC)).padStart(7, '0');
  }

  // --- binary search ----------------------------------------------------

  /**
   * Najmniejszy indeks klucza >= prefix. Porownanie na surowych bajtach
   * bez tworzenia stringow - to jest gorace miejsce.
   *
   * WARUNEK POPRAWNOSCI: klucze musza byc posortowane bajtowo (UTF-8),
   * dokladnie tak jak sortuje je builder. Poniewaz `normalizeText` zwraca
   * wylacznie [a-z0-9 ], porzadek leksykograficzny stringow JS i porzadek
   * bajtowy sa tozsame. Gdyby kiedykolwiek do kluczy trafily znaki spoza
   * ASCII, builder i silnik rozjechalyby sie po cichu.
   *
   * `Buffer.compare(target, tStart, tEnd, sStart, sEnd)` porownuje
   * source[sStart..sEnd] z target[tStart..tEnd] - czyli tutaj klucz z prefiksem.
   */
  private lowerBound(prefix: Buffer): number {
    let lo = 0;
    let hi = this.keyOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const start = this.keyOffsets[mid];
      const end = this.keyOffsets[mid + 1];
      // < 0 oznacza klucz < prefiks -> szukamy dalej w prawo
      if (this.keys.compare(prefix, 0, prefix.length, start, end) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private startsWith(keyId: number, prefix: Buffer): boolean {
    const start = this.keyOffsets[keyId];
    const end = this.keyOffsets[keyId + 1];
    if (end - start < prefix.length) return false;
    return this.keys.compare(prefix, 0, prefix.length, start, start + prefix.length) === 0;
  }

  // --- wyszukiwanie -----------------------------------------------------

  search(query: string, opts: SearchOptions = {}): Suggestion[] {
    const { limit = 10, maxCandidates = 400 } = opts;
    const q = normalizeText(query);
    if (q.length === 0) return [];

    const candidates = this.collectCandidates(q, opts, maxCandidates);
    if (candidates.length === 0) return [];

    // tokenizacja zapytania RAZ, nie dla kazdego z max 400 kandydatow
    const qTokens = tokenize(q);
    const scored = candidates
      .map((docId) => ({ docId, score: this.score(docId, q, qTokens) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map((c) => this.toSuggestion(c.docId, c.score));
  }

  /**
   * Zbiera kandydatow, degradujac prefiks az do trafienia.
   *
   * Kolejnosc prob:
   *   1. cale zapytanie jako prefiks           - najlepsza precyzja
   *   2. najdluzszy token zapytania            - "warszawa kosciuszki" -> "kosciuszki"
   *   3. skracanie prefiksu o 1 znak (max 3x)  - obsluga literowek na koncu
   */
  private collectCandidates(q: string, opts: SearchOptions, maxCandidates: number): number[] {
    this.generation++;
    const out: number[] = [];
    const typeFilter = opts.type === 'locality' ? 0 : opts.type === 'street' ? 1 : -1;
    const simcFilter = opts.simc ? Number(opts.simc) : -1;

    const tryPrefix = (p: string): void => {
      if (p.length === 0 || out.length >= maxCandidates) return;
      const prefix = Buffer.from(p, 'utf8');
      let k = this.lowerBound(prefix);
      while (k < this.keyDocs.length && out.length < maxCandidates && this.startsWith(k, prefix)) {
        const docId = this.keyDocs[k];
        if (this.visited[docId] !== this.generation) {
          this.visited[docId] = this.generation;
          if (typeFilter < 0 || this.field(docId, DOC.TYPE) === typeFilter) {
            if (simcFilter < 0 || this.field(docId, DOC.SIMC) === simcFilter) {
              out.push(docId);
            }
          }
        }
        k++;
      }
    };

    tryPrefix(q);
    if (out.length > 0) return out;

    const tokens = tokenize(q).sort((a, b) => b.length - a.length);
    for (const t of tokens) {
      tryPrefix(t);
      if (out.length > 0) return out;
    }

    // Literowka: skracamy prefiks az do 4 znakow. Wystarczy, ze poprawny jest
    // POCZATEK slowa - "mickievicza" -> prefiks "micki" znajdzie "mickiewicza",
    // a ranking po odleglosci edycyjnej ustawi je na wlasciwym miejscu.
    // Ciecie tylko o 3 znaki (poprzednia wersja) nie lapalo literowek w srodku.
    const longest = tokens[0] ?? q;
    const MIN_PREFIX = 4;
    for (let len = longest.length - 1; len >= MIN_PREFIX; len--) {
      tryPrefix(longest.slice(0, len));
      if (out.length > 0) return out;
    }
    return out;
  }

  /**
   * Ranking.
   *
   * Skladniki, w kolejnosci wagi:
   *  - dopasowanie prefiksowe od poczatku etykiety (uzytkownik zwykle pisze od poczatku)
   *  - pokrycie tokenow zapytania
   *  - kara za odleglosc edycyjna (literowki)
   *  - popularnosc: log(liczba punktow adresowych) - Warszawa przed Warszawka
   *  - kara za dlugosc etykiety - krotsze = bardziej ogolne = zwykle trafniejsze
   */
  private score(docId: number, q: string, qTokens: string[]): number {
    const norm = this.normLabel(docId);
    if (norm.length === 0) return 0;

    let s = 0;

    // Wiodace slowo rodzajowe jest dla punktacji PRZEZROCZYSTE.
    //
    // PRG nie wypelnia kolumny cechy i dla 20 586 ulic wstawia typ do samej
    // nazwy ("ulica Marszalkowska"); w Warszawie dotyczy to 97% ulic. Takie
    // etykiety traca 500 punktow na dopasowaniu prefiksowym i dodatkowo sa
    // karane za dlugosc, ktora ten przedrostek sztucznie zawyza. Skutek byl
    // taki, ze zapytanie "marszalkowska" nie zwracalo Warszawy nawet
    // w pierwszej 25, a "pulawska" stawialo ja na 26 miejscu mimo 373 punktow
    // adresowych wobec 157 w wygrywajacej Warce.
    //
    // Nie obcinamy przedrostka z etykiety - "Aleje Jerozolimskie" czy "Rynek"
    // to nazwy zwyczajowe i skrocenie zmienialoby sens. Pomijamy go wylacznie
    // przy liczeniu punktow.
    // Kolejnosc testow jest istotna dla kosztu: wiekszosc kandydatow trafia tu
    // wlasnie dlatego, ze etykieta zaczyna sie od zapytania, wiec ta sciezka
    // nie moze placic za obsluge przedrostka. Przesuniecie liczymy dopiero,
    // gdy tani test zawiedzie.
    let fromName = 0;
    if (norm.startsWith(q)) {
      s += 1000;
    } else {
      fromName = afterGenericWord(norm);
      if (fromName > 0 && norm.startsWith(q, fromName)) s += 1000;
      else if (norm.includes(q)) s += 500;
    }

    const lTokens = norm.split(' ');
    let matched = 0;
    let fuzzyPenalty = 0;
    for (const qt of qTokens) {
      let best = -1;
      for (const lt of lTokens) {
        if (lt.startsWith(qt)) { best = 0; break; }
        if (Math.abs(lt.length - qt.length) <= 2) {
          const d = levenshtein(qt, lt, 2);
          if (d <= 2 && (best < 0 || d < best)) best = d;
        }
      }
      if (best >= 0) { matched++; fuzzyPenalty += best * 40; }
    }
    if (matched === 0) return 0;
    s += (matched / qTokens.length) * 600;
    s -= fuzzyPenalty;

    // Popularnosc: wielkosc samego obiektu ORAZ miejscowosci, w ktorej lezy.
    //
    // Sama liczba adresow przy ulicy to slaby sygnal waznosci - ulica we wsi
    // miewa ich tyle samo, co fragment ulicy w miescie. Zapytanie
    // "marszalkowska" dawalo Cmolas (67 adresow przy ulicy) i Warszawe (70)
    // w praktycznym remisie, rozstrzyganym dlugoscia etykiety, choc same
    // miejscowosci roznia sie o trzy rzedy wielkosci.
    //
    // Waga miejscowosci jest nizsza niz waga samego obiektu: ma przewazac przy
    // remisie, a nie przykrywac dopasowania nazwy. Roznica miedzy Warszawa
    // (126 566 adresow) a wsia na kilkaset wychodzi na ok. 60 punktow, przy
    // premii za trafienie prefiksowe rownej 1000.
    const points = this.field(docId, DOC.POINTS);
    s += Math.log10(points + 1) * 30;
    s += Math.log10(this.field(docId, DOC.LOCALITY_POINTS) + 1) * 25;

    // Kara za dlugosc liczona bez slowa rodzajowego - inaczej etykieta
    // "ulica Pulawska, Warszawa" placi za szesc znakow, ktorych uzytkownik
    // nie wpisal i ktore nie odrozniaja jej od niczego.
    s -= Math.min(norm.length - fromName, 60) * 1.5;

    return s;
  }

  private toSuggestion(docId: number, score: number): Suggestion {
    const type = this.field(docId, DOC.TYPE) === 0 ? 'locality' : 'street';
    const label = this.label(docId);
    const ulicId = this.field(docId, DOC.ULIC_ID);
    const lat = this.field(docId, DOC.LAT_E6);
    const lon = this.field(docId, DOC.LON_E6);

    // etykieta ulicy ma format "<cecha> <nazwa>, <miejscowosc>"
    let street: string | undefined;
    let streetType: string | undefined;
    let locality = label;
    if (type === 'street') {
      const comma = label.lastIndexOf(', ');
      const streetPart = comma >= 0 ? label.slice(0, comma) : label;
      locality = comma >= 0 ? label.slice(comma + 2) : '';
      const sp = streetPart.indexOf(' ');
      if (sp > 0 && streetPart.slice(0, sp).endsWith('.')) {
        streetType = streetPart.slice(0, sp);
        street = streetPart.slice(sp + 1);
      } else {
        street = streetPart;
      }
    } else {
      const comma = label.indexOf(', ');
      if (comma >= 0) locality = label.slice(0, comma);
    }

    return {
      type,
      label,
      score: Math.round(score),
      simc: this.simcOf(docId),
      ulicId: ulicId >= 0 ? ulicId : undefined,
      locality,
      street,
      streetType,
      gmina: this.dictAt(this.field(docId, DOC.GMINA_IDX)),
      powiat: this.dictAt(this.field(docId, DOC.POWIAT_IDX)),
      voivodeship: this.dictAt(this.field(docId, DOC.VOIVODESHIP_IDX)),
      hasStreets: (this.field(docId, DOC.FLAGS) & FLAG_HAS_STREETS) !== 0,
      addressPointCount: this.field(docId, DOC.POINTS),
      ...(lat !== 0 || lon !== 0 ? { lat: lat / 1e6, lon: lon / 1e6 } : {}),
    } as Suggestion;
  }
}
