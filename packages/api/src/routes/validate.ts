/**
 * Walidacja i parsowanie adresu.
 *
 * ZASADA NADRZEDNA: walidacja NIGDY nie blokuje zapisu. Zwracamy
 * klasyfikacje (`confidence`) i liste problemow (`issues`), a decyzje
 * o blokadzie podejmuje aplikacja konsumencka.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { IndexHolder } from '../search/loader.ts';
import {
  parseAddressLine, parseNumber, validateAgainstRegistry, toCanonical,
  buildingNumberKey, normalizeText,
  type PlAddress, type RegistryContext,
} from '@adres-pl/core';

interface ValidateBody {
  /** Adres w polach - preferowane. */
  address?: Partial<PlAddress>;
  /** Albo jednym ciagiem - wtedy najpierw parsujemy. */
  raw?: string;
}

export function registerValidateRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  holder: IndexHolder,
): void {
  /** Samo parsowanie, bez odpytywania rejestru. Tanie, do podgladu. */
  app.post<{ Body: { raw: string } }>(
    '/v1/parse',
    { schema: { body: { type: 'object', properties: { raw: { type: 'string', maxLength: 500 } }, required: ['raw'] } } },
    async (req) => parseAddressLine(req.body.raw),
  );

  app.post<{ Body: ValidateBody }>(
    '/v1/validate',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            raw: { type: 'string', maxLength: 500 },
            address: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    async (req) => validateOne(pool, holder, req.body),
  );

  /**
   * Walidacja wsadowa.
   *
   * To INNA sciezka kodu niz typeahead i celowo wolniejsza: nie ma czlowieka
   * czekajacego przy kazdym znaku, wiec mozemy sobie pozwolic na pelne
   * dopasowanie z fuzzy matchingiem i sprawdzeniem alternatyw numeru.
   */
  app.post<{ Body: { items: ValidateBody[] } }>(
    '/v1/batch',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            items: { type: 'array', maxItems: 1000, items: { type: 'object', additionalProperties: true } },
          },
          required: ['items'],
        },
      },
    },
    async (req) => {
      const results = [];
      for (const item of req.body.items) {
        results.push(await validateOne(pool, holder, item));
      }
      return {
        count: results.length,
        summary: results.reduce<Record<string, number>>((acc, r) => {
          acc[r.confidence] = (acc[r.confidence] ?? 0) + 1;
          return acc;
        }, {}),
        results,
      };
    },
  );
}

