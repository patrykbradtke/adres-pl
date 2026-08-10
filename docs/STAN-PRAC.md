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
| Katalog ulic | **325 595** — po scaleniu duplikatów, było 689 328 |
| Artefakt wyszukiwania | **378 399** pozycji (325 595 ulic + 52 804 miejscowości), **54,5 MB**, format **2** |
| API | `localhost:3000`, 11 endpointów `/v1/*` + 4 operacyjne + **6 administracyjnych** (`/admin/*`, tylko przy ustawionym `ADMIN_TOKEN`), wersja danych `2026-08-06` |
| Uwierzytelnianie | **klucz API w nagłówku `X-API-Key`, wymagany domyślnie** od etapu 8A. Limit po zweryfikowanym kliencie |
| Wyszukiwanie | RSS procesu **55 MB**, było 239 MB. Czasy do przemierzenia — patrz niżej |
| Archiwum PRG | 16 z 16 województw, 1,8 GB, `data/archive/prg/2026-08-06/` |
| Archiwum TERYT | `data/archive/teryt/2026-08-06/` (TERC/SIMC/ULIC/WMRODZ w CSV) |
| Kopia poza maszyną | **jest** od 9.08 wieczorem — `serwer2653901.hosting-home.pl:~/kopie/adres-pl/`, sumy sprawdzone po stronie serwera. Szczegóły w sekcji 8 |

Rejestr zapowiada 8 560 617 punktów na 31.03.2026 — mamy 45 tys. więcej, co
odpowiada przyrostowi za cztery miesiące. Zrzut jest kompletny.

Pomiar wyszukiwania: `node --experimental-strip-types packages/etl/test/bench-realny.ts`.
Testy: `npm test` — sześć zestawów **hermetycznych** (bez bazy i bez danych,
budują sobie atrapę artefaktu). `npm run test:baza` — sześć zestawów na żywej
bazie z migracją `004_licencje.sql`. `npm run jakosc` — zbiór wzorcowy (28
przypadków), wymaga pełnych danych krajowych; bez nich kończy się jedną linią
o niespełnionym warunku wstępnym, a nie kilkunastoma rzekomymi regresjami.
Monitoring: `docker compose --profile monitoring up -d` — Prometheus 9090,
Grafana 3001 (pulpit bez logowania), Alertmanager 9093.

**Czysty pomiar czasów odpowiedzi jest na tej maszynie nieosiągalny — i to jest
wynik, nie porażka.** Nocny przebieg z 10.08 miał go zdjąć. Nie zdjął, bo
maszyna nigdy nie jest spokojna: `com.docker.backend` chodzi na **546% CPU**
przy ośmiu kontenerach projektu. Zmierzone 10.08 o 06:55, przy bezczynnej
sesji użytkownika:

| kontener | CPU | używany przez kod |
|---|---|---|
| grafana | 31,4% | tak |
| db | 22,6% | tak |
| prometheus | 9,7% | tak |
| **redis** | **9,1%** | **nie — zero odwołań** |
| alertmanager | 0,7% | tak |
| **minio** | 0,1%, 85 MB | **nie — jedyne wystąpienie to komentarz w `loader.ts`** |

Rozrzut p99 między kolejnymi przebiegami tego samego pomiaru: **33, 41, 49,
66, 99, 129 ms**. Przy takim rozrzucie każda pojedyncza liczba jest bez wartości.
Wniosek do zadania 2.10: **próg regresji wydajności nie ma sensu bez
kontrolowanego środowiska pomiaru** — inaczej będzie odpalał się losowo.
Zadanie do dopisania: wyłączyć `redis` i `minio` z `docker-compose.yml` albo
przenieść je do osobnego profilu, bo dziś kosztują ~9% CPU i 85 MB, nie dając
niczego.

**Uwaga o kontenerze API.** `docker compose restart api` NIE przebudowuje
obrazu. Po zmianie w `packages/api` trzeba `docker compose build api`, inaczej
`npm test` (źródła) i `curl localhost:3000` (kontener) pokazują różne rzeczy —
kosztowało to sporo zamieszania 9.08.

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

