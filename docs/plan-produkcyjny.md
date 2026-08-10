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
| 1.1 | ~~Załadowanie 12 pozostałych województw~~ **WYKONANE 9.08.2026** — komplet 16, ~17 min przy `--rownolegle 4` | — | — |
| 1.2 | ~~Publikacja pełnego kraju~~ **WYKONANE 9.08.2026** — 8 605 682 punkty, o 45 tys. więcej niż zapowiadane 8,56 mln (przyrost za 4 miesiące) | — | — |
| 1.3 | ~~Artefakt na pełnym zbiorze~~ **WYKONANE 9.08.2026** — 791 211 pozycji, 109,3 MB, RSS procesu 239 MB | — | — |
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
| 2.7 | ~~Profil pełnego cyklu na 16 województwach~~ **WYKONANE 9.08.2026** — ~3 h 25 min, rozbicie niżej | — | — |
| 2.8 | Publikacja: **2 h 16 min dla całego kraju** — zbadać i skrócić | 1–2 d | to 2/3 całego cyklu; wcześniejszy szacunek 72 min dotyczył 4 województw |
| 2.9 | Strojenie bazy pod ładowanie masowe (`work_mem`, `maintenance_work_mem`, autovacuum) | 0,5 d | domyślne 4 MB przy 2 mln wierszy |
| 2.10 | Testy regresji wydajności wyszukiwania | 1 d | jest już `bench-realny.ts`; podpiąć do cyklu i ustawić progi |
| 2.11 | **Rozgrzewanie instancji przed skierowaniem ruchu** | 0,5 d | pierwsze zapytanie po starcie: 82 ms wobec 1,7 ms po rozgrzewce — to, a nie nazwy pospolite, jest realnym przypadkiem brzegowym |
| 2.12 | Przegląd zapytań pod kątem wzorca z `OR` i pętli zagnieżdżonych | 1 d | ten sam błąd może być gdzie indziej |
| 2.13 | **Wzmocnienie zapisu przy pełnych aktualizacjach stagingu** — przenieść `resolve_refs()` do okna ładowania masowego, zbadać wiązanie z ulicami | 1–1,5 d | zmierzone 8.08.2026, patrz niżej |

**Uwaga do 2.13 — zmierzone na komplecie 16 województw (8 605 908 punktów).**
W ścieżce publikacji są **dwie pełne aktualizacje** tabeli `staging.punkt_adresowy`,
obie przy nałożonych trzech indeksach, czyli każdy wiersz to nowa krotka plus
trzy wpisy indeksowe — ponad 25 mln operacji na indeksach na każdą z nich:

| operacja | gdzie | zmierzony czas |
|---|---|---|
| `resolve_refs()` — wypełnienie `simc` | poza oknem ładowania masowego | **~49 min** |
| wiązanie punktów z ulicami (`ulic_id`) | wewnątrz `publikuj_zrzut()` | ponad 30 min |

Kontener bazy zaraportował **303 GB zapisów** przy zbiorze ważącym 9 GB —
trzydziestokrotne wzmocnienie zapisu. Pierwszą operację da się przenieść do
okna `przed_ladowaniem`/`po_ladowaniu`, gdzie indeksów nie ma (poprawka
przygotowana w `002_staging.sql`, wymaga ręcznego wgrania — patrz luka
„narzędzie do migracji”). Druga siedzi wewnątrz transakcji publikującej, więc
wymaga osobnego podejścia. Powiązane z 2.8 i 2.9.

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
| 6.1 | **Uwierzytelnianie klientów API** | — | rozwinięte w etapie 8A wraz z licencjami; nie planować podwójnie |
| 6.2 | Klucze testowe i produkcyjne, limity per klient | — | jw., etap 8A |
| 6.3 | Retencja i anonimizacja logów zapytań | 1 d | zapytania zawierają adresy — to dane osobowe |
| 6.4 | Rejestr czynności przetwarzania (RODO) | 1 d | wymagane przed produkcją |

