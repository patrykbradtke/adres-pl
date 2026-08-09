-- ---------------------------------------------------------------------
--  Scalenie zdublowanego katalogu ulic + wydzielenie cechy z nazwy.
--  Zadania 6.22 i 6.23. Migracja jednorazowa.
-- ---------------------------------------------------------------------
--
--  PROBLEM
--  `adres.ulica` to w praktyce DWA rownolegle katalogi, nie jeden scalony:
--  689 328 wierszy, z czego 363 823 nadmiarowych (53%). Ta sama ulica
--  wystepuje osobno jako wpis z TERYT i jako wpis z PRG, bo klucz unikatowy
--  obejmuje `cecha`, a TERYT ustawia 'ul.' tam, gdzie PRG zostawia NULL.
--  Do tego w Postgresie NULL <> NULL, wiec dwa wpisy z PRG o tej samej nazwie
--  i pustej cesze rowniez nie koliduja ze soba - stad duplikaty wewnatrz
--  samego PRG (5 871 grup).
--
--  SKUTKI
--  Podpowiedzi pokazuja te sama ulice kilka razy, przy czym punkty adresowe
--  wiaza sie tylko z jednym wpisem, a pozostale maja liczba_punktow = 0
--  i zasmiecaja ranking. Artefakt wyszukiwania jest dwukrotnie wiekszy,
--  niz powinien.
--
--  KLUCZ SCALENIA: (simc, sym_ul)
--  `sym_ul` to identyfikator z urzedowego katalogu ULIC. Jest wypelniony
--  dla 689 196 z 689 328 wierszy i zgodny w obrebie duplikatu w 291 478
--  grupach na 291 710. Byl dostepny od poczatku - klucz unikatowy po prostu
--  go nie uzywal.
--
--  CZEGO NIE RUSZAMY
--  - 232 grupy o niezgodnym sym_ul: wymagaja przegladu recznego
--  - 132 wiersze bez sym_ul: brak klucza scalenia
--  Obie grupy zostaja jak sa i sa raportowane na koncu.
--
--  PRECEDENCJA POL przy scalaniu - zgodna z regula opisana w publikuj_zrzut:
--    nazwa, cecha       -> TERYT (urzedowy rejestr nazw)
--    liczba punktow     -> wiersz, ktory je faktycznie ma
--    prg_local_id       -> PRG
--
--  BEZPIECZENSTWO
--  punkt_adresowy.ulic_id ma klucz obcy do ulica.ulic_id, wiec punkty MUSZA
--  zostac przepiete przed usunieciem wierszy. Calosc w jednej transakcji.
-- ---------------------------------------------------------------------

BEGIN;

-- Stan przed - do porownania na koncu.
CREATE TEMP TABLE _przed AS
SELECT (SELECT count(*) FROM adres.ulica WHERE wycofany_od IS NULL)          AS ulic,
       (SELECT count(*) FROM adres.punkt_adresowy WHERE wycofany_od IS NULL) AS punktow,
       (SELECT count(*) FROM adres.punkt_adresowy
         WHERE wycofany_od IS NULL AND ulic_id IS NOT NULL)                  AS punktow_z_ulica;

-- ---------------------------------------------------------------------
-- WYMAGANIE WSTEPNE: indeks pod klucz obcy
-- ---------------------------------------------------------------------
-- `punkt_adresowy.ulic_id` ma klucz obcy do `ulica.ulic_id`, ale jedyny indeks
-- na tej kolumnie - ix_pa_ulica_nr - jest CZESCIOWY (WHERE wycofany_od IS NULL).
-- Kontrola klucza obcego wykonuje zapytanie bez tego warunku:
--     SELECT 1 FROM ONLY punkt_adresowy x WHERE $1 = ulic_id FOR KEY SHARE
-- wiec indeksu uzyc nie moze i skanuje calosc. Przy 363 823 usuwanych wierszach
-- i tabeli 2 GB pierwsza proba tej migracji nie skonczyla DELETE przez godzine.
--
-- Indeks `ix_pa_ulic_id` zaklada sie osobno, poleceniem CREATE INDEX
-- CONCURRENTLY (nie da sie go wykonac w transakcji). Bez niego nie uruchamiac.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='adres' AND indexname='ix_pa_ulic_id') THEN
    RAISE EXCEPTION 'Brak indeksu adres.ix_pa_ulic_id. Zaloz go najpierw: '
      'CREATE INDEX CONCURRENTLY ix_pa_ulic_id ON adres.punkt_adresowy(ulic_id);';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. Wybor wiersza, ktory przetrwa scalenie (6.23)
