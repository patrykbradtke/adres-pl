# Zgłoszenie prefiksu klucza do wykrywania wycieków

Materiał do wysłania operatorom skanerów sekretów (GitHub Secret Scanning,
GitGuardian, TruffleHog i podobne). Celem jest wykrywanie kluczy `adres-pl`
przypadkowo opublikowanych w repozytoriach, obrazach i pastebinach.

## Wzorzec

```
adr_(live|test)_[A-Za-z0-9_-]{32}_[A-Za-z0-9_-]{6}
```

Długość zawsze **48 znaków**. Dwa środowiska: `adr_live_` (produkcyjne)
i `adr_test_`.

Przykład o poprawnej strukturze, **niebędący działającym kluczem** —
suma kontrolna jest celowo błędna:

```
adr_live_00000000000000000000000000000000_XXXXXX
```

## Weryfikacja bez naszego udziału — i dlaczego to możliwe

Ostatnie sześć znaków to suma kontrolna sekretu, liczona **CRC32 bez żadnego
sekretu po naszej stronie**. Partner może więc odróżnić prawdziwy klucz od
losowego ciągu o tym samym kształcie, nie kontaktując się z nami i nie mając
dostępu do niczego poufnego.

To nie jest wygoda, tylko **warunek konstrukcyjny**: gdyby suma była liczona
z pieprzem, stałaby się wyrocznią — kto miałby próbki, odróżniałby nasze klucze
od losowych, a skaner i tak nie mógłby ich zweryfikować. Bezpieczeństwo daje
entropia sekretu (192 bity), nie utajnienie sumy.

Algorytm weryfikacji:

1. sprawdź wzorzec i długość 48,
2. weź 32 znaki sekretu (pozycje 9–40),
3. policz CRC32 z ich reprezentacji ASCII,
4. zapisz wynik jako 4 bajty big-endian, zakoduj base64url, weź 6 pierwszych znaków,
5. porównaj z ostatnimi sześcioma znakami klucza.

Referencyjna implementacja: `packages/core/src/api-key.ts`, funkcja
`apiKeyChecksum` — bez zależności zewnętrznych, około 40 linii, działa też
w przeglądarce.

Wartości wzorcowe do sprawdzenia implementacji (przypięte testem
`packages/core/test/klucz-api.ts`, kontrola 7):

| sekret | suma |
|---|---|
| `adres-pl-wzorzec` | `V8lyEg` |
| *(pusty)* | `AAAAAA` |

## Współczynnik fałszywych trafień

Sześć znaków sumy to 36 bitów kontroli, więc losowy ciąg pasujący do wzorca
przechodzi weryfikację z prawdopodobieństwem około 1,5 × 10⁻¹¹. Praktycznie
każde trafienie jest prawdziwym kluczem.

## Czego zgłoszenie NIE zawiera

Ani jednego działającego klucza, ani skrótu, ani pieprza. Wzorzec i algorytm
sumy są jawne z założenia.

## Co robimy po zgłoszeniu wycieku

Procedura operacyjna: `docs/runbook-klucze.md`, sekcja „Wyciek klucza —
unieważnienie natychmiastowe". Unieważnienie jest jednym poleceniem i działa
we wszystkich instancjach usługi typowo poniżej 100 ms.

## Kontakt

Do uzupełnienia przed wysłaniem: adres zespołu bezpieczeństwa oraz kanał
zgłoszeń. **Kryterium ukończenia zadania 8.9 to WYSŁANIE zgłoszenia**;
przyjęcie go zależy od partnera i nie jest w naszej gestii.