### Kontrakt

| # | zadanie | nakład | uwagi |
|---|---|---|---|
| 6.5 | ~~Specyfikacja OpenAPI jako źródło prawdy~~ **WYKONANE 9.08.2026** — `packages/api/openapi.yaml`, wszystkie 15 tras, kształty odpowiedzi zdjęte z działającej usługi. Test `openapi-zgodnosc.ts` porównuje specyfikację z trasami Fastify w obie strony, więc nie da się jej po cichu rozjechać | — | — |
| 6.6 | Polityka wycofywania wersji API | 0,5 d | ile wstecz, z jakim wyprzedzeniem |
| 6.7 | Dokumentacja dla integratorów | 2 d | |

### Jakość i eksploatacja

| # | zadanie | nakład | uwagi |
|---|---|---|---|
| 6.8 | ~~Zbiór wzorcowy i testy regresji jakości wyszukiwania~~ **WYKONANE 9.08.2026** — 22 przypadki, `npm run jakosc`. Ujawnił 6 wad, opisanych niżej | — | — |
| 6.9 | Cele dostępności i czasu odpowiedzi, alarmy przy przekroczeniu | 1 d | `/metrics` i alarmy istnieją, brak progów |
| 6.10 | Powiadomienie o nowej wersji danych (webhook) | 1 d | klient wie, kiedy odświeżyć |
| 6.11 | Procedura postępowania przy awarii źródła | 0,5 d | poziomy odporności opisane, nieprzećwiczone |

### Wady ujawnione przez zbiór wzorcowy (9.08.2026)

Zbiór opisuje odpowiedź **poprawną**, nie bieżącą. Sześć przypadków ma znacznik
`znaneOdstepstwo` — nie przewracają zestawu, ale są wypisywane, a gdy przestaną
występować, zestaw upomina się o zdjęcie znacznika.

| # | wada | skutek | nakład |
|---|---|---|---|
| 6.16 | ~~Słowo rodzajowe wtopione w nazwę ulicy~~ **NAPRAWIONE 9.08.2026** — punktacja pomija wiodące słowo rodzajowe. Marszałkowska poz. 2, Grójecka poz. 4, Puławska poz. 1 (było: poza pierwszą 25). Zostaje warstwa danych — patrz niżej | — | — |
| 6.17 | ~~Skrytka pocztowa dostaje `zweryfikowany_rejestr`~~ **NAPRAWIONE 9.08.2026** — marker rozpoznawany przed resztą parsowania, numer skrytki nie trafia w numer budynku | — |
| 6.18 | ~~Parser wymaga przecinka jako separatora pól~~ **NAPRAWIONE 9.08.2026** — przy braku przecinka podział w miejscu kodu pocztowego | — |
| 6.19 | ~~Ranking prawie nie uwzględnia wielkości miejscowości~~ **NAPRAWIONE 9.08.2026** — do indeksu doszło pole z liczbą adresów całej miejscowości (format 1→2). „marszalkowska" i „grojecka" zwracają Warszawę na pierwszym miejscu, przy zachowanej znajdywalności wsi | — |
| 6.20 | ~~Pięciocyfrowy numer budynku czytany jako kod pocztowy~~ **NAPRAWIONE 9.08.2026** — kod bez myślnika odrzucany, gdy wychodzi na zaślepkę | — |
| 6.21 | ~~Miejscowości-widma z zerową liczbą punktów~~ **NAPRAWIONE 9.08.2026** — z indeksu wypadają miejscowości bez punktów I bez ulic (49 079, 48% słownika). Filtr funkcjonalny, nie słownikowy: 921 wpisów typu „część" ma własne adresy | — |

