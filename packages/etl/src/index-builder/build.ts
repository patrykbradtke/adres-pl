/**
 * Budowniczy artefaktu indeksu.
 *
 * Wejscie: baza PostgreSQL (albo dowolny iterator rekordow - patrz `buildIndex`).
 * Wyjscie: pojedynczy, niemutowalny plik ~80 MB.
 *
 * Artefakt jest publikowany do object storage pod nazwa zawierajaca wersje
 * danych. Pody API pobieraja go przy starcie i trzymaja w RAM. Nigdy nie
 * modyfikujemy artefaktu w miejscu - nowa wersja to nowy plik.
 */
import {
  DOC, DOC_STRIDE, FLAG_MA_ULICE,
  StringDict, packStrings, serializeArtifact, bufferFromInt32,
  type SectionName,
} from '@adres-pl/index-format';
import { normalizeText, tokenize } from '@adres-pl/core';

export interface IndexDoc {
  type: 'locality' | 'street';
  /** Etykieta wyswietlana, np. "ul. Tadeusza Kosciuszki, Warszawa". */
  label: string;
  simc: string;
  ulicId?: number;
  liczbaPunktow: number;
  gmina?: string;
  powiat?: string;
  wojewodztwo?: string;
  maUlice?: boolean;
  lat?: number;
  lon?: number;
  /**
   * Dodatkowe klucze wyszukiwania poza etykieta:
   * forma potoczna ulicy ("Kosciuszki"), warianty liczebnikowe ("1 Maja"
   * / "Pierwszego Maja"), nazwa w jezyku mniejszosci.
   */
  aliases?: string[];
}

export interface BuildResult {
  buffer: Buffer;
  stats: {
    docs: number;
    keys: number;
    localities: number;
    streets: number;
    labelsBytes: number;
    keysBytes: number;
    totalBytes: number;
    buildMs: number;
  };
}

/**
 * Generuje klucze rotacyjne dla etykiety.
 *
 * "ul. Tadeusza Kosciuszki, Warszawa" ->
 *   "tadeusza kosciuszki warszawa"
 *   "kosciuszki warszawa"
 *   "warszawa"
 *
 * Cecha ("ul.") jest pomijana, bo nikt nie wyszukuje od "ul".
 * Ograniczamy do MAX_ROTATIONS tokenow - dlugie nazwy patronackie
 * generowalyby liniowo rosnaca liczbe kluczy przy zerowym zysku.
 */
const MAX_ROTATIONS = 6;
const STOP_TOKENS = new Set(['ul', 'al', 'pl', 'os', 'im']);

export function rotationalKeys(text: string): string[] {
  const tokens = tokenize(text).filter((t) => !STOP_TOKENS.has(t));
  if (tokens.length === 0) return [];
  const out: string[] = [];
  const n = Math.min(tokens.length, MAX_ROTATIONS);
  for (let i = 0; i < n; i++) out.push(tokens.slice(i).join(' '));
  return out;
}

