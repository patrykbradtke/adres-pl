# Plan doprowadzenia do wersji produkcyjnej — back-end

Stan wyjściowy: 7 sierpnia 2026. Baza zawiera 4 województwa (1 990 483 punkty),
API odpowiada na prawdziwych danych, komplet 16 archiwów PRG leży na dysku.

Zakres tego dokumentu to **back-end**. Panel administracyjny — patrz notatka
na końcu, do zaplanowania osobno.

Nakłady w dniach roboczych jednej osoby.

---

## Etap 0. Zabezpieczenie stanu — 0,5 dnia, PILNE

Wszystkie poprawki z 6–7 sierpnia istnieją wyłącznie w drzewie roboczym.
Katalog projektu nie jest śledzony przez git. Awaria dysku = utrata pracy.

| # | zadanie |
|---|---|
| 0.1 | Repozytorium dla `adres-pl` (osobne, nie w katalogu domowym) |
| 0.2 | Commit stanu z opisem 5 napraw: parser UTF-8, wiązanie referencji, duplikaty, zapytanie z `OR`, ładowanie TERYT |
| 0.3 | Zdalne repozytorium + push |
| 0.4 | `.gitignore` na `data/` — 1,8 GB archiwów nie należy do repozytorium |

---

## Etap 1. Dokończenie bazy produkcyjnej — 3–4 dni

Cel: komplet danych i **niezależność od źródła zewnętrznego**.

| # | zadanie | nakład | zależy od |
|---|---|---|---|
| 1.1 | Załadowanie 12 pozostałych województw (`cycle --rownolegle 4`) | 0,5 d | — |
| 1.2 | Publikacja pełnego kraju, weryfikacja wobec 8,56 mln punktów | 0,5 d | 1.1 |
| 1.3 | Artefakt na pełnym zbiorze — pomiar rozmiaru i zużycia pamięci | 0,5 d | 1.2 |
| 1.4 | **Archiwum poza maszyną** — wysyłka archiwów i artefaktów do magazynu obiektowego | 1 d | 1.2 |
| 1.5 | Odtworzenie z archiwum bez internetu (`cycle --z-archiwum`) — przećwiczyć | 0,5 d | 1.4 |
| 1.6 | Kopie zapasowe bazy: harmonogram, retencja, test odtworzenia | 1 d | 1.2 |

**Uwaga do 1.4:** `docker-compose.yml` deklaruje MinIO, ale nic z niego nie
korzysta — archiwum leży wyłącznie na dysku lokalnym. To dokładnie ten
scenariusz, przed którym miał chronić „poziom 4” odporności. Dopóki kopia nie
jest poza maszyną, zabezpieczenia nie ma.

**Ukończenie:** skasowanie bazy i odtworzenie z archiwum bez dostępu do sieci
kończy się kompletem 8,56 mln punktów.

---

## Etap 2. Wydajność i przetwarzanie równoległe — 6–8 dni

Zrównoleglenie działa (zmierzone 3,6× na czterech procesach), ale jest
„ślepe” — brak wglądu w postęp, sterowania i zabezpieczeń.

### 2A. Zarządzanie przetwarzaniem równoległym

| # | zadanie | nakład | uzasadnienie |
|---|---|---|---|
| 2.1 | Raportowanie postępu do bazy: proces, województwo, rekordy, etap | 1,5 d | podczas 38-minutowego ładowania nie było widać nic |
| 2.2 | Dobór liczby procesów do dostępnej pamięci, nie do rdzeni | 0,5 d | ~400 MB na proces, limit poda to twarde ograniczenie |
| 2.3 | Zatrzymanie i wznowienie cyklu; wznowienie od nieukończonych województw | 1,5 d | dziś przerwanie = utrata całej pracy |
| 2.4 | Limit czasu na województwo + wykrywanie zawieszenia | 1 d | 8-godzinny przebieg bez końca nie zgłosił niczego |
| 2.5 | Kolejka zadań i rejestr uruchomień jako podstawa sterowania | 1 d | `etl_run` istnieje, wymaga rozszerzenia |
| 2.6 | Zabezpieczenie przed nakładaniem się przebiegów poza Kubernetesem | 0,5 d | `concurrencyPolicy` chroni tylko CronJob |

