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

: "${DATABASE_URL:=postgres://adres:adres@localhost:5432/adres}"
export DATABASE_URL
# Fixture ma pojedyncze punkty, a prog produkcyjny to 7,5 mln.
# To parametryzacja kontroli, nie jej obejscie - patrz README.
export SANITY_MIN_POINTS=1
export ARCHIVE_ROOT="${ARCHIVE_ROOT:-./data/archive}"
export INDEX_ROOT="${INDEX_ROOT:-./data/index}"

ETL="node --experimental-strip-types packages/etl/src/cli.ts"
WERSJA="e2e-$(date +%Y%m%d-%H%M%S)"
FIX=packages/etl/test/fixtures

krok() { printf '\n\033[1m### %s\033[0m\n' "$*"; }

krok "0. Migracje i czyszczenie"
# ON_ERROR_STOP=1: bez tego psql konczy sie kodem 0 mimo bledow w srodku pliku,
# a `set -e` na gorze skryptu nie ma czego zlapac.
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -q -f db/migrations/001_init.sql
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -q -f db/migrations/002_staging.sql
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -q -f db/migrations/003_licencje.sql
# TRUNCATE, nie DELETE - przy wiekszej bazie DELETE 8,5 mln wierszy
# potrafi trwac minuty i generuje ogromna ilosc martwych krotek.
psql "$DATABASE_URL" -q -c "
  TRUNCATE staging.punkt_adresowy, staging.miejscowosc, staging.ulica;
  TRUNCATE adres.punkt_adresowy, adres.ulica, adres.miejscowosc,
           adres.teryt_jednostka, adres.wmrodz, adres.zrzut CASCADE;"

krok "1. TERYT - slowniki. BEZ TEGO KROKU BAZA NIE PRZYJMIE PUNKTOW"
$ETL teryt "$FIX/teryt"

krok "2. Rozpoznanie struktury GML (nowa, obowiazujaca od 1.09.2026)"
$ETL discover "$FIX/emuia-2021-sample.gml" | head -12

krok "3. Zaladowanie do obszaru przejsciowego"
$ETL load "$FIX/emuia-2021-sample.gml" --woj 14 --wersja "$WERSJA"

krok "4. Kontrole jakosci + publikacja transakcyjna"
$ETL publish --woj 14 --wersja "$WERSJA"

krok "5. Ta sama sciezka dla struktury DOTYCHCZASOWEJ (do 1.09.2026)"
$ETL load "$FIX/prg-2012-sample.gml" --woj 14 --wersja "$WERSJA-stara" >/dev/null
$ETL publish --woj 14 --wersja "$WERSJA-stara" | tail -7

krok "6. Zrodlo zapasowe - raport rozbieznosci (NIE zmienia danych produktowych)"
$ETL impa "$FIX/impa-adruni-sample.csv" --wersja "$WERSJA" >/dev/null
$ETL impa diff --wersja "$WERSJA"

krok "7. Artefakt indeksu wyszukiwania"
$ETL build-index

krok "8. Stan bazy"
psql "$DATABASE_URL" -c "
  SELECT miejscowosc, cecha, ulica, nr_budynku, kod_pocztowy, gmina, wojewodztwo
    FROM adres.adres_pelny ORDER BY 1,3,4;"

printf '\n\033[1;32m### OK - pipeline przeszedl dla obu struktur GML\033[0m\n'
printf '\nUruchom serwis:\n'
printf '  INDEX_SOURCE=%s/current.bin npm run api\n' "$INDEX_ROOT"
printf 'i sprawdz:\n'
printf '  curl "localhost:3000/v1/suggest?q=kosciuszki"\n'
printf '  curl -X POST localhost:3000/v1/validate -H "content-type: application/json" \\\n'
printf '       -d %s\n\n' "'{\"raw\":\"ul. Kosciuszki 12A, 00-950 Warszawa\"}'"