export function buildIndex(docs: Iterable<IndexDoc>, dataVersion: string): BuildResult {
  const t0 = process.hrtime.bigint();

  const labels: string[] = [];
  const normLabels: string[] = [];
  const dict = new StringDict();
  const docFields: number[] = [];
  // pary [klucz, docId] - sortowane pozniej
  const keyPairs: Array<[string, number]> = [];

  let localities = 0;
  let streets = 0;

  for (const d of docs) {
    const docId = labels.length;
    labels.push(d.label);
    normLabels.push(normalizeText(d.label));
    if (d.type === 'locality') localities++; else streets++;

    const base = docId * DOC_STRIDE;
    docFields[base + DOC.TYPE] = d.type === 'locality' ? 0 : 1;
    docFields[base + DOC.SIMC] = Number(d.simc) || 0;
    docFields[base + DOC.ULIC_ID] = d.ulicId ?? -1;
    docFields[base + DOC.PUNKTOW] = Math.min(d.liczbaPunktow | 0, 2_000_000_000);
    docFields[base + DOC.GMINA_IDX] = dict.intern(d.gmina);
    docFields[base + DOC.POWIAT_IDX] = dict.intern(d.powiat);
    docFields[base + DOC.WOJ_IDX] = dict.intern(d.wojewodztwo);
    docFields[base + DOC.FLAGS] = d.maUlice ? FLAG_MA_ULICE : 0;
    docFields[base + DOC.LAT_E6] = d.lat ? Math.round(d.lat * 1e6) : 0;
    docFields[base + DOC.LON_E6] = d.lon ? Math.round(d.lon * 1e6) : 0;

    const seen = new Set<string>();
    for (const k of rotationalKeys(d.label)) {
      if (!seen.has(k)) { seen.add(k); keyPairs.push([k, docId]); }
    }
    for (const alias of d.aliases ?? []) {
      for (const k of rotationalKeys(alias)) {
        if (!seen.has(k)) { seen.add(k); keyPairs.push([k, docId]); }
      }
    }
  }

  // Sortowanie po BAJTACH UTF-8, nie po localeCompare - musi byc identyczne
  // z porzadkiem uzywanym przez binary search w silniku (Buffer.compare).
  keyPairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));

  const keyStrings = keyPairs.map((p) => p[0]);
  const keyDocIds = new Int32Array(keyPairs.length);
  for (let i = 0; i < keyPairs.length; i++) keyDocIds[i] = keyPairs[i][1];

  const packedLabels = packStrings(labels);
  const packedNorm = packStrings(normLabels);
  const packedKeys = packStrings(keyStrings);
  const packedDict = packStrings(dict.entries as string[]);
  const docsArr = Int32Array.from(docFields);

  const sections: Record<SectionName, Buffer> = {
    labels: packedLabels.blob,
    labelOffsets: bufferFromInt32(packedLabels.offsets),
    normLabels: packedNorm.blob,
    normLabelOffsets: bufferFromInt32(packedNorm.offsets),
    docs: bufferFromInt32(docsArr),
    keys: packedKeys.blob,
    keyOffsets: bufferFromInt32(packedKeys.offsets),
    keyDocs: bufferFromInt32(keyDocIds),
    dict: packedDict.blob,
    dictOffsets: bufferFromInt32(packedDict.offsets),
  };

  const buffer = serializeArtifact(
    {
      dataVersion,
      builtAt: new Date().toISOString(),
      counts: {
        docs: labels.length,
        keys: keyPairs.length,
        localities,
        streets,
        addressPoints: 0,
      },
    },
    sections,
  );

  const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;

  return {
    buffer,
    stats: {
      docs: labels.length,
      keys: keyPairs.length,
      localities,
      streets,
      labelsBytes: packedLabels.blob.length,
      keysBytes: packedKeys.blob.length,
      totalBytes: buffer.length,
      buildMs,
    },
  };
}

/**
 * Zapytanie zrodlowe dla buildera.
 *
 * UWAGA na `liczba_punktow` - to jest sygnal popularnosci w rankingu.
 * Bez niego "Warszawa" i "Warszawka" maja identyczny wynik, co daje
 * absurdalne podpowiedzi.
 */
export const SQL_INDEX_DOCS = `
  SELECT
    'locality'         AS type,
    m.nazwa            AS label,
    m.simc,
    NULL::bigint       AS ulic_id,
    m.liczba_punktow,
    g.nazwa            AS gmina,
    pw.nazwa           AS powiat,
    w.nazwa            AS wojewodztwo,
    m.ma_ulice,
    ST_Y(m.centroid::geometry) AS lat,
    ST_X(m.centroid::geometry) AS lon,
    NULL::text[]       AS aliases
  FROM adres.miejscowosc m
  JOIN adres.teryt_jednostka g   ON g.terc = m.terc_gminy
  LEFT JOIN adres.teryt_jednostka pw ON pw.terc = g.parent_terc
  LEFT JOIN adres.teryt_jednostka w  ON w.terc = pw.parent_terc
  WHERE m.wycofany_od IS NULL

  UNION ALL

  SELECT
    'street',
    concat_ws(' ', u.cecha, u.nazwa) || ', ' || m.nazwa,
    m.simc,
    u.ulic_id,
    u.liczba_punktow,
    g.nazwa, pw.nazwa, w.nazwa,
    m.ma_ulice,
    NULL, NULL,
    CASE WHEN u.nazwa_skroc IS NOT NULL
         THEN ARRAY[u.nazwa_skroc || ', ' || m.nazwa]
         ELSE NULL END
  FROM adres.ulica u
  JOIN adres.miejscowosc m ON m.simc = u.simc
  JOIN adres.teryt_jednostka g   ON g.terc = m.terc_gminy
  LEFT JOIN adres.teryt_jednostka pw ON pw.terc = g.parent_terc
  LEFT JOIN adres.teryt_jednostka w  ON w.terc = pw.parent_terc
  WHERE u.wycofany_od IS NULL
`;
