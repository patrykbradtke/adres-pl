# Stan prac — przekazanie do kolejnej sesji

Dokument zamyka sesję z 6–7 sierpnia 2026. Opisuje **stan faktyczny**:
co działa, co naprawiono, jakie są pułapki i od czego zacząć.
Plan zadań: [plan-produkcyjny.md](plan-produkcyjny.md).

---

## 1. Co działa teraz

| element | stan |
|---|---|
| Baza PostgreSQL 17 + PostGIS | działa w kontenerze `adres-pl-db-1` |
| Słowniki TERYT | 4360 jednostek, 101 865 miejscowości, 308 888 ulic |
| Punkty adresowe | **1 990 483** opublikowane (4 województwa: 08, 14, 16, 20) |
| Powiązanie z ulicami | 1 324 563 punkty — 100% tych, które miały referencję |
| Katalog ulic | 385 436 (308 888 TERYT + reszta z PRG) |
| Artefakt wyszukiwania | 487 301 pozycji, 66,4 MB, budowa 208 s |
| API | `localhost:3000`, 11 endpointów `/v1/*` + 4 operacyjne (`/health`, `/ready`, `/metrics`, `/status`), wersja danych `2026-08-06` |
| Archiwum PRG | **16 z 16 województw**, 1,8 GB, `data/archive/prg/2026-08-06/` |
| Archiwum TERYT | `data/archive/teryt/2026-08-06/` (TERC/SIMC/ULIC/WMRODZ w CSV) |

**Zakres danych: ~23% kraju.** Pozostałe 12 województw jest pobranych, ale
nieprzetworzonych — to pierwsze zadanie z planu (etap 1.1).

---

## 2. Środowisko — istotne ograniczenia

| rzecz | stan |
|---|---|
| Node | **22.23.2** przez nvm (`nvm alias default 22` ustawiony) |
| macOS | 12 (Monterey), Intel. **Homebrew nie zbuduje nowych formuł** — Command Line Tools za stare, naprawa wymaga `sudo` |
| `psql` | jest, ale **poza PATH**: `/usr/local/opt/libpq/bin/psql` |
| Docker | Desktop 28.0.4, 8 rdzeni, 7,75 GB RAM |
| git | `patrykbradtke/adres-pl` (prywatne), gałąź `master` |

**Uwaga o Dockerze:** przy trzech równoległych kontenerach plus ładowaniu
Docker Desktop raz podniósł bazę od zera (wolumen wyczyszczony, migracje
uruchomione ponownie), co skasowało 20-minutowy import. Przy dłuższych
przebiegach warto ograniczyć liczbę równoczesnych kontenerów.

---

## 3. Naprawione w tej sesji

Pięć usterek — **żadnej nie dało się wykryć na danych testowych**.

| # | usterka | gdzie | skutek przed naprawą |
|---|---|---|---|
| 1 | Dekodowanie każdego chunku osobno rozcinało znaki wielobajtowe | `gml/parser.ts` | uszkodzone polskie nazwy (1 na województwo, ciche) |
| 2 | Wyłuskiwanie cyfr z identyfikatora IIP zamiast SIMC z obiektu | `002_staging.sql`, `resolve_refs()` | publikacja przerywana błędem `character(7)` |
| 3 | Duplikaty w słownikach źródłowych | `002_staging.sql`, `publikuj_zrzut()` | `ON CONFLICT ... cannot affect row a second time` |
| 4 | `OR` łączący porównanie kolumn z porównaniem wyniku funkcji | `002_staging.sql`, wiązanie punktów z ulicami | pętla zagnieżdżona, ~102 mld porównań, **8 h bez końca** |
| 5 | Wstawianie słowników TERYT wiersz po wierszu | `db/load-teryt.ts` | 20+ min i zerwane połączenie; po zmianie na `COPY` — 489 s |

Poza tym: naprawiony niekompletny `package-lock.json`, dodany `.dockerignore`,
`build-index` tworzy teraz stabilną nazwę `current.bin`, loader API czyta
wskaźnik wersji już przy starcie, dodano `ANALYZE` po masowym wstawieniu.

**Zacommitowane i wypchnięte** — prywatne repozytorium
`patrykbradtke/adres-pl`, 68 plików. Katalog `data/` wykluczony z historii:
1,8 GB archiwów i zrzut bazy odtwarza się z zewnątrz albo z kopii zapasowej.

---

## 4. Wydajność — zmierzone wartości

| co | wynik |
|---|---|
| Parsowanie punktów adresowych | 902 rek/s |
| Parsowanie miejscowości i ulic | ~460 rek/s (więcej pól na rekord) |
| Cztery procesy równolegle | 3266 rek/s łącznie — **3,6×** |
| `load` mazowieckiego (1,27 mln punktów) | ~38 min |
| Import TERYT (400 tys. rekordów) | 489 s |
| Publikacja 4 województw | 72 min |
| Budowa artefaktu | 208 s |
| Wyszukiwanie — mediana | **~4 ms** (nie 0,49 ms jak w raporcie — to był zbiór syntetyczny) |
| Wyszukiwanie — najgorszy przypadek | 42 ms („Nowa Wieś”) |

Zrównoleglenie: `cycle --rownolegle N` lub `ETL_ROWNOLEGLE`. Domyślnie 1.
Koszt ~400 MB RAM na proces — dobierać do pamięci, nie do liczby rdzeni.

---

## 5. Pułapki, o których trzeba wiedzieć

