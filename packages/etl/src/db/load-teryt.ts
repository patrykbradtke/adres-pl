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
  ulicBezMiejscowosci: number;
  stanNa?: string;
  czasS: number;
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
  opts: { stanNa?: string; onProgress?: (msg: string) => void } = {},
): Promise<TerytLoadStats> {
  const t0 = Date.now();
  const log = opts.onProgress ?? (() => {});
  const stats: TerytLoadStats = {
    wmrodz: 0, terc: 0, simc: 0, ulic: 0,
    simcBezGminy: 0, ulicBezMiejscowosci: 0,
    stanNa: opts.stanNa, czasS: 0,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- 1. WMRODZ: slownik rodzajow miejscowosci --------------------
    if (input.wmrodz) {
      const rows = parseWmrodz(toCsv(input.wmrodz));
      for (const r of rows) {
        await client.query(
          `INSERT INTO adres.wmrodz (kod, nazwa) VALUES ($1, $2)
             ON CONFLICT (kod) DO UPDATE SET nazwa = EXCLUDED.nazwa`,
          [Number(r.rm), r.nazwaRm],
        );
      }
      stats.wmrodz = rows.length;
      stats.stanNa ??= rows[0]?.stanNa;
      log(`WMRODZ: ${rows.length}`);
    }

    // --- 2. TERC: hierarchia administracyjna -------------------------
    if (input.terc) {
      const rows = parseTerc(toCsv(input.terc));
      // Kolejnosc wg poziomu - klucz obcy `parent_terc` wskazuje w gore
      // hierarchii, wiec wojewodztwa musza wejsc przed powiatami.
      rows.sort((a, b) => a.poziom - b.poziom);
      stats.terc = await upsertTerc(client, rows, opts.stanNa);
      stats.stanNa ??= rows[0]?.stanNa;
      log(`TERC: ${stats.terc}`);
    }

    // --- 3. SIMC: miejscowosci ---------------------------------------
    if (input.simc) {
      const rows = parseSimc(toCsv(input.simc));
      const res = await upsertSimc(client, rows);
      stats.simc = res.wstawione;
      stats.simcBezGminy = res.pominiete;
      stats.stanNa ??= rows[0]?.stanNa;
      log(`SIMC: ${res.wstawione}${res.pominiete ? ` (pominieto ${res.pominiete} bez gminy w TERC)` : ''}`);
    }

    // --- 4. ULIC: katalog ulic ---------------------------------------
    if (input.ulic) {
      const rows = parseUlic(toCsv(input.ulic));
      const res = await upsertUlic(client, rows);
      stats.ulic = res.wstawione;
      stats.ulicBezMiejscowosci = res.pominiete;
      stats.stanNa ??= rows[0]?.stanNa;
      log(`ULIC: ${res.wstawione}${res.pominiete ? ` (pominieto ${res.pominiete} bez miejscowosci w SIMC)` : ''}`);
    }

    await client.query('SELECT adres.refresh_derived()');
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  stats.czasS = Math.round((Date.now() - t0) / 1000);
  return stats;
}

async function upsertTerc(
  client: pg.PoolClient,
  rows: TercRow[],
  stanNa?: string,
): Promise<number> {
  let n = 0;
  for (const r of rows) {
    const nazwa = r.nazwa || r.nazwaDod;
    if (!nazwa) continue;
    await client.query(
      `INSERT INTO adres.teryt_jednostka (terc, nazwa, poziom, rodzaj_gminy, parent_terc, stan_na)
         VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (terc) DO UPDATE SET
         nazwa = EXCLUDED.nazwa,
         poziom = EXCLUDED.poziom,
         rodzaj_gminy = EXCLUDED.rodzaj_gminy,
         parent_terc = COALESCE(EXCLUDED.parent_terc, adres.teryt_jednostka.parent_terc),
         stan_na = EXCLUDED.stan_na`,
      [
        r.terc,
        titleCasePl(nazwa),
        r.poziom,
        r.rodz ? Number(r.rodz) : null,
        r.parentTerc ?? null,
        r.stanNa || stanNa || new Date().toISOString().slice(0, 10),
      ],
    );
    n++;
  }
  return n;
}

/**
 * Buduje mape rozwiazywania TERC gminy.
 *
 * PUŁAPKA GMIN MIEJSKO-WIEJSKICH:
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
  const { rows } = await client.query<{ terc: string; rodzaj_gminy: number | null }>(
    `SELECT terc, rodzaj_gminy FROM adres.teryt_jednostka WHERE poziom = 3`,
  );
  const map = new Map<string, string>();
  // Priorytet: 1,2,3 (gmina wlasciwa) przed 4,5 (obszary skladowe)
  const rank = (r: number | null) => (r === null ? 9 : r <= 3 ? 0 : 1);
  for (const row of rows.sort((a, b) => rank(a.rodzaj_gminy) - rank(b.rodzaj_gminy))) {
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
 * pelny import trwal ponad 20 minut i zdazyl paść na zerwanym polaczeniu,
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
): Promise<{ wstawione: number; pominiete: number }> {
  const resolver = await buildGminaResolver(client);

  await client.query(`
    CREATE TEMP TABLE tmp_simc (
      simc text, nazwa text, nazwa_norm text, rodzaj int,
      terc_gminy text, simc_nadrzedna text, zrodlo_wersja text
    ) ON COMMIT DROP`);

  const stream = new Readable({ read() {} });
  const done = pipeline(stream, client.query(copyFrom('COPY tmp_simc FROM STDIN')));

  let wstawione = 0;
  let pominiete = 0;
  // Duplikat SIMC w zrodle wywrocilby upsert bledem "cannot affect row
  // a second time", wiec odsiewamy go po stronie strumienia.
  const seen = new Set<string>();
  for (const r of rows) {
    const terc = resolver.get(r.tercGminy) ?? resolver.get(r.tercGminy.slice(0, 6));
    if (!terc) { pominiete++; continue; }
    if (seen.has(r.sym)) continue;
    seen.add(r.sym);
    const nazwa = titleCasePl(cleanText(r.nazwa));
    stream.push([
      esc(r.sym), esc(nazwa), esc(normalizeText(nazwa)),
      esc(r.rm ? Number(r.rm) : null),
      esc(terc),
      esc(r.sympod !== r.sym ? r.sympod : null),
      esc(r.stanNa || 'teryt'),
    ].join('\t') + '\n');
    wstawione++;
  }
  stream.push(null);
  await done;

  await client.query(`
    INSERT INTO adres.miejscowosc
      (simc, nazwa, nazwa_norm, rodzaj, terc_gminy, simc_nadrzedna,
       zrodlo, zrodlo_wersja, pobrano)
    SELECT simc, nazwa, nazwa_norm, rodzaj, terc_gminy, simc_nadrzedna,
           'teryt', zrodlo_wersja, now()
      FROM tmp_simc
    ON CONFLICT (simc) DO UPDATE SET
      -- Nazwa z TERYT jest urzedowa i ma pierwszenstwo nad nazwa z PRG.
      nazwa = EXCLUDED.nazwa,
      nazwa_norm = EXCLUDED.nazwa_norm,
      rodzaj = COALESCE(EXCLUDED.rodzaj, adres.miejscowosc.rodzaj),
      terc_gminy = EXCLUDED.terc_gminy,
      simc_nadrzedna = EXCLUDED.simc_nadrzedna,
      zrodlo_wersja = EXCLUDED.zrodlo_wersja,
      pobrano = now(),
      wycofany_od = NULL`);

  return { wstawione, pominiete };
}

async function upsertUlic(
  client: pg.PoolClient,
  rows: UlicRow[],
): Promise<{ wstawione: number; pominiete: number }> {
  const { rows: msc } = await client.query<{ simc: string }>(
    `SELECT simc FROM adres.miejscowosc`,
  );
  const znane = new Set(msc.map((m) => m.simc));

  await client.query(`
    CREATE TEMP TABLE tmp_ulic (
      simc text, sym_ul text, cecha text, nazwa text, nazwa_norm text,
      nazwa_skroc text, nazwa_skroc_norm text, nazwa_1 text, nazwa_2 text,
      zrodlo_wersja text
    ) ON COMMIT DROP`);

  const stream = new Readable({ read() {} });
  const done = pipeline(stream, client.query(copyFrom('COPY tmp_ulic FROM STDIN')));

  let wstawione = 0;
  let pominiete = 0;
  // Klucz taki sam jak indeks docelowy - inaczej upsert dostalby ten sam
  // wiersz dwa razy w jednej instrukcji i przerwal cala transakcje.
  const seen = new Set<string>();
  for (const r of rows) {
    if (!znane.has(r.sym)) { pominiete++; continue; }
    const nazwa = titleCasePl(cleanText(r.nazwaPelna));
    if (!nazwa) continue;
    const nazwaNorm = normalizeText(nazwa);
    const cecha = r.cecha || null;
    const klucz = `${r.sym} ${nazwaNorm} ${cecha ?? ''}`;
    if (seen.has(klucz)) continue;
    seen.add(klucz);
    const skroc = shortStreetName(nazwa);

    stream.push([
      esc(r.sym), esc(r.symUl), esc(cecha), esc(nazwa), esc(nazwaNorm),
      esc(skroc ?? null), esc(skroc ? normalizeText(skroc) : null),
      esc(r.nazwa1 || null), esc(r.nazwa2 || null),
      esc(r.stanNa || 'teryt'),
    ].join('\t') + '\n');
    wstawione++;
  }
  stream.push(null);
  await done;

  await client.query(`
    INSERT INTO adres.ulica
      (simc, sym_ul, cecha, nazwa, nazwa_norm, nazwa_skroc, nazwa_skroc_norm,
       nazwa_1, nazwa_2, zrodlo, zrodlo_wersja, pobrano)
    SELECT simc, sym_ul, cecha, nazwa, nazwa_norm, nazwa_skroc, nazwa_skroc_norm,
           nazwa_1, nazwa_2, 'teryt', zrodlo_wersja, now()
      FROM tmp_ulic
    ON CONFLICT (simc, nazwa_norm, cecha) DO UPDATE SET
      -- SYM_UL z TERYT jest wartoscia dodana: PRG czesto go nie ma.
      sym_ul = COALESCE(EXCLUDED.sym_ul, adres.ulica.sym_ul),
      nazwa = EXCLUDED.nazwa,
      nazwa_skroc = EXCLUDED.nazwa_skroc,
      nazwa_skroc_norm = EXCLUDED.nazwa_skroc_norm,
      nazwa_1 = EXCLUDED.nazwa_1,
      nazwa_2 = EXCLUDED.nazwa_2,
      zrodlo_wersja = EXCLUDED.zrodlo_wersja,
      pobrano = now(),
      wycofany_od = NULL`);

  return { wstawione, pominiete };
}
