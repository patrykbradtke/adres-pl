/**
 * Jedna warstwa zamieniajaca wyjatek na odpowiedz.
 *
 * ZASADA: kod stanu wynika ze SWIADOMEJ decyzji, a nie z tego, jaki wyjatek
 * akurat doleciał z biblioteki. Wszystko, co nie jest rozpoznane, konczy sie
 * jako 500 INTERNAL - bo czym innym mialoby byc? Zgadywanie po tresci
 * komunikatu dawaloby kody stanu, ktore klamia.
 *
 * CO TO NAPRAWIA
 *
 * Przed ta warstwa `POST /admin/keys` z nieistniejacym clientId zwracalo 500
 * z trescia `insert or update on table "api_key" violates foreign key
 * constraint "klucz_api_klient_id_fkey"`. Trzy bledy w jednej odpowiedzi:
 * zly kod stanu, wyciek budowy schematu i ksztalt ciala inny niz reszta.
 *
 * IDENTYFIKATOR KORELACJI
 *
 * Uzywamy `req.id` Fastify - jest juz unikatowy na zadanie i juz trafia do
 * logu jako `reqId`. Nowa maszyneria bylaby drugim mechanizmem obok
 * dzialajacego. Wedruje do naglowka odpowiedzi, do logu i do
 * `panel.audit_log.correlation_id`, wiec odpowiedz, wpis w logu i wpis
 * w dzienniku da sie zestawic ze soba.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, Forbidden, PolicyUsageError, errorDef, type ErrorBody } from '@adres-pl/core';

/** Nazwa naglowka z identyfikatorem korelacji. */
export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Mapowanie SQLSTATE.
 *
 * Wpisujemy WYLACZNIE te, ktore sa bledem WOLAJACEGO. Cala reszta - w tym
 * 42703 (nie ma takiej kolumny) i 42P01 (nie ma takiej tabeli) - to nasza
 * wada i ma isc jako 500. Zamiana ich na 400 ukrylaby usterke pod kodem
 * sugerujacym, ze zawinil klient. Dokladnie taka usterka siedziala
 * w `/v1/numbers` (`p.wycofany_od` po migracji 005).
 */
const SQLSTATE: Record<string, { code: string; info?: (e: DbError) => Record<string, unknown> }> = {
  '23505': { code: 'ALREADY_EXISTS' },              // unique_violation
  '23503': { code: 'CONFLICT' },                    // foreign_key_violation
  '23514': { code: 'INVALID_PARAMETER' },           // check_violation
  '23502': { code: 'INVALID_PARAMETER' },           // not_null_violation
  '22P02': { code: 'INVALID_PARAMETER' },           // invalid_text_representation
  '22001': { code: 'INVALID_PARAMETER' },           // string_data_right_truncation
  '40001': { code: 'CONFLICT' },                    // serialization_failure
  '40P01': { code: 'CONFLICT' },                    // deadlock_detected
  '57014': { code: 'NOT_READY' },                   // query_canceled
};

interface DbError { code?: string; constraint?: string; column?: string; table?: string }

interface Rozpoznanie {
  status: number;
  code: string;
  message: string;
  info?: Record<string, unknown>;
  /** Czy to nasza wada - decyduje o poziomie logu. */
  ourFault: boolean;
}