-- ---------------------------------------------------------------------
-- Scalamy po (simc, sym_ul) - identyfikatorze z urzedowego katalogu ULIC.
-- Nie zalezy on od nazw, wiec moze isc PRZED normalizacja.
-- Zostaje wiersz z najwieksza liczba punktow; przy remisie najnizszy ulic_id,
-- zeby wynik byl powtarzalny miedzy przebiegami.
CREATE TEMP TABLE _scalenie AS
WITH grupy AS (
  SELECT simc, sym_ul
    FROM adres.ulica
   WHERE wycofany_od IS NULL AND sym_ul IS NOT NULL
   GROUP BY simc, sym_ul
  HAVING count(*) > 1
     AND count(DISTINCT nazwa_norm) >= 1
), ranking AS (
  SELECT u.ulic_id, u.simc, u.sym_ul, u.zrodlo, u.liczba_punktow,
         row_number() OVER (PARTITION BY u.simc, u.sym_ul
                            ORDER BY u.liczba_punktow DESC, u.ulic_id) AS poz
    FROM adres.ulica u JOIN grupy g ON g.simc = u.simc AND g.sym_ul = u.sym_ul
   WHERE u.wycofany_od IS NULL
)
SELECT r.ulic_id AS znika,
       z.ulic_id AS zostaje
  FROM ranking r
  JOIN ranking z ON z.simc = r.simc AND z.sym_ul = r.sym_ul AND z.poz = 1
 WHERE r.poz > 1;

CREATE INDEX ON _scalenie(znika);

-- ---------------------------------------------------------------------
-- 3. Zapamietanie nazw z TERYT - PRZED usunieciem wierszy
-- ---------------------------------------------------------------------
-- Precedencja: nazwa i cecha pochodza z TERYT (urzedowy rejestr nazw).
--
-- Nazwy tylko ZAPAMIETUJEMY, a przypisujemy dopiero po usunieciu duplikatow
-- (krok 7). Przypisanie ich tutaj laduje wprost w kolizji: wiersz, ktory
-- przezyje, dostawalby (simc, nazwa_norm, cecha) identyczne z wpisem TERYT,
-- ktory w tym momencie jeszcze istnieje. Na tym polegla druga proba migracji.
CREATE TEMP TABLE _nazwy AS
SELECT DISTINCT ON (s.zostaje)
       s.zostaje, t.nazwa, t.nazwa_norm, t.cecha, t.nazwa_skroc, t.nazwa_skroc_norm
  FROM _scalenie s
  JOIN adres.ulica t ON t.ulic_id = s.znika AND t.zrodlo = 'teryt'
 ORDER BY s.zostaje, t.ulic_id;

CREATE INDEX ON _nazwy(zostaje);

-- ---------------------------------------------------------------------
-- 4. Przepiecie punktow adresowych - MUSI poprzedzac usuniecie
-- ---------------------------------------------------------------------
UPDATE adres.punkt_adresowy p
   SET ulic_id = s.zostaje
  FROM _scalenie s
 WHERE p.ulic_id = s.znika;

-- ---------------------------------------------------------------------
-- 5. Usuniecie wierszy nadmiarowych
-- ---------------------------------------------------------------------
DELETE FROM adres.ulica u USING _scalenie s WHERE u.ulic_id = s.znika;

