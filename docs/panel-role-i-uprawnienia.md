# Panel administracyjny — role i uprawnienia

Dokument projektowy. Powstał 10.08.2026 przy planowaniu panelu administracyjnego
i rozstrzyga kształt mechanizmu autoryzacji, zanim powstanie pierwsza linia kodu.

**Zasada naczelna:** uprawnienie jest sprawdzane w jednym miejscu i na podstawie
uprawnienia, nigdy nazwy roli. Rola to wyłącznie nazwana wiązka uprawnień.

---

## 1. Stan wyjściowy — co już jest

| mechanizm | dla kogo | gdzie |
|---|---|---|
| klucz API `adr_(live\|test)_…` | maszyna klienta, ruch `/v1` | `licensing.api_key`, replika w pamięci, HMAC z pieprzem |
| `ADMIN_TOKEN` | operator, ruch `/admin` | jeden statyczny token w zmiennej środowiskowej |

Dzisiejszy `/admin` to **sześć tras za jednym wspólnym sekretem**. Nie ma
użytkowników, nie ma ról, nie ma sesji, nie ma śladu po tym, kto co zrobił —
`created_by` wpisuje na sztywno `'admin-api'`. To wystarczało, gdy operatorem
był jeden człowiek. Panel z trzema rolami tego nie udźwignie.

---

## 2. Podmioty działające

Rozróżnienie jest fundamentem — mieszanie tych czterech to najczęstsze źródło
luk w tego typu systemach.

| podmiot | uwierzytelnienie | co robi | zakres |
|---|---|---|---|
| **człowiek** | login + hasło + drugi składnik, sesja | panel, `/admin` | role → uprawnienia |
| **klient maszynowy** | klucz API | `/v1` | zakresy klucza + limity |
| **usługa wewnętrzna** | poświadczenie usługi | ETL, publikacja, cykl nocny | stała, wąska lista |
| **tryb ratunkowy** | `ADMIN_TOKEN` | wyłącznie założenie pierwszego konta i odblokowanie | pełny, ale rejestrowany osobno |

**Człowiek i klucz to dwa różne podmioty i nie wolno ich sprowadzać do jednego
mechanizmu.** Człowiek ma sesję, którą się unieważnia; klucz jest długowieczny
i przypisany do organizacji. Wspólny mają wyłącznie **dziennik audytu** — tam
oba występują jako „wykonawca”, bo pytanie „kto to zrobił” musi mieć odpowiedź
niezależnie od rodzaju podmiotu.

---

## 3. Uprawnienia, nie role, w punkcie kontroli

W kodzie nigdy nie pojawia się `if (rola === 'administrator')`. Pojawia się:

```
can(actor, 'key.revoke', { clientId: 42 })
```

Powód jest praktyczny: role **zawsze** się zmieniają, a sprawdzanie po nazwie
roli rozsypuje politykę po całym kodzie. Po roku nikt nie odpowie na pytanie
„co dokładnie może operator”, bo odpowiedź leży w czterdziestu miejscach.

**Uprawnienia są zamkniętym zbiorem zdefiniowanym w kodzie** — wynikają wprost
z endpointów i operacji, więc nie mogą być danymi. **Role są danymi** —
edytowalne w panelu, bo to one się zmieniają. Rola własna („audytor zewnętrzny”,
„redaktor Mazowsza”) to funkcja panelu, nie wdrożenie.

### Wstępny katalog uprawnień

Nazewnictwo `obszar.czynność`, po angielsku, zgodnie z konwencją nazewnictwa.

| obszar | uprawnienia |
|---|---|
| `user` | `read`, `create`, `update`, `disable`, `assign_role` |
| `role` | `read`, `create`, `update`, `delete` |
| `client` | `read`, `create`, `update`, `suspend` |
| `key` | `read`, `create`, `rotate`, `revoke` |
| `usage` | `read`, `export` |
| `address` | `read`, `edit`, `create`, `withdraw` |
| `import` | `run`, `approve` |
| `release` | `read`, `prepare`, `publish`, `rollback`, `pin_client` |
| `etl` | `run`, `cancel`, `read_progress` |
| `audit` | `read`, `export` |
| `system` | `read_metrics`, `manage_settings`, `break_glass` |

