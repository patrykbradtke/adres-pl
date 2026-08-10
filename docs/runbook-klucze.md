# Runbook: klucze API i pieprz

Procedury operacyjne dla etapu 8A. Wszystkie polecenia zakładają ustawione
`DATABASE_URL`. Żadna z nich nie wymaga panelu ani wdrożenia — powiadomienie
o zmianie siedzi w wyzwalaczu bazy, nie w kodzie aplikacji.

---

## Wyciek klucza — unieważnienie natychmiastowe

Najczęstsza sytuacja alarmowa. Jedno polecenie, skutek we wszystkich
instancjach w czasie poniżej sekundy.

```bash
psql "$DATABASE_URL" -c "UPDATE licencje.klucz_api SET uniewazniony_od = now(), powod_uniewaznienia = 'wyciek zgloszony <data/zrodlo>' WHERE prefiks = 'adr_live_' AND id = <ID>;"
```

Identyfikator klucza znajdziesz po kliencie:

```bash
psql "$DATABASE_URL" -c "SELECT k.id, k.prefiks, k.wazny_do, k.uniewazniony_od, c.nazwa FROM licencje.klucz_api k JOIN licencje.klient c ON c.id = k.klient_id WHERE c.nazwa ILIKE '%<fragment>%' ORDER BY k.id;"
```

**Nie kasuj wiersza.** W tym schemacie nie usuwamy rekordów — unieważniony
klucz musi zostać, żeby serwis mógł odróżnić „klucz unieważniony" (403,
komunikat mówiący integratorowi, co się stało) od „klucz nieznany" (401).

## Zawieszenie całego klienta

Unieważnia **wszystkie** jego klucze naraz, bez dotykania każdego z osobna:

```bash
psql "$DATABASE_URL" -c "UPDATE licencje.klient SET zawieszony_od = now() WHERE id = <ID>;"
```

Odwieszenie: `SET zawieszony_od = NULL`.

---

## Rotacja klucza bez przerwy w działaniu

Zasada: nowy klucz powstaje **obok** starego, a stary dostaje termin, nie
natychmiastowe unieważnienie. Przez okres przejściowy działają oba.

1. Wystaw następcę (klucz jawny widać **raz** — zapisz go od razu):

```bash
node --experimental-strip-types packages/api/src/keys/cli.ts wystaw --client <ID> --replaces <ID_STAREGO>
```

2. Ustaw poprzednikowi koniec ważności — domyślnie 7 dni:

```bash
psql "$DATABASE_URL" -c "UPDATE licencje.klucz_api SET wazny_do = now() + interval '7 days' WHERE id = <ID_STAREGO>;"
```

3. **Powiadom klienta** — to jest warunek przejścia do kroku 4, nie
   formalność. Adres w `licencje.klient.email_kontakt`. Zapisz datę i kanał.

4. Po okresie przejściowym poprzednik wygasa sam. Unieważnienie nie jest
   potrzebne; jeśli chcesz je przyspieszyć, patrz procedura wycieku.

Klucze wygasające w ciągu 7 dni:

```bash
psql "$DATABASE_URL" -c "SELECT k.id, c.nazwa, c.email_kontakt, k.wazny_do FROM licencje.klucz_api k JOIN licencje.klient c ON c.id = k.klient_id WHERE k.uniewazniony_od IS NULL AND k.wazny_do BETWEEN now() AND now() + interval '7 days' ORDER BY k.wazny_do;"
```

---

## Rotacja pieprza

**Przeczytaj to zdanie, zanim zaczniesz: nie da się przeliczyć istniejących
skrótów na nowy pieprz.** Przeliczenie wymagałoby klucza **jawnego**, którego
z założenia nie mamy — w bazie leżą wyłącznie skróty. Rotacja pieprza jest
więc zawsze **wymianą wszystkich kluczy** i wymaga powiadomienia klientów.

Kolumna `pieprz_wersja` jest **księgowością** tej operacji, nie jej
mechanizmem: mówi, ile kluczy zostało do wymiany.

Procedura bez przerwy w działaniu:

