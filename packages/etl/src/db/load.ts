/**
 * Ladowanie sparsowanych rekordow do schematu `staging`.
 *
 * STRATEGIA: COPY FROM STDIN, nie INSERT.
 * Przy 8,5 mln rekordow roznica jest rzedu wielkosci: INSERT po jednym to
 * godziny, COPY to minuty. Strumieniujemy prosto z parsera SAX do COPY,
 * wiec zuzycie pamieci jest stale niezaleznie od rozmiaru pliku.
 *
 * Kolejnosc jest istotna: najpierw miejscowosci i ulice (slowniki),
 * potem punkty - bo punkty referencja sie do nich przez gml:id albo SIMC.
 */
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';

import { parseGmlStream, type RawFeature } from '../gml/parser.ts';
import { mapFeature, type PointRecord, type LocalityRecord, type StreetRecord } from '../gml/mapper.ts';
import { buildingSortKey, shortStreetName, normalizeText } from '@adres-pl/core';

export interface LoadOptions {
  pool: pg.Pool;
  zrodlo: string;
  zrodloWersja: string;
  wojewodztwo?: string;
  /** Co ile rekordow raportowac postep. */
  progressEvery?: number;
  onProgress?: (n: number) => void;
}

export interface LoadStats {
  punkty: number;
  miejscowosci: number;
  ulice: number;
  pominiete: number;
  powodyPominiec: Record<string, number>;
  osieOdwrocone: number;
  pozaPolska: number;
  bezGeometrii: number;
  profil?: string;
  namespaceUri?: string;
  czasS: number;
}

/**
 * Hash tresci merytorycznej punktu.
 *
 * Sluzy do wykrywania zmian bez porownywania geometrii pole po polu.
 * Wchodza TYLKO atrybuty, ktorych zmiana oznacza zmiane adresu -
 * `pobrano` czy `zrodlo_wersja` sa celowo pominiete, bo inaczej kazdy
 * zrzut wygladalby jak zmiana wszystkiego.
 *
 * Wspolrzedne zaokraglone do 1e-6 (~11 cm) - drobne przeliczenia
 * transformacji nie moga generowac falszywych zmian.
 */
export function hashPoint(r: PointRecord): Buffer {
  const h = createHash('sha256');
  h.update([
    r.simcRef ?? '',
    r.ulicRef ?? '',
    r.nrBudynku,
    r.kodPocztowy ?? '',
    r.status ?? '',
    r.lat !== undefined ? r.lat.toFixed(6) : '',
    r.lon !== undefined ? r.lon.toFixed(6) : '',
  ].join(''));
  return h.digest();
}

/** Escapowanie do formatu tekstowego COPY. */
export function esc(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '\\N';
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** WKT punktu dla PostGIS albo NULL. */
function wkt(lon?: number, lat?: number): string {
  if (lon === undefined || lat === undefined) return '\\N';
  return `SRID=4326;POINT(${lon} ${lat})`;
}

/**
 * Laduje jeden plik GML do staging.
 *
 * Dwa przebiegi po strumieniu sa NIEMOZLIWE (strumien jest jednorazowy),
 * a buforowanie 8,5 mln rekordow w pamieci odpada. Dlatego:
 *  - miejscowosci i ulice buforujemy (jest ich ~373 tys. lacznie, mieszcza sie)
 *  - punkty strumieniujemy prosto do COPY
 */
export async function loadGmlToStaging(
  openStream: () => Promise<Readable>,
  opts: LoadOptions,
): Promise<LoadStats> {
  const t0 = Date.now();
  const { pool, zrodlo, zrodloWersja, wojewodztwo } = opts;
  const progressEvery = opts.progressEvery ?? 100_000;

  const stats: LoadStats = {
    punkty: 0, miejscowosci: 0, ulice: 0, pominiete: 0,
    powodyPominiec: {}, osieOdwrocone: 0, pozaPolska: 0, bezGeometrii: 0,
    czasS: 0,
  };

  const localities: Array<LocalityRecord & { gmlId?: string }> = [];
  const streets: Array<StreetRecord & { gmlId?: string }> = [];

  const client = await pool.connect();
  try {
    // Punkty ida strumieniowo do COPY. Reszta czeka w pamieci, bo potrzebna
    // jest do rozwiazania referencji i tak jest jej niewiele.
    const pointStream = new Readable({ read() {} });
    const copyPoints = client.query(copyFrom(
      `COPY staging.punkt_adresowy (
         prg_local_id, wersja_id, poczatek_wersji, simc_ref, ulic_ref,
         nr_budynku, nr_key, nr_sort, kod_pocztowy, status, terc_ref,
         geom, zrodlo, zrodlo_wersja, tresc_hash, wojewodztwo
       ) FROM STDIN`,
    ));

    const copyDone = pipeline(pointStream, copyPoints);

    const parseStats = await parseGmlStream(await openStream(), {
      onProfileDetected: (p, ns) => { stats.profil = p.name; stats.namespaceUri = ns; },
      onFeature: (f: RawFeature) => {
        const r = mapFeature(f);
        if (r.kind === 'skipped') {
          stats.pominiete++;
          const key = r.warning.reason.replace(/"[^"]*"/, '"…"').slice(0, 60);
          stats.powodyPominiec[key] = (stats.powodyPominiec[key] ?? 0) + 1;
          return;
        }

        if (r.kind === 'point') {
          const p = r.record;
          const row = [
            esc(p.prgLocalId), esc(p.wersjaId), esc(p.poczatekWersji),
            esc(p.simcRef), esc(p.ulicRef),
            esc(p.nrBudynku), esc(p.nrKey), esc(buildingSortKey(p.nrBudynku)),
            esc(p.kodPocztowy), esc(p.status), esc(p.tercRef),
            wkt(p.lon, p.lat),
            esc(zrodlo), esc(zrodloWersja),
            // bytea w formacie tekstowym COPY: \\x<hex>
            '\\\\x' + hashPoint(p).toString('hex'),
            esc(wojewodztwo),
          ].join('\t') + '\n';
          pointStream.push(row);
          stats.punkty++;
          if (stats.punkty % progressEvery === 0) opts.onProgress?.(stats.punkty);
        } else if (r.kind === 'locality') {
          localities.push({ ...r.record, gmlId: f.gmlId });
          stats.miejscowosci++;
        } else {
          streets.push({ ...r.record, gmlId: f.gmlId });
          stats.ulice++;
        }
      },
    });

    pointStream.push(null);
    await copyDone;

    stats.osieOdwrocone = parseStats.axisSwapped;
    stats.pozaPolska = parseStats.outsidePoland;
    stats.bezGeometrii = parseStats.geometryMissing;

    await copyLocalities(client, localities, zrodlo, zrodloWersja);
    await copyStreets(client, streets, zrodlo, zrodloWersja);
  } finally {
    client.release();
  }

  stats.czasS = Math.round((Date.now() - t0) / 1000);
  return stats;
}

async function copyLocalities(
  client: pg.PoolClient,
  rows: Array<LocalityRecord & { gmlId?: string }>,
  zrodlo: string,
  wersja: string,
): Promise<void> {
  if (rows.length === 0) return;
  const stream = new Readable({ read() {} });
  const copy = client.query(copyFrom(
    `COPY staging.miejscowosc (
       prg_local_id, gml_id, simc, nazwa, nazwa_norm, rodzaj, rodzaj_raw,
       terc_gminy, identyfikator_prng, centroid, zrodlo, zrodlo_wersja
     ) FROM STDIN`,
  ));
  const done = pipeline(stream, copy);
  // Deduplikacja po prg_local_id - PK w staging nie wybaczy duplikatow,
  // a PRG potrafi je miec przy sklejaniu plikow wojewodzkich.
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.prgLocalId)) continue;
    seen.add(r.prgLocalId);
    stream.push([
      esc(r.prgLocalId), esc(r.gmlId), esc(r.simc), esc(r.nazwa), esc(r.nazwaNorm),
      esc(r.rodzaj), esc(r.rodzajRaw), esc(r.tercGminy), esc(r.identyfikatorPRNG),
      wkt(r.lon, r.lat), esc(zrodlo), esc(wersja),
    ].join('\t') + '\n');
  }
  stream.push(null);
  await done;
}

