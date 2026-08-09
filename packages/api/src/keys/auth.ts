/**
 * Uwierzytelnianie klientow API - hook onRequest POZIOMU INSTANCJI.
 *
 * DLACZEGO WLASNIE TAM, A NIE W preHandler
 *
 * @fastify/rate-limit NIE zaklada hooka na instancji: jedyne addHook w calym
 * jego index.js to onRoute (linia 142), a wlasciwy limiter jest wpychany do
 * routeOptions[hook] osobno dla KAZDEJ trasy (linie 201-211), domyslnie
 * w fazie onRequest (linie 11 i 87).
 *
 * Fastify sklada tablice hookow trasy na preReady jako
 *     this[kHooks][hook].concat(opts[hook] || [])
 * (lib/route.js:391), czyli hooki INSTANCJI zawsze wyprzedzaja hooki TRASY
 * w tej samej fazie. Weryfikacja klucza konczy sie wiec ZANIM keyGenerator
 * limitera cokolwiek policzy - i to wynika z konstrukcji Fastify, a nie
 * z ostroznego ustawienia kolejnosci wywolan w buildServer.
 *
 * Plan produkcyjny mowi w zadaniu 8.4 "jako preHandler" i to jest BLEDNE.
 * preHandler biegnie cztery fazy po onRequest, wiec keyGenerator wykonalby sie
 * przed weryfikacja i jedyne, co mialby pod reka, to surowa wartosc naglowka -
 * czyli doslownie luka z zadania 8.1: losowanie naglowka = swiezy licznik.
 *
 * Odrzucona jest tez odwrotna latka, czyli przestawienie limitera na
 * hook: 'preHandler'. Limiter przestalby wtedy odrzucac PRZED parsowaniem
 * ciala, a POST /v1/batch przyjmuje do 1000 pozycji - klient ponad limitem
 * najpierw obciazylby proces parsowaniem i walidacja JSON.
 *
 * DLACZEGO ZWYKLA FUNKCJA, A NIE app.register
 *
 * app.register bez fastify-plugin tworzy instancje POTOMNA z KOPIA tablic
 * hookow. addHook wewnatrz objalby wylacznie trasy zarejestrowane w tym
 * potomku - czyli zadnej z tras serwisu. Awaria bylaby CICHA: serwis wstaje,
 * testy przechodza, uwierzytelnianie nie dziala. fastify-plugin lezy
 * w node_modules tylko jako zaleznosc przechodnia cors i rate-limit, wiec
 * import bylby poleganiem na hoistingu cudzej zaleznosci.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { parseApiKey } from '@adres-pl/core';
import type { Peppers } from './pepper.ts';
import type { KeyRegistry, KeyEntry } from './registry.ts';

export type ApiKeyMode = 'wylaczony' | 'opcjonalny' | 'wymagany';

/**
 * Trasy poza uwierzytelnianiem, rozpoznawane po `req.routeOptions.url`,
 * a NIE po `req.url`.
 *
 * Roznica jest istotna: trasy z parametrem maja rozne req.url przy tym samym
 * routeOptions.url (`/v1/locality/0918123` wobec `/v1/locality/:simc`).
 *
 * Ta czworka MUSI zostac otwarta. Prometheus zbiera /metrics co 15 s, a kubelet
 * odpytuje /health i /ready - gdyby dostawaly 401, monitoring oslepnie
 * (up{job="adres-api"} spada do 0 i zapala sie krytyczny BrakMetrykZSerwisu),
 * a pody beda ubijane przez nieudane sondy przy w pelni sprawnej usludze.
 */
const BEZ_KLUCZA = new Set(['/health', '/ready', '/metrics', '/status']);

export interface AuthConfig {
  mode: ApiKeyMode;
  /** Limit zadan na minute z jednego adresu dla ruchu BEZ waznego klucza. */
  limitNieuwierzytelniony: number;
}

export interface AuthDeps {
  rejestr: KeyRegistry;
  pieprze: Peppers;
  cfg: AuthConfig;
  /** Licznik do metryk - wolany dla kazdego rozstrzygniecia. */
  onWynik?: (wynik: string) => void;
}

/** Powody odmowy. Wartosci trafiaja do metryk, wiec maja stala kardynalnosc. */
type Wynik =
  | 'ok' | 'brak_klucza' | 'nieprawidlowy' | 'wygasly'
  | 'uniewazniony' | 'zawieszony' | 'limit_prob';

/**
 * Dlawienie logu odrzucen.
 *
 * Po tej zmianie kontekst 404 tez przechodzi przez uwierzytelnianie, wiec
 * skanowanie sciezek generuje wpisy. Bez dlawienia jest to wektor DoS na dysk:
 * jeden wpis na sekundę na rodzaj wyniku wystarcza, zeby zobaczyc zjawisko,
 * i nie wystarcza, zeby zapelnic wolumen.
 */
class DlawionyLog {
  private ostatni = new Map<string, number>();
  private okresMs: number;

  // Jawne przypisanie zamiast parameter property - Node w trybie
  // --experimental-strip-types wycina wylacznie typy i nie generuje kodu,
  // wiec `constructor(private okresMs)` nie zadziala. Ta sama uwaga stoi
  // przy konstruktorze IndexHolder w search/loader.ts.
  constructor(okresMs = 1000) {
    this.okresMs = okresMs;
  }

  wolno(klucz: string): boolean {
    const teraz = Date.now();
    if (teraz - (this.ostatni.get(klucz) ?? 0) < this.okresMs) return false;
    this.ostatni.set(klucz, teraz);
    return true;
  }
}

