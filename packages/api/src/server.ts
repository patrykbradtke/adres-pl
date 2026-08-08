/**
 * adres-pl API - mikroserwis adresowy.
 *
 * PODZIAL ODPOWIEDZIALNOSCI:
 *   typeahead (miejscowosci, ulice) -> indeks w RAM, 0,3-1,1 ms
 *   numery domow, kody, walidacja   -> PostgreSQL, B-tree 0,22 ms
 *   geokodowanie odwrotne           -> PostGIS, indeks GiST
 *
 * Pod jest bezstanowy: caly stan to artefakt indeksu pobrany przy starcie.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import pg from 'pg';
import { IndexHolder } from './search/loader.ts';
import { registerSearchRoutes } from './routes/search.ts';
import { registerLookupRoutes } from './routes/lookup.ts';
import { registerValidateRoutes } from './routes/validate.ts';
import { registerMetricsRoutes, Metrics } from './routes/metrics.ts';

export interface ServerConfig {
  port: number;
  host: string;
  databaseUrl: string;
  indexSource: string;
  indexPointer?: string;
  indexPollMs: number;
  rateLimitMax: number;
  trustProxy: boolean | number | string;
  corsOrigin: string | string[] | boolean;
}

/**
 * Zaufanie do naglowkow proxy przy ustalaniu adresu klienta.
 *
 * Domyslnie WYLACZONE i to jest celowe: gdy proces stoi bezposrednio na porcie,
 * wlaczenie pozwoliloby dowolnemu klientowi podac wlasny X-Forwarded-For, a wiec
 * wlasny klucz limitowania - czyli dokladnie ta luke, ktora zamyka zadanie 8.1.
 *
 * Za ingressem ustawic liczbe przeskokow (TRUST_PROXY=1) albo liste CIDR
 * zaufanych proxy. Bez tego caly ruch wpada do jednego kubelka po adresie
 * ingressu i limit dziala na cala instalacje zamiast na klienta.
 */
export function parseTrustProxy(v?: string): boolean | number | string {
  if (!v || v === 'false') return false;
  if (v === 'true') return true;
  const hops = Number(v);
  return Number.isInteger(hops) && hops >= 0 ? hops : v;
}

export function loadConfig(env = process.env): ServerConfig {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: env.DATABASE_URL ?? 'postgres://adres:adres@localhost:5432/adres',
    indexSource: env.INDEX_SOURCE ?? './data/index/current.bin',
    indexPointer: env.INDEX_POINTER,
    indexPollMs: Number(env.INDEX_POLL_MS ?? 60_000),
    rateLimitMax: Number(env.RATE_LIMIT_MAX ?? 600),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    corsOrigin: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(',') : true,
  };
}

export async function buildServer(cfg: ServerConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Typeahead generuje duzo krotkich zapytan - wylaczamy kosztowne logowanie ciala
    disableRequestLogging: process.env.LOG_REQUESTS !== '1',
    trustProxy: cfg.trustProxy,
  });

  await app.register(cors, { origin: cfg.corsOrigin });
  await app.register(rateLimit, {
    max: cfg.rateLimitMax,
    timeWindow: '1 minute',
    /**
     * Limitujemy WYLACZNIE po adresie klienta.
     *
     * Wczesniej kluczem byl naglowek x-api-key z odwrotem na req.ip. Naglowka
     * nikt nie weryfikuje, wiec klient losujacy jego wartosc przy kazdym zadaniu
     * dostawal za kazdym razem swiezy licznik i calkowicie omijal limitowanie.
     * Nie byl to brak funkcji, tylko dzialajacy mechanizm obejscia.
     *
     * Klucze API z wlasnymi, wyzszymi limitami wracaja dopiero razem
     * z uwierzytelnianiem (etap 8A planu) - kluczem limitowania moze byc
     * wylacznie wartosc, ktora zostala wczesniej zweryfikowana.
     */
    keyGenerator: (req) => req.ip,
  });

  if (cfg.trustProxy === false) {
    app.log.info('TRUST_PROXY wylaczone - limitowanie po adresie polaczenia. ' +
      'Za ingressem ustawic TRUST_PROXY na liczbe przeskokow albo liste CIDR.');
  }

  const pool = new pg.Pool({
    connectionString: cfg.databaseUrl,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    // Typeahead nie dotyka bazy, wiec pula moze byc mala.
    idleTimeoutMillis: 30_000,
  });

  const holder = new IndexHolder({
    source: cfg.indexSource,
    pointer: cfg.indexPointer,
    pollIntervalMs: cfg.indexPollMs,
    onSwap: (from, to) => app.log.info({ from, to }, 'podmieniono artefakt indeksu'),
    onError: (err) => app.log.error({ err }, 'blad odswiezania indeksu'),
  });

  app.decorate('pool', pool);
  app.decorate('index', holder);

  await holder.start();

  const metrics = new Metrics();
  registerMetricsRoutes(app, pool, holder, metrics);
  registerSearchRoutes(app, holder);
  registerLookupRoutes(app, pool);
  registerValidateRoutes(app, pool, holder);

  /**
   * Metadane zbioru. Wazniejsze, niz wyglada: pozwala wykryc, ze dane
   * zamarly - dokladnie tak jak w incydencie z czerwca 2024, gdy paczki
   * PRG nie byly odswiezane przez 2 tygodnie i zauwazyla to firma
   * zewnetrzna, a nie GUGiK.
   */
  app.get('/v1/meta', async () => {
    const idx = holder.current;
    const { rows } = await pool.query<{ zrodlo: string; wersja: string; pobrano: Date }>(
      `SELECT zrodlo, wersja, max(pobrano) AS pobrano
         FROM adres.zrzut GROUP BY zrodlo, wersja
         ORDER BY max(pobrano) DESC LIMIT 10`,
    );
    const newest = rows[0]?.pobrano;
    const wiekDni = newest ? Math.floor((Date.now() - newest.getTime()) / 86_400_000) : null;
    return {
      indeks: {
        wersjaDanych: idx.dataVersion,
        zbudowano: idx.header.builtAt,
        liczby: idx.header.counts,
      },
      zrzuty: rows,
      wiekNajnowszegoZrzutuDni: wiekDni,
      // Sygnal dla monitoringu: PRG aktualizuje sie na biezaco, wiec
      // brak nowego zrzutu przez 30 dni to anomalia, nie normalnosc.
      ostrzezenie: wiekDni !== null && wiekDni > 30
        ? `Najnowszy zrzut ma ${wiekDni} dni - sprawdz pipeline ETL i dostepnosc zrodla.`
        : undefined,
    };
  });

  app.get('/health', async (_req, reply) => {
    if (!holder.ready) return reply.code(503).send({ status: 'indeks nie zaladowany' });
    return { status: 'ok', wersjaDanych: holder.current.dataVersion };
  });

  app.get('/ready', async (_req, reply) => {
    if (!holder.ready) return reply.code(503).send({ ready: false });
    try {
      await pool.query('SELECT 1');
      return { ready: true };
    } catch {
      return reply.code(503).send({ ready: false, powod: 'baza niedostepna' });
    }
  });

  app.addHook('onClose', async () => {
    holder.stop();
    await pool.end();
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    pool: pg.Pool;
    index: IndexHolder;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const app = await buildServer(cfg);
  await app.listen({ port: cfg.port, host: cfg.host });
}
