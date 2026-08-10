/**
 * Katalog uprawnien - JEDYNE zrodlo prawdy o tym, co w ogole da sie nadac.
 *
 * DLACZEGO STALA W KODZIE, A NIE WIERSZE W BAZIE
 *
 * Uprawnienie jest odpowiednikiem PUNKTU KONTROLI w kodzie. Gdyby bylo dana,
 * panel pozwolilby utworzyc role nadajaca `address.publish` - nazwe bez
 * pokrycia, ktorej nikt nie egzekwuje, bo nie ma po drugiej stronie zadnego
 * `can(...)`. Operator bylby przekonany, ze cos nadal.
 *
 * Odwrotnie jest z ROLAMI: te sa danymi i panel je tworzy, edytuje, laczy
 * i kasuje. Rola to wylacznie nazwana wiazka pozycji z tego katalogu.
 *
 * DLACZEGO KAZDA POZYCJA NIESIE OS ZAKRESU
 *
 * Nie kazde uprawnienie da sie zawezic. "Moze opublikowac wydanie, ale tylko
 * w Mazowieckiem" jest bez znaczenia - wydanie jest krajowe. Bez tego pola
 * panel pozwolilby nadac ustawienie, ktore nic nie robi, a operator bylby
 * przekonany, ze cos ograniczyl. Silnik odrzuca zakres podany do uprawnienia
 * globalnego zamiast go po cichu zignorowac.
 */

/**
 * Os, wzdluz ktorej uprawnienie da sie zawezic.
 *
 *  - `global`      - nie da sie zawezic w ogole
 *  - `territorial` - prefiksem TERC (`14` = Mazowieckie, `1465011` = gmina)
 *  - `client`      - identyfikatorem klienta
 */
export type ScopeAxis = 'global' | 'territorial' | 'client';

export interface PermissionDef {
  readonly name: string;
  readonly axis: ScopeAxis;
  /** Po co istnieje. Widoczne w panelu przy nadawaniu. */
  readonly description: string;
}

/**
 * Pelny katalog. Kolejnosc ma znaczenie wylacznie dla czytelnosci wydruku.
 *
 * Dopisanie pozycji tutaj NIE nadaje jej nikomu - trzeba ja jeszcze wlozyc
 * do roli. Usuniecie pozycji, do ktorej odwoluje sie rola w bazie, jest
 * wykrywane przy starcie (patrz `findUnknownPermissions`).
 */
export const PERMISSIONS: readonly PermissionDef[] = [
  // --- ludzie i role ---------------------------------------------------
  { name: 'user.read',          axis: 'global', description: 'Podglad kont panelu' },
  { name: 'user.create',        axis: 'global', description: 'Zakladanie kont' },
  { name: 'user.update',        axis: 'global', description: 'Edycja konta' },
  { name: 'user.disable',       axis: 'global', description: 'Wylaczenie konta' },
  { name: 'user.assign_role',   axis: 'global', description: 'Nadawanie i odbieranie rol' },
  { name: 'role.read',          axis: 'global', description: 'Podglad rol' },
  { name: 'role.create',        axis: 'global', description: 'Tworzenie rol' },
  { name: 'role.update',        axis: 'global', description: 'Edycja roli i jej skladania' },
  { name: 'role.delete',        axis: 'global', description: 'Usuwanie rol' },
  { name: 'role.merge',         axis: 'global', description: 'Scalanie dwoch rol w jedna' },

  // --- klienci i klucze -------------------------------------------------
  { name: 'client.read',        axis: 'client', description: 'Podglad klientow' },
  { name: 'client.create',      axis: 'client', description: 'Zakladanie klienta' },
  { name: 'client.update',      axis: 'client', description: 'Edycja klienta i limitow' },
  { name: 'client.suspend',     axis: 'client', description: 'Zawieszenie i odwieszenie klienta' },
  { name: 'key.read',           axis: 'client', description: 'Podglad kluczy API' },
  { name: 'key.create',         axis: 'client', description: 'Wystawienie klucza' },
  { name: 'key.rotate',         axis: 'client', description: 'Rotacja klucza' },
  { name: 'key.revoke',         axis: 'client', description: 'Uniewaznienie klucza' },
  { name: 'usage.read',         axis: 'client', description: 'Podglad zuzycia' },
  { name: 'usage.export',       axis: 'client', description: 'Eksport zuzycia do rozliczen' },

  // --- dane adresowe ----------------------------------------------------
  { name: 'address.read',       axis: 'territorial', description: 'Podglad adresow' },
  { name: 'address.edit',       axis: 'territorial', description: 'Poprawianie adresu' },
  { name: 'address.create',     axis: 'territorial', description: 'Dodanie adresu spoza rejestru' },
  { name: 'address.withdraw',   axis: 'territorial', description: 'Wycofanie adresu' },
  { name: 'import.run',         axis: 'territorial', description: 'Import reczny z pliku' },
  { name: 'import.approve',     axis: 'territorial', description: 'Zatwierdzenie importu do publikacji' },

  // --- wydania ----------------------------------------------------------
  //
  // Globalne z natury rzeczy: wydanie obejmuje caly kraj, wiec zawezenie
  // terytorialne byloby nazwa bez tresci.
  { name: 'release.read',       axis: 'global', description: 'Podglad wydan' },
  { name: 'release.prepare',    axis: 'global', description: 'Przygotowanie wydania' },
  { name: 'release.publish',    axis: 'global', description: 'Opublikowanie wydania' },
  { name: 'release.rollback',   axis: 'global', description: 'Wycofanie wydania' },
  { name: 'release.pin_client', axis: 'global', description: 'Przypiecie klienta do wersji danych' },

  // --- eksploatacja -----------------------------------------------------
  { name: 'etl.run',            axis: 'global', description: 'Uruchomienie cyklu ETL' },
  { name: 'etl.cancel',         axis: 'global', description: 'Przerwanie cyklu' },
  { name: 'etl.read_progress',  axis: 'global', description: 'Podglad postepu przetwarzania' },
  { name: 'audit.read',         axis: 'global', description: 'Podglad dziennika audytu' },
  { name: 'audit.export',       axis: 'global', description: 'Eksport dziennika' },
  { name: 'system.read_metrics', axis: 'global', description: 'Podglad metryk' },
  { name: 'system.manage_settings', axis: 'global', description: 'Zmiana ustawien systemu' },
  { name: 'system.break_glass', axis: 'global', description: 'Tryb ratunkowy - zawsze glosny' },
] as const;

/** Nazwa uprawnienia. Wywodzona z katalogu, zeby literowka nie przeszla. */
export type PermissionName = (typeof PERMISSIONS)[number]['name'];

const BY_NAME = new Map<string, PermissionDef>(PERMISSIONS.map((p) => [p.name, p]));

export function findPermission(name: string): PermissionDef | undefined {
  return BY_NAME.get(name);
}

export function permissionAxis(name: string): ScopeAxis | undefined {
  return BY_NAME.get(name)?.axis;
}

/**
 * Nazwy, ktore istnieja w bazie, a nie istnieja w katalogu.
 *
 * Sytuacja jest realna: wdrozenie usuwa uprawnienie, a w bazie zostaja role,
 * ktore je wymieniaja. Cichy skutek bylby taki, ze rola wyglada normalnie,
 * a jedna jej pozycja nie robi nic. Sprawdzane przy starcie i przy edycji roli.
 */
export function findUnknownPermissions(names: readonly string[]): string[] {
  return names.filter((n) => !BY_NAME.has(n));
}