async function copyStreets(
  client: pg.PoolClient,
  rows: Array<StreetRecord & { gmlId?: string }>,
  zrodlo: string,
  wersja: string,
): Promise<void> {
  if (rows.length === 0) return;
  const stream = new Readable({ read() {} });
  const copy = client.query(copyFrom(
    `COPY staging.ulica (
       prg_local_id, gml_id, sym_ul, simc_ref, cecha, nazwa, nazwa_norm,
       nazwa_skroc, nazwa_skroc_norm, nazwa_1, nazwa_2, zrodlo, zrodlo_wersja
     ) FROM STDIN`,
  ));
  const done = pipeline(stream, copy);
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.prgLocalId)) continue;
    seen.add(r.prgLocalId);
    // Forma potoczna liczona tutaj, nie w mapperze - zalezy od pelnej nazwy,
    // a ta w strukturze 2021 przychodzi jako `nazwaPelna`, w 2012 jako `nazwa`.
    const skroc = shortStreetName(r.nazwa);
    stream.push([
      esc(r.prgLocalId), esc(r.gmlId), esc(r.symUl), esc(r.simcRef), esc(r.cecha),
      esc(r.nazwa), esc(r.nazwaNorm),
      esc(skroc), esc(skroc ? normalizeText(skroc) : undefined),
      esc(r.nazwa1), esc(r.nazwa2), esc(zrodlo), esc(wersja),
    ].join('\t') + '\n');
  }
  stream.push(null);
  await done;
}

/**
 * Publikacja: sanity checks -> atomowa podmiana.
 * Wolane po zaladowaniu WSZYSTKICH wojewodztw wchodzacych w sklad zrzutu.
 */
export async function publish(
  pool: pg.Pool,
  zrodlo: string,
  wersja: string,
  wojewodztwa?: string[],
): Promise<{ dodane: number; zmienione: number; wycofane: number; przywrocone: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{
      dodane: string; zmienione: string; wycofane: string; przywrocone: string;
    }>(
      'SELECT * FROM adres.publikuj_zrzut($1, $2, $3)',
      [zrodlo, wersja, wojewodztwa ?? null],
    );
    await client.query('COMMIT');
    return {
      dodane: Number(rows[0].dodane),
      zmienione: Number(rows[0].zmienione),
      wycofane: Number(rows[0].wycofane),
      przywrocone: Number(rows[0].przywrocone),
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function clearStaging(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT staging.wyczysc()');
}

/**
 * Zdejmuje indeksy obszaru przejsciowego przed masowym ladowaniem.
 * Przy 8,5 mln wierszy utrzymywanie ich w trakcie COPY jest dominujacym
 * kosztem, a same indeksy sa potrzebne dopiero do kontroli jakosci.
 */
export async function beforeBulkLoad(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT staging.przed_ladowaniem()');
}

/** Odtwarza indeksy i statystyki po zaladowaniu wszystkich wojewodztw. */
export async function afterBulkLoad(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT staging.po_ladowaniu()');
}
