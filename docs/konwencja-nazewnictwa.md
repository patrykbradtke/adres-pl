# Konwencja nazewnictwa

Dokument wiazacy dla calego repozytorium. Powstal 10.08.2026 przy przejsciu
kodu na angielskie identyfikatory i rozstrzyga te decyzje raz, zeby nie wracaly
przy kazdym nowym module.

**Zasada naczelna:** identyfikatory po angielsku, komentarze po polsku bez
znakow diakrytycznych. Kod mowi *co* robi w jezyku, ktorym mowi cala branza;
komentarz tlumaczy *dlaczego* w jezyku zespolu.

---

## 1. Nazwy wlasne nie sa tlumaczone

Rejestry, ich pola i polskie jednostki administracyjne to nazwy wlasne. Nie maja
odpowiednikow, a kazde tlumaczenie albo zawezalo znaczenie, albo tworzylo
falszywego przyjaciela.

```
SIMC  TERC  ULIC  TERYT  PRG  WMRODZ  IMPA  NIP  PNA  EPSG
```

zostaja doslownie — rowniez jako czesc identyfikatora zlozonego (`simc`,
`symUl`, `tercGminy` -> `gminaTerc`).

Jednostki administracyjne:

| polski | w kodzie | uzasadnienie |
|---|---|---|
| wojewodztwo | `voivodeship` | angielszczyzna ma wlasna pisownie tego slowa, tak jak `Warsaw` dla Warszawy |
| powiat | `powiat` | brak odpowiednika; GUS we wlasnych publikacjach angielskich rowniez go nie tlumaczy |
| gmina | `gmina` | `municipality` i `commune` zakladaja miasto, a gmina wiejska go nie ma |

Odrzucone swiadomie: `county` (amerykanski county nie odpowiada powiatowi ani
funkcja, ani skala) oraz `district` — zderza sie z **dzielnica**, ktora w tych
danych istnieje osobno jako WMRODZ 95 (`dzielnicaWarszawy`).

Zrodla rozbiezne, dlatego decyzja jest nasza, nie zapozyczona: GUS pisze
`voivodship`/`municipality` i pomija powiat, biblioteka `teryt-api` uzywa
`province`/`district`/`commune`, Wikipedia miesza `powiat` z `county`.
schema.org i Google nie wyrazaja trzypoziomowej hierarchii w ogole.

---

## 2. Adres

| polski | w kodzie |
|---|---|
| miejscowosc | `locality` |
| ulica | `street` |
| cecha ulicy (`ul.`, `al.`, `pl.`) | `streetType` |
| numer budynku | `buildingNumber` |
| numer lokalu | `unitNumber` |
| kod pocztowy | `postalCode` |
| punkt adresowy | `addressPoint` |
| ma ulice | `hasStreets` |
| nazwa skrocona | `shortName` |
| nazwa znormalizowana | `normalizedName` |
| rodzaj (WMRODZ) | `kind` |
| kraj | `country` |

`locality`, `street`, `postalCode` i `buildingNumber` nie sa wyborem
arbitralnym: pokrywaja sie z `addressLocality` / `streetAddress` / `postalCode`
w schema.org oraz `locality` u Google, a w tym repozytorium mialy juz przewage
99:2 nad `city` i 40:2 nad `postcode`.

---

## 3. Cykl zycia danych i ETL

| polski | w kodzie |
|---|---|
| zrodlo | `source` |
| wersja | `version` |
| zrzut | `snapshot` |
| artefakt (indeksu) | `artifact` |
| indeks | `index` |
| wycofany | `withdrawn` |
| pominiete | `skipped` |
| kontrola jakosci | `check` |
| plik / sciezka / katalog | `file` / `path` / `directory` |
| wiersz / kolumna | `row` / `column` |
| dane | `data` |
| stan | `state` |
| wynik | `result` |
| blad / ostrzezenie | `error` / `warning` |
| liczba czegos | `count` |
| prog | `threshold` |
| pobrano | `fetchedAt` |

