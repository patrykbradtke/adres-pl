/**
 * Ladowanie katalogow TERYT do bazy.
 *
 * TERYT jest wymiarem odniesienia dla calej bazy adresowej:
 *  - `teryt_jednostka` jest celem klucza obcego z `miejscowosc`
 *  - `wmrodz` opisuje rodzaj miejscowosci
 *  - SIMC i ULIC dostarczaja nazwy urzedowe oraz identyfikatory,
 *    ktorych PRG czesto nie zawiera albo podaje w innej formie
 *
 * Bez TERYT baza nie przyjmie zadnego punktu adresowego, bo `miejscowosc`
 * wymaga istniejacego `terc_gminy`. Dlatego to jest PIERWSZY krok zasilania.
 *
 * Kolejnosc ma znaczenie: WMRODZ -> TERC -> SIMC -> ULIC.
 */
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import {
  parseTerc, parseSimc, parseUlic, parseWmrodz, toCsv,
  type TercRow, type SimcRow, type UlicRow,
} from '../sources/teryt/format.ts';
import { normalizeText, titleCasePl, shortStreetName, cleanText } from '@adres-pl/core';
import { esc } from './load.ts';

export interface TerytLoadStats {
  wmrodz: number;
  terc: number;
  simc: number;
  ulic: number;
  /** Miejscowosci pominiete, bo ich gmina nie istnieje w TERC. */
  simcBezGminy: number;
  /** Ulice pominiete, bo ich miejscowosc nie istnieje w SIMC. */
  ulicWithoutLocality: number;
  asOf?: string;
  durationSeconds: number;
}

export interface TerytInput {
  wmrodz?: string;
  terc?: string;
  simc?: string;
  ulic?: string;
}

/**
 * Laduje komplet katalogow w jednej transakcji.
 *
 * Slowniki sa aktualizowane metoda upsert, bez kasowania - jednostka
 * zniesiona administracyjnie zostaje w bazie, bo moga do niej odwolywac
 * sie dane historyczne.
 */
