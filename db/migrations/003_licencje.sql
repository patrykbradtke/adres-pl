-- =====================================================================
--  adres-pl - klienci API, klucze i zuzycie (etap 8A)
--  PostgreSQL 14+ (uzywamy CREATE OR REPLACE TRIGGER)
-- =====================================================================
--
--  ZASADY TEGO SCHEMATU:
--
--   1. OSOBNY SCHEMAT `licencje`, nie `adres`.
--      scripts/e2e.sh wykonuje `TRUNCATE adres.* CASCADE` przy kazdym
--      przebiegu testowym. Gdyby poswiadczenia klientow siedzialy w tym
--      samym schemacie albo mialy do niego klucz obcy, zwykly test
--      kasowalby klucze produkcyjne przez kaskade. ZERO kluczy obcych
--      w strone schematu adres - w obie strony.
--
--   2. ZADNEJ KOLUMNY Z KLUCZEM JAWNYM ani niczym odwracalnym.
--      Zrzut bazy ma byc bezuzyteczny dla napastnika. Trzymamy wylacznie
--      HMAC-SHA256 z pieprzem, ktory w tej bazie nigdy nie byl i nie bedzie.
--
--   3. ZERO `CREATE EXTENSION pgcrypto`. Liczenie HMAC po stronie bazy
--      wstawiloby pieprz do TEKSTU ZAPYTANIA, czyli do pg_stat_statements,
--      do logu wolnych zapytan i do kazdego zrzutu diagnostycznego -
--      co wywraca cala przeslanke "pieprz poza baza".
--
--   4. ZERO typow wyliczeniowych i ZERO uuid. Repozytorium nie ma ani
--      jednego enuma (ALTER TYPE ADD VALUE nie dziala w transakcji),
--      a identyfikatory sa bigserial. Zgodnosc z 001_init.sql.
--
--   5. Wszystkie obiekty KWALIFIKOWANE nazwa schematu. Rola nazywa sie
--      `adres` i schemat nazywa sie `adres`, wiec domyslny search_path
--      ("$user", public) maskuje bledy, ktore na innej instalacji wyjda.
--
--  WGRYWANIE - RECZNE I DOKLADNIE RAZ:
--
--    psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f db/migrations/003_licencje.sql
--
--  ON_ERROR_STOP=1 jest ISTOTNE: bez niego psql konczy sie kodem 0 mimo
--  bledow w srodku pliku, wiec "migracja przeszla" nic nie znaczy.
--
--  Katalog /docker-entrypoint-initdb.d jest przetwarzany WYLACZNIE przy
--  pustym wolumenie, wiec na dzialajacej bazie ten plik nie wejdzie sam.
--  To znany dlug projektu ("narzedzie do migracji", plan produkcyjny) -
--  ten plik jest trzecim, ktory trzeba wgrywac recznie.
--
--  Plik jest IDEMPOTENTNY: mozna go wgrac ponownie bez skutkow ubocznych.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS licencje;

