-- ---------------------------------------------------------------------
-- 006. Kregoslup panelu: wykonawca, role z zakresem, sesje, dziennik audytu
-- ---------------------------------------------------------------------
--
-- CO TU JEST I DLACZEGO RAZEM
--
-- Cztery nadchodzace rzeczy potrzebuja tego samego pojecia: KTO dziala.
-- Dziennik zmian rekordow (etap 5.1), historia wydan (4.7), pochodzenie
-- recznej poprawki (5.4) i dziennik uprawnien. Zbudowane osobno dadza cztery
-- niekompatybilne dzienniki i jedno pytanie "kto to zmienil", na ktore nie ma
-- odpowiedzi. Dlatego wykonawca i dziennik powstaja RAZ, tutaj.
--
-- OSOBNY SCHEMAT `panel`
--
-- Tak samo jak `licensing`: zero kluczy obcych w strone `address`. Powod jest
-- ten sam co przy 004 - `scripts/e2e.sh` robi TRUNCATE schematu address
-- CASCADE, a kaskada nie moze wynosic kont i dziennika audytu.
--
-- ZAKRES NA DWOCH OSIACH
--
-- Rozstrzygniete 10.08.2026 (docs/panel-role-i-uprawnienia.md rozdz. 4):
-- rola mowi CO, przypisanie mowi GDZIE. Bez tego rozdzielenia powstalyby
-- `Redaktor Mazowsza`, `Redaktor Malopolski` i tak dalej - 16 wojewodztw,
-- 380 powiatow, 2477 gmin.
--
-- Zakres terytorialny to PREFIKS TERC. Sprawdzone na danych: wszystkie 4344
-- jednostki maja TERC rodzica jako prefiks swojego, wiec `14` obejmuje cale
-- Mazowieckie, a `1465011` sama gmine. Bez tabel posrednich i bez drzewa.

BEGIN;

CREATE SCHEMA IF NOT EXISTS panel;

COMMENT ON SCHEMA panel IS
  'Konta ludzi, role, sesje i dziennik audytu. Bez kluczy obcych do address.';