export async function loadTeryt(
  pool: pg.Pool,
  input: TerytInput,
  opts: { asOf?: string; onProgress?: (msg: string) => void } = {},
): Promise<TerytLoadStats> {
  const t0 = Date.now();
  const log = opts.onProgress ?? (() => {});
  const stats: TerytLoadStats = {
    wmrodz: 0, terc: 0, simc: 0, ulic: 0,
    simcBezGminy: 0, ulicWithoutLocality: 0,
    asOf: opts.asOf, durationSeconds: 0,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- 1. WMRODZ: slownik rodzajow miejscowosci --------------------
    if (input.wmrodz) {
      const rows = parseWmrodz(toCsv(input.wmrodz));
      for (const r of rows) {
        await client.query(
          `INSERT INTO address.wmrodz (kod, name) VALUES ($1, $2)
             ON CONFLICT (kod) DO UPDATE SET name = EXCLUDED.name`,
          [Number(r.rm), r.nameRemoved],
        );
      }
      stats.wmrodz = rows.length;
      stats.asOf ??= rows[0]?.asOf;
      log(`WMRODZ: ${rows.length}`);
    }

    // --- 2. TERC: hierarchia administracyjna -------------------------
    if (input.terc) {
      const rows = parseTerc(toCsv(input.terc));
      // Kolejnosc wg poziomu - klucz obcy `parent_terc` wskazuje w gore
      // hierarchii, wiec wojewodztwa musza wejsc przed powiatami.
      rows.sort((a, b) => a.level - b.level);
      stats.terc = await upsertTerc(client, rows, opts.asOf);
      stats.asOf ??= rows[0]?.asOf;
      log(`TERC: ${stats.terc}`);
    }

    // --- 3. SIMC: miejscowosci ---------------------------------------
    if (input.simc) {
      const rows = parseSimc(toCsv(input.simc));
      const res = await upsertSimc(client, rows);
      stats.simc = res.inserted;
      stats.simcBezGminy = res.skipped;
      stats.asOf ??= rows[0]?.asOf;
      log(`SIMC: ${res.inserted}${res.skipped ? ` (skipped ${res.skipped} without gminy w TERC)` : ''}`);
    }

    // --- 4. ULIC: katalog ulic ---------------------------------------
    if (input.ulic) {
      const rows = parseUlic(toCsv(input.ulic));
      const res = await upsertUlic(client, rows);
      stats.ulic = res.inserted;
      stats.ulicWithoutLocality = res.skipped;
      stats.asOf ??= rows[0]?.asOf;
      log(`ULIC: ${res.inserted}${res.skipped ? ` (skipped ${res.skipped} without localities w SIMC)` : ''}`);
    }

    await client.query('SELECT address.refresh_derived()');
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  stats.durationSeconds = Math.round((Date.now() - t0) / 1000);
  return stats;
}

async function upsertTerc(
  client: pg.PoolClient,
  rows: TercRow[],
  asOf?: string,
): Promise<number> {
  let n = 0;
  for (const r of rows) {
    const name = r.name || r.nameAdded;
    if (!name) continue;
    await client.query(
      `INSERT INTO address.teryt_unit (terc, name, level, gmina_kind, parent_terc, as_of)
         VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (terc) DO UPDATE SET
         name = EXCLUDED.name,
         level = EXCLUDED.level,
         gmina_kind = EXCLUDED.gmina_kind,
         parent_terc = COALESCE(EXCLUDED.parent_terc, address.teryt_unit.parent_terc),
         as_of = EXCLUDED.as_of`,
      [
        r.terc,
        titleCasePl(name),
        r.level,
        r.kind ? Number(r.kind) : null,
        r.parentTerc ?? null,
        r.asOf || asOf || new Date().toISOString().slice(0, 10),
      ],
    );
    n++;
  }
  return n;
}

/**
 * Buduje mape rozwiazywania TERC gminy.
 *
 * PULAPKA GMIN MIEJSKO-WIEJSKICH:
 * W katalogu TERC gmina miejsko-wiejska wystepuje pod RODZ=3, a dodatkowo
 * jako dwa obszary skladowe: RODZ=4 (miasto) i RODZ=5 (obszar wiejski).
 * Katalogi SIMC i ULIC odwoluja sie do wariantow 4/5, nie do 3.
 *
 * Dopasowanie po pelnym 7-znakowym TERC gubi wiec wszystkie miejscowosci
 * w gminach miejsko-wiejskich - w Polsce jest ich okolo 640, czyli
 * jedna czwarta wszystkich gmin. Blad byly cichy: rekordy po prostu
 * nie trafialyby do bazy.
 *
 * Rozwiazanie: mapa z 6-znakowego prefiksu (WOJ+POW+GMI) na TERC, ktory
 * faktycznie istnieje w bazie. Preferujemy wariant podstawowy, ale
 * akceptujemy kazdy istniejacy.
 */
async function buildGminaResolver(client: pg.PoolClient): Promise<Map<string, string>> {
  const { rows } = await client.query<{ terc: string; gmina_kind: number | null }>(
    `SELECT terc, gmina_kind FROM address.teryt_unit WHERE level = 3`,
  );
  const map = new Map<string, string>();
  // Priorytet: 1,2,3 (gmina wlasciwa) przed 4,5 (obszary skladowe)
  const rank = (r: number | null) => (r === null ? 9 : r <= 3 ? 0 : 1);
  for (const row of rows.sort((a, b) => rank(a.gmina_kind) - rank(b.gmina_kind))) {
    const prefix = row.terc.slice(0, 6);
    if (!map.has(prefix)) map.set(prefix, row.terc);
    // pelny TERC tez musi dzialac, gdy istnieje wprost
    map.set(row.terc, row.terc);
  }
  return map;
}

/**
 * SIMC i ULIC ida przez COPY do tabeli tymczasowej, a nie pojedynczymi
 * INSERT-ami.
 *
 * DLACZEGO: katalogi maja ~103 tys. miejscowosci i ~250 tys. ulic. Wstawianie
 * wiersz po wierszu to tyle samo sekwencyjnych obiegow do bazy - w pomiarze
 * pelny import trwal ponad 20 minut i zdazyl pasc na zerwanym polaczeniu,
 * zanim doszedl do konca. Cala transakcja przepadala. COPY przenosi ten sam
 * zbior jednym strumieniem, a upsert wykonuje sie jako jedna instrukcja.
 *
 * TEMP + INSERT ... SELECT zamiast samego COPY, bo COPY nie zna ON CONFLICT,
 * a semantyka upsertu jest tu wymagana: slowniki aktualizujemy bez kasowania.
 * Tabela znika sama przy COMMIT (ON COMMIT DROP).
 */
async function upsertSimc(
  client: pg.PoolClient,
  rows: SimcRow[],
): Promise<{ inserted: number; skipped: number }> {
  const resolver = await buildGminaResolver(client);

  await client.query(`
    CREATE TEMP TABLE tmp_simc (
      simc text, name text, name_norm text, kind int,
      gmina_terc text, parent_simc text, source_version text
    ) ON COMMIT DROP`);

  const stream = new Readable({ read() {} });
  const done = pipeline(stream, client.query(copyFrom('COPY tmp_simc FROM STDIN')));

  let inserted = 0;
  let skipped = 0;
  // Duplikat SIMC w zrodle wywrocilby upsert bledem "cannot affect row
  // a second time", wiec odsiewamy go po stronie strumienia.
  const seen = new Set<string>();
  for (const r of rows) {
    const terc = resolver.get(r.gminaTerc) ?? resolver.get(r.gminaTerc.slice(0, 6));
    if (!terc) { skipped++; continue; }
    if (seen.has(r.sym)) continue;
    seen.add(r.sym);
    const name = titleCasePl(cleanText(r.name));
    stream.push([
      esc(r.sym), esc(name), esc(normalizeText(name)),
      esc(r.rm ? Number(r.rm) : null),
      esc(terc),
      esc(r.sympod !== r.sym ? r.sympod : null),
      esc(r.asOf || 'teryt'),
    ].join('\t') + '\n');
    inserted++;
  }
  stream.push(null);
  await done;

  await client.query(`
    INSERT INTO address.locality
      (simc, name, name_norm, kind, gmina_terc, parent_simc,
       source, source_version, fetched_at)
    SELECT simc, name, name_norm, kind, gmina_terc, parent_simc,
           'teryt', source_version, now()
      FROM tmp_simc
    ON CONFLICT (simc) DO UPDATE SET
      -- Nazwa z TERYT jest urzedowa i ma pierwszenstwo nad name z PRG.
      name = EXCLUDED.name,
      name_norm = EXCLUDED.name_norm,
      kind = COALESCE(EXCLUDED.kind, address.locality.kind),
      gmina_terc = EXCLUDED.gmina_terc,
      parent_simc = EXCLUDED.parent_simc,
      source_version = EXCLUDED.source_version,
      fetched_at = now(),
      withdrawn_at = NULL`);

  return { inserted, skipped };
}

async function upsertUlic(
  client: pg.PoolClient,
  rows: UlicRow[],
): Promise<{ inserted: number; skipped: number }> {
  const { rows: msc } = await client.query<{ simc: string }>(
    `SELECT simc FROM address.locality`,
  );
  const known = new Set(msc.map((m) => m.simc));

  await client.query(`
    CREATE TEMP TABLE tmp_ulic (
      simc text, sym_ul text, street_type text, name text, name_norm text,
      short_name text, short_name_norm text, name_1 text, name_2 text,
      source_version text
    ) ON COMMIT DROP`);

  const stream = new Readable({ read() {} });
  const done = pipeline(stream, client.query(copyFrom('COPY tmp_ulic FROM STDIN')));

  let inserted = 0;
  let skipped = 0;
  // Klucz taki sam jak indeks docelowy - inaczej upsert dostalby ten sam
  // wiersz dwa razy w jednej instrukcji i przerwal cala transakcje.
  const seen = new Set<string>();
  for (const r of rows) {
    if (!known.has(r.sym)) { skipped++; continue; }
    const name = titleCasePl(cleanText(r.fullName));
    if (!name) continue;
    const nameNorm = normalizeText(name);
    const streetType = r.streetType || null;
    const key = `${r.sym} ${nameNorm} ${streetType ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const shortName = shortStreetName(name);

    stream.push([
      esc(r.sym), esc(r.symUl), esc(streetType), esc(name), esc(nameNorm),
      esc(shortName ?? null), esc(shortName ? normalizeText(shortName) : null),
      esc(r.name1 || null), esc(r.name2 || null),
      esc(r.asOf || 'teryt'),
    ].join('\t') + '\n');
    inserted++;
  }
  stream.push(null);
  await done;

  await client.query(`
    INSERT INTO address.street
      (simc, sym_ul, street_type, name, name_norm, short_name, short_name_norm,
       name_1, name_2, source, source_version, fetched_at)
    SELECT simc, sym_ul, street_type, name, name_norm, short_name, short_name_norm,
           name_1, name_2, 'teryt', source_version, now()
      FROM tmp_ulic
    ON CONFLICT (simc, name_norm, street_type) DO UPDATE SET
      -- SYM_UL z TERYT jest wartoscia dodana: PRG czesto go nie ma.
      sym_ul = COALESCE(EXCLUDED.sym_ul, address.street.sym_ul),
      name = EXCLUDED.name,
      short_name = EXCLUDED.short_name,
      short_name_norm = EXCLUDED.short_name_norm,
      name_1 = EXCLUDED.name_1,
      name_2 = EXCLUDED.name_2,
      source_version = EXCLUDED.source_version,
      fetched_at = now(),
      withdrawn_at = NULL`);

  return { inserted, skipped };
}