-- ---------------------------------------------------------------------
--  Klient - strona umowy
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS licencje.klient (
  id                bigserial PRIMARY KEY,
  nazwa             text NOT NULL,
  nip               char(10),
  email_kontakt     text,

  -- Nazwa pakietu handlowego. Tekst, nie enum - patrz zasada 4.
  pakiet            text NOT NULL DEFAULT 'test',

  -- Limit zapytan na minute. UWAGA: liczony NA INSTANCJE uslugi, nie
  -- lacznie - liczniki minutowe zyja w pamieci procesu. Przy N replikach
  -- klient moze faktycznie wykonac N razy tyle. To wlasciwosc do zapisania
  -- w umowie, nie luka do zamkniecia: wspoldzielony licznik oznaczalby
  -- obieg sieciowy na sciezce KAZDEGO zadania.
  limit_zapytan_min integer NOT NULL DEFAULT 600,

  -- Kwota miesieczna w JEDNOSTKACH rozliczeniowych (nie w zadaniach) -
  -- patrz komentarz przy licencje.zuzycie. NULL = bez kwoty.
  kwota_miesieczna  bigint,

  -- Zakres licencji na dane. Rozroznienie istotne prawnie: dane PRG sa
  -- bez oplat (art. 40c ust. 5 Prawa geodezyjnego), ale redystrybucja
  -- to inna umowa niz uzycie wewnetrzne.
  licencja          text NOT NULL DEFAULT 'wewnetrzna'
                    CHECK (licencja IN ('wewnetrzna', 'redystrybucja')),
  licencja_od       date,
  licencja_do       date,

  -- Zawieszenie klienta unieważnia WSZYSTKIE jego klucze naraz, bez
  -- dotykania kazdego z osobna.
  zawieszony_od     timestamptz,
  uwagi             text,

  utworzony         timestamptz NOT NULL DEFAULT now(),
  utworzony_przez   text,
  -- Zrodlo znacznika dla repliki w procesie - patrz wyzwalacze nizej.
  zmieniony         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
--  Klucz API
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS licencje.klucz_api (
  id                bigserial PRIMARY KEY,
  -- Bez ON DELETE: klientow sie nie kasuje, tak samo jak nie kasuje sie
  -- rekordow adresowych (zasada 2 z 001_init.sql).
  klient_id         bigint NOT NULL REFERENCES licencje.klient(id),

  srodowisko        text NOT NULL CHECK (srodowisko IN ('test', 'live')),

  -- Jawny fragment do rozpoznania klucza w logu i w panelu. NIGDY nie
  -- wystarcza do uwierzytelnienia.
  prefiks           text NOT NULL,

  -- HMAC-SHA256 klucza jawnego. 32 bajty. Jedyny slad po kluczu w bazie.
  hash              bytea NOT NULL,

  -- Ktora wersja pieprza policzyla ten skrot.
  --
  -- To jest KSIEGOWOSC rotacji, a NIE jej mechanizm. Kolumna kusi do
  -- zalozenia, ze da sie przeliczyc skrot na nowy pieprz - NIE DA SIE,
  -- bo przeliczenie wymaga klucza JAWNEGO, ktorego z zalozenia nie mamy.
  -- Sluzy do policzenia, ile kluczy zostalo do wymiany, i do decyzji,
  -- kiedy wolno usunac stary pieprz z konfiguracji.
  pieprz_wersja     smallint NOT NULL DEFAULT 1,

  nazwa             text,

  wazny_od          timestamptz NOT NULL DEFAULT now(),
  -- Koniec okresu przejsciowego przy rotacji bezprzerwowej.
  wazny_do          timestamptz,
  uniewazniony_od   timestamptz,
  powod_uniewaznienia text,
  -- Poprzednik przy rotacji - pozwala odtworzyc lancuch wymian.
  zastepuje_id      bigint REFERENCES licencje.klucz_api(id),

  -- NULL = "wez limit z klienta". Kolumna celowo BEZ wartosci domyslnej,
  -- zeby odroznic to od jawnego ustawienia 0, czyli "zablokuj ten klucz".
  limit_zapytan_min integer,

  utworzony         timestamptz NOT NULL DEFAULT now(),
  utworzony_przez   text,
  zmieniony         timestamptz NOT NULL DEFAULT now()
);

-- Unikat PELNY, bez warunku czesciowego - i to jest swiadome odstepstwo od
-- konwencji repozytorium, ktore indeksuje z `WHERE wycofany_od IS NULL`
-- (001_init.sql). Z warunkiem `WHERE uniewazniony_od IS NULL` ten sam skrot
-- moglby wejsc do tabeli po raz drugi, a wtedy `SELECT ... WHERE hash = $1`
-- zwracaloby wiecej niz jeden wiersz i klucz UNIEWAZNIONY moglby wygrac.
CREATE UNIQUE INDEX IF NOT EXISTS ux_klucz_hash ON licencje.klucz_api(hash);

CREATE INDEX IF NOT EXISTS ix_klucz_klient ON licencje.klucz_api(klient_id)
  WHERE uniewazniony_od IS NULL;
-- Pod raport "klucze wygasajace w ciagu 7 dni" (zadanie 8.6).
CREATE INDEX IF NOT EXISTS ix_klucz_wazny ON licencje.klucz_api(wazny_do)
  WHERE wazny_do IS NOT NULL AND uniewazniony_od IS NULL;
-- Pod raport "ile kluczy zostalo na starym pieprzu" - warunek wykonalnosci
-- ostatniego kroku rotacji pieprza.
CREATE INDEX IF NOT EXISTS ix_klucz_pieprz ON licencje.klucz_api(pieprz_wersja)
  WHERE uniewazniony_od IS NULL;

-- ---------------------------------------------------------------------
--  Zuzycie - podstawa rozliczenia
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS licencje.zuzycie (
  klucz_id   bigint NOT NULL REFERENCES licencje.klucz_api(id),
  -- Pierwszy dzien miesiaca rozliczeniowego.
  okres      date   NOT NULL,

  -- Dwie rozne wielkosci i obie sa potrzebne:
  --   zapytan   - liczba zadan HTTP, do diagnostyki i do limitow ochronnych
  --   jednostek - podstawa KWOTY; /v1/batch liczy tyle, ile pozycji we wsadzie
  --
  -- Rozroznienia nie da sie dolozyc pozniej bez zmiany umow: wsad przyjmuje
  -- do 1000 pozycji, wiec klient rozliczany w zadaniach obchodzi kwote,
  -- pakujac tysiac adresow w jedno zapytanie.
  zapytan    bigint NOT NULL DEFAULT 0,
  jednostek  bigint NOT NULL DEFAULT 0,
  zmieniony  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (klucz_id, okres)
);

-- ---------------------------------------------------------------------
--  Znacznik zmiany i kanal powiadomien
-- ---------------------------------------------------------------------
--
-- SET search_path jest OBOWIAZKOWE - patrz komentarz w 001_init.sql.
-- Funkcja bierze search_path z sesji WOLAJACEGO, wiec bez tego dziala
-- z psql (ktory ustawil sciezke), a wywala sie z puli aplikacji. Tutaj
-- skutek jest szczegolny i grozny: uniewaznienie klucza po wycieku
-- wycofuje transakcje i CICHO nie dziala.

CREATE OR REPLACE FUNCTION licencje.znacznik_zmiany() RETURNS trigger
LANGUAGE plpgsql
SET search_path = licencje, public
AS $$
BEGIN
  NEW.zmieniony := now();
  RETURN NEW;
END;
$$;

-- Powiadomienie o zmianie klucza. Payload to hex skrotu - NIGDY klucz jawny,
-- ktorego baza zreszta nie zna.
CREATE OR REPLACE FUNCTION licencje.powiadom_o_kluczu() RETURNS trigger
LANGUAGE plpgsql
SET search_path = licencje, public
AS $$
BEGIN
  -- Wyzwalacz jest AFTER INSERT OR UPDATE (nie kasujemy rekordow), wiec NEW
  -- jest zawsze ustawione.
  PERFORM pg_notify('licencje_zmiana', 'klucz:' || encode(NEW.hash, 'hex'));
  RETURN NULL;
END;
$$;

-- Powiadomienie o zmianie KLIENTA - osobna funkcja, bo tabela klient nie ma
-- kolumny hash.
--
-- Bez tego wyzwalacza zawieszenie klienta i obnizenie jego limitu nigdy nie
-- docieraja do repliki w procesie: instancja odswieza sie po zmianach
-- w kluczach, a wiersz klucza pozostaje nietkniety. Klient zawieszony
-- pracowalby dalej do najblizszego restartu poda.
CREATE OR REPLACE FUNCTION licencje.powiadom_o_kliencie() RETURNS trigger
LANGUAGE plpgsql
SET search_path = licencje, public
AS $$
BEGIN
  PERFORM pg_notify('licencje_zmiana', 'klient:' || NEW.id::text);
  RETURN NULL;
END;
$$;

-- CREATE OR REPLACE TRIGGER (PG 14+) zamiast DROP + CREATE: idempotentne
-- i bez okna, w ktorym wyzwalacza nie ma.
CREATE OR REPLACE TRIGGER tg_klient_znacznik
  BEFORE UPDATE ON licencje.klient
  FOR EACH ROW EXECUTE FUNCTION licencje.znacznik_zmiany();

CREATE OR REPLACE TRIGGER tg_klucz_znacznik
  BEFORE UPDATE ON licencje.klucz_api
  FOR EACH ROW EXECUTE FUNCTION licencje.znacznik_zmiany();

CREATE OR REPLACE TRIGGER tg_zuzycie_znacznik
  BEFORE UPDATE ON licencje.zuzycie
  FOR EACH ROW EXECUTE FUNCTION licencje.znacznik_zmiany();

CREATE OR REPLACE TRIGGER tg_klucz_powiadom
  AFTER INSERT OR UPDATE ON licencje.klucz_api
  FOR EACH ROW EXECUTE FUNCTION licencje.powiadom_o_kluczu();

CREATE OR REPLACE TRIGGER tg_klient_powiadom
  AFTER INSERT OR UPDATE ON licencje.klient
  FOR EACH ROW EXECUTE FUNCTION licencje.powiadom_o_kliencie();

-- ---------------------------------------------------------------------
--  Dopiski dla baz zalozonych wczesniejsza wersja tego pliku
-- ---------------------------------------------------------------------
--
-- CREATE TABLE IF NOT EXISTS NIE aktualizuje istniejacej tabeli o innym
-- ksztalcie - konczy sie milczaco sukcesem. Kazda kolumna dodana w przyszlosci
-- musi trafic TAKZE tutaj, inaczej bazy zalozone wczesniej zostana w tyle,
-- a plik nadal bedzie sie konczyl kodem 0.
ALTER TABLE licencje.klient    ADD COLUMN IF NOT EXISTS zawieszony_od timestamptz;
ALTER TABLE licencje.klucz_api ADD COLUMN IF NOT EXISTS zastepuje_id bigint;
ALTER TABLE licencje.zuzycie   ADD COLUMN IF NOT EXISTS jednostek bigint NOT NULL DEFAULT 0;

COMMENT ON SCHEMA licencje IS
  'Klienci API, klucze i zuzycie. Odseparowany od schematu adres celowo: '
  'e2e.sh robi TRUNCATE adres.* CASCADE, wiec kaskada z tamtej strony '
  'kasowalaby poswiadczenia klientow. Zero kluczy obcych miedzy schematami.';

COMMENT ON COLUMN licencje.klucz_api.hash IS
  'HMAC-SHA256 klucza jawnego z pieprzem trzymanym poza baza. Klucza jawnego '
  'nie da sie odtworzyc z tej wartosci ani z calego zrzutu bazy.';

COMMENT ON COLUMN licencje.klucz_api.pieprz_wersja IS
  'Ksiegowosc rotacji pieprza, nie jej mechanizm. Przeliczenie skrotu na nowy '
  'pieprz wymagaloby klucza jawnego, ktorego nie mamy - rotacja pieprza to '
  'zawsze wymiana kluczy.';
