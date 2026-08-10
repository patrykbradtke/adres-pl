/**
 * Endpointy typeahead - obslugiwane wylacznie z indeksu w RAM.
 * Zadne z tych zapytan nie dotyka bazy.
 */
import type { FastifyInstance } from 'fastify';
import type { IndexHolder } from '../search/loader.ts';

const suggestSchema = {
  querystring: {
    type: 'object',
    properties: {
      q: { type: 'string', minLength: 1, maxLength: 120 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      type: { type: 'string', enum: ['locality', 'street'] },
      simc: { type: 'string', pattern: '^[0-9]{7}$' },
    },
    required: ['q'],
  },
} as const;

export function registerSearchRoutes(app: FastifyInstance, holder: IndexHolder): void {
  /**
   * Uniwersalna podpowiedz: miejscowosci + ulice.
   * Uzywane przez pojedyncze pole "zacznij pisac adres".
   */
  app.get<{ Querystring: { q: string; limit?: number; type?: 'locality' | 'street'; simc?: string } }>(
    '/v1/suggest',
    { schema: suggestSchema },
    async (req) => {
      const { q, limit = 10, type, simc } = req.query;
      const t0 = process.hrtime.bigint();
      const results = holder.current.search(q, { limit, type, simc });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      return {
        query: q,
        results,
        durationMs: Math.round(ms * 1000) / 1000,
        dataVersion: holder.current.dataVersion,
      };
    },
  );

  /** Tylko miejscowosci - pole "miejscowosc". */
  app.get<{ Querystring: { q: string; limit?: number } }>(
    '/v1/localities',
    { schema: suggestSchema },
    async (req) => {
      const { q, limit = 10 } = req.query;
      return { results: holder.current.search(q, { limit, type: 'locality' }) };
    },
  );

  /**
   * Ulice w konkretnej miejscowosci - pole "ulica".
   * `simc` jest wymagany: bez zawezenia lista ulic w Polsce jest bezuzyteczna,
   * bo "Polna" wystepuje w tysiacach miejscowosci.
   */
  app.get<{ Querystring: { q?: string; simc: string; limit?: number } }>(
    '/v1/streets',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string', maxLength: 120 },
            simc: { type: 'string', pattern: '^[0-9]{7}$' },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
          },
          required: ['simc'],
        },
      },
    },
    async (req) => {
      const { q, simc, limit = 20 } = req.query;
      // Puste `q` = "pokaz wszystkie ulice w tej miejscowosci". Uzytkownik
      // klika w pole i chce zobaczyc liste, zanim cokolwiek napisze.
      const results = holder.current.search(q && q.length > 0 ? q : simc, {
        limit,
        simc,
        type: 'street',
        maxCandidates: q && q.length > 0 ? 400 : 2000,
      });
      return { simc, results };
    },
  );
}
