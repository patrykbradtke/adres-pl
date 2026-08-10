-- =====================================================================
--  adres-pl - przejscie schematu bazy na angielskie nazewnictwo
-- =====================================================================
--
--  DLACZEGO OSOBNA MIGRACJA, A NIE POPRAWKA W 001-004:
--  Pliki 001-004 sa zapisem historii i na wdrozonej bazie juz przeszly.
--  Ich edycja rozjechalaby instalacje istniejaca z nowa. Ten plik dokłada
--  krok: baza zalozona od zera przechodzi 001 -> 005 i konczy z nazwami
--  angielskimi, baza dzialajaca dostaje sam krok 005.
--
--  DLACZEGO RENAME, A NIE CREATE + COPY:
--  W tabelach lezy 8,6 mln punktow adresowych (12 GB). ALTER ... RENAME
--  zmienia wylacznie katalog systemowy - nie dotyka ani jednej krotki,
--  nie przebudowuje indeksow i konczy sie w milisekundach. Przepisanie
--  danych oznaczaloby kilkugodzinne okno i drugie tyle miejsca na dysku.
--
--  CO WYMAGA ODTWORZENIA, A NIE PRZEMIANOWANIA:
--  Ciala funkcji i widokow Postgres trzyma jako TEKST i rozwiazuje nazwy
--  dopiero przy wywolaniu. Samo przemianowanie tabel zostawiloby funkcje
--  wskazujace na nieistniejace obiekty - dlatego wszystkie funkcje,
--  wyzwalacze i widok sa nizej tworzone od nowa.
--
--  ZMIANA KONTRAKTU POZA BAZA: kanal NOTIFY zmienia nazwe z
--  `licencje_zmiana` na `licensing_change`, a prefiksy ladunku z
--  `klucz:`/`klient:` na `key:`/`client:`. Nasluch w
--  packages/api/src/keys/notify-listener.ts musi wejsc razem z ta migracja.
--
--  WGRYWANIE - RECZNE, DOKLADNIE RAZ:
--    psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f db/migrations/005_nazewnictwo_en.sql
--
--  Plik jest IDEMPOTENTNY: kazde przemianowanie sprawdza, czy zrodlo
--  jeszcze istnieje, a cel jeszcze nie. Ponowne wgranie nic nie zmienia.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
--  Pomocniki. Zyja w pg_temp, wiec znikaja z koncem sesji.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pg_temp.rename_column(
  p_schema text, p_table text, p_old text, p_new text
) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = p_schema AND table_name = p_table
                AND column_name = p_old)
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = p_schema AND table_name = p_table
                AND column_name = p_new)
  THEN
    EXECUTE format('ALTER TABLE %I.%I RENAME COLUMN %I TO %I',
                   p_schema, p_table, p_old, p_new);
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.rename_table(
  p_schema text, p_old text, p_new text
) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = p_schema AND c.relname = p_old AND c.relkind IN ('r','v','m'))
     AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = p_schema AND c.relname = p_new)
  THEN
    EXECUTE format('ALTER TABLE %I.%I RENAME TO %I', p_schema, p_old, p_new);
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.rename_index(
  p_schema text, p_old text, p_new text
) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = p_schema AND c.relname = p_old AND c.relkind = 'i')
     AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = p_schema AND c.relname = p_new)
  THEN
    EXECUTE format('ALTER INDEX %I.%I RENAME TO %I', p_schema, p_old, p_new);
  END IF;
END;
$fn$;

-- ---------------------------------------------------------------------
--  1. Widok i funkcje znikaja PRZED przemianowaniem.
--     Widok trzyma wlasne aliasy kolumn, funkcje - tekst cial.
-- ---------------------------------------------------------------------

DROP VIEW IF EXISTS adres.adres_pelny;
DROP VIEW IF EXISTS address.full_address;

DROP FUNCTION IF EXISTS adres.publikuj_zrzut(text, text, char(2)[]);
DROP FUNCTION IF EXISTS adres.refresh_derived();
DROP FUNCTION IF EXISTS staging.resolve_refs();
DROP FUNCTION IF EXISTS staging.wyczysc();
DROP FUNCTION IF EXISTS staging.przed_ladowaniem();
DROP FUNCTION IF EXISTS staging.po_ladowaniu();

-- ---------------------------------------------------------------------
--  2. Kolumny - schemat adresowy
-- ---------------------------------------------------------------------

SELECT pg_temp.rename_column('adres', 'teryt_jednostka', 'nazwa',        'name');
SELECT pg_temp.rename_column('adres', 'teryt_jednostka', 'poziom',       'level');
SELECT pg_temp.rename_column('adres', 'teryt_jednostka', 'rodzaj_gminy', 'gmina_kind');
SELECT pg_temp.rename_column('adres', 'teryt_jednostka', 'stan_na',      'as_of');

SELECT pg_temp.rename_column('adres', 'wmrodz', 'kod',   'code');
SELECT pg_temp.rename_column('adres', 'wmrodz', 'nazwa', 'name');

SELECT pg_temp.rename_column('adres', 'miejscowosc', 'nazwa',              'name');
SELECT pg_temp.rename_column('adres', 'miejscowosc', 'nazwa_norm',         'name_norm');
SELECT pg_temp.rename_column('adres', 'miejscowosc', 'rodzaj',             'kind');
SELECT pg_temp.rename_column('adres', 'miejscowosc', 'terc_gminy',         'gmina_terc');
SELECT pg_temp.rename_column('adres', 'miejscowosc', 'simc_nadrzedna',     'parent_simc');
SELECT pg_temp.rename_column('adres', 'miejscowosc', 'identyfikator_prng', 'prng_id');
SELECT pg_temp.rename_column('adres', 'miejscowosc', 'ma_ulice',           'has_streets');
SELECT pg_temp.rename_column('adres', 'miejscowosc', 'liczba_punktow',     'point_count');
SELECT pg_temp.rename_column('adres', 'miejscowosc', 'zrodlo',             'source');
SELECT pg_temp.rename_column('adres', 'miejscowosc', 'zrodlo_wersja',      'source_version');
SELECT pg_temp.rename_column('adres', 'miejscowosc', 'pobrano',            'fetched_at');
SELECT pg_temp.rename_column('adres', 'miejscowosc', 'wycofany_od',        'withdrawn_at');

