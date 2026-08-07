-- =====================================================================
--  adres-pl - schemat bazy adresowej
--  PostgreSQL 16+ / PostGIS 3.4+
-- =====================================================================
--
--  ZASADY:
--   1. Kotwica adresu to MIEJSCOWOSC (SIMC), nie kod pocztowy.
--      PNA nie mapuje sie 1:1 na gmine ani miejscowosc.
--   2. NIGDY nie kasujemy rekordow - `wycofany_od` zamiast DELETE.
--      Gminy popelniaja bledy i je cofaja; punkt moze wrocic za miesiac.
--   3. Proweniencja per rekord (`zrodlo`, `zrodlo_wersja`) jest obowiazkowa.
--      Bez niej debug konfliktow PRG vs iMPA jest niemozliwy.
--   4. Dane na licencji ODbL (OSM, czesc Overture) NIE MOGA trafic do tych
--      tabel. Zyja w schemacie `qa_osm` i sluza wylacznie do wykrywania luk.
--      Zmieszanie ich tutaj oznacza ryzyko share-alike dla calej bazy.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- tylko do walidacji wsadowej
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE SCHEMA IF NOT EXISTS adres;
-- Odseparowany schemat na dane ODbL. Patrz zasada 4.
CREATE SCHEMA IF NOT EXISTS qa_osm;

SET search_path = adres, public;

