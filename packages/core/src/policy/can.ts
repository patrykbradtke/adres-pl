/**
 * Silnik polityki - JEDYNE miejsce, w ktorym zapada decyzja o dostepie.
 *
 * DLACZEGO UPRAWNIENIE, A NIE NAZWA ROLI
 *
 * W kodzie nigdy nie pojawia sie `if (rola === 'administrator')`. Powod jest
 * praktyczny: role ZAWSZE sie zmieniaja, a sprawdzanie po ich nazwach rozsypuje
 * polityke po calym kodzie. Po roku nikt nie odpowie na pytanie "co dokladnie
 * moze operator", bo odpowiedz lezy w czterdziestu miejscach.
 *
 * DLACZEGO DECYZJA NIESIE UZASADNIENIE
 *
 * `true`/`false` nie odpowiada na pytanie "dlaczego ta osoba to moze", a przy
 * skladaniu rol (rola zawiera role) to pytanie pada natychmiast. Decyzja niesie
 * wiec `via` - sciezke, ktora uprawnienie do niej doszlo. To samo pole trafia
 * do dziennika audytu, wiec odpowiedz jest dostepna takze po fakcie.
 *
 * FUNKCJA JEST CZYSTA
 *
 * Zadnego dotkniecia bazy, zadnego wejscia do sieci. Wszystko, czego potrzebuje,
 * dostaje w `Actor`. Dzieki temu da sie ja przetestowac bez stawiania czegokol-
 * wiek, a wywolanie w sciezce zadania kosztuje tyle, co przejscie po tablicy.
 * Ladowanie nadan z bazy jest osobna sprawa i mieszka w `packages/api`.
 */
import { findPermission, type ScopeAxis } from './permissions.ts';

export type ActorKind = 'user' | 'api_key' | 'service' | 'break_glass';

/**
 * Pojedyncze nadanie. `null` w zakresie znaczy BEZ OGRANICZENIA na tej osi -
 * nie "brak dostepu".
 */
export interface Grant {
  readonly permission: string;
  /** Prefiks TERC, np. `14` (wojewodztwo) albo `1465011` (gmina). */
  readonly scopeTerc: string | null;
  readonly scopeClientId: number | null;
  /** Skad przyszlo, np. `rola koordynator` albo `rola koordynator < redaktor`. */
  readonly via: string;
}

export interface Actor {
  readonly kind: ActorKind;
  /** Identyfikator do dziennika audytu. */
  readonly id: string;
  /** Nazwa do wydruku - login, prefiks klucza, nazwa uslugi. */
  readonly label?: string;
  readonly grants: readonly Grant[];
}

/** Czego dotyczy czynnosc. Puste pole = czynnosc nie jest niczym zawezona. */
export interface ScopeRequest {
  /** TERC jednostki, ktorej dotyczy czynnosc - pelny, nie prefiks. */
  readonly terc?: string;
  readonly clientId?: number;
}

export type Decision =
  | { readonly allowed: true; readonly via: string }
  | { readonly allowed: false; readonly reason: string };

/**
 * Blad UZYCIA silnika, nie odmowa dostepu.
 *
 * Rozroznienie jest celowe: podanie zakresu terytorialnego do uprawnienia,
 * ktore go nie przyjmuje, to pomylka programisty. Zwrocenie z tego powodu
 * "brak dostepu" ukryloby blad pod poprawnie wygladajacym 403 i nikt by go
 * nie znalazl. Wyjatek konczy sie kodem 500, czyli tym, czym naprawde jest.
 */
export class PolicyUsageError extends Error {}

function matchesTerc(grant: string | null, requested: string | undefined): boolean {
  // Nadanie bez zakresu obejmuje caly kraj.
  if (grant === null) return true;
  // Nadanie zawezone, a czynnosc nie mowi czego dotyczy - nie ma jak sprawdzic,
  // wiec odmawiamy. Inaczej zawezenie dalo by sie obejsc pominieciem parametru.
  if (requested === undefined) return false;
  // TERC jest hierarchiczny prefiksowo: `14` obejmuje `1465011`.
  // Sprawdzone na danych - wszystkie 4344 jednostki maja TERC rodzica
  // jako prefiks swojego.
  return requested.startsWith(grant);
}

function matchesClient(grant: number | null, requested: number | undefined): boolean {
  if (grant === null) return true;
  if (requested === undefined) return false;
  return grant === requested;
}