### 2B. Audyt wydajności

| # | zadanie | nakład | uzasadnienie |
|---|---|---|---|
| 2.7 | Profil pełnego cyklu na 16 województwach | 1 d | dotąd mierzone na 1–4 |
| 2.8 | Publikacja: 72 min dla 4 województw — zbadać i skrócić | 1–2 d | przy 16 może być nie do przyjęcia |
| 2.9 | Strojenie bazy pod ładowanie masowe (`work_mem`, `maintenance_work_mem`, autovacuum) | 0,5 d | domyślne 4 MB przy 2 mln wierszy |
| 2.10 | Testy regresji wydajności wyszukiwania | 1 d | mediana wzrosła z 0,49 do ~4 ms |
| 2.11 | Zapytania o dużej liczbie kandydatów („Nowa Wieś” — 42 ms) | 1 d | 2.10 |
| 2.12 | Przegląd zapytań pod kątem wzorca z `OR` i pętli zagnieżdżonych | 1 d | ten sam błąd może być gdzie indziej |

**Ukończenie:** znany budżet czasu pełnego cyklu, progi alarmowe, oraz
możliwość odpowiedzi na pytanie „na czym stoi przetwarzanie” bez zaglądania
do `pg_stat_activity`.

---

## Etap 3. Podział na dwa serwisy — 3–5 dni

Podział istnieje w warstwie uruchomieniowej (osobne obrazy `etl` i `api`),
ale oba dzielą repozytorium, zależności i uprawnienia do bazy.

| # | zadanie | nakład |
|---|---|---|
| 3.1 | Rozdzielenie ról w bazie: ETL zapisuje, API czyta | 0,5 d |
| 3.2 | API bez dostępu do `staging` — wyłącznie schemat `adres` | 0,5 d |
| 3.3 | Osobne potoki budowania i wersjonowanie obrazów | 1 d |
| 3.4 | Kontrakt między serwisami: artefakt + wskaźnik wersji jako jedyny styk | 1 d |
| 3.5 | Skalowanie poziome API — test wielu instancji na jednym artefakcie | 0,5 d |
| 3.6 | Osobne alarmy i wskaźniki dla obu serwisów | 0,5 d |

**Decyzja do podjęcia:** czy API ma utrzymywać połączenie z bazą. Dziś
potrzebuje go do numerów budynków, kodów pocztowych i geokodowania odwrotnego.
Włączenie tych danych do artefaktu uniezależniłoby API całkowicie, ale
powiększa artefakt i wydłuża budowę. Wymaga oszacowania.

---

## Etap 4. Wersjonowanie wydań — 4–5 dni

| # | zadanie | nakład |
|---|---|---|
| 4.1 | Tabela wydań: identyfikator, data, źródła, sumy kontrolne, status | 1 d |
| 4.2 | Wersja danych w **każdej** odpowiedzi API (nagłówek + pole w treści) | 0,5 d |
| 4.3 | Rozdzielenie wersji API (`/v1`) od wersji danych | 0,5 d |
| 4.4 | Wycofanie wydania: przestawienie wskaźnika, procedura i test | 1 d |
| 4.5 | Wydanie kanarkowe — część instancji na nowym artefakcie | 1 d |
| 4.6 | Przypięcie klienta do konkretnej wersji danych | 1 d |
| 4.7 | Historia wydań dostępna przez API | 0,5 d |

**Uwaga do 4.6:** utrzymywanie kilku artefaktów naraz to wielokrotność zużycia
pamięci. Wymaga decyzji, ile wersji wstecz obsługujemy i jak długo.

---

## Etap 5. Audyt zmian i kontrola nadpisywania — 5–7 dni

| # | zadanie | nakład |
|---|---|---|
| 5.1 | Dziennik zmian rekordów: co, kiedy, z jakiego źródła, poprzednia wartość | 2 d |
| 5.2 | Raport różnic między wydaniami, w rozbiciu na gminy | 1,5 d |
| 5.3 | Reguły precedencji źródeł — jawne i konfigurowalne | 1 d |
| 5.4 | Ochrona zmian ręcznych przed nadpisaniem przez automat | 1,5 d |
| 5.5 | Podgląd zmian przed publikacją (tryb „co się stanie”) | 1 d |