SELECT pg_temp.rename_column('adres', 'ulica', 'cecha',            'street_type');
SELECT pg_temp.rename_column('adres', 'ulica', 'nazwa',            'name');
SELECT pg_temp.rename_column('adres', 'ulica', 'nazwa_norm',       'name_norm');
SELECT pg_temp.rename_column('adres', 'ulica', 'nazwa_skroc',      'short_name');
SELECT pg_temp.rename_column('adres', 'ulica', 'nazwa_skroc_norm', 'short_name_norm');
SELECT pg_temp.rename_column('adres', 'ulica', 'nazwa_1',          'name_1');
SELECT pg_temp.rename_column('adres', 'ulica', 'nazwa_2',          'name_2');
SELECT pg_temp.rename_column('adres', 'ulica', 'liczba_punktow',   'point_count');
SELECT pg_temp.rename_column('adres', 'ulica', 'zrodlo',           'source');
SELECT pg_temp.rename_column('adres', 'ulica', 'zrodlo_wersja',    'source_version');
SELECT pg_temp.rename_column('adres', 'ulica', 'pobrano',          'fetched_at');
SELECT pg_temp.rename_column('adres', 'ulica', 'wycofany_od',      'withdrawn_at');

SELECT pg_temp.rename_column('adres', 'punkt_adresowy', 'wersja_id',          'version_id');
SELECT pg_temp.rename_column('adres', 'punkt_adresowy', 'poczatek_wersji',    'version_start');
SELECT pg_temp.rename_column('adres', 'punkt_adresowy', 'nr_budynku',         'building_number');
SELECT pg_temp.rename_column('adres', 'punkt_adresowy', 'nr_key',             'building_number_key');
SELECT pg_temp.rename_column('adres', 'punkt_adresowy', 'nr_sort',            'building_number_sort');
SELECT pg_temp.rename_column('adres', 'punkt_adresowy', 'kod_pocztowy',       'postal_code');
SELECT pg_temp.rename_column('adres', 'punkt_adresowy', 'status_zrodlo_data', 'status_source_date');
SELECT pg_temp.rename_column('adres', 'punkt_adresowy', 'zrodlo',             'source');
SELECT pg_temp.rename_column('adres', 'punkt_adresowy', 'zrodlo_wersja',      'source_version');
SELECT pg_temp.rename_column('adres', 'punkt_adresowy', 'pobrano',            'fetched_at');
SELECT pg_temp.rename_column('adres', 'punkt_adresowy', 'wycofany_od',        'withdrawn_at');
SELECT pg_temp.rename_column('adres', 'punkt_adresowy', 'tresc_hash',         'content_hash');

SELECT pg_temp.rename_column('adres', 'zrzut', 'zrodlo',      'source');
SELECT pg_temp.rename_column('adres', 'zrzut', 'wersja',      'version');
SELECT pg_temp.rename_column('adres', 'zrzut', 'wojewodztwo', 'voivodeship');
SELECT pg_temp.rename_column('adres', 'zrzut', 'bajtow',      'bytes');
SELECT pg_temp.rename_column('adres', 'zrzut', 'pobrano',     'fetched_at');
SELECT pg_temp.rename_column('adres', 'zrzut', 'profil',      'profile');
SELECT pg_temp.rename_column('adres', 'zrzut', 'statystyki',  'stats');

SELECT pg_temp.rename_column('adres', 'etl_run', 'rozpoczety',      'started_at');
SELECT pg_temp.rename_column('adres', 'etl_run', 'zakonczony',      'finished_at');
SELECT pg_temp.rename_column('adres', 'etl_run', 'powod',           'reason');
SELECT pg_temp.rename_column('adres', 'etl_run', 'artefakt_wersja', 'artifact_version');

SELECT pg_temp.rename_column('qa_osm', 'punkt_osm', 'pobrano', 'fetched_at');

-- ---------------------------------------------------------------------
--  3. Kolumny - obszar przejsciowy
-- ---------------------------------------------------------------------

SELECT pg_temp.rename_column('staging', 'punkt_adresowy', 'wersja_id',       'version_id');
SELECT pg_temp.rename_column('staging', 'punkt_adresowy', 'poczatek_wersji', 'version_start');
SELECT pg_temp.rename_column('staging', 'punkt_adresowy', 'nr_budynku',      'building_number');
SELECT pg_temp.rename_column('staging', 'punkt_adresowy', 'nr_key',          'building_number_key');
SELECT pg_temp.rename_column('staging', 'punkt_adresowy', 'nr_sort',         'building_number_sort');
SELECT pg_temp.rename_column('staging', 'punkt_adresowy', 'kod_pocztowy',    'postal_code');
SELECT pg_temp.rename_column('staging', 'punkt_adresowy', 'zrodlo',          'source');
SELECT pg_temp.rename_column('staging', 'punkt_adresowy', 'zrodlo_wersja',   'source_version');
SELECT pg_temp.rename_column('staging', 'punkt_adresowy', 'tresc_hash',      'content_hash');
SELECT pg_temp.rename_column('staging', 'punkt_adresowy', 'wojewodztwo',     'voivodeship');

