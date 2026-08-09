-- =====================================================================
--  Schemat staging + atomowa podmiana
-- =====================================================================
--
--  MODEL PUBLIKACJI:
--    1. ETL laduje surowy zrzut do `staging` (TRUNCATE + COPY)
--    2. sanity checks porownuja `staging` z `adres` (patrz db/sanity.ts)
--    3. dopiero po przejsciu kontroli - atomowa podmiana w JEDNEJ transakcji
--
--  Dlaczego TRUNCATE + full reload, a nie merge przyrostowy:
--  PRG nie publikuje plikow roznicowych. Przy 8,5 mln rekordow pelne
--  przeladowanie do staging to kilka minut, a merge wymagalby utrzymywania
--  stanu, ktory i tak trzeba by weryfikowac. Prostota wygrywa - to samo
--  podejscie ma produkcyjny pipeline gugik2osm.
--
--  Dlaczego podmiana, a nie UPDATE in place:
--  UPDATE na 8,5 mln wierszy blokuje odczyty i zostawia baze w stanie
--  posrednim. Podmiana partycji/tabeli jest natychmiastowa i albo sie
--  udaje w calosci, albo wcale.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS staging;

SET search_path = staging, adres, public;

CREATE TABLE IF NOT EXISTS staging.punkt_adresowy (
  prg_local_id  text PRIMARY KEY,
  wersja_id     text,
  poczatek_wersji timestamptz,
  -- Referencje surowe: w strukturze 2012 to gotowe kody SIMC/ULIC,
  -- w 2021 to xlink:href wskazujacy na gml:id - rozwiazywane w resolve_refs().
  simc_ref      text,
  ulic_ref      text,
  simc          char(7),
  ulic_id       bigint,
  nr_budynku    text NOT NULL,
  nr_key        text NOT NULL,
  nr_sort       text NOT NULL,
  kod_pocztowy  char(6),
  status        text,
  terc_ref      text,
  geom          geography(Point, 4326),
  zrodlo        text NOT NULL,
  zrodlo_wersja text NOT NULL,
  tresc_hash    bytea NOT NULL,
  wojewodztwo   char(2)
);
CREATE INDEX IF NOT EXISTS ix_st_pa_simc ON staging.punkt_adresowy(simc);
CREATE INDEX IF NOT EXISTS ix_st_pa_ulic ON staging.punkt_adresowy(ulic_id);
CREATE INDEX IF NOT EXISTS ix_st_pa_hash ON staging.punkt_adresowy(tresc_hash);

