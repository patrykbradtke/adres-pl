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

Pomiar wyszukiwania: `node --experimental-strip-types packages/etl/test/bench-real.ts`.
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
| Ładowanie 16 województw (`--parallel 4`) | **~17 min** |
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
| silnik bezpośrednio | 0,81 ms | 4,63 ms | 9,38 ms | `bench-real.ts` |
| pełna ścieżka HTTP | **1,71 ms** | 9,41 ms | 27,94 ms | **pomiar doraźny, nie do odtworzenia** |

**Sprostowanie (etap 8A, 9.08).** Wiersz „pełna ścieżka HTTP" był tu i w
`deploy/alerty.yaml` przypisany skryptowi `bench-real.ts`. Ten skrypt
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

Zrównoleglenie: `cycle --parallel N` lub `ETL_ROWNOLEGLE`. Domyślnie 1.
Koszt ~400 MB RAM na proces — dobierać do pamięci, nie do liczby rdzeni.

---

## 5. Pułapki, o których trzeba wiedzieć

**TERYT przez usługę sieciową GUS nie działa.** Żadne zapytanie SOAP nie
dostaje odpowiedzi (sprawdzone: 30 s, 60 s, 180 s), przy działającym pobraniu
opisu usługi w 2,2 s. Konto produkcyjne: zgłoszenie na `teryt_ws1@stat.gov.pl`.
**Nie jest potrzebne** — te same katalogi pobiera bez konta skrypt
`scripts/teryt-fetch-files.mjs` (odtwarza formularz eteryt). Uwaga: brać
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
Test regresji: `node --experimental-strip-types packages/api/test/rate-limit-bypass.ts`.
Pełne uwierzytelnianie z licencjami: etap 8A.

---

## 6. Jak uruchomić

