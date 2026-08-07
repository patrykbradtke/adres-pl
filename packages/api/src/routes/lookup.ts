/**
 * Endpointy uderzajace do bazy: numery domow, kody pocztowe,
 * geokodowanie odwrotne.
 *
 * Numery domow celowo NIE sa w indeksie. Po wybraniu ulicy jest ich
 * 20-300 - wystarczy B-tree (zmierzone 0,22 ms na 8,5 mln rekordow),
 * a fuzzy matching numerow nie ma sensu.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildingNumberKey } from '@adres-pl/core';

export function registerLookupRoutes(app: FastifyInstance, pool: pg.Pool): void {
  /**
   * Numery na ulicy albo w miejscowosci bez ulic.
   * Zwracamy wszystkie i pozwalamy filtrowac po stronie klienta - to jest
   * tansze niz round-trip przy kazdym znaku.
   */
  app.get<{ Querystring: { ulicId?: number; simc?: string; prefix?: string; limit?: number } }>(
    '/v1/numbers',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            ulicId: { type: 'integer' },
            simc: { type: 'string', pattern: '^[0-9]{7}$' },
            prefix: { type: 'string', maxLength: 12 },
            limit: { type: 'integer', minimum: 1, maximum: 2000, default: 500 },
          },
        },
      },
    },
    async (req, reply) => {
      const { ulicId, simc, prefix, limit = 500 } = req.query;
      if (!ulicId && !simc) {
        return reply.code(400).send({ error: 'Podaj ulicId albo simc.' });
      }

      const params: unknown[] = [];
      let where: string;
      if (ulicId) {
        params.push(ulicId);
        where = 'p.ulic_id = $1';
      } else {
        params.push(simc);
        where = 'p.simc = $1 AND p.ulic_id IS NULL';
      }
      if (prefix) {
        params.push(buildingNumberKey(prefix) + '%');
        where += ` AND p.nr_key LIKE $${params.length}`;
      }
      params.push(limit);

      const { rows } = await pool.query(
        `SELECT p.id, p.prg_local_id, p.nr_budynku, p.kod_pocztowy, p.status,
                ST_Y(p.geom::geometry) AS lat, ST_X(p.geom::geometry) AS lon
           FROM adres.punkt_adresowy p
          WHERE ${where} AND p.wycofany_od IS NULL
          ORDER BY p.nr_sort
          LIMIT $${params.length}`,
        params,
      );
      return { count: rows.length, results: rows };
    },
  );

  /**
   * Kod pocztowy dla konkretnego adresu.
   *
   * UWAGA: kod pochodzi z PRG, czyli z gminnych EMUiA - nie od Poczty Polskiej.
   * Autorytatywny jest Spis PNA (platny, bez API). Rozbieznosci sa normalne
   * i nie powinny blokowac zapisu adresu.
   */
  app.get<{ Querystring: { ulicId?: number; simc?: string; nr: string } }>(
    '/v1/postal-code',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            ulicId: { type: 'integer' },
            simc: { type: 'string', pattern: '^[0-9]{7}$' },
            nr: { type: 'string', minLength: 1, maxLength: 20 },
          },
          required: ['nr'],
        },
      },
    },
    async (req, reply) => {
      const { ulicId, simc, nr } = req.query;
      if (!ulicId && !simc) return reply.code(400).send({ error: 'Podaj ulicId albo simc.' });

      const key = buildingNumberKey(nr);
      const { rows } = await pool.query<{ kod_pocztowy: string | null }>(
        ulicId
          ? `SELECT kod_pocztowy FROM adres.punkt_adresowy
              WHERE ulic_id = $1 AND nr_key = $2 AND wycofany_od IS NULL LIMIT 1`
          : `SELECT kod_pocztowy FROM adres.punkt_adresowy
              WHERE simc = $1 AND ulic_id IS NULL AND nr_key = $2 AND wycofany_od IS NULL LIMIT 1`,
        [ulicId ?? simc, key],
      );

      if (rows.length === 0) {
        // Numeru nie ma - probujemy kodu dominujacego na ulicy jako podpowiedzi
        const { rows: fallback } = await pool.query<{ kod_pocztowy: string; n: string }>(
          ulicId
            ? `SELECT kod_pocztowy, count(*) n FROM adres.punkt_adresowy
                WHERE ulic_id = $1 AND kod_pocztowy IS NOT NULL AND wycofany_od IS NULL
                GROUP BY kod_pocztowy ORDER BY n DESC LIMIT 1`
            : `SELECT kod_pocztowy, count(*) n FROM adres.punkt_adresowy
                WHERE simc = $1 AND kod_pocztowy IS NOT NULL AND wycofany_od IS NULL
                GROUP BY kod_pocztowy ORDER BY n DESC LIMIT 1`,
          [ulicId ?? simc],
        );
        return {
          kodPocztowy: fallback[0]?.kod_pocztowy ?? null,
          zrodlo: fallback.length ? 'dominujacy_na_ulicy' : 'brak',
          uwaga: 'Numeru nie ma w rejestrze. Kod jest przyblizeniem - zweryfikuj przed wysylka.',
        };
      }
      return { kodPocztowy: rows[0].kod_pocztowy, zrodlo: 'rejestr_prg' };
    },
  );

  /** Geokodowanie odwrotne - najblizszy punkt adresowy. */
  app.get<{ Querystring: { lat: number; lon: number; maxM?: number } }>(
    '/v1/reverse',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            lat: { type: 'number', minimum: 48.9, maximum: 55.0 },
            lon: { type: 'number', minimum: 13.9, maximum: 24.3 },
            maxM: { type: 'integer', minimum: 1, maximum: 5000, default: 500 },
          },
          required: ['lat', 'lon'],
        },
      },
    },
    async (req) => {
      const { lat, lon, maxM = 500 } = req.query;
      const { rows } = await pool.query(
        `SELECT a.*, ST_Distance(p.geom, $3::geography) AS odleglosc_m
           FROM adres.punkt_adresowy p
           JOIN adres.adres_pelny a ON a.id = p.id
          WHERE p.wycofany_od IS NULL
            AND ST_DWithin(p.geom, $3::geography, $4)
          ORDER BY p.geom <-> $3::geography
          LIMIT 5`,
        [lat, lon, `SRID=4326;POINT(${lon} ${lat})`, maxM],
      );
      return { results: rows };
    },
  );

  /** Szczegoly miejscowosci - m.in. `maUlice`, ktore steruje formularzem. */
  app.get<{ Params: { simc: string } }>(
    '/v1/locality/:simc',
    { schema: { params: { type: 'object', properties: { simc: { type: 'string', pattern: '^[0-9]{7}$' } } } } },
    async (req, reply) => {
      const { rows } = await pool.query(
        `SELECT m.simc, m.nazwa, m.rodzaj, w.nazwa AS rodzaj_nazwa, m.ma_ulice,
                m.liczba_punktow, m.terc_gminy,
                g.nazwa AS gmina, pw.nazwa AS powiat, woj.nazwa AS wojewodztwo,
                ST_Y(m.centroid::geometry) AS lat, ST_X(m.centroid::geometry) AS lon
           FROM adres.miejscowosc m
           LEFT JOIN adres.wmrodz w ON w.kod = m.rodzaj
           JOIN adres.teryt_jednostka g ON g.terc = m.terc_gminy
           LEFT JOIN adres.teryt_jednostka pw ON pw.terc = g.parent_terc
           LEFT JOIN adres.teryt_jednostka woj ON woj.terc = pw.parent_terc
          WHERE m.simc = $1 AND m.wycofany_od IS NULL`,
        [req.params.simc],
      );
      if (rows.length === 0) return reply.code(404).send({ error: 'Nie znaleziono miejscowosci.' });
      return rows[0];
    },
  );
}
