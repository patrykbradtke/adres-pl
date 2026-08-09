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
import { registerAuth, type ApiKeyMode } from './keys/auth.ts';
import { KeyRegistry } from './keys/registry.ts';
import { Peppers, pepperEntriesFromEnv } from './keys/pepper.ts';

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
  /** Etap 8A. Domyslnie wylaczony - wlaczenie jest osobna decyzja (8.9). */
  apiKeyMode: ApiKeyMode;
  /** Limit na minute z jednego adresu dla ruchu bez waznego klucza. */
  rateLimitNieuwierzytelniony: number;
  kluczeOdswiezanieMs: number;
  /** Pieprze jako zwykle dane - konfiguracja pozostaje serializowalna. */
  pieprze: Array<[number, string]>;
  pieprzAktywny: number | null;
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
    // loadConfig zostaje CZYSTA i nie rzuca, takze przy niespojnej konfiguracji
    // (np. tryb wymagany bez pieprza). Kontrola spojnosci siedzi w buildServer -
    // dzieki temu da sie zbadac sama konfiguracje, nie stawiajac serwera.
    apiKeyMode: parseApiKeyMode(env.API_KEY_MODE),
    rateLimitNieuwierzytelniony: Number(env.RATE_LIMIT_NIEUWIERZYTELNIONY ?? 60),
    kluczeOdswiezanieMs: Number(env.KLUCZE_ODSWIEZANIE_MS ?? 10_000),
    ...(() => { const { sekrety, aktywna } = pepperEntriesFromEnv(env); return { pieprze: sekrety, pieprzAktywny: aktywna }; })(),
  };
}

/** Nieznana wartosc daje 'wylaczony' - najbezpieczniejsza wobec zgodnosci wstecz. */
export function parseApiKeyMode(v?: string): ApiKeyMode {
  return v === 'wymagany' || v === 'opcjonalny' || v === 'wylaczony' ? v : 'wylaczony';
}

export interface BuildOptions {
  /**
   * Podglad rejestrowanych tras. Wolane dla KAZDEJ trasy, w momencie jej
   * rejestracji.
   *
   * Istnieje dla testu zgodnosci z openapi.yaml, ktory wczesniej odczytywal
   * trasy z wydruku printRoutes - a ten jest rysunkiem drzewa dla czlowieka,
   * nie interfejsem programistycznym. Hook musi powstac PRZED rejestracja
   * tras, wiec nie da sie go zalozyc z zewnatrz po zbudowaniu serwera.
   */
  onRoute?: (trasa: { method: string | string[]; url: string }) => void;
}