-- ---------------------------------------------------------------------
-- 6. Zdjecie starego klucza unikatowego — MOZLIWIE POZNO
-- ---------------------------------------------------------------------
-- Klucz `(simc, nazwa_norm, cecha)` jest zrodlem problemu, a nie jego ofiara:
-- obejmuje `cecha`, ktora TERYT wypelnia, a PRG zostawia pusta, wiec ten sam
-- obiekt wchodzi dwa razy. Dodatkowo `cecha` bywa NULL, a w SQL NULL <> NULL -
-- wiec dwa wpisy z PRG o tej samej nazwie i pustej cesze rowniez nie koliduja.
--
-- ALTER TABLE bierze ACCESS EXCLUSIVE i trzyma go DO KONCA TRANSAKCJI, blokujac
-- kazdego czytelnika tabeli. W pierwszej wersji stal na poczatku migracji
-- i zamrozil endpoint /metrics na godzine - kolejne zbierania metryk pietrzyly
-- sie w kolejce po blokade. Dlatego stoi tu, za dlugim DELETE, ktory sam
-- potrzebuje tylko ROW EXCLUSIVE i czytelnikow nie blokuje.
ALTER TABLE adres.ulica DROP CONSTRAINT IF EXISTS ulica_simc_nazwa_norm_cecha_key;

-- ---------------------------------------------------------------------
-- 7. Przypisanie nazw z TERYT zapamietanych w kroku 3
-- ---------------------------------------------------------------------
UPDATE adres.ulica z
   SET nazwa      = n.nazwa,
       nazwa_norm = n.nazwa_norm,
       cecha      = COALESCE(n.cecha, z.cecha),
       nazwa_skroc      = COALESCE(n.nazwa_skroc, z.nazwa_skroc),
       nazwa_skroc_norm = COALESCE(n.nazwa_skroc_norm, z.nazwa_skroc_norm)
  FROM _nazwy n
 WHERE z.ulic_id = n.zostaje;

-- ---------------------------------------------------------------------
-- 8. Wydzielenie slowa rodzajowego z nazwy do kolumny cechy (6.22)
-- ---------------------------------------------------------------------
-- Dopiero TERAZ, gdy duplikaty juz nie istnieja. Lista slow domknieta
-- i celowo krotka: pomijamy wyrazy, ktore bywaja czescia nazwy wlasnej
-- ("Aleje Jerozolimskie", "Rynek").
CREATE TEMP TABLE _rodzajowe(slowo text PRIMARY KEY, skrot text);
INSERT INTO _rodzajowe VALUES
  ('ulica','ul.'), ('aleja','al.'), ('plac','pl.'), ('osiedle','os.'),
  ('rondo','rondo'), ('skwer','skwer'), ('bulwar','bulw.'), ('droga','droga'),
  ('szosa','szosa');

UPDATE adres.ulica u
   SET cecha      = COALESCE(u.cecha, r.skrot),
       nazwa      = regexp_replace(u.nazwa, '^\S+\s+', ''),
       nazwa_norm = regexp_replace(u.nazwa_norm, '^\S+\s+', '')
  FROM _rodzajowe r
 WHERE u.wycofany_od IS NULL
   AND lower(split_part(u.nazwa, ' ', 1)) = r.slowo
   AND position(' ' in u.nazwa) > 0;

-- ---------------------------------------------------------------------
-- 9. Przeliczenie licznikow punktow na wierszach, ktore zostaly
-- ---------------------------------------------------------------------
UPDATE adres.ulica u
   SET liczba_punktow = COALESCE(x.n, 0)
  FROM (SELECT ulic_id, count(*) n FROM adres.punkt_adresowy
         WHERE wycofany_od IS NULL AND ulic_id IS NOT NULL GROUP BY 1) x
 WHERE u.ulic_id = x.ulic_id AND u.liczba_punktow <> x.n;

-- ---------------------------------------------------------------------
-- 10. Nowy klucz unikatowy - po identyfikatorze, nie po nazwie
-- ---------------------------------------------------------------------
-- Zeby ta klasa bledu przestala byc mozliwa, a nie tylko zostala posprzatana.
-- Klucz czesciowy, bo 132 wiersze nie maja sym_ul i nie da sie ich tak objac.
CREATE UNIQUE INDEX IF NOT EXISTS ulica_simc_symul_key
  ON adres.ulica(simc, sym_ul) WHERE sym_ul IS NOT NULL AND wycofany_od IS NULL;