### Uprawnienie niesie informację, czy przyjmuje zakres

Nie każde da się zawęzić. „Może opublikować wydanie, ale tylko w Mazowieckiem”
jest **bez znaczenia** — wydanie jest krajowe. Katalog musi to rozróżniać,
inaczej panel pozwoli nadać ustawienie, które nic nie robi, a operator będzie
przekonany, że coś ograniczył.

| uprawnienie | przyjmuje zakres |
|---|---|
| `address.*`, `import.*` | terytorialny |
| `client.*`, `key.*`, `usage.*` | kliencki |
| `release.*`, `user.*`, `role.*`, `system.*`, `etl.*`, `audit.*` | **wyłącznie globalne** |

### Role startowe

**Rola mówi CO, przypisanie mówi GDZIE.** To rozdzielenie jest istotne: gdyby
obszar był częścią roli, powstałyby `Redaktor Mazowsza`, `Redaktor Małopolski`
i tak dalej — 16 województw, 380 powiatów, 2477 gmin. Po pół roku nikt nie
odpowie na pytanie „co może redaktor”, bo odpowiedzi będzie kilka tysięcy.

Jedna rola `redaktor`, przypisana Annie z zakresem `14` i Piotrowi z zakresem
`1465011`. Poziom wynika z **długości prefiksu TERC**, nie z osobnej roli.

| rola | co może | oś zakresu |
|---|---|---|
| `podglad` | wszystkie `*.read` | dowolna |
| `redaktor` | `address.read/edit/create/withdraw` | terytorialna |
| `koordynator` | redaktor + `import.run`, `import.approve` | terytorialna |
| `operator` | `client.*`, `key.*`, `usage.*` | kliencka |
| `wydawca` | `release.prepare/publish/rollback` | **tylko globalna** |
| `administrator` | wszystko poza `system.break_glass` | globalna |

Role różnicujemy tam, gdzie różni się **zakres czynności**, nie obszar.

---

## 4. Zakres — trzy osie, każda wymaga decyzji

Uprawnienie bez zakresu jest niepełne. „Może unieważnić klucz” — czyj klucz?

| oś | wartości | po co |
|---|---|---|
| **globalna** | cały system | publikacja wydania, zarządzanie użytkownikami |
| **kliencka** | konkretny `client_id` | opiekun obsługuje wyłącznie swoich klientów; klient dostający dostęp do panelu widzi wyłącznie siebie |
| **terytorialna** | województwo / powiat / gmina (TERC) | redaktor danych odpowiada za swój obszar i nie rusza cudzego |

**ROZSTRZYGNIĘTE 10.08.2026: oś terytorialna wchodzi od razu i jest
egzekwowana; panel zostaje wewnętrzny.**

Oś terytorialna jest tania, bo TERYT sam się do niej nadaje. Sprawdzone na
danych: wszystkie 4344 jednostki mają TERC rodzica jako prefiks swojego.

```
14        → Mazowieckie   (województwo)
1465      → Warszawa      (powiat)
1465011   → Warszawa      (gmina)
```

Zakres to więc **jeden tekst i porównanie prefiksem** — `gmina_terc LIKE '14%'`
obejmuje całe województwo. Bez tabel pośrednich i bez przechodzenia drzewa.

Sprostowanie do wcześniejszego zapisu: dołożenie tej osi później **nie jest**
migracją 8,6 mln wierszy. Zakres siedzi na przypisaniu roli, czyli na małej
tabeli. Kosztem odłożenia byłaby szerokość przeróbki — sygnatura `can()`
i każde jej wywołanie — oraz **nieodwracalna luka w audycie**: wpisy sprzed
wprowadzenia osi nie mają zapisanego zakresu i nikt tego wstecz nie ustali.