1. Dodaj nowy pieprz **obok** starego i przełącz wersję aktywną. Wdrożenie
   kroczące; instancja liczy skrót obiema wersjami i sprawdza obie:

   ```
   API_KEY_PEPPER_1=<stary>
   API_KEY_PEPPER_2=<nowy>
   API_KEY_PEPPER_AKTYWNY=2
   ```

   Koszt drugiej wersji to około mikrosekundy na żądanie — szum wobec p50 1,71 ms.
   Baza się nie zmienia.

2. Dla każdego klucza z `pieprz_wersja = 1` wystaw następcę mechanizmem rotacji
   bezprzerwowej (wyżej). Skrót policzy się pieprzem aktywnym, czyli 2.

   ```bash
   psql "$DATABASE_URL" -c "SELECT pieprz_wersja, count(*) FROM licencje.klucz_api WHERE uniewazniony_od IS NULL GROUP BY 1 ORDER BY 1;"
   ```

3. Okres przejściowy i powiadomienia — jak w rotacji klucza.

4. Gdy licznik z kroku 2 pokaże zero kluczy na wersji 1, usuń
   `API_KEY_PEPPER_1` z konfiguracji.

### Wariant awaryjny: wyciekł pieprz

Usunięcie pieprza z konfiguracji unieważnia **natychmiast** wszystkie klucze
na nim policzone, we wszystkich instancjach, **bez dotykania bazy**. To jest
zaprojektowana funkcja — bezpiecznik ostatniej szansy — a nie awaria. Cena:
wszyscy klienci na tym pieprzu tracą dostęp do czasu wydania nowych kluczy.

**Utrata pieprza jest nieodwracalna.** Kopia bazy nie pomoże, bo zawiera same
skróty. Pieprz musi być objęty kopią sekretów (zadanie 8.22).

---

## Awaria bazy — co się dzieje i czego nie robić

Dwie **niezależne** decyzje, celowo rozdzielone:

| decyzja | zachowanie | dlaczego |
|---|---|---|
| wpuszczanie klientów | **fail-open** — działa z repliki w pamięci | wpisy zostały już raz zweryfikowane; odrzucanie ich zamieniałoby awarię częściową w całkowitą, w tym `/v1/suggest`, które bazy w ogóle nie dotyka |
| kierowanie ruchu | `/ready` → 503 po `KLUCZE_MAX_WIEK_S` (domyślnie 900 s) | jeśli baza padła globalnie, wszystkie instancje wypadają z ruchu i awaria staje się widoczna, zamiast być po cichu tolerowana godzinami |

Ryzyko jest ograniczone i mierzalne: przez czas awarii klucz unieważniony
kilka minut temu nadal działa. To **okno**, nie dziura — i domyka je próg wieku.

`/ready` **nie wykonuje** już zapytania do bazy. Dostępność samego Postgresa
raportuje metryka `adres_baza_dostepna` (reguła `BazaNiedostepna`) oraz `/status`.

---

## Zbieżność — ile trwa, zanim zmiana zadziała

| droga | czas | uwagi |
|---|---|---|
| `LISTEN/NOTIFY` | typowo **25–100 ms** | przyspieszacz; ginie **cicho** przy restarcie bazy i przełączeniu na replikę |
| odpytywanie | **gwarantowane** poniżej `KLUCZE_ODSWIEZANIE_MS` + czas zapytania (domyślnie ~10 s) | to jest wartość, którą wolno zapisać w umowie |
| przy awarii bazy | brak zbieżności | fail-open, `/ready` → 503 po 900 s |

## Co obserwować w metrykach

| metryka | znaczenie |
|---|---|
| `adres_klucze_wiek_s` | **numer jeden.** Przy fail-open rosnący wiek jest jedynym objawem zerwanego kanału odświeżania |
| `adres_klucze_zaladowany` | 0 oznacza, że instancja odrzuca cały ruch `/v1` kodem 401 |
| `adres_klucze_powiadomienia_total` | brak przyrostu przy rosnącej liczbie odświeżeń = `NOTIFY` nie działa, ratuje odpytywanie |
| `adres_uwierzytelnienie_total{wynik=...}` | skok `uniewazniony` po rotacji jest normalny; skok `nieprawidlowy` to sygnał zgadywania kluczy |
| `adres_klucze_w_replice` | nagły spadek jest odrzucany przez kontrolę rozsądku — sprawdź logi |