-- ---------------------------------------------------------------------
--  Slowniki / wymiar administracyjny (TERYT)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS teryt_jednostka (
  terc          char(7)  PRIMARY KEY,
  nazwa         text     NOT NULL,
  -- 1 = wojewodztwo, 2 = powiat, 3 = gmina
  poziom        smallint NOT NULL CHECK (poziom BETWEEN 1 AND 3),
  rodzaj_gminy  smallint,
  parent_terc   char(7)  REFERENCES teryt_jednostka(terc),
  stan_na       date     NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_teryt_parent ON teryt_jednostka(parent_terc);

CREATE TABLE IF NOT EXISTS wmrodz (
  kod    smallint PRIMARY KEY,
  nazwa  text NOT NULL
);

-- ---------------------------------------------------------------------
--  Miejscowosci (SIMC + PRG)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS miejscowosc (
  simc          char(7) PRIMARY KEY,
  nazwa         text    NOT NULL,
  -- lower + bez diakrytykow; klucz wyszukiwania, NIE do wyswietlania
  nazwa_norm    text    NOT NULL,
  rodzaj        smallint REFERENCES wmrodz(kod),
  terc_gminy    char(7)  NOT NULL REFERENCES teryt_jednostka(terc),
  -- SIMC miejscowosci nadrzednej dla czesci miejscowosci
  simc_nadrzedna char(7),
  identyfikator_prng text,

  -- Czy w tej miejscowosci istnieja JAKIEKOLWIEK ulice.
  -- Steruje pokazaniem/ukryciem pola ulicy w UI. Bez tego uzytkownik ze wsi
  -- wpatruje sie w puste, wymagane pole "ulica".
  -- Wyliczane w kroku refresh_derived().
  ma_ulice      boolean NOT NULL DEFAULT false,
  liczba_punktow integer NOT NULL DEFAULT 0,

  centroid      geography(Point, 4326),

  zrodlo        text NOT NULL,
  zrodlo_wersja text NOT NULL,
  prg_local_id  text,
  pobrano       timestamptz NOT NULL DEFAULT now(),
  wycofany_od   timestamptz
);
CREATE INDEX IF NOT EXISTS ix_miejsc_norm    ON miejscowosc(nazwa_norm) WHERE wycofany_od IS NULL;
CREATE INDEX IF NOT EXISTS ix_miejsc_terc    ON miejscowosc(terc_gminy);
CREATE INDEX IF NOT EXISTS ix_miejsc_geo     ON miejscowosc USING gist(centroid);
-- do walidacji wsadowej (nie do typeahead - patrz raport, pomiar 4,9 s)
CREATE INDEX IF NOT EXISTS ix_miejsc_trgm    ON miejscowosc USING gin(nazwa_norm gin_trgm_ops);

-- ---------------------------------------------------------------------
--  Ulice (ULIC + PRG)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ulica (
  ulic_id       bigserial PRIMARY KEY,
  simc          char(7) NOT NULL REFERENCES miejscowosc(simc),
  -- SYM_UL z TERYT; NULL dla ulic obecnych tylko w PRG
  sym_ul        char(5),
  cecha         text,
  nazwa         text NOT NULL,
  nazwa_norm    text NOT NULL,
  -- forma potoczna: "Kosciuszki" dla "Tadeusza Kosciuszki"
  nazwa_skroc      text,
  nazwa_skroc_norm text,
  -- TERYTNazwa1 / TERYTNazwa2 (2021) = nazwaGlownaCzesc / nazwaCzesc (2012)
  nazwa_1       text,
  nazwa_2       text,

  liczba_punktow integer NOT NULL DEFAULT 0,

  zrodlo        text NOT NULL,
  zrodlo_wersja text NOT NULL,
  prg_local_id  text,
  pobrano       timestamptz NOT NULL DEFAULT now(),
  wycofany_od   timestamptz,

  UNIQUE (simc, nazwa_norm, cecha)
);
CREATE INDEX IF NOT EXISTS ix_ulica_simc      ON ulica(simc) WHERE wycofany_od IS NULL;
CREATE INDEX IF NOT EXISTS ix_ulica_norm      ON ulica(nazwa_norm);
CREATE INDEX IF NOT EXISTS ix_ulica_skroc     ON ulica(nazwa_skroc_norm) WHERE nazwa_skroc_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_ulica_symul     ON ulica(sym_ul) WHERE sym_ul IS NOT NULL;

-- ---------------------------------------------------------------------
--  Punkty adresowe
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS punkt_adresowy (
  id            bigserial PRIMARY KEY,
  -- lokalnyId z PRG. Trwaly klucz miedzy kolejnymi zrzutami - bez niego
  -- kazda aktualizacja to zgadywanka, ktory rekord jest ktorym.
  prg_local_id  text UNIQUE,
  wersja_id     text,
  poczatek_wersji timestamptz,

  simc          char(7) NOT NULL REFERENCES miejscowosc(simc),
  -- NULL dla miejscowosci bez ulic - numer odnosi sie do miejscowosci
  ulic_id       bigint  REFERENCES ulica(ulic_id),

  nr_budynku    text NOT NULL,
  -- klucz porownawczy: 12a = 12 A = 12A
  nr_key        text NOT NULL,
  -- klucz sortowania naturalnego: 2 przed 10, 10A po 10
  nr_sort       text NOT NULL,

  kod_pocztowy  char(6),

  -- UWAGA: PRG przestaje publikowac `status` wraz ze zmiana struktury
  -- 1.09.2026. Ta kolumna przechowuje ZAMROZONY SNAPSHOT sprzed tej daty.
  -- Nowe rekordy beda mialy NULL. Nie buduj na tym twardej logiki blokujacej.
  status            text,
  status_zrodlo_data date,

  geom          geography(Point, 4326),

  zrodlo        text NOT NULL,
  zrodlo_wersja text NOT NULL,
  pobrano       timestamptz NOT NULL DEFAULT now(),
  -- soft delete: punkt znikniety z PRG moze wrocic
  wycofany_od   timestamptz,

  -- hash atrybutow merytorycznych do wykrywania zmian bez porownywania geometrii
  tresc_hash    bytea NOT NULL
);

-- 0,22 ms na 8,5 mln (zmierzone) - to jest sciezka "numery na wybranej ulicy"
CREATE INDEX IF NOT EXISTS ix_pa_ulica_nr   ON punkt_adresowy(ulic_id, nr_sort) WHERE wycofany_od IS NULL;
-- miejscowosci bez ulic
CREATE INDEX IF NOT EXISTS ix_pa_simc_nr    ON punkt_adresowy(simc, nr_sort)
  WHERE ulic_id IS NULL AND wycofany_od IS NULL;
CREATE INDEX IF NOT EXISTS ix_pa_geo        ON punkt_adresowy USING gist(geom);
CREATE INDEX IF NOT EXISTS ix_pa_kod        ON punkt_adresowy(kod_pocztowy) WHERE kod_pocztowy IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_pa_hash       ON punkt_adresowy(tresc_hash);

-- ---------------------------------------------------------------------
--  Wersjonowanie zrzutow i audyt ETL
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS zrzut (
  id            bigserial PRIMARY KEY,
  zrodlo        text NOT NULL,           -- 'prg' | 'impa' | 'teryt' | 'krakow'
  wersja        text NOT NULL,           -- data + hash pliku
  wojewodztwo   char(2),
  url           text,
  bajtow        bigint,
  etag          text,
  last_modified timestamptz,
  sha256        bytea,
  pobrano       timestamptz NOT NULL DEFAULT now(),
  -- struktura pliku: 'prg-2012' | 'emuia-2021'
  profil        text,
  namespace_uri text,
  statystyki    jsonb,
  status        text NOT NULL DEFAULT 'pobrany',
  UNIQUE (zrodlo, wersja, wojewodztwo)
);

CREATE TABLE IF NOT EXISTS etl_run (
  id            bigserial PRIMARY KEY,
  rozpoczety    timestamptz NOT NULL DEFAULT now(),
  zakonczony    timestamptz,
  status        text NOT NULL DEFAULT 'running',  -- running|ok|wstrzymany|blad
  -- powod wstrzymania, gdy sanity check nie przeszedl
  powod         text,
  delta         jsonb,
  artefakt_wersja text
);

-- ---------------------------------------------------------------------
--  Widok pelnego adresu - do walidacji wsadowej i eksportu
-- ---------------------------------------------------------------------

CREATE OR REPLACE VIEW adres_pelny AS
SELECT
  p.id,
  p.prg_local_id,
  m.simc,
  m.nazwa            AS miejscowosc,
  u.ulic_id,
  u.sym_ul,
  u.cecha,
  u.nazwa            AS ulica,
  p.nr_budynku,
  p.kod_pocztowy,
  m.terc_gminy,
  g.nazwa            AS gmina,
  pw.nazwa           AS powiat,
  w.nazwa            AS wojewodztwo,
  m.ma_ulice,
  p.status,
  ST_Y(p.geom::geometry) AS lat,
  ST_X(p.geom::geometry) AS lon,
  p.zrodlo,
  p.zrodlo_wersja
FROM punkt_adresowy p
JOIN miejscowosc m       ON m.simc = p.simc
LEFT JOIN ulica u        ON u.ulic_id = p.ulic_id
JOIN teryt_jednostka g   ON g.terc = m.terc_gminy
LEFT JOIN teryt_jednostka pw ON pw.terc = g.parent_terc
LEFT JOIN teryt_jednostka w  ON w.terc = pw.parent_terc
WHERE p.wycofany_od IS NULL;

-- ---------------------------------------------------------------------
--  Przeliczenie pol pochodnych
-- ---------------------------------------------------------------------

-- UWAGA: `SET search_path` na funkcji jest OBOWIAZKOWE.
-- Funkcja NIE dziedziczy search_path z momentu utworzenia - bierze go
-- z sesji wolajacego. Bez tego dzialalo z psql (ktory wykonal SET na
-- poczatku pliku), a wywalalo sie z poola aplikacji na "relation does
-- not exist". Przy okazji to hardening: przypiety search_path chroni
-- przed podmiana obiektow przez schemat wstrzyniety do sciezki.
CREATE OR REPLACE FUNCTION adres.refresh_derived() RETURNS void
LANGUAGE plpgsql
SET search_path = adres, public
AS $$
BEGIN
  UPDATE adres.ulica u SET liczba_punktow = c.n
  FROM (SELECT ulic_id, count(*) n FROM adres.punkt_adresowy
        WHERE wycofany_od IS NULL AND ulic_id IS NOT NULL GROUP BY ulic_id) c
  WHERE u.ulic_id = c.ulic_id;

  UPDATE adres.miejscowosc m SET liczba_punktow = c.n
  FROM (SELECT simc, count(*) n FROM adres.punkt_adresowy
        WHERE wycofany_od IS NULL GROUP BY simc) c
  WHERE m.simc = c.simc;

  -- ma_ulice: kluczowe dla UI - steruje pokazaniem pola ulicy
  UPDATE adres.miejscowosc m SET ma_ulice = EXISTS (
    SELECT 1 FROM adres.ulica u WHERE u.simc = m.simc AND u.wycofany_od IS NULL
  );
END;
$$;

-- ---------------------------------------------------------------------
--  Schemat QA - dane ODbL, ODSEPAROWANE
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS qa_osm.punkt_osm (
  id           bigserial PRIMARY KEY,
  osm_type     char(1) NOT NULL,
  osm_id       bigint  NOT NULL,
  city         text,
  street       text,
  housenumber  text,
  postcode     text,
  geom         geography(Point, 4326),
  pobrano      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_qa_geo ON qa_osm.punkt_osm USING gist(geom);

COMMENT ON SCHEMA qa_osm IS
  'Dane OpenStreetMap na licencji ODbL (share-alike). WYLACZNIE do wykrywania '
  'luk w PRG i raportow jakosci. Zadne rekordy z tego schematu nie moga byc '
  'kopiowane do schematu adres ani redystrybuowane w produkcie.';
