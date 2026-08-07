# adres-pl — baza i mikroserwis adresowy dla Polski

Własna baza adresowa zbudowana na PRG (GUGiK) i TERYT (GUS), serwowana przez
bezstanowy mikroserwis Node z indeksem trzymanym w pamięci procesu.

```
packages/
  core/          @adres-pl/core          izomorficzny TS, zero zależności
                                         typy · normalizacja · parser · walidatory
  index-format/  @adres-pl/index-format  format binarny artefaktu indeksu
  etl/           @adres-pl/etl           pobieranie · parsery · sanity · orkiestracja
  api/           @adres-pl/api           Fastify: typeahead · walidacja · metryki
db/migrations/   schemat PostgreSQL + PostGIS
deploy/          CronJob dla Kubernetes + reguły alertów Prometheusa
scripts/e2e.sh   test całego pipeline'u na fixture'ach
```

## Polecenia

```bash
# słowniki TERYT — PIERWSZY krok, bez nich baza nie przyjmie punktów
npm run etl -- teryt test              # sprawdź połączenie z usługą GUS
npm run etl -- teryt pobierz           # pobierz katalogi do archiwum
npm run etl -- teryt <katalog>         # załaduj do bazy

# dane adresowe PRG
npm run etl -- probe                   # czy źródło się zmieniło (tanio)
npm run etl -- download --all          # pobierz do archiwum
npm run etl -- discover <plik>         # rozpoznaj strukturę nieznanego GML
npm run etl -- parse <plik>            # statystyki bez zapisu do bazy
npm run etl -- load <plik> --woj 14    # do obszaru przejściowego
npm run etl -- check                   # kontrole jakości
npm run etl -- publish --woj 14        # kontrole + atomowa podmiana
npm run etl -- build-index             # artefakt wyszukiwania

# PEŁNY CYKL bez nadzoru — to uruchamia CronJob
npm run etl -- cycle
npm run etl -- cycle --dry-run                 # bez publikacji
npm run etl -- cycle --z-archiwum 2026-08-06   # ponownie z archiwum, bez pobierania

# źródło zapasowe
npm run etl -- impa discover <plik>    # rozpoznaj układ kolumn
npm run etl -- impa <plik>             # do tabeli porównawczej
npm run etl -- impa diff               # raport: czego PRG nie ma
```

---

## ⏰ Zanim zaczniecie: 1 września 2026

**GUGiK przestaje wtedy publikować GML PRG w dotychczasowej strukturze.**
Format SHP przeszedł na nową strukturę już 1 lipca 2026.

Nowa struktura **traci trzy atrybuty**, które są w tym projekcie używane:

| Atrybut | Do czego służył | Co robimy |
|---|---|---|
| `status` | filtr punktów prognozowanych (adres nadany, budynku nie ma) | zamrożony snapshot w kolumnie `punkt_adresowy.status` |
| `numerLokalu` | — | i tak traktujemy numer lokalu jako wolny tekst |
| `jednostkaAdministracyjna` | przynależność woj./pow./gmina | wyprowadzamy joinem po SIMC z TERYT |

**Zróbcie to w tym tygodniu:**

```bash
npm run etl -- download --all --wersja 2026-08-ostatni-stary
# archiwum trafia do data/archive/prg/<wersja>/ i zostaje na zawsze
```

To jedyna okazja, żeby mieć `status` jako dane historyczne.

---

## Nieznany namespace — i co z tego wynika

Namespace URI nowego schematu EMUiA 2021 **nie jest publicznie udokumentowany**,
a GUGiK jest w tym niekonsekwentny. Z kodu jego własnego walidatora
(`WalidatorPlikowGML/utils.py`) widać, że schematy z rozporządzeń 2021 rozeszły
się w trzy strony:

```
egb -> ewidencjaGruntowIBudynkow:1.0                          (bez urn:, dodane "I")
ges -> geodezyjnaEwidencjaSieciUzbrojeniaTerenu:1.0           (bez urn:)
ot  -> bazaDanychObiektowTopograficznych500:1.0               (bez urn:)
ot  -> urn:gugik:...:bazaDanychObiektowTopograficznych10k:2.0 (z urn:, wersja 2.0)
```