```bash
# baza
docker compose up -d db

# pełny cykl na pozostałych województwach, 4 procesy naraz
docker compose run --rm etl cycle --from-archive 2026-08-06 --parallel 4

# publikacja i artefakt
docker compose run --rm etl publish --version 2026-08-06
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
- `teryt-fetch-files.mjs <katalog>` — pobiera katalogi TERYT bez konta w GUS
- `fetch-all-voivodeships.sh` — kolejka pobrania archiwów PRG, pomija już pobrane
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

**3. Nie osłabiaj `rate-limit-bypass.ts`.** Gdy sczerwienieje po zmianie
w uwierzytelnianiu, znaczy to, że kubełek limitu przestał być liczony po
zweryfikowanym kliencie — a nie że asercja jest za ostra. W nagłówku pliku są
cztery instrukcje odtworzenia luki, każda dla innej drogi powrotu.

### Zmierzone

| co | wynik |
|---|---|
| Koszt uwierzytelniania | **34–36 µs** na p50, przy budżecie 300 µs |
| Ta sama liczba, drugą metodą | ~50 µs (`auth-cost.ts`, bez serwera) |
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
3. Wystaw pierwszy klucz: `npm run klucze -- wystaw --client <ID>`
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

---

## 10. Refactor nazewnictwa na angielski (10.08.2026)

Kod przeszedł na angielskie identyfikatory. Konwencja i jej uzasadnienie:
**[konwencja-nazewnictwa.md](konwencja-nazewnictwa.md)** — ten dokument jest
wiążący i rozstrzyga spory o nazwy raz, zamiast przy każdym module.

### Co się zmieniło

| warstwa | stan |
|---|---|
| identyfikatory TS | angielskie w całym repozytorium (`core`, `index-format`, `etl`, `api`, testy) |
| pola JSON API | angielskie — `miejscowosc`→`locality`, `nrBudynku`→`buildingNumber`, `cecha`→`streetType` |
| wartości enumów | `zweryfikowany_rejestr`→`verified_registry`, `BRAK_MIEJSCOWOSCI`→`MISSING_LOCALITY` |
| kody odmowy 401/403 | `BRAK_KLUCZA`→`MISSING_KEY`, `WYGASLY`→`EXPIRED`, `UNIEWAZNIONY`→`REVOKED` |
| baza | migracja **005_english_naming.sql** — schematy `adres`→`address`, `licencje`→`licensing` |
| kanał NOTIFY | `licencje_zmiana`→`licensing_change`, ładunek `key:` / `client:` |
| metryki | `adres_zapytania_total`→`adres_requests_total` i 25 innych; prefiks `adres_` **zostaje** |
| zmienne środowiskowe | `KLUCZE_MAX_WIEK_S`→`KEYS_MAX_AGE_S`, `ZUZYCIE_FLUSH_MS`→`USAGE_FLUSH_MS` |
| `API_KEY_MODE` | wartości `required` / `optional` / `disabled` (były polskie) |
| flagi CLI | `--klient`→`--client`, `--woj`→`--voivodeship`, `--stan`→`--as-of` |
| skrypty npm | `test:baza`→`test:db`, `jakosc`→`quality`, `raport`→`report`, `klucze`→`keys` |
| pliki testów | angielskie nazwy (`uwierzytelnianie.ts`→`authentication.ts` itd.) |

Komentarze i komunikaty **zostają po polsku**, bez znaków diakrytycznych.

### Co zostaje po polsku celowo

To nie są nasze nazwy — ich tłumaczenie byłoby błędem:

- nagłówki kolumn plików iMPA i TERYT: `NAZWA_MIEJSCOWOSCI`, `TYP_ULICY`, `CECHA`
- operacje SOAP w API GUS: `PobierzKatalogTERC`, `PobierzKatalogSIMC`
- elementy GML GUGiK: `lokalnyId`, `numerPorzadkowy`, `przedrostek1Czesc`
- cechy ulic jako dane słownikowe: `szosa`, `wybrzeze`, `bulwar`
- migracje 001–004 — zapis historii, który na wdrożonej bazie już przeszedł

### Trzy pułapki znalezione przy okazji

Wszystkie trzy były **cichymi** błędami — kod działał, testy wcześniej
przechodziły, a skutek ujawniał się dopiero w konkretnym scenariuszu:

1. **Alias SQL kontra odczyt w TS.** `SELECT ... AS znacznik` przy odczycie
   `z.stamp` dawało `undefined`. Efekt: `undefined === undefined`, więc rejestr
   kluczy uznawał, że nic się nie zmieniło, i **nigdy się nie odświeżał**.
   Przy każdej zmianie nazwy kolumny sprawdzać OBIE strony.
2. **Pole i metoda o tej samej nazwie.** `private authentication = new Map()`
   przesłoniło metodę `authentication()`. Każde żądanie kończyło się 500.
3. **Typ unii kontra klucze rekordu.** `type DenialState = 'wygasly' | ...`
   przy kluczach `DENIALS` już angielskich — trzy z czterech odmów zwracały
   `undefined` zamiast kodu 403.

### Zweryfikowane 10.08.2026

- `npm test` — sześć zestawów hermetycznych, kod wyjścia **0**
- `npm run test:db` — sześć zestawów na żywej bazie po migracji 005, **0**
- `node docs/build-report.js` — raport generuje się poprawnie
- migracja 005 wgrana na lokalnej bazie w kontenerze `adres-pl-db-1`

### Czego NIE zweryfikowano

- **`scripts/e2e.sh`** — poprawiony pod nowe nazwy (w tym dopisana migracja
  005 do sekwencji), ale **nieuruchomiony**: wymaga pełnych danych TERYT i PRG
- **`npm run quality`** — zbiór wzorcowy wymaga danych krajowych
- **`npm run bench`** — pomiar niewykonany po zmianach

### Zanim wdrożysz

1. **Nie da się rolling-update.** Migracja zmienia jednocześnie nazwy kolumn
   i kanał NOTIFY. Stara instancja API po migracji przestaje działać —
   baza i obraz muszą wejść razem.
2. **Prometheus straci ciągłość** dla 26 przemianowanych metryk. Alerty
   i pulpit Grafany są zaktualizowane, ale wykresy będą miały wyrwę.
3. **`.env` trzeba poprawić ręcznie** — `API_KEY_MODE=wymagany` już nie działa,
   wartość to teraz `required`.

### Kolejność dalszych prac po refactorze

| # | zadanie | dlaczego |
|---|---|---|
| 1 | Uruchomić `scripts/e2e.sh` na pełnych danych | jedyna niezweryfikowana ścieżka; sprawdza ETL → publikacja → API od końca do końca |
| 2 | Uruchomić `npm run quality` i `npm run bench` | potwierdzić brak regresji jakości wyszukiwania i czasów po zmianie nazw |
| 3 | Przejrzeć prozę w README i tym dokumencie | opisy pól API miejscami wciąż mówią `miejscowosc`/`nrBudynku`; nazwy metryk i poleceń są już poprawione |
| 4 | Zdjąć `redis` i `minio` z `docker-compose.yml` | zadanie sprzed refactoru, wciąż otwarte — ~9% CPU i 85 MB bez żadnego użycia |
| 5 | Narzędzie do migracji (`node-pg-migrate`) | 005 to piąty plik wgrywany ręcznie; dług opisany w planie produkcyjnym |

---

## 11. Weryfikacja refactoru i plan fazowy (10.08.2026, sesja druga)

Zadania 1 i 2 z rozdziału 10 wykonane. Przy okazji wyszły **cztery kolejne ciche
błędy tej samej klasy** oraz dwie przyczyny systemowe, przez które mogły przejść.

### Zadanie 1 — `scripts/e2e.sh`

**Nie wolno go uruchamiać na bazie produkcyjnej.** Krok 0 robi
`TRUNCATE address.* CASCADE`, a krok 7 przestawia `data/index/current.bin`.
Przy komplecie krajowym oznacza to skasowanie 8 605 682 punktów i podmianę
57 MB artefaktu na fixture'owy. Odtworzenie ~3 h 25 min, a **kopii stanu po
migracji 005 nie ma** — najnowszy zrzut jest sprzed 003.

Uruchamiać wyłącznie izolowanie:

```bash
export DATABASE_URL="postgres://adres:adres@localhost:5432/adres_e2e"
export INDEX_ROOT=/tmp/e2e-index ARCHIVE_ROOT=/tmp/e2e-archive
./scripts/e2e.sh
```

Kolejność z rozdziału 10 była odwrotna: `quality` wymaga `dataVersion`
zgodnej ze zbiorem wzorcowym, więc zadanie 1 kasowało warunek wstępny zadania 2.

### Zadanie 2 — wyniki

| kontrola | wynik |
|---|---|
| `npm run quality` | 28/28, kod 0 |
| `npm run bench` | koszt uwierzytelniania p50 **0,017 ms** (próg 0,3), kod 0 |
| `npm test`, `npm run test:db` | kod 0 |

`bench` używa **atrapy indeksu celowo** — mierzy koszt hooka, nie czasy na
danych krajowych. Nie zestawiać z wierszem „pełna ścieżka HTTP".

### Ciche błędy 4–7

| # | gdzie | skutek |
|---|---|---|
| 4 | `routes/validate.ts:109` — `'nietypowy'` wobec `'irregular'` w `core` | skrytka pocztowa dostawała `unverified`; strażnik poprawki z 9.08 wyłączony |
| 5 | `test/bench-http.ts` — `zadan` i `zapytania` przemianowane oba na `REQUESTS` | `SyntaxError`, `npm run bench` nie uruchomił się ani razu od refactoru |
| 6 | `test/reference-set.yaml` — klucze zostały polskie | **9 przypadków przechodziło, nie sprawdzając niczego**, plus 6 fałszywych błędów |
| 7 | `routes/lookup.ts:169` (`w.kod`), `db/load-teryt.ts:75` (`kod`) | 500 na `/v1/locality/:simc`; ładowanie TERYT niedziałające na świeżej bazie |

Naprawione i zweryfikowane. Poza tym:

- **`003_scalenie_ulic.sql` miała `BEGIN;` bez `COMMIT`.** `psql -f` wycofuje
  otwartą transakcję przy EOF i **zwraca kod 0** — migracja „przechodziła",
  nie zmieniając nic. Dopisany `COMMIT`.
- **`e2e.sh` nigdy nie uruchamiał 003** (też sprzed refactoru). Dopisana wraz
  z wymaganym `ix_pa_ulic_id`.

### Dwie przyczyny systemowe

1. **Nic nie sprawdza typów.** Brak `tsconfig.json`, brak `typescript`,
   `npm run build` jest pusty. Unia `Confidence` nie chroniła przed niczym.
2. **`load-teryt.ts` jest niewidoczny dla `grep`** — dwa surowe bajty NUL
   w linii 297 (celowe separatory klucza) sprawiają, że `file` widzi „data".
   NUL-e są sprzed refactoru; to dlatego akurat ten plik przemianowano w połowie.

### Ósmy błąd — słowniki źródłowe GML

Znaleziony pomiarem typów. W `gml/profiles.ts` **klucz jest wartością z pliku
GUGiK**, a nie naszym identyfikatorem (`mapper.ts:160`). Refactor przetłumaczył
siedem pozycji, które przez to przestały się dopasowywać:

```
ulica -> street            czescMiejscowosci -> localityPart
przysiolek -> hamlet       czescMiejcowosci  -> localityPart  (duplikat, wariant przepadł)
schroniskoTurystyczne -> touristHostel        czescMiasta -> cityPart
dzielnicaWarszawy -> warsawDistrict
```

Konwencja mówi o tych wartościach wprost, że zostają po polsku. Rozróżnienie,
które trzeba zapamiętać: w mapach ścieżek GML **lewa strona jest nasza**
(idzie na angielski), **prawa jest źródłowa** (zostaje) — i tam refactor zrobił
to dobrze. Zepsute są wyłącznie dwa słowniki, gdzie kluczem jest sama dana.

**Typecheck złapał 1 z 7** — tylko duplikat klucza. `hamlet: 3` jest poprawne
typowo i błędne znaczeniowo, bo mapa to `Record<string, number>`. Wniosek na
przyszłość: **tam, gdzie klucz jest daną z zewnątrz, typ nie ma czego pilnować**
i potrzebny jest test przepuszczający prawdziwe wartości źródłowe.

`e2e.sh` tego nie łapie, bo krok 8 tylko drukuje tabelkę zamiast ją sprawdzać.

### Kolejność dalszych prac — fazy

Kryterium: **zasięg zmiany, gdyby zrobić to później.** Rzeczy o dużym zasięgu
idą pierwsze, nawet gdy same nie dają nic widocznego.

| faza | zakres | nakład |
|---|---|---|
| **0. Szczelność** | typy + CI, domknięcie e2e, konformancja kontraktu o schematy, audyt słowników z testem, krok 8 asercją, higiena sekretów | 5–6 d |
| **1. Kręgosłup** | narzędzie migracji z rejestrem, **jedno** pojęcie wykonawcy, **jeden** dziennik audytu, `can()` jako szew, kolumna zakresu, **kolumny pochodzenia na poziomie pola i tabele nakładki** (patrz niżej) | 4–5 d |
| **2. Dane** | etapy 4 i 5 — wersjonowanie wydań i audyt zmian, **projekt i wdrożenie izolowanego importu z promocją** (patrz niżej) | 9–12 d + 3–5 d |
| **3. Role** | R1–R15 z `panel-role-i-uprawnienia.md` | 8–9 d |
| **4. Front** | R19–R20 i ekrany | wg planu panelu |

Tor równoległy, nieblokujący: monitoring (7.4–7.7), RODO (6.3, 6.4), kopie
(1.6–1.7, 8.18–8.26), reszta ETL (6.22 — 11 162 ulic bez cechy, 6.23 — 170 par
duplikatów), dokumentacja integratora (6.7).

### Warunek wejścia w etapy 4 i 5

Zanim zacznie się faza 2, ma być prawdą:

1. `npm run typecheck` przechodzi i jest w CI
2. `e2e.sh` przechodzi w całości i **asertuje treść**, nie drukuje
3. Migracje mają rejestr zastosowanych
4. Istnieje **jedno** pojęcie wykonawcy i **jeden** dziennik audytu
5. `can()` istnieje jako szew, więc nowe trasy rodzą się za nim
6. Kolumna zakresu jest w schemacie, choćby pusta
7. Kontrakt zgadza się z kodem, a konformancja sprawdza schematy

Punkty **3 i 4 są krytyczne**: reszta poprawia się plik po pliku, a brak
rejestru migracji i brak jednego dziennika audytu to koszt rosnący wykładniczo.
Dziennika nie da się dorobić wstecz — okres sprzed retrofitu przepada.

### Otwarte decyzje

| # | pytanie | blokuje |
|---|---|---|
| A1 | Cel konfliktu dla ULIC w `load-teryt.ts:320` wobec częściowych indeksów z 003 | domknięcie `e2e.sh` |
| 1 | Oś terytorialna w uprawnieniach: od razu czy tylko miejsce na nią | fazę 1, punkt 6 |
| 2 | Czy klienci dostają dostęp do panelu | model zakresu i połowę scenariuszy |

### Wymaganie: aktualizacja nie może dotykać działającego API

Zapisane 10.08.2026. Dwa warunki naraz, a ciągną w przeciwne strony:

1. Import i synchronizacja **nie mogą wpłynąć na dostępność ani na płynność**
   produkcyjnego API adresowego — ani na dostęp, ani na czasy odpowiedzi.
2. Baza produkcyjna jest **równolegle zapisywana przez panel** (ręczne
   poprawki), więc promocja nowego wydania nie może ich skasować.

**Co jest dziś zmierzone.** `search.ts` wykonuje **zero** zapytań do bazy —
`/v1/suggest` idzie w całości z artefaktu w pamięci i jest już odporne. Na bazie
wiszą `lookup.ts` (5 zapytań) i `validate.ts` (2), czyli te same tabele, które
`publikuj_zrzut` przepisuje przez 2 h 16 min. `metrics.ts` (7 zapytań) jest
odpytywane co 15 s.

**Precedens szkody, której zakazujemy, jest już w repozytorium:** nagłówek
migracji 003 opisuje, jak `ALTER TABLE` z blokadą ACCESS EXCLUSIVE **zamroził
`/metrics` na godzinę**, a usterka 8 — jak `resolve_refs()` wygenerowało 303 GB
zapisów przy zbiorze 12 GB.

**Status: zapisane jako wymaganie, projekt do wykonania.** Poniższe to kierunek
wynikający z warunków, a nie rozstrzygnięcie — właściwy projekt powstanie
w fazie 2, na tym samym poziomie szczegółowości co `panel-role-i-uprawnienia.md`.

**Kierunek.** Warunek 1 wyklucza „scalanie w żywe tabele” jako mechanizm
podstawowy: skoro nic nie może dotykać tego, z czego czyta API, to import nie
może tam pisać. Z tego wynikałby kształt:

- ręczne poprawki z panelu modelujemy jako **nakładkę na poziomie pola**
  (osobną i nadrzędną), a nie jako zmiany wierszy pochodzących z importu
- każde wydanie: zaciągnięcie źródła → **odtworzenie nakładki** → walidacja
  i mapowanie → promocja
- promocja ma być dla czytelnika **przestawieniem wskaźnika**, a nie migracją
  danych

**Wzorzec już działa w tym projekcie i trzeba go rozszerzyć na bazę:** artefakt
indeksu buduje się do nowego pliku, sprawdza i dopiero wtedy przestawia
`current.bin`. Baza nie ma odpowiednika.

Warianty do oceny: dwa schematy z przełączaniem `search_path` albo widoku,
osobna instancja z przełączeniem połączenia, albo przeniesienie `lookup`
i `validate` na artefakt lub replikę odczytu — wtedy baza znika ze ścieżki
żądania i wpływ importu przestaje mieć znaczenie. Odwrotne geokodowanie
wymaga PostGIS, więc go tak nie da się zdjąć.

**Konsekwencja dla kolejności:** kolumny pochodzenia na poziomie pola i tabele
nakładki muszą wejść w **fali schematu z fazy 1**. Dołożenie ich później do
`address_point` (8,6 mln wierszy) to długa migracja, a ścieżka publikacji musi
je znać, żeby wiedzieć, czego nie ruszać. Dziś `address_point` ma ślad
pochodzenia wyłącznie na poziomie rekordu (`source`, `source_version`,
`fetched_at`), a `publikuj_zrzut` nadpisuje wszystkie pola bezwarunkowo —
jedyny wyjątek to `status` ze strażnikiem `COALESCE(EXCLUDED.status, p.status)`.

### Postęp fazy 0

| # | zadanie | stan |
|---|---|---|
| 0.1 | Typy | **wykonane** — `tsconfig.json`, `npm run typecheck`, pełny `strict`, kod 0 |
| 0.2 | CI | **wykonane** — `.github/workflows/ci.yml`, dwa zadania |
| 0.3 | Decyzja ULIC i domknięcie `e2e.sh` | **wykonane** — A1 rozstrzygnięte, przebieg zielony, dopięty do CI |
| 0.4 | `e2e.sh` na osobnej bazie z definicji | **wykonane** — domyślka `adres_e2e`, `./data/e2e`, strażnik progu |
| 0.5 | Kontrakt i próba dymna tras | **wykonane** — enumy i nazwy schematów, `endpoint-smoke.ts`, konformancja porównuje enumy z kodem |
| 0.6 | Test słowników źródłowych | **wykonane** — `gml-dictionaries.ts`, sprawdzony w obie strony |
| 0.7 | Krok 8 `e2e.sh` asercją | **wykonane** — z zastrzeżeniem niżej |
| 0.8 | NUL w `load-teryt.ts`, higiena sekretów | **wykonane** — plik jest znów tekstem; `.env` ignorowany na tej gałęzi |

**0.1 — jak wypadł pomiar.** Bez typów pakietów `strict` kosztował 80 błędów.
Po doinstalowaniu `@types/pg`, `@types/pg-copy-streams` i `@types/yauzl`
spadł do **31**: wszystkie 27 braków deklaracji i 22 domyślne `any` siedziały
na wywołaniach `pg` i `yauzl`. Dlatego fundament jest od razu ścisły.
Otypowany `pg` jest tu zresztą tym mechanizmem, który wykrywa klasę „alias SQL
wobec odczytu w TS" — czyli usterki 1 i 7.

**0.2 — czego w CI świadomie NIE ma.** `npm run quality` wymaga danych
krajowych i bez nich kończy się kodem 2, więc byłby czerwony zawsze i z powodu,
który nie jest regresją. `scripts/e2e.sh` dochodzi w 0.3, razem z decyzją A1 —
dopóki przebieg staje na ładowaniu ULIC, dodanie go oznaczałoby czerwony CI od
pierwszego dnia. Zasada: **w tym przebiegu nie ma kroku, który ma prawo być
czerwony „normalnie”**.

**Usterka znaleziona przy 0.2:** `docker compose up -d db` na czystym wolumenie
**nie wstaje**. Compose montuje `db/migrations` jako `docker-entrypoint-initdb.d`,
migracje idą alfabetycznie, a 003 przerywa, bo wymaga `ix_pa_ulic_id`, którego
001 ani 002 nie zakładają. Sprawdzone przebiegiem na czystej bazie: 001 OK,
002 OK, **003 przerwana**, 004 OK, 005 OK. To sprzed refactoru. Blokuje
postawienie projektu od zera, onboarding i ścieżkę odtworzenia. CI i `e2e.sh`
obchodzą to jawnym krokiem `CREATE INDEX IF NOT EXISTS ix_pa_ulic_id` przed 003;
właściwe zamknięcie to narzędzie do migracji z fazy 1.

### Faza 0 — zamknięcie i to, czego uczy

**A1 rozstrzygnięte: scalanie po `sym_ul`, nie po nazwie.** Ładowarka ULIC
dostała ten sam cel konfliktu co `publikuj_zrzut`:
`ON CONFLICT (simc, sym_ul) WHERE sym_ul IS NOT NULL AND withdrawn_at IS NULL`.
Uzasadnienie było już w migracji 005 — dawny klucz łączył obiekty po nazwie,
a TERYT ustawia cechę `ul.` tam, gdzie PRG zostawia NULL, więc ta sama ulica
wchodziła dwa razy (usterka 6.23, 53% katalogu). Przy okazji klucz dedupu
w pamięci poszedł za indeksem, bo plik sam to sobie narzucał komentarzem
„klucz taki sam jak indeks docelowy", a po 003 już nim nie był.

**Cztery kolejne martwe ścieżki, wykryte dopiero przez uruchomienie:**

| gdzie | co było |
|---|---|
| `/v1/numbers` | `p.nr_key`, `p.nr_sort`, `p.wycofany_od` — trzy kolumny sprzed 005, **500 na każde żądanie** |
| `/v1/reverse` | `lat` i `lon` przekazywane jako `$1`/`$2`, których zapytanie **nie używa** — Postgres nie miał z czego wywieść typu, **500** |
| `load-impa.ts` | alias `AS wspolne` przy odczycie `c.shared` → `NaN` w raporcie rozbieżności; `ORDER BY z.miejscowosc` |
| `POST /admin/keys` | nieistniejący `clientId` dawał 500 z treścią błędu Postgresa zamiast 404 |

**Najważniejsza lekcja fazy 0 dotyczy kontroli, nie kodu.** Napisałem asercję
treści w kroku 8 `e2e.sh` jako strażnika słowników GML — i **sprawdziłem, czy
umie nie przejść**. Nie umiała: po przetłumaczeniu klucza `ulica` przebieg
nadal był zielony. Powód: fixture TERYT niesie `CECHA` w `ULIC.csv` i `RM`
w `SIMC.csv`, a TERYT ma pierwszeństwo, więc te pola nie pochodzą wtedy ze
słownika GML. Kontrola pilnowała czegoś innego, niż deklarowała.

Właściwym strażnikiem jest `packages/etl/test/gml-dictionaries.ts` — porównuje
zamrożony słownik źródłowy co do klucza i **jest sprawdzony w obie strony**:
przechodzi na poprawnym kodzie i wywraca się po zepsuciu `ulica`.

Stąd zasada na dalsze fazy: **zanim uznasz kontrolę za gotową, zepsuj to, co
sprawdza, i zobacz czerwone.** Kontrola, której nikt nie widział czerwonej,
jest hipotezą, nie zabezpieczeniem.

### Stan kontroli po fazie 0

| polecenie | co pilnuje | w CI |
|---|---|---|
| `npm run typecheck` | pełny `strict`, 0 błędów | tak |
| `npm test` | 7 zestawów hermetycznych, w tym słowniki źródłowe | tak |
| `npm run test:db` | 7 zestawów na bazie, w tym próba dymna 21 tras | tak |
| `./scripts/e2e.sh` | cała ścieżka ETL → publikacja → artefakt → treść | tak |
| `npm run bench` | próba dymna przyrządu | tak (mały nakład) |
| `npm run quality` | 28 przypadków jakości | **nie** — wymaga danych krajowych |

**Domknięcie 0.5 — usunięcie wystąpień to nie to samo co zamknięcie klasy.**
Poprawione enumy w `openapi.yaml` nie chroniły przed niczym na przyszłość:
`openapi-conformance.ts` porównywał wyłącznie ścieżki, więc rozjazd wartości
przechodził niezauważony (i przechodził — `niezweryfikowany` w specyfikacji
wobec `unverified` w kodzie). Źródłem prawdy są teraz tablice `as const`
w kodzie: `CONFIDENCE_VALUES` w `core/types.ts` oraz `UNAUTHENTICATED_RESULTS`
i `DENIAL_STATES` w `api/keys/auth.ts` — bo tylko one istnieją w czasie
wykonania, a unia typu znika przy uruchomieniu. Konformancja porównuje je ze
specyfikacją i **jest sprawdzona w obie strony**.

---

## 12. Faza 1 — kręgosłup

### 1.1 Narzędzie migracji — WYKONANE

`db/migrate.ts`, uruchamiane przez `npm run migrate`. Trzy polecenia:

```bash
npm run migrate            # wgraj brakujące
npm run migrate status     # co jest wgrane, co czeka
npm run migrate baseline   # oznacz jako wgrane, NIE uruchamiając
```

**Odstępstwo od planu, świadome.** Plan wskazywał `node-pg-migrate`. Nie
pokrywa trzech rzeczy, których tu potrzeba, więc i tak trzeba by dopisać kod
wokół niego: **oznaczenia wstecznego** (001–005 są już na produkcji i nie wolno
ich uruchomić drugi raz), **sum kontrolnych** (bez nich zmiana wgranego pliku
jest niewidoczna — a do 003 dopisano `COMMIT` już po wgraniu) oraz
pozostawienia plików **surowym SQL-em** (node-pg-migrate oczekuje znaczników
`-- Up Migration`, czyli przepisania historii). Cena: ~150 linii bez zależności.

Własności: rejestr w `migration.applied`, suma kontrolna każdego pliku, blokada
doradcza na czas przebiegu, osobna transakcja na migrację — z wykryciem plików,
które **prowadzą transakcję same** (003 i 005 mają własne `BEGIN`/`COMMIT`,
więc owinięcie ich w kolejną kończyłoby się zamknięciem cudzej).

Rozbieżność sumy kontrolnej jest **ostrzeżeniem, nie błędem**: plik już
przeszedł, ponowne wgranie niczego nie naprawi, a zatrzymanie wdrożenia byłoby
gorsze niż sam problem. Ale operator ma wiedzieć, że historia i baza się
rozjechały.

### Trzy rzeczy, które to zamknęło przy okazji

1. **Świeży `docker compose up -d db` znów wstaje.** Warunek wstępny w 003
   zakłada teraz `ix_pa_ulic_id` **sam, gdy tabela jest pusta** — bo świeża baza
   nie ma jak spełnić go wcześniej. Na tabeli z danymi zostaje jak było:
   przerwanie z instrukcją, bo tam indeks naprawdę trzeba założyć
   `CONCURRENTLY` i poza transakcją.
2. **Zdjęte montowanie `db/migrations` jako `docker-entrypoint-initdb.d`.**
   Dwie drogi wgrywania schematu to dwie prawdy o tym, co baza ma — a initdb
   nie zapisuje niczego w rejestrze. Po `docker compose up -d db` uruchamia się
   `npm run migrate`.
3. **`e2e.sh` i CI przeszły na migrator.** Zniknęła ręcznie utrzymywana
   sekwencja `psql` z osobnym krokiem na indeks, która rozjeżdżała się przy
   każdej nowej migracji.

**Zweryfikowane:** świeża baza postawiona wyłącznie migratorem ma schemat
identyczny z produkcyjnym (te same trzy unikaty na `address.street`, w tym oba
częściowe z 003), `test:db` na niej przechodzi, a ponowne `up` jest bezczynne.
Produkcyjna baza oznaczona wstecznie — 8 605 682 punkty nietknięte.

### 1.2–1.5 Kręgosłup — schemat i silnik polityki

**Migracja 006**, pierwsza wgrywana nowym narzędziem. Osobny schemat `panel`,
bez kluczy obcych w stronę `address` — z tego samego powodu co przy 004:
`e2e.sh` robi `TRUNCATE address.* CASCADE`, a kaskada nie może wynosić kont
i dziennika audytu.

| tabela | po co |
|---|---|
| `panel.account` | konta ludzi; wyłączane, nie kasowane — dziennik musi mieć na co wskazywać |
| `panel.role` | role jako **dane**, edytowalne z panelu |
| `panel.role_permission` | uprawnienia roli, nazwy z katalogu w kodzie |
| `panel.role_includes` | składanie ról, z wykrywaniem cykli |
| `panel.role_assignment` | **tu mieszka zakres** — `scope_terc` i `scope_client_id` |
| `panel.session` | sesje po wzorcu 8.4a, skrót zamiast wartości jawnej |
| `panel.audit_log` | **jeden** dziennik dla wszystkich czterech rodzajów wykonawcy |

**Silnik: `packages/core/src/policy/`** — funkcja czysta, bez bazy i bez sieci.
Wszystko dostaje w `Actor`, więc testuje się bez stawiania czegokolwiek,
a wywołanie w ścieżce żądania kosztuje tyle, co przejście po tablicy.
Ładowanie nadań z bazy jest osobną sprawą i mieszka w `packages/api`.

Trzy rzeczy, które wpisałem świadomie pod kątem utrzymania przez kogoś innego:

1. **Decyzja niesie uzasadnienie**, nie `true`/`false`. Przy składaniu ról
   pytanie „dlaczego ta osoba to może" pada natychmiast, a `via` odpowiada
   na nie także po fakcie, bo trafia do dziennika.
2. **Pomyłka wołającego rzuca, a nie odmawia.** Podanie zakresu terytorialnego
   do uprawnienia globalnego to błąd programisty. Zwrócenie z tego powodu
   „brak dostępu" ukryłoby go pod poprawnie wyglądającym 403.
3. **Uprawnienie niesie oś zakresu.** `release.publish` jest globalne, bo
   wydanie jest krajowe — panel nie pozwoli nadać ustawienia bez znaczenia.

**Zweryfikowane doświadczalnie:** wykrywanie cykli odmawia przy próbie
`redaktor` zawiera `koordynator` (który już zawiera `redaktor`); ograniczenie
`CHECK` odrzuca `scope_terc = 'MAZOWSZE'` i przyjmuje `14`. Zestaw
`packages/core/test/policy.ts` — 19 kontroli, w tym te sprawdzające, że
zawężenia **nie da się obejść pominięciem parametru**.

### 1.6 Kontrakt błędów i logowanie — DO ZROBIENIA

Wymaganie: kody odpowiedzi mają odpowiadać temu, co się faktycznie stało,
a nie sprowadzać się do 400 albo 500. Problem jest udokumentowany dzisiejszym
znaleziskiem: `POST /admin/keys` z nieistniejącym `clientId` zwracało **500
z treścią błędu Postgresa**, wraz z nazwą ograniczenia z bazy. Naprawione
doraźnie na 404, ale mechanizmu nie ma — każda kolejna trasa powtórzyłaby błąd.

Zakres w zadaniu #9: jedna warstwa kształtująca błąd, klasa bazowa
z `{status, code}`, mapowanie SQLSTATE, spójny kształt ciała **wszystkich**
odpowiedzi, identyfikator korelacji w nagłówku i w `panel.audit_log`, oraz
rozszerzenie próby dymnej o celowe wywoływanie 404 i 409.

### 1.2–1.4 Wykonawca, dziennik i szew — WYKONANE

**Ładowanie nadań** (`api/src/policy/grants.ts`). Rozwinięcie składania ról robi
**baza**, zapytaniem rekurencyjnym — rekurencja po stronie aplikacji oznaczałaby
N+1 zapytań i własną obsługę cykli. Ścieżka pochodzenia budowana po drodze,
więc `via` niesie `rola koordynator < redaktor`, czyli odpowiedź na pytanie
„skąd ta osoba ma to uprawnienie". Uwzględniane są wyłącznie przypisania czynne:
rola niewyłączona, przypisanie w okresie ważności — wykonawca zewnętrzny
z datą końca traci dostęp sam z siebie.

**Dziennik audytu** (`api/src/policy/audit.ts`). Błąd zapisu jest logowany, ale
**nie przerywa obsługi** — odwrotna decyzja znaczyłaby, że awaria tabeli audytu
kładzie całą powierzchnię administracyjną. Odmowa zapisywana na równi z nadaniem.

**Szew jest prawdziwy, nie teoretyczny.** Token operatora też przechodzi przez
silnik — z uprawnieniami roli `administrator` wczytanymi **z bazy**, nie
zaszytymi w kodzie. Dzięki temu ścieżka autoryzacji jest sprawdzona, zanim
powstaną konta, a odjęcie uprawnienia w panelu zadziała także na token.

**Test wymuszający** (`test/policy-seam.ts`): trasy zbierane z **routera**,
każda wołana, a potem sprawdzane, czy w dzienniku pojawił się wpis o tym samym
identyfikatorze korelacji. Brak wpisu = trasa ominęła silnik. Zwyczaj zamieniony
w regułę.

### Wada znaleziona przez ten test — i to produkcyjna

Zestaw najpierw świecił na **zielono z zepsutym kodem**. Powód: `req.id`
Fastify to licznik per instancja, zaczynający od 1, więc zapytanie o wpisy
po identyfikatorze korelacji trafiało w wiersze z **poprzednich uruchomień**.

To nie jest wada testu, tylko projektu: przy dwóch podach oba mają żądanie
`req-1`, więc w produkcji zestawienie odpowiedzi z wpisem w dzienniku trafiałoby
w cudzy wiersz. Naprawione — `genReqId` daje `randomUUID()`, a nagłówek
`x-correlation-id` jest honorowany po oczyszczeniu (trafia do logu i do bazy,
więc nie może być dowolnym ciągiem od klienta). Koszt: ~7 µs na żądanie,
zmierzone; próg kosztu uwierzytelniania trzyma z ośmiokrotnym zapasem.

### 1.6 Kontrakt błędów — WYKONANE

Katalog **27 kodów** w `core/src/errors.ts` z kodem stanu i treścią — to jest
mapa tłumacząca: panel używa `error` wprost albo tłumaczy sobie po `code`,
który jest **stabilny**. Rozdzielony od `ISSUE_CODES` (12), bo tamte opisują
zastrzeżenia **wewnątrz poprawnej odpowiedzi 200**.

Kształt każdej odpowiedzi błędu: `{ code, error, info?, correlationId }` —
także dla 500 i nieznanej trasy. Wszystko nierozpoznane kończy jako `INTERNAL`;
mapowane są tylko te SQLSTATE, które są **błędem wołającego**. `42703`
(„nie ma takiej kolumny") idzie jako 500, bo to nasza wada — zamiana na 400
ukryłaby usterkę pod kodem sugerującym, że zawinił klient.

Konformancja porównuje ze specyfikacją **trzy** katalogi: `Confidence`,
`ErrorCode` i `Issue.code`, plus sprawdza, że zawężone listy kodów przy
odpowiedziach nie wymieniają nic spoza katalogu.

### Stan kontroli po etapie 1

| polecenie | zestawów | co doszło |
|---|---|---|
| `npm test` | 8 | silnik polityki, słowniki źródłowe |
| `npm run test:db` | 9 | próba dymna tras, szew polityki |
| `npm run migrate` | — | rejestr, sumy kontrolne, `baseline` |

**Warunek wejścia w etap 2 jest spełniony** — wszystkie siedem punktów
z rozdziału 11: typy w CI, e2e asertujące treść, rejestr migracji, jedno
pojęcie wykonawcy i jeden dziennik audytu, `can()` jako szew, kolumna zakresu
w schemacie, kontrakt zgodny z kodem i pilnowany konformancją.