**Panel wewnętrzny — oś kliencka zostaje, ale nie jest granicą bezpieczeństwa.**
Jest potrzebna do „opiekun obsługuje piętnastu klientów” i do audytu „kto
dotykał klienta X”. Gdyby samoobsługa klientów kiedyś była potrzebna, powstaje
**osobna, wąska powierzchnia** — portal klienta z własnym API. Panelu
wewnętrznego nie otwieramy: obrasta on w operacje o dużej sile rażenia
(publikacja, wycofanie, edycja adresów, zarządzanie rolami), a żadna z nich nie
może być o jeden błąd w autoryzacji od sesji klienta.

---

## 4a. Zarządzanie rolami z panelu

Wymaganie: administrator ma role nie tylko **przypisywać**, ale też **tworzyć,
edytować, usuwać i łączyć**. To przesuwa role z konfiguracji do danych
edytowalnych w czasie działania i wymaga kilku rzeczy, których przy stałym
zestawie trzech ról by nie było.

### Co wolno zmieniać, a co nie

| element | źródło | edytowalny z panelu |
|---|---|---|
| **uprawnienia** | stała w kodzie | **nie** — wynikają z endpointów; nowe pojawia się z wdrożeniem |
| **role** | dane | tak — nazwa, opis, zestaw uprawnień |
| **przypisania** | dane | tak — użytkownik, rola, zakres, termin ważności |

Uprawnienie nie może być danymi, bo jest **odpowiednikiem punktu kontroli
w kodzie**. Rola nadająca `address.publish` byłaby nazwą bez pokrycia, a panel
pozwoliłby ją utworzyć i nikt by się nie zorientował, że nic nie robi.

### „Łączenie" znaczy dwie różne rzeczy i obie są potrzebne

**1. Składanie ról (trwałe).** Rola może zawierać inną — `koordynator` zawiera
`redaktor` i dokłada `import.approve`. Zmiana w `redaktor` przenosi się na
`koordynatora` samoczynnie, więc definicja nie rozjeżdża się przy każdej
poprawce.

Ryzyko jest znane: po roku nikt nie wie, co rola naprawdę nadaje. Dlatego
warunkiem jest **wyliczony zestaw uprawnień z pochodzeniem** — panel dla każdej
roli pokazuje pełną, rozwiniętą listę i przy każdej pozycji to, skąd przyszła
(wprost czy przez którą rolę składową). Bez tego składanie robi więcej szkody
niż pożytku.

Do tego: **wykrywanie cykli** przy zapisie. `A` zawiera `B`, `B` zawiera `A` to
nie jest sytuacja teoretyczna przy edycji z panelu.

**2. Scalenie ról (jednorazowa czynność).** Dwie role okazały się tym samym —
`redaktor` i `edytor-danych`. Scalenie tworzy sumę uprawnień w roli docelowej,
przenosi wszystkie przypisania i **zostawia wpis w audycie**. Zakresy przypisań
pozostają nietknięte, bo należą do przypisania, nie do roli.

### Reguły przy każdej z tych operacji

| operacja | reguła |
|---|---|
| utworzenie | nie można nadać roli uprawnienia, którego samemu się nie ma |
| edycja | zmiana działa **natychmiast dla wszystkich**, którzy ją mają — panel pokazuje ilu ich jest **przed** zapisem |
| usunięcie | **blokowane**, gdy rola ma przypisania albo jest składową innej roli. Usunięcie kaskadowe po cichu zdejmuje ludziom dostęp |
| scalenie | wymaga wskazania roli docelowej; źródłowa zostaje wyłączona, nie skasowana |
| każda | wpis w dzienniku audytu z pełnym stanem przed i po |

### Czego nie wolno zrobić samemu sobie