SELECT pg_temp.rename_column('staging', 'miejscowosc', 'nazwa',              'name');
SELECT pg_temp.rename_column('staging', 'miejscowosc', 'nazwa_norm',         'name_norm');
SELECT pg_temp.rename_column('staging', 'miejscowosc', 'rodzaj',             'kind');
SELECT pg_temp.rename_column('staging', 'miejscowosc', 'rodzaj_raw',         'kind_raw');
SELECT pg_temp.rename_column('staging', 'miejscowosc', 'terc_gminy',         'gmina_terc');
SELECT pg_temp.rename_column('staging', 'miejscowosc', 'identyfikator_prng', 'prng_id');
SELECT pg_temp.rename_column('staging', 'miejscowosc', 'zrodlo',             'source');
SELECT pg_temp.rename_column('staging', 'miejscowosc', 'zrodlo_wersja',      'source_version');

SELECT pg_temp.rename_column('staging', 'ulica', 'cecha',            'street_type');
SELECT pg_temp.rename_column('staging', 'ulica', 'nazwa',            'name');
SELECT pg_temp.rename_column('staging', 'ulica', 'nazwa_norm',       'name_norm');
SELECT pg_temp.rename_column('staging', 'ulica', 'nazwa_skroc',      'short_name');
SELECT pg_temp.rename_column('staging', 'ulica', 'nazwa_skroc_norm', 'short_name_norm');
SELECT pg_temp.rename_column('staging', 'ulica', 'nazwa_1',          'name_1');
SELECT pg_temp.rename_column('staging', 'ulica', 'nazwa_2',          'name_2');
SELECT pg_temp.rename_column('staging', 'ulica', 'zrodlo',           'source');
SELECT pg_temp.rename_column('staging', 'ulica', 'zrodlo_wersja',    'source_version');

-- ---------------------------------------------------------------------
--  4. Kolumny - licencje
-- ---------------------------------------------------------------------

SELECT pg_temp.rename_column('licencje', 'klient', 'nazwa',             'name');
SELECT pg_temp.rename_column('licencje', 'klient', 'email_kontakt',     'contact_email');
SELECT pg_temp.rename_column('licencje', 'klient', 'pakiet',            'plan');
SELECT pg_temp.rename_column('licencje', 'klient', 'limit_zapytan_min', 'rate_limit_per_min');
SELECT pg_temp.rename_column('licencje', 'klient', 'kwota_miesieczna',  'monthly_quota');
SELECT pg_temp.rename_column('licencje', 'klient', 'licencja',          'license');
SELECT pg_temp.rename_column('licencje', 'klient', 'licencja_od',       'license_from');
SELECT pg_temp.rename_column('licencje', 'klient', 'licencja_do',       'license_to');
SELECT pg_temp.rename_column('licencje', 'klient', 'zawieszony_od',     'suspended_at');
SELECT pg_temp.rename_column('licencje', 'klient', 'uwagi',             'notes');
SELECT pg_temp.rename_column('licencje', 'klient', 'utworzony',         'created_at');
SELECT pg_temp.rename_column('licencje', 'klient', 'utworzony_przez',   'created_by');
SELECT pg_temp.rename_column('licencje', 'klient', 'zmieniony',         'updated_at');

SELECT pg_temp.rename_column('licencje', 'klucz_api', 'klient_id',           'client_id');
SELECT pg_temp.rename_column('licencje', 'klucz_api', 'srodowisko',          'environment');
SELECT pg_temp.rename_column('licencje', 'klucz_api', 'prefiks',             'prefix');
SELECT pg_temp.rename_column('licencje', 'klucz_api', 'pieprz_wersja',       'pepper_version');
SELECT pg_temp.rename_column('licencje', 'klucz_api', 'nazwa',               'name');
SELECT pg_temp.rename_column('licencje', 'klucz_api', 'wazny_od',            'valid_from');
SELECT pg_temp.rename_column('licencje', 'klucz_api', 'wazny_do',            'valid_to');
SELECT pg_temp.rename_column('licencje', 'klucz_api', 'uniewazniony_od',     'revoked_at');
SELECT pg_temp.rename_column('licencje', 'klucz_api', 'powod_uniewaznienia', 'revocation_reason');
SELECT pg_temp.rename_column('licencje', 'klucz_api', 'zastepuje_id',        'replaces_id');
SELECT pg_temp.rename_column('licencje', 'klucz_api', 'limit_zapytan_min',   'rate_limit_per_min');
SELECT pg_temp.rename_column('licencje', 'klucz_api', 'utworzony',           'created_at');
SELECT pg_temp.rename_column('licencje', 'klucz_api', 'utworzony_przez',     'created_by');
SELECT pg_temp.rename_column('licencje', 'klucz_api', 'zmieniony',           'updated_at');

SELECT pg_temp.rename_column('licencje', 'zuzycie', 'klucz_id',  'api_key_id');
SELECT pg_temp.rename_column('licencje', 'zuzycie', 'okres',     'period');
SELECT pg_temp.rename_column('licencje', 'zuzycie', 'zapytan',   'requests');
SELECT pg_temp.rename_column('licencje', 'zuzycie', 'jednostek', 'units');
SELECT pg_temp.rename_column('licencje', 'zuzycie', 'zmieniony', 'updated_at');

-- ---------------------------------------------------------------------
--  5. Indeksy i ograniczenia
-- ---------------------------------------------------------------------

SELECT pg_temp.rename_index('adres', 'ix_miejsc_norm', 'ix_locality_name_norm');
SELECT pg_temp.rename_index('adres', 'ix_miejsc_terc', 'ix_locality_gmina_terc');
SELECT pg_temp.rename_index('adres', 'ix_miejsc_geo',  'ix_locality_geo');
SELECT pg_temp.rename_index('adres', 'ix_miejsc_trgm', 'ix_locality_trgm');

