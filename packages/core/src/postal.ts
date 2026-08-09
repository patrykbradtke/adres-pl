/**
 * Kod pocztowy (PNA).
 *
 * WAZNE OGRANICZENIE: PNA nie mapuje sie 1:1 ani na gmine, ani na miejscowosc.
 * Jeden kod obejmuje kilka gmin; jedna ulica ma wiele kodow przypisanych do
 * zakresow numerycznych. Kod pocztowy jest dobra PODPOWIEDZIA zawezajaca
 * i fatalnym KLUCZEM. Kotwica adresu to miejscowosc (SIMC).
 *
 * Dodatkowo: kody w PRG pochodza z gminnych EMUiA, nie od Poczty Polskiej.
 * Rozbieznosci sa normalne i nie powinny blokowac zapisu adresu.
 */

export const RE_POSTAL = /^\d{2}-\d{3}$/;

/** Czy ciag jest poprawnym formalnie kodem pocztowym. */
export function isValidPostalFormat(s: string): boolean {
  return RE_POSTAL.test(s.trim());
}

/**
 * Doprowadza kod do formy NN-NNN.
 * `"00950"` -> `"00-950"`, `"00 950"` -> `"00-950"`, `"0-0950"` -> null
 */
export function normalizePostalCode(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length !== 5) return null;
  return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

/**
 * Kody nieprawidlowe semantycznie, choc poprawne formalnie.
 * `00-000` to najczestszy artefakt "brak danych" w PRG.
 */
const PLACEHOLDER_CODES = new Set(['00-000', '99-999', '11-111', '12-345']);

export function isPlaceholderPostalCode(code: string): boolean {
  return PLACEHOLDER_CODES.has(code);
}

/** Wyciaga pierwszy kod pocztowy z dowolnego tekstu. */
export function extractPostalCode(text: string): { code: string; index: number; length: number } | null {
  // najpierw forma z myslnikiem (jednoznaczna)
  const dashed = /\b(\d{2}-\d{3})\b/.exec(text);
  if (dashed) return { code: dashed[1], index: dashed.index, length: dashed[0].length };

  // forma bez myslnika - ryzykowna, bo 5 cyfr moze byc czymkolwiek.
  // Akceptujemy tylko gdy nie sasiaduje z innymi cyframi ani z '/'.
  const plain = /(?<![\d/])(\d{5})(?![\d/])/.exec(text);
  if (plain) {
    const normalized = normalizePostalCode(plain[1]);
    // Forma bez mysnika jest niejednoznaczna, wiec odrzucamy wynik, ktory
    // wychodzi na kod-zaslepke. "Marszalkowska 99999" dawalo wczesniej kod
    // "99-999" i PUSTY numer budynku: dane byly cicho reinterpretowane
    // zamiast odrzucone. Zapis z mysnikiem zostawiamy - tam intencja jest jawna
    // i zaslepke lepiej pokazac niz ukryc.
    if (normalized && !isPlaceholderPostalCode(normalized)) {
      return { code: normalized, index: plain.index, length: plain[0].length };
    }
  }
  return null;
}