**Uwaga do 5.3:** dziś precedencja jest zaszyta w SQL (nazwa z TERYT wygrywa
z PRG, geometria odwrotnie). Działa, ale jest niewidoczna dla administratora
i niezmienialna bez wdrożenia.

**Uwaga do 5.4:** bez tego pierwsza nocna aktualizacja skasuje wszystkie ręczne
poprawki. Wymaga znacznika pochodzenia **na poziomie pola**, nie rekordu —
inaczej ręczna korekta kodu pocztowego zablokuje aktualizację geometrii.

---

## Etap 6. Braki blokujące wdrożenie — 8–10 dni

Z rozpoznania rynku, uporządkowane wg pilności.

### Bezpieczeństwo i dostęp

| # | zadanie | nakład | uwagi |
|---|---|---|---|
| 6.1 | **Uwierzytelnianie klientów API** | 2 d | dziś `x-api-key` służy tylko do limitowania — nikt go nie sprawdza, API jest otwarte |
| 6.2 | Klucze testowe i produkcyjne, limity per klient | 1,5 d | standard w usługach tej klasy |
| 6.3 | Retencja i anonimizacja logów zapytań | 1 d | zapytania zawierają adresy — to dane osobowe |
| 6.4 | Rejestr czynności przetwarzania (RODO) | 1 d | wymagane przed produkcją |

### Kontrakt

| # | zadanie | nakład | uwagi |
|---|---|---|---|
| 6.5 | Specyfikacja OpenAPI jako źródło prawdy | 1,5 d | 12 endpointów bez formalnego kontraktu |
| 6.6 | Polityka wycofywania wersji API | 0,5 d | ile wstecz, z jakim wyprzedzeniem |
| 6.7 | Dokumentacja dla integratorów | 2 d | |

### Jakość i eksploatacja

| # | zadanie | nakład | uwagi |
|---|---|---|---|
| 6.8 | Zbiór wzorcowy i testy regresji jakości wyszukiwania | 2 d | bez tego aktualizacja może cicho pogorszyć wyniki |
| 6.9 | Cele dostępności i czasu odpowiedzi, alarmy przy przekroczeniu | 1 d | `/metrics` i alarmy istnieją, brak progów |
| 6.10 | Powiadomienie o nowej wersji danych (webhook) | 1 d | klient wie, kiedy odświeżyć |
| 6.11 | Procedura postępowania przy awarii źródła | 0,5 d | poziomy odporności opisane, nieprzećwiczone |

### Odłożone świadomie

| # | zadanie | uwagi |
|---|---|---|
| 6.12 | Drugie źródło (iMPA) | 5 d, wymaga wyjaśnienia licencji |
| 6.13 | Walidacja wsadowa z kolejką | 3 d, endpoint `/v1/batch` istnieje bez kolejkowania |
| 6.14 | Kody pocztowe z Poczty Polskiej | decyzja licencyjna, dziś przybliżenie z ewidencji gminnych |
| 6.15 | Wykrywanie luk wobec OSM | 2 d, schemat `qa_osm` już przygotowany |

---

## Etap 7. Monitorowanie i obserwowalność — 6–8 dni

**Stan wyjściowy jest lepszy, niż się wydaje, ale niedokończony.** Aplikacja
wystawia 15 metryk pod `/metrics` (wiek danych, status ostatniego przebiegu,
spójność artefaktu z bazą, zużycie pamięci, dostępność bazy) oraz ma gotowe
trzy reguły alertów w `deploy/alerty.yaml`, każdą przypisaną do konkretnego
scenariusza awarii — łącznie z zamrożeniem danych po stronie źródła.