-- ---------------------------------------------------------------------
-- 1. Konta
-- ---------------------------------------------------------------------
-- `account`, a nie `user`: USER jest slowem zastrzezonym w SQL i wymagaloby
-- cudzyslowow w kazdym zapytaniu. Reszta schematu jest w liczbie pojedynczej
-- (`client`, `api_key`, `street`), wiec trzymamy sie tego.
CREATE TABLE IF NOT EXISTS panel.account (
  id            bigserial PRIMARY KEY,
  login         text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  -- argon2id. Tu wolne hashowanie MA sens, w przeciwiescieństwie do kluczy API:
  -- haslo czlowieka ma niska entropie i to wlasnie przed jego zgadywaniem
  -- chroni koszt funkcji. Klucz o 128 bitach entropii nie potrzebuje spowolnienia.
  password_hash text,
  totp_secret   text,
  -- Konta sie WYLACZA, nie kasuje - dziennik audytu musi miec na co wskazywac.
  disabled_at   timestamptz,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 2. Role - DANE, edytowalne z panelu
-- ---------------------------------------------------------------------
-- Uprawnienia sa stala w kodzie (core/policy/permissions.ts), bo sa
-- odpowiednikiem punktu kontroli. Rola nadajaca `address.publish` bylaby nazwa
-- bez pokrycia. Role natomiast panel tworzy, edytuje, laczy i kasuje.
CREATE TABLE IF NOT EXISTS panel.role (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  description text,
  -- Rola zalozona przez migracje. Informacyjne - nie blokuje edycji,
  -- bo wymaganiem jest pelne zarzadzanie z panelu.
  built_in    boolean NOT NULL DEFAULT false,
  -- Przy scaleniu rola zrodlowa jest WYLACZANA, nie kasowana: dziennik audytu
  -- odwoluje sie do niej po identyfikatorze.
  disabled_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS panel.role_permission (
  role_id    bigint NOT NULL REFERENCES panel.role(id) ON DELETE CASCADE,
  -- Nazwa z katalogu w kodzie. Klucza obcego nie ma do czego zalozyc, wiec
  -- spojnosci pilnuje kontrola przy starcie i przy edycji roli
  -- (findUnknownPermissions). Sytuacja jest realna: wdrozenie usuwa
  -- uprawnienie, a w bazie zostaja role, ktore je wymieniaja.
  permission text NOT NULL,
  PRIMARY KEY (role_id, permission)
);

-- Skladanie rol: `koordynator` zawiera `redaktor` i dokłada import.approve.
CREATE TABLE IF NOT EXISTS panel.role_includes (
  role_id     bigint NOT NULL REFERENCES panel.role(id) ON DELETE CASCADE,
  -- RESTRICT, nie CASCADE: usuniecie roli skladowej po cichu okroilo by
  -- kazda role, ktora ja zawiera.
  included_id bigint NOT NULL REFERENCES panel.role(id) ON DELETE RESTRICT,
  PRIMARY KEY (role_id, included_id),
  CONSTRAINT role_includes_nie_sama_siebie CHECK (role_id <> included_id)
);

/**
 * Wykrywanie cykli PO STRONIE BAZY, a nie tylko w panelu.
 *
 * `A` zawiera `B`, ktos ustawia `B` zawiera `A` - przy edycji z panelu to nie
 * jest sytuacja teoretyczna. Skutkiem jest nieskonczona rekurencja przy
 * wyliczaniu zestawu skutecznego, czyli zawieszenie procesu obslugujacego
 * zadanie. Kontrola w aplikacji tez bedzie, ale ta jest OSTATECZNA: obowiazuje
 * takze przy recznym UPDATE z psql.
 */
CREATE OR REPLACE FUNCTION panel.role_includes_bez_cyklu() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE sciezka(id) AS (
      SELECT NEW.role_id
      UNION
      SELECT ri.role_id FROM panel.role_includes ri JOIN sciezka s ON ri.included_id = s.id
    )
    SELECT 1 FROM sciezka WHERE id = NEW.included_id
  ) THEN
    RAISE EXCEPTION 'Cykl w skladaniu rol: % zawieralaby samą siebie przez %',
      NEW.role_id, NEW.included_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_role_includes_bez_cyklu ON panel.role_includes;
CREATE TRIGGER tg_role_includes_bez_cyklu
  BEFORE INSERT OR UPDATE ON panel.role_includes
  FOR EACH ROW EXECUTE FUNCTION panel.role_includes_bez_cyklu();

-- ---------------------------------------------------------------------
-- 3. Przypisania - tu mieszka ZAKRES
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS panel.role_assignment (
  id              bigserial PRIMARY KEY,
  account_id      bigint NOT NULL REFERENCES panel.account(id) ON DELETE RESTRICT,
  role_id         bigint NOT NULL REFERENCES panel.role(id) ON DELETE RESTRICT,
  -- NULL = bez ograniczenia na tej osi. To NIE znaczy "brak dostepu".
  scope_terc      text,
  scope_client_id bigint,
  valid_from      timestamptz NOT NULL DEFAULT now(),
  -- Wykonawca zewnetrzny na czas okreslony - scenariusz 5 z dokumentu.
  valid_to        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text,
  UNIQUE (account_id, role_id, scope_terc, scope_client_id),
  -- TERC ma 7 znakow, wiec prefiks jest krotszy albo rowny i zawsze cyframi.
  CONSTRAINT role_assignment_terc_prefiks
    CHECK (scope_terc IS NULL OR scope_terc ~ '^[0-9]{1,7}$')
);

CREATE INDEX IF NOT EXISTS ix_role_assignment_account ON panel.role_assignment(account_id);

-- ---------------------------------------------------------------------
-- 4. Sesje
-- ---------------------------------------------------------------------
-- Wzorzec z zadania 8.4a: replika w pamieci + NOTIFY jako przyspieszacz
-- + odpytywanie jako gwarancja. Uzasadnienie jest juz w repozytorium - NOTIFY
-- ginie przy restarcie bazy i przelaczeniu na replike, i ginie CICHO, wiec
-- uniewazniona sesja dzialalaby dalej.
--
-- Przeciw bezstanowym tokenom: zmiana roli i odejscie pracownika musza dzialac
-- natychmiast. JWT bez listy uniewaznien tego nie potrafi, a JWT z lista
-- uniewaznien to rejestr sesji obudowany dodatkowa warstwa.
CREATE TABLE IF NOT EXISTS panel.session (
  id           bigserial PRIMARY KEY,
  account_id   bigint NOT NULL REFERENCES panel.account(id) ON DELETE RESTRICT,
  -- Skrot, nigdy wartosc jawna - tak samo jak przy kluczach API.
  token_hash   bytea NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  revoked_by   text,
  ip           inet,
  user_agent   text
);

CREATE INDEX IF NOT EXISTS ix_session_account ON panel.session(account_id)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- 5. Dziennik audytu - JEDEN dla calego systemu
-- ---------------------------------------------------------------------
-- Nie da sie go dorobic wstecz. Okres sprzed zalozenia dziennika przepada
-- bezpowrotnie, dlatego powstaje TERAZ, zanim cokolwiek zacznie zmieniac dane.
--
-- Obsluguje wszystkie cztery rodzaje wykonawcy - czlowieka, klucz API, usluge
-- wewnetrzna i tryb ratunkowy - bo pytanie "kto to zrobil" musi miec odpowiedz
-- niezaleznie od tego, kto dzialal.
--
-- ODMOWA JEST ZDARZENIEM AUDYTOWYM na rowni z nadaniem. Seria odmow to sygnal
-- ataku albo zle nadanych rol; jedno i drugie trzeba zobaczyc.
CREATE TABLE IF NOT EXISTS panel.audit_log (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),

  actor_kind      text NOT NULL CHECK (actor_kind IN ('user','api_key','service','break_glass')),
  actor_id        text NOT NULL,
  actor_label     text,

  -- Czynnosc w postaci obszar.czynnosc - zwykle nazwa uprawnienia.
  action          text NOT NULL,
  -- Sprawdzone uprawnienie i zakres zadania. NULL, gdy zdarzenie nie bylo
  -- rozstrzygnieciem dostepu (np. zalogowanie).
  permission      text,
  scope_terc      text,
  scope_client_id bigint,

  decision        text CHECK (decision IN ('allowed','denied')),
  -- Sciezka, ktora uprawnienie doszlo do wykonawcy - `via` z silnika polityki.
  -- To ona odpowiada na pytanie "dlaczego ta osoba mogla".
  via             text,
  reason          text,

  target_kind     text,
  target_id       text,
  -- Stan przed i po. Wymaganie 5.1: "co, kiedy, z jakiego zrodla,
  -- poprzednia wartosc".
  before          jsonb,
  after           jsonb,

  -- Wiaze wpisy pochodzace z jednego zadania HTTP albo jednego przebiegu ETL.
  correlation_id  text,
  ip              inet
);

