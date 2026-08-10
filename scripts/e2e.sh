#!/usr/bin/env bash
#
# Test end-to-end calego pipeline'u na fixture'ach.
# Nie wymaga dostepu do internetu ani zadnych kluczy - wszystko lokalnie.
#
# Wymaga: dzialajacego PostgreSQL z PostGIS (docker compose up -d db)
#
#   ./scripts/e2e.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

# OSOBNA BAZA I OSOBNE KATALOGI Z DEFINICJI, a nie przez pamietanie o tym.
#
# Ten skrypt robi TRUNCATE na schemacie address i przestawia wskaznik artefaktu.
# Domyslka wskazywala kiedys baze `adres` i katalog ./data/index - czyli komplet
# krajowy (8,6 mln punktow) i artefakt 57 MB. Jedno uruchomienie bez ustawionych
# zmiennych kasowalo dorobek ~3 h 25 min przetwarzania, a kopii stanu po
# migracji 005 nie ma.
: "${DATABASE_URL:=postgres://adres:adres@localhost:5432/adres_e2e}"
export DATABASE_URL
# Fixture ma pojedyncze punkty, a prog produkcyjny to 7,5 mln.
# To parametryzacja kontroli, nie jej obejscie - patrz README.
export SANITY_MIN_POINTS=1
export ARCHIVE_ROOT="${ARCHIVE_ROOT:-./data/e2e/archive}"
export INDEX_ROOT="${INDEX_ROOT:-./data/e2e/index}"
mkdir -p "$ARCHIVE_ROOT" "$INDEX_ROOT"

ETL="node --experimental-strip-types packages/etl/src/cli.ts"
WERSJA="e2e-$(date +%Y%m%d-%H%M%S)"
FIX=packages/etl/test/fixtures

krok() { printf '\n\033[1m### %s\033[0m\n' "$*"; }

# Baza zakladana sama, zeby przebieg byl bezobslugowy takze w CI.
BAZA_ADMIN="${DATABASE_URL%/*}/postgres"
NAZWA_BAZY="${DATABASE_URL##*/}"; NAZWA_BAZY="${NAZWA_BAZY%%\?*}"
if ! psql "$BAZA_ADMIN" -tAc \
     "SELECT 1 FROM pg_database WHERE datname = '$NAZWA_BAZY'" | grep -q 1; then
  printf '# zakladam baze %s\n' "$NAZWA_BAZY"
  psql "$BAZA_ADMIN" -q -c "CREATE DATABASE \"$NAZWA_BAZY\""
fi