**Czternaście usterek — żadnej nie wykryłyby testy na danych próbnych.**
Każda grupa wymagała innego warunku, żeby stać się widoczna, i to ta
klasyfikacja, a nie liczba, ma znaczenie dla planowania:

| warunek wykrycia | ile | wniosek |
|---|---|---|
| skala danych | 5 | przebieg na komplecie danych przed produkcją |
| **druga publikacja** na niepustej bazie | 3 | **dwie pełne publikacje pod obserwacją, nie jedna** |
| obserwacja działającej usługi | 2 | monitorowanie wcześnie, nie na koniec |
| porównanie z oczekiwaniem | 4 | zbiór wzorcowy jest warunkiem, nie ozdobą |

### Pierwsze pięć — przy uruchomieniu na czterech województwach

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

Testy regresji: `npm test` oraz `npm run test:baza` — po sześć zestawów.

**Cztery kolejne z zbioru wzorcowego (9.08)** — usługa odpowiadała poprawnie
i szybko, tyle że nie to, co trzeba:

| # | usterka | gdzie | skutek przed naprawą |
|---|---|---|---|
| 11 | Typ ulicy wtopiony w nazwę — 20 586 ulic, **97% ulic Warszawy** | `search/engine.ts` | **„marszalkowska" nie zwracało Warszawy nawet w pierwszej 25.** Po naprawie: poz. 2 |
| 12 | Marker skrytki pocztowej nierozpoznawany | `core/parse.ts` | numer skrytki wpadał w numer budynku i adres dostawał **`zweryfikowany_rejestr`** — wysyłka bez przeglądu |
| 13 | Przecinek jako jedyny separator pól | `core/parse.ts` | „Marszałkowska 1 00-624 Warszawa" w całości jako nazwa miejscowości |
| 14 | Pięciocyfrowy numer czytany jako kod pocztowy | `core/postal.ts` | „99999" → kod „99-999" i pusty numer budynku |

Usterka 11 naprawiona **tylko w punktacji** — słowo rodzajowe jest dla niej
przezroczyste. Etykiet nie skracamy, bo „Aleje Jerozolimskie" to nazwa
zwyczajowa. W warstwie danych problem zostaje: pozycje 6.22 i 6.23 planu,
z pułapką migracyjną wokół `publikuj_zrzut`.

Zbiór wzorcowy: 28 przypadków, **zero odstępstw** (sprawdzone 9.08 o 21:06).
Opisuje odpowiedź *poprawną*,
nie bieżącą, a po naprawie sam upomina się o zdjęcie znacznika odstępstwa.

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

**Wyszukiwanie na pełnym kraju** (po rozgrzewce):

| metoda | p50 | p95 | p99 | skąd |
|---|---|---|---|---|
| silnik bezpośrednio | 0,81 ms | 4,63 ms | 9,38 ms | `bench-realny.ts` |
| pełna ścieżka HTTP | **1,71 ms** | 9,41 ms | 27,94 ms | **pomiar doraźny, nie do odtworzenia** |

**Sprostowanie (etap 8A, 9.08).** Wiersz „pełna ścieżka HTTP" był tu i w
`deploy/alerty.yaml` przypisany skryptowi `bench-realny.ts`. Ten skrypt
**nie może** tych liczb dać: importuje `SearchIndex` i mierzy `idx.search()`
bezpośrednio — bez routingu, bez hooków, bez serializacji (`grep fastify`
nie daje w nim ani jednego trafienia). Liczby pochodzą z pomiaru doraźnego,
którego w repozytorium nie ma, więc **traktować je jako orientacyjne**.
Przyrząd mierzący faktyczną ścieżkę HTTP powstał w etapie 8A jako
`packages/api/test/bench-http.ts` (`npm run bench`) — patrz niżej.

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
| `docs/raport/raport-baza-mikroserwis-v1.8.docx` | raport dla analityków i klienta |
| `docs/build-report.js` | **generator raportu** — źródło prawdy, `npm run raport` |
| `README.md` | dokumentacja techniczna, zaktualizowane czasy przebiegów |