-- Wsrod wierszy bez sym_ul rowniez sa duplikaty - te same nazwy w tej samej
-- miejscowosci, przewaznie z zerem punktow. Klucza katalogowego nie maja, wiec
-- dla nich nazwa JEST jedynym dostepnym kluczem. Scalamy ta sama metoda.
CREATE TEMP TABLE _scalenie_bez_symul AS
WITH ranking AS (
  SELECT ulic_id, simc, nazwa_norm, cecha,
         row_number() OVER (PARTITION BY simc, nazwa_norm, cecha
                            ORDER BY liczba_punktow DESC, ulic_id) AS poz
    FROM adres.ulica
   WHERE wycofany_od IS NULL AND sym_ul IS NULL
)
SELECT r.ulic_id AS znika, z.ulic_id AS zostaje
  FROM ranking r
  JOIN ranking z ON z.simc = r.simc AND z.nazwa_norm = r.nazwa_norm
                AND z.cecha IS NOT DISTINCT FROM r.cecha AND z.poz = 1
 WHERE r.poz > 1;

UPDATE adres.punkt_adresowy p SET ulic_id = s.zostaje
  FROM _scalenie_bez_symul s WHERE p.ulic_id = s.znika;

DELETE FROM adres.ulica u USING _scalenie_bez_symul s WHERE u.ulic_id = s.znika;

-- Dla wierszy bez sym_ul zostaje klucz po nazwie. NULLS NOT DISTINCT, bo
-- `cecha` bywa pusta, a domyslne traktowanie NULL jako wartosci roznych od
-- siebie jest wlasnie tym, co pozwolilo duplikatom powstac.
CREATE UNIQUE INDEX IF NOT EXISTS ulica_simc_nazwa_bez_symul_key
  ON adres.ulica(simc, nazwa_norm, cecha) NULLS NOT DISTINCT
  WHERE sym_ul IS NULL AND wycofany_od IS NULL;

-- ---------------------------------------------------------------------
-- 11. Weryfikacja
-- ---------------------------------------------------------------------
SELECT 'ulic przed'            AS miara, ulic::text            AS wartosc FROM _przed
UNION ALL SELECT 'ulic po',          (SELECT count(*)::text FROM adres.ulica WHERE wycofany_od IS NULL)
UNION ALL SELECT 'scalonych',        (SELECT count(*)::text FROM _scalenie)
UNION ALL SELECT 'punktow przed',    (SELECT punktow::text FROM _przed)
UNION ALL SELECT 'punktow po',       (SELECT count(*)::text FROM adres.punkt_adresowy WHERE wycofany_od IS NULL)
UNION ALL SELECT 'z ulica przed',    (SELECT punktow_z_ulica::text FROM _przed)
UNION ALL SELECT 'z ulica po',       (SELECT count(*)::text FROM adres.punkt_adresowy WHERE wycofany_od IS NULL AND ulic_id IS NOT NULL)
UNION ALL SELECT 'osieroconych ulic_id', (SELECT count(*)::text FROM adres.punkt_adresowy p
                                           WHERE p.ulic_id IS NOT NULL
                                             AND NOT EXISTS (SELECT 1 FROM adres.ulica u WHERE u.ulic_id = p.ulic_id))
UNION ALL SELECT 'ulic z zerem punktow',  (SELECT count(*)::text FROM adres.ulica WHERE wycofany_od IS NULL AND liczba_punktow = 0)
UNION ALL SELECT 'pozostale duplikaty (simc,sym_ul)',
                 (SELECT coalesce(sum(n-1),0)::text FROM (SELECT count(*) n FROM adres.ulica
                    WHERE wycofany_od IS NULL AND sym_ul IS NOT NULL GROUP BY simc, sym_ul HAVING count(*)>1) q)
UNION ALL SELECT 'grupy o niezgodnym sym_ul (zostawione)',
                 (SELECT count(*)::text FROM (SELECT 1 FROM adres.ulica WHERE wycofany_od IS NULL AND sym_ul IS NOT NULL
                    GROUP BY simc, nazwa_norm HAVING count(DISTINCT sym_ul) > 1) q)
UNION ALL SELECT 'wiersze bez sym_ul (zostawione)',
                 (SELECT count(*)::text FROM adres.ulica WHERE wycofany_od IS NULL AND sym_ul IS NULL);