**6.16 — co naprawiono, a co zostaje.** Naprawiona jest warstwa wyszukiwania:
`score()` traktuje wiodące słowo rodzajowe jako przezroczyste — nie przyznaje
za nie premii prefiksowej ani nie karze za długość, którą ono zawyża. Etykiet
**nie skracamy**, bo „Aleje Jerozolimskie" czy „Rynek" to nazwy zwyczajowe
i obcięcie zmieniałoby sens. Koszt: mediana czasu odpowiedzi ok. +0,1 ms,
w granicach rozrzutu kolejnych przebiegów.

W warstwie danych problem **pozostaje** i wymaga osobnej decyzji:

| # | pozostałość | nakład |
|---|---|---|
| 6.22 | `cecha` pusta dla **wszystkich 380 440 ulic z PRG**; typ ulicy siedzi w `nazwa` dla 20 586 z nich. API zwraca `ulica: "ulica Marszałkowska"`, więc konsument doklejający cechę dostanie „ul. ulica Marszałkowska" | 1,5 d |
| 6.23 | **2 061 par duplikatów** — ta sama ulica raz czysta z TERYT, raz z przedrostkiem z PRG. Punkty adresowe wiążą się z wpisem z PRG, więc wpis z TERYT ma zero punktów i zaśmieca podpowiedzi | 1–1,5 d |

Uwaga migracyjna do obu: `publikuj_zrzut` deduplikuje po `(simc, nazwa_norm, cecha)`.
Zmiana normalizacji bez jednoczesnej migracji istniejących wierszy **utworzy
nowe rekordy zamiast zaktualizować stare** i zerwie powiązania `ulic_id`
z punktami adresowymi. Wiersze trzeba zmienić `UPDATE`, nie przeładowaniem.

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
wystawia 17 metryk pod `/metrics` (wiek danych, status ostatniego przebiegu,
spójność artefaktu z bazą, zużycie pamięci, dostępność bazy) oraz ma gotowe
trzy reguły alertów w `deploy/alerty.yaml`, każdą przypisaną do konkretnego
scenariusza awarii — łącznie z zamrożeniem danych po stronie źródła.

**Odbiorca metryk powstał 9.08.2026** — `docker compose --profile monitoring up -d`:
Prometheus na 9090, Grafana na 3001, Alertmanager na 9093, 7 reguł wczytanych,
oba cele zbierane.

**Podpięcie monitoringu natychmiast ujawniło dwa defekty**, niewidoczne wcześniej
dokładnie dlatego, że nikt nie patrzył:

| defekt | objaw | skutek |
|---|---|---|
| Loader porównywał wersję danych z **nazwą pliku** ze wskaźnika | log „podmieniono artefakt 2026-08-06 → 2026-08-06" co 60 s | każda instancja czytała i parsowała 109 MB **co minutę**, bez zmiany wersji |
| `/metrics` liczył trzy `count(*)` na tabelach produkcyjnych | odpowiedź 4,4 s przy limicie zbierania 10 s | endpoint na granicy timeoutu, każde zbieranie to pełny skan 8,6 mln wierszy |

Po naprawie: jedno ładowanie artefaktu na start, `/metrics` w 0,05–0,12 s.
Test regresji: `packages/api/test/loader-podmiana.ts`.

**Próg alertu `WysokaLatencjaPodpowiedzi` przeliczony** z 25 ms na 60 ms.
Poprzedni był skalibrowany do wycofanego pomiaru syntetycznego (1,84 ms)
i **odpaliłby się natychmiast po wdrożeniu** — zmierzone p99 na pełnym kraju
to 27,94 ms. Dołożona reguła `BrakMetrykZSerwisu`: bez niej cisza po awarii
zbierania wygląda identycznie jak stan zdrowy.