SELECT pg_temp.rename_index('adres', 'ix_ulica_simc',  'ix_street_simc');
SELECT pg_temp.rename_index('adres', 'ix_ulica_norm',  'ix_street_name_norm');
SELECT pg_temp.rename_index('adres', 'ix_ulica_skroc', 'ix_street_short_name');
SELECT pg_temp.rename_index('adres', 'ix_ulica_symul', 'ix_street_sym_ul');
SELECT pg_temp.rename_index('adres', 'ulica_simc_symul_key',          'street_simc_sym_ul_key');
SELECT pg_temp.rename_index('adres', 'ulica_simc_nazwa_bez_symul_key', 'street_simc_name_no_sym_ul_key');

SELECT pg_temp.rename_index('adres', 'ix_pa_ulica_nr', 'ix_ap_street_number');
SELECT pg_temp.rename_index('adres', 'ix_pa_simc_nr',  'ix_ap_simc_number');
SELECT pg_temp.rename_index('adres', 'ix_pa_geo',      'ix_ap_geo');
SELECT pg_temp.rename_index('adres', 'ix_pa_kod',      'ix_ap_postal_code');
SELECT pg_temp.rename_index('adres', 'ix_pa_hash',     'ix_ap_content_hash');
SELECT pg_temp.rename_index('adres', 'ix_pa_ulic_id',  'ix_ap_ulic_id');

SELECT pg_temp.rename_index('staging', 'ix_st_pa_simc', 'ix_st_ap_simc');
SELECT pg_temp.rename_index('staging', 'ix_st_pa_ulic', 'ix_st_ap_ulic');
SELECT pg_temp.rename_index('staging', 'ix_st_pa_hash', 'ix_st_ap_content_hash');
SELECT pg_temp.rename_index('staging', 'ix_st_m_simc',  'ix_st_locality_simc');
SELECT pg_temp.rename_index('staging', 'ix_st_m_gml',   'ix_st_locality_gml');
SELECT pg_temp.rename_index('staging', 'ix_st_u_simc',  'ix_st_street_simc');
SELECT pg_temp.rename_index('staging', 'ix_st_u_gml',   'ix_st_street_gml');
SELECT pg_temp.rename_index('staging', 'ix_st_u_sym',   'ix_st_street_sym_ul');

SELECT pg_temp.rename_index('licencje', 'ux_klucz_hash',   'ux_api_key_hash');
SELECT pg_temp.rename_index('licencje', 'ix_klucz_klient', 'ix_api_key_client');
SELECT pg_temp.rename_index('licencje', 'ix_klucz_wazny',  'ix_api_key_valid_to');
SELECT pg_temp.rename_index('licencje', 'ix_klucz_pieprz', 'ix_api_key_pepper_version');

-- ---------------------------------------------------------------------
--  6. Tabele
-- ---------------------------------------------------------------------

SELECT pg_temp.rename_table('adres', 'teryt_jednostka', 'teryt_unit');
SELECT pg_temp.rename_table('adres', 'miejscowosc',     'locality');
SELECT pg_temp.rename_table('adres', 'ulica',           'street');
SELECT pg_temp.rename_table('adres', 'punkt_adresowy',  'address_point');
SELECT pg_temp.rename_table('adres', 'zrzut',           'snapshot');

SELECT pg_temp.rename_table('staging', 'punkt_adresowy', 'address_point');
SELECT pg_temp.rename_table('staging', 'miejscowosc',    'locality');
SELECT pg_temp.rename_table('staging', 'ulica',          'street');

SELECT pg_temp.rename_table('licencje', 'klient',    'client');
SELECT pg_temp.rename_table('licencje', 'klucz_api', 'api_key');
SELECT pg_temp.rename_table('licencje', 'zuzycie',   'usage');

SELECT pg_temp.rename_table('qa_osm', 'punkt_osm', 'osm_point');

-- ---------------------------------------------------------------------
--  7. Schematy. Na koncu, zeby powyzsze odwolania byly czytelne.
-- ---------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'adres')
     AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'address') THEN
    ALTER SCHEMA adres RENAME TO address;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'licencje')
     AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'licensing') THEN
    ALTER SCHEMA licencje RENAME TO licensing;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------
--  8. Widok pelnego adresu - odtworzony z angielskimi aliasami
-- ---------------------------------------------------------------------

CREATE OR REPLACE VIEW address.full_address AS
SELECT
  p.id,
  p.prg_local_id,
  m.simc,
  m.name             AS locality,
  u.ulic_id,
  u.sym_ul,
  u.street_type,
  u.name             AS street,
  p.building_number,
  p.postal_code,
  m.gmina_terc,
  g.name             AS gmina,
  pw.name            AS powiat,
  w.name             AS voivodeship,
  m.has_streets,
  p.status,
  ST_Y(p.geom::geometry) AS lat,
  ST_X(p.geom::geometry) AS lon,
  p.source,
  p.source_version
FROM address.address_point p
JOIN address.locality m        ON m.simc = p.simc
LEFT JOIN address.street u     ON u.ulic_id = p.ulic_id
JOIN address.teryt_unit g      ON g.terc = m.gmina_terc
LEFT JOIN address.teryt_unit pw ON pw.terc = g.parent_terc
LEFT JOIN address.teryt_unit w  ON w.terc = pw.parent_terc
WHERE p.withdrawn_at IS NULL;

-- ---------------------------------------------------------------------
--  9. Pola pochodne
-- ---------------------------------------------------------------------

