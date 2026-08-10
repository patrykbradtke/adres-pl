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
import { type UsageMeter, requestUnits } from './usage.ts';

export type ApiKeyMode = 'disabled' | 'optional' | 'required';

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
const WITHOUT_KEY = new Set(['/health', '/ready', '/metrics', '/status']);


export interface AuthConfig {
  mode: ApiKeyMode;
  /** Limit zadan na minute z jednego adresu dla ruchu BEZ waznego klucza. */
  unauthenticatedLimit: number;
  /**
   * Sztuczne opoznienie sciezki uwierzytelniania, w mikrosekundach - WYLACZNIE
   * do walidacji przyrzadu pomiarowego z zadania 8.8b.
   *
   * Pomiar pokazujacy "brak regresji" jest bezwartosciowy, dopoki nie wiadomo,
   * czy przyrzad w ogole cokolwiek by wykryl. Seria kontrolna z wstrzyknietym
   * kosztem MUSI przekroczyc prog - dopiero wtedy wynik serii wlasciwej cokolwiek
   * znaczy. Zawsze zero w produkcji (patrz config.ts).
   *
   * Wartosc jest per INSTANCJA, a nie per proces: przyrzad stawia trzy serwery
   * w jednym procesie i kazdy musi miec wlasne ustawienie.
   */
  debugDelayUs?: number;
}

export interface AuthDeps {
  registry: KeyRegistry;
  peppers: Peppers;
  cfg: AuthConfig;
  /** Licznik zuzycia. Bez niego kwota nie jest egzekwowana ani ksiegowana. */
  usage?: UsageMeter;
  /** Licznik do metryk - wolany dla kazdego rozstrzygniecia. */
  onResult?: (result: string) => void;
}

/**
 * Powody odmowy. Wartosci trafiaja do metryk jako etykiety, wiec sa po polsku
 * (tak jak reszta wyjscia /metrics) i maja DOMKNIETY zbior - inaczej
 * kardynalnosc szeregow czasowych rosla by bez ograniczenia.
 */
type Result =
  | 'ok' | 'rate_limited' | 'quota'
  | (typeof UNAUTHENTICATED_RESULTS)[number]
  | DenialState;

/**
 * Powody odmowy 401. Wartosc idzie na drut wersalikami (`.toUpperCase()`
 * w `denials`), wiec jest czescia kontraktu - stad tablica, a nie sama unia.
 */
export const UNAUTHENTICATED_RESULTS = ['missing_key', 'invalid'] as const;

/**
 * Stany klucza, ktore koncza sie odmowa po trafieniu w wiersz rejestru.
 * Tak samo jak wyzej: wersaliki tych wartosci sa kodami 403 w odpowiedzi.
 */
export const DENIAL_STATES = ['not_yet_valid', 'expired', 'revoked', 'suspended'] as const;

type DenialState = (typeof DENIAL_STATES)[number];

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
const DENIALS: Record<DenialState, { code: 403; message: string }> = {
  not_yet_valid: { code: 403, message: 'Klucz API nie jest jeszcze wazny.' },
  expired: { code: 403, message: 'Klucz API wygasl.' },
  revoked: { code: 403, message: 'Klucz API zostal uniewazniony.' },
  suspended: { code: 403, message: 'Konto klienta jest zawieszone.' },
};

/**
 * Czysta ocena stanu klucza. Zwraca null, gdy klucz jest czynny.
 *
 * Kolejnosc ma znaczenie dla komunikatu, ktory zobaczy integrator:
 * uniewaznienie jest decyzja operatora i wazniejsza informacja niz to,
 * ze klucz przy okazji zdazyl wygasnac.
 */
function assessKeyState(entry: KeyEntry, teraz: number): DenialState | null {
  if (entry.revokedAt && entry.revokedAt.getTime() <= teraz) return 'revoked';
  if (entry.suspendedAt && entry.suspendedAt.getTime() <= teraz) return 'suspended';
  if (entry.validTo && entry.validTo.getTime() <= teraz) return 'expired';
  // Klucz wystawiony "od jutra" nie moze dzialac dzis. Kolumna wazny_od
  // istnieje od migracji 003 i nie byla dotad sprawdzana.
  if (entry.validFrom.getTime() > teraz) return 'not_yet_valid';
  return null;
}

/**
 * Wyszukanie wpisu po skrocie liczonym KAZDA znana wersja pieprza - warunek
 * rotacji pieprza bez przerwy w dzialaniu. Zero dotkniecia bazy, zawsze.
 */