**TERYT przez usługę sieciową GUS nie działa.** Żadne zapytanie SOAP nie
dostaje odpowiedzi (sprawdzone: 30 s, 60 s, 180 s), przy działającym pobraniu
opisu usługi w 2,2 s. Konto produkcyjne: zgłoszenie na `teryt_ws1@stat.gov.pl`.
**Nie jest potrzebne** — te same katalogi pobiera bez konta skrypt
`scripts/teryt-pobierz-pliki.mjs` (odtwarza formularz eteryt). Uwaga: brać
warianty **CSV**, nie XML — parser obsługuje wyłącznie CSV ze średnikami.

**Próg kontroli jakości.** `publish` domyślnie wymaga 7,5 mln punktów (cały
kraj). Przy podzbiorze użyć `SANITY_MIN_POINTS`. To nie jest obejście
zabezpieczenia, tylko jego parametryzacja — przy pełnym kraju zostawić domyślny.

**Sondaż HTTP jest bezużyteczny.** Serwer GUGiK nie zwraca `ETag` ani
`Last-Modified` dla żadnego z 16 województw. Wykrywanie zmian musi opierać się
na sumie kontrolnej pobranego pliku.

**Nowa struktura GML (od 1.09.2026) działa.** Przestrzeń nazw
`https://geoportal.gov.pl/schemas/prgad/1.0`, zero rekordów odrzuconych.
Sierpniowa paczka zawiera **równolegle** plik w starej i nowej strukturze —
archiwum zabezpiecza obie.

**Migracje.** Wykonują się wyłącznie przy inicjalizacji kontenera bazy.
Zmiany w `002_staging.sql` trzeba wgrywać ręcznie:
`psql "$DATABASE_URL" -f db/migrations/002_staging.sql`. Brak narzędzia do
wersjonowania schematu to luka wskazana w planie.

**API nie ma uwierzytelniania.** Nagłówek `x-api-key` służy wyłącznie jako
klucz limitowania zapytań — nikt go nie weryfikuje. Przed produkcją: etap 6.1.

---

## 6. Jak uruchomić

```bash
# baza
docker compose up -d db

# pełny cykl na pozostałych województwach, 4 procesy naraz
docker compose run --rm etl cycle --z-archiwum 2026-08-06 --rownolegle 4

# publikacja i artefakt
docker compose run --rm etl publish --wersja 2026-08-06
docker compose run --rm etl build-index

# serwis
docker compose up -d api
curl "localhost:3000/v1/suggest?q=marszalkowska"
```

Lokalnie (Node 22 jest już domyślny) zadziała też `npm run etl -- ...`
i `./scripts/e2e.sh` — ten drugi wymaga `psql` w PATH:
`export PATH="/usr/local/opt/libpq/bin:$PATH"`.

Narzędzia pomocnicze w `scripts/`:
- `teryt-pobierz-pliki.mjs <katalog>` — pobiera katalogi TERYT bez konta w GUS
- `pobierz-wszystkie-woj.sh` — kolejka pobrania archiwów PRG, pomija już pobrane
- `e2e.sh` — test całej ścieżki na fixture'ach

---

## 7. Dokumenty

| plik | zawartość |
|---|---|
| `docs/plan-produkcyjny.md` | **plan zadań** — od tego zacząć |
| `docs/STAN-PRAC.md` | ten dokument |
| `docs/raport/raport-baza-mikroserwis-v1.3.docx` | raport dla analityków i klienta |
| `docs/build-report.js` | **generator raportu** — źródło prawdy, `npm run raport` |
| `README.md` | dokumentacja techniczna, zaktualizowane czasy przebiegów |

Raport dla analityków jest w wersji **1.3**. Wydanie 1.3 uzgadnia treść ze stanem
repozytorium: koryguje zakres mikroserwisu, oznacza Redis i magazyn obiektowy jako
niewdrożone, ujawnia cztery braki blokujące produkcję (uwierzytelnianie, kopie
zapasowe poza maszyną, brak odbiorcy metryk, 4 z 16 województw) i przepisuje plan
prac na 11–15 tygodni. Wszystkie wydania leżą w `docs/raport/`.

**Plik .docx powstaje wyłącznie z `docs/build-report.js`** (`npm run raport`).
Ręcznych poprawek w Wordzie nie wprowadzać — znikają przy kolejnym przebiegu.
Wydania 1.1 i 1.2 powstały poza tym generatorem, dlatego stał on na treści 1.0
aż do 8.08.2026; teraz jest z dokumentem zsynchronizowany.

---

## 8. Od czego zacząć w nowej sesji

1. **Etap 0 — wykonany.** Repozytorium prywatne `patrykbradtke/adres-pl`,
   cztery commity, katalog `data/` poza historią.
2. **Etap 1.1** — dołożyć 12 pozostałych województw. Dane są na dysku, więc to
   samo przetwarzanie: ~1–1,5 h przy `--rownolegle 4`.
3. Dalej wg `plan-produkcyjny.md`. Etap 8 (komercjalizacja) został dopisany
   7.08.2026 na podstawie rozpoznania: klucze API z terminem ważności
   i licencjami, model wielodostępności, kopie zapasowe poza maszyną.
   Zadanie 8.1 warto wykonać niezależnie od reszty — to ćwierć dnia,
   a zamyka czynną lukę w limitowaniu zapytań.

Odtworzenie bazy bez ponownego przetwarzania — z kopii w `data/backup/`:

```bash
docker compose exec -T db pg_restore -U adres -d adres --clean --if-exists \
  < data/backup/adres-2026-08-07.dump
```

Ustalenia dotyczące technologii (uzasadnienie w planie): serwis danych zostaje
na Fastify bez ORM; NestJS i ewentualnie Drizzle rozważyć wyłącznie dla
back-endu panelu administracyjnego, który powstanie w Angularze jako SPA
z autoryzacją — planowany osobno, po etapach 4 i 5.