| # | zadanie | nakład | uzasadnienie |
|---|---|---|---|
| 7.1 | ~~Stos monitorujący: Prometheus + Grafana + Alertmanager~~ **WYKONANE 9.08.2026** — profil `monitoring` w compose, 7 reguł wczytanych, oba cele zbierane | — | — |
| 7.2 | ~~Pulpit operacyjny~~ **WYKONANE 9.08.2026** — `deploy/grafana/pulpit-operacyjny.json`, port 3001 | — | — |
| 7.3 | Metryki przebiegu ETL w czasie rzeczywistym: postęp per proces i województwo | 1 d | wspólne z 2.1 — dziś przetwarzanie jest nieprzejrzyste |
| 7.4 | Alerty dla API: czas odpowiedzi p95/p99, błędy 5xx, zużycie pamięci wobec limitu 1 GB | 1 d | istniejące alerty pilnują wyłącznie danych, nie usługi |
| 7.5 | Sonda syntetyczna: cykliczne zapytanie kontrolne z weryfikacją treści odpowiedzi | 0,5 d | wykrywa „usługa odpowiada, ale zwraca bzdury” |
| 7.6 | Centralne logi z korelacją do metryk | 1 d | dziś logi żyją w kontenerze |
| 7.7 | Cele poziomu usługi (SLO) i alerty oparte na budżecie błędu | 1 d | zamiast progów sztywnych, mniej fałszywych alarmów |
| 7.8 | ~~Zasady eskalacji: kto dostaje alert, co budzi w nocy, co czeka do rana~~ **WYKONANE 9.08.2026** — podział wyegzekwowany konfiguracją, nie opisem: `critical` do dyżuru natychmiast, `warning` wyciszone pon–pt 18:00–08:00 i przez weekend, dostarczane rano. Zostaje uzupełnienie adresów po wskazaniu osoby odpowiedzialnej | — |

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

## Etap 8. Komercjalizacja — 18–24 dni

Trzy obszary rozpoznane 7.08.2026. Każda rekomendacja przeszła weryfikację
adwersaryjną — zastrzeżenia zapisano, bo część przesłanek okazała się fałszywa.

### 8A. Uwierzytelnianie i licencje — 9–11 dni

**Rekomendacja:** nieprzezroczyste klucze API z prefiksem i sumą kontrolną
(`adr_live_<24 bajty base64url>_<suma>`), przechowywane jako **HMAC-SHA256
z pieprzem** trzymanym poza bazą. Bez bramy API i bez OAuth2 w pierwszej wersji.

Dlaczego HMAC, a nie bcrypt/argon2: klucz o entropii 128 bitów jest nie do
złamania siłowo niezależnie od szybkości funkcji skrótu — powolne hashowanie
chroni przed słabymi hasłami ludzi, nie przed 24 bajtami z generatora. HMAC jest
deterministyczny, więc kolumnę można zaindeksować unikatowo i trafiać jednym
zapytaniem, bez skanu tabeli.