Raport dla analityków jest w wersji **1.8** (10.08.2026): pełny kraj, czternaście
naprawionych usterek z klasyfikacją według warunku wykrycia, formalny kontrakt
interfejsu, zmierzone czasy odpowiedzi i przetwarzania, archiwum wyniesione poza
maszynę roboczą (1.7) oraz zamknięte uwierzytelnianie klientów wraz ze zmierzonym
kosztem weryfikacji klucza (1.8, rozdz. 5.5). Wydanie 1.3 uzgodniło
treść ze stanem repozytorium — skorygowało zakres mikroserwisu, oznaczyło Redis
i magazyn obiektowy jako niewdrożone, ujawniło braki blokujące produkcję
i przepisało plan prac na 11–15 tygodni. Wszystkie wydania leżą w `docs/raport/`.

**Plik .docx powstaje wyłącznie z `docs/build-report.js`** (`npm run raport`).
Ręcznych poprawek w Wordzie nie wprowadzać — znikają przy kolejnym przebiegu.
Wydania 1.1 i 1.2 powstały poza tym generatorem, dlatego stał on na treści 1.0
aż do 8.08.2026; teraz jest z dokumentem zsynchronizowany.

---

## 8. Etap 8A — uwierzytelnianie klientów API (10.08.2026)

Gałąź `etap-8a`, scalona z `master` po zakończeniu równoległej sesji.
Wszystkie dziewięć zadań planu (8.2–8.9) zamknięte, każde osobnym commitem.

### Co powstało

| obszar | gdzie |
|---|---|
| Format i rozbiór klucza | `packages/core/src/api-key.ts` — **zero importów `node:*`**, działa też w przeglądarce |
| Pieprz HMAC z rotacją | `packages/api/src/keys/pepper.ts` |
| Replika rejestru w pamięci | `packages/api/src/keys/registry.ts` + `notify-listener.ts` |
| Hook uwierzytelniający | `packages/api/src/keys/auth.ts` |
| Zużycie i kwoty | `packages/api/src/keys/usage.ts` |
| Endpointy operatorskie | `packages/api/src/routes/admin.ts` — 6 tras, **poza** `/v1` |
| CLI do wystawiania kluczy | `packages/api/src/keys/cli.ts` (`npm run klucze`) |
| Schemat bazy | `db/migrations/004_licencje.sql` |
| Runbook operacyjny | `docs/runbook-klucze.md` |
| Zgłoszenie prefiksu do skanerów | `docs/zgloszenie-prefiksu.md` |

### Trzy rzeczy, które trzeba wiedzieć przed zmianą czegokolwiek tutaj

**1. Kolejność hooków jest gwarancją bezpieczeństwa, nie konwencją.**
Uwierzytelnianie działa w `onRequest` **poziomu instancji**. Fastify skleja hooki
instancji przed hookami trasy (`lib/route.js:391`), a `@fastify/rate-limit`
dokłada się per trasa — dlatego `keyGenerator` widzi już gotowe `req.klient`
i surowy nagłówek nie ma jak tam trafić. Zapis w planie mówił „jako `preHandler`"
i był **błędny**: wzięty dosłownie odtwarzałby lukę z zadania 8.1. Potwierdzone
odwróceniem — po przestawieniu hooka na `preHandler` obaj klienci wpadają do
wspólnego kubełka po adresie.

**2. `npm test` jest hermetyczny i ma taki zostać.** Sześć zestawów, żaden nie
wymaga bazy ani danych — budują sobie atrapę artefaktu produkcyjnym `buildIndex`.
Dzięki temu podniesienie formatu artefaktu do wersji 2 przez równoległą sesję
przeszło **bez jednej zmiany w kodzie testów**; wystarczyło przebudować plik.
Zestawy wymagające bazy stoją osobno: `npm run test:baza`.

**3. Nie osłabiaj `limit-obejscie.ts`.** Gdy sczerwienieje po zmianie
w uwierzytelnianiu, znaczy to, że kubełek limitu przestał być liczony po
zweryfikowanym kliencie — a nie że asercja jest za ostra. W nagłówku pliku są
cztery instrukcje odtworzenia luki, każda dla innej drogi powrotu.

### Zmierzone

