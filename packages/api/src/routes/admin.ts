/**
 * Endpointy administracyjne - zarzadzanie klientami i kluczami.
 *
 * POZA PRZESTRZENIA /v1 I TO JEST DECYZJA, NIE PRZYPADEK
 *
 * /v1 to kontrakt dla aplikacji klienckich, opisany w openapi.yaml i pilnowany
 * asercja "endpointow /v1 = 11", ktora wystepuje takze w dokumentacji i
 * w dostarczonym juz raporcie. Powierzchnia administracyjna ma inny cykl zycia,
 * innych odbiorcow i inny mechanizm uwierzytelniania, wiec trzymanie jej obok
 * tras klienckich tylko zacieraloby te granice. Przy przenosinach do osobnego
 * serwisu (kandydat: back-end panelu) bedzie to przeprowadzka tras, a nie
 * przepisywanie logiki kluczy.
 *
 * MECHANIZM UWIERZYTELNIANIA JEST ODREBNY OD KLUCZY KLIENCKICH
 *
 * Klucz adr_live_* NIE otwiera zadnej trasy /admin - inaczej dowolny klient
 * wystawilby sobie klucz bez limitow, czyli jedna trasa dawalaby eskalacje
 * uprawnien z klienta na operatora.
 *
 * TRASY ISTNIEJA TYLKO PRZY USTAWIONYM ADMIN_TOKEN
 *
 * Instancja wystawiona na ruch publiczny nie ma ich w routerze w ogole, wiec
 * nie da sie ich znalezc sondowaniem - odpowiedzia jest 404 z kontekstu
 * "nie ma takiej trasy", a nie 401 mowiace "jest, tylko nie dla ciebie".
 *
 * CZEGO TU NIE MA: ROL
 *
 * Panel administracyjny ma wlasny model rol (administrator, operator, podglad)
 * i jest zablokowany etapami 4 i 5. Do czasu jego powstania te endpointy sa
 * uzywane z curl i ze skryptow, gdzie role nie maja czego chronic - jedynym
 * posiadaczem tokenu jest operator.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import pg from 'pg';
import { generateApiKey, type ApiKeyEnvironment } from '@adres-pl/core';
import type { Peppers } from '../keys/pepper.ts';

export interface AdminDeps {
  pool: pg.Pool;
  peppers: Peppers;
  token: string;
}

/**
 * Porownanie tokenu w czasie stalym.
 *
 * Obie strony przepuszczamy przez SHA-256, zeby mialy ROWNA dlugosc 32 bajtow.
 * timingSafeEqual rzuca RangeError przy roznych dlugosciach, wiec porownanie
 * surowych wartosci dawaloby klientowi mozliwosc wywolania kodu 500 samym
 * podaniem krotszego tokenu.
 */