Reguły z rozdziału 7 obowiązują tu wprost i są wykonywane przez silnik, nie
przez pamiętanie o nich w panelu:

- nie można nadać roli uprawnienia spoza własnego zestawu
- nie można edytować roli, którą samemu się ma, jeśli podnosi to własne
  uprawnienia
- nie można usunąć ani scalić roli, która jest ostatnim źródłem
  `user.assign_role` w systemie

---

## 5. Warstwy egzekwowania

| warstwa | rola | czy jest kontrolą |
|---|---|---|
| front (Angular) | ukrywa to, czego użytkownik nie może zrobić | **nie** — wyłącznie wygoda |
| API administracyjne | sprawdza każde żądanie | **tak, jedyna wiążąca** |
| baza (RLS) | druga linia dla osi terytorialnej | opcjonalna, obrona w głąb |
| ETL i publikacja | działanie z panelu przechodzi tą samą kontrolą jakości co automat | **tak** |

Front, który ukrywa przycisk, niczego nie zabezpiecza — chroni użytkownika przed
pomyłką, a nie system przed napastnikiem. Każdy punkt kontroli w API musi działać
tak samo przy żądaniu wysłanym z konsoli przeglądarki.

Warstwa ETL jest wymieniona świadomie: plan mówi wprost, że import ręczny
i edycja **muszą** przechodzić przez ten sam mechanizm kontroli jakości co
automat, inaczej panel stanie się drogą obejścia zabezpieczeń
(`plan-produkcyjny.md:619`).

---

## 6. Sesje — powtórzyć wzorzec, który już działa

Do sesji panelu stosuje się dokładnie ten sam wzorzec co do kluczy API:
**replika w pamięci + `NOTIFY` jako przyspieszacz + odpytywanie jako gwarancja**.

Uzasadnienie jest już w repozytorium i nie trzeba go wymyślać od nowa: `NOTIFY`
ginie przy restarcie bazy i przełączeniu na replikę, i ginie **cicho** —
unieważniona sesja po prostu działałaby dalej.

**Przeciw bezstanowym tokenom (JWT bez rejestru).** Zmiana roli i odejście
pracownika muszą działać natychmiast. JWT bez listy unieważnień tego nie potrafi,
a JWT z listą unieważnień to rejestr sesji obudowany dodatkową warstwą.

Wymagania wobec sesji:
- unieważnienie natychmiastowe, pojedynczej sesji i wszystkich sesji użytkownika
- **zmiana roli unieważnia sesję albo wymusza przeliczenie uprawnień** — sesja
  nie może nieść zamrożonej kopii uprawnień sprzed zmiany
- ograniczony czas życia, przedłużany aktywnością
- widoczna lista aktywnych sesji użytkownika w panelu

---

## 7. Reguły, które muszą być w modelu od początku

Każda z nich to znana klasa błędu, nie ostrożność na wyrost.

1. **Nie można nadać uprawnienia, którego się nie ma.** Bez tego operator
   z prawem edycji użytkowników nadaje sobie administratora w dwóch kliknięciach.
2. **Nie można zmienić własnych ról ani sobie podnieść zakresu.** Zmiana
   uprawnień to zawsze czynność wykonana na kimś innym.
3. **Nie można usunąć ostatniego konta z `user.assign_role`.** Klasyczna blokada
   dostępu do własnego systemu.
4. **Konta się wyłącza, nie kasuje.** Dziennik audytu musi mieć na co wskazywać.
5. **Odmowa jest zdarzeniem audytowym.** Seria odmów to sygnał ataku albo źle
   nadanych ról — jedno i drugie trzeba zobaczyć.
6. **Rozdzielenie obowiązków jest możliwe do włączenia.** Przygotowanie wydania
   i jego zatwierdzenie mogą wymagać dwóch różnych osób. Na starcie może to być
   ta sama osoba, ale model musi to unieść bez przebudowy.