| co | wynik |
|---|---|
| Koszt uwierzytelniania | **34–36 µs** na p50, przy budżecie 300 µs |
| Ta sama liczba, drugą metodą | ~50 µs (`koszt-uwierzytelnienia.ts`, bez serwera) |
| Zbieżność unieważnienia | 25–100 ms kanałem `NOTIFY`, gwarantowane ~10 s odpytywaniem |
| Bramka jakości po zmianach | 28 przypadków, **zero odstępstw**, na pełnych danych |

**Kryterium 8.8 wymagało sprostowania.** „+0,3 ms do p99" nie mierzy kosztu
żądania. Seria kontrolna z **dokładnie znanym** kosztem 500 µs wstrzykniętym
w ścieżkę uwierzytelniania pokazuje się na p50 jako +0,63 ms (wiernie, 1,25×),
a na p99 jako +32 do +48 ms — zawyżenie 51–96×, przy czym sam współczynnik jest
niestabilny. Ogonem rządzą pauzy odśmiecania, a koszt na żądanie tylko przesuwa
ich prawdopodobieństwo. Próg egzekwujemy więc na p50, gdzie seria kontrolna
dowodzi wierności pomiaru.

### Czego NIE zweryfikowano

Wydajność mierzono na **atrapie artefaktu**, nie na pełnym kraju. Koszt
uwierzytelniania jest niezależny od danych adresowych i temu ufam; wartości
bezwzględne p50/p95/p99 nie są porównywalne z produkcją.

`app.inject()` **przecieka** ~10 kB na żądanie: 50 tys. wywołań podnosi stertę
z 10 MB do 468 MB. Ta sama trasa przez prawdziwe gniazdo nie rośnie wcale, więc
ścieżka produkcyjna jest czysta — ale przyrząd pomiarowy ma sufit rzędu 400 tys.
wywołań na proces. Docelowo: osobny proces na serię.

### Zanim wdrożysz

1. `psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f db/migrations/004_licencje.sql`
2. Ustaw `API_KEY_PEPPER_1` — **bez niego serwis nie wstanie**, bo domyślką
   `API_KEY_MODE` jest od zadania 8.9 `wymagany`
3. Wystaw pierwszy klucz: `npm run klucze -- wystaw --klient <ID>`
4. Zabezpiecz kopię pieprza. Jego utrata unieważnia **wszystkie** klucze i nie
   da się jej odwrócić z kopii bazy, bo baza zawiera same skróty (zadanie 8.22)

---

## 9. Od czego zacząć w nowej sesji

### Nocny przebieg z 10.08.2026 — WYKONANY, wynik poniżej

Cykl 02:00 → 05:57, **3 h 56 min 48 s**, status `ok` w `adres.etl_run` (id 3).
Progi domyślne, bez `SANITY_MAX_DELTA_FRAC` — przeszły bez obchodzenia.
Log: `nocny.log` w katalogu roboczym sesji z 9.08.

**Wszystkie trzy kryteria zaliczone:**

```
OK   DUPLIKATOW: 0 (ma byc 0)
OK   PRZEDROSTKI: 3 -> 3 (bez przyrostu)
OK   OSIEROCONYCH ulic_id: 0 (ma byc 0)
```

Publikacja **nie odtwarza duplikatów** po zmianie klucza na `sym_ul` — to była
główna niewiadoma i jest zamknięta. Kontrole jakości: wszystkie pięć `[OK]`.

Trzy nazwy z przedrostkiem **nie są usterką 11** — wszystkie mają wypełnioną
`cecha`: „Aleja Klonów" (`os.`, 44 punkty) to nazwa poprawna, osiedle tak się
nazywa; „Plac Obrońców Warszawy" (`pl.`, 3 punkty) i „Plac Słowiański"
(`skwer`, 0 punktów) to resztka po 6.22. Usterka 11 dawała 20 586 takich nazw.
Skrypt porównuje **przyrost**, nie wartość bezwzględną — wersja 1 wypisałaby
tu „3" wobec oczekiwanego zera i wyglądałoby to na regres publikacji.

**Zmiany po przebiegu:** ulice 325 496 → **325 595** (+99), punkty **bez zmian**
(8 605 682), artefakt 378 300 → **378 399** pozycji, 54,5 MB. `etl_run.delta`
to same zera — cykl na tym samym archiwum `2026-08-06` nie wnosi nic nowego,
co jest zachowaniem poprawnym.

