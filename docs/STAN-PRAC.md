# Stan prac — przekazanie do kolejnej sesji

Dokument zamyka sesję z 6–9 sierpnia 2026. Opisuje **stan faktyczny**:
co działa, co naprawiono, jakie są pułapki i od czego zacząć.
Plan zadań: [plan-produkcyjny.md](plan-produkcyjny.md).

---

## 1. Co działa teraz

**Cały kraj jest opublikowany** — etap 1.1 i 1.2 zamknięte 9.08.2026.

| element | stan |
|---|---|
| Baza PostgreSQL 17 + PostGIS | działa w kontenerze `adres-pl-db-1`, 12 GB |
| Słowniki TERYT | 4360 jednostek, 101 883 miejscowości |
| Punkty adresowe | **8 605 682** opublikowane, **16 z 16 województw** |
| Powiązanie z ulicami | 5 532 383 punkty (64,3%) |
| Kod pocztowy | 8 604 962 punkty (99,99%) |
| Katalog ulic | 689 328 |
| Artefakt wyszukiwania | 791 211 pozycji, 109,3 MB, budowa 55 s |
| API | `localhost:3000`, 11 endpointów `/v1/*` + 4 operacyjne (`/health`, `/ready`, `/metrics`, `/status`), wersja danych `2026-08-06` |
| Wyszukiwanie | HTTP p50 **1,71 ms**, p95 9,41 ms, p99 27,94 ms; RSS procesu 239 MB |
| Archiwum PRG | 16 z 16 województw, 1,8 GB, `data/archive/prg/2026-08-06/` |
| Archiwum TERYT | `data/archive/teryt/2026-08-06/` (TERC/SIMC/ULIC/WMRODZ w CSV) |

Rejestr zapowiada 8 560 617 punktów na 31.03.2026 — mamy 45 tys. więcej, co
odpowiada przyrostowi za cztery miesiące. Zrzut jest kompletny.

Pomiar wyszukiwania: `node --experimental-strip-types packages/etl/test/bench-realny.ts`.

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

**Trzy kolejne przy przejściu na pełny kraj (8–9.08)** — żadnej nie dało się
wykryć na czterech województwach:

| # | usterka | gdzie | skutek przed naprawą |
|---|---|---|---|
| 6 | `SPADEK_W_GMINIE` liczona **przed** `resolve_refs()`, więc `simc` było wszędzie NULL | `db/sanity.ts` | kontrola blokująca **nigdy nie działała poza pustą bazą**; przy drugiej publikacji fałszywy STOP na 20 gminach z Warszawą na czele |
| 7 | `/dev/shm` kontenera bazy = domyślne 64 MB Dockera | `docker-compose.yml` | przy 8,6 mln wierszy planer wchodzi w tryb równoległy i cykl przerywa się na `could not resize shared memory segment` — komunikat myli, bo nie ma związku z dyskiem hosta |
| 8 | `resolve_refs()` wywoływane **po** odtworzeniu indeksów | `002_staging.sql`, `po_ladowaniu()` | 8,6 mln wierszy × 3 indeksy = **49 min** zamiast kilku; łącznie 303 GB zapisów przy zbiorze 12 GB |

Usterka 6 jest najpoważniejsza koncepcyjnie: to nie błędne dane, tylko **fałszywe
poczucie zabezpieczenia**. Pierwsza publikacja zawsze idzie na pustą bazę, więc
cała klasa błędów „porównanie stanu poprzedniego z nowym” jest wtedy niewidoczna.
Wniosek do harmonogramu: **dwie pełne publikacje pod obserwacją, nie jedna.**

Poprawka 8 **wgrana do działającej bazy 9.08.2026** — zysk zmierzyć kolejnym
pełnym przebiegiem. Przy odtwarzaniu bazy od zera migracja wejdzie sama.

**Dwie kolejne po podpięciu monitoringu (9.08)** — obie niewidoczne wcześniej
dokładnie dlatego, że nikt nie zbierał metryk:

| # | usterka | gdzie | skutek przed naprawą |
|---|---|---|---|
| 9 | Loader porównywał `dataVersion` („2026-08-06") z **nazwą pliku** ze wskaźnika („idx-2026-08-06.bin") | `search/loader.ts` | warunek „nic się nie zmieniło" nie zatrzymywał niczego — **każda instancja czytała i parsowała 109 MB co 60 s** |
| 10 | `/metrics` liczył trzy `count(*)` na tabelach produkcyjnych | `routes/metrics.ts` | 4,4 s przy limicie zbierania 10 s; po cache'owaniu zliczeń **0,05–0,12 s** |