function scopeMatches(axis: ScopeAxis, g: Grant, scope: ScopeRequest): boolean {
  switch (axis) {
    case 'global':      return true;
    case 'territorial': return matchesTerc(g.scopeTerc, scope.terc);
    case 'client':      return matchesClient(g.scopeClientId, scope.clientId);
  }
}

/**
 * Czy `actor` moze wykonac `permission` w zakresie `scope`.
 *
 * @throws PolicyUsageError gdy uprawnienie nie istnieje w katalogu albo gdy
 *         podano zakres na osi, ktorej to uprawnienie nie przyjmuje.
 */
export function can(
  actor: Actor,
  permission: string,
  scope: ScopeRequest = {},
): Decision {
  const def = findPermission(permission);
  if (!def) {
    throw new PolicyUsageError(
      `Nieznane uprawnienie: ${permission}. Katalog jest w core/policy/permissions.ts.`);
  }

  // Zakres podany na osi, ktorej uprawnienie nie przyjmuje - pomylka wolajacego.
  if (def.axis !== 'territorial' && scope.terc !== undefined) {
    throw new PolicyUsageError(
      `${permission} ma os ${def.axis}, a podano zakres terytorialny. ` +
      'Zawezenie nie mialoby tu znaczenia.');
  }
  if (def.axis !== 'client' && scope.clientId !== undefined) {
    throw new PolicyUsageError(
      `${permission} ma os ${def.axis}, a podano zakres klienta.`);
  }

  /**
   * Tryb ratunkowy przechodzi wszystko - i to jest JAWNY wyjatek, a nie
   * przeoczenie. Udawanie, ze break-glass to zwykle nadanie, ukrywaloby
   * fakt, ze istnieje droga na skroty. Wolajacy ma obowiazek zapisac to
   * w dzienniku z wysokim priorytetem (patrz reguly, rozdz. 7 dokumentu).
   */
  if (actor.kind === 'break_glass') {
    return { allowed: true, via: 'TRYB RATUNKOWY' };
  }

  for (const g of actor.grants) {
    if (g.permission !== permission) continue;
    if (scopeMatches(def.axis, g, scope)) return { allowed: true, via: g.via };
  }

  const posiadane = actor.grants.filter((g) => g.permission === permission);
  if (posiadane.length === 0) {
    return { allowed: false, reason: `brak uprawnienia ${permission}` };
  }
  return {
    allowed: false,
    reason: `uprawnienie ${permission} jest zawezone do ` +
      posiadane.map((g) => opisZakresu(def.axis, g)).join(' oraz ') +
      `, a czynnosc dotyczy ${opisZadania(def.axis, scope)}`,
  };
}

function opisZakresu(axis: ScopeAxis, g: Grant): string {
  if (axis === 'territorial') return g.scopeTerc === null ? 'calego kraju' : `TERC ${g.scopeTerc}`;
  if (axis === 'client') return g.scopeClientId === null ? 'wszystkich klientow' : `klienta ${g.scopeClientId}`;
  return 'calosci';
}

function opisZadania(axis: ScopeAxis, s: ScopeRequest): string {
  if (axis === 'territorial') return s.terc === undefined ? 'obszaru niewskazanego' : `TERC ${s.terc}`;
  if (axis === 'client') return s.clientId === undefined ? 'klienta niewskazanego' : `klienta ${s.clientId}`;
  return 'calosci';
}

/**
 * Wersja rzucajaca - do uzycia tam, gdzie odmowa i tak konczy obsluge.
 * Skraca `const d = can(...); if (!d.allowed) return reply.code(403)...`
 * do jednej linii, nie gubiac uzasadnienia.
 */
export class Forbidden extends Error {
  readonly reason: string;

  // Jawne przypisanie zamiast parameter property: Node w trybie
  // --experimental-strip-types wycina WYLACZNIE typy i nie generuje kodu,
  // wiec `constructor(public readonly reason)` nie przypisalby niczego.
  // Ta sama uwaga stoi przy DlawionyLog w api/keys/auth.ts.
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export function assertCan(
  actor: Actor,
  permission: string,
  scope: ScopeRequest = {},
): { via: string } {
  const d = can(actor, permission, scope);
  if (!d.allowed) throw new Forbidden(d.reason);
  return { via: d.via };
}