# STRAZNIK. Domyslka wskazuje baze testowa, ale DATABASE_URL mozna nadpisac -
# a wtedy TRUNCATE nizej idzie tam, gdzie kazano. Zmienna srodowiskowa ustawiona
# do czegos innego pol godziny wczesniej to za cienka ochrona dla zbioru,
# ktorego odtworzenie trwa ponad trzy godziny. Prog jest luzny celowo: chodzi
# o odroznienie fixture'a od kompletu, a nie o dokladna liczbe.
PUNKTY=$(psql "$DATABASE_URL" -tAc "
  SELECT CASE WHEN to_regclass('address.address_point') IS NULL THEN 0
              ELSE (SELECT count(*) FROM address.address_point) END" 2>/dev/null || echo 0)
if [ "${PUNKTY:-0}" -gt 10000 ]; then
  printf '\n\033[1;31m### STOP\033[0m\n' >&2
  printf 'Baza %s ma %s punktow adresowych - to wyglada na zbior produkcyjny.\n' \
    "$NAZWA_BAZY" "$PUNKTY" >&2
  printf 'Ten skrypt robi TRUNCATE schematu address i przestawia wskaznik artefaktu.\n' >&2
  printf 'Uruchom go na osobnej bazie albo wskaz inna przez DATABASE_URL.\n' >&2
  exit 1
fi

krok "0. Migracje i czyszczenie"
# Jedna droga wgrywania schematu - ta sama, ktorej uzywa wdrozenie i CI.
# Wczesniej stala tu recznie utrzymywana sekwencja psql z osobnym krokiem
# zakladajacym ix_pa_ulic_id; rozjezdzala sie z reszta przy kazdej nowej
# migracji, a jej kolejnosc trzeba bylo pamietac.
npm run migrate --silent
# TRUNCATE, nie DELETE - przy wiekszej bazie DELETE 8,5 mln wierszy
# potrafi trwac minuty i generuje ogromna ilosc martwych krotek.
psql "$DATABASE_URL" -q -c "
  TRUNCATE staging.address_point, staging.locality, staging.street;
  TRUNCATE address.address_point, address.street, address.locality,
           address.teryt_unit, address.wmrodz, address.snapshot CASCADE;"

krok "1. TERYT - slowniki. BEZ TEGO KROKU BAZA NIE PRZYJMIE PUNKTOW"
$ETL teryt "$FIX/teryt"

krok "2. Rozpoznanie struktury GML (nowa, obowiazujaca od 1.09.2026)"
$ETL discover "$FIX/emuia-2021-sample.gml" | head -12

krok "3. Zaladowanie do obszaru przejsciowego"
$ETL load "$FIX/emuia-2021-sample.gml" --voivodeship 14 --version "$WERSJA"

krok "4. Kontrole jakosci + publikacja transakcyjna"
$ETL publish --voivodeship 14 --version "$WERSJA"

krok "5. Ta sama sciezka dla struktury DOTYCHCZASOWEJ (do 1.09.2026)"
$ETL load "$FIX/prg-2012-sample.gml" --voivodeship 14 --version "$WERSJA-stara" >/dev/null
$ETL publish --voivodeship 14 --version "$WERSJA-stara" | tail -7

krok "6. Zrodlo zapasowe - raport rozbieznosci (NIE zmienia danych produktowych)"
$ETL impa "$FIX/impa-adruni-sample.csv" --version "$WERSJA" >/dev/null
$ETL impa diff --version "$WERSJA"

krok "7. Artefakt indeksu wyszukiwania"
$ETL build-index

krok "8. Stan bazy - SPRAWDZANY, nie tylko wypisywany"
psql "$DATABASE_URL" -c "
  SELECT locality, street_type, street, building_number, postal_code, gmina, voivodeship
    FROM address.full_address ORDER BY 1,3,4;"

# Wydruk sam z siebie niczego nie pilnuje - przebieg konczyl sie na zielono
# niezaleznie od tresci. Ponizsze kontrole to zmieniaja.
#
# CZEGO TE KONTROLE NIE PILNUJA, wbrew pierwszemu wrazeniu: slownikow zrodlowych
# GML. Sprawdzone doswiadczalnie - po przetlumaczeniu klucza `ulica` na `street`
# przebieg NADAL byl zielony. Powod: fixture TERYT niesie CECHA='ul.' w ULIC.csv
# i RM=96 w SIMC.csv, a TERYT ma pierwszenstwo przed PRG, wiec te dwa pola sa tu
# ustawiane z katalogu, nie ze slownika GML. Straznikiem slownikow jest osobny
# zestaw: packages/etl/test/gml-dictionaries.ts.
#
# Zostaje realna wartosc: publikacja cokolwiek wniosla, wiersz wzorcowy jest
# w komplecie pol, a cechy i rodzaje nie sa masowo puste.
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -q -c "
DO \$\$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM address.full_address;
  IF n = 0 THEN
    RAISE EXCEPTION 'Widok full_address jest pusty - publikacja nic nie wniosla.';
  END IF;

  -- Wiersz wzorcowy z fixture'a, w komplecie pol.
  SELECT count(*) INTO n FROM address.full_address
   WHERE locality = 'Warszawa' AND street = 'Tadeusza Kościuszki'
     AND street_type = 'ul.' AND building_number = '12A'
     AND postal_code = '00-950' AND voivodeship = 'Mazowieckie';
  IF n <> 1 THEN
    RAISE EXCEPTION 'Brak wiersza wzorcowego (Warszawa/Tadeusza Kosciuszki/12A) - jest %', n;
  END IF;

  -- Cecha dociera do widoku. W tym przebiegu pochodzi z katalogu ULIC, wiec
  -- kontrola pilnuje polaczenia ulica-cecha i samego widoku, a NIE slownika GML.
  SELECT count(*) INTO n FROM address.full_address
   WHERE street IS NOT NULL AND (street_type IS NULL OR street_type = '');
  IF n > 0 THEN
    RAISE EXCEPTION 'Ulic bez cechy: %', n;
  END IF;

  -- Rodzaj miejscowosci dociera z SIMC (kolumna RM). Jak wyzej: kontrola
  -- sciezki katalog -> baza, nie slownika AD_RodzajMiejscowosci.
  SELECT count(*) INTO n FROM address.locality
   WHERE withdrawn_at IS NULL AND kind IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'Miejscowosci bez rodzaju: %', n;
  END IF;

  RAISE NOTICE 'Kontrole tresci: OK';
END \$\$;"

printf '\n\033[1;32m### OK - pipeline przeszedl dla obu struktur GML\033[0m\n'
printf '\nUruchom serwis:\n'
printf '  INDEX_SOURCE=%s/current.bin npm run api\n' "$INDEX_ROOT"
printf 'i sprawdz:\n'
printf '  curl "localhost:3000/v1/suggest?q=kosciuszki"\n'
printf '  curl -X POST localhost:3000/v1/validate -H "content-type: application/json" \\\n'
printf '       -d %s\n\n' "'{\"raw\":\"ul. Kosciuszki 12A, 00-950 Warszawa\"}'"
