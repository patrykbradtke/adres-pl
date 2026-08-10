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

/**
 * Powody odmowy. Wartosci trafiaja do metryk jako etykiety, wiec sa po polsku
 * (tak jak reszta wyjscia /metrics) i maja DOMKNIETY zbior - inaczej
 * kardynalnosc szeregow czasowych rosla by bez ograniczenia.
 */
type Wynik =
  | 'ok' | 'brak_klucza' | 'nieprawidlowy' | 'niewazny_jeszcze' | 'wygasly'
  | 'uniewazniony' | 'zawieszony' | 'limit_prob';

/** Stany klucza, ktore konczy sie odmowa po trafieniu w wiersz rejestru. */
type StanOdmowy = 'niewazny_jeszcze' | 'wygasly' | 'uniewazniony' | 'zawieszony';

/**
 * Kod i komunikat w JEDNYM miejscu, zamiast rozproszonych po wywolaniach.
 *
 * Chroniona wlasnoscia jest to, ze WSZYSTKIE odpowiedzi 401 maja identyczne
 * cialo - rozne komunikaty zamienialyby odpowiedz w wyrocznie dla zgadujacego.
 * Przy piaciu wywolaniach z literalami w miejscu wywolania sprawdzenie tego
 * wymagalo porownywania ciagow rozsypanych po pliku.
 *
 * Kody 403 sa juz KONKRETNE, bo padaja po udowodnieniu posiadania calego
 * sekretu. To nie jest wyciek - znajomosc klucza to juz posiadanie - a
 * integrator dowiaduje sie, co zrobic, zamiast zgadywac.
 */
const ODMOWY: Record<StanOdmowy, { kod: 403; komunikat: string }> = {
  niewazny_jeszcze: { kod: 403, komunikat: 'Klucz API nie jest jeszcze wazny.' },
  wygasly: { kod: 403, komunikat: 'Klucz API wygasl.' },
  uniewazniony: { kod: 403, komunikat: 'Klucz API zostal uniewazniony.' },
  zawieszony: { kod: 403, komunikat: 'Konto klienta jest zawieszone.' },
};

/**
 * Czysta ocena stanu klucza. Zwraca null, gdy klucz jest czynny.
 *
 * Kolejnosc ma znaczenie dla komunikatu, ktory zobaczy integrator:
 * uniewaznienie jest decyzja operatora i wazniejsza informacja niz to,
 * ze klucz przy okazji zdazyl wygasnac.
 */
function ocenStan(wpis: KeyEntry, teraz: number): StanOdmowy | null {
  if (wpis.uniewaznionyOd && wpis.uniewaznionyOd.getTime() <= teraz) return 'uniewazniony';
  if (wpis.zawieszonyOd && wpis.zawieszonyOd.getTime() <= teraz) return 'zawieszony';
  if (wpis.waznyDo && wpis.waznyDo.getTime() <= teraz) return 'wygasly';
  // Klucz wystawiony "od jutra" nie moze dzialac dzis. Kolumna wazny_od
  // istnieje od migracji 003 i nie byla dotad sprawdzana.
  if (wpis.waznyOd.getTime() > teraz) return 'niewazny_jeszcze';
  return null;
}

/**
 * Wyszukanie wpisu po skrocie liczonym KAZDA znana wersja pieprza - warunek
 * rotacji pieprza bez przerwy w dzialaniu. Zero dotkniecia bazy, zawsze.
 */
function znajdzWpis(
  pieprze: Peppers, rejestr: KeyRegistry, kluczJawny: string,
): KeyEntry | undefined {
  for (const { hex } of pieprze.hashAll(kluczJawny)) {
    const wpis = rejestr.znajdz(hex);
    if (wpis) return wpis;
  }
  return undefined;
}

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

    const wpis = znajdzWpis(pieprze, rejestr, surowy);
    if (!wpis) {
      return odmow(req, reply, 401, 'nieprawidlowy', 'Klucz API nieprawidlowy.');
    }

    /**
     * Srodowisko z klucza JAWNEGO musi zgadzac sie z zapisanym w rejestrze.
     *
     * Bez tej kontroli prefiks adr_test_ i adr_live_ jest wylacznie ozdoba:
     * skrot liczymy z calego ciagu, wiec klucz testowy uwierzytelnialby sie
     * na instalacji produkcyjnej dokladnie tak samo jak produkcyjny, a caly
     * podzial na srodowiska bylby pozorny.
     *
     * Odpowiedz jest NIEODROZNIALNA od "klucz nieznany" - to jest wciaz etap
     * przed potwierdzeniem, ze klucz nalezy do tej instalacji.
     */
    if (rozebrany.environment !== wpis.srodowisko) {
      return odmow(req, reply, 401, 'nieprawidlowy', 'Klucz API nieprawidlowy.');
    }

    const stan = ocenStan(wpis, Date.now());
    if (stan) {
      const { kod, komunikat } = ODMOWY[stan];
      return odmow(req, reply, kod, stan, komunikat, wpis.prefiks);
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
