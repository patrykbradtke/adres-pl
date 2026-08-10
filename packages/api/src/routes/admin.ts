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
  pieprze: Peppers;
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
function tokenZgodny(podany: string, oczekiwany: string): boolean {
  const a = createHash('sha256').update(podany).digest();
  const b = createHash('sha256').update(oczekiwany).digest();
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

export function sprawdzTokenOperatora(token: string): void {
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
  const { pool, pieprze, token } = deps;

  const straz = async (req: FastifyRequest, reply: FastifyReply) => {
    const naglowek = req.headers.authorization;
    const podany = typeof naglowek === 'string' && naglowek.startsWith('Bearer ')
      ? naglowek.slice(7)
      : null;
    if (!podany || !tokenZgodny(podany, token)) {
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
    preHandler: straz,
    config: { rateLimit: { max: 30, timeWindow: '1 minute', ban: 5, cache: 20_000 } },
  };

  // --- klienci ---------------------------------------------------------

  app.post<{ Body: { nazwa: string; nip?: string; email?: string; pakiet?: string;
    limitNaMinute?: number; kwotaMiesieczna?: number } }>(
    '/admin/clients', opcje, async (req, reply) => {
      const b = req.body;
      const { rows: [r] } = await pool.query(
        `INSERT INTO licencje.klient
           (nazwa, nip, email_kontakt, pakiet, limit_zapytan_min, kwota_miesieczna, utworzony_przez)
         VALUES ($1, $2, $3, coalesce($4, 'test'), coalesce($5, 600), $6, 'admin-api')
         RETURNING id, nazwa, pakiet, limit_zapytan_min, kwota_miesieczna`,
        [b.nazwa, b.nip ?? null, b.email ?? null, b.pakiet ?? null,
          b.limitNaMinute ?? null, b.kwotaMiesieczna ?? null]);
      return reply.code(201).send(r);
    });

  app.get('/admin/clients', opcje, async () => {
    const { rows } = await pool.query(
      `SELECT id, nazwa, nip, email_kontakt, pakiet, limit_zapytan_min,
              kwota_miesieczna, licencja, zawieszony_od, utworzony
         FROM licencje.klient ORDER BY id`);
    return { klienci: rows };
  });

  // --- klucze ----------------------------------------------------------

  /**
   * JEDYNE miejsce w calym serwisie, ktore kiedykolwiek zwraca klucz jawny.
   * Raz, w polu `klucz`, z naglowkiem zabraniajacym cachowania - odpowiedz
   * przechodzi przez proxy i przegladarki, a jej tresc jest poswiadczeniem.
   */
  app.post<{ Body: { klientId: number; srodowisko?: ApiKeyEnvironment;
    nazwa?: string; zastepujeId?: number } }>(
    '/admin/keys', opcje, async (req, reply) => {
      const b = req.body;
      const srodowisko: ApiKeyEnvironment = b.srodowisko === 'test' ? 'test' : 'live';
      const jawny = generateApiKey(srodowisko);
      const { version, hex } = pieprze.hash(jawny);
      const prefiks = srodowisko === 'live' ? 'adr_live_' : 'adr_test_';

      const { rows: [r] } = await pool.query<{ id: string }>(
        `INSERT INTO licencje.klucz_api
           (klient_id, srodowisko, prefiks, hash, pieprz_wersja, nazwa, zastepuje_id, utworzony_przez)
         VALUES ($1, $2, $3, decode($4, 'hex'), $5, $6, $7, 'admin-api')
         RETURNING id`,
        [b.klientId, srodowisko, prefiks, hex, version, b.nazwa ?? null, b.zastepujeId ?? null]);

      return reply.code(201).header('cache-control', 'no-store').send({
        id: Number(r.id),
        klucz: jawny,
        uwaga: 'Ta wartosc nie zostanie pokazana ponownie - w bazie lezy wylacznie skrot.',
      });
    });

  /** Nigdy nie zwraca klucza jawnego ani skrotu - takze w zadnej postaci. */
  app.get('/admin/keys', opcje, async () => {
    const { rows } = await pool.query(
      `SELECT k.id, k.klient_id, c.nazwa AS klient, k.srodowisko, k.prefiks,
              k.pieprz_wersja, k.nazwa, k.wazny_od, k.wazny_do, k.uniewazniony_od,
              k.zastepuje_id, k.limit_zapytan_min,
              coalesce(z.jednostek, 0) AS jednostek_w_okresie
         FROM licencje.klucz_api k
         JOIN licencje.klient c ON c.id = k.klient_id
         LEFT JOIN licencje.zuzycie z
           ON z.klucz_id = k.id AND z.okres = date_trunc('month', now() AT TIME ZONE 'UTC')::date
        ORDER BY k.id`);
    return { klucze: rows };
  });

  /**
   * Rotacja bezprzerwowa: nastepca powstaje obok, a poprzednik dostaje TERMIN,
   * nie natychmiastowe uniewaznienie. Przez okres przejsciowy dzialaja oba.
   */
  app.post<{ Body: { kluczId: number; okresDni?: number } }>(
    '/admin/keys/rotate', opcje, async (req, reply) => {
      const { kluczId, okresDni = 7 } = req.body;
      const { rows: [stary] } = await pool.query<{ klient_id: string; srodowisko: ApiKeyEnvironment }>(
        `SELECT klient_id, srodowisko FROM licencje.klucz_api WHERE id = $1`, [kluczId]);
      if (!stary) return reply.code(404).send({ error: 'Nie ma takiego klucza.' });

      const jawny = generateApiKey(stary.srodowisko);
      const { version, hex } = pieprze.hash(jawny);
      const prefiks = stary.srodowisko === 'live' ? 'adr_live_' : 'adr_test_';

      const { rows: [nowy] } = await pool.query<{ id: string }>(
        `INSERT INTO licencje.klucz_api
           (klient_id, srodowisko, prefiks, hash, pieprz_wersja, zastepuje_id, utworzony_przez)
         VALUES ($1, $2, $3, decode($4, 'hex'), $5, $6, 'admin-api') RETURNING id`,
        [stary.klient_id, stary.srodowisko, prefiks, hex, version, kluczId]);

      await pool.query(
        `UPDATE licencje.klucz_api SET wazny_do = now() + ($2 || ' days')::interval
          WHERE id = $1 AND wazny_do IS NULL`, [kluczId, String(okresDni)]);

      return reply.code(201).header('cache-control', 'no-store').send({
        id: Number(nowy.id),
        klucz: jawny,
        poprzedniDziala: `${okresDni} dni`,
        uwaga: 'Powiadom klienta PRZED koncem okresu przejsciowego - patrz docs/runbook-klucze.md.',
      });
    });

  app.post<{ Body: { kluczId: number; powod?: string } }>(
    '/admin/keys/revoke', opcje, async (req, reply) => {
      const { rowCount } = await pool.query(
        `UPDATE licencje.klucz_api
            SET uniewazniony_od = now(), powod_uniewaznienia = $2
          WHERE id = $1 AND uniewazniony_od IS NULL`,
        [req.body.kluczId, req.body.powod ?? 'przez API administracyjne']);
      if (rowCount === 0) {
        return reply.code(404).send({ error: 'Nie ma takiego klucza albo jest juz uniewazniony.' });
      }
      // Zbieznosc idzie kanalem NOTIFY z wyzwalacza - typowo ponizej 100 ms.
      return { uniewazniony: req.body.kluczId };
    });
}
