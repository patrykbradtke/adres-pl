# Komponent adresowy — rekomendacja front-end (do realizacji później)

*Stan wiedzy: 5 sierpnia 2026. Kontekst: 6 mikrofrontendów Angular + 4 paczki npm,
Angular 21.2.19 (LTS), Module Federation.*

> **Wniosek w jednym zdaniu:** wąskim gardłem nie jest migracja Angular 21 → 22,
> tylko **webpack Module Federation → Native Federation** — i to jest warunek
> konieczny, niezależny od wersji Angulara.

---

## 1. Co się zmieniło od czasu, gdy sprawdzaliście MF ostatnio

Twoja pamięć („2 miesiące temu nie było stabilne") była **trafna**, ale sytuacja
przesunęła się w kilku miejscach:

| Fakt | Data | Znaczenie |
|---|---|---|
| `@angular-architects/native-federation@22.0.0` | 03.06.2026 | ten sam dzień co Angular 22.0.0 |
| przed tym: kod v4 żył w osobnej paczce beta `native-federation-v4` | maj/czerwiec 2026 | stąd wrażenie niestabilności — słusznie |
| 7 patchy w 10 tygodni (22.0.1 → 22.0.6) | VI–VII 2026 | stabilizacja „w locie", część to zmiany funkcjonalne |
| `autoShareScope()` | 22.0.4, **03.07.2026** | rozwiązuje version skew przy stopniowej migracji |
| **`native-federation@22.1.0`** | **05.08.2026** | **pierwsza wersja NF zgodna z Angular 22.1 — wyszła dziś** |

Angular 22.1.0 ukazał się 29.07.2026, a NF dogonił go dopiero 05.08 — przez
tydzień `npm install` wywalał się na peer dependency
([issue #109](https://github.com/native-federation/angular-adapter/issues/109)).

### 🔴 To nie jest jednorazowy poślizg — to cecha konstrukcyjna

Builder NF importuje **prywatne API Angular CLI**:

```js
import { buildApplicationInternal, serveWithVite } from "@angular/build/private";
import { createCompilerPlugin } from '@angular/build/private';
```

Stąd peer dependency z **tyldą, nie caretem**: `{"@angular/build": "~22.1.0"}`.

Angular wydaje minory co ~6–8 tygodni. **Zakładajcie, że przy każdym `ng update`
do nowego minora czekacie od kilku dni do tygodnia na NF.** To trzeba wpisać
w proces release'owy, nie w rejestr ryzyk.

---

## 2. Webpack Module Federation jest ślepą uliczką

| Sygnał | Dowód |
|---|---|
| Brak wersji 22.x | ostatnia `@angular-architects/module-federation` to **21.2.2 z 20.03.2026** |
| Zero aktywności od premiery Angular 22 | brak wydanych commitów od 03.06.2026 |
| Pytanie wprost o wsparcie v22 — bez odpowiedzi | [issue #1116](https://github.com/angular-architects/module-federation-plugin/issues/1116), otwarte od 24.06.2026 |
| Pytanie o MF 2.0 — bez odpowiedzi | [issue #1051](https://github.com/angular-architects/module-federation-plugin/issues/1051), otwarte od 04.02.2026 |
| `ngx-build-plus` (zależność pomocnicza) | stoi na **20.0.0 z 02.06.2025** |

Formalnie nie jest oznaczony jako `deprecated` na npm — ale nie ma wersji dla
Angular 22, nie ma aktywności i nie ma odpowiedzi na bezpośrednie pytania.

**Nx poszedł krok dalej i powiedział to wprost** — cytat z
[nx.dev/docs/kb/angular-micro-frontends](https://nx.dev/docs/kb/angular-micro-frontends):

> As of Nx v23, the `@nx/angular` host and remote generators are deprecated, and
> **Angular Module Federation in Nx is no longer supported going forward. The
> supported path for Angular micro frontends is `@angular-architects/native-federation`**

Generatory znikają w Nx v24. Nx nie ma własnego rozwiązania — odsyła do NF.

### Czy webpackowy builder ratuje sytuację? Nie.

`@angular-devkit/build-angular@22.1.3` **nadal działa** w Angular 22 — jest
oznaczony jako deprecated, ale nie usunięty (Breaking Changes 22.0.0 wyrzuciły
Node 20 i buildery `:jest`/`:web-test-runner`, nie `:browser`). Data usunięcia:
nieznana, realistycznie nie wcześniej niż v24.

Ale to nieistotne — brakującym elementem nie jest webpack, tylko **plugin**,
którego wersja 22.x nie istnieje.

### Rspack + MF 2.0?

`@nx/angular-rspack@23.1.1` obejmuje Angular 22, ale dokumentacja Nx mówi wprost:
*„Angular Rspack support is still experimental and is not yet considered
production ready"* (brak Server Routing, brak App Engine APIs). Generatory to te
same, które znikają w Nx v24. `@ng-rsbuild/plugin-angular` nie był aktualizowany
od 15 miesięcy i peeruje Angular 19.

**Dla 6 produkcyjnych mikrofrontendów: nie w 2026 roku.**

---

## 3. Rekomendowana kolejność

```
        DZIŚ                    ETAP 1                  ETAP 2               ETAP 3
   ┌──────────────┐       ┌──────────────┐       ┌──────────────┐    ┌──────────────┐
   │ Angular 21.2 │       │ Angular 21.2 │       │ MFE po jednym│    │ biblioteka   │
   │ webpack MF   │  ──►  │ Native Fed.  │  ──►  │  21 → 22     │──► │ adresowa     │
   │              │       │ (v3 lub v4)  │       │ z autoShare  │    │ na 22        │
   └──────────────┘       └──────────────┘       └──────────────┘    └──────────────┘
                            ryzyko: średnie        ryzyko: niskie      ryzyko: niskie
                            1 zmienna naraz        dzięki scope'om
```

**Nie róbcie MF→NF i 21→22 jednocześnie.** Dwie ryzykowne zmiany naraz przy
6 mikrofrontendach to proszenie się o tydzień debugowania, w którym nie wiadomo,
która zmiana coś zepsuła.

### Etap 1 — MF → Native Federation, wciąż na Angular 21

Dwie opcje:

| Opcja | Paczka | Za | Przeciw |
|---|---|---|---|
| **v3** | `@angular-architects/native-federation@21.2.5` | dojrzalsze, mniejsze ryzyko | przy przejściu na 22 czeka was jeszcze upgrade v3→v4 |
| **v4** | `@angular-architects/native-federation-v4@21.2.9` | API identyczne z linią 22.x — etap 2 to wtedy sama zmiana wersji Angulara | README **nadal ma** `> [!WARNING] This is our v4 version which is currently in beta` |

**Rekomendacja: v4**, mimo bannera beta. Runtime, config i builder API są wg
dokumentacji identyczne z 22.x, więc etap 2 redukuje się do `ng update` — a to
jest dokładnie ten podział ryzyka, o który chodzi. Zweryfikujcie na jednym MFE
przed rozlaniem na resztę.

### Etap 2 — migracja MFE pojedynczo

**Włączcie `autoShareScope()` ZANIM ruszycie pierwszy MFE.** To jest mechanizm,
który pozwala 6 mikrofrontendom żyć w dwóch wersjach Angulara jednocześnie:

```js
// federation.config.mjs
import { withNativeFederation, shareAll, autoShareScope }
  from "@angular-architects/native-federation/config";

export default withNativeFederation({
  name: "mfe-zamowienia",
  shareScope: autoShareScope(),   // -> "ng22.1" albo "ng21.2", zależnie od package.json
  shared: {
    ...shareAll({ singleton: true, strictVersion: true, requiredVersion: "auto" }),
    // Bez tego tree-shaking secondary entry pointów potrafi rozszczepić
    // Angulara na dwie wersje — udokumentowana pułapka.
    "@angular/core": { includeSecondaries: { keepAll: true }, singleton: true, strictVersion: true },
  },
});
```

`autoShareScope()` czyta wersję Angulara z `package.json` i generuje nazwę scope'u:

| `level` | wynik dla `@angular/core` 22.1.4 |
|---|---|
| `'major'` | `ng22` |
| `'minor'` | `ng22.1` ← domyślne |
| `'patch'` | `ng22.1.4` |

**Rekomendacja: `level: 'major'`** na czas migracji. Daje dwie grupy (`ng21`,
`ng22`) zamiast wielu, więc kosztem jest jedno dodatkowe pobranie Angulara,
a zyskiem — brak `NG0203`/`NG0201` i możliwość migracji MFE po jednym.

Uzasadnienie wprost z dokumentacji version-resolvera:

> Setting `shareScope: "strict"` is special. […] **This is essential for compiled
> frameworks like Angular where patch versions can break AOT output compatibility.**

Wymaga NF ≥ 22.0.4 po stronie 22 i backportu v4 po stronie 21.

### Etap 3 — biblioteka adresowa

Dopiero tutaj wchodzi `@firma/ng-address`.

---

## 4. Biblioteka wspierająca Angular 21 i 22 jednocześnie

Da się — ale są dwa konkretne pola minowe.

### Toolchain

```
@angular/compiler-cli 21.2.19  ->  peer typescript ">=5.9 <6.1"
@angular/compiler-cli 22.1.0   ->  peer typescript ">=6.0 <6.1"
                                    ^^^^^^^^^^^^^ TS 6.0 jest wspólnym oknem
```

Ale `ng-packagr@21.2.0` ma peer `typescript ">=5.9 <6.0"` — **nie przyjmie TS 6.0**.

**Konfiguracja:** buduj `ng-packagr@22` + `@angular/compiler-cli@22` + TS 6.0,
`peerDependencies` biblioteki `^21.2.0 || ^22.0.0`, `compilationMode: "partial"`.

### 🔴 Twarda blokada: nowy dekorator `@Service` z Angular 22

Angular 22 wprowadza `@Service` i prymitywy `ɵɵdefineService` / `ɵɵngDeclareService`.
W `@angular/compiler@22.1.0`:

```js
const MINIMUM_PARTIAL_LINKER_VERSION = '22.0.0';
```

Linker w `@angular/compiler-cli@21.2.19` **nie zna** `ɵɵngDeclareService` — nie ma
go na liście `declarationFunctions`.

| | Angular 21.2.19 | Angular 22.1.0 |
|---|---|---|
| `@Injectable` → `ɵɵngDeclareInjectable` | minVersion 12.0.0 ✅ | ✅ |
| `@Service` → `ɵɵngDeclareService` | **nie istnieje** ❌ | minVersion 22.0.0 |

**Reguła: zakaz `@Service` w bibliotece, dopóki wszystkie 6 MFE nie będą na 22.**
Wyegzekwujcie lintem, nie code review — to jest błąd, który wyjdzie dopiero
u konsumenta przy buildzie, nie u was.

Pozostałe minVersions w kompilatorze 22 są ≤ 21 (komponenty 14.0.0, defer 18.0.0,
signal inputs 17.1.0/17.2.0), więc bezpieczne.

### Inne breaking changes Angular 22 istotne dla biblioteki współdzielonej

- **`changeDetection` niezdefiniowane → domyślnie `OnPush`** (było `Default`).
  Zachowanie runtime waszych komponentów zależy od tego, którą wersją Angulara
  zostały skompilowane. → **piszcie `changeDetection` jawnie w każdym komponencie.**
- `ComponentFactoryResolver` i `ComponentFactory` — **usunięte**
- `createNgModuleRef` → `createNgModule`
- `ChangeDetectorRef.checkNoChanges` — usunięte
- `provideRoutes()` — usunięte
- `paramsInheritanceStrategy` domyślnie `'always'`

### 🔴 Partial-Ivy NIE wystarcza w kontekście federacji

Partial-Ivy rozwiązuje **build-time**. W runtime federacji problem jest inny:

Jeśli biblioteka jest `singleton: true` w globalnym scope, jedna jej instancja
trafia do wszystkich remote'ów — zlinkowana przeciw **jednej** wersji Angulara.
Przy MFE-A na 21 i MFE-B na 22 jeden z nich dostanie kod zlinkowany „nie swoim"
runtime'em.

**Konsekwencja projektowa:** biblioteka musi trafić do tego samego
version-pinned scope co Angular. Czyli **jedna instancja per linia wersji**, nie
jedna dla wszystkich. Jeśli biblioteka trzyma stan globalny (singleton service
z cache'em, rejestr), **rozjedzie się na dwie instancje** w okresie przejściowym.

→ **Projektujcie bibliotekę jako bezstanową.** Cały stan po stronie konsumenta
albo w mikroserwisie. To i tak dobra praktyka, ale tutaj jest wymogiem, nie
preferencją. Nasz `@adres-pl/core` już taki jest — czysto funkcyjny, zero
globalnego stanu.

---

## 5. Wybór API biblioteki — zależny od tego, czy 21 zostaje w grze

| Scenariusz | Formularz | Combobox |
|---|---|---|
| **Tylko Angular 22** | Signal Forms (stable) + eksport `polishAddressSchema` | `@angular/aria/combobox` (GA) |
| **`^21 \|\| ^22`** | **`ControlValueAccessor`** — Signal Forms odpada, API różni się między liniami | CDK Overlay + własna obsługa ARIA |

**Rekomendacja niezależna od scenariusza:** `ControlValueAccessor` jako
**główny** kontrakt integracyjny, Signal Forms jako opcjonalna warstwa dodana
później. CVA jest stabilne od lat, wspierane przez tysiące bibliotek i nie pęknie
przy żadnej z tych migracji. Signal Forms można dołożyć jako secondary entry
point (`@firma/ng-address/signals`), gdy wszystkie MFE będą na 22.

To kosztuje trochę elegancji, ale kupuje niezależność od najbardziej ruchomej
części ekosystemu.

---

## 6. Znane otwarte problemy NF + Angular 22

Wszystkie **otwarte** na 05.08.2026, repo `native-federation/angular-adapter`:

| # | Data | Problem |
|---|---|---|
| **#119** | 05.08 | **`InjectionToken` duplication → NG0201.** Kod wykonuje się dwa razy (rejestr `es-module-shims` + natywny cache modułów) → dwie instancje tokenu → DI porównuje po referencji → provider not found. Zgłaszający: *„band-aid for critical services, not a general solution"* |
| **#113** | 03.08 | `File 'bootstrap.ts' not found in TypeScript compilation` — NF 22.0.6 + Angular 22.1.0 + TS 6.0.5, monorepo z 9 MFE |
| **#110** | 02.08 | Production serve: `Unsupported Content-Type "text/html"` przy shared deps |
| **#73** | 26.06 | **Chunk optimization Angulara 22 psuje remote-entry** — hashe regenerowane po buildzie federacji, „filename drift". Workaround: `NG_BUILD_OPTIMIZE_CHUNKS=0` (kosztem wydajności) |
| #101 | 29.07 | Builder aktualizuje federation tsconfig, ale go nie tworzy → świeży `git clone` się nie buduje |
| #117 | 04.08 | Windows: wielkość litery dysku gubi shared mappings |

`#119` i `#73` obserwujcie — pierwszy dotyka DI (czyli wszystkiego), drugi
produkcyjnego builda.

### ⚠️ Luka w wiedzy: zoneless + federacja

**Nie znalazłem ani jednego issue, ani wzmianki w dokumentacji NF, która wiązałaby
zoneless z federacją.** Dokumentacja NF w ogóle nie porusza tematu.

To nie znaczy, że problemu nie ma — znaczy, że **nie ma publicznych dowodów
w żadną stronę**. Przy Angular 22 (`OnPush` domyślnie, sygnały, `provideZonelessChangeDetection`)
to najbardziej prawdopodobne miejsce niespodzianki.

→ **Jedyna pozycja, którą trzeba zamknąć własnym PoC przed decyzją.**

---

## 7. Harmonogram i decyzje

### Nie migrujcie dziś

NF 22.1.0 ma kilka godzin. Angular 21.2 jest w LTS **do czerwca 2027** — macie
10 miesięcy zapasu i zero presji czasowej. Poczekajcie 2–4 tygodnie i obserwujcie
`#113`, `#119`, `#73`.

### Kolejność zadań

| # | Zadanie | Kiedy | Blokuje |
|---|---|---|---|
| 1 | PoC: zoneless + Native Federation, 2 MFE | teraz, równolegle do backendu | wszystko poniżej |
| 2 | PoC: `autoShareScope({level:'major'})` na dwóch MFE w różnych wersjach Angulara | po #1 | etap 2 |
| 3 | MF → NF v4 na Angular 21, jeden MFE | po #1–2 | rozlanie na resztę |
| 4 | MF → NF, pozostałe 5 MFE | po #3 | migrację Angulara |
| 5 | Angular 21 → 22, MFE po jednym | po #4 | — |
| 6 | `@firma/ng-address` — build na 22, peer `^21.2 \|\| ^22`, CVA | równolegle od #3 | — |

### Decyzje do podjęcia

| Decyzja | Rekomendacja |
|---|---|
| v3 czy v4 na etapie 1 | **v4** (`native-federation-v4@21.2.9`) — etap 2 redukuje się do `ng update` |
| `autoShareScope` level | **`'major'`** na czas migracji, `'minor'` docelowo |
| API formularza w bibliotece | **CVA** jako główne, Signal Forms jako secondary entry point później |
| `@Service` w bibliotece | **zakaz, wymuszony lintem** do końca migracji |
| Stan w bibliotece | **bezstanowa** — wymóg, nie preferencja (patrz §4) |
| Kiedy zacząć | **po PoC zoneless**, nie wcześniej |

---

## Źródła

- [registry.npmjs.org/@angular-architects/native-federation](https://registry.npmjs.org/@angular-architects/native-federation) · [module-federation](https://registry.npmjs.org/@angular-architects/module-federation) · [native-federation-v4](https://registry.npmjs.org/@angular-architects/native-federation-v4)
- [native-federation.com/docs/angular-adapter](https://native-federation.com/docs/angular-adapter/) · [version-resolver](https://native-federation.com/docs/orchestrator/version-resolver/) · [core/sharing](https://native-federation.com/docs/core/sharing/)
- [github.com/native-federation/angular-adapter](https://github.com/native-federation/angular-adapter) — issues [#73](https://github.com/native-federation/angular-adapter/issues/73), [#109](https://github.com/native-federation/angular-adapter/issues/109), [#113](https://github.com/native-federation/angular-adapter/issues/113), [#119](https://github.com/native-federation/angular-adapter/issues/119)
- [github.com/angular-architects/module-federation-plugin](https://github.com/angular-architects/module-federation-plugin) — issues [#1051](https://github.com/angular-architects/module-federation-plugin/issues/1051), [#1116](https://github.com/angular-architects/module-federation-plugin/issues/1116)
- [nx.dev — Micro Frontends with Angular](https://nx.dev/docs/kb/angular-micro-frontends) · [Angular/Nx version matrix](https://nx.dev/docs/kb/angular-nx-version-matrix) · [Angular Rspack](https://nx.dev/docs/technologies/angular/angular-rspack/introduction)
- [angular.dev — build system migration](https://angular.dev/tools/cli/build-system-migration) · [releases](https://angular.dev/reference/releases)
- [Angular CLI CHANGELOG](https://github.com/angular/angular-cli/blob/main/CHANGELOG.md) · [Angular CHANGELOG](https://github.com/angular/angular/blob/main/CHANGELOG.md)