-- SET search_path jest OBOWIAZKOWE - funkcja bierze sciezke z sesji
-- wolajacego, wiec bez tego dziala z psql, a wywala sie z puli aplikacji.
CREATE OR REPLACE FUNCTION address.refresh_derived() RETURNS void
LANGUAGE plpgsql
SET search_path = address, public
AS $$
BEGIN
  UPDATE address.street u SET point_count = c.n
  FROM (SELECT ulic_id, count(*) n FROM address.address_point
        WHERE withdrawn_at IS NULL AND ulic_id IS NOT NULL GROUP BY ulic_id) c
  WHERE u.ulic_id = c.ulic_id;

  UPDATE address.locality m SET point_count = c.n
  FROM (SELECT simc, count(*) n FROM address.address_point
        WHERE withdrawn_at IS NULL GROUP BY simc) c
  WHERE m.simc = c.simc;

  -- has_streets: kluczowe dla UI - steruje pokazaniem pola ulicy
  UPDATE address.locality m SET has_streets = EXISTS (
    SELECT 1 FROM address.street u WHERE u.simc = m.simc AND u.withdrawn_at IS NULL
  );
END;
$$;

-- ---------------------------------------------------------------------
--  10. Rozwiazywanie referencji w obszarze przejsciowym
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION staging.resolve_refs() RETURNS void
LANGUAGE plpgsql
SET search_path = staging, address, public
AS $$
BEGIN
  -- NAJPIERW dopasowanie po gml:id, i wtedy SIMC bierzemy WPROST z miejscowosci.
  -- Wyciaganie cyfr z identyfikatora nowej struktury jest bledem: dla
  -- `PL.ZIPIN.692.EMUiA_0145023_2026-07-23T09_31_02_02_00` regexp zbiera cyfry
  -- z numeru ZIPIN, z SIMC ORAZ z daty wersji i sklada z nich ~30-znakowy ciag.
  UPDATE staging.address_point p
     SET simc = m.simc
    FROM staging.locality m
   WHERE m.gml_id = p.simc_ref AND p.simc IS NULL;

  -- Dopiero teraz przypadek struktury 2012, gdzie ref JEST kodem SIMC.
  UPDATE staging.address_point p
     SET simc = lpad(regexp_replace(p.simc_ref, '\D', '', 'g'), 7, '0')
   WHERE p.simc IS NULL
     AND p.simc_ref ~ '^\d{1,7}$';

  UPDATE staging.street u
     SET simc = m.simc
    FROM staging.locality m
   WHERE m.gml_id = u.simc_ref AND u.simc IS NULL;

  UPDATE staging.street u
     SET simc = lpad(regexp_replace(u.simc_ref, '\D', '', 'g'), 7, '0')
   WHERE u.simc IS NULL
     AND u.simc_ref ~ '^\d{1,7}$';

  -- UWAGA: `ulic_id` NIE jest tu ustawiane. Wlasciwe powiazanie powstaje
  -- w publish_snapshot, juz PO wstawieniu ulic do tabeli docelowej - bo
  -- dopiero wtedy istnieja prawdziwe identyfikatory.
END;
$$;

-- ---------------------------------------------------------------------
--  11. Atomowa publikacja zrzutu
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION address.publish_snapshot(
  p_source text,
  p_version text,
  p_voivodeships char(2)[] DEFAULT NULL   -- NULL = caly kraj
) RETURNS TABLE(added bigint, changed bigint, withdrawn bigint, restored bigint)
LANGUAGE plpgsql
SET search_path = address, staging, public
AS $$
DECLARE
  v_added bigint := 0;
  v_changed bigint := 0;
  v_withdrawn bigint := 0;
  v_restored bigint := 0;