**To jednak oznacza rzecz istotną dla etapów 2.8 i 2.13: cykl, który nie
publikuje ANI JEDNEJ zmiany, kosztuje prawie cztery godziny.** Koszt jest
stały, nie proporcjonalny do liczby zmian. Z rozbicia widać tylko dwie
pozycje: odtwarzanie indeksów stagingu **2 671,7 s (44,5 min)** i budowa
artefaktu 50,2 s; pozostałe ~3 h 11 min rozkłada się na ładowanie,
`resolve_refs()` i transakcję publikującą — **bez rozbicia, bo tabeli etapów
nie ma** (to właśnie zadanie 2.1).

Zysku z poprawki 8 (`resolve_refs` przeniesione do okna ładowania masowego)
**nie da się z tego przebiegu wyliczyć**: poprzedni pomiar 3 h 25 min dotyczył
pierwszej publikacji z 6,6 mln wstawień, ten — publikacji zerowej. To dwa różne
obciążenia i porównywanie ich wprost byłoby błędem.

### Kolejność dalszych prac

1. **Zadanie 1.7 — jednorazowe odtworzenie z kopii offsite.** Najważniejsza
   pozycja i jedyna, która zamienia dzisiejsze zabezpieczenie z domniemanego
   na potwierdzone. Sumy zgadzają się 29 na 29, co dowodzi, że pliki dotarły
   całe — **nie dowodzi, że da się z nich postawić bazę**. Zakres i pułapki
   w planie. Dopiero jej wynik zamyka 1.4.
2. **Zadanie 0.5 — higiena sekretów na `master`.** PILNE **przed** scaleniem
   gałęzi `etap-8a`. Sprawdzone 10.08: `master` nie ma ani `.env`
   w `.gitignore`, ani wpisu `env` w `.dockerignore`, ani `ON_ERROR_STOP=1`.
   Dziś nic nie wycieka, bo pliku `.env` nie ma — ale etap 8A wymaga trzymania
   w nim pieprza HMAC, więc luka otworzy się dokładnie przy scaleniu. Poprawki
   gotowe na `etap-8a` (`036ef05`), chodzi o przeniesienie.
3. **Etap 1.6** — cykliczność i retencja kopii. Termin z 1.09.2026 jest
   **zdjęty**, więc to już praca porządkowa, nie ratunkowa.
4. **Etap 2.13, 2.8 i nowe 2.14** — pomiar z 10.08 pokazał, że cykl bez ani
   jednej zmiany trwa 3 h 57 min, czyli koszt jest stały. **2.14 jest
   warunkiem wstępnym dla 2.10**: bez kontrolowanego środowiska pomiaru próg
   regresji wydajności będzie odpalał się losowo.
3. **Etap 8A — uwierzytelnianie.** Prowadzone w osobnej sesji na gałęzi
   `etap-8a` w drzewie `/Users/pro/adres-pl-8a`, własna baza na porcie 5433.
   **Stan na 9.08 wieczorem — pięć commitów, wszystkie z odwróceniami
   wykonanymi, nie założonymi:**

   | zadanie | co powstało |
   |---|---|
   | 8.0 | hermetyczny zbiór testów (atrapa indeksu budowana tym samym `buildIndex`, co ETL) + higiena sekretów |
   | 8.2 | migracja `003_licencje.sql` — osobny schemat, zero kluczy obcych w stronę `adres` |
   | 8.3 | format klucza `adr_(live\|test)_<32>_<6>` w `core`, pieprz HMAC w `api` |
   | 8.4a | replika rejestru kluczy w pamięci procesu (NOTIFY + odpytywanie) |
   | 8.8a | przyrząd mierzący **faktyczną** ścieżkę HTTP i jego czułość |

   W toku, niezacommitowane: `packages/api/src/keys/auth.ts` — hook
   uwierzytelniający (8.4b). **Nie planować niczego w `packages/api` bez
   sprawdzenia tej gałęzi**, bo dotyka `server.ts` i `routes/metrics.ts`.

   Dwa ustalenia stamtąd dotyczą całego projektu, nie tylko etapu 8A:

   - **`.env` nie był ignorowany przez git ani przez `.dockerignore`.**
     Jeden `git add -A` wystarczyłby, żeby poświadczenia weszły do historii,
     a `COPY . .` w Dockerfile wpiekłby je w warstwę obrazu. Naprawione tam;
     sprawdzić, czy `master` też to ma.
   - **`psql` bez `-v ON_ERROR_STOP=1` kończy się kodem 0 mimo błędów
     w środku pliku.** Kryterium „migracja przeszła" było więc spełnialne
     przez pomyłkę. Przełącznik dopisany do 001 i 002 w README oraz `e2e.sh`.