function recognise(err: unknown): Rozpoznanie {
  // 1. Blad dziedzinowy - autor swiadomie wybral kod.
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, message: err.message, info: err.info, ourFault: false };
  }

  // 2. Odmowa z silnika polityki. Uzasadnienie idzie do `info`, bo jest
  //    dla czlowieka konkretne ("zawezone do TERC 14, a czynnosc dotyczy
  //    TERC 1261011") i nie zdradza niczego, czego pytajacy juz nie wie.
  if (err instanceof Forbidden) {
    const def = errorDef('FORBIDDEN')!;
    return { status: def.status, code: def.code, message: def.message,
      info: { reason: err.reason }, ourFault: false };
  }

  // 3. Zle UZYCIE silnika polityki to nasz blad, nie odmowa. Gdyby szlo jako
  //    403, pomylka programisty wygladalaby jak poprawnie dzialajaca kontrola
  //    dostepu i nikt by jej nie znalazl.
  if (err instanceof PolicyUsageError) {
    return { status: 500, code: 'INTERNAL', message: errorDef('INTERNAL')!.message, ourFault: true };
  }

  // 4. Walidacja schematu przez Fastify.
  const f = err as { validation?: unknown[]; statusCode?: number; code?: string; message?: string };
  if (f.validation) {
    const def = errorDef('VALIDATION_FAILED')!;
    return { status: def.status, code: def.code, message: def.message,
      info: { details: f.message }, ourFault: false };
  }

  // 5. Blad bazy.
  const db = err as DbError;
  if (db.code && SQLSTATE[db.code]) {
    const def = errorDef(SQLSTATE[db.code].code)!;
    // Nazwa ograniczenia i kolumny NIE ida do klienta - opisuja budowe
    // schematu. Ida do logu.
    return { status: def.status, code: def.code, message: def.message, ourFault: false };
  }

  // 6. Fastify sam ustawil kod stanu 4xx (np. nieobslugiwany typ tresci).
  if (typeof f.statusCode === 'number' && f.statusCode >= 400 && f.statusCode < 500) {
    return { status: f.statusCode, code: 'INVALID_PARAMETER',
      message: errorDef('INVALID_PARAMETER')!.message, ourFault: false };
  }

  // 7. Wszystko pozostale.
  return { status: 500, code: 'INTERNAL', message: errorDef('INTERNAL')!.message, ourFault: true };
}

export function buildErrorBody(err: unknown, correlationId: string): { status: number; body: ErrorBody } {
  const r = recognise(err);
  const body: ErrorBody = { code: r.code, error: r.message, correlationId };
  if (r.info) body.info = r.info;
  return { status: r.status, body };
}

export function registerErrorHandling(app: FastifyInstance): void {
  // Identyfikator korelacji w KAZDEJ odpowiedzi, nie tylko blednej - inaczej
  // nie da sie zestawic udanego zadania z jego wpisami w dzienniku audytu.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header(CORRELATION_HEADER, req.id);
  });

  app.setErrorHandler((err, req, reply) => {
    const r = recognise(err);
    const { body } = buildErrorBody(err, String(req.id));

    const kontekst = {
      code: r.code,
      status: r.status,
      route: req.routeOptions?.url ?? req.url,
      // Pelny szczegol bledu bazy TYLKO do logu.
      db: (err as DbError).code
        ? { sqlstate: (err as DbError).code, constraint: (err as DbError).constraint }
        : undefined,
    };

    if (r.ourFault) {
      // Nasza wada - pelny slad, bo bez niego nie ma czego szukac.
      req.log.error({ ...kontekst, err }, 'blad wewnetrzny');
    } else if (r.status >= 500) {
      req.log.error(kontekst, 'blad');
    } else {
      // Odmowy i bledy wolajacego: bez sladu stosu, bo nie ma w nim nic
      // ciekawego, a przy skanowaniu zapelnilyby wolumen.
      req.log.warn(kontekst, 'zadanie odrzucone');
    }

    return reply.code(r.status).send(body);
  });

  // Nieznana trasa tez ma odpowiadac tym samym ksztaltem - inaczej klient
  // dostaje dwa rozne formaty bledu w zaleznosci od literowki w sciezce.
  app.setNotFoundHandler((req, reply) => {
    const def = errorDef('NOT_FOUND')!;
    return reply.code(def.status).send({
      code: def.code,
      error: def.message,
      info: { route: `${req.method} ${req.url}` },
      correlationId: String(req.id),
    } satisfies ErrorBody);
  });
}