BEGIN
  PERFORM staging.resolve_refs();

  -- 1. slowniki: miejscowosci i ulice (upsert, bez kasowania)
  --
  -- DISTINCT ON, bo zrodlo potrafi opisac ta sama miejscowosc wiecej niz raz.
  -- Bez tego ON CONFLICT dostaje ten sam klucz dwukrotnie w jednej instrukcji
  -- i Postgres przerywa calosc bledem "cannot affect row a second time".
  INSERT INTO address.locality AS m (
    simc, name, name_norm, kind, gmina_terc, prng_id,
    centroid, source, source_version, prg_local_id, fetched_at
  )
  SELECT DISTINCT ON (s.simc)
         s.simc, s.name, s.name_norm, s.kind, s.gmina_terc,
         s.prng_id, s.centroid, s.source, s.source_version,
         s.prg_local_id, now()
    FROM staging.locality s
   WHERE s.simc IS NOT NULL AND s.gmina_terc IS NOT NULL
   ORDER BY s.simc, (s.centroid IS NULL), s.prg_local_id
  -- PRECEDENCJA ZRODEL:
  --   nazwa           -> TERYT (rejestr urzedowy nazw)
  --   geometria       -> PRG   (spojny uklad, walidowana)
  --   punkty adresowe -> PRG
  ON CONFLICT (simc) DO UPDATE SET
    name      = CASE WHEN m.source = 'teryt' THEN m.name      ELSE EXCLUDED.name      END,
    name_norm = CASE WHEN m.source = 'teryt' THEN m.name_norm ELSE EXCLUDED.name_norm END,
    kind = COALESCE(m.kind, EXCLUDED.kind),
    centroid = COALESCE(m.centroid, EXCLUDED.centroid),
    source_version = EXCLUDED.source_version,
    fetched_at = now(),
    withdrawn_at = NULL;

  -- Wydzielenie slowa rodzajowego z nazwy do kolumny street_type.
  -- PRG nie wypelnia jej w ogole i dla czesci ulic wstawia typ do samej
  -- nazwy: "ulica Marszalkowska" zamiast "ul." + "Marszalkowska".
  UPDATE staging.street s
     SET street_type = COALESCE(s.street_type, r.skrot),
         name        = regexp_replace(s.name, '^\S+\s+', ''),
         name_norm   = regexp_replace(s.name_norm, '^\S+\s+', '')
    FROM (VALUES ('ulica','ul.'), ('aleja','al.'), ('plac','pl.'),
                 ('osiedle','os.'), ('rondo','rondo'), ('skwer','skwer'),
                 ('bulwar','bulw.'), ('droga','droga'), ('szosa','szosa'))
         AS r(slowo, skrot)
   WHERE lower(split_part(s.name, ' ', 1)) = r.slowo
     AND position(' ' in s.name) > 0;

  -- Katalog ulic: scalanie po SYM_UL, nie po nazwie. Kluczem konfliktu byla
  -- kiedys (simc, name_norm, street_type) - TERYT ustawia 'ul.', PRG zostawia
  -- NULL, wiec ten sam obiekt wchodzil DWA RAZY (53% katalogu).
  INSERT INTO address.street AS u (
    simc, sym_ul, street_type, name, name_norm, short_name, short_name_norm,
    name_1, name_2, source, source_version, prg_local_id, fetched_at
  )
  SELECT DISTINCT ON (s.simc, s.sym_ul)
         s.simc, s.sym_ul, s.street_type, s.name, s.name_norm,
         s.short_name, s.short_name_norm, s.name_1, s.name_2,
         s.source, s.source_version, s.prg_local_id, now()
    FROM staging.street s
   WHERE s.simc IS NOT NULL AND s.sym_ul IS NOT NULL
     AND EXISTS (SELECT 1 FROM address.locality m WHERE m.simc = s.simc)
   ORDER BY s.simc, s.sym_ul, (s.source <> 'teryt'), s.prg_local_id
  ON CONFLICT (simc, sym_ul) WHERE sym_ul IS NOT NULL AND withdrawn_at IS NULL
  DO UPDATE SET
    name            = CASE WHEN EXCLUDED.source = 'teryt' THEN EXCLUDED.name            ELSE u.name            END,
    name_norm       = CASE WHEN EXCLUDED.source = 'teryt' THEN EXCLUDED.name_norm       ELSE u.name_norm       END,
    street_type     = CASE WHEN EXCLUDED.source = 'teryt' THEN EXCLUDED.street_type     ELSE COALESCE(u.street_type, EXCLUDED.street_type) END,
    short_name      = CASE WHEN EXCLUDED.source = 'teryt' THEN EXCLUDED.short_name      ELSE COALESCE(u.short_name, EXCLUDED.short_name) END,
    short_name_norm = CASE WHEN EXCLUDED.source = 'teryt' THEN EXCLUDED.short_name_norm ELSE COALESCE(u.short_name_norm, EXCLUDED.short_name_norm) END,
    name_1 = COALESCE(u.name_1, EXCLUDED.name_1),
    name_2 = COALESCE(u.name_2, EXCLUDED.name_2),
    prg_local_id = COALESCE(u.prg_local_id, EXCLUDED.prg_local_id),
    source_version = EXCLUDED.source_version,
    fetched_at = now(),
    withdrawn_at = NULL;

  -- Ulice bez SYM_UL (ok. 130 w skali kraju) - brak klucza katalogowego,
  -- wiec dla nich zostaje dopasowanie po nazwie.
  INSERT INTO address.street AS u (
    simc, sym_ul, street_type, name, name_norm, short_name, short_name_norm,
    name_1, name_2, source, source_version, prg_local_id, fetched_at
  )
  SELECT DISTINCT ON (s.simc, s.name_norm, s.street_type)
         s.simc, s.sym_ul, s.street_type, s.name, s.name_norm,
         s.short_name, s.short_name_norm, s.name_1, s.name_2,
         s.source, s.source_version, s.prg_local_id, now()
    FROM staging.street s
   WHERE s.simc IS NOT NULL AND s.sym_ul IS NULL
     AND EXISTS (SELECT 1 FROM address.locality m WHERE m.simc = s.simc)
     AND NOT EXISTS (SELECT 1 FROM address.street x
                      WHERE x.simc = s.simc AND x.name_norm = s.name_norm
                        AND x.sym_ul IS NOT NULL AND x.withdrawn_at IS NULL)
   ORDER BY s.simc, s.name_norm, s.street_type, s.prg_local_id
  ON CONFLICT (simc, name_norm, street_type) WHERE sym_ul IS NULL AND withdrawn_at IS NULL
  DO UPDATE SET
    name_1 = COALESCE(u.name_1, EXCLUDED.name_1),
    name_2 = COALESCE(u.name_2, EXCLUDED.name_2),
    source_version = EXCLUDED.source_version,
    fetched_at = now(),
    withdrawn_at = NULL;

  -- Powiazanie punktow z ulicami - dopiero teraz, gdy ulice maja juz
  -- prawdziwe identyfikatory w tabeli docelowej.
  --   2021: ulic_ref to gml:id obiektu w tym samym pliku
  --   2012: ulic_ref to kod SYM_UL z katalogu ULIC
  UPDATE staging.address_point s
     SET ulic_id = u.ulic_id
    FROM staging.street su
    JOIN address.street u
      ON u.simc = su.simc
     AND u.name_norm = su.name_norm
     AND u.street_type IS NOT DISTINCT FROM su.street_type
   WHERE s.ulic_ref IS NOT NULL
     AND su.gml_id = s.ulic_ref;

  -- Druga droga w OSOBNYM zapytaniu, a nie w OR z powyzszym. W OR planner
  -- nie moze uzyc indeksu dla zadnej galezi i schodzi do petli zagniezdzonej:
  -- zmierzone ponad 100 mld porownan, publikacja nie skonczyla sie po 8 h.
  UPDATE staging.address_point s
     SET ulic_id = u.ulic_id
    FROM staging.street su
    JOIN address.street u
      ON u.simc = su.simc
     AND u.name_norm = su.name_norm
     AND u.street_type IS NOT DISTINCT FROM su.street_type
   WHERE s.ulic_id IS NULL
     AND s.ulic_ref IS NOT NULL
     AND su.sym_ul = lpad(regexp_replace(s.ulic_ref, '\D', '', 'g'), 5, '0');

  -- Dopasowanie po samym SYM_UL, gdy ulicy nie bylo w tym pliku,
  -- ale jest juz w bazie z TERYT albo z wczesniejszego zrzutu.
  UPDATE staging.address_point s
     SET ulic_id = u.ulic_id
    FROM address.street u
   WHERE s.ulic_id IS NULL
     AND s.ulic_ref ~ '^[0-9]{1,5}$'
     AND u.simc = s.simc
     AND u.sym_ul = lpad(s.ulic_ref, 5, '0');

  -- ZABEZPIECZENIE: identyfikator, ktory nie istnieje w tabeli docelowej,
  -- musi zostac wyzerowany. Inaczej publikacja przerywa sie na kluczu obcym
  -- i traci CALY zrzut z powodu pojedynczej nierozwiazanej referencji.
  UPDATE staging.address_point s
     SET ulic_id = NULL
   WHERE s.ulic_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM address.street u WHERE u.ulic_id = s.ulic_id);

  -- 2. punkty adresowe: upsert TYLKO tego, co sie zmienilo.
  --
  -- Upsert wszystkich 8,5 mln wierszy trwa ~7 minut i jest tak samo kosztowny
  -- przy nocnej aktualizacji, w ktorej realnie zmienia sie ~0,4% rekordow.
  -- Warunek `withdrawn_at IS NOT NULL` jest istotny: punkt wczesniej wycofany,
  -- ktory wrocil do rejestru bez zmiany tresci, musi zostac przywrocony.
  WITH ins AS (
    INSERT INTO address.address_point AS p (
      prg_local_id, version_id, version_start, simc, ulic_id,
      building_number, building_number_key, building_number_sort,
      postal_code, status, status_source_date,
      geom, source, source_version, fetched_at, content_hash
    )
    SELECT s.prg_local_id, s.version_id, s.version_start, s.simc, s.ulic_id,
           s.building_number, s.building_number_key, s.building_number_sort,
           s.postal_code,
           s.status, CASE WHEN s.status IS NOT NULL THEN current_date END,
           s.geom, s.source, s.source_version, now(), s.content_hash
      FROM staging.address_point s
      LEFT JOIN address.address_point existing ON existing.prg_local_id = s.prg_local_id
     WHERE s.simc IS NOT NULL
       AND (existing.prg_local_id IS NULL
            OR existing.content_hash <> s.content_hash
            OR existing.withdrawn_at IS NOT NULL)
       AND EXISTS (SELECT 1 FROM address.locality m WHERE m.simc = s.simc)
    ON CONFLICT (prg_local_id) DO UPDATE SET
      version_id = EXCLUDED.version_id,
      version_start = EXCLUDED.version_start,
      simc = EXCLUDED.simc,
      ulic_id = EXCLUDED.ulic_id,
      building_number = EXCLUDED.building_number,
      building_number_key = EXCLUDED.building_number_key,
      building_number_sort = EXCLUDED.building_number_sort,
      postal_code = EXCLUDED.postal_code,
      -- Po 1.09.2026 PRG nie publikuje `status`. Nie nadpisujemy wtedy
      -- zamrozonego snapshotu NULL-em - to jedyne zrodlo tej informacji.
      status = COALESCE(EXCLUDED.status, p.status),
      status_source_date = CASE WHEN EXCLUDED.status IS NOT NULL
                                THEN current_date ELSE p.status_source_date END,
      geom = COALESCE(EXCLUDED.geom, p.geom),
      source_version = EXCLUDED.source_version,
      fetched_at = now(),
      content_hash = EXCLUDED.content_hash,
      withdrawn_at = NULL
    RETURNING (xmax = 0) AS inserted,
              (xmax <> 0 AND p.withdrawn_at IS NOT NULL) AS was_withdrawn
  )
  SELECT count(*) FILTER (WHERE inserted),
         count(*) FILTER (WHERE NOT inserted),
         count(*) FILTER (WHERE was_withdrawn)
    INTO v_added, v_changed, v_restored
    FROM ins;

  -- Odswiezenie statystyk PO masowym wstawieniu, a PRZED kolejnymi krokami.
  -- Bez tego planner planuje reszte transakcji na statystykach sprzed
  -- wstawienia i wybiera petle zagniezdzone dla milionow rekordow.
  ANALYZE address.address_point;
  ANALYZE address.street;
  ANALYZE address.locality;

  -- 3. soft delete tego, czego nie ma w zrzucie. Ograniczone do wojewodztw
  --    obecnych w zrzucie - inaczej import jednego wojewodztwa wycofalby
  --    cala reszte kraju.
  WITH gone AS (
    UPDATE address.address_point p
       SET withdrawn_at = now()
      FROM address.locality m
     WHERE m.simc = p.simc
       AND p.withdrawn_at IS NULL
       AND p.source = p_source
       AND (p_voivodeships IS NULL OR left(m.gmina_terc, 2) = ANY(p_voivodeships))
       AND NOT EXISTS (
             SELECT 1 FROM staging.address_point s
              WHERE s.prg_local_id = p.prg_local_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_withdrawn FROM gone;

  PERFORM address.refresh_derived();

  UPDATE address.snapshot SET status = 'opublikowany'
   WHERE source = p_source AND version = p_version;

  RETURN QUERY SELECT v_added, v_changed, v_withdrawn, v_restored;
END;
$$;

-- ---------------------------------------------------------------------
--  12. Obsluga obszaru przejsciowego
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION staging.truncate_all() RETURNS void
LANGUAGE plpgsql
SET search_path = staging, public
AS $$
BEGIN
  TRUNCATE staging.address_point, staging.locality, staging.street;
END;
$$;

-- Przy 8,5 mln wierszy indeksy na staging sa podczas COPY czystym narzutem.
-- Zdjecie ich przed ladowaniem i odtworzenie po nim jest tansze niz
-- utrzymywanie w trakcie.
CREATE OR REPLACE FUNCTION staging.before_load() RETURNS void
LANGUAGE plpgsql
SET search_path = staging, public
AS $$
BEGIN
  DROP INDEX IF EXISTS staging.ix_st_ap_simc;
  DROP INDEX IF EXISTS staging.ix_st_ap_ulic;
  DROP INDEX IF EXISTS staging.ix_st_ap_content_hash;
END;
$$;

CREATE OR REPLACE FUNCTION staging.after_load() RETURNS void
LANGUAGE plpgsql
SET search_path = staging, public
AS $$
BEGIN
  -- Referencje rozwiazujemy TU, jeszcze przy zdjetych indeksach.
  -- Wywolane po odtworzeniu indeksow oznacza ponad 25 mln operacji
  -- indeksowych - zmierzone ponad 40 minut na komplecie 16 wojewodztw.
  PERFORM staging.resolve_refs();

  CREATE INDEX IF NOT EXISTS ix_st_ap_simc         ON staging.address_point(simc);
  CREATE INDEX IF NOT EXISTS ix_st_ap_ulic         ON staging.address_point(ulic_id);
  CREATE INDEX IF NOT EXISTS ix_st_ap_content_hash ON staging.address_point(content_hash);
  -- Bez statystyk planer wybiera zagniezdzone petle dla kontroli jakosci.
  ANALYZE staging.address_point;
  ANALYZE staging.locality;
  ANALYZE staging.street;
END;
$$;

-- ---------------------------------------------------------------------
--  13. Znacznik zmiany i kanal powiadomien
-- ---------------------------------------------------------------------
--
--  UWAGA NA KONTRAKT: kanal nazywa sie teraz `licensing_change`, a ladunek
--  ma prefiksy `key:` / `client:`. Nasluch po stronie API musi znac te same
--  nazwy - patrz packages/api/src/keys/notify-listener.ts.

DROP FUNCTION IF EXISTS licensing.znacznik_zmiany() CASCADE;
DROP FUNCTION IF EXISTS licensing.powiadom_o_kluczu() CASCADE;
DROP FUNCTION IF EXISTS licensing.powiadom_o_kliencie() CASCADE;

CREATE OR REPLACE FUNCTION licensing.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = licensing, public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Payload to hex skrotu - NIGDY klucz jawny, ktorego baza zreszta nie zna.
CREATE OR REPLACE FUNCTION licensing.notify_api_key_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = licensing, public
AS $$
BEGIN
  PERFORM pg_notify('licensing_change', 'key:' || encode(NEW.hash, 'hex'));
  RETURN NULL;
END;
$$;

-- Osobna funkcja, bo tabela client nie ma kolumny hash. Bez tego wyzwalacza
-- zawieszenie klienta nigdy nie dociera do repliki w procesie.
CREATE OR REPLACE FUNCTION licensing.notify_client_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = licensing, public
AS $$
BEGIN
  PERFORM pg_notify('licensing_change', 'client:' || NEW.id::text);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER tg_client_touch
  BEFORE UPDATE ON licensing.client
  FOR EACH ROW EXECUTE FUNCTION licensing.touch_updated_at();

CREATE OR REPLACE TRIGGER tg_api_key_touch
  BEFORE UPDATE ON licensing.api_key
  FOR EACH ROW EXECUTE FUNCTION licensing.touch_updated_at();

CREATE OR REPLACE TRIGGER tg_usage_touch
  BEFORE UPDATE ON licensing.usage
  FOR EACH ROW EXECUTE FUNCTION licensing.touch_updated_at();

CREATE OR REPLACE TRIGGER tg_api_key_notify
  AFTER INSERT OR UPDATE ON licensing.api_key
  FOR EACH ROW EXECUTE FUNCTION licensing.notify_api_key_change();

CREATE OR REPLACE TRIGGER tg_client_notify
  AFTER INSERT OR UPDATE ON licensing.client
  FOR EACH ROW EXECUTE FUNCTION licensing.notify_client_change();

-- Stare wyzwalacze znikaja razem z funkcjami (CASCADE wyzej), ale gdyby
-- migracja szla na bazie bez tamtych funkcji - usuwamy je jawnie.
DROP TRIGGER IF EXISTS tg_klient_znacznik  ON licensing.client;
DROP TRIGGER IF EXISTS tg_klucz_znacznik   ON licensing.api_key;
DROP TRIGGER IF EXISTS tg_zuzycie_znacznik ON licensing.usage;
DROP TRIGGER IF EXISTS tg_klucz_powiadom   ON licensing.api_key;
DROP TRIGGER IF EXISTS tg_klient_powiadom  ON licensing.client;

-- ---------------------------------------------------------------------
--  14. Komentarze schematow
-- ---------------------------------------------------------------------

COMMENT ON SCHEMA licensing IS
  'Klienci API, klucze i zuzycie. Odseparowany od schematu address celowo: '
  'e2e.sh robi TRUNCATE address.* CASCADE, wiec kaskada z tamtej strony '
  'kasowalaby poswiadczenia klientow. Zero kluczy obcych miedzy schematami.';

COMMENT ON COLUMN licensing.api_key.hash IS
  'HMAC-SHA256 klucza jawnego z pieprzem trzymanym poza baza. Klucza jawnego '
  'nie da sie odtworzyc z tej wartosci ani z calego zrzutu bazy.';

COMMENT ON COLUMN licensing.api_key.pepper_version IS
  'Ksiegowosc rotacji pieprza, nie jej mechanizm. Przeliczenie skrotu na nowy '
  'pieprz wymagaloby klucza jawnego, ktorego nie mamy - rotacja pieprza to '
  'zawsze wymiana kluczy.';

COMMIT;