function findEntry(
  peppers: Peppers, registry: KeyRegistry, plaintextKey: string,
): KeyEntry | undefined {
  for (const { hex } of peppers.hashAll(plaintextKey)) {
    const entry = registry.find(hex);
    if (entry) return entry;
  }
  return undefined;
}

/**
 * Dlawienie logu odrzucen.
 *
 * Po tej zmianie kontekst 404 tez przechodzi przez uwierzytelnianie, wiec
 * skanowanie sciezek generuje wpisy. Bez dlawienia jest to wektor DoS na dysk:
 * jeden wpis na sekunde na rodzaj wyniku wystarcza, zeby zobaczyc zjawisko,
 * i nie wystarcza, zeby zapelnic wolumen.
 */
class DlawionyLog {
  private lastRun = new Map<string, number>();
  private periodMs: number;

  // Jawne przypisanie zamiast parameter property - Node w trybie
  // --experimental-strip-types wycina wylacznie typy i nie generuje kodu,
  // wiec `constructor(private okresMs)` nie zadziala. Ta sama uwaga stoi
  // przy konstruktorze IndexHolder w search/loader.ts.
  constructor(periodMs = 1000) {
    this.periodMs = periodMs;
  }

  slow(key: string): boolean {
    const teraz = Date.now();
    if (teraz - (this.lastRun.get(key) ?? 0) < this.periodMs) return false;
    this.lastRun.set(key, teraz);
    return true;
  }
}