4. Dalej wg `plan-produkcyjny.md`.

### Kopia poza maszyną

Wykonana 9.08.2026 wieczorem. **Zamyka zadanie 8.16** i zdejmuje termin
1.09.2026 — stara struktura GML nie istnieje już w jednym egzemplarzu.

| rzecz | wartość |
|---|---|
| host | `serwer2653901.hosting-home.pl`, port **22222**, SFTP/rsync po SSH |
| katalog | `~/kopie/adres-pl/` — **poza `public_html`**, nic tego nie serwuje po HTTP |
| pojemność konta | ~100 GB, zajęte ~3,9 GB |
| dostęp | klucz `id_ed25519`; odcisk hosta ECDSA `SHA256:9nZb3HFtO4AwhU2Ujz3SQYpXRG3LHmI0h5Z4WL5De+A` |

Zawartość: `archive/prg/2026-08-06/` (16 archiwów, 1,7 GB),
`archive/teryt/2026-08-06/` (33 MB), `backup/` (oba zrzuty, 2,0 GB),
`index/` (artefakt, 55 MB) oraz `SHA256SUMS.txt`.

**Weryfikacja jest częścią kopii, nie dodatkiem.** Sumy policzono przed
wysyłką i sprawdzono `sha256sum -c` **po stronie serwera** — czyli
potwierdzono integralność po przesłaniu, a nie sam fakt skopiowania. Do tego
kontrola, czy w każdym z 16 archiwów jest plik `.xml` ze starą strukturą; bez
niej kopia mogłaby zawierać wyłącznie `NOWE_*.gml` i cały wysiłek byłby pusty.
Ponowne sprawdzenie w dowolnym momencie:

```bash
ssh -p 22222 serwer2653901@serwer2653901.hosting-home.pl \
  'cd kopie/adres-pl && sha256sum -c SHA256SUMS.txt | grep -v ": OK$"'
```

Czego ta kopia **nie** załatwia: jest jednorazowa i ręczna. Brak harmonogramu,
retencji, blokady zapisu na zamrożonym archiwum (8.20) i **testu odtworzenia**
(8.23). Do etapu 1.6 i 8C to nadal jest punkt wyjścia, nie zamknięcie.

### Odtworzenie bazy

```bash
# stan sprzed scalenia ulic (9.08, przed migracją 003)
docker compose exec -T db pg_restore -U adres -d adres --clean --if-exists \
  < data/backup/adres-2026-08-09-przed-migracja.dump
```

Uwaga: migracja `003_scalenie_ulic.sql` wymaga wcześniejszego założenia indeksu
`ix_pa_ulic_id` — sama to sprawdza i przerywa z komunikatem, jeśli go brak.

**Zrzut otwiera wyłącznie `pg_restore` z kontenera.** Lokalny z libpq to wersja
**16.2**, a zrzut powstał pod **PostgreSQL 17.5** — próba lokalna kończy się
`unsupported version (1.16) in file header`. To ograniczenie narzędzia, nie
uszkodzenie pliku. Polecenie wyżej jest poprawne, bo idzie przez kontener;
nie zamieniać go na `pg_restore` z PATH.

Ustalenia dotyczące technologii (uzasadnienie w planie): serwis danych zostaje
na Fastify bez ORM; NestJS i ewentualnie Drizzle rozważyć wyłącznie dla
back-endu panelu administracyjnego, który powstanie w Angularze jako SPA
z autoryzacją — planowany osobno, po etapach 4 i 5.