| # | zadanie | nakład |
|---|---|---|
| 8.1 | ~~**PILNE:** poprawka `keyGenerator` — limitowanie po IP do czasu wdrożenia uwierzytelniania~~ **WYKONANE 8.08.2026** — limitowanie po `req.ip`, `TRUST_PROXY` dla pracy za ingressem, test regresji `packages/api/test/limit-obejscie.ts` | — |
| 8.0 | ~~Środowisko i hermetyczny baseline testów~~ **WYKONANE 9.08.2026** — atrapa artefaktu budowana produkcyjnym `buildIndex`, `npm test` przechodzi w świeżym klonie bez ETL i bez bazy; `.env` dopisany do `.gitignore` i `.dockerignore` (nie był ignorowany, a `Dockerfile` robi `COPY . .`) | — |
| 8.2 | ~~Model danych: `klient`, `klucz_api`, `zuzycie`~~ **WYKONANE 9.08.2026** — `db/migrations/004_licencje.sql`, osobny schemat `licencje` bez kluczy obcych w stronę `adres` (bo `e2e.sh` robi `TRUNCATE adres.* CASCADE`), unikat na skrócie **pełny, nie częściowy**, wyzwalacze `NOTIFY` na obu tabelach | — |
| 8.3 | ~~Generowanie i weryfikacja klucza w `@adres-pl/core`~~ **WYKONANE 9.08.2026** — `core/src/api-key.ts` bez ani jednego importu `node:*` (własny base64url i CRC32), suma kontrolna liczona **bez pieprza**, bo skaner wycieków musi potwierdzić kształt klucza bez naszego sekretu; HMAC z rotacją w `api/src/keys/pepper.ts` | — |
| 8.4 | ~~Uwierzytelnianie i limitowanie po zweryfikowanym kliencie~~ **WYKONANE 9.08.2026** — **zapis „jako `preHandler`" był błędny**, patrz sprostowanie niżej. Hook w `onRequest` poziomu instancji, pełna replika rejestru w pamięci zamiast cache, drugi poziom limitu dla ruchu bez ważnego klucza | — |
| 8.5 | Limity i kwoty per klient, magazyn współdzielony między instancjami | 1,5 d |
| 8.6 | Cykl życia klucza: rotacja bezprzerwowa, okres przejściowy, unieważnianie | 1,5 d |
| 8.7 | Endpointy administracyjne pod panel (klucz jawny pokazywany raz) | 1,5 d |
| 8.8 | Test wydajnościowy: próg regresji nie więcej niż +0,3 ms do p99 — **część a wykonana 9.08.2026**: przyrząd `npm run bench` mierzy pełny cykl życia żądania i **własną czułość**; próg jest mierzalny dopiero przy 180 tys. żądań na serię | 0,75 d |
| 8.9 | Zgłoszenie prefiksu do wykrywania wycieków, dokumentacja dla integratorów | 0,75 d |

**Sprostowanie zapisu 8.4 (9.08.2026): `preHandler` był błędem.** Rekomendacja
mówiła „plugin uwierzytelniający Fastify jako `preHandler`". Wzięta dosłownie,
odtwarzałaby lukę z zadania 8.1.

`@fastify/rate-limit` nie zakłada hooka na instancji: jedyne `addHook` w jego
`index.js` to `onRoute` (linia 142), a właściwy limiter jest wpychany do
`routeOptions[hook]` osobno dla każdej trasy (201–211), domyślnie w fazie
`onRequest` (11, 87). `preHandler` biegnie **cztery fazy po** `onRequest`, więc
`keyGenerator` wykonałby się przed weryfikacją i jedyne, co miałby pod ręką, to
surowa wartość nagłówka — czyli dokładnie to, co pozwalało omijać limitowanie.

Rozwiązanie: uwierzytelnianie w `onRequest` **poziomu instancji**. Fastify składa
tablice hooków trasy na `preReady` jako `this[kHooks][hook].concat(opts[hook] || [])`
(`lib/route.js:391`), więc hooki instancji **zawsze** wyprzedzają hooki trasy.
Szczelność wynika z konstrukcji Fastify, a nie z ostrożnej kolejności wywołań.

Odrzucona odwrotna łatka — przestawienie limitera na `hook: 'preHandler'`:
przestałby odrzucać przed parsowaniem ciała, a `/v1/batch` przyjmuje do 1000
pozycji, więc klient ponad limitem najpierw obciążyłby proces parsowaniem JSON.

**Uwaga do 8.8 (9.08.2026): próg „+0,3 ms do p99" wymaga próby 180 tys. żądań.**
Zmierzona podłoga szumu: 6,03 ms przy 3 tys. żądań na serię, 0,659 ms przy
60 tys., 0,04–0,19 ms przy 180 tys. Zmierzony na małej próbie próg dałby liczbę
wyglądającą tak samo i wartą zero. Przy okazji sprostowano atrybucję: wiersz
„pełna ścieżka HTTP" w `STAN-PRAC.md` i `alerty.yaml` był przypisany skryptowi
`bench-realny.ts`, który Fastify w ogóle nie dotyka — hook uwierzytelniający
nie wykonuje się tam wcale, więc pomiar „przed i po" pokazywałby zero.