export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  const { registry, peppers, cfg } = deps;

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
   * najstarsze counters, czyli druga - niezalezna od zadania 8.1 - droga
   * obejscia limitu przez rozproszenie kluczy.
   */
  // Rzutowanie, bo `CreateRateLimitOptions` w @fastify/rate-limit NIE deklaruje
  // pola `cache` - jest dopiero na `RateLimitOptions`. W dzialaniu opcja JEST
  // czytana: createLimiterArgs przekazuje scalone parametry do
  // LocalStore.child(), a ten robi `new LocalStore(..., routeOptions.cache)`.
  // Czyli luka siedzi w deklaracjach biblioteki, nie w tym kodzie - dlatego
  // opcja zostaje, a nie znika pod typem.
  const limiterAdresu = app.createRateLimit({
    keyGenerator: (req: FastifyRequest) => `ip:${req.ip}`,
    max: cfg.unauthenticatedLimit,
    timeWindow: '1 minute',
    cache: 20_000,
  } as Parameters<typeof app.createRateLimit>[0]);

  const log = new DlawionyLog();

  const denials = async (
    req: FastifyRequest, reply: FastifyReply,
    code: 401 | 403, result: Result, message: string, prefix?: string,
  ) => {
    // Limitujemy KAZDE odrzucenie, zanim je odeslemy.
    const state = await limiterAdresu(req);
    // `isAllowed` rozroznia warianty wyniku: pola `isExceeded` i `ttl` istnieja
    // wylacznie w galezi odmownej. Bez tego zawezenia siegalismy po nie na unii.
    if (!state.isAllowed && state.isExceeded) {
      deps.onResult?.('rate_limited');
      return reply.code(429)
        .header('retry-after', Math.ceil(state.ttl / 1000))
        .send({ error: 'Za duzo prob uwierzytelnienia z tego adresu.', code: 'RATE_LIMITED' });
    }
    deps.onResult?.(result);
    if (log.slow(result)) {
      // W logu NIGDY klucz jawny, NIGDY skrot, NIGDY hex - wylacznie prefiks,
      // ktory sam w sobie nie wystarcza do uwierzytelnienia.
      req.log.warn({ result, prefix }, 'odrzucone uwierzytelnienie');
    }
    return reply.code(code).send({ error: message, code: result.toUpperCase() });
  };

  if (deps.usage) {
    /**
     * Ksiegowanie jednostek dopiero w onResponse - w onRequest cialo zadania
     * nie jest jeszcze sparsowane, a wsad rozlicza sie po liczbie pozycji.
     *
     * Odpowiedzi 5xx nie obciazaja klienta: nie placi za nasze bledy.
     */
    app.addHook('onResponse', async (req, reply) => {
      if (!req.client || reply.statusCode >= 500) return;
      deps.usage!.count(
        req.client.keyId, req.client.clientId,
        requestUnits(req.routeOptions?.url, req.body));
    });
  }

  app.addHook('onRequest', async (req, reply) => {
    const trasa = req.routeOptions?.url;

    // Sondy i metryki poza uwierzytelnianiem - patrz komentarz przy BEZ_KLUCZA.
    if (trasa !== undefined && WITHOUT_KEY.has(trasa)) return;

    // Trasy administracyjne maja WLASNY mechanizm (token operatora) i celowo
    // nie przechodza przez uwierzytelnianie klientow: klucz adr_live_* nie
    // moze otwierac zadnej z nich, bo bylaby to eskalacja uprawnien z klienta
    // na operatora.
    if (trasa !== undefined && trasa.startsWith('/admin/')) return;

    // Kontekst 404 ma routeOptions.url === undefined i CELOWO przechodzi przez
    // uwierzytelnianie: dzieki temu sondowanie nieistniejacych sciezek przestaje
    // byc darmowe. Nie "naprawiac" tego przepuszczaniem nieznanych tras.

    if (cfg.mode === 'disabled') return;

    const raw = req.headers['x-api-key'];
    // Klucz w query stringu jest traktowany jak jego BRAK: trafia do access
    // logu ingressu, do naglowka Referer i do historii przegladarki.
    if (typeof raw !== 'string' || raw.length === 0) {
      if (cfg.mode === 'optional') return;
      return denials(req, reply, 401, 'missing_key',
        'Wymagany naglowek x-api-key.');
    }

    const rozebrany = parseApiKey(raw);
    if (!rozebrany) {
      // Zly format, zla suma i klucz nieznany MUSZA byc nieodroznialne -
      // inaczej komunikat staje sie wyrocznia dla zgadujacego.
      return denials(req, reply, 401, 'invalid', 'Klucz API nieprawidlowy.');
    }

    const entry = findEntry(peppers, registry, raw);
    if (!entry) {
      return denials(req, reply, 401, 'invalid', 'Klucz API nieprawidlowy.');
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
    if (rozebrany.environment !== entry.environment) {
      return denials(req, reply, 401, 'invalid', 'Klucz API nieprawidlowy.');
    }

    const state = assessKeyState(entry, Date.now());
    if (state) {
      const { code, message } = DENIALS[state];
      return denials(req, reply, code, state, message, entry.prefix);
    }

    /**
     * Kwota miesieczna liczona jako STAN Z BAZY + JEDNOSTKI JESZCZE NIEZRZUCONE.
     *
     * Sam odczyt z repliki nie wystarcza: zapis jest zbiorczy, wiec przez cale
     * okno zrzutu klient widzialby zuzycie sprzed minuty. Przy wsadzie po 1000
     * pozycji daloby to przekroczenie kwoty o kilka rzedow wielkosci, zanim
     * ktokolwiek by to zobaczyl.
     *
     * Nadmiar jest ograniczony JEDNYM zadaniem - najwyzej ostatni wsad przekroczy
     * kwote o swoja wielkosc. Kwota jest podstawa faktury, a nie zaworem
     * bezpieczenstwa; twarda ochrone daje limit minutowy.
     */
    if (entry.monthlyQuota !== null && deps.usage) {
      const remote = registry.usedUnits(entry.clientId);
      const lokalne = deps.usage.clientUnits(entry.clientId);
      if (remote + lokalne >= entry.monthlyQuota) {
        deps.onResult?.('quota');
        return reply.code(429).send({
          error: 'Miesieczna kwota zapytan wyczerpana.',
          code: 'QUOTA_EXHAUSTED',
        });
      }
    }

    // Celowe opoznienie do WALIDACJI PRZYRZADU pomiarowego (zadanie 8.8b).
    // Bez serii kontrolnej z wstrzyknietym kosztem zielony wynik pomiaru
    // znaczy tylko tyle, ze przyrzad niczego nie zmierzyl. Niedostepne
    // w produkcji - to jedyny warunek, ktory tu wystarcza, bo koszt jest
    // sterowany zmienna srodowiskowa, a nie danymi z zadania.
    if (cfg.debugDelayUs) {
      const do_ = process.hrtime.bigint() + BigInt(cfg.debugDelayUs * 1000);
      while (process.hrtime.bigint() < do_) { /* zajete oczekiwanie */ }
    }

    deps.onResult?.('ok');
    req.client = entry;
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Zweryfikowany klient. Ustawia WYLACZNIE hook z tego pliku. */
    client: KeyEntry | null;
  }
}