Przy usterce 10 uwaga projektowa: cache'owane są **tylko zliczenia**.
Dostępność bazy idzie osobną, tanią sondą `SELECT 1` przy każdym zbieraniu —
cache'owanie jej maskowałoby awarię, a to sygnał dla alertu z progiem 2 minut.

Testy regresji: `npm test` — cztery zestawy w `packages/api/test/`.

**Zbiór wzorcowy jakości (9.08, zadanie 6.8) ujawnił sześć wad.** Najpoważniejsza:
**„marszalkowska" nie zwraca Warszawy nawet w pierwszej 25** — 10 992 z 11 338 ulic
Warszawy ma słowo rodzajowe wtopione w nazwę („ulica Marszałkowska") przy pustej
kolumnie `cecha`, więc przegrywają ze wsiami, gdzie nazwa jest czysta. W kraju
32 418 takich ulic. Druga co do wagi: **skrytka pocztowa dostaje
`zweryfikowany_rejestr`**, choć rozdz. 6.4 raportu przewiduje tryb nietypowy.
Komplet z nakładami: `plan-produkcyjny.md`, pozycje 6.16–6.21.

Poza tym: naprawiony niekompletny `package-lock.json`, dodany `.dockerignore`,
`build-index` tworzy teraz stabilną nazwę `current.bin`, loader API czyta
wskaźnik wersji już przy starcie, dodano `ANALYZE` po masowym wstawieniu.

**Zacommitowane i wypchnięte** — prywatne repozytorium
`patrykbradtke/adres-pl`, 68 plików. Katalog `data/` wykluczony z historii:
1,8 GB archiwów i zrzut bazy odtwarza się z zewnątrz albo z kopii zapasowej.

---

## 4. Wydajność — zmierzone wartości

**Pełny przebieg krajowy, 8–9.08.2026 — łącznie ~3 h 25 min:**

| etap | czas |
|---|---|
| Ładowanie 16 województw (`--rownolegle 4`) | **~17 min** |
| `resolve_refs()` — 8,6 mln wierszy | ~49 min ← do naprawy, patrz usterka 8 |
| Kontrole jakości na pełnym zbiorze | ~2 min |
| Publikacja transakcyjna (+6 615 199 punktów) | **2 h 16 min** |
| Budowa artefaktu | 55 s |

**Ładowanie jest ~10× szybsze, niż podawał poprzedni pomiar** (~38 min na samo
mazowieckie). Poprzednia liczba powstała w sesji, w której naprawiano jeszcze
błędy wydajnościowe — uznać za nieaktualną.

**Czas uchodzi gdzie indziej: dwie pełne aktualizacje 8,6 mln wierszy** przy
nałożonych indeksach (`resolve_refs` + wiązanie z ulicami wewnątrz publikacji).
303 GB zapisów przy zbiorze 12 GB. To one, nie parsowanie, wyznaczają czas cyklu.

**Wyszukiwanie na pełnym kraju** (`bench-realny.ts`, po rozgrzewce):

| metoda | p50 | p95 | p99 |
|---|---|---|---|
| silnik bezpośrednio | 0,81 ms | 4,63 ms | 9,38 ms |
| pełna ścieżka HTTP | **1,71 ms** | 9,41 ms | 27,94 ms |

Wyniki są **lepsze** niż wcześniejsze ~4 ms mimo dwukrotnie większego zbioru.
Przyczyna jest metodyczna: pierwsze zapytanie po starcie procesu daje 82 ms,
czyli ten sam rząd wielkości, co wcześniej raportowane 14–42 ms dla „nazw
pospolitych”. Tamten pomiar łapał w znacznej części rozgrzewkę maszyny
wykonującej kod, nie koszt uszeregowania kandydatów. **Budżet czasu odpowiedzi
planować pod zimny start instancji, nie pod nazwy pospolite** — i rozgrzewać
instancję przed skierowaniem na nią ruchu.

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

**Progi kontroli jakości.** `SANITY_MIN_POINTS` (domyślnie 7,5 mln) nie jest już
potrzebny — pełny kraj przechodzi progiem domyślnym. Przy pierwszym załadunku
trzeba było natomiast jednorazowo podnieść `SANITY_MAX_DELTA_FRAC=4`, bo wejście
z 1,99 mln na 8,61 mln to +332% wobec domyślnych 2%. **Przy kolejnych przebiegach
NIE ustawiać** — 2% jest właściwe dla cyklu tygodniowego i to ono łapie katastrofy.

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

**API nadal nie ma uwierzytelniania**, ale luka w limitowaniu jest zamknięta
(8.08.2026, zadanie 8.1). Limitowanie idzie wyłącznie po adresie klienta;
nagłówek `x-api-key` nie jest już kluczem kubełka, bo nikt go nie weryfikuje,
a losowanie wartości dawało świeży licznik. Za ingressem ustawić `TRUST_PROXY`
— bez tego cały ruch trafia do jednego kubełka po adresie ingressu.
Test regresji: `node --experimental-strip-types packages/api/test/limit-obejscie.ts`.
Pełne uwierzytelnianie z licencjami: etap 8A.

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

# monitoring: Prometheus 9090, Grafana 3001 (pulpit bez logowania), Alertmanager 9093
docker compose --profile monitoring up -d
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
| `docs/raport/raport-baza-mikroserwis-v1.4.docx` | raport dla analityków i klienta |
| `docs/build-report.js` | **generator raportu** — źródło prawdy, `npm run raport` |
| `README.md` | dokumentacja techniczna, zaktualizowane czasy przebiegów |

Raport dla analityków jest w wersji **1.4** (9.08.2026): pełny kraj, trzy nowe
usterki, przemierzone czasy odpowiedzi i przetwarzania. Wydanie 1.3 uzgodniło
treść ze stanem repozytorium — skorygowało zakres mikroserwisu, oznaczyło Redis
i magazyn obiektowy jako niewdrożone, ujawniło braki blokujące produkcję
i przepisało plan prac na 11–15 tygodni. Wszystkie wydania leżą w `docs/raport/`.

**Plik .docx powstaje wyłącznie z `docs/build-report.js`** (`npm run raport`).
Ręcznych poprawek w Wordzie nie wprowadzać — znikają przy kolejnym przebiegu.
Wydania 1.1 i 1.2 powstały poza tym generatorem, dlatego stał on na treści 1.0
aż do 8.08.2026; teraz jest z dokumentem zsynchronizowany.

---

## 8. Od czego zacząć w nowej sesji

1. **Etapy 0, 1.1–1.3 oraz zadanie 8.1 — wykonane.** Cały kraj opublikowany,
   artefakt zbudowany i zmierzony, luka w limitowaniu zamknięta.
2. **Wgrać poprawkę 8** do działającej bazy (migracje idą tylko przy inicjalizacji
   kontenera), a potem zmierzyć zysk kolejnym pełnym przebiegiem:
   `psql "$DATABASE_URL" -f db/migrations/002_staging.sql`
3. **Etap 1.4 i 1.6 — archiwum i kopie zapasowe poza maszynę.** To teraz
   najpilniejsza pozycja: zrzut w strukturze sprzed 1.09.2026 istnieje w jednej
   kopii na dysku roboczym, a po tej dacie jest nieodtwarzalny.
4. **Etap 2.13** — dwie pełne aktualizacje 8,6 mln wierszy przy nałożonych
   indeksach; 303 GB zapisów przy zbiorze 12 GB.
5. Dalej wg `plan-produkcyjny.md`. Z etapu 7 warto wcześnie wziąć 7.1 i 7.2 —
   w tej sesji dwukrotnie okazało się, że awarię wykrywa człowiek, bo metryk
   nikt nie zbiera.

Odtworzenie bazy bez ponownego przetwarzania — z kopii w `data/backup/`:

```bash
docker compose exec -T db pg_restore -U adres -d adres --clean --if-exists \
  < data/backup/adres-2026-08-07.dump
```

Ustalenia dotyczące technologii (uzasadnienie w planie): serwis danych zostaje
na Fastify bez ORM; NestJS i ewentualnie Drizzle rozważyć wyłącznie dla
back-endu panelu administracyjnego, który powstanie w Angularze jako SPA
z autoryzacją — planowany osobno, po etapach 4 i 5.
