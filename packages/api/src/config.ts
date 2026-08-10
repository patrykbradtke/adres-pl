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
  rateLimitNieuwierzytelniony: number;
  kluczeOdswiezanieMs: number;
  /**
   * Po ilu sekundach bez UDANEGO odswiezenia repliki instancja przestaje
   * meldowac gotowosc. Uwierzytelnianie dziala dalej (fail-open) - to jest
   * decyzja o KIEROWANIU RUCHU, nie o wpuszczaniu klientow.
   */
  kluczeMaxWiekS: number;
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
    kluczeMaxWiekS: Number(env.KLUCZE_MAX_WIEK_S ?? 900),
    ...(() => { const { sekrety, aktywna } = pepperEntriesFromEnv(env); return { pieprze: sekrety, pieprzAktywny: aktywna }; })(),
  };
}

/** Nieznana wartosc daje 'wylaczony' - najbezpieczniejsza wobec zgodnosci wstecz. */
export function parseApiKeyMode(v?: string): ApiKeyMode {
  return v === 'wymagany' || v === 'opcjonalny' || v === 'wylaczony' ? v : 'wylaczony';
}