export async function buildServer(
  cfg: ServerConfig,
  opcje: BuildOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Typeahead generuje duzo krotkich zapytan - wylaczamy kosztowne logowanie ciala
    disableRequestLogging: process.env.LOG_REQUESTS !== '1',
    trustProxy: cfg.trustProxy,
  });

  if (opcje.onRoute) {
    app.addHook('onRoute', (r) => opcje.onRoute!({ method: r.method, url: r.url }));
  }

  await app.register(cors, { origin: cfg.corsOrigin });

  const pool = new pg.Pool({
    connectionString: cfg.databaseUrl,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    // Typeahead nie dotyka bazy, wiec pula moze byc mala.
    idleTimeoutMillis: 30_000,
  });

  // Zbieracz metryk powstaje wczesnie, bo hook uwierzytelniajacy raportuje
  // do niego wyniki, a rejestrowany jest przed trasami.
  const metrics = new Metrics();

  /**
   * Kontrola spojnosci konfiguracji - TUTAJ, nie w loadConfig.
   *
   * Tryb inny niz wylaczony bez pieprza oznaczalby, ze zadnego klucza nie da
   * sie zweryfikowac, czyli 401 na calym ruchu przy w pelni sprawnej usludze.
   * Lepiej nie wstac, i to z komunikatem mowiacym, czego brakuje.
   *
   * loadConfig zostaje czysta i nie rzuca - dzieki temu da sie zbadac sama
   * konfiguracje bez stawiania serwera.
   */
  const pieprze = cfg.pieprze.length && cfg.pieprzAktywny !== null
    ? new Peppers(new Map(cfg.pieprze), cfg.pieprzAktywny)
    : null;
  if (cfg.apiKeyMode !== 'wylaczony' && !pieprze) {
    throw new Error(
      `API_KEY_MODE=${cfg.apiKeyMode} wymaga co najmniej jednego pieprza. ` +
      'Ustaw API_KEY_PEPPER_1 (nowy sekret: patrz .env.example).');
  }

  const rejestr = new KeyRegistry({
    pool,
    connectionString: cfg.databaseUrl,
    odswiezanieMs: cfg.kluczeOdswiezanieMs,
    onError: (err, gdzie) => app.log.error({ err, gdzie }, 'rejestr kluczy'),
    onInfo: (msg) => app.log.info(msg),
  });

  /**
   * Rejestr rusza WYLACZNIE w trybie innym niz wylaczony.
   *
   * Inaczej tryb przejsciowy przestalby znaczyc "zerowa zmiana": kazdy
   * istniejacy zestaw testow i kazde uruchomienie serwisu zaczelyby wymagac
   * zywej bazy z wgrana migracja 003.
   */
  if (cfg.apiKeyMode !== 'wylaczony') {
    await rejestr.start();
  }

  await app.register(rateLimit, {
    /**
     * Limit zalezy od ZWERYFIKOWANEGO klienta, a nie od czegokolwiek, co
     * przyszlo w zadaniu. Funkcja dostaje juz wyliczony klucz kubelka, wiec
     * dziala tylko wtedy, gdy keyGenerator zwrocil tozsamosc - mechanizm
     * sam sie egzekwuje.
     *
     * Math.min, nie ??: limit na kluczu moze wartosc z klienta tylko OBNIZYC.
     * Inaczej klient podnosilby sobie limit, wystawiajac dodatkowy klucz.
     */
    max: (req) => {
      const k = req.klient;
      if (!k) return cfg.rateLimitMax;
      return Math.min(k.limitKlientaNaMinute, k.limitKluczaNaMinute ?? Infinity);
    },
    timeWindow: '1 minute',
    /**
     * KLUCZEM LIMITOWANIA MOZE BYC WYLACZNIE WARTOSC WCZESNIEJ ZWERYFIKOWANA.
     *
     * Do 8.08.2026 bylo tu `req.headers['x-api-key'] ?? req.ip`. Nagowka nikt
     * nie weryfikowal, wiec klient losujacy jego wartosc przy kazdym zadaniu
     * dostawal swiezy licznik i CALKOWICIE omijal limitowanie. Zadanie 8.1
     * przestawilo to na req.ip.
     *
     * Klucze API wracaja tu w etapie 8A, ale czytamy WYLACZNIE req.klient,
     * ktore ustawia jedna funkcja - hook uwierzytelniajacy z keys/auth.ts,
     * dzialajacy w onRequest poziomu instancji, czyli zawsze PRZED tym
     * limiterem (Fastify sklada hooki instancji przed hookami trasy).
     * Surowy naglowek nie moze tu trafic zadna droga.
     *
     * Kubelek jest PER KLIENT, nie per klucz: inaczej klient podnosilby sobie
     * przepustowosc, wystawiajac kolejne klucze.
     *
     * Prefiksy 'k:' i 'ip:' sa konieczne - bez nich przestrzenie identyfikatorow
     * klientow i adresow moglyby sie zlac.
     */
    keyGenerator: (req) => (req.klient ? `k:${req.klient.klientId}` : `ip:${req.ip}`),
    /**
     * Domyslne 5000 wpisow to LRU wypychajace najstarsze liczniki - przy
     * wiekszej przestrzeni kluczy limit dalby sie obejsc samym rozproszeniem.
     * To druga, niezalezna od zadania 8.1 droga obejscia.
     */
    cache: 20_000,
  });

  if (cfg.apiKeyMode !== 'wylaczony') {
    registerAuth(app, {
      rejestr,
      pieprze: pieprze!,
      cfg: {
        mode: cfg.apiKeyMode,
        limitNieuwierzytelniony: cfg.rateLimitNieuwierzytelniony,
      },
      onWynik: (wynik) => metrics.uwierzytelnienie(wynik),
    });
  }

  if (cfg.trustProxy === false) {
    app.log.info('TRUST_PROXY wylaczone - limitowanie po adresie polaczenia. ' +
      'Za ingressem ustawic TRUST_PROXY na liczbe przeskokow albo liste CIDR.');
  }

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

  registerMetricsRoutes(app, pool, holder, metrics, rejestr);
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
    // Rejestr trzyma wlasne polaczenie nasluchujace i interwal odswiezania.
    // Bez tego wiersza app.close() konczy sie, ale PROCES NIE - petla zdarzen
    // ma wciaz zywe uchwyty. Objaw: test albo skrypt wisi po zakonczeniu pracy.
    rejestr.stop();
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