Nie da się z tego wyprowadzić EMUiA. Dlatego parser **dopasowuje po local name
i ignoruje URI**, a namespace tylko loguje.

Gdy dostaniecie prawdziwy plik:

```bash
npm run etl -- discover data/archive/prg/2026-09-01/14_Punkty_Adresowe.zip
```

Dostaniecie faktyczne namespace'y, nazwy feature'ów, ścieżki pól i przykładowe
wartości. Poprawienie profilu w `packages/etl/src/gml/profiles.ts` to wtedy
kwestia minut, a nie debugowania pustej bazy.

`discover` służy też jako **test regresji** — jeśli GUGiK znowu zmieni format,
pokaże to od razu.

---

## Start

Wymagania: Node ≥ 22 (tryb `--experimental-strip-types`), Docker, `psql`.
Trzy ścieżki — od najtańszej.

### A. Demo offline na fixture'ach — ok. 5 min, bez internetu i bez kont

```bash
npm install
docker compose up -d db
./scripts/e2e.sh
```

Przechodzi 8 kroków: migracje → TERYT → `discover` → `load` → `publish`
→ ta sama ścieżka dla **starej** struktury GML → raport rozbieżności iMPA
→ artefakt indeksu → stan bazy. Skrypt jest idempotentny — można go
uruchamiać wielokrotnie. Na końcu drukuje komendę startu serwisu.

### B. Test skali — ok. 15 min, też bez internetu

```bash
node --experimental-strip-types packages/etl/test/scale-test.ts
node --experimental-strip-types packages/etl/test/scale-test.ts --punktow 2000000   # szybciej
```