7. **Tryb ratunkowy jest jednorazowy i głośny.** Użycie `ADMIN_TOKEN` po
   założeniu pierwszego konta zapisuje się jako zdarzenie o wysokim priorytecie
   i powinno wywołać alert.

---

## 8. Most między rolami a kluczami API

To odpowiedź na wymaganie, żeby zarządzanie przekładało się także na dostęp do
API. Dziś klucz niesie środowisko, limit i kwotę, ale **nie niesie informacji,
do czego uprawnia** — każdy ważny klucz otwiera wszystkie jedenaście tras `/v1`.

Propozycja: klucz dostaje **zakresy** (`api_key.scopes`), np. `suggest`,
`validate`, `reverse`, `batch`. Wtedy jeden silnik polityki obsługuje oba
podmioty: człowiek pyta o uprawnienie, klucz o zakres, a mechanizm decyzyjny
jest ten sam. Daje to też sprzedaży prawdziwe pakiety — dziś „pakiet” jest
wyłącznie etykietą w `licensing.client.plan` i nie wpływa na nic poza limitem.

Ta zmiana jest **rozszerzeniem kontraktu 8A**, nie przebudową: klucze bez
zakresów zachowują dzisiejsze zachowanie (wszystko dozwolone) do czasu nadania.

---

## 9. Zadania

### D. Model i baza

| # | zadanie | nakład |
|---|---|---|
| R1 | Migracja: `panel_user`, `role`, `permission_grant`, `role_assignment` (z kolumną zakresu), `session`, `audit_log` | 1 d |
| R2 | Katalog uprawnień jako stała w kodzie, z oznaczeniem osi zakresu, + kontrola spójności z rolami w bazie | 0,5 d |
| R3 | ~~Rozstrzygnięcie osi terytorialnej~~ **ROZSTRZYGNIĘTE** — prefiks TERC, obie osie w `role_assignment` | — |
| R3a | Składanie ról: tabela zawierania, wykrywanie cykli, wyliczanie zestawu skutecznego z pochodzeniem | 1 d |
| R4 | Opcjonalnie: RLS na tabelach edytowalnych z panelu | 1 d |

### E. Silnik polityki

| # | zadanie | nakład |
|---|---|---|
| R5 | `can(actor, permission, scope)` — jedno miejsce decyzji, bez odwołań do nazw ról | 1 d |
| R6 | Reguły z rozdz. 7 jako część silnika, nie jako sprawdzenia w trasach | 0,5 d |
| R7 | Zakresy kluczy API przez ten sam silnik (rozdz. 8) | 1 d |

### F. Uwierzytelnianie ludzi

| # | zadanie | nakład |
|---|---|---|
| R8 | Logowanie, hasła (argon2 — tu wolne hashowanie **ma** sens, w przeciwieństwie do kluczy), polityka haseł | 1 d |
| R9 | Drugi składnik (TOTP) — wymagany dla `administrator` | 1 d |
| R10 | Sesje: replika + `NOTIFY` + odpytywanie, wzorzec z 8.4a | 1 d |
| R11 | Założenie pierwszego konta trybem ratunkowym i wyłączenie `ADMIN_TOKEN` z codziennego użycia | 0,5 d |

### G. API zarządzania

| # | zadanie | nakład |
|---|---|---|
| R12 | Trasy `/admin/users`, `/admin/roles`, `/admin/sessions` | 1,5 d |
| R13 | Objęcie sześciu istniejących tras `/admin` silnikiem polityki | 0,5 d |
| R14 | `created_by` z prawdziwym wykonawcą zamiast `'admin-api'` | 0,25 d |
| R15 | Endpoint „co mogę” dla frontu — lista uprawnień bieżącej sesji | 0,25 d |

### H. Audyt i obserwowalność

