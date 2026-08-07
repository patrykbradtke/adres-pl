#!/usr/bin/env bash
# Kolejka pobrania pozostalych wojewodztw PRG do tej samej wersji zrzutu,
# co juz pobrane mazowieckie (14). Sekwencyjnie - rownolegle pobieranie
# 16 plikow po ~100 MB tylko rozjezdza laczE i utrudnia wznowienie.
#
# `etl download` nadpisuje plik bezwarunkowo, wiec pomijanie juz pobranych
# robimy tutaj - dzieki temu skrypt mozna wznowic po przerwaniu.
set -uo pipefail
cd /Users/pro/adres-pl

WERSJA=2026-08-06
KODY=(02 04 06 08 10 12 16 18 20 22 24 26 28 30 32)   # bez 14 - juz mamy

echo "### Kolejka PRG, wersja $WERSJA, $((${#KODY[@]})) wojewodztw"
echo "### start: $(date +%H:%M:%S)"

ok=0; pominiete=0; bledy=()
for kod in "${KODY[@]}"; do
  plik="data/archive/prg/$WERSJA/${kod}_Punkty_Adresowe.zip"
  if [ -s "$plik" ]; then
    echo "[$kod] pominiete - juz w archiwum ($(du -h "$plik" | cut -f1))"
    pominiete=$((pominiete+1)); continue
  fi
  echo "[$kod] $(date +%H:%M:%S) pobieram..."
  if docker compose run --rm --no-TTY etl download --woj "$kod" --wersja "$WERSJA" 2>&1 | grep -v "Container adres-pl-db-1"; then
    ok=$((ok+1))
  else
    echo "[$kod] BLAD"; bledy+=("$kod")
  fi
done

echo
echo "### koniec: $(date +%H:%M:%S)"
echo "### pobrane: $ok | pominiete: $pominiete | bledy: ${bledy[*]:-brak}"
du -sh data/archive/prg/$WERSJA
ls data/archive/prg/$WERSJA | wc -l | xargs echo "plikow w zrzucie:"