Generuje zbiór o wielkości realnego PRG (8,56 mln punktów) i mierzy pełną
ścieżkę na **waszym** sprzęcie. Wyniki z naszego przebiegu: [Wyniki na pełnej
skali PRG](#wyniki-na-pełnej-skali-prg).

### C. Prawdziwe dane PRG — wymaga internetu

Kolejność ma znaczenie: **TERYT musi być pierwszy**, punkty adresowe mają
klucz obcy do słowników.

```bash
psql "$DATABASE_URL" -f db/migrations/001_init.sql
psql "$DATABASE_URL" -f db/migrations/002_staging.sql

# 1. TERYT — konto testowe GUS wystarczy do próby, produkcja wymaga rejestracji
npm run etl -- teryt test
npm run etl -- teryt pobierz && npm run etl -- teryt data/archive/teryt/<data>

# 2. czy PRG się zmienił (tanio, bez pobierania 900 MB)
npm run etl -- probe

# 3. jedno województwo na próbę
npm run etl -- download --woj 14

# 4. NAJPIERW rozpoznanie — namespace nowej struktury nie jest znany z góry
npm run etl -- discover data/archive/prg/<wersja>/14_Punkty_Adresowe.zip

# 5. załadowanie, kontrole jakości, atomowa publikacja
npm run etl -- load data/archive/prg/<wersja>/14_Punkty_Adresowe.zip --woj 14
npm run etl -- publish --woj 14

# 6. artefakt wyszukiwania i serwis
npm run etl -- build-index
INDEX_SOURCE=data/index/current.bin npm run api
```

Cała Polska: `npm run etl -- cycle` (to samo uruchamia CronJob).
Rząd wielkości: ~1,8 GB pobrania (16 województw, sierpień 2026), ~3,1 GB
tabeli punktów.

Czas pierwszego przebiegu — zmierzony 6.08.2026, Docker Desktop na macOS,
8 rdzeni do dyspozycji, archiwum na wolumenie montowanym z hosta:

| co | wynik |
|---|---|
| parsowanie punktów adresowych | 902 rekordy/s |
| parsowanie miejscowości i ulic | ~460 rekordów/s (więcej pól na rekord) |
| `load` mazowieckiego (1,27 mln punktów) | ~38 min |
| cała Polska, sekwencyjnie | ~4 h |
| cała Polska, `--rownolegle 4` | ~1–1,5 h |

Parsowanie jest związane procesorem i zajmuje jeden wątek, więc opłaca się
rozdać województwa na procesy: `npm run etl -- cycle --rownolegle 4`.
Zmierzone na czterech plikach naraz: 3266 rek/s łącznie wobec 902 w jednym
procesie (3,6×), przy spadku pojedynczego procesu o 10–20%. Kosztuje ~400 MB
RAM na proces, więc dobierz wartość do pamięci poda, a nie do liczby rdzeni.

Import słowników TERYT to dodatkowe ~8 min (400 tys. rekordów).

---

## Architektura

```
PRG (GML) · TERYT · iMPA                    OSM/Geofabrik
        │                                        │
        ↓  CronJob, dziennie                     ↓ NIGDY do produktu (ODbL!)
┌──────────────────────┐              ┌──────────────────┐
│ etl (stanowy)        │              │ schemat qa_osm   │
│ probe→download→      │              │ tylko wykrywanie │
│ archiwum→SAX→staging │              │ luk i raporty QA │
│ →hash diff→sanity→   │              └──────────────────┘
│ atomowy switch       │
└───────┬──────────┬───┘
        ↓          ↓
  PostgreSQL   artefakt idx-<wersja>.bin (~50 MB)
  (prawda)     niemutowalny, wersjonowany
        │          │
        └────┬─────┘
             ↓ pobierany przy starcie / hot swap
   ┌──────────────────────────────────┐
   │ api (BEZSTANOWY, skalowany)      │
   │  indeks w RAM → typeahead 0,5 ms │
   │  Postgres     → numery 0,22 ms   │
   └──────────────────────────────────┘
```

### Dlaczego artefakt, a nie zapytania do bazy

Zmierzone na zbiorze o kształcie PRG (8,5 mln punktów):

| Podejście | p50 |
|---|---|
| `pg_trgm` + `ORDER BY similarity()` | **4 922 ms** |
| `pg_trgm` GIN, `LIKE`, zapytanie 14 znaków | 117 ms |
| SQLite FTS5 płasko, 8,5 mln | 0,4 ms (ale 196 ms przy 25 znakach) |
| **indeks w RAM, 373k etykiet** | **0,49 ms** (p95 1,11 · p99 1,84) |

Problemem jest **liczba dokumentów w korpusie, nie technologia**. Dlatego nie
indeksujemy 8,5 mln pełnych adresów, tylko 373 tys. etykiet (miejscowości +
ulice). Numery domów zostają w Postgresie — po wybraniu ulicy jest ich 20–300
i wystarczy B-tree.

Artefakt daje przy okazji: skalowanie poziome bez współdzielonego stanu,
rollback przez zmianę wskaźnika wersji, i determinizm testów regresyjnych.

### Klucze rotacyjne

Użytkownik pisze `Kościuszki`, a etykieta zaczyna się od `ul. Tadeusza`.
Wyszukiwanie podciągu to 2,7–4,3 ms brute force; wyszukiwanie prefiksu przez
binary search to 2–10 **mikro**sekund. Więc dla każdej etykiety generujemy
klucze zaczynające się od każdego kolejnego tokenu:

```
ul. Tadeusza Kościuszki, Warszawa
  → "tadeusza kosciuszki warszawa"
  → "kosciuszki warszawa"
  → "warszawa"
```

Drogi problem podciągu zamienia się w tani problem prefiksu.

---

## Stack — co i dlaczego

| | Werdykt | Uzasadnienie |
|---|---|---|
| **PostgreSQL + PostGIS** | tak | Źródło prawdy. Dane adresowe są ściśle relacyjne i przestrzenne. |
| **Redis** | tak, ale nie do wyszukiwania | Rate limiting, cache reverse-geocoding, pub/sub o nowej wersji artefaktu. Typeahead go nie potrzebuje. |
| **RabbitMQ** | dopiero przy walidacji wsadowej | Do ETL wystarczy CronJob. Nie dodawajcie brokera „na zapas". |
| **MongoDB** | nie | Brak przypadku użycia. Tracicie integralność referencyjną, którą model adresowy realnie wykorzystuje. |
| Meilisearch / Typesense / Elastic | nie w wersji 1 | Dodają kontener i RAM do problemu, który rozwiązuje 50 MB w procesie. Meilisearch zmienił licencję w 2025 na dualny MIT/BUSL-1.1. |

---

## 🔴 Pułapka licencyjna — OSM i ODbL

**PRG jest czysty.** Art. 40a ust. 2 pkt 1 lit. a Prawa geodezyjnego —
nieodpłatny. Art. 40c ust. 5 — *„Licencji nie wydaje się"*. Art. 40c ust. 3 —
jedyny obowiązek to podanie źródła. Wolno komercyjnie, wolno redystrybuować.

**OSM to ODbL z klauzulą share-alike.** Wmieszanie danych OSM do produktowej
bazy może zobowiązać was do udostępnienia całej bazy pochodnej na ODbL. To
niszczy model komercyjny.

Dlatego schemat `qa_osm` jest **odseparowany na poziomie bazy** i służy
wyłącznie do wykrywania luk. Wynikiem analizy jest lista *„PRG prawdopodobnie
nie ma tych adresów"*, a nie skopiowane rekordy.

Atrybucja do stopki produktu:

> Dane pochodzą z Państwowego Rejestru Granic i Powierzchni Jednostek Podziałów
> Terytorialnych Kraju (PRG), udostępnianego nieodpłatnie przez Główny Urząd
> Geodezji i Kartografii na podstawie art. 40a ust. 2 pkt 1 lit. a ustawy Prawo
> geodezyjne i kartograficzne. Licencji nie wydaje się (art. 40c ust. 5).

---

## Sanity checks — każdy odpowiada realnemu incydentowi

| Kontrola | Incydent, który jej odpowiada |
|---|---|
| `MINIMUM_REKORDOW` | zmiana formatu → parser zwraca ułamek rekordów |
| `WIELKOSC_DELTY` | jw. + błąd konwersji |
| `SPADEK_W_GMINIE` | marzec 2016 — zrzut PRG bez Wrocławia; podobnie Białystok |
| `DELTA_ZERO` | czerwiec 2024 — paczki nie odświeżane ≥2 tygodnie, wykryła to firma zewnętrzna, nie GUGiK |
| `GEOMETRIA` | odwrócona kolejność osi w `srsName` |

Kontrola blokująca **wstrzymuje publikację**. Stary zrzut zostaje aktywny —
lepiej serwować dane sprzed tygodnia niż połowę kraju.

### Kolejność osi — pułapka, która cicho psuje cały zbiór

Układy PL-1992 i PL-2000 mają w rejestrze EPSG kolejność osi (X=north, Y=east).
Forma `urn:ogc:def:crs:EPSG::2180` ją respektuje; forma skrócona `EPSG:2180`
jest przez większość narzędzi traktowana jako (easting, northing).

**Samym bounding boxem Polski tego nie rozstrzygniecie** — zakresy easting
(140–880 km) i northing (120–900 km) nachodzą na siebie, więc punkt z Warszawy
odczytany odwrotnie ląduje pod Bydgoszczą, czyli nadal „w Polsce". Sprawdzone
empirycznie na fixture'ach w `packages/etl/test/`.

Parser respektuje deklarację `srsName`, weryfikuje bboxem i raportuje
`axisSwapped` jako ostrzeżenie — masowe swapowanie oznacza, że producent pliku
złamał własną deklarację i trzeba to zgłosić, a nie po cichu „naprawiać".

---

## Automatyzacja

`npm run etl -- cycle` przechodzi cały cykl bez nadzoru i zwraca kod wyjścia,
który monitoring może rozróżnić:

| Kod | Znaczenie | Reakcja |
|---|---|---|
| 0 | opublikowano | — |
| 5 | brak zmian w źródle | **nie jest błędem** — PRG się nie zmienił |
| 3 | wstrzymane przez kontrole jakości | zabezpieczenie zadziałało, wymaga decyzji człowieka |
| 1 | błąd techniczny | diagnoza |

Rozróżnienie 3 od 1 jest istotne: wstrzymanie publikacji to poprawne działanie
systemu, a nie awaria. Manifesty w `deploy/cronjob.yaml`.

Tryb `--z-archiwum WERSJA` przetwarza ponownie pliki już pobrane — potrzebny po
poprawce parsera, żeby nie ściągać 900 MB drugi raz.

## Źródło zapasowe i raport rozbieżności

`impa diff` odpowiada na pytanie „czego PRG nie ma", **nie modyfikując danych
produktowych**. Dane ze źródeł zapasowych trafiają do osobnego schematu
`porownanie` — to samo rozwiązanie co przy ODbL: źródło o niejasnej licencji
może być użyte do analizy, nie do zasilenia produktu.

Dopasowanie idzie po **dwóch kluczach**: najpierw po SIMC (jednoznaczny, odporny
na duplikaty nazw typu „Nowa Wieś"), a gdy źródło go nie podaje — po
znormalizowanej nazwie. Oba klucze muszą być liczone identycznie po obu stronach;
rozjechanie się ich daje raport pokazujący 100% rozbieżności przy danych, które
są w rzeczywistości zgodne.

## Odporność na zniknięcie źródła

| Poziom | Źródło | Kiedy wchodzi |
|---|---|---|
| 1 | **PRG** | domyślnie |
| 2 | **iMPA** (`danepubliczne.punktyadresowe.pl`, `adruni.zip` 100 MB) | PRG niedostępne >7 dni albo delta = 0 przez >30 dni |
| 3 | dane miejskie (Kraków ma statyczne URL-e) | uzupełnienie luk w dużych miastach |
| 4 | **własne archiwum ZIP** | awaria wszystkich źródeł |

**iMPA to jedyne realnie niezależne źródło.** Overture, OpenAddresses i w dużej
mierze OSM dla Polski to cache PRG — OpenAddresses ciąga dokładnie ten sam ZIP
z `opendata.geoportal.gov.pl`. iMPA jest *upstream* względem PRG (~1400 gmin
prowadzi tam ewidencję) i należy do innego podmiotu, więc ma inny profil ryzyka.

⚠️ **Licencja iMPA jest niejasna** — wystąpcie o nią pisemnie do Geo-System
przed komercjalizacją.

Warstwa 4 jest ważniejsza, niż się wydaje: własne wersjonowane archiwum
(~900 MB na zrzut, ~22 GB rocznie przy zrzutach miesięcznych) oznacza, że
zniknięcie PRG **degraduje produkt, a nie wyłącza go**.

---

## Model zależności między polami

```
        kraj (PL)
           │
           ├──────────────┐
           ↓              ↓
     miejscowość ←──── kod pocztowy
      (SIMC) ⚓          (podpowiada, NIE determinuje)
           │
           ↓  ma_ulice ?
     ┌─────┴─────┐
    tak         nie
     ↓            │
   ulica          │
     └─────┬──────┘
           ↓
     nr budynku
           ↓
     nr lokalu  (wolny tekst, BEZ walidacji rejestrowej)
```

**Kotwicą jest miejscowość, nie kod pocztowy.** PNA nie mapuje się 1:1 na gminę
ani miejscowość — jeden kod obejmuje kilka gmin, a jedna ulica ma wiele kodów
przypisanych do zakresów numerycznych. Kod pocztowy to świetna *podpowiedź
zawężająca* i fatalny *klucz*.

Kolumna `miejscowosc.ma_ulice` steruje pokazaniem pola ulicy. Bez niej
użytkownik ze wsi wpatruje się w puste, wymagane pole „ulica".

### Zasada nadrzędna

> **Walidacja nigdy nie blokuje zapisu adresu.**

PRG zawiera punkty prognozowane, gubi nowe budownictwo i część gmin zasila
rejestr sporadycznie. Formularz mówiący „taki adres nie istnieje" komuś, kto
właśnie się tam wprowadził, jest błędem produktu, nie użytkownika.

Walidacja **klasyfikuje i ostrzega** (`confidence` + `issues`). Decyzję
o blokadzie podejmuje logika biznesowa aplikacji konsumenckiej.

---

## API

```
GET  /v1/suggest?q=&limit=&type=&simc=   miejscowości + ulice   (RAM, ~0,5 ms)
GET  /v1/localities?q=                    same miejscowości
GET  /v1/streets?simc=&q=                 ulice w miejscowości
GET  /v1/numbers?ulicId=&prefix=          numery na ulicy        (PG, 0,22 ms)
GET  /v1/postal-code?ulicId=&nr=          kod pocztowy
GET  /v1/locality/:simc                   szczegóły + ma_ulice
GET  /v1/reverse?lat=&lon=                geokodowanie odwrotne  (PostGIS)
POST /v1/parse    {raw}                   rozbicie ciągu na pola
POST /v1/validate {address|raw}           walidacja + confidence
POST /v1/batch    {items[]}               walidacja wsadowa
GET  /v1/meta                             wersja danych + wiek zrzutu
GET  /health · /ready                     sondy Kubernetes
GET  /status                              stan dla człowieka + ostrzeżenia
GET  /metrics                             metryki Prometheusa
```

Najważniejsza metryka to `adres_dane_wiek_dni`. PRG aktualizuje się na bieżąco,
więc rosnący wiek danych oznacza zatrzymany pipeline albo problem po stronie
źródła. Reguły alertów: `deploy/alerty.yaml`.

`/v1/meta` zwraca `wiekNajnowszegoZrzutuDni` i ostrzeżenie powyżej 30 dni —
to jest wykrywacz scenariusza z czerwca 2024.

---

## Numer budynku `12/14` — dwuznaczność, którą rozstrzyga rejestr

```
12        → budynek 12
12A       → budynek 12A
12-14     → budynek 12-14 (zakres, nigdy lokal)
12 m. 5   → budynek 12, lokal 5      (jawny marker)
12A/5     → budynek 12A, lokal 5     (litera po lewej przesądza)
12/14     → budynek 12, lokal 14  ⚠️ ambiguous
            alternatywa: budynek "12/14"
12/14/5   → budynek 12/14, lokal 5
```

`parseNumber()` zwraca flagę `ambiguous` i listę alternatyw. `/v1/validate`
sprawdza w rejestrze **obie** interpretacje i przyjmuje tę, która istnieje —
jeśli w PRG jest punkt `12/14` przy tej ulicy, to jest to numer budynku.

---

## Testy

```bash
# benchmark indeksu: 373 tys. etykiet o rozkładzie PRG
node --experimental-strip-types packages/etl/test/bench-index.ts

# pełny pipeline na fixture'ach (wymaga Postgresa z PostGIS)
docker compose up -d db && ./scripts/e2e.sh
```

`e2e.sh` przechodzi całą ścieżkę dla **obu** struktur GML:
`discover → load → sanity → publish → build-index`.

Zweryfikowane na PostgreSQL 16.13 + PostGIS 3:

| Krok | Wynik |
|---|---|
| parser, struktura 2021 | profil wykryty, namespace zalogowany, PL-1992 → WGS84 poprawnie |
| parser, struktura 2012 | identyczne współrzędne, `B.N.` odrzucone jako śmieć |
| sanity checks | poprawnie **blokują** publikację przy 1 punkcie vs próg 7,5 mln |
| `publikuj_zrzut` | `+1 / ~0 / -0`, transakcyjnie |
| `refresh_derived` | `ma_ulice=true`, `liczba_punktow=1`, `nazwa_skroc='Kosciuszki'` |
| `/v1/validate` | `"ul. Kosciuszki 12A, 00-950 Warszawa"` → forma oficjalna `Tadeusza Kosciuszki` + SIMC + TERC + współrzędne + `prgLocalId`, `confidence: zweryfikowany_rejestr` |
| numer spoza rejestru | `zweryfikowany_czesciowo` + **warning**, nie error — zgodnie z zasadą „walidacja nie blokuje" |

### Progi sanity w dev/test

Fixture ma 1 punkt, produkcyjny próg to 7,5 mln. Progi są konfigurowalne przez ENV:

```bash
SANITY_MIN_POINTS=1 SANITY_MAX_DELTA_FRAC=1 npm run etl -- publish
```

To **parametryzacja** kontroli, nie jej obejście. Do obejścia służy jawna
flaga `--force`, która zostawia ślad w logu.

---

## Wyniki na pełnej skali PRG

Zmierzone na zbiorze syntetycznym o **rzeczywistej wielkości i rozkładzie PRG**:
8 560 617 punktów adresowych, 103 tys. miejscowości, 2 477 gmin.
PostgreSQL 16.13 + PostGIS 3, 2 vCPU, 8 GB RAM, `shared_buffers=1GB`.

```bash
node --experimental-strip-types packages/etl/test/scale-test.ts
node --experimental-strip-types packages/etl/test/scale-test.ts --punktow 1000000   # szybszy przebieg
```

| Etap | Czas |
|---|---|
| COPY 8,56 mln punktów do obszaru przejściowego | poniżej 2 min łącznie z kontrolami |
| Kontrole jakości na pełnym zbiorze | sekundy |
| **Publikacja — pierwsze pełne ładowanie** | **412 s** |
| **Publikacja — nocna aktualizacja (0,4% zmian)** | **67 s** |
| Budowa artefaktu indeksu | 1 s |

| Zapytanie produkcyjne | p50 | p95 |
|---|---|---|
| numery na ulicy | 1,27 ms | 6,38 ms |
| punkt po ulicy i numerze | 0,83 ms | 1,13 ms |
| geokodowanie odwrotne (PostGIS) | 0,77 ms | 1,11 ms |
| **wyszukiwanie (indeks w RAM)** | **0,114 ms** | 0,291 ms (p99 0,807) |

Rozmiar tabeli punktów: **3 127 MB**, z czego indeksy 1 477 MB.
Zużycie pamięci instancji API po załadowaniu artefaktu: **281 MB**.

### Co ten test zmienił w kodzie

Trzy rzeczy wyszły dopiero na pełnej skali i zostały poprawione:

**Indeksy obszaru przejściowego zdejmowane na czas ładowania.** Przy 8,5 mln
wierszy utrzymywanie trzech struktur B-tree w trakcie COPY było dominującym
kosztem — ładowanie przekraczało 9 minut. Po zdjęciu indeksów przed COPY
i odtworzeniu po nim: poniżej 2 minut razem z kontrolami.

**Publikacja przetwarza tylko zmienione rekordy.** Pierwotna wersja robiła upsert
wszystkich 8,5 mln wierszy niezależnie od tego, czy cokolwiek się zmieniło — więc
nocna aktualizacja kosztowała tyle samo co pełne ładowanie. PRG rośnie o ~30 tys.
punktów na kwartał, czyli realna nocna delta to ułamek procenta. Po dodaniu
filtru: 412 s → 67 s.

**Współbieżne publikacje blokują się nawzajem** na tej samej tabeli. Potwierdza
to zasadność `concurrencyPolicy: Forbid` w manifeście CronJob — bez tego dwa
nakładające się cykle zakleszczają się na wiele minut.

### Ograniczenie tego pomiaru

Generator używa ograniczonej puli nazw ulic, więc po deduplikacji po
`(simc, nazwa_norm, cecha)` powstaje ~5 tys. unikalnych ulic zamiast realnych
302 tys. **Rozmiar artefaktu indeksu (10 MB) jest więc zaniżony.** Wiarygodniejszy
szacunek daje dedykowany benchmark na 373 tys. etykiet: `bench-index.ts` → 53 MB.
Liczby po stronie bazy — czasy COPY, publikacji, rozmiar tabeli, latencje zapytań —
są miarodajne, bo zależą od liczby punktów, która jest odwzorowana wiernie.

---

## Pułapki wychwycone w trakcie budowy

Warto znać, bo dwie pierwsze psują dane po cichu.

**Kolejność osi w PL-1992.** Zakresy easting (140–880 km) i northing (120–900 km)
nachodzą na siebie, więc bounding box Polski **nie wystarcza** do wykrycia
odwrócenia — punkt z Warszawy odczytany na odwrót ląduje pod Bydgoszczą i nadal
jest „w Polsce". Parser respektuje konwencję `srsName` (`urn:` = northing
pierwszy), weryfikuje bboxem i raportuje `axisSwapped` jako ostrzeżenie.

**`search_path` w funkcjach PL/pgSQL.** Funkcja nie dziedziczy `search_path`
z momentu utworzenia — bierze go z sesji wołającego. `refresh_derived()` działała
z `psql` (bo skrypt robił `SET` na początku) i wywalała się z poola aplikacji na
„relation does not exist". Wszystkie funkcje mają teraz `SET search_path` przypięty
na sobie; to jednocześnie hardening przeciw podmianie obiektów.

**Typ parametru w wyrażeniu SQL.** `1 - $1` przy `$1 = 0.1` → Postgres próbuje
`integer` i wywala `invalid input syntax`. Potrzebny jawny `$1::numeric`.

**Gminy miejsko-wiejskie w TERYT.** W katalogu TERC gmina miejsko-wiejska
występuje pod `RODZ=3`, a dodatkowo jako dwa obszary składowe: `RODZ=4` (miasto)
i `RODZ=5` (obszar wiejski). Katalogi SIMC i ULIC odwołują się do wariantów 4/5.
Dopasowanie po pełnym 7-znakowym TERC gubi więc **wszystkie miejscowości
w gminach miejsko-wiejskich** — w Polsce jest ich około 640, czyli jedna czwarta
wszystkich gmin. Błąd byłby cichy: rekordy po prostu nie trafiłyby do bazy.

**Precedencja źródeł.** TERYT jest autorytatywny dla nazw, PRG dla geometrii
i punktów adresowych. Bez jawnej reguły PRG nadpisuje urzędową nazwę swoją
wersją, która bywa pozbawiona polskich znaków — „Kościuszki" staje się
„Kosciuszki".

**Porównywanie wersji jako napisów.** Wykrywanie nieaktualnego indeksu opierało
się na porównaniu leksykalnym wersji. Wersja to dowolny ciąg, więc `"t2"`
wychodziło większe niż `"2026-08-06"` i alarm był fałszywy. Porównanie musi iść
po czasie publikacji.

**Binary search po bajtach, nie po `localeCompare`.** Builder sortuje klucze jako
stringi JS, silnik szuka przez `Buffer.compare`. Działa, bo `normalizeText`
zwraca wyłącznie `[a-z0-9 ]` — gdyby kiedykolwiek trafił tam znak spoza ASCII,
oba porządki rozjechałyby się po cichu.

---

## Do zweryfikowania przy wdrożeniu

1. Czy serwer GUGiK zwraca `ETag` / `Last-Modified` (`npm run etl -- probe`).
   Jeśli nie — `probe` jest bezużyteczny i trzeba zejść na harmonogram tygodniowy
   + porównywanie sha256.
2. Dokładne nazwy plików nowej struktury po 1.09.2026 (kod dopasowuje po wzorcu
   `NOWE_*`, nie po stałej nazwie).
3. Czy nowa struktura zachowuje `wersjaId` / `poczatekWersjiObiektu` — od tego
   zależy, czy diff może iść po wersjach, czy tylko po content hashu.
4. Licencja iMPA (pisemnie, od Geo-System).