function tokenZgodny(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Wymagania wobec tokenu operatora.
 *
 * Fail-closed przy starcie, tak samo jak przy braku pieprza: token krotszy niz
 * 32 znaki albo oczywisty daje sie zgadnac, a jego zgadniecie omija CALY
 * etap 8A w jednym kroku - z tokenem mozna wystawic sobie klucz bez limitow.
 */
const OCZYWISTE_TOKENY = new Set([
  'admin', 'password', 'secret', 'token', 'changeme', 'test', 'adres',
]);

export function checkOperatorToken(token: string): void {
  if (token.length < 32) {
    throw new Error(
      `ADMIN_TOKEN ma ${token.length} znakow, wymagane co najmniej 32. ` +
      'Wygeneruj: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64url\'))"');
  }
  if (OCZYWISTE_TOKENY.has(token.toLowerCase())) {
    throw new Error('ADMIN_TOKEN jest wartoscia oczywista - wygeneruj losowy.');
  }
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { pool, peppers, token } = deps;

  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const provided = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice(7)
      : null;
    if (!provided || !tokenZgodny(provided, token)) {
      return reply.code(401).send({ error: 'Wymagany token operatora.', code: 'BRAK_TOKENU' });
    }
  };

  /**
   * Wlasny, niski limit. `ban: 5` sprawia, ze po piatej nieudanej probie adres
   * dostaje 403 na cale okno - rozproszona zgadywanka tokenu staje sie kosztowna.
   * `cache` przekazany jawnie, bo magazyn dzieciecy tworzony dla trasy z wlasna
   * konfiguracja NIE dziedziczy ustawienia globalnego.
   */
  const opcje = {
    preHandler: guard,
    config: { rateLimit: { max: 30, timeWindow: '1 minute', ban: 5, cache: 20_000 } },
  };

  // --- klienci ---------------------------------------------------------

  app.post<{ Body: { name: string; nip?: string; email?: string; pakiet?: string;
    limitNaMinute?: number; monthlyQuota?: number } }>(
    '/admin/clients', opcje, async (req, reply) => {
      const b = req.body;
      const { rows: [r] } = await pool.query(
        `INSERT INTO licensing.client
           (name, nip, contact_email, plan, rate_limit_per_min, monthly_quota, created_by)
         VALUES ($1, $2, $3, coalesce($4, 'test'), coalesce($5, 600), $6, 'admin-api')
         RETURNING id, name, plan, rate_limit_per_min, monthly_quota`,
        [b.name, b.nip ?? null, b.email ?? null, b.pakiet ?? null,
          b.limitNaMinute ?? null, b.monthlyQuota ?? null]);
      return reply.code(201).send(r);
    });

  app.get('/admin/clients', opcje, async () => {
    const { rows } = await pool.query(
      `SELECT id, name, nip, contact_email, plan, rate_limit_per_min,
              monthly_quota, license, suspended_at, created_at
         FROM licensing.client ORDER BY id`);
    return { clients: rows };
  });

  // --- klucze ----------------------------------------------------------

  /**
   * JEDYNE miejsce w calym serwisie, ktore kiedykolwiek zwraca klucz jawny.
   * Raz, w polu `klucz`, z naglowkiem zabraniajacym cachowania - odpowiedz
   * przechodzi przez proxy i przegladarki, a jej tresc jest poswiadczeniem.
   */
  app.post<{ Body: { clientId: number; environment?: ApiKeyEnvironment;
    name?: string; replacesId?: number } }>(
    '/admin/keys', opcje, async (req, reply) => {
      const b = req.body;
      const environment: ApiKeyEnvironment = b.environment === 'test' ? 'test' : 'live';
      const plaintext = generateApiKey(environment);
      const { version, hex } = peppers.hash(plaintext);
      const prefix = environment === 'live' ? 'adr_live_' : 'adr_test_';

      const { rows: [r] } = await pool.query<{ id: string }>(
        `INSERT INTO licensing.api_key
           (client_id, environment, prefix, hash, pepper_version, name, replaces_id, created_by)
         VALUES ($1, $2, $3, decode($4, 'hex'), $5, $6, $7, 'admin-api')
         RETURNING id`,
        [b.clientId, environment, prefix, hex, version, b.name ?? null, b.replacesId ?? null]);

      return reply.code(201).header('cache-control', 'no-store').send({
        id: Number(r.id),
        key: plaintext,
        uwaga: 'Ta wartosc nie zostanie pokazana ponownie - w bazie lezy wylacznie skrot.',
      });
    });

  /** Nigdy nie zwraca klucza jawnego ani skrotu - takze w zadnej postaci. */
  app.get('/admin/keys', opcje, async () => {
    const { rows } = await pool.query(
      `SELECT k.id, k.client_id, c.name AS client, k.environment, k.prefix,
              k.pepper_version, k.name, k.valid_from, k.valid_to, k.revoked_at,
              k.replaces_id, k.rate_limit_per_min,
              coalesce(z.units, 0) AS jednostek_w_okresie
         FROM licensing.api_key k
         JOIN licensing.client c ON c.id = k.client_id
         LEFT JOIN licensing.usage z
           ON z.api_key_id = k.id AND z.period = date_trunc('month', now() AT TIME ZONE 'UTC')::date
        ORDER BY k.id`);
    return { keys: rows };
  });

  /**
   * Rotacja bezprzerwowa: nastepca powstaje obok, a poprzednik dostaje TERMIN,
   * nie natychmiastowe uniewaznienie. Przez okres przejsciowy dzialaja oba.
   */
  app.post<{ Body: { keyId: number; periodDays?: number } }>(
    '/admin/keys/rotate', opcje, async (req, reply) => {
      const { keyId, periodDays = 7 } = req.body;
      const { rows: [stary] } = await pool.query<{ client_id: string; environment: ApiKeyEnvironment }>(
        `SELECT client_id, environment FROM licensing.api_key WHERE id = $1`, [keyId]);
      if (!stary) return reply.code(404).send({ error: 'Nie ma takiego klucza.' });

      const plaintext = generateApiKey(stary.environment);
      const { version, hex } = peppers.hash(plaintext);
      const prefix = stary.environment === 'live' ? 'adr_live_' : 'adr_test_';

      const { rows: [created] } = await pool.query<{ id: string }>(
        `INSERT INTO licensing.api_key
           (client_id, environment, prefix, hash, pepper_version, replaces_id, created_by)
         VALUES ($1, $2, $3, decode($4, 'hex'), $5, $6, 'admin-api') RETURNING id`,
        [stary.client_id, stary.environment, prefix, hex, version, keyId]);

      await pool.query(
        `UPDATE licensing.api_key SET valid_to = now() + ($2 || ' days')::interval
          WHERE id = $1 AND valid_to IS NULL`, [keyId, String(periodDays)]);

      return reply.code(201).header('cache-control', 'no-store').send({
        id: Number(created.id),
        key: plaintext,
        previousWorks: `${periodDays} dni`,
        uwaga: 'Powiadom klienta PRZED koncem okresu przejsciowego - patrz docs/runbook-klucze.md.',
      });
    });

  app.post<{ Body: { keyId: number; reason?: string } }>(
    '/admin/keys/revoke', opcje, async (req, reply) => {
      const { rowCount } = await pool.query(
        `UPDATE licensing.api_key
            SET revoked_at = now(), revocation_reason = $2
          WHERE id = $1 AND revoked_at IS NULL`,
        [req.body.keyId, req.body.reason ?? 'przez API administracyjne']);
      if (rowCount === 0) {
        return reply.code(404).send({ error: 'Nie ma takiego klucza albo jest juz uniewazniony.' });
      }
      // Zbieznosc idzie kanalem NOTIFY z wyzwalacza - typowo ponizej 100 ms.
      return { revoked: req.body.keyId };
    });
}