Czego brakuje: **czegokolwiek, co te metryki zbiera**. W konfiguracji
uruchomieniowej nie ma Prometheusa ani Grafany, reguły alertów nie są nigdzie
wczytane. Dziś jedynym sposobem sprawdzenia stanu jest ręczne odpytanie
`/status`. Tak wykryliśmy w tej sesji ośmiogodzinny przebieg bez końca — czyli
nie wykryliśmy go wcale, zgłosił go człowiek.

| # | zadanie | nakład | uzasadnienie |
|---|---|---|---|
| 7.1 | Stos monitorujący: Prometheus + Grafana + Alertmanager, w konfiguracji lokalnej i wdrożeniowej | 1,5 d | metryki i reguły już są, brakuje odbiorcy |
| 7.2 | Pulpit operacyjny: stan danych, przebiegi, wydajność API, zużycie zasobów | 1,5 d | jeden ekran odpowiadający na pytanie „czy jest dobrze” |
| 7.3 | Metryki przebiegu ETL w czasie rzeczywistym: postęp per proces i województwo | 1 d | wspólne z 2.1 — dziś przetwarzanie jest nieprzejrzyste |
| 7.4 | Alerty dla API: czas odpowiedzi p95/p99, błędy 5xx, zużycie pamięci wobec limitu 1 GB | 1 d | istniejące alerty pilnują wyłącznie danych, nie usługi |
| 7.5 | Sonda syntetyczna: cykliczne zapytanie kontrolne z weryfikacją treści odpowiedzi | 0,5 d | wykrywa „usługa odpowiada, ale zwraca bzdury” |
| 7.6 | Centralne logi z korelacją do metryk | 1 d | dziś logi żyją w kontenerze |
| 7.7 | Cele poziomu usługi (SLO) i alerty oparte na budżecie błędu | 1 d | zamiast progów sztywnych, mniej fałszywych alarmów |
| 7.8 | Zasady eskalacji: kto dostaje alert, co budzi w nocy, co czeka do rana | 0,5 d | alert bez adresata jest bezużyteczny |

**Zasada dla alertów:** reagować na objawy odczuwalne dla użytkownika, a nie na
przyczyny techniczne. Istniejące trzy reguły są dobrym wzorcem — każda mówi
nie tylko „co”, ale też „co z tym zrobić”.

**Monitorowanie jakości danych to osobna rzecz niż monitorowanie systemu.**
Wiek zrzutu jest już pilnowany, ale nie ma wskaźnika mówiącego, czy wyniki
wyszukiwania nie pogorszyły się po aktualizacji. Zbiór wzorcowy zapytań
(zadanie 6.8) powinien być uruchamiany cyklicznie i raportować do tego samego
stosu — inaczej regres jakości wyjdzie dopiero od klienta.

**Śledzenie rozproszone (OpenTelemetry) — świadomie odłożone.** Przy dwóch
serwisach o prostym przepływie daje niewiele. Sens pojawi się, gdy dojdzie
panel administracyjny i kolejki zadań; wtedy warto wrócić, tym bardziej że
instrumentacja jest wtedy neutralna wobec wyboru dostawcy.

---

## Decyzje technologiczne do rozstrzygnięcia

### NestJS zamiast Fastify?

**Rekomendacja: nie dla serwisu danych, rozważyć dla serwisu administracyjnego.**

Argumenty przeciw w serwisie danych:
- Projekt działa **bez kroku kompilacji** (`node --experimental-strip-types`).
  NestJS opiera się na dekoratorach i `emitDecoratorMetadata`, czyli wymaga
  pełnej kompilacji TypeScriptu. To odwrócenie przyjętej filozofii.
- Serwis danych to 12 endpointów bezstanowych, w których liczy się czas
  odpowiedzi liczony w ułamkach milisekundy. Warstwa wstrzykiwania zależności
  nie wnosi tu wartości.
- Fastify jest fundamentem także dla NestJS — rezygnacja z pośrednika nic nie
  odbiera poza strukturą, której przy 12 endpointach nie brakuje.

Argumenty za w serwisie administracyjnym (późniejszy etap):
- Autoryzacja, role, walidacja danych wejściowych, generowanie OpenAPI —
  wszystko to NestJS daje gotowe, a tam będzie tego dużo.