export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  const { rejestr, pieprze, cfg } = deps;

  // null, nie {}: Fastify 5 rzuca FST_ERR_DEC_REFERENCE_TYPE dla wartosci
  // referencyjnych juz przy budowie serwera (lib/decorate.js:69).
  app.decorateRequest('klient', null);

  /**
   * Limiter DRUGIEGO POZIOMU, po adresie, dla ruchu bez waznego klucza.
   *
   * Bez niego zgadywanie kluczy byloby CALKOWICIE nielimitowane: zadanie
   * odrzucone w onRequest konczy sie zanim limiter trasy w ogole sie wykona.
   *
   * createRateLimit zwraca wynik i SAM NICZEGO NIE ODSYLA (index.js:129),
   * wiec decyzje podejmujemy tutaj. Nie ustawia tez znacznika rateLimitRan,
   * wiec limiter trasy dziala potem niezaleznie.
   *
   * `cache` przekazany JAWNIE: domyslne 5000 wpisow to LRU wypychajace
   * najstarsze liczniki, czyli druga - niezalezna od zadania 8.1 - droga
   * obejscia limitu przez rozproszenie kluczy.
   */
  const limiterAdresu = app.createRateLimit({
    keyGenerator: (req: FastifyRequest) => `ip:${req.ip}`,
    max: cfg.limitNieuwierzytelniony,
    timeWindow: '1 minute',
    cache: 20_000,
  });

  const log = new DlawionyLog();

  const odmow = async (
    req: FastifyRequest, reply: FastifyReply,
    kod: 401 | 403, wynik: Wynik, komunikat: string, prefiks?: string,
  ) => {
    // Limitujemy KAZDE odrzucenie, zanim je odeslemy.
    const stan = await limiterAdresu(req);
    if (stan.isExceeded) {
      deps.onWynik?.('limit_prob');
      return reply.code(429)
        .header('retry-after', Math.ceil(stan.ttl / 1000))
        .send({ error: 'Za duzo prob uwierzytelnienia z tego adresu.', code: 'LIMIT_PROB' });
    }
    deps.onWynik?.(wynik);
    if (log.wolno(wynik)) {
      // W logu NIGDY klucz jawny, NIGDY skrot, NIGDY hex - wylacznie prefiks,
      // ktory sam w sobie nie wystarcza do uwierzytelnienia.
      req.log.warn({ wynik, prefiks }, 'odrzucone uwierzytelnienie');
    }
    return reply.code(kod).send({ error: komunikat, code: wynik.toUpperCase() });
  };

  app.addHook('onRequest', async (req, reply) => {
    const trasa = req.routeOptions?.url;

    // Sondy i metryki poza uwierzytelnianiem - patrz komentarz przy BEZ_KLUCZA.
    if (trasa !== undefined && BEZ_KLUCZA.has(trasa)) return;

    // Kontekst 404 ma routeOptions.url === undefined i CELOWO przechodzi przez
    // uwierzytelnianie: dzieki temu sondowanie nieistniejacych sciezek przestaje
    // byc darmowe. Nie "naprawiac" tego przepuszczaniem nieznanych tras.

    if (cfg.mode === 'wylaczony') return;

    const surowy = req.headers['x-api-key'];
    // Klucz w query stringu jest traktowany jak jego BRAK: trafia do access
    // logu ingressu, do naglowka Referer i do historii przegladarki.
    if (typeof surowy !== 'string' || surowy.length === 0) {
      if (cfg.mode === 'opcjonalny') return;
      return odmow(req, reply, 401, 'brak_klucza',
        'Wymagany naglowek x-api-key.');
    }

    const rozebrany = parseApiKey(surowy);
    if (!rozebrany) {
      // Zly format, zla suma i klucz nieznany MUSZA byc nieodroznialne -
      // inaczej komunikat staje sie wyrocznia dla zgadujacego.
      return odmow(req, reply, 401, 'nieprawidlowy', 'Klucz API nieprawidlowy.');
    }

    // Skrot liczony KAZDA znana wersja pieprza - warunek rotacji bez przerwy.
    // Zero dotkniecia bazy, zawsze.
    let wpis: KeyEntry | undefined;
    for (const { hex } of pieprze.hashAll(surowy)) {
      wpis = rejestr.znajdz(hex);
      if (wpis) break;
    }
    if (!wpis) {
      return odmow(req, reply, 401, 'nieprawidlowy', 'Klucz API nieprawidlowy.');
    }

    // Ponizsze kody sa KONKRETNE, bo padaja dopiero po trafieniu w wiersz
    // rejestru, czyli po udowodnieniu posiadania calego sekretu. To nie jest
    // wyciek - znajomosc klucza to juz posiadanie - a integrator dowiaduje sie,
    // co ma zrobic zamiast zgadywac.
    const teraz = Date.now();
    if (wpis.uniewaznionyOd && wpis.uniewaznionyOd.getTime() <= teraz) {
      return odmow(req, reply, 403, 'uniewazniony', 'Klucz API zostal uniewazniony.', wpis.prefiks);
    }
    if (wpis.waznyDo && wpis.waznyDo.getTime() <= teraz) {
      return odmow(req, reply, 403, 'wygasly', 'Klucz API wygasl.', wpis.prefiks);
    }
    if (wpis.zawieszonyOd && wpis.zawieszonyOd.getTime() <= teraz) {
      return odmow(req, reply, 403, 'zawieszony', 'Konto klienta jest zawieszone.', wpis.prefiks);
    }

    deps.onWynik?.('ok');
    req.klient = wpis;
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Zweryfikowany klient. Ustawia WYLACZNIE hook z tego pliku. */
    klient: KeyEntry | null;
  }
}
