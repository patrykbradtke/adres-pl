/**
 * Metryki operacyjne w formacie tekstowym Prometheusa.
 *
 * CO WARTO MONITOROWAC I DLACZEGO
 *
 *  adres_dane_wiek_dni
 *    Najwazniejsza metryka calego systemu. PRG aktualizuje sie na biezaco,
 *    wiec rosnacy wiek danych oznacza, ze albo pipeline stanal, albo zrodlo
 *    przestalo publikowac. Dokladnie tak wygladal incydent z czerwca 2024,
 *    gdy paczki nie byly odswiezane przez dwa tygodnie i zauwazyla to firma
 *    zewnetrzna, a nie instytucja prowadzaca rejestr.
 *    Alarm: > 30 dni.
 *
 *  adres_etl_wstrzymane_total
 *    Liczba cykli zatrzymanych przez kontrole jakosci. Wartosc niezerowa
 *    NIE jest awaria - to zadzialalo zabezpieczenie. Ale wymaga decyzji
 *    czlowieka, wiec musi byc widoczna.
 *
 *  adres_indeks_wersja_info
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
  private uwierzytelnienia = new Map<string, number>();

  uwierzytelnienie(wynik: string): void {
    this.uwierzytelnienia.set(wynik, (this.uwierzytelnienia.get(wynik) ?? 0) + 1);
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
    out.push('# HELP adres_zapytania_total Liczba obsluzonych zapytan.');
    out.push('# TYPE adres_zapytania_total counter');
    for (const [ep, n] of this.counts) out.push(`adres_zapytania_total{endpoint="${ep}"} ${n}`);

    out.push('# HELP adres_zapytanie_ms Czas obslugi zapytania w milisekundach.');
    out.push('# TYPE adres_zapytanie_ms histogram');
    for (const [ep, h] of this.hist) {
      let cum = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cum += h[i];
        out.push(`adres_zapytanie_ms_bucket{endpoint="${ep}",le="${this.buckets[i]}"} ${cum}`);
      }
      cum += h[this.buckets.length];
      out.push(`adres_zapytanie_ms_bucket{endpoint="${ep}",le="+Inf"} ${cum}`);
      out.push(`adres_zapytanie_ms_sum{endpoint="${ep}"} ${(this.sumMs.get(ep) ?? 0).toFixed(3)}`);
      out.push(`adres_zapytanie_ms_count{endpoint="${ep}"} ${cum}`);
    }

    if (this.uwierzytelnienia.size > 0) {
      out.push('# HELP adres_uwierzytelnienie_total Rozstrzygniecia uwierzytelnienia klucza API.');
      out.push('# TYPE adres_uwierzytelnienie_total counter');
      for (const [wynik, n] of this.uwierzytelnienia) {
        out.push(`adres_uwierzytelnienie_total{wynik="${wynik}"} ${n}`);
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
  rejestr?: {
    rozmiar: number; wiekMs: number; zaladowana: boolean; liczbaPowiadomien: number;
  },
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
  const STAN_DANYCH_TTL_MS = Number(process.env.METRICS_CACHE_MS ?? 60_000);
  let stanDanych = { wiekDni: -1, punkty: 0, miejscowosci: 0, ulice: 0 };
  let staneDanychTs = 0;

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
  async function metrykiStanuDanych(): Promise<{ linie: string[]; bazaOk: number }> {
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
    let bazaOk = 1;
    try {
      await pool.query('SELECT 1');
    } catch {
      bazaOk = 0;
    }

    if (bazaOk === 1 && Date.now() - staneDanychTs > STAN_DANYCH_TTL_MS) {
      try {
        const { rows: [d] } = await pool.query<{
          wiek: string | null; punkty: string; miejscowosci: string; ulice: string;
        }>(`
          SELECT
            EXTRACT(EPOCH FROM now() - (
              SELECT max(pobrano) FROM adres.zrzut
               WHERE zrodlo='prg' AND status='opublikowany'))::text AS wiek,
            (SELECT count(*) FROM adres.punkt_adresowy WHERE wycofany_od IS NULL)::text AS punkty,
            (SELECT count(*) FROM adres.miejscowosc  WHERE wycofany_od IS NULL)::text AS miejscowosci,
            (SELECT count(*) FROM adres.ulica        WHERE wycofany_od IS NULL)::text AS ulice
        `);
        stanDanych = {
          wiekDni: d.wiek ? Number(d.wiek) / 86400 : -1,
          punkty: Number(d.punkty),
          miejscowosci: Number(d.miejscowosci),
          ulice: Number(d.ulice),
        };
        staneDanychTs = Date.now();
      } catch {
        bazaOk = 0;   // sonda przeszla, ale odczyt nie - i tak zglaszamy problem
      }
    }
    const { wiekDni, punkty, miejscowosci, ulice } = stanDanych;

    lines.push('# HELP adres_baza_dostepna Czy baza danych odpowiada (1/0).');
    lines.push('# TYPE adres_baza_dostepna gauge');
    lines.push(`adres_baza_dostepna ${bazaOk}`);

    lines.push('# HELP adres_dane_wiek_dni Wiek najnowszego opublikowanego zrzutu w dniach. -1 = brak zrzutu.');
    lines.push('# TYPE adres_dane_wiek_dni gauge');
    lines.push(`adres_dane_wiek_dni ${wiekDni.toFixed(3)}`);

    lines.push('# HELP adres_punkty_total Liczba aktywnych punktow adresowych.');
    lines.push('# TYPE adres_punkty_total gauge');
    lines.push(`adres_punkty_total ${punkty}`);
    lines.push('# HELP adres_miejscowosci_total Liczba aktywnych miejscowosci.');
    lines.push('# TYPE adres_miejscowosci_total gauge');
    lines.push(`adres_miejscowosci_total ${miejscowosci}`);
    lines.push('# HELP adres_ulice_total Liczba aktywnych ulic.');
    lines.push('# TYPE adres_ulice_total gauge');
    lines.push(`adres_ulice_total ${ulice}`);

    return { linie: lines, bazaOk };
  }

  async function metrykiEtl(): Promise<string[]> {
    const lines: string[] = [];
    // --- stan ETL ----------------------------------------------------
    try {
      const { rows } = await pool.query<{ status: string; n: string }>(
        `SELECT status, count(*)::text n FROM adres.etl_run
          WHERE rozpoczety > now() - interval '30 days' GROUP BY status`,
      );
      lines.push('# HELP adres_etl_przebiegi_total Cykle ETL z ostatnich 30 dni wg statusu.');
      lines.push('# TYPE adres_etl_przebiegi_total gauge');
      for (const r of rows) lines.push(`adres_etl_przebiegi_total{status="${r.status}"} ${r.n}`);

      const { rows: [ost] } = await pool.query<{ status: string | null; sekund: string | null }>(
        `SELECT status, EXTRACT(EPOCH FROM now() - rozpoczety)::text AS sekund
           FROM adres.etl_run ORDER BY rozpoczety DESC LIMIT 1`,
      );
      lines.push('# HELP adres_etl_od_ostatniego_s Czas od rozpoczecia ostatniego cyklu ETL.');
      lines.push('# TYPE adres_etl_od_ostatniego_s gauge');
      lines.push(`adres_etl_od_ostatniego_s ${ost?.sekund ? Number(ost.sekund).toFixed(0) : -1}`);
      if (ost?.status) {
        lines.push('# HELP adres_etl_ostatni_status_info Status ostatniego cyklu ETL.');
        lines.push('# TYPE adres_etl_ostatni_status_info gauge');
        lines.push(`adres_etl_ostatni_status_info{status="${ost.status}"} 1`);
      }
    } catch { /* brak tabeli etl_run nie moze wywalic metryk */ }

    return lines;
  }

  async function metrykiIndeksu(): Promise<string[]> {
    const lines: string[] = [];
    // --- stan indeksu -------------------------------------------------
    lines.push('# HELP adres_indeks_zaladowany Czy artefakt indeksu jest w pamieci (1/0).');
    lines.push('# TYPE adres_indeks_zaladowany gauge');
    lines.push(`adres_indeks_zaladowany ${holder.ready ? 1 : 0}`);

    if (holder.ready) {
      const idx = holder.current;
      lines.push('# HELP adres_indeks_wersja_info Wersja danych zaladowanego artefaktu.');
      lines.push('# TYPE adres_indeks_wersja_info gauge');
      lines.push(`adres_indeks_wersja_info{wersja="${idx.dataVersion}"} 1`);
      lines.push('# HELP adres_indeks_dokumenty Liczba pozycji w indeksie wyszukiwania.');
      lines.push('# TYPE adres_indeks_dokumenty gauge');
      lines.push(`adres_indeks_dokumenty{typ="miejscowosc"} ${idx.header.counts.localities}`);
      lines.push(`adres_indeks_dokumenty{typ="ulica"} ${idx.header.counts.streets}`);
      lines.push('# HELP adres_indeks_klucze Liczba kluczy wyszukiwania.');
      lines.push('# TYPE adres_indeks_klucze gauge');
      lines.push(`adres_indeks_klucze ${idx.header.counts.keys}`);

      // Rozjechanie sie wersji miedzy artefaktem a baza oznacza, ze indeks
      // jest starszy niz dane - podpowiedzi beda niespojne z walidacja.
      lines.push('# HELP adres_indeks_niespojny Artefakt starszy niz opublikowany zrzut (1/0).');
      lines.push('# TYPE adres_indeks_niespojny gauge');
      let niespojny = 0;
      try {
        // Porownanie po CZASIE PUBLIKACJI, nie po napisie wersji.
        // Wersja to dowolny ciag ("2026-08-06", ale tez "t2" przy testach),
        // a porownanie leksykalne dawalo falszywe alarmy: "t2" > "2026-08-06".
        const { rows: [z] } = await pool.query<{ starsze: boolean | null }>(
          `SELECT (max(pobrano) > $1::timestamptz) AS starsze
             FROM adres.zrzut WHERE zrodlo='prg' AND status='opublikowany'`,
          [idx.header.builtAt.trim()],
        );
        if (z?.starsze) niespojny = 1;
      } catch { /* brak danych albo niepoprawna data budowy */ }
      lines.push(`adres_indeks_niespojny ${niespojny}`);
    }

    return lines;
  }

  function metrykiProcesu(): string[] {
    const lines: string[] = [];
    // --- proces --------------------------------------------------------
    const mem = process.memoryUsage();
    lines.push('# HELP adres_proces_rss_bajty Zuzycie pamieci procesu.');
    lines.push('# TYPE adres_proces_rss_bajty gauge');
    lines.push(`adres_proces_rss_bajty ${mem.rss}`);
    lines.push('# HELP adres_proces_uptime_s Czas dzialania procesu.');
    lines.push('# TYPE adres_proces_uptime_s gauge');
    lines.push(`adres_proces_uptime_s ${Math.round(process.uptime())}`);

    return lines;
  }

  function metrykiRejestruKluczy(): string[] {
    const lines: string[] = [];
    /**
     * Stan repliki rejestru kluczy.
     *
     * adres_klucze_wiek_s jest tu metryka numer jeden: przy awarii bazy
     * uwierzytelnianie dziala dalej z repliki (fail-open), wiec JEDYNYM
     * widocznym objawem jest rosnacy wiek. Bez niej awaria kanalu
     * odswiezania wyglada identycznie jak stan zdrowy.
     *
     * adres_klucze_powiadomienia_total pozwala odroznic "NOTIFY nie dziala,
     * ratuje odpytywanie" od "wszystko gra" - bez tego cicha awaria kanalu
     * jest niewidoczna.
     */
    if (rejestr) {
      lines.push('# HELP adres_klucze_w_replice Liczba kluczy API w replice w pamieci.');
      lines.push('# TYPE adres_klucze_w_replice gauge');
      lines.push(`adres_klucze_w_replice ${rejestr.rozmiar}`);
      lines.push('# HELP adres_klucze_wiek_s Czas od ostatniego udanego odswiezenia repliki.');
      lines.push('# TYPE adres_klucze_wiek_s gauge');
      lines.push(`adres_klucze_wiek_s ${Number.isFinite(rejestr.wiekMs) ? Math.round(rejestr.wiekMs / 1000) : -1}`);
      lines.push('# HELP adres_klucze_powiadomienia_total Powiadomienia NOTIFY o zmianie klucza.');
      lines.push('# TYPE adres_klucze_powiadomienia_total counter');
      lines.push(`adres_klucze_powiadomienia_total ${rejestr.liczbaPowiadomien}`);
      // Instancja z niezaladowanym rejestrem odrzuca CALY ruch /v1 kodem 401.
      // Bez tej metryki jedynym sygnalem byloby /ready, czyli fakt wypadniecia
      // poda z rotacji - widoczny, ale nie mowiacy dlaczego.
      lines.push('# HELP adres_klucze_zaladowany Czy replika rejestru kluczy jest zaladowana.');
      lines.push('# TYPE adres_klucze_zaladowany gauge');
      lines.push(`adres_klucze_zaladowany ${rejestr.zaladowana ? 1 : 0}`);
    }
    return lines;
  }

  app.get('/metrics', async (_req, reply) => {
    const stan = await metrykiStanuDanych();
    const lines: string[] = [
      ...stan.linie,
      ...await metrykiEtl(),
      ...await metrykiIndeksu(),
      ...metrykiProcesu(),
      ...metrykiRejestruKluczy(),
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
    const { rows: [d] } = await pool.query<{ wiek: string | null; punkty: string }>(`
      SELECT
        EXTRACT(DAY FROM now() - (
          SELECT max(pobrano) FROM adres.zrzut
           WHERE zrodlo='prg' AND status='opublikowany'))::text AS wiek,
        (SELECT count(*) FROM adres.punkt_adresowy WHERE wycofany_od IS NULL)::text AS punkty
    `);
    const { rows: przebiegi } = await pool.query(
      `SELECT id, rozpoczety, zakonczony, status, powod, artefakt_wersja
         FROM adres.etl_run ORDER BY rozpoczety DESC LIMIT 5`,
    );
    const wiek = d.wiek ? Number(d.wiek) : null;

    return {
      indeks: holder.ready
        ? { wersja: holder.current.dataVersion, zbudowano: holder.current.header.builtAt.trim(),
            liczby: holder.current.header.counts }
        : { zaladowany: false },
      dane: { punktow: Number(d.punkty), wiekZrzutuDni: wiek },
      ostrzezenia: [
        wiek !== null && wiek > 30
          ? `Najnowszy zrzut ma ${wiek} dni. PRG aktualizuje sie na biezaco - sprawdz pipeline i dostepnosc zrodla.`
          : null,
        przebiegi[0]?.status === 'wstrzymany'
          ? `Ostatni cykl ETL zostal wstrzymany przez kontrole jakosci: ${przebiegi[0].powod}. Wymaga decyzji.`
          : null,
        przebiegi[0]?.status === 'blad'
          ? `Ostatni cykl ETL zakonczyl sie bledem: ${przebiegi[0].powod}`
          : null,
      ].filter(Boolean),
      ostatnieCykle: przebiegi,
    };
  });
}