CREATE INDEX IF NOT EXISTS ix_audit_at         ON panel.audit_log(at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_actor      ON panel.audit_log(actor_kind, actor_id, at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_target     ON panel.audit_log(target_kind, target_id, at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_correlation ON panel.audit_log(correlation_id)
  WHERE correlation_id IS NOT NULL;
-- Odmowy sa rzadkie i wazne - osobny indeks czesciowy, zeby alert po nich
-- nie skanowal calosci.
CREATE INDEX IF NOT EXISTS ix_audit_denied ON panel.audit_log(at DESC)
  WHERE decision = 'denied';

-- ---------------------------------------------------------------------
-- 6. Role startowe
-- ---------------------------------------------------------------------
-- Roznicowane po ZAKRESIE CZYNNOSCI, nie po obszarze. Obszar wnosi
-- przypisanie, przez prefiks TERC.
INSERT INTO panel.role (name, description, built_in, created_by) VALUES
  ('podglad',      'Wszystko do odczytu, nic do zmiany',                     true, 'migracja 006'),
  ('redaktor',     'Poprawianie i dodawanie adresow w swoim obszarze',       true, 'migracja 006'),
  ('koordynator',  'Redaktor plus import reczny i jego zatwierdzanie',       true, 'migracja 006'),
  ('operator',     'Obsluga klientow, kluczy i rozliczen',                   true, 'migracja 006'),
  ('wydawca',      'Przygotowanie, publikacja i wycofanie wydania',          true, 'migracja 006'),
  ('administrator','Wszystko poza trybem ratunkowym',                        true, 'migracja 006')
ON CONFLICT (name) DO NOTHING;

INSERT INTO panel.role_permission (role_id, permission)
SELECT r.id, p.permission FROM panel.role r
CROSS JOIN LATERAL (VALUES
  ('user.read'),('role.read'),('client.read'),('key.read'),('usage.read'),
  ('address.read'),('release.read'),('etl.read_progress'),('system.read_metrics')
) AS p(permission)
WHERE r.name = 'podglad'
ON CONFLICT DO NOTHING;

INSERT INTO panel.role_permission (role_id, permission)
SELECT r.id, p.permission FROM panel.role r
CROSS JOIN LATERAL (VALUES
  ('address.read'),('address.edit'),('address.create'),('address.withdraw')
) AS p(permission)
WHERE r.name = 'redaktor'
ON CONFLICT DO NOTHING;

INSERT INTO panel.role_permission (role_id, permission)
SELECT r.id, p.permission FROM panel.role r
CROSS JOIN LATERAL (VALUES ('import.run'),('import.approve')) AS p(permission)
WHERE r.name = 'koordynator'
ON CONFLICT DO NOTHING;

-- Skladanie zamiast powtarzania: poprawka w `redaktor` przenosi sie sama.
INSERT INTO panel.role_includes (role_id, included_id)
SELECT k.id, r.id FROM panel.role k, panel.role r
 WHERE k.name = 'koordynator' AND r.name = 'redaktor'
ON CONFLICT DO NOTHING;

INSERT INTO panel.role_permission (role_id, permission)
SELECT r.id, p.permission FROM panel.role r
CROSS JOIN LATERAL (VALUES
  ('client.read'),('client.create'),('client.update'),('client.suspend'),
  ('key.read'),('key.create'),('key.rotate'),('key.revoke'),
  ('usage.read'),('usage.export')
) AS p(permission)
WHERE r.name = 'operator'
ON CONFLICT DO NOTHING;

INSERT INTO panel.role_permission (role_id, permission)
SELECT r.id, p.permission FROM panel.role r
CROSS JOIN LATERAL (VALUES
  ('release.read'),('release.prepare'),('release.publish'),
  ('release.rollback'),('release.pin_client')
) AS p(permission)
WHERE r.name = 'wydawca'
ON CONFLICT DO NOTHING;

-- Administrator dostaje komplet POZA trybem ratunkowym. Lista jest wypisana
-- wprost, a nie wyliczana - dopisanie uprawnienia w kodzie ma byc SWIADOMA
-- decyzja o tym, kto je dostaje, a nie skutkiem ubocznym wdrozenia.
INSERT INTO panel.role_permission (role_id, permission)
SELECT r.id, p.permission FROM panel.role r
CROSS JOIN LATERAL (VALUES
  ('user.read'),('user.create'),('user.update'),('user.disable'),('user.assign_role'),
  ('role.read'),('role.create'),('role.update'),('role.delete'),('role.merge'),
  ('client.read'),('client.create'),('client.update'),('client.suspend'),
  ('key.read'),('key.create'),('key.rotate'),('key.revoke'),
  ('usage.read'),('usage.export'),
  ('address.read'),('address.edit'),('address.create'),('address.withdraw'),
  ('import.run'),('import.approve'),
  ('release.read'),('release.prepare'),('release.publish'),('release.rollback'),('release.pin_client'),
  ('etl.run'),('etl.cancel'),('etl.read_progress'),
  ('audit.read'),('audit.export'),
  ('system.read_metrics'),('system.manage_settings')
) AS p(permission)
WHERE r.name = 'administrator'
ON CONFLICT DO NOTHING;

COMMIT;
