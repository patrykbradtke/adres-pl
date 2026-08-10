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
import { appError, buildingNumberKey } from '@adres-pl/core';

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
        throw appError('INVALID_PARAMETER', { required: 'ulicId albo simc' },
          'Podaj ulicId albo simc.');
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
        where += ` AND p.building_number_key LIKE $${params.length}`;
      }
      params.push(limit);

      const { rows } = await pool.query(
        `SELECT p.id, p.prg_local_id, p.building_number, p.postal_code, p.status,
                ST_Y(p.geom::geometry) AS lat, ST_X(p.geom::geometry) AS lon
           FROM address.address_point p
          WHERE ${where} AND p.withdrawn_at IS NULL
          ORDER BY p.building_number_sort
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
      if (!ulicId && !simc) {
        throw appError('INVALID_PARAMETER', { required: 'ulicId albo simc' },
          'Podaj ulicId albo simc.');
      }

      const key = buildingNumberKey(nr);
      const { rows } = await pool.query<{ postal_code: string | null }>(
        ulicId
          ? `SELECT postal_code FROM address.address_point
              WHERE ulic_id = $1 AND building_number_key = $2 AND withdrawn_at IS NULL LIMIT 1`
          : `SELECT postal_code FROM address.address_point
              WHERE simc = $1 AND ulic_id IS NULL AND building_number_key = $2 AND withdrawn_at IS NULL LIMIT 1`,
        [ulicId ?? simc, key],
      );

      if (rows.length === 0) {
        // Numeru nie ma - probujemy kodu dominujacego na ulicy jako podpowiedzi
        const { rows: fallback } = await pool.query<{ postal_code: string; n: string }>(
          ulicId
            ? `SELECT postal_code, count(*) n FROM address.address_point
                WHERE ulic_id = $1 AND postal_code IS NOT NULL AND withdrawn_at IS NULL
                GROUP BY postal_code ORDER BY n DESC LIMIT 1`
            : `SELECT postal_code, count(*) n FROM address.address_point
                WHERE simc = $1 AND postal_code IS NOT NULL AND withdrawn_at IS NULL
                GROUP BY postal_code ORDER BY n DESC LIMIT 1`,
          [ulicId ?? simc],
        );
        return {
          postalCode: fallback[0]?.postal_code ?? null,
          source: fallback.length ? 'dominant_on_street' : 'none',
          note: 'Numeru nie ma w rejestrze. Kod jest przyblizeniem - zweryfikuj przed wysylka.',
        };
      }
      return { postalCode: rows[0].postal_code, source: 'prg_registry' };
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
      // $1 to punkt, $2 promien. Wczesniej lista parametrow zaczynala sie od
      // `lat` i `lon`, ktorych zapytanie nie uzywa w ogole - Postgres nie mial
      // z czego wywiesc ich typu i cala trasa konczyla sie bledem 500
      // ("could not determine data type of parameter $1").
      const { rows } = await pool.query(
        `SELECT a.*, ST_Distance(p.geom, $1::geography) AS distance_m
           FROM address.address_point p
           JOIN address.full_address a ON a.id = p.id
          WHERE p.withdrawn_at IS NULL
            AND ST_DWithin(p.geom, $1::geography, $2)
          ORDER BY p.geom <-> $1::geography
          LIMIT 5`,
        [`SRID=4326;POINT(${lon} ${lat})`, maxM],
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
        `SELECT m.simc, m.name, m.kind, w.name AS kind_name, m.has_streets,
                m.point_count, m.gmina_terc,
                g.name AS gmina, pw.name AS powiat, woj.name AS voivodeship,
                ST_Y(m.centroid::geometry) AS lat, ST_X(m.centroid::geometry) AS lon
           FROM address.locality m
           LEFT JOIN address.wmrodz w ON w.code = m.kind
           JOIN address.teryt_unit g ON g.terc = m.gmina_terc
           LEFT JOIN address.teryt_unit pw ON pw.terc = g.parent_terc
           LEFT JOIN address.teryt_unit woj ON woj.terc = pw.parent_terc
          WHERE m.simc = $1 AND m.withdrawn_at IS NULL`,
        [req.params.simc],
      );
      if (rows.length === 0) throw appError('LOCALITY_NOT_FOUND', { simc: req.params.simc });
      return rows[0];
    },
  );
}