| # | zadanie | nakład |
|---|---|---|
| R16 | Dziennik: wykonawca, rodzaj podmiotu, uprawnienie, zakres, cel, wartość przed i po, wynik, identyfikator korelacji | 1 d |
| R17 | Metryki: odmowy autoryzacji, użycia trybu ratunkowego, nieudane logowania | 0,5 d |
| R18 | Alerty na powyższe (zazębia się z 7.4) | 0,25 d |

### I. Front

| # | zadanie | nakład |
|---|---|---|
| R19 | Strażnik trasy i dyrektywa ukrywająca elementy na podstawie R15 | 0,5 d |
| R20 | Ekrany: użytkownicy, role, przypisania, sesje, dziennik audytu | 3 d |

**Razem: ok. 17–19 dni**, z czego 13–14 to back-end.

---

## 10. Scenariusze

Lista do rozszerzania. Każdy scenariusz to jednocześnie przypadek testowy —
mechanizm uznajemy za zaplanowany dopiero wtedy, gdy na każdy z nich znana jest
odpowiedź.

### Cykl życia konta

1. Nowy pracownik dostaje konto; kto może je założyć i jaką rolę nadać domyślnie.
2. Pracownik odchodzi — konto wyłączone, sesje unieważnione, ale ślad w audycie zostaje.
3. Pracownik zmienia stanowisko: operator zostaje podglądem. Co z czynnościami w toku.
4. Konto nieużywane od 90 dni — wygaszać automatycznie czy tylko raportować.
5. Wykonawca zewnętrzny na czas określony; wygaśnięcie roli z datą.
6. Ktoś zakłada konto testowe i o nim zapomina.

### Zarządzanie samymi rolami

7a. Administrator zmienia definicję roli, którą ma dwadzieścia osób — czy widzi, ilu dotknie, **zanim** zapisze.
7b. Rola `A` zawiera `B`, ktoś próbuje ustawić `B` zawiera `A`.
7c. Rola składowa zostaje usunięta, a zawiera ją inna rola.
7d. Scalenie dwóch ról, których posiadacze mają różne zakresy terytorialne.
7e. Administrator tworzy rolę z uprawnieniem, którego sam nie ma.
7f. Rola nadaje uprawnienie, które nie przyjmuje zakresu, a przypisanie ma zakres — co wygrywa i czy panel na to pozwala.
7g. Po wdrożeniu z kodu znika uprawnienie, do którego odwołuje się rola w bazie.
7h. Pytanie „skąd ta osoba ma `release.publish`" przy trzech poziomach składania ról.

### Zmiana uprawnień w locie

7. Administrator odbiera rolę operatorowi, który **w tej chwili** ma otwarty formularz edycji adresu.
8. Rola zostaje przedefiniowana (usunięte uprawnienie) — co z dwudziestoma osobami, które ją mają.
9. Rola usunięta, a ma przypisanych użytkowników.
10. Użytkownik ma dwie role dające sprzeczne zakresy terytorialne — suma czy część wspólna.
11. Uprawnienie nadane bezpośrednio użytkownikowi, z pominięciem roli — dopuszczamy czy nie.

### Eskalacja i nadużycie

12. Operator próbuje nadać sobie administratora.
13. Operator zakłada konto z rolą wyższą niż własna.
14. Administrator odbiera uprawnienia wszystkim innym administratorom.
15. Użytkownik podnosi sobie zakres terytorialny z gminy na województwo.
16. Ktoś wystawia klucz API bez limitów i używa go poza panelem.
17. Sesja przechwycona — czy powiązanie z adresem i przeglądarką ma ją unieważniać.
18. Żądanie do `/admin` wysłane bezpośrednio, z pominięciem frontu, przez konto podglądowe.

### Blokada dostępu

19. Ostatni administrator odchodzi z firmy.
20. Ostatni administrator gubi drugi składnik.
21. Baza kont niedostępna — czy panel ma działać w trybie ograniczonym.
22. `ADMIN_TOKEN` wyciekł i trzeba go wymienić przy działającej usłudze.
23. Wszyscy administratorzy zablokowani nieudanymi próbami logowania.

