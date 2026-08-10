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
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import pg from 'pg';
import { IndexHolder } from './search/loader.ts';
import { registerSearchRoutes } from './routes/search.ts';
import { registerLookupRoutes } from './routes/lookup.ts';
import { registerValidateRoutes } from './routes/validate.ts';
import { registerMetricsRoutes, Metrics } from './routes/metrics.ts';
import { registerAdminRoutes, checkOperatorToken } from './routes/admin.ts';
import { registerAuth } from './keys/auth.ts';
import { registerErrorHandling } from './errors.ts';
import { KeyRegistry } from './keys/registry.ts';
import { Peppers } from './keys/pepper.ts';
import { UsageMeter } from './keys/usage.ts';
import { loadConfig, type ServerConfig } from './config.ts';

/**
 * Reeksport dla zgodnosci: kilkanascie testow i skryptow importuje loadConfig
 * oraz parseTrustProxy z tego modulu. Definicje mieszkaja w ./config.ts.
 */
export { loadConfig, parseTrustProxy, parseApiKeyMode, type ServerConfig } from './config.ts';

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

/**
 * Identyfikator korelacji zadania.
 *
 * DOMYSLNY genReqId FASTIFY TU NIE WYSTARCZA: to licznik per INSTANCJA,
 * zaczynajacy od 1. Przy dwoch podach oba maja zadanie `req-1`, wiec
 * zestawienie odpowiedzi z wpisem w dzienniku audytu trafia w cudzy wiersz.
 * Wyszlo to na jaw w zestawie `policy-seam.ts`, ktory swiecil na zielono,
 * bo trafial w wpisy z POPRZEDNICH uruchomien.
 *
 * Naglowek przychodzacy jest honorowany, zeby slad dalo sie przeprowadzic
 * przez kilka uslug - ale PO OCZYSZCZENIU: ta wartosc trafia do logu i do
 * bazy, wiec nie moze byc dowolnym ciagiem od klienta.
 */
