/**
 * Ladowanie nadan z bazy i skladanie ich w `Actor`.
 *
 * PODZIAL Z SILNIKIEM
 *
 * Silnik (`core/policy/can.ts`) jest czysty: dostaje gotowego `Actor` i nie
 * dotyka bazy. Tutaj jest cala reszta - zapytanie, rozwiniecie skladania rol
 * i zlozenie sciezki pochodzenia. Dzieki temu decyzja o dostepie da sie
 * przetestowac bez stawiania czegokolwiek, a to miejsce da sie wymienic
 * (cache, replika) bez dotykania regul.
 *
 * ROZWINIECIE SKLADANIA ROBI BAZA
 *
 * `koordynator` zawiera `redaktor`, ktory moglby zawierac kolejna. Rekurencja
 * po stronie aplikacji oznaczalaby N+1 zapytan i wlasna obsluge cykli.
 * Zapytanie rekurencyjne robi to jednym przebiegiem, a przed cyklem chroni
 * wyzwalacz zalozony w migracji 006 - wiec tu nie trzeba go powtarzac.
 *
 * SCIEZKA POCHODZENIA JEST BUDOWANA PO DRODZE
 *
 * `via` niesie `koordynator < redaktor`, czyli odpowiedz na pytanie "skad ta
 * osoba ma to uprawnienie". Bez tego przy trzech poziomach skladania nikt
 * na nie nie odpowie, a przy zarzadzaniu rolami z panelu to pytanie pada
 * natychmiast.
 */
import type pg from 'pg';
import { findUnknownPermissions, type Actor, type Grant } from '@adres-pl/core';

interface Wiersz {
  permission: string;
  scope_terc: string | null;
  scope_client_id: string | null;
  via: string;
}

/**
 * Nadania skuteczne konta - juz po rozwinieciu skladania rol.
 *
 * Uwzglednia wylacznie przypisania CZYNNE: rola niewylaczona, przypisanie
 * w swoim okresie waznosci. Wykonawca zewnetrzny z data konca przestaje miec
 * dostep sam z siebie, bez pamietania o tym przez kogokolwiek.
 */
const ZAPYTANIE = `
WITH RECURSIVE rozwiniete(assignment_id, role_id, sciezka, glebokosc) AS (
  SELECT ra.id, ra.role_id, r.name, 0
    FROM panel.role_assignment ra
    JOIN panel.role r ON r.id = ra.role_id AND r.disabled_at IS NULL
   WHERE ra.account_id = $1
     AND ra.valid_from <= now()
     AND (ra.valid_to IS NULL OR ra.valid_to > now())
  UNION ALL
  SELECT e.assignment_id, ri.included_id, e.sciezka || ' < ' || i.name, e.glebokosc + 1
    FROM rozwiniete e
    JOIN panel.role_includes ri ON ri.role_id = e.role_id
    JOIN panel.role i ON i.id = ri.included_id AND i.disabled_at IS NULL
   -- Bezpiecznik na wypadek, gdyby cykl jednak powstal (np. przez recznego
   -- INSERT-a z wylaczonym wyzwalaczem). Bez niego zapytanie nie wracaloby.
   WHERE e.glebokosc < 16
)
SELECT rp.permission,
       ra.scope_terc,
       ra.scope_client_id::text,
       e.sciezka AS via
  FROM rozwiniete e
  JOIN panel.role_permission rp ON rp.role_id = e.role_id
  JOIN panel.role_assignment ra ON ra.id = e.assignment_id`;

export async function loadGrants(pool: pg.Pool, accountId: number): Promise<Grant[]> {
  const { rows } = await pool.query<Wiersz>(ZAPYTANIE, [accountId]);
  return rows.map((r) => ({
    permission: r.permission,
    scopeTerc: r.scope_terc,
    scopeClientId: r.scope_client_id === null ? null : Number(r.scope_client_id),
    via: `rola ${r.via}`,
  }));
}

export interface AccountRow {
  id: number;
  login: string;
  display_name: string;
  disabled_at: Date | null;
}

/**
 * Wykonawca dla konta czlowieka. `null`, gdy konta nie ma albo jest wylaczone -
 * wylaczenie ma dzialac natychmiast, wiec sprawdzamy je przy kazdym zlozeniu,
 * a nie tylko przy logowaniu.
 */
export async function loadAccountActor(pool: pg.Pool, accountId: number): Promise<Actor | null> {
  const { rows: [a] } = await pool.query<AccountRow>(
    `SELECT id, login, display_name, disabled_at FROM panel.account WHERE id = $1`,
    [accountId]);
  if (!a || a.disabled_at) return null;
  return {
    kind: 'user',
    id: String(a.id),
    label: a.login,
    grants: await loadGrants(pool, a.id),
  };
}

/**
 * Wykonawca dla tokenu operatora.
 *
 * Do czasu powstania kont (etap 3 planu panelu) token ADMIN_TOKEN jest
 * jedynym sposobem wejscia na trasy /admin. Zeby szew `can()` byl PRAWDZIWY,
 * a nie teoretyczny, ten token tez przechodzi przez silnik - z uprawnieniami
 * roli `administrator` wczytanymi Z BAZY, a nie zaszytymi w kodzie.
 *
 * Dzieki temu:
 *  - kazde wywolanie /admin przechodzi ta sama sciezka co bedzie przechodzic
 *    konto czlowieka, wiec sciezka jest sprawdzona zanim powstana konta;
 *  - odjecie uprawnienia roli `administrator` w panelu dziala takze na token;
 *  - w dzienniku audytu widac `service/admin-token`, a nie anonimowa zmiane.
 *
 * NIE jest to tryb ratunkowy: ten omija silnik i ma byc glosny. Token
 * operatora to zwykly wykonawca maszynowy z szerokimi uprawnieniami.
 */
export async function loadOperatorTokenActor(pool: pg.Pool): Promise<Actor> {
  const { rows } = await pool.query<{ permission: string }>(
    `SELECT rp.permission
       FROM panel.role r JOIN panel.role_permission rp ON rp.role_id = r.id
      WHERE r.name = 'administrator' AND r.disabled_at IS NULL`);
  return {
    kind: 'service',
    id: 'admin-token',
    label: 'token operatora',
    grants: rows.map((r) => ({
      permission: r.permission,
      scopeTerc: null,
      scopeClientId: null,
      via: 'rola administrator (token operatora)',
    })),
  };
}

/**
 * Uprawnienia wymieniane przez role, ktorych nie ma juz w katalogu.
 *
 * Sytuacja jest realna: wdrozenie usuwa uprawnienie, a w bazie zostaja role,
 * ktore je wymieniaja. Rola wyglada wtedy normalnie, a jedna jej pozycja nie
 * robi nic. Sprawdzane przy starcie serwisu - lepiej dowiedziec sie z logu
 * przy wstawaniu niz z pytania uzytkownika.
 */
export async function findOrphanedPermissions(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ permission: string }>(
    `SELECT DISTINCT permission FROM panel.role_permission`);
  return findUnknownPermissions(rows.map((r) => r.permission));
}
