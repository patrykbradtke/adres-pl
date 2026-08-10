/**
 * Metryki operacyjne w formacie tekstowym Prometheusa.
 *
 * CO WARTO MONITOROWAC I DLACZEGO
 *
 *  adres_data_age_days
 *    Najwazniejsza metryka calego systemu. PRG aktualizuje sie na biezaco,
 *    wiec rosnacy wiek danych oznacza, ze albo pipeline stanal, albo zrodlo
 *    przestalo publikowac. Dokladnie tak wygladal incydent z czerwca 2024,
 *    gdy paczki nie byly odswiezane przez dwa tygodnie i zauwazyla to firma
 *    zewnetrzna, a nie instytucja prowadzaca rejestr.
 *    Alarm: > 30 dni.
 *
 *  adres_etl_halted_total
 *    Liczba cykli zatrzymanych przez kontrole jakosci. Wartosc niezerowa
 *    NIE jest awaria - to zadzialalo zabezpieczenie. Ale wymaga decyzji
 *    czlowieka, wiec musi byc widoczna.
 *
 *  adres_index_version_info
 *    Pozwala wykryc rozjechanie sie wersji miedzy instancjami mikroserwisu
 *    po nieudanej podmianie artefaktu.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { IndexHolder } from '../search/loader.ts';

/** Lekki zbieracz metryk zapytan - bez zewnetrznych zaleznosci. */
export class Metrics {
  private counts = new Map<string, number>();
  private sumMs = new Map<string, number>();
  /** Progi histogramu dobrane pod typeahead: 0,5 ms to nasza mediana. */
  private buckets = [0.5, 1, 2, 5, 10, 25, 100, 500];
  private hist = new Map<string, number[]>();
  readonly startedAt = Date.now();

  /**
   * Wyniki uwierzytelnienia. Zbior wartosci jest DOMKNIETY (ok, brak_klucza,
   * nieprawidlowy, wygasly, uniewazniony, zawieszony, limit_prob) - zadnego
   * identyfikatora klienta ani prefiksu klucza, bo to wysadziloby kardynalnosc
   * Prometheusa. Wymiar klienta to osobne zadanie (8.12).
   */
  private authCounters = new Map<string, number>();

  authentication(result: string): void {
    this.authCounters.set(result, (this.authCounters.get(result) ?? 0) + 1);
  }

  observe(endpoint: string, ms: number): void {
    this.counts.set(endpoint, (this.counts.get(endpoint) ?? 0) + 1);
    this.sumMs.set(endpoint, (this.sumMs.get(endpoint) ?? 0) + ms);
    let h = this.hist.get(endpoint);
    if (!h) { h = new Array(this.buckets.length + 1).fill(0); this.hist.set(endpoint, h); }
    let i = 0;
    while (i < this.buckets.length && ms > this.buckets[i]) i++;
    h[i]++;
  }

  render(): string[] {
    const out: string[] = [];
    out.push('# HELP adres_requests_total Liczba obsluzonych zapytan.');
    out.push('# TYPE adres_requests_total counter');
    for (const [ep, n] of this.counts) out.push(`adres_requests_total{endpoint="${ep}"} ${n}`);

    out.push('# HELP adres_request_ms Czas obslugi zapytania w milisekundach.');
    out.push('# TYPE adres_request_ms histogram');
    for (const [ep, h] of this.hist) {
      let cum = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cum += h[i];
        out.push(`adres_request_ms_bucket{endpoint="${ep}",le="${this.buckets[i]}"} ${cum}`);
      }
      cum += h[this.buckets.length];
      out.push(`adres_request_ms_bucket{endpoint="${ep}",le="+Inf"} ${cum}`);
      out.push(`adres_request_ms_sum{endpoint="${ep}"} ${(this.sumMs.get(ep) ?? 0).toFixed(3)}`);
      out.push(`adres_request_ms_count{endpoint="${ep}"} ${cum}`);
    }

    if (this.authCounters.size > 0) {
      out.push('# HELP adres_auth_total Rozstrzygniecia uwierzytelnienia klucza API.');
      out.push('# TYPE adres_auth_total counter');
      for (const [result, n] of this.authCounters) {
        out.push(`adres_auth_total{result="${result}"} ${n}`);
      }
    }
    return out;
  }
}

