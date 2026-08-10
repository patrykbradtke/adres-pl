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
  source: string;
  sourceVersion: string;
  voivodeship?: string;
  /** Co ile rekordow raportowac postep. */
  progressEvery?: number;
  onProgress?: (n: number) => void;
}

export interface LoadStats {
  points: number;
  localities: number;
  streets: number;
  skipped: number;
  skipReasons: Record<string, number>;
  axisSwapped: number;
  outsidePoland: number;
  geometryMissing: number;
  profile?: string;
  namespaceUri?: string;
  durationSeconds: number;
}

/**
 * Hash tresci merytorycznej punktu.
 *
 * Sluzy do wykrywania zmian bez porownywania geometrii pole po polu.
 * Wchodza TYLKO atrybuty, ktorych zmiana oznacza zmiane adresu -
 * `fetched_at` czy `source_version` sa celowo pominiete, bo inaczej kazdy
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
    r.buildingNumber,
    r.postalCode ?? '',
    r.status ?? '',
    r.lat !== undefined ? r.lat.toFixed(6) : '',
    r.lon !== undefined ? r.lon.toFixed(6) : '',
  ].join(''));
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
  const { pool, source, sourceVersion, voivodeship } = opts;
  const progressEvery = opts.progressEvery ?? 100_000;

  const stats: LoadStats = {
    points: 0, localities: 0, streets: 0, skipped: 0,
    skipReasons: {}, axisSwapped: 0, outsidePoland: 0, geometryMissing: 0,
    durationSeconds: 0,
  };

  const localities: Array<LocalityRecord & { gmlId?: string }> = [];
  const streets: Array<StreetRecord & { gmlId?: string }> = [];

  const client = await pool.connect();
  try {
    // Punkty ida strumieniowo do COPY. Reszta czeka w pamieci, bo potrzebna
    // jest do rozwiazania referencji i tak jest jej niewiele.
    const pointStream = new Readable({ read() {} });
    const copyPoints = client.query(copyFrom(
      `COPY staging.address_point (
         prg_local_id, version_id, version_start, simc_ref, ulic_ref,
         building_number, building_number_key, building_number_sort,
         postal_code, status, terc_ref,
         geom, source, source_version, content_hash, voivodeship
       ) FROM STDIN`,
    ));

    const copyDone = pipeline(pointStream, copyPoints);

    const parseStats = await parseGmlStream(await openStream(), {
      onProfileDetected: (p, ns) => { stats.profile = p.name; stats.namespaceUri = ns; },
      onFeature: (f: RawFeature) => {
        const r = mapFeature(f);
        if (r.kind === 'skipped') {
          stats.skipped++;
          const key = r.warning.reason.replace(/"[^"]*"/, '"…"').slice(0, 60);
          stats.skipReasons[key] = (stats.skipReasons[key] ?? 0) + 1;
          return;
        }

        if (r.kind === 'point') {
          const p = r.record;
          const row = [
            esc(p.prgLocalId), esc(p.versionId), esc(p.versionStart),
            esc(p.simcRef), esc(p.ulicRef),
            esc(p.buildingNumber), esc(p.buildingNumberKey),
            esc(buildingSortKey(p.buildingNumber)),
            esc(p.postalCode), esc(p.status), esc(p.tercRef),
            wkt(p.lon, p.lat),
            esc(source), esc(sourceVersion),
            // bytea w formacie tekstowym COPY: \\x<hex>
            '\\\\x' + hashPoint(p).toString('hex'),
            esc(voivodeship),
          ].join('\t') + '\n';
          pointStream.push(row);
          stats.points++;
          if (stats.points % progressEvery === 0) opts.onProgress?.(stats.points);
        } else if (r.kind === 'locality') {
          localities.push({ ...r.record, gmlId: f.gmlId });
          stats.localities++;
        } else {
          streets.push({ ...r.record, gmlId: f.gmlId });
          stats.streets++;
        }
      },
    });

    pointStream.push(null);
    await copyDone;

    stats.axisSwapped = parseStats.axisSwapped;
    stats.outsidePoland = parseStats.outsidePoland;
    stats.geometryMissing = parseStats.geometryMissing;

    await copyLocalities(client, localities, source, sourceVersion);
    await copyStreets(client, streets, source, sourceVersion);
  } finally {
    client.release();
  }

  stats.durationSeconds = Math.round((Date.now() - t0) / 1000);
  return stats;
}

async function copyLocalities(
  client: pg.PoolClient,
  rows: Array<LocalityRecord & { gmlId?: string }>,
  source: string,
  version: string,
): Promise<void> {
  if (rows.length === 0) return;
  const stream = new Readable({ read() {} });
  const copy = client.query(copyFrom(
    `COPY staging.locality (
       prg_local_id, gml_id, simc, name, name_norm, kind, kind_raw,
       gmina_terc, prng_id, centroid, source, source_version
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
      esc(r.prgLocalId), esc(r.gmlId), esc(r.simc), esc(r.name), esc(r.nameNorm),
      esc(r.kind), esc(r.kindRaw), esc(r.gminaTerc), esc(r.prngId),
      wkt(r.lon, r.lat), esc(source), esc(version),
    ].join('\t') + '\n');
  }
  stream.push(null);
  await done;
}

async function copyStreets(
  client: pg.PoolClient,
  rows: Array<StreetRecord & { gmlId?: string }>,
  source: string,
  version: string,
): Promise<void> {
  if (rows.length === 0) return;
  const stream = new Readable({ read() {} });
  const copy = client.query(copyFrom(
    `COPY staging.street (
       prg_local_id, gml_id, sym_ul, simc_ref, street_type, name, name_norm,
       short_name, short_name_norm, name_1, name_2, source, source_version
     ) FROM STDIN`,
  ));
  const done = pipeline(stream, copy);
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.prgLocalId)) continue;
    seen.add(r.prgLocalId);
    // Forma potoczna liczona tutaj, nie w mapperze - zalezy od pelnej nazwy,
    // a ta w strukturze 2021 przychodzi jako `fullName`, w 2012 jako `name`.
    const shortName = shortStreetName(r.name);
    stream.push([
      esc(r.prgLocalId), esc(r.gmlId), esc(r.symUl), esc(r.simcRef), esc(r.streetType),
      esc(r.name), esc(r.nameNorm),
      esc(shortName), esc(shortName ? normalizeText(shortName) : undefined),
      esc(r.name1), esc(r.name2), esc(source), esc(version),
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
  source: string,
  version: string,
  voivodeships?: string[],
): Promise<{ added: number; changed: number; withdrawn: number; restored: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{
      added: string; changed: string; withdrawn: string; restored: string;
    }>(
      'SELECT * FROM address.publish_snapshot($1, $2, $3)',
      [source, version, voivodeships ?? null],
    );
    await client.query('COMMIT');
    return {
      added: Number(rows[0].added),
      changed: Number(rows[0].changed),
      withdrawn: Number(rows[0].withdrawn),
      restored: Number(rows[0].restored),
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function clearStaging(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT staging.truncate_all()');
}

/**
 * Zdejmuje indeksy obszaru przejsciowego przed masowym ladowaniem.
 * Przy 8,5 mln wierszy utrzymywanie ich w trakcie COPY jest dominujacym
 * kosztem, a same indeksy sa potrzebne dopiero do kontroli jakosci.
 */
export async function beforeBulkLoad(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT staging.before_load()');
}

/** Odtwarza indeksy i statystyki po zaladowaniu wszystkich wojewodztw. */
export async function afterBulkLoad(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT staging.after_load()');
}