---

## 4. Klucze, klienci, rozliczenia

| polski | w kodzie | kolumna w bazie |
|---|---|---|
| klucz API | `apiKey` | `api_key` |
| klient | `client` | `client` |
| pieprz | `pepper` | `pepper` |
| licencje (schemat) | `licensing` | `licensing` |
| zuzycie | `usage` | `usage` |
| kwota miesieczna | `monthlyQuota` | `monthly_quota` |
| srodowisko | `environment` | `environment` |
| prefiks | `prefix` | `prefix` |
| klucz jawny | `plaintextKey` | — |
| skrot | `hash` | `hash` |
| wazny od / do | `validFrom` / `validTo` | `valid_from` / `valid_to` |
| uniewazniony od | `revokedAt` | `revoked_at` |
| powod uniewaznienia | `revocationReason` | `revocation_reason` |
| zawieszony od | `suspendedAt` | `suspended_at` |
| utworzony / zmieniony | `createdAt` / `updatedAt` | `created_at` / `updated_at` |
| okres rozliczeniowy | `billingPeriod` | — |

---

## 5. Warstwa HTTP

| polski | w kodzie |
|---|---|
| podpowiedzi | `suggestions` |
| walidacja | `validation` |
| wyszukiwanie | `search` |
| trasy | `routes` |
| sonda zywotnosci / gotowosci | `liveness` / `readiness` |
| uwierzytelnienie | `authentication` |
| token operatora | `operatorToken` |
| przekroczony limit | `rateLimitExceeded` |

**Uwaga na `zapytanie`** — to slowo ma w tym kodzie dwa znaczenia i tlumaczy sie
roznie zaleznie od warstwy:

- zapytanie HTTP od klienta -> `request` (`adres_requests_total`)
- zapytanie SQL do bazy -> `query` (`dbQueryCount`)

Mieszanie tych dwoch bylo zrodlem nieporozumien przy liczeniu limitow.

---

## 6. Styl zapisu

| warstwa | styl | przyklad |
|---|---|---|
| TypeScript, pola JSON | `camelCase` | `buildingNumber` |
| kolumny i tabele SQL | `snake_case` | `valid_from` |
| zmienne srodowiskowe | `SCREAMING_SNAKE` | `KEYS_REFRESH_MS` |
| kody problemow walidacji | `SCREAMING_SNAKE` | `MISSING_LOCALITY` |
| metryki Prometheusa | `snake_case` z prefiksem `adres_` | `adres_requests_total` |
| pliki z kodem | `kebab-case.ts`, nazwa mowi czym plik JEST | `notify-listener.ts` |

Prefiks metryk `adres_` **zostaje**. To nazwa uslugi, przestrzen nazw — tak jak
`pg_` czy `nginx_` — a nie polskie slowo do przetlumaczenia.

Dokumenty w `docs/` sa polskojezyczna proza i zachowuja polskie nazwy plikow.
Konwencja angielskich nazw dotyczy kodu.

---

## 7. Wartosci enumow to tez kontrakt

Wartosci lecace po drucie sa danymi, na ktorych konsument robi `switch`, wiec
podlegaja tej samej zasadzie co pola:

```
'zweryfikowany_rejestr'    -> 'verified_registry'
'zweryfikowany_czesciowo'  -> 'verified_partial'
'poza_rejestrem'           -> 'outside_registry'
'nietypowy'                -> 'irregular'
'niezweryfikowany'         -> 'unverified'

'BRAK_MIEJSCOWOSCI'        -> 'MISSING_LOCALITY'
'ZLY_FORMAT_KODU'          -> 'INVALID_POSTAL_CODE_FORMAT'
```

Pole po angielsku z polska wartoscia w srodku to dokladnie ta niespojnosc,
ktora ten dokument likwiduje.