**Zastrzeżenie weryfikacji — nie budować cache w Redisie.** Rekomendacja
proponowała dwa poziomy cache (w procesie + Redis). Weryfikator wykazał błąd:
obieg do Redisa po sieci w klastrze to 0,2–1 ms, czyli tyle samo albo więcej niż
odrzucone zapytanie do Postgresa. Drugi poziom nie daje nic poza złożonością.
Zostaje cache w procesie plus kanał powiadomień o unieważnieniu.

**Znaleziona przy okazji czynna luka:** dzisiejszy limiter używa
`keyGenerator: req.headers['x-api-key'] ?? req.ip`. Klient wysyłający losową
wartość nagłówka przy każdym żądaniu dostaje świeży licznik i **całkowicie omija
limitowanie**. To nie jest brak funkcji, to działający mechanizm obejścia —
stąd zadanie 8.1 z najwyższym priorytetem.

### 8B. Model wielodostępności — 4–6 dni (+3 d wariant on-premise)

**Rekomendacja: jedna wspólna instalacja, nie instancja per klient.**

Uzasadnienie wprost odpowiada na pytanie o izolację: dane adresowe są
**identyczne dla wszystkich klientów** — to nie jest przypadek izolacji danych,
tylko wydajności. Instancja per klient oznaczałaby trzymanie tego samego
artefaktu w pamięci tyle razy, ilu jest klientów, przy 400+ MB na instancję.
Przy 50 klientach to ponad 20 GB pamięci na dane, które są kopią tego samego.

Izolację wydajności taniej osiąga się inaczej:

| # | zadanie | nakład |
|---|---|---|
| 8.10 | Bulkhead na puli bazy: limit równoczesnych zapytań per klient | 1 d |
| 8.11 | Rozdzielenie sond: `/health` niezależne od bazy, `/ready` degradujące się częściowo | 1 d |
| 8.12 | Metryki z wymiarem klienta, cele SLO i budżety błędu per pakiet | 1,5 d |
| 8.13 | Zawór bezpieczeństwa odrzucający najpierw ruch ponadlimitowy | 1,5 d |
| 8.14 | Wydzielona pula instancji dla klientów z twardym SLA (opcjonalnie) | 2 d |
| 8.15 | Wariant on-premise — tylko na podpisany kontrakt | 3 d |

**Zastrzeżenia weryfikacji:** rekomendacja opierała arytmetykę przepustowości na
liczbach z README (p50 0,114 ms), które **projekt sam wycofał** — pomiar na
danych rzeczywistych daje ~4 ms. Podobnie zużycie pamięci 281 MB pochodziło
z testu z artefaktem 10 MB, a dzisiejszy artefakt ma 66 MB. Przed decyzją
o wydzielonych pulach trzeba przeliczyć wydajność na aktualnych pomiarach.

### 8C. Kopie zapasowe na osobną maszynę — 5–7 dni

**Rekomendacja:** `pg_dump -Fc` plus wysyłka do zewnętrznego magazynu obiektowego
w UE (rząd wielkości 1–5 EUR miesięcznie przy tym wolumenie), zamiast lokalnego
MinIO. Blokada zapisu na archiwum PRG sprzed 1.09.2026 — ono jest
**nieodtwarzalne**, bo po tej dacie stara struktura znika ze źródła.