function correlationId(req: { headers: Record<string, unknown> }): string {
  const podany = req.headers['x-correlation-id'];
  if (typeof podany === 'string') {
    const czysty = podany.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (czysty.length >= 8) return czysty;
  }
  return randomUUID();
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
    genReqId: correlationId,
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
  const peppers = cfg.peppers.length && cfg.activePepper !== null
    ? new Peppers(new Map(cfg.peppers), cfg.activePepper)
    : null;
  if (cfg.apiKeyMode !== 'disabled' && !peppers) {
    throw new Error(
      `API_KEY_MODE=${cfg.apiKeyMode} wymaga co najmniej jednego pieprza. ` +
      'Ustaw API_KEY_PEPPER_1 (nowy sekret: patrz .env.example).');
  }

  const registry = new KeyRegistry({
    pool,
    connectionString: cfg.databaseUrl,
    refreshMs: cfg.keysRefreshMs,
    onError: (err, where) => app.log.error({ err, where }, 'rejestr kluczy'),
    onInfo: (msg) => app.log.info(msg),
  });

  /**
   * Rejestr rusza WYLACZNIE w trybie innym niz wylaczony.
   *
   * Inaczej tryb przejsciowy przestalby znaczyc "zerowa zmiana": kazdy
   * istniejacy zestaw testow i kazde uruchomienie serwisu zaczelyby wymagac
   * zywej bazy z wgrana migracja 004_licencje.sql.
   */
  if (cfg.apiKeyMode !== 'disabled') {
    await registry.start();
  }

  /**
   * DWIE OSIE KOLEJNOSCI - NIE PRZESTAWIAC BEZ PRZECZYTANIA TEGO.
   *
   * Ponizej limiter jest rejestrowany PRZED uwierzytelnianiem, co wyglada
   * odwrotnie do wymagania bezpieczenstwa. Obie kolejnosci sa poprawne, bo
   * dotycza czego innego:
   *
   *   REJESTRACJA (ten plik, z gory na dol): limiter musi byc pierwszy, bo
   *   registerAuth uzywa app.createRateLimit, ktore powstaje dopiero przy
   *   rejestracji wtyczki. Odwrocenie da blad przy starcie.
   *
   *   WYKONANIE (w czasie zadania): uwierzytelnianie biegnie PIERWSZE, bo jego
   *   hook jest hookiem INSTANCJI, a limiter dokleja sie per trasa - Fastify
   *   sklada tablice jako this[kHooks][hook].concat(opts[hook] || [])
   *   (lib/route.js:391). Dlatego keyGenerator widzi juz gotowe req.klient.
   *
   * Konsekwencja praktyczna: kolejnosci REJESTRACJI nie da sie zamienic, a
   * kolejnosc WYKONANIA nie zalezy od niej wcale. Szczegoly i numery linii
   * w zrodlach - w naglowku keys/auth.ts.
   */
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
      const k = req.client;
      if (!k) return cfg.rateLimitMax;
      return Math.min(k.clientRateLimitPerMin, k.keyRateLimitPerMin ?? Infinity);
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
    keyGenerator: (req) => (req.client ? `k:${req.client.clientId}` : `ip:${req.ip}`),
    /**
     * Domyslne 5000 wpisow to LRU wypychajace najstarsze counters - przy
     * wiekszej przestrzeni kluczy limit dalby sie obejsc samym rozproszeniem.
     * To druga, niezalezna od zadania 8.1 droga obejscia.
     */
    cache: 20_000,
  });

  /**
   * Licznik zuzycia rusza razem z uwierzytelnianiem: bez zweryfikowanego
   * klienta nie ma czego ksiegowac.
   */
  const usage = new UsageMeter({
    pool,
    flushMs: cfg.usageFlushMs,
    onError: (err) => app.log.error({ err }, 'zrzut zuzycia'),
  });

  if (cfg.apiKeyMode !== 'disabled') {
    usage.start();
    registerAuth(app, {
      registry,
      peppers: peppers!,
      usage,
      cfg: {
        mode: cfg.apiKeyMode,
        unauthenticatedLimit: cfg.rateLimitUnauthenticated,
        debugDelayUs: cfg.debugDelayUs,
      },
      onResult: (result) => metrics.authentication(result),
    });
  }

  if (cfg.debugDelayUs > 0) {
    // Furtka pomiarowa nie moze byc wlaczona po cichu - patrz komentarz
    // przy debugOpoznienieUs w config.ts.
    app.log.warn(
      { delayUs: cfg.debugDelayUs },
      "AUTH_DEBUG_OPOZNIENIE_US jest USTAWIONE - sciezka uwierzytelniania jest " +
      "sztucznie spowalniana. To furtka do walidacji przyrzadu pomiarowego; " +
      "na produkcji nie powinna byc wlaczona.");
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
  // Rejestr i licznik zuzycia wystawione tak samo jak pula i indeks: testy
  // musza moc wymusic odswiezenie albo zrzut, zamiast czekac na interwal.
  app.decorate('registry', registry);
  app.decorate('usage', usage);

  await holder.start();

  registerMetricsRoutes(app, pool, holder, metrics, registry, peppers ?? undefined);
  registerSearchRoutes(app, holder);
  registerLookupRoutes(app, pool);
  registerValidateRoutes(app, pool, holder);

  /**
   * Trasy administracyjne istnieja WYLACZNIE przy ustawionym tokenie.
   *
   * Wymagaja tez pieprza, bo wystawienie klucza polega na policzeniu skrotu -
   * bez niego endpoint bylby atrapa konczaca sie bledem przy pierwszym uzyciu.
   */
  /**
   * Kontrakt bledow zakladany PRZED trasami.
   *
   * setErrorHandler i setNotFoundHandler obowiazuja na instancji, wiec
   * kolejnosc wzgledem rejestracji tras nie ma znaczenia dla dzialania -
   * ale ma dla czytania: to jest warstwa, przez ktora przechodzi kazda
   * nieudana odpowiedz, wiec stoi w widocznym miejscu.
   */
  registerErrorHandling(app);

  if (cfg.adminToken) {
    checkOperatorToken(cfg.adminToken);
    if (!peppers) {
      throw new Error('ADMIN_TOKEN ustawiony, ale brak pieprza - wystawienie klucza ' +
        'wymaga policzenia skrotu. Ustaw API_KEY_PEPPER_1.');
    }
    registerAdminRoutes(app, { pool, peppers, token: cfg.adminToken });
  }

  /**
   * Metadane zbioru. Wazniejsze, niz wyglada: pozwala wykryc, ze dane
   * zamarly - dokladnie tak jak w incydencie z czerwca 2024, gdy paczki
   * PRG nie byly odswiezane przez 2 tygodnie i zauwazyla to firma
   * zewnetrzna, a nie GUGiK.
   */
  app.get('/v1/meta', async () => {
    const idx = holder.current;
    const { rows } = await pool.query<{ source: string; version: string; fetchedAt: Date }>(
      `SELECT source, version, max(fetched_at) AS fetched_at
         FROM address.snapshot GROUP BY source, version
         ORDER BY max(fetched_at) DESC LIMIT 10`,
    );
    const newest = rows[0]?.fetchedAt;
    const ageDays = newest ? Math.floor((Date.now() - newest.getTime()) / 86_400_000) : null;
    return {
      index: {
        dataVersion: idx.dataVersion,
        builtAt: idx.header.builtAt,
        counts: idx.header.counts,
      },
      snapshots: rows,
      newestSnapshotAgeDays: ageDays,
      // Sygnal dla monitoringu: PRG aktualizuje sie na biezaco, wiec
      // brak nowego zrzutu przez 30 dni to anomalia, nie normalnosc.
      warning: ageDays !== null && ageDays > 30
        ? `Najnowszy zrzut ma ${ageDays} dni - sprawdz pipeline ETL i dostepnosc zrodla.`
        : undefined,
    };
  });

  app.get('/health', async (_req, reply) => {
    if (!holder.ready) return reply.code(503).send({ status: 'indeks nie zaladowany' });
    return { status: 'ok', dataVersion: holder.current.dataVersion };
  });

  /**
   * Sonda gotowosci - CO JEST WARUNKIEM, A CO NIM NIE JEST.
   *
   * Do 9.08.2026 sonda wykonywala `SELECT 1` i zwracala 503, gdy baza nie
   * odpowiadala. Skutek byl odwrotny do zamierzonego: awaria bazy wyrzucala pod
   * z ruchu takze dla /v1/suggest, ktore bazy w ogole nie dotyka (czyta artefakt
   * z pamieci). Awaria czesciowa zamieniala sie w calkowita.
   *
   * Teraz warunkiem jest STAN TEGO, CZYM POD OBSLUGUJE RUCH:
   *   - artefakt indeksu w pamieci,
   *   - replika rejestru kluczy zaladowana i nieprzeterminowana.
   *
   * Uwierzytelnianie przy niedostepnej bazie dziala DALEJ, z repliki - wpisy
   * zostaly juz raz zweryfikowane, a odrzucanie ich z powodu chwilowej awarii
   * Postgresa zamienialoby ja w awarie calego API. Ryzyko jest ograniczone
   * i mierzalne: przez czas awarii klucz uniewazniony pare minut temu nadal
   * dziala. To okno, nie dziura - i zamyka je prog KEYS_MAX_AGE_S.
   *
   * Dostepnosc samej bazy nie znika z widoku: raportuje ja metryka
   * adres_db_up (regula BazaNiedostepna w deploy/alerty.yaml)
   * oraz podglad /status. To sygnal dla operatora, nie warunek kierowania ruchu.
   */
  app.get('/ready', async (_req, reply) => {
    if (!holder.ready) return reply.code(503).send({ ready: false, reason: 'indeks niezaladowany' });

    if (cfg.apiKeyMode !== 'disabled') {
      // Instancja z niezaladowana replika odpowiada 401 na CALYM ruchu /v1,
      // bo zadnego klucza nie da sie odnalezc. Meldowanie gotowosci byloby
      // stanem gorszym niz jawna niedostepnosc, bo niewidocznym.
      if (!registry.loaded) {
        return reply.code(503).send({ ready: false, reason: 'rejestr kluczy niezaladowany' });
      }
      const ageSeconds = Math.round(registry.ageMs / 1000);
      if (ageSeconds > cfg.keysMaxAgeSeconds) {
        return reply.code(503).send({
          ready: false,
          reason: `replika kluczy przeterminowana (${ageSeconds} s > ${cfg.keysMaxAgeSeconds} s)`,
        });
      }
    }

    return { ready: true };
  });

  app.addHook('onClose', async () => {
    holder.stop();
    // Rejestr trzyma wlasne polaczenie nasluchujace i interwal odswiezania.
    // Bez tego wiersza app.close() konczy sie, ale PROCES NIE - petla zdarzen
    // ma wciaz zywe uchwyty. Objaw: test albo skrypt wisi po zakonczeniu pracy.
    registry.stop();
    // Ostatni zrzut PRZED zamknieciem puli - inaczej zuzycie z ostatniej minuty
    // pracy poda przepada przy kazdym wdrozeniu kroczacym.
    await usage.stop();
    await pool.end();
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    pool: pg.Pool;
    index: IndexHolder;
    registry: KeyRegistry;
    usage: UsageMeter;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const app = await buildServer(cfg);
  await app.listen({ port: cfg.port, host: cfg.host });
}
