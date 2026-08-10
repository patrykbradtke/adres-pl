/**
 * Konfiguracja serwisu - odczyt i rozbior zmiennych srodowiskowych.
 *
 * Wydzielone z server.ts, bo to inna odpowiedzialnosc niz zlozenie instancji
 * Fastify: tutaj mieszka wiedza o TYM, CO da sie ustawic i co znaczy kazda
 * wartosc, a tam - jak z tego zbudowac dzialajacy serwis.
 *
 * ZASADA: ten modul NIE RZUCA i nie ma skutkow ubocznych. Nawet konfiguracja
 * niespojna (np. tryb wymagajacy klucza bez ani jednego pieprza) daje poprawny
 * obiekt - kontrola spojnosci siedzi w buildServer. Dzieki temu da sie zbadac
 * sama konfiguracje, nie stawiajac serwera, i testy moga sprawdzac odczyt
 * w oderwaniu od reszty.
 *
 * UWAGA: nic w projekcie nie wczytuje pliku .env. Zmienne podaje sie z powloki,
 * przez sekcje environment w compose albo przez sekret Kubernetesa.
 */
import { type ApiKeyMode } from './keys/auth.ts';
import { pepperEntriesFromEnv } from './keys/pepper.ts';

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
  rateLimitUnauthenticated: number;
  keysRefreshMs: number;
  /**
   * Po ilu sekundach bez UDANEGO odswiezenia repliki instancja przestaje
   * meldowac gotowosc. Uwierzytelnianie dziala dalej (fail-open) - to jest
   * decyzja o KIEROWANIU RUCHU, nie o wpuszczaniu klientow.
   */
  keysMaxAgeSeconds: number;
  /** Co ile zrzucac agregat zuzycia do bazy. */
  usageFlushMs: number;
  /**
   * Token operatora. Pusty = trasy /admin NIE ISTNIEJA w routerze, wiec nie
   * da sie ich znalezc sondowaniem.
   */
  adminToken: string;
  /**
   * Patrz AuthConfig.debugOpoznienieUs - furtka WYLACZNIE do walidacji
   * przyrzadu pomiarowego.
   *
   * NODE_ENV=production zeruje ja twardo, ale nie da sie na tym poprzestac:
   * w wielu wdrozeniach NODE_ENV po prostu nie jest ustawione, wiec sam ten
   * warunek gwarantuje mniej, niz sugeruje. Dlatego buildServer wypisuje
   * OSTRZEZENIE przy kazdym starcie z niezerowa wartoscia - furtka nie moze
   * byc wlaczona po cichu.
   */
  debugDelayUs: number;
  /** Pieprze jako zwykle dane - konfiguracja pozostaje serializowalna. */
  peppers: Array<[number, string]>;
  activePepper: number | null;
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
    rateLimitUnauthenticated: Number(env.RATE_LIMIT_UNAUTHENTICATED ?? 60),
    keysRefreshMs: Number(env.KEYS_REFRESH_MS ?? 10_000),
    keysMaxAgeSeconds: Number(env.KEYS_MAX_AGE_S ?? 900),
    usageFlushMs: Number(env.USAGE_FLUSH_MS ?? 60_000),
    adminToken: env.ADMIN_TOKEN ?? '',
    debugDelayUs: env.NODE_ENV === 'production'
      ? 0
      : Number(env.AUTH_DEBUG_DELAY_US ?? 0),
    ...(() => { const { sekrety, aktywna } = pepperEntriesFromEnv(env); return { peppers: sekrety, activePepper: aktywna }; })(),
  };
}

/** Nieznana wartosc daje 'disabled' - najbezpieczniejsza wobec zgodnosci wstecz. */
export function parseApiKeyMode(v?: string): ApiKeyMode {
  if (v === 'required' || v === 'optional' || v === 'disabled') return v;
  /**
   * DOMYSLKA ZMIENIONA 10.08.2026 z 'disabled' na 'required' (zadanie 8.9).
   *
   * To jedyna zmiana ZACHOWANIA w calym etapie 8A - cala reszta byla dokladana
   * pod wylaczonym przelacznikiem. Celowo osobny, jednolinijkowy i odwracalny
   * commit: gdyby cokolwiek poszlo nie tak przy wdrozeniu, cofniecie jest
   * jedna zmiana, a nie rewizja calego etapu.
   *
   * Wszystkie zestawy testow maja tryb przypiety jawnie od zadania 8.4b, wiec
   * przelaczenie ich nie dotyka. To byla cala pointa trybu przejsciowego.
   *
   * Nieznana wartosc daje 'required', nie 'disabled': literowka w konfiguracji
   * wdrozenia nie moze po cichu OTWIERAC serwisu.
   */
  return 'required';
}