- Ruch administracyjny jest znikomy, więc narzut nie ma znaczenia.
- Naturalnie łączy się z Angularem po stronie panelu (ten sam język, wspólne
  typy kontraktu).

**Wniosek:** trzymać serwis danych na Fastify, a NestJS rozważyć wyłącznie jako
back-end panelu. To zresztą wzmacnia podział z etapu 3.

### ORM?

**Rekomendacja: nie w ETL i w serwisie danych. Ewentualnie w serwisie
administracyjnym.**

- ETL opiera się na `COPY` i zapytaniach masowych — ORM tego nie obsługuje
  sensownie, a to właśnie ta ścieżka decyduje o czasie przetwarzania.
- Zapytania serwisu danych są strojone pod konkretne indeksy, w tym przestrzenne
  (PostGIS). Prisma obsługuje PostGIS słabo, TypeORM przeciętnie.
- Gdyby ORM miał wejść do części administracyjnej (proste operacje na
  rekordach), najlepszym kandydatem jest **Drizzle** — leży blisko SQL,
  ma dobre typowanie i nie ukrywa zapytań.

### Czego brakuje niezależnie od powyższego

**Narzędzie do migracji bazy — luka do uzupełnienia.** Dziś migracje wykonują
się wyłącznie przez mechanizm inicjalizacji kontenera. Jest to kruche:
w trakcie prac kontener bazy podniósł się od zera i uruchomił migracje
ponownie, a ręczne poprawki funkcji trzeba było wgrywać osobno. Potrzebne jest
wersjonowanie schematu z rejestrem zastosowanych migracji (`node-pg-migrate`
albo Drizzle Kit, jeśli zapadnie decyzja o Drizzle). Nakład: 1,5 d.

---

## Panel administracyjny — notatka, do zaplanowania osobno

Ustalenia na teraz:
- **Angular**, aplikacja jednostronicowa (SPA)
- **Autoryzacja** z rolami (administrator, operator, podgląd)
- Back-end panelu — kandydat na NestJS, patrz decyzje technologiczne
- Zakres funkcjonalny: zarządzanie aktualizacjami, import ręczny z pliku,
  ręczna edycja i dodawanie adresów, przeglądanie raportów zmian

Warunek wstępny: panel wymaga etapów 4 i 5 (wersjonowanie i audyt), bo bez nich
nie ma czym zarządzać. Import ręczny i edycja muszą przechodzić przez ten sam
mechanizm kontroli jakości co automat — inaczej panel stanie się drogą obejścia
zabezpieczeń.

---

## Podsumowanie nakładów — back-end

| etap | zakres | nakład |
|---|---|---|
| 0 | Zabezpieczenie stanu | 0,5 d |
| 1 | Dokończenie bazy | 3–4 d |
| 2 | Wydajność i przetwarzanie równoległe | 6–8 d |
| 3 | Podział na serwisy | 3–5 d |
| 4 | Wersjonowanie wydań | 4–5 d |
| 5 | Audyt zmian | 5–7 d |
| 6 | Braki blokujące (bez 6.12–6.15) | 8–10 d |
| 7 | Monitorowanie i obserwowalność | 6–8 d |
| — | Narzędzie migracji | 1,5 d |
| **razem** | | **37–49 dni** |

Około **7,5–10 tygodni** pracy jednej osoby na sam back-end. Panel
administracyjny doliczyć osobno po zaplanowaniu.

## Kolejność

Etapy 0 i 1 są pilne i niezależne od reszty. Etap 2 przed 3, żeby nie
przenosić problemów wydajnościowych do nowej struktury. Etapy 4 i 5 muszą
poprzedzać prace nad panelem. Z etapu 6 pozycje 6.1, 6.3, 6.5, 6.8 wykonać
przed pierwszym wdrożeniem produkcyjnym niezależnie od reszty harmonogramu.

Etap 7 warto zacząć **wcześnie i częściowo** — zadania 7.1 i 7.2 (stos
monitorujący i pulpit) kosztują 3 dni, a od razu zaczynają się zwracać przy
pracach z etapów 1 i 2. Reszta etapu 7 może poczekać na ustabilizowanie usługi.