async function validateOne(
  pool: pg.Pool,
  holder: IndexHolder,
  body: ValidateBody,
) {
  // 1. Zlozenie adresu z pol albo sparsowanie ciagu
  let addr: Partial<PlAddress>;
  if (body.raw) {
    const p = parseAddressLine(body.raw);
    addr = {
      country: 'PL',
      locality: p.locality,
      streetType: p.streetType,
      street: p.street,
      buildingNumber: p.buildingNumber,
      unitNumber: p.unitNumber,
      postalCode: p.postalCode,
      raw: body.raw,
      // Skrytka pocztowa nie ma odpowiednika w rejestrze - deriveConfidence
      // przepuszcza `irregular` bez proby dopasowania. Rozdzial 6.4 raportu.
      ...(p.irregular ? { confidence: 'irregular' as const } : {}),
    };
  } else {
    addr = { ...body.address, country: 'PL' };
  }

  // 2. Rozstrzygniecie miejscowosci. Kotwica adresu - NIE kod pocztowy,
  //    bo PNA nie mapuje sie 1:1 na gmine ani miejscowosc.
  const ctx: RegistryContext = { localityExists: false, localityHasStreets: false };
  let simc = addr.simc;

  if (!simc && addr.locality) {
    const hits = holder.current.search(addr.locality, { limit: 5, type: 'locality' });
    const exact = hits.filter((h) => normalizeText(h.locality) === normalizeText(addr.locality!));
    const pool_ = exact.length ? exact : hits;
    if (pool_.length > 0) {
      simc = pool_[0].simc;
      ctx.candidateCount = exact.length || hits.length;
    }
  }

  if (simc) {
    const { rows } = await pool.query<{ simc: string; name: string; has_streets: boolean; gmina_terc: string }>(
      `SELECT simc, name, has_streets, gmina_terc FROM address.locality
        WHERE simc = $1 AND withdrawn_at IS NULL`,
      [simc],
    );
    if (rows.length) {
      ctx.localityExists = true;
      ctx.localityHasStreets = rows[0].has_streets;
      addr.simc = rows[0].simc;
      addr.locality = rows[0].name;
      addr.gminaTerc = rows[0].gmina_terc;
    }
  }

  // 3. Ulica - zawsze w kontekscie miejscowosci
  let ulicId: number | undefined;
  if (addr.street && ctx.localityExists) {
    const hits = holder.current.search(addr.street, { limit: 5, type: 'street', simc: addr.simc });
    if (hits.length > 0 && hits[0].ulicId !== undefined) {
      ulicId = hits[0].ulicId;
      ctx.streetExists = true;
      addr.street = hits[0].street ?? addr.street;
      addr.streetType = hits[0].streetType ?? addr.streetType;
    } else {
      ctx.streetExists = false;
    }
  }

  // 4. Numer. Tu rozstrzygamy dwuznacznosc `12/14`.
  if (addr.buildingNumber && (ulicId || (ctx.localityExists && !ctx.localityHasStreets))) {
    const parsed = parseNumber(
      addr.unitNumber ? `${addr.buildingNumber}/${addr.unitNumber}` : addr.buildingNumber,
    );
    const kandydaci: Array<{ nr: string; lok?: string }> = [];
    if (parsed) {
      kandydaci.push({ nr: parsed.buildingNumber, lok: parsed.unitNumber });
      for (const alt of parsed.alternatives ?? []) kandydaci.push({ nr: alt.buildingNumber, lok: alt.unitNumber });
    } else {
      kandydaci.push({ nr: addr.buildingNumber, lok: addr.unitNumber });
    }

    let found = false;
    for (const k of kandydaci) {
      const row = await lookupNumber(pool, ulicId, addr.simc, k.nr);
      if (row) {
        // Jesli trafil wariant alternatywny (np. budynek "12/14"),
        // przyjmujemy odczyt REJESTRU, nie heurystyki parsera.
        addr.buildingNumber = row.building_number;
        addr.unitNumber = k.lok;
        addr.prgLocalId = row.prg_local_id ?? undefined;
        addr.lat = row.lat ?? undefined;
        addr.lon = row.lon ?? undefined;
        ctx.registryPostalCode = row.postal_code ?? undefined;
        ctx.pointStatus = row.status ?? undefined;
        ctx.numberExists = true;
        found = true;
        break;
      }
    }
    if (!found) {
      ctx.numberExists = false;
      if (parsed) { addr.buildingNumber = parsed.buildingNumber; addr.unitNumber = parsed.unitNumber ?? addr.unitNumber; }
    }
  }

  const result = validateAgainstRegistry(addr, ctx);
  return {
    ...result,
    address: toCanonical({ ...result.address, confidence: result.confidence }),
    dataVersion: holder.current.dataVersion,
  };
}

interface NumberRow {
  prg_local_id: string | null;
  building_number: string;
  postal_code: string | null;
  status: string | null;
  lat: number | null;
  lon: number | null;
}

async function lookupNumber(
  pool: pg.Pool,
  ulicId: number | undefined,
  simc: string | undefined,
  nr: string,
): Promise<NumberRow | null> {
  const key = buildingNumberKey(nr);
  const { rows } = await pool.query<NumberRow>(
    ulicId
      ? `SELECT prg_local_id, building_number, postal_code, status,
                ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lon
           FROM address.address_point
          WHERE ulic_id = $1 AND building_number_key = $2 AND withdrawn_at IS NULL LIMIT 1`
      : `SELECT prg_local_id, building_number, postal_code, status,
                ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lon
           FROM address.address_point
          WHERE simc = $1 AND ulic_id IS NULL AND building_number_key = $2 AND withdrawn_at IS NULL LIMIT 1`,
    [ulicId ?? simc, key],
  );
  return rows[0] ?? null;
}