| # | zadanie | nakład |
|---|---|---|
| 8.16 | Zamrożenie archiwum sprzed 1.09.2026: pełne pobranie, sumy kontrolne, wysyłka | 0,5 d |
| 8.17 | Wybór dostawcy magazynu w UE, kubełki, rozdzielenie poświadczeń | 0,5 d |
| 8.18 | Zadanie cykliczne kopii bazy: zrzut, suma kontrolna, szyfrowanie, wysyłka | 1 d |
| 8.19 | Wysyłka archiwów i artefaktów w ramach cyklu ETL | 0,5 d |
| 8.20 | Reguły cyklu życia kopii i blokada zapisu na zamrożonym archiwum | 0,5 d |
| 8.21 | Kopia offline zamrożonego archiwum na dwóch nośnikach, dwie lokalizacje | 0,25 d |
| 8.22 | Kopia sekretów Kubernetesa, szyfrowana, klucz w menedżerze | 0,5 d |
| 8.23 | **Cotygodniowy test odtworzenia** — automatyczny, z testami akceptacyjnymi | 1,5 d |
| 8.24 | Pomiar czasu odtworzenia na pełnym kraju, dobór równoległości | 0,5 d |
| 8.25 | Alerty: brak kopii ponad 26 h, kopia podejrzanie mała, nieudane odtworzenie | 0,25 d |
| 8.26 | Runbook z trzema ścieżkami odtworzenia: artefakt, zrzut bazy, pełne przetworzenie | 1 d |

**Zastrzeżenia weryfikacji — dwa istotne:**

Po pierwsze, **nie wykluczać schematu `staging` ze zrzutu bez zmiany sposobu
migracji**. Jego definicja istnieje wyłącznie w `002_staging.sql`, a migracje
uruchamiają się tylko przy inicjalizacji kontenera — odtworzenie z takiego
zrzutu dałoby bazę bez obszaru przejściowego i bez funkcji publikującej.
Wiąże się to z luką „narzędzie do migracji” opisaną niżej.

Po drugie, teza „awaria bazy nie jest awarią całej usługi” jest **nieprawdziwa
w obecnym kodzie**: `/ready` wykonuje zapytanie do bazy i zwraca 503, gdy ono
zawiedzie — czyli pod zostaje wyłączony z ruchu, mimo że wyszukiwanie działa
z pamięci. Stąd zadanie 8.11.

---

## Decyzje technologiczne do rozstrzygnięcia

### NestJS zamiast Fastify?

**Rekomendacja: nie dla serwisu danych, rozważyć dla serwisu administracyjnego.**

Argumenty przeciw w serwisie danych:
- Projekt działa **bez kroku kompilacji** (`node --experimental-strip-types`).
  NestJS opiera się na dekoratorach i `emitDecoratorMetadata`, czyli wymaga
  pełnej kompilacji TypeScriptu. To odwrócenie przyjętej filozofii.
- Serwis danych to 11 endpointów bezstanowych, w których liczy się czas
  odpowiedzi liczony w ułamkach milisekundy. Warstwa wstrzykiwania zależności
  nie wnosi tu wartości.
- Fastify jest fundamentem także dla NestJS — rezygnacja z pośrednika nic nie
  odbiera poza strukturą, której przy 11 endpointach nie brakuje.

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
| 8 | Komercjalizacja: klucze i licencje, wielodostępność, kopie zapasowe | 18–24 d |
| — | Narzędzie migracji | 1,5 d |
| **razem** | | **55–73 dni** |

Około **11–15 tygodni** pracy jednej osoby na sam back-end. Panel
administracyjny doliczyć osobno po zaplanowaniu.

Jeśli komercjalizacja nie jest celem pierwszego wdrożenia, etap 8 można odłożyć
w całości poza zadaniem 8.1 — poprawką limitera, która zamyka czynną lukę
i kosztuje ćwierć dnia.

## Kolejność

Etapy 0 i 1 są pilne i niezależne od reszty. Etap 2 przed 3, żeby nie
przenosić problemów wydajnościowych do nowej struktury. Etapy 4 i 5 muszą
poprzedzać prace nad panelem. Z etapu 6 pozycje 6.1, 6.3, 6.5, 6.8 wykonać
przed pierwszym wdrożeniem produkcyjnym niezależnie od reszty harmonogramu.

Etap 7 warto zacząć **wcześnie i częściowo** — zadania 7.1 i 7.2 (stos
monitorujący i pulpit) kosztują 3 dni, a od razu zaczynają się zwracać przy
pracach z etapów 1 i 2. Reszta etapu 7 może poczekać na ustabilizowanie usługi.