export function registerMetricsRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  holder: IndexHolder,
  metrics: Metrics,
  registry?: {
    size: number; ageMs: number; loaded: boolean; notificationCount: number;
  },
  /** Do odcisku zestawu pieprzy w /status - patrz komentarz przy uzyciu. */
  peppers?: { fingerprint(): Array<{ version: number; odcisk: string }> },
): void {
  /**
   * Pomiar czasu dla zapytan /v1/*.
   *
   * Dwa warunki, oba istotne:
   *
   * 1. Etykieta liczona WYLACZNIE z req.routeOptions.url, bez odwrotu na
   *    req.url. Odwrot byl luka kardynalnosci: zadania na nieistniejace
   *    sciezki maja routeOptions.url === undefined, wiec do etykiety trafialby
   *    dowolny ciag podany przez klienta. Skanowanie sciezek zamienialoby sie
   *    w nieograniczona liczbe szeregow czasowych w Prometheusie.
   *
   * 2. Tylko odpowiedzi ponizej 400. Odrzucenia uwierzytelnienia i limitu
   *    konczy sie w onRequest, bez dotkniecia bazy i indeksu - rzad 0,05 ms.
   *    Wpadajac do tego samego histogramu, zanizalyby p50/p95/p99, a wraz
   *    z nimi uniewaznily prog alertu WysokaLatencjaPodpowiedzi (60 ms)
   *    i utopily prog "+0,3 ms" z zadania 8.8.
   */
  app.addHook('onResponse', async (req, reply) => {
    const url = req.routeOptions?.url;
    if (!url || !url.startsWith('/v1/') || reply.statusCode >= 400) return;
    metrics.observe(url, reply.elapsedTime);
  });

  /**
   * Cache zliczen ze stanu danych - uzasadnienie przy uzyciu, nizej.
   * Domyslnie 60 s: dane zmieniaja sie po publikacji, czyli raz w tygodniu,
   * a zbieranie metryk chodzi co 15 s.
   */
  const DATA_STATE_TTL_MS = Number(process.env.METRICS_CACHE_MS ?? 60_000);
  let dataState = { ageDays: -1, points: 0, localities: 0, streets: 0 };
  let dataStateTs = 0;

  /**
   * Piec niezaleznych zrodel metryk, kazde w osobnej funkcji.
   *
   * Wczesniej caly handler byl jednym cialem o 165 liniach: piec blokow
   * z wlasna obsluga bledow, wspolna zmienna bazaOk i domknieciem cache'u.
   * Dodanie szostego zrodla oznaczalo wejscie w srodek tego bloku i zgadywanie,
   * co jeszcze od czego zalezy.
   *
   * Jedyne wspoldzielenie, ktore zostalo, jest jawne: stan danych ZWRACA
   * bazaOk, bo dostepnosc bazy jest sygnalem samym w sobie i sonduje sie ja
   * przy okazji zapytania, ktore i tak wykonujemy.
   */
  async function dataStateMetrics(): Promise<{ lines: string[]; dbOk: number }> {
    const lines: string[] = [];
    // --- stan danych -------------------------------------------------
    //
    // Zliczenia sa CACHOWANE, dostepnosc bazy NIE.
    //
    // Trzy `count(*)` na tabelach produkcyjnych kosztuja na pelnym kraju
    // 4,4 s (8,6 mln punktow, zmierzone 9.08.2026). Przy zbieraniu co 15 s
    // i domyslnym limicie 10 s oznacza to endpoint stale na granicy timeoutu,
    // a kazde zbieranie obciaza baze pelnym skanem. Liczby zmieniaja sie
    // wylacznie po publikacji, czyli raz w tygodniu - cache jest tu darmowy.
    //
    // Dostepnosci bazy cachowac nie wolno: to sygnal dla alertu
    // BazaNiedostepna z progiem 2 minut. Zamiast tego tania sonda SELECT 1
    // przy kazdym zbieraniu.
    let dbOk = 1;
    try {
      await pool.query('SELECT 1');
    } catch {
      dbOk = 0;
    }

    if (dbOk === 1 && Date.now() - dataStateTs > DATA_STATE_TTL_MS) {
      try {
        const { rows: [d] } = await pool.query<{
          age: string | null; points: string; localities: string; streets: string;
        }>(`
          SELECT
            EXTRACT(EPOCH FROM now() - (
              SELECT max(fetched_at) FROM address.snapshot
               WHERE source='prg' AND status='opublikowany'))::text AS age,
            (SELECT count(*) FROM address.address_point WHERE withdrawn_at IS NULL)::text AS points,
            (SELECT count(*) FROM address.locality  WHERE withdrawn_at IS NULL)::text AS localities,
            (SELECT count(*) FROM address.street        WHERE withdrawn_at IS NULL)::text AS streets
        `);
        dataState = {
          ageDays: d.age ? Number(d.age) / 86400 : -1,
          points: Number(d.points),
          localities: Number(d.localities),
          streets: Number(d.streets),
        };
        dataStateTs = Date.now();
      } catch {
        dbOk = 0;   // sonda przeszla, ale odczyt nie - i tak zglaszamy problem
      }
    }
    const { ageDays, points, localities, streets } = dataState;

    lines.push('# HELP adres_db_up Czy baza danych odpowiada (1/0).');
    lines.push('# TYPE adres_db_up gauge');
    lines.push(`adres_db_up ${dbOk}`);

    lines.push('# HELP adres_data_age_days Wiek najnowszego opublikowanego zrzutu w dniach. -1 = brak zrzutu.');
    lines.push('# TYPE adres_data_age_days gauge');
    lines.push(`adres_data_age_days ${ageDays.toFixed(3)}`);

    lines.push('# HELP adres_address_points_total Liczba aktywnych punktow adresowych.');
    lines.push('# TYPE adres_address_points_total gauge');
    lines.push(`adres_address_points_total ${points}`);
    lines.push('# HELP adres_localities_total Liczba aktywnych miejscowosci.');
    lines.push('# TYPE adres_localities_total gauge');
    lines.push(`adres_localities_total ${localities}`);
    lines.push('# HELP adres_streets_total Liczba aktywnych ulic.');
    lines.push('# TYPE adres_streets_total gauge');
    lines.push(`adres_streets_total ${streets}`);

    return { lines: lines, dbOk };
  }

  async function etlMetrics(): Promise<string[]> {
    const lines: string[] = [];
    // --- stan ETL ----------------------------------------------------
    try {
      const { rows } = await pool.query<{ status: string; n: string }>(
        `SELECT status, count(*)::text n FROM address.etl_run
          WHERE started_at > now() - interval '30 days' GROUP BY status`,
      );
      lines.push('# HELP adres_etl_runs_total Cykle ETL z ostatnich 30 dni wg statusu.');
      lines.push('# TYPE adres_etl_runs_total gauge');
      for (const r of rows) lines.push(`adres_etl_runs_total{status="${r.status}"} ${r.n}`);

      const { rows: [last] } = await pool.query<{ status: string | null; seconds: string | null }>(
        `SELECT status, EXTRACT(EPOCH FROM now() - started_at)::text AS seconds
           FROM address.etl_run ORDER BY started_at DESC LIMIT 1`,
      );
      lines.push('# HELP adres_etl_since_last_seconds Czas od rozpoczecia ostatniego cyklu ETL.');
      lines.push('# TYPE adres_etl_since_last_seconds gauge');
      lines.push(`adres_etl_since_last_seconds ${last?.seconds ? Number(last.seconds).toFixed(0) : -1}`);
      if (last?.status) {
        lines.push('# HELP adres_etl_last_status_info Status ostatniego cyklu ETL.');
        lines.push('# TYPE adres_etl_last_status_info gauge');
        lines.push(`adres_etl_last_status_info{status="${last.status}"} 1`);
      }
    } catch { /* brak tabeli etl_run nie moze wywalic metryk */ }

    return lines;
  }

  async function indexMetrics(): Promise<string[]> {
    const lines: string[] = [];
    // --- stan indeksu -------------------------------------------------
    lines.push('# HELP adres_index_loaded Czy artefakt indeksu jest w pamieci (1/0).');
    lines.push('# TYPE adres_index_loaded gauge');
    lines.push(`adres_index_loaded ${holder.ready ? 1 : 0}`);

    if (holder.ready) {
      const idx = holder.current;
      lines.push('# HELP adres_index_version_info Wersja danych zaladowanego artefaktu.');
      lines.push('# TYPE adres_index_version_info gauge');
      lines.push(`adres_index_version_info{version="${idx.dataVersion}"} 1`);
      lines.push('# HELP adres_index_documents Liczba pozycji w indeksie wyszukiwania.');
      lines.push('# TYPE adres_index_documents gauge');
      lines.push(`adres_index_documents{type="locality"} ${idx.header.counts.localities}`);
      lines.push(`adres_index_documents{type="street"} ${idx.header.counts.streets}`);
      lines.push('# HELP adres_index_keys Liczba kluczy wyszukiwania.');
      lines.push('# TYPE adres_index_keys gauge');
      lines.push(`adres_index_keys ${idx.header.counts.keys}`);

      // Rozjechanie sie wersji miedzy artefaktem a baza oznacza, ze indeks
      // jest starszy niz dane - podpowiedzi beda niespojne z walidacja.
      lines.push('# HELP adres_index_inconsistent Artefakt starszy niz opublikowany zrzut (1/0).');
      lines.push('# TYPE adres_index_inconsistent gauge');
      let inconsistent = 0;
      try {
        // Porownanie po CZASIE PUBLIKACJI, nie po napisie wersji.
        // Wersja to dowolny ciag ("2026-08-06", ale tez "t2" przy testach),
        // a porownanie leksykalne dawalo falszywe alarmy: "t2" > "2026-08-06".
        const { rows: [z] } = await pool.query<{ newer: boolean | null }>(
          `SELECT (max(fetched_at) > $1::timestamptz) AS newer
             FROM address.snapshot WHERE source='prg' AND status='opublikowany'`,
          [idx.header.builtAt.trim()],
        );
        if (z?.newer) inconsistent = 1;
      } catch { /* brak danych albo niepoprawna data budowy */ }
      lines.push(`adres_index_inconsistent ${inconsistent}`);
    }

    return lines;
  }

  function processMetrics(): string[] {
    const lines: string[] = [];
    // --- proces --------------------------------------------------------
    const mem = process.memoryUsage();
    lines.push('# HELP adres_process_rss_bytes Zuzycie pamieci procesu.');
    lines.push('# TYPE adres_process_rss_bytes gauge');
    lines.push(`adres_process_rss_bytes ${mem.rss}`);
    lines.push('# HELP adres_process_uptime_seconds Czas dzialania procesu.');
    lines.push('# TYPE adres_process_uptime_seconds gauge');
    lines.push(`adres_process_uptime_seconds ${Math.round(process.uptime())}`);

    return lines;
  }

  function keyRegistryMetrics(): string[] {
    const lines: string[] = [];
    /**
     * Stan repliki rejestru kluczy.
     *
     * adres_keys_age_seconds jest tu metryka numer jeden: przy awarii bazy
     * uwierzytelnianie dziala dalej z repliki (fail-open), wiec JEDYNYM
     * widocznym objawem jest rosnacy wiek. Bez niej awaria kanalu
     * odswiezania wyglada identycznie jak stan zdrowy.
     *
     * adres_keys_notifications_total pozwala odroznic "NOTIFY nie dziala,
     * ratuje odpytywanie" od "wszystko gra" - bez tego cicha awaria kanalu
     * jest niewidoczna.
     */
    if (registry) {
      lines.push('# HELP adres_keys_in_replica Liczba kluczy API w replice w pamieci.');
      lines.push('# TYPE adres_keys_in_replica gauge');
      lines.push(`adres_keys_in_replica ${registry.size}`);
      lines.push('# HELP adres_keys_age_seconds Czas od ostatniego udanego odswiezenia repliki.');
      lines.push('# TYPE adres_keys_age_seconds gauge');
      lines.push(`adres_keys_age_seconds ${Number.isFinite(registry.ageMs) ? Math.round(registry.ageMs / 1000) : -1}`);
      lines.push('# HELP adres_keys_notifications_total Powiadomienia NOTIFY o zmianie klucza.');
      lines.push('# TYPE adres_keys_notifications_total counter');
      lines.push(`adres_keys_notifications_total ${registry.notificationCount}`);
      // Instancja z niezaladowanym rejestrem odrzuca CALY ruch /v1 kodem 401.
      // Bez tej metryki jedynym sygnalem byloby /ready, czyli fakt wypadniecia
      // poda z rotacji - widoczny, ale nie mowiacy dlaczego.
      lines.push('# HELP adres_keys_loaded Czy replika rejestru kluczy jest zaladowana.');
      lines.push('# TYPE adres_keys_loaded gauge');
      lines.push(`adres_keys_loaded ${registry.loaded ? 1 : 0}`);
    }
    return lines;
  }

  app.get('/metrics', async (_req, reply) => {
    const state = await dataStateMetrics();
    const lines: string[] = [
      ...state.lines,
      ...await etlMetrics(),
      ...await indexMetrics(),
      ...processMetrics(),
      ...keyRegistryMetrics(),
    ];

    lines.push(...metrics.render());

    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return lines.join('\n') + '\n';
  });

  /**
   * Skrocony podglad stanu dla czlowieka - do szybkiej diagnozy bez
   * przechodzenia przez Prometheusa.
   */
  app.get('/status', async () => {
    const { rows: [d] } = await pool.query<{ age: string | null; points: string }>(`
      SELECT
        EXTRACT(DAY FROM now() - (
          SELECT max(fetched_at) FROM address.snapshot
           WHERE source='prg' AND status='opublikowany'))::text AS age,
        (SELECT count(*) FROM address.address_point WHERE withdrawn_at IS NULL)::text AS points
    `);
    const { rows: runs } = await pool.query(
      `SELECT id, started_at, finished_at, status, reason, artifact_version
         FROM address.etl_run ORDER BY started_at DESC LIMIT 5`,
    );
    const age = d.age ? Number(d.age) : null;

    return {
      index: holder.ready
        ? { version: holder.current.dataVersion, builtAt: holder.current.header.builtAt.trim(),
            counts: holder.current.header.counts }
        : { loaded: false },
      data: { points: Number(d.points), snapshotAgeDays: age },
      /**
       * Stan warstwy kluczy - to jest podglad dla CZLOWIEKA przy diagnozie,
       * osobny od metryk dla Prometheusa.
       *
       * Odcisk pieprza jest tu po to, zeby dalo sie odpowiedziec jednym curl
       * na pytanie z czwartego kroku rotacji pieprza: "czy wszystkie pody maja
       * juz nowa wersje". Odpowiedz 401 jest celowo nieodroznialna, wiec bez
       * tego pola sprawdzenie sprowadzaloby sie do zgadywania.
       *
       * Odcisk NIE ujawnia sekretu: to HMAC ze stalej etykiety, obciety do
       * osmiu znakow.
       */
      keys: registry
        ? {
            inReplica: registry.size,
            loaded: registry.loaded,
            ageSeconds: Number.isFinite(registry.ageMs) ? Math.round(registry.ageMs / 1000) : null,
            powiadomien: registry.notificationCount,
            peppers: peppers?.fingerprint() ?? null,
          }
        : null,
      warnings: [
        age !== null && age > 30
          ? `Najnowszy zrzut ma ${age} dni. PRG aktualizuje sie na biezaco - sprawdz pipeline i dostepnosc zrodla.`
          : null,
        runs[0]?.status === 'wstrzymany'
          ? `Ostatni cykl ETL zostal wstrzymany przez kontrole jakosci: ${runs[0].reason}. Wymaga decyzji.`
          : null,
        runs[0]?.status === 'blad'
          ? `Ostatni cykl ETL zakonczyl sie bledem: ${runs[0].reason}`
          : null,
      ].filter(Boolean),
      recentCycles: runs,
    };
  });
}