### Klienci i wielodostępność

24. Klient dostaje dostęp do panelu, żeby zarządzać własnymi kluczami — widzi wyłącznie siebie.
25. Pracownik klienta próbuje zobaczyć zużycie innego klienta.
26. Opiekun handlowy obsługuje piętnastu klientów i żadnego więcej.
27. Klient zawieszony za brak płatności — co widzą jego ludzie po zalogowaniu.
28. Klient prosi o eksport swoich danych (RODO) i o ich usunięcie.

### Zakres terytorialny

29. Redaktor Mazowsza edytuje adres w Małopolsce.
30. Adres leży na granicy gmin albo zmienia przynależność po zmianie podziału administracyjnego.
31. Zmiana granic gminy przenosi punkty poza zakres redaktora, który je wprowadził.
32. Import z pliku obejmuje obszar szerszy niż zakres importującego.

### Publikacja i dane

33. Operator uruchamia publikację wydania — czy to wymaga zatwierdzenia drugiej osoby.
34. Publikacja wycofana; kto może i czy potrzebne jest uzasadnienie.
35. Ręczna poprawka zostaje nadpisana przez nocną aktualizację (etap 5.4).
36. Dwie osoby edytują ten sam adres jednocześnie.
37. Import ręczny nie przechodzi kontroli jakości — kto może wymusić i czy w ogóle wolno.
38. Klient przypięty do starej wersji danych, a wersja ma zostać wycofana.

### Audyt i zgodność

39. Pytanie „kto zmienił ten adres i na jakiej podstawie” pół roku po fakcie.
40. Audytor zewnętrzny ma zobaczyć dziennik i nic poza nim.
41. Dziennik audytu zawiera dane osobowe (adresy) — jak długo go trzymamy.
42. Ktoś chce usunąć wpis z dziennika.
43. Trzeba wykazać, że w danym okresie nikt nieuprawniony nie miał dostępu do danych klienta.

### Awarie i sytuacje brzegowe

44. Replika sesji rozjeżdża się z bazą — czy wpuszczamy, czy odmawiamy.
45. Dwie instancje API mają różny stan uprawnień w trakcie wdrożenia.
46. Migracja ze stanu obecnego: co się dzieje z `ADMIN_TOKEN` i kto dostaje pierwsze konto.
47. Usługa wewnętrzna (cykl nocny) działa bez człowieka — jak podpisuje swoje zmiany w audycie.
48. Zmiana katalogu uprawnień w kodzie, gdy w bazie są role odwołujące się do usuniętego uprawnienia.

---

## 11. Decyzje do podjęcia

**Rozstrzygnięte 10.08.2026:**

| # | pytanie | decyzja |
|---|---|---|
| 1 | Oś terytorialna | **wchodzi od razu i jest egzekwowana.** Zakres jako prefiks TERC na przypisaniu roli |
| 2 | Klienci w panelu | **nie — panel wewnętrzny.** Oś kliencka zostaje, ale nie jest granicą bezpieczeństwa |
| 3 | Role własne | **tak — pełne zarządzanie z panelu**: tworzenie, edycja, usuwanie, składanie i scalanie (rozdz. 4a) |

**Otwarte:**

| # | pytanie | dlaczego teraz |
|---|---|---|
| 4 | Drugi składnik: dla wszystkich czy tylko dla administratora | koszt wdrożenia wobec ryzyka |
| 5 | Rozdzielenie obowiązków przy publikacji: od razu czy później | wpływa na etap 4 |
| 6 | Zakresy kluczy API (rozdz. 8) — w tym etapie czy osobno | rozszerza kontrakt 8A |
| 7 | NestJS jako back-end panelu (`plan-produkcyjny.md:561`) | przesądza, gdzie mieszka silnik polityki |