CREATE TABLE IF NOT EXISTS staging.miejscowosc (
  prg_local_id  text PRIMARY KEY,
  gml_id        text,
  simc          char(7),
  nazwa         text NOT NULL,
  nazwa_norm    text NOT NULL,
  rodzaj        smallint,
  rodzaj_raw    text,
  terc_gminy    char(7),
  identyfikator_prng text,
  centroid      geography(Point, 4326),
  zrodlo        text NOT NULL,
  zrodlo_wersja text NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_st_m_simc ON staging.miejscowosc(simc);
CREATE INDEX IF NOT EXISTS ix_st_m_gml  ON staging.miejscowosc(gml_id);

CREATE TABLE IF NOT EXISTS staging.ulica (
  prg_local_id  text PRIMARY KEY,
  gml_id        text,
  sym_ul        char(5),
  simc_ref      text,
  simc          char(7),
  cecha         text,
  nazwa         text NOT NULL,
  nazwa_norm    text NOT NULL,
  nazwa_skroc      text,
  nazwa_skroc_norm text,
  nazwa_1       text,
  nazwa_2       text,
  zrodlo        text NOT NULL,
  zrodlo_wersja text NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_st_u_simc ON staging.ulica(simc);
CREATE INDEX IF NOT EXISTS ix_st_u_gml  ON staging.ulica(gml_id);
-- Druga droga wiazania punktow z ulicami (struktura 2012, ref = SYM_UL).
CREATE INDEX IF NOT EXISTS ix_st_u_sym  ON staging.ulica(sym_ul) WHERE sym_ul IS NOT NULL;

-- ---------------------------------------------------------------------
--  Rozwiazywanie referencji
-- ---------------------------------------------------------------------
--
--  W strukturze 2021 asocjacje sa kodowane jako xlink:href wskazujacy
--  na gml:id innego obiektu w TYM SAMYM pliku, a nie jako gotowy kod
--  SIMC/ULIC. Parser zapisuje surowa wartosc do *_ref; tutaj ja rozwiazujemy.
--
--  Obsluguje OBA warianty: jesli *_ref wyglada jak kod TERYT, bierzemy go
--  wprost; jesli jak gml:id - szukamy po gml_id.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION staging.resolve_refs() RETURNS void
LANGUAGE plpgsql
SET search_path = staging, adres, public
AS $$
BEGIN
  -- miejscowosc: ref moze byc kodem SIMC (2012) albo gml:id (2021)
  --
  -- NAJPIERW dopasowanie po gml:id, i wtedy SIMC bierzemy WPROST z miejscowosci.
  -- Wyciaganie cyfr z identyfikatora nowej struktury jest bledem: dla
  -- `PL.ZIPIN.692.EMUiA_0145023_2026-07-23T09_31_02_02_00` regexp zbiera cyfry
  -- z numeru ZIPIN, z SIMC ORAZ z daty wersji i sklada z nich ~30-znakowy
  -- ciag. Wczesniej stalo to na pierwszej pozycji COALESCE, wiec wygrywalo
  -- z poprawnym `m.simc` - publikacja przewracala sie na `value too long for
  -- type character(7)`, a gdyby kolumna byla szersza, do bazy trafilyby ciche
  -- smieci zamiast identyfikatorow miejscowosci.
  UPDATE staging.punkt_adresowy p
     SET simc = m.simc
    FROM staging.miejscowosc m
   WHERE m.gml_id = p.simc_ref AND p.simc IS NULL;

  -- Dopiero teraz przypadek struktury 2012, gdzie ref JEST kodem SIMC.
  UPDATE staging.punkt_adresowy p
     SET simc = lpad(regexp_replace(p.simc_ref, '\D', '', 'g'), 7, '0')
   WHERE p.simc IS NULL
     AND p.simc_ref ~ '^\d{1,7}$';

  UPDATE staging.ulica u
     SET simc = m.simc
    FROM staging.miejscowosc m
   WHERE m.gml_id = u.simc_ref AND u.simc IS NULL;

  UPDATE staging.ulica u
     SET simc = lpad(regexp_replace(u.simc_ref, '\D', '', 'g'), 7, '0')
   WHERE u.simc IS NULL
     AND u.simc_ref ~ '^\d{1,7}$';

  -- UWAGA: `ulic_id` NIE jest tu ustawiane.
  --
  -- Wczesniejsza wersja przypisywala tymczasowy identyfikator z row_number(),
  -- ktory nie odpowiadal zadnej ulicy w tabeli docelowej. Gdy dalsze
  -- dopasowanie zawiodlo, wartosc zostawala i publikacja wywalala sie na
  -- kluczu obcym `punkt_adresowy_ulic_id_fkey`.
  --
  -- Wlasciwe powiazanie powstaje w `publikuj_zrzut`, juz PO wstawieniu ulic
  -- do tabeli docelowej - bo dopiero wtedy istnieja prawdziwe identyfikatory.
  -- Punkt bez rozwiazanej ulicy zostaje z NULL, czyli jest traktowany jak
  -- adres bez ulicy. To poprawne zachowanie: lepiej stracic powiazanie
  -- z ulica niz caly punkt adresowy.
END;
$$;

-- ---------------------------------------------------------------------
--  Atomowa publikacja
-- ---------------------------------------------------------------------
--
--  Wszystko w jednej transakcji. Albo caly zrzut wchodzi, albo nic.
--
--  Zwraca liczby: dodane / zmienione / wycofane.
--  Punktow NIE KASUJEMY - ustawiamy `wycofany_od`. Gminy popelniaja bledy
--  i je cofaja; punkt usuniety dzis moze wrocic za miesiac, a w miedzyczasie
--  klient ma go w zamowieniu.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION adres.publikuj_zrzut(
  p_zrodlo text,
  p_wersja text,
  p_wojewodztwa char(2)[] DEFAULT NULL   -- NULL = caly kraj
) RETURNS TABLE(dodane bigint, zmienione bigint, wycofane bigint, przywrocone bigint)
LANGUAGE plpgsql
SET search_path = adres, staging, public
AS $$
DECLARE
  v_dodane bigint := 0;
  v_zmienione bigint := 0;
  v_wycofane bigint := 0;
  v_przywrocone bigint := 0;
BEGIN
  PERFORM staging.resolve_refs();

  -- 1. slowniki: miejscowosci i ulice (upsert, bez kasowania)
  INSERT INTO adres.miejscowosc AS m (
    simc, nazwa, nazwa_norm, rodzaj, terc_gminy, identyfikator_prng,
    centroid, zrodlo, zrodlo_wersja, prg_local_id, pobrano
  )
  -- DISTINCT ON, bo zrodlo potrafi opisac ta sama miejscowosc wiecej niz raz.
  -- Bez tego ON CONFLICT dostaje ten sam klucz dwukrotnie w jednej instrukcji
  -- i Postgres przerywa calosc bledem "cannot affect row a second time" -
  -- czyli jeden zdublowany rekord w zrodle wstrzymuje publikacje calego kraju.
  -- Preferujemy wariant z geometria, a przy remisie rozstrzyga identyfikator,
  -- zeby wybor byl powtarzalny miedzy przebiegami.
  SELECT DISTINCT ON (s.simc)
         s.simc, s.nazwa, s.nazwa_norm, s.rodzaj, s.terc_gminy,
         s.identyfikator_prng, s.centroid, s.zrodlo, s.zrodlo_wersja,
         s.prg_local_id, now()
    FROM staging.miejscowosc s
   WHERE s.simc IS NOT NULL AND s.terc_gminy IS NOT NULL
   ORDER BY s.simc, (s.centroid IS NULL), s.prg_local_id
  -- PRECEDENCJA ZRODEL:
  --   nazwa           -> TERYT (rejestr urzedowy nazw)
  --   geometria       -> PRG   (spojny uklad, walidowana)
  --   punkty adresowe -> PRG
  -- Bez tego PRG nadpisuje urzedowa nazwe swoja wersja, ktora bywa
  -- pozbawiona polskich znakow albo zapisana wersalikami.
  ON CONFLICT (simc) DO UPDATE SET
    nazwa      = CASE WHEN m.zrodlo = 'teryt' THEN m.nazwa      ELSE EXCLUDED.nazwa      END,
    nazwa_norm = CASE WHEN m.zrodlo = 'teryt' THEN m.nazwa_norm ELSE EXCLUDED.nazwa_norm END,
    rodzaj = COALESCE(m.rodzaj, EXCLUDED.rodzaj),
    -- centroid z PRG jest lepszy niz brak, ale nie nadpisuje istniejacego
    centroid = COALESCE(m.centroid, EXCLUDED.centroid),
    zrodlo_wersja = EXCLUDED.zrodlo_wersja,
    pobrano = now(),
    wycofany_od = NULL;

  -- Wydzielenie slowa rodzajowego z nazwy do kolumny cechy.
  --
  -- PRG nie wypelnia `cecha` w ogole i dla czesci ulic wstawia typ do samej
  -- nazwy: "ulica Marszalkowska" zamiast cechy "ul." i nazwy "Marszalkowska".
  -- W Warszawie dotyczylo to 97% ulic. Bez tego kroku migracja 003 zostalaby
  -- cofnieta przy pierwszej publikacji, bo PRG wnioslby nazwy z przedrostkiem
  -- z powrotem. Regula jest ta sama, co w 003 - trzymac je zgodne.
  UPDATE staging.ulica s
     SET cecha      = COALESCE(s.cecha, r.skrot),
         nazwa      = regexp_replace(s.nazwa, '^\S+\s+', ''),
         nazwa_norm = regexp_replace(s.nazwa_norm, '^\S+\s+', '')
    FROM (VALUES ('ulica','ul.'), ('aleja','al.'), ('plac','pl.'),
                 ('osiedle','os.'), ('rondo','rondo'), ('skwer','skwer'),
                 ('bulwar','bulw.'), ('droga','droga'), ('szosa','szosa'))
         AS r(slowo, skrot)
   WHERE lower(split_part(s.nazwa, ' ', 1)) = r.slowo
     AND position(' ' in s.nazwa) > 0;

  -- Katalog ulic: scalanie po SYM_UL, nie po nazwie.
  --
  -- Do 9.08.2026 kluczem konfliktu bylo (simc, nazwa_norm, cecha). TERYT
  -- ustawia cecha 'ul.', PRG zostawia NULL, wiec ten sam obiekt wchodzil DWA
  -- RAZY - 363 823 nadmiarowe wiersze, 53% katalogu. Punkty wiazaly sie tylko
  -- z jednym wpisem, drugi zostawal z zerem i zasmiecal podpowiedzi.
  -- SYM_UL to identyfikator z urzedowego katalogu ULIC; jest wypelniony
  -- dla 99,98% wierszy i byl dostepny od poczatku.
  INSERT INTO adres.ulica AS u (
    simc, sym_ul, cecha, nazwa, nazwa_norm, nazwa_skroc, nazwa_skroc_norm,
    nazwa_1, nazwa_2, zrodlo, zrodlo_wersja, prg_local_id, pobrano
  )
  SELECT DISTINCT ON (s.simc, s.sym_ul)
         s.simc, s.sym_ul, s.cecha, s.nazwa, s.nazwa_norm,
         s.nazwa_skroc, s.nazwa_skroc_norm, s.nazwa_1, s.nazwa_2,
         s.zrodlo, s.zrodlo_wersja, s.prg_local_id, now()
    FROM staging.ulica s
   WHERE s.simc IS NOT NULL AND s.sym_ul IS NOT NULL
     AND EXISTS (SELECT 1 FROM adres.miejscowosc m WHERE m.simc = s.simc)
   -- TERYT pierwszy, bo z niego bierzemy nazwe urzedowa
   ORDER BY s.simc, s.sym_ul, (s.zrodlo <> 'teryt'), s.prg_local_id
  ON CONFLICT (simc, sym_ul) WHERE sym_ul IS NOT NULL AND wycofany_od IS NULL
  DO UPDATE SET
    -- nazwa urzedowa z TERYT ma pierwszenstwo (patrz komentarz wyzej)
    nazwa            = CASE WHEN EXCLUDED.zrodlo = 'teryt' THEN EXCLUDED.nazwa            ELSE u.nazwa            END,
    nazwa_norm       = CASE WHEN EXCLUDED.zrodlo = 'teryt' THEN EXCLUDED.nazwa_norm       ELSE u.nazwa_norm       END,
    cecha            = CASE WHEN EXCLUDED.zrodlo = 'teryt' THEN EXCLUDED.cecha            ELSE COALESCE(u.cecha, EXCLUDED.cecha) END,
    nazwa_skroc      = CASE WHEN EXCLUDED.zrodlo = 'teryt' THEN EXCLUDED.nazwa_skroc      ELSE COALESCE(u.nazwa_skroc, EXCLUDED.nazwa_skroc) END,
    nazwa_skroc_norm = CASE WHEN EXCLUDED.zrodlo = 'teryt' THEN EXCLUDED.nazwa_skroc_norm ELSE COALESCE(u.nazwa_skroc_norm, EXCLUDED.nazwa_skroc_norm) END,
    nazwa_1 = COALESCE(u.nazwa_1, EXCLUDED.nazwa_1),
    nazwa_2 = COALESCE(u.nazwa_2, EXCLUDED.nazwa_2),
    prg_local_id = COALESCE(u.prg_local_id, EXCLUDED.prg_local_id),
    zrodlo_wersja = EXCLUDED.zrodlo_wersja,
    pobrano = now(),
    wycofany_od = NULL;

  -- Ulice bez SYM_UL (ok. 130 w skali kraju) - brak klucza katalogowego,
  -- wiec dla nich zostaje dopasowanie po nazwie. Osobny indeks czesciowy.
  INSERT INTO adres.ulica AS u (
    simc, sym_ul, cecha, nazwa, nazwa_norm, nazwa_skroc, nazwa_skroc_norm,
    nazwa_1, nazwa_2, zrodlo, zrodlo_wersja, prg_local_id, pobrano
  )
  SELECT DISTINCT ON (s.simc, s.nazwa_norm, s.cecha)
         s.simc, s.sym_ul, s.cecha, s.nazwa, s.nazwa_norm,
         s.nazwa_skroc, s.nazwa_skroc_norm, s.nazwa_1, s.nazwa_2,
         s.zrodlo, s.zrodlo_wersja, s.prg_local_id, now()
    FROM staging.ulica s
   WHERE s.simc IS NOT NULL AND s.sym_ul IS NULL
     AND EXISTS (SELECT 1 FROM adres.miejscowosc m WHERE m.simc = s.simc)
     AND NOT EXISTS (SELECT 1 FROM adres.ulica x
                      WHERE x.simc = s.simc AND x.nazwa_norm = s.nazwa_norm
                        AND x.sym_ul IS NOT NULL AND x.wycofany_od IS NULL)
   ORDER BY s.simc, s.nazwa_norm, s.cecha, s.prg_local_id
  ON CONFLICT (simc, nazwa_norm, cecha) WHERE sym_ul IS NULL AND wycofany_od IS NULL
  DO UPDATE SET
    nazwa_1 = COALESCE(u.nazwa_1, EXCLUDED.nazwa_1),
    nazwa_2 = COALESCE(u.nazwa_2, EXCLUDED.nazwa_2),
    zrodlo_wersja = EXCLUDED.zrodlo_wersja,
    pobrano = now(),
    wycofany_od = NULL;

  -- Powiazanie punktow z ulicami - dopiero teraz, gdy ulice maja juz
  -- prawdziwe identyfikatory w tabeli docelowej.
  --
  -- Dwie drogi dopasowania, bo struktury zrodlowe roznia sie sposobem
  -- zapisu referencji:
  --   2021: ulic_ref to gml:id obiektu w tym samym pliku
  --   2012: ulic_ref to kod SYM_UL z katalogu ULIC
  UPDATE staging.punkt_adresowy s
     SET ulic_id = u.ulic_id
    FROM staging.ulica su
    JOIN adres.ulica u
      ON u.simc = su.simc
     AND u.nazwa_norm = su.nazwa_norm
     AND u.cecha IS NOT DISTINCT FROM su.cecha
   WHERE s.ulic_ref IS NOT NULL
     AND su.gml_id = s.ulic_ref;

  -- Druga droga w OSOBNYM zapytaniu, a nie w OR z powyzszym.
  --
  -- Poprzednio oba warunki laczyl OR, w ktorym jedna galaz porownywala
  -- kolumny, a druga wynik funkcji. Planner nie moze wtedy wykorzystac
  -- indeksu dla zadnej z nich i schodzi do petli zagniezdzonej: dla kazdego
  -- punktu skan calej staging.ulica. Zmierzone na czterech wojewodztwach:
  -- 1 324 563 punkty z referencja razy 76 886 ulic, czyli ponad 100 mld
  -- porownan - publikacja nie skonczyla sie po 8 godzinach. Rozbicie na dwa
  -- zapytania pozwala uzyc ix_st_u_gml w pierwszym i zlaczenia haszowego
  -- po sym_ul w drugim.
  UPDATE staging.punkt_adresowy s
     SET ulic_id = u.ulic_id
    FROM staging.ulica su
    JOIN adres.ulica u
      ON u.simc = su.simc
     AND u.nazwa_norm = su.nazwa_norm
     AND u.cecha IS NOT DISTINCT FROM su.cecha
   WHERE s.ulic_id IS NULL
     AND s.ulic_ref IS NOT NULL
     AND su.sym_ul = lpad(regexp_replace(s.ulic_ref, '\D', '', 'g'), 5, '0');

  -- Dopasowanie po samym SYM_UL, gdy ulicy nie bylo w tym pliku,
  -- ale jest juz w bazie z TERYT albo z wczesniejszego zrzutu.
  UPDATE staging.punkt_adresowy s
     SET ulic_id = u.ulic_id
    FROM adres.ulica u
   WHERE s.ulic_id IS NULL
     AND s.ulic_ref ~ '^[0-9]{1,5}$'
     AND u.simc = s.simc
     AND u.sym_ul = lpad(s.ulic_ref, 5, '0');

  -- ZABEZPIECZENIE: identyfikator, ktory nie istnieje w tabeli docelowej,
  -- musi zostac wyzerowany. Inaczej publikacja przerywa sie na kluczu obcym
  -- i traci CALY zrzut z powodu pojedynczej nierozwiazanej referencji.
  UPDATE staging.punkt_adresowy s
     SET ulic_id = NULL
   WHERE s.ulic_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM adres.ulica u WHERE u.ulic_id = s.ulic_id);

  -- 2. punkty adresowe: upsert TYLKO tego, co sie zmienilo
  --
  -- POMIAR NA PELNEJ SKALI: upsert wszystkich 8,5 mln wierszy trwa ~7 minut
  -- i jest tak samo kosztowny przy nocnej aktualizacji, w ktorej realnie
  -- zmienia sie ~0,4% rekordow. PRG rosnie o ~30 tys. punktow na kwartal.
  --
  -- Filtr ponizej ogranicza prace do rekordow nowych albo o zmienionej
  -- tresci. Reszta nie jest dotykana: nie generuje martwych krotek,
  -- nie odswieza indeksow i nie zabiera czasu.
  --
  -- Warunek `wycofany_od IS NOT NULL` jest istotny: punkt wczesniej wycofany,
  -- ktory wrocil do rejestru bez zmiany tresci, musi zostac przywrocony.
  WITH ins AS (
    INSERT INTO adres.punkt_adresowy AS p (
      prg_local_id, wersja_id, poczatek_wersji, simc, ulic_id,
      nr_budynku, nr_key, nr_sort, kod_pocztowy, status, status_zrodlo_data,
      geom, zrodlo, zrodlo_wersja, pobrano, tresc_hash
    )
    SELECT s.prg_local_id, s.wersja_id, s.poczatek_wersji, s.simc, s.ulic_id,
           s.nr_budynku, s.nr_key, s.nr_sort, s.kod_pocztowy,
           s.status, CASE WHEN s.status IS NOT NULL THEN current_date END,
           s.geom, s.zrodlo, s.zrodlo_wersja, now(), s.tresc_hash
      FROM staging.punkt_adresowy s
      LEFT JOIN adres.punkt_adresowy istn ON istn.prg_local_id = s.prg_local_id
     WHERE s.simc IS NOT NULL
       AND (istn.prg_local_id IS NULL
            OR istn.tresc_hash <> s.tresc_hash
            OR istn.wycofany_od IS NOT NULL)
       AND EXISTS (SELECT 1 FROM adres.miejscowosc m WHERE m.simc = s.simc)
    ON CONFLICT (prg_local_id) DO UPDATE SET
      wersja_id = EXCLUDED.wersja_id,
      poczatek_wersji = EXCLUDED.poczatek_wersji,
      simc = EXCLUDED.simc,
      ulic_id = EXCLUDED.ulic_id,
      nr_budynku = EXCLUDED.nr_budynku,
      nr_key = EXCLUDED.nr_key,
      nr_sort = EXCLUDED.nr_sort,
      kod_pocztowy = EXCLUDED.kod_pocztowy,
      -- Po 1.09.2026 PRG nie publikuje `status`. Nie nadpisujemy wtedy
      -- zamrozonego snapshotu NULL-em - to jedyne zrodlo tej informacji.
      status = COALESCE(EXCLUDED.status, p.status),
      status_zrodlo_data = CASE WHEN EXCLUDED.status IS NOT NULL
                                THEN current_date ELSE p.status_zrodlo_data END,
      geom = COALESCE(EXCLUDED.geom, p.geom),
      zrodlo_wersja = EXCLUDED.zrodlo_wersja,
      pobrano = now(),
      tresc_hash = EXCLUDED.tresc_hash,
      wycofany_od = NULL
    RETURNING (xmax = 0) AS wstawiony,
              (xmax <> 0 AND p.wycofany_od IS NOT NULL) AS byl_wycofany
  )
  SELECT count(*) FILTER (WHERE wstawiony),
         count(*) FILTER (WHERE NOT wstawiony),
         count(*) FILTER (WHERE byl_wycofany)
    INTO v_dodane, v_zmienione, v_przywrocone
    FROM ins;

  -- Odswiezenie statystyk PO masowym wstawieniu, a PRZED kolejnymi krokami.
  --
  -- Bez tego planner planuje reszte transakcji na statystykach sprzed
  -- wstawienia. Przy pierwszym zaladowaniu tabela punktow jest pusta, wiec
  -- widzi "zero wierszy" i wybiera petle zagniezdzone - ktore wykonuje potem
  -- na dwoch milionach rekordow. Zmierzone: krok wycofywania i przeliczanie
  -- pol pochodnych nie skonczyly sie po godzinie, przy szacunku plannera
  -- rownym 27 wierszy. ANALYZE kosztuje sekundy i jest w tej transakcji
  -- widoczny tylko dla niej.
  ANALYZE adres.punkt_adresowy;
  ANALYZE adres.ulica;
  ANALYZE adres.miejscowosc;

  -- 3. soft delete tego, czego nie ma w zrzucie.
  --    Ograniczone do wojewodztw obecnych w zrzucie - inaczej import
  --    jednego wojewodztwa wycofalby cala reszte kraju.
  WITH wyc AS (
    UPDATE adres.punkt_adresowy p
       SET wycofany_od = now()
      FROM adres.miejscowosc m
     WHERE m.simc = p.simc
       AND p.wycofany_od IS NULL
       AND p.zrodlo = p_zrodlo
       AND (p_wojewodztwa IS NULL OR left(m.terc_gminy, 2) = ANY(p_wojewodztwa))
       AND NOT EXISTS (
             SELECT 1 FROM staging.punkt_adresowy s
              WHERE s.prg_local_id = p.prg_local_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_wycofane FROM wyc;

  PERFORM adres.refresh_derived();

  UPDATE adres.zrzut SET status = 'opublikowany'
   WHERE zrodlo = p_zrodlo AND wersja = p_wersja;

  RETURN QUERY SELECT v_dodane, v_zmienione, v_wycofane, v_przywrocone;
END;
$$;

CREATE OR REPLACE FUNCTION staging.wyczysc() RETURNS void
LANGUAGE plpgsql
SET search_path = staging, public
AS $$
BEGIN
  TRUNCATE staging.punkt_adresowy, staging.miejscowosc, staging.ulica;
END;
$$;

-- ---------------------------------------------------------------------
--  Indeksy obszaru przejsciowego: zdejmowane na czas ladowania
-- ---------------------------------------------------------------------
--
--  Przy 8,5 mln wierszy indeksy na `staging` sa podczas COPY czystym
--  narzutem - kazdy wstawiany wiersz aktualizuje trzy struktury B-tree,
--  ktore i tak nie sa potrzebne az do momentu kontroli jakosci.
--
--  Pomiar na pelnej skali pokazal, ze to dominujacy koszt ladowania.
--  Zdjecie indeksow przed COPY i odtworzenie po nim jest tansze niz
--  utrzymywanie ich w trakcie.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION staging.przed_ladowaniem() RETURNS void
LANGUAGE plpgsql
SET search_path = staging, public
AS $$
BEGIN
  DROP INDEX IF EXISTS staging.ix_st_pa_simc;
  DROP INDEX IF EXISTS staging.ix_st_pa_ulic;
  DROP INDEX IF EXISTS staging.ix_st_pa_hash;
END;
$$;

CREATE OR REPLACE FUNCTION staging.po_ladowaniu() RETURNS void
LANGUAGE plpgsql
SET search_path = staging, public
AS $$
BEGIN
  -- Referencje rozwiazujemy TU, jeszcze przy zdjetych indeksach.
  --
  -- resolve_refs() aktualizuje wszystkie wiersze punkt_adresowy. Wywolane po
  -- odtworzeniu indeksow oznacza dla kazdego wiersza nowa krotke plus trzy
  -- wpisy indeksowe - przy 8,6 mln punktow ponad 25 mln operacji na indeksach.
  -- Zmierzone na komplecie 16 wojewodztw: ponad 40 minut. W oknie ladowania
  -- masowego, bez indeksow, to zwykly seq scan z hash join i zapis krotek,
  -- a indeksy powstaja nizej juz na gotowych danych.
  --
  -- Efekt uboczny jest pozadany: ix_st_pa_simc buduje sie na wypelnionej
  -- kolumnie, wiec kontrole jakosci dostaja indeks, ktory faktycznie pomaga.
  PERFORM staging.resolve_refs();

  CREATE INDEX IF NOT EXISTS ix_st_pa_simc ON staging.punkt_adresowy(simc);
  CREATE INDEX IF NOT EXISTS ix_st_pa_ulic ON staging.punkt_adresowy(ulic_id);
  CREATE INDEX IF NOT EXISTS ix_st_pa_hash ON staging.punkt_adresowy(tresc_hash);
  -- Bez statystyk planer wybiera zagniezdzone petle dla kontroli jakosci,
  -- co przy 8,5 mln wierszy oznacza minuty zamiast sekund.
  ANALYZE staging.punkt_adresowy;
  ANALYZE staging.miejscowosc;
  ANALYZE staging.ulica;
END;
$$;
