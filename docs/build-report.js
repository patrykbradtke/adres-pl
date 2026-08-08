/**
 * Generator raportu dla Klienta i analityków.
 *
 * Wydanie 1.3. Ten plik jest zrodlem prawdy dla dokumentu — plik .docx
 * powstaje wylacznie stad. Recznych poprawek w Wordzie nie wprowadzac,
 * bo znikaja przy kolejnym przebiegu.
 *
 *   node docs/build-report.js
 *
 * Wynik: docs/raport/raport-baza-mikroserwis-v<WERSJA>.docx
 */
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
  PageBreak, LevelFormat,
  Footer, PageNumber, TabStopType, TabStopPosition,
} from 'docx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WERSJA = '1.4';
const DATA = '9 sierpnia 2026';

const W = 9026;                 // szerokosc kolumny tekstu A4 przy marginesach 1"
const C = {
  head: 'E8EDF2',
  alt:  'F5F7F9',
  warn: 'FDF1E7',
  ok:   'EDF5EE',
  stop: 'FBEAEA',
  accent: '1F4E5F',
  muted: '5A6873',
};

// ---------- helpers ----------
const P = (text, opts = {}) => new Paragraph({
  spacing: { after: opts.after ?? 120, line: 276 },
  alignment: opts.align,
  indent: opts.indent,
  border: opts.border,
  shading: opts.shading,
  children: Array.isArray(text) ? text : [new TextRun({ text, size: opts.size ?? 21, color: opts.color, bold: opts.bold, italics: opts.italics })],
});

const H1 = (t) => new Paragraph({ text: t, heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 180 } });
const H2 = (t) => new Paragraph({ text: t, heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 140 } });
const H3 = (t) => new Paragraph({ text: t, heading: HeadingLevel.HEADING_3, spacing: { before: 220, after: 110 } });

const BULLET = (t, level = 0) => new Paragraph({
  numbering: { reference: 'bul', level },
  spacing: { after: 80, line: 276 },
  children: Array.isArray(t) ? t : [new TextRun({ text: t, size: 21 })],
});

const NUM = (t) => new Paragraph({
  numbering: { reference: 'num', level: 0 },
  spacing: { after: 80, line: 276 },
  children: Array.isArray(t) ? t : [new TextRun({ text: t, size: 21 })],
});

/** Akapit z wytluszczonym wprowadzeniem — wzorzec powtarzany w calym dokumencie. */
const LEAD = (bold, rest) => P([
  new TextRun({ text: bold, bold: true, size: 21 }),
  new TextRun({ text: rest, size: 21 }),
]);

const LEADB = (bold, rest) => BULLET([
  new TextRun({ text: bold, bold: true, size: 21 }),
  new TextRun({ text: rest, size: 21 }),
]);

function cell(text, w, o = {}) {
  const runs = Array.isArray(text) ? text
    : [new TextRun({ text: String(text), bold: o.bold, size: o.size ?? 19, color: o.color })];
  return new TableCell({
    width: { size: w, type: WidthType.DXA },
    shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined,
    margins: { top: 70, bottom: 70, left: 110, right: 110 },
    verticalAlign: 'center',
    children: [new Paragraph({ spacing: { after: 0, line: 240 }, alignment: o.align, children: runs })],
  });
}

function table(cols, rows, opts = {}) {
  const widths = cols.widths;
  const header = new TableRow({
    tableHeader: true,
    children: cols.head.map((h, i) => cell(h, widths[i], { bold: true, fill: C.head, size: 19 })),
  });
  const body = rows.map((r, ri) => new TableRow({
    children: r.map((v, i) => {
      const fill = opts.rowFill ? opts.rowFill(r, ri) : (ri % 2 ? C.alt : undefined);
      return cell(v, widths[i], { fill, size: opts.size ?? 19, bold: opts.boldFirst && i === 0 });
    }),
  }));
  return new Table({
    columnWidths: widths,
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    rows: [header, ...body],
  });
}

const SPACER = (h = 160) => new Paragraph({ spacing: { after: h }, children: [] });

/** Ramka informacyjna / ostrzegawcza. */
function box(title, lines, fill) {
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'D5DBE0' };
  const out = [new Paragraph({
    shading: { type: ShadingType.CLEAR, fill, color: 'auto' },
    border: { top: border, bottom: { ...border, size: 0 }, left: border, right: border },
    spacing: { before: 160, after: 0, line: 276 },
    indent: { left: 120, right: 120 },
    children: [new TextRun({ text: title, bold: true, size: 21 })],
  })];
  lines.forEach((l, i) => out.push(new Paragraph({
    shading: { type: ShadingType.CLEAR, fill, color: 'auto' },
    border: {
      top: { ...border, size: 0 },
      bottom: i === lines.length - 1 ? border : { ...border, size: 0 },
      left: border, right: border,
    },
    spacing: { after: i === lines.length - 1 ? 0 : 60, line: 276 },
    indent: { left: 120, right: 120 },
    children: [new TextRun({ text: l, size: 20 })],
  })));
  out.push(SPACER(180));
  return out;
}

const children = [];

// ================= STRONA TYTULOWA =================
children.push(
  SPACER(2600),
  P([new TextRun({ text: 'Komponent walidacji danych adresowych', bold: true, size: 44, color: C.accent })], { align: AlignmentType.CENTER, after: 100 }),
  P([new TextRun({ text: 'Baza danych i mikroserwis', size: 32, color: C.muted })], { align: AlignmentType.CENTER, after: 700 }),
  P([new TextRun({ text: 'Raport z analizy i realizacji', size: 26 })], { align: AlignmentType.CENTER, after: 120 }),
  P([new TextRun({ text: 'Stan prac, ocena ryzyk, warianty rozwiązania', size: 22, color: C.muted })], { align: AlignmentType.CENTER, after: 1400 }),
  P([new TextRun({ text: 'Odbiorcy: Klient, Analityk biznesowy, Zespół wdrożeniowy', size: 21 })], { align: AlignmentType.CENTER, after: 80 }),
  P([new TextRun({ text: `Wersja ${WERSJA}  ·  ${DATA}`, size: 21, color: C.muted })], { align: AlignmentType.CENTER }),
  new Paragraph({ children: [new PageBreak()] }),
);

// ================= SPIS TRESCI =================
const TOC = [
  ['1.', 'Streszczenie zarządcze'],
  ['2.', 'Kontekst biznesowy'],
  ['3.', 'Źródła danych adresowych w Polsce'],
  ['4.', 'Ryzyka i kalendarz zmian'],
  ['5.', 'Architektura rozwiązania'],
  ['6.', 'Model danych i reguły — dla analityka'],
  ['7.', 'Proces aktualizacji danych'],
  ['8.', 'Wyniki weryfikacji'],
  ['9.', 'Warianty rozwiązania'],
  ['10.', 'Plan dalszych prac'],
  ['11.', 'Decyzje wymagane od Zamawiającego'],
  ['12.', 'Słownik pojęć'],
];
children.push(H1('Spis treści'));
TOC.forEach(([n, t]) => children.push(new Paragraph({
  spacing: { after: 110, line: 276 },
  indent: { left: 240 },
  tabStops: [{ type: TabStopType.LEFT, position: 700 }],
  children: [new TextRun({ text: n + '\t' + t, size: 22 })],
})));

// ================= HISTORIA DOKUMENTU =================
children.push(H1('Historia dokumentu'));
children.push(P(
  'Niniejsze opracowanie jest kolejnym wydaniem raportu z 5 sierpnia 2026. Struktura ' +
  'i wnioski pozostają, zmienia się podstawa dowodowa: wyniki z próbek zostały zastąpione ' +
  'pomiarami na rzeczywistych danych rejestru, a deklaracje o zakresie zbudowanego ' +
  'rozwiązania — zestawione z zawartością repozytorium.'));

children.push(table(
  { head: ['Wydanie', 'Data', 'Co przyniosło'], widths: [1200, 1400, 6426] },
  [
    ['1.0', '5.08.2026', 'Analiza źródeł, architektura, warianty rozwiązania, kalendarz ryzyk. Wyniki z fixture’ów i zbiorów syntetycznych'],
    ['1.1', '6.08.2026', 'Komplet archiwum PRG (16 województw), słowniki TERYT pobrane bez konta w GUS, potwierdzenie nowej struktury danych na rzeczywistym pliku. Rozstrzygnięte dwa z czterech pytań otwartych'],
    ['1.2', '7.08.2026', 'Publikacja 1 990 483 punktów, pięć usterek wykrytych na danych rzeczywistych, sprostowanie czasu pełnego przebiegu i czasów odpowiedzi'],
    ['1.3', '8.08.2026', 'Uzgodnienie raportu ze stanem repozytorium. Ujawnione braki blokujące produkcję, przepisany plan prac na 11–15 tygodni, usunięte deklaracje o elementach, których nie zbudowano'],
    ['1.4', '9.08.2026', 'Uruchomienie na całym kraju: 8 605 682 punkty ze wszystkich 16 województw. Trzy kolejne usterki wykryte dopiero przy pełnej skali, w tym kontrola jakości, która nigdy nie działała. Nowe pomiary czasów odpowiedzi i przetwarzania'],
  ],
  { rowFill: (r) => r[0] === '1.4' ? C.ok : undefined },
));

children.push(SPACER());
children.push(...box(
  'Co zmieniło się w wydaniu 1.4',
  [
    'Rozwiązanie działa na komplecie danych: 8 605 682 punkty adresowe ze wszystkich 16 województw, wobec 1 990 483 z czterech w wydaniu 1.3. Pozycja „uruchomienie na pełnym zbiorze” jest zamknięta.',
    'Przejście na pełną skalę ujawniło trzy kolejne usterki — rozdział 8.4. Jedna z nich to kontrola jakości, która nie zadziałałaby w produkcji ani razu.',
    'Czasy odpowiedzi przemierzono na danych rzeczywistych dwiema metodami. Wyniki są znacznie lepsze od podanych w wydaniach 1.2–1.3, a rozbieżność ma źródło metodyczne — rozdział 8.6.',
    'Wcześniejsza zmiana z wydania 1.3 pozostaje w mocy: raport rozdziela architekturę docelową od stanu zbudowanego, a elementy niewdrożone oznacza wprost.',
  ],
  C.head,
));

children.push(P(
  'Dwa wcześniejsze szacunki okazały się zbyt optymistyczne i zostały skorygowane w górę ' +
  'pod wpływem pomiarów: mediana czasu odpowiedzi z 0,49 ms do ok. 4 ms oraz czas pełnego ' +
  'przebiegu dla kraju z zakładanych 40 minut do ok. 4 godzin, czyli 1–1,5 godziny po ' +
  'zrównolegleniu. Zmiany merytoryczne względem wydania 1.0 zebrano w rozdziałach 8.3–8.6.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ================= 1. STRESZCZENIE =================
children.push(H1('1. Streszczenie zarządcze'));

children.push(P(
  'Celem prac jest zbudowanie własnej bazy adresowej dla Polski oraz mikroserwisu, ' +
  'który udostępnia ją aplikacjom w postaci podpowiedzi adresowych i walidacji. ' +
  'Rozwiązanie ma zastąpić sytuację, w której adres wpisywany przez użytkownika ' +
  'nie jest w żaden sposób weryfikowany wobec rejestru państwowego.'));

children.push(H2('1.1. Stan prac'));
children.push(P(
  'Zbudowano i przetestowano end-to-end kompletny rdzeń rozwiązania: pobieranie danych ' +
  'z rejestru państwowego, przetwarzanie, bazę danych, mechanizm publikacji z kontrolami ' +
  'jakości oraz mikroserwis HTTP. Całość zweryfikowano na działającej instancji ' +
  'PostgreSQL 17 z rozszerzeniem PostGIS.'));

children.push(table(
  { head: ['Obszar', 'Status', 'Uwagi'], widths: [3000, 1700, 4326] },
  [
    ['Pobieranie danych z rejestru PRG', 'Gotowe', 'Pobieranie wojewódzkie, archiwizacja z sumą kontrolną. Tani sondaż nagłówków HTTP okazał się niemożliwy — patrz 4.3'],
    ['Parser danych źródłowych (GML)', 'Gotowe', 'Obsługuje starą i nową strukturę; tryb rozpoznawania nieznanych plików'],
    ['Baza danych', 'Gotowe', 'Schemat, indeksy, publikacja transakcyjna'],
    ['Kontrole jakości danych', 'Gotowe', '5 kontroli, każda odpowiada realnemu incydentowi'],
    ['Silnik wyszukiwania', 'Gotowe', 'Mediana 1,7 ms na pełnym kraju, przez interfejs HTTP — patrz 8.6'],
    ['Mikroserwis HTTP', 'Gotowe', '11 punktów końcowych /v1 oraz 4 operacyjne — patrz 5.4'],
    ['Reguły walidacji adresu', 'Gotowe', 'Format, zgodność z rejestrem, poziomy pewności'],
    ['Import słowników TERYT', 'Gotowe', 'Pliki pełne z eTeryt, bez konta w GUS'],
    ['Metryki i reguły alertów', 'Gotowe', '17 metryk pod /metrics, 6 reguł alertów, manifest zadania cyklicznego'],
    ['Uruchomienie na pełnym zbiorze', 'Gotowe', 'Wszystkie 16 województw opublikowane 9.08.2026: 8 605 682 punkty — patrz 8.3'],
    ['Odbiorca metryk i powiadomienia', 'Do zrobienia', 'Metryki i reguły są, brakuje tego, co je zbiera — patrz 1.2'],
    ['Uwierzytelnianie klientów API', 'Do zrobienia', 'Serwis nie weryfikuje dziś tożsamości klienta — patrz 5.5'],
    ['Kopie zapasowe poza maszyną', 'Do zrobienia', 'Archiwum i zrzut bazy leżą wyłącznie na dysku lokalnym — patrz 7.3'],
    ['Automatyzacja cyklu aktualizacji', 'Do zrobienia', 'Uruchomienie zadania cyklicznego, wznawianie przerwanych przebiegów'],
    ['Drugie źródło danych (iMPA)', 'Do zrobienia', 'Zabezpieczenie na wypadek awarii źródła podstawowego'],
  ],
  { rowFill: (r) => r[1] === 'Gotowe' ? C.ok : r[1] === 'Częściowo' ? C.head : C.warn },
));

children.push(SPACER());
children.push(P(
  'Szacowany nakład do wersji produkcyjnej: 11–15 tygodni pracy jednej osoby (55–73 dni ' +
  'roboczych) na sam back-end. Rozbicie na etapy znajduje się w rozdziale 10. Nakład nie ' +
  'zawiera panelu administracyjnego ani prac po stronie interfejsu użytkownika, które są ' +
  'przedmiotem odrębnych opracowań.'));

children.push(H2('1.2. Braki blokujące wdrożenie produkcyjne'));
children.push(P(
  'Rozwiązanie działa na komplecie danych krajowych i zostało na nich zmierzone. Trzy braki ' +
  'dzielą je jednak od wersji, którą można wystawić klientom. Wymieniamy je w streszczeniu, ' +
  'ponieważ każdy wpływa na termin i na decyzje Zamawiającego. Czwarty brak z wydania 1.3 — ' +
  'niepełny zakres danych — został zamknięty 9 sierpnia 2026.'));

children.push(table(
  { head: ['Brak', 'Na czym polega', 'Nakład'], widths: [2500, 4926, 1600] },
  [
    ['Serwis nie uwierzytelnia klientów', 'Serwis nie weryfikuje tożsamości klienta, więc nie da się rozdzielić limitów ani rozliczeń per klient. Do czasu naprawy nie powinien opuszczać sieci wewnętrznej. Możliwość obejścia limitowania zamknięto 8.08.2026 — patrz 5.5', '9–11 dni'],
    ['Kopie zapasowe nie opuszczają maszyny', 'Archiwum plików źródłowych i zrzut bazy leżą wyłącznie na dysku roboczym. Deklarowany czwarty poziom odporności na awarię źródła nie istnieje jeszcze fizycznie', '5–7 dni'],
    ['Metryki nie mają odbiorcy', 'Aplikacja wystawia 17 metryk i ma 6 gotowych reguł alertów, ale w konfiguracji uruchomieniowej nie ma niczego, co je zbiera. Awarie wykrywa dziś człowiek — w trakcie prac z 8–9 sierpnia dwukrotnie się to potwierdziło', '6–8 dni; pierwsze 3 dni dają większość efektu'],
  ],
  { rowFill: () => C.warn },
));

children.push(SPACER());
children.push(LEAD('Kolejność ma znaczenie. ',
  'Trzy braki są od siebie niezależne i można je prowadzić równolegle. Żaden nie wymaga ' +
  'rozstrzygnięcia pozostałych, więc harmonogram zależy wyłącznie od dostępności ludzi ' +
  'i od decyzji Zamawiającego z rozdziału 11. Najpilniejszy jest drugi: archiwum sprzed ' +
  '1 września 2026 nadal istnieje w jednej kopii, a terminu nie da się przesunąć.'));

children.push(H2('1.3. Wrześniowa zmiana formatu danych — ryzyko zamknięte'));

children.push(...box(
  'Termin: 1 września 2026 — zabezpieczenie wykonane 6.08.2026',
  [
    'Główny Urząd Geodezji i Kartografii przestaje wtedy publikować dane adresowe w dotychczasowej strukturze. Format SHP przeszedł na nową strukturę już 1 lipca 2026.',
    'Nowa struktura nie zawiera trzech informacji, które dziś wykorzystujemy: statusu budynku (istniejący / w budowie / planowany), numeru lokalu oraz przynależności administracyjnej.',
    'Zalecenie z wydania 1.0 zostało zrealizowane: pełny zrzut w dotychczasowej strukturze — komplet 16 województw, 1,8 GB, z sumą kontrolną każdego pliku — zarchiwizowano 6 sierpnia 2026.',
    'Parser przeszedł przez rzeczywisty plik w nowej strukturze bez odrzucenia jednego rekordu. Ryzyko bezpowrotnej utraty atrybutów jest zamknięte; pozostaje wyłącznie brak tych trzech atrybutów w danych bieżących po 1 września.',
  ],
  C.ok,
));

children.push(LEAD('Uwaga do trwałości zabezpieczenia: ',
  'archiwum spełnia swoją rolę tylko dopóki istnieje. Dziś jest to jedna kopia na dysku ' +
  'roboczym — po 1 września 2026 danych w starej strukturze nie da się pobrać ponownie ' +
  'z żadnego źródła. Wyniesienie tej kopii poza maszynę jest zadaniem pilnym, nie ' +
  'porządkowym (rozdz. 7.3 i 10).'));

children.push(H2('1.4. Rekomendacja'));
children.push(P(
  'Rekomendujemy kontynuację w obecnym modelu: własna baza zbudowana na państwowym ' +
  'rejestrze PRG, uzupełniona o niezależne źródło zapasowe, serwowana przez bezstanowy ' +
  'mikroserwis. Uzasadnienie:'));
children.push(BULLET('Dane rejestru PRG i TERYT są bezpłatne, bez licencji, z prawem do komercyjnego wykorzystania i redystrybucji. Jedynym obowiązkiem jest podanie źródła.'));
children.push(BULLET('Brak uzależnienia od zewnętrznego dostawcy w ścieżce krytycznej — żaden podmiot nie może podnieść ceny ani wycofać usługi.'));
children.push(BULLET('Adresy klientów nie opuszczają infrastruktury Zamawiającego, co upraszcza zgodność z RODO.'));
children.push(BULLET('Zmierzona wydajność jest ok. 30-krotnie lepsza niż zapytanie do bazy z indeksem tekstowym i ponad tysiąckrotnie lepsza niż sortowanie po podobieństwie tekstowym.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ================= 2. KONTEKST =================
children.push(H1('2. Kontekst biznesowy'));

children.push(H2('2.1. Problem'));
children.push(P(
  'Adres wpisany ręcznie przez użytkownika jest jednym z najczęstszych źródeł błędów ' +
  'w systemach obsługujących wysyłkę, fakturowanie i obsługę klienta. Typowe konsekwencje ' +
  'to nieudane doręczenia, dodatkowe koszty kuriera, opóźnienia, reklamacje oraz konieczność ' +
  'ręcznej korekty danych.'));

children.push(P('Najczęstsze przyczyny błędów w polskich danych adresowych:'));
children.push(BULLET('Nazwy potoczne ulic — użytkownik wpisuje „Kościuszki”, w rejestrze widnieje „Tadeusza Kościuszki”.'));
children.push(BULLET('Brak lub niezgodny kod pocztowy.'));
children.push(BULLET('Nieistniejące numery budynków — literówki albo budynki wyburzone.'));
children.push(BULLET('Duplikaty nazw miejscowości — nazwy takie jak „Nowa Wieś” występują w Polsce setki razy.'));
children.push(BULLET('Nieaktualne dane — zmienione nazwy ulic po dekomunizacji krążą w bazach klientów latami.'));

children.push(H2('2.2. Dlaczego budujemy własną bazę'));
children.push(P(
  'Rozważono trzy podejścia. Szczegółowe porównanie znajduje się w rozdziale 9. ' +
  'W skrócie: gotowe API zewnętrzne są szybkie we wdrożeniu, ale generują koszt rosnący ' +
  'liniowo z ruchem, uzależniają od dostawcy i wymagają przekazywania danych osobowych ' +
  'klientów poza infrastrukturę Zamawiającego. Własna baza wymaga większego nakładu ' +
  'początkowego, ale eliminuje wszystkie trzy problemy.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ================= 3. ZRODLA DANYCH =================
children.push(H1('3. Źródła danych adresowych w Polsce'));

children.push(H2('3.1. Przegląd'));
children.push(table(
  { head: ['Źródło', 'Zawartość', 'Dostęp i koszt', 'Licencja'], widths: [1900, 2400, 2400, 2326] },
  [
    ['PRG — punkty adresowe (GUGiK)', '8 560 617 punktów adresowych, 302 793 ulic i placów (stan 31.03.2026)', 'Bezpłatnie, bez rejestracji', 'Bez licencji — art. 40c ust. 5 Prawa geodezyjnego. Wolno komercyjnie i redystrybuować'],
    ['TERYT (GUS)', 'Rejestr jednostek podziału terytorialnego, miejscowości i ulic', 'Pliki bez rejestracji — sprawdzone 6.08.2026. Usługa sieciowa nie odpowiadała na zapytania, konto produkcyjne po zgłoszeniu na teryt_ws1@stat.gov.pl', 'Dane publiczne'],
    ['iMPA (Geo-System)', 'Ok. 6,3 mln punktów, ewidencja prowadzona przez ok. 1400 gmin', 'Bezpłatnie', 'Niejasna — wymaga pisemnego potwierdzenia'],
    ['Spis PNA (Poczta Polska)', 'Kody pocztowe według zakresów numerycznych — jedyne źródło autorytatywne', 'Wyszukiwarka bezpłatna; plik danych płatny', 'Zakaz redystrybucji'],
  ],
));

children.push(SPACER());
children.push(H2('3.2. Pułapka pozornej redundancji'));
children.push(P(
  'W trakcie analizy ustalono fakt istotny dla oceny ryzyka: popularne alternatywne ' +
  'źródła danych adresowych dla Polski — Overture Maps, OpenAddresses oraz w znacznej ' +
  'części OpenStreetMap — nie są źródłami niezależnymi. Wszystkie pobierają dane z tego ' +
  'samego pliku rejestru PRG.'));

children.push(P(
  'Potwierdzenie: projekt OpenAddresses w definicji polskich źródeł wskazuje wprost na ' +
  'adres pliku PRG na serwerze GUGiK, a Overture Maps w informacji o atrybucji podaje, ' +
  'że dane dla Polski są dystrybuowane przez OpenAddresses. Liczby to potwierdzają — ' +
  'PRG podaje 8 560 617 punktów, Overture 8 584 407.'));

children.push(...box(
  'Konsekwencja praktyczna',
  [
    'Gdyby rejestr PRG przestał być dostępny, wszystkie trzy alternatywy zamrożą się na ostatniej pobranej wersji i przestaną się aktualizować. Nie zapewniają zabezpieczenia.',
    'Jedynym niezależnym źródłem o zasięgu krajowym jest iMPA — system, w którym ok. 1400 gmin prowadzi ewidencję adresową, czyli źródło zasilające PRG. Prowadzi go podmiot komercyjny, więc ryzyko ma inny charakter niż ryzyko po stronie administracji.',
    'Uzupełniająco, ale wyłącznie lokalnie, dostępne są otwarte dane dużych miast — patrz poziom 3 w rozdziale 7.3.',
  ],
  C.warn,
));

children.push(H2('3.3. Kwestie licencyjne'));
children.push(P(
  'Rejestr PRG jest wolny od ograniczeń licencyjnych. Zgodnie z art. 40a ust. 2 pkt 1 lit. a ' +
  'ustawy Prawo geodezyjne i kartograficzne dane są udostępniane nieodpłatnie, a art. 40c ust. 5 ' +
  'stanowi wprost, że licencji dla tych materiałów nie wydaje się. Jedynym obowiązkiem, ' +
  'wynikającym z art. 40c ust. 3, jest podanie informacji o źródle w publikowanych opracowaniach.'));

children.push(...box(
  'Ostrzeżenie: OpenStreetMap i licencja ODbL',
  [
    'Dane OpenStreetMap są objęte licencją ODbL zawierającą klauzulę share-alike. Włączenie ich do produktowej bazy adresowej może rodzić obowiązek udostępnienia całej bazy pochodnej na tej samej licencji.',
    'W zbudowanym rozwiązaniu dane OSM są odseparowane na poziomie schematu bazy danych i służą wyłącznie do wykrywania luk w rejestrze PRG. Żaden rekord z tego obszaru nie trafia do danych produktowych. Zasada ta jest zapisana w komentarzu do schematu bazy.',
  ],
  C.warn,
));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ================= 4. RYZYKA =================
children.push(H1('4. Ryzyka i kalendarz zmian'));

children.push(H2('4.1. Kalendarz'));
children.push(table(
  { head: ['Data', 'Zdarzenie', 'Wpływ na projekt'], widths: [1500, 3600, 3926] },
  [
    ['1.07.2026', 'Koniec publikacji danych SHP w starej strukturze', 'Zrealizowane, bez wpływu — korzystamy z formatu GML'],
    ['1.09.2026', 'Koniec publikacji danych GML w starej strukturze', 'Ograniczony — archiwizacja wykonana 6.08.2026, parser potwierdzony na rzeczywistym pliku. Pozostaje brak trzech atrybutów w danych bieżących'],
    ['5.10.2026', 'Głosowanie Parlamentu Europejskiego nad zmianą dyrektywy INSPIRE', 'Kierunkowy, bez bezpośrednich skutków'],
    ['ok. 2028–2029', 'Transpozycja zmienionej dyrektywy INSPIRE', 'Średni — zanikają unijne wymogi dotyczące usług sieciowych'],
    ['bez daty', 'Projekt nowelizacji Prawa geodezyjnego — uprawnienie MON do ograniczania dostępu', 'Niski — dotyczy terenów obronnych'],
  ],
));

children.push(SPACER());
children.push(H2('4.2. Incydenty historyczne po stronie źródła'));
children.push(P(
  'Analiza dostępności rejestru PRG w poprzednich latach wykazała dwa typy zdarzeń, ' +
  'które przekładają się bezpośrednio na wymagania wobec procesu aktualizacji:'));

children.push(LEADB('Czerwiec 2024 — dane zamrożone. ',
  'Paczki nie były odświeżane przez co najmniej dwa tygodnie. Problem wykryła i zgłosiła firma zewnętrzna, nie instytucja prowadząca rejestr.'));
children.push(LEADB('Marzec 2016 — zrzut niekompletny. ',
  'Opublikowany plik nie zawierał danych Wrocławia. Podobny przypadek dotyczył Białegostoku.'));

children.push(P(
  'Wniosek: poprawna odpowiedź serwera i poprawny plik archiwum nie stanowią wystarczającego ' +
  'potwierdzenia jakości danych. Z tego powodu proces aktualizacji zawiera zestaw kontroli ' +
  'opisany w rozdziale 7.2.'));

children.push(H2('4.3. Ograniczenia po stronie źródła'));
children.push(table(
  { head: ['Czego brakuje', 'Zastosowane obejście'], widths: [4000, 5026] },
  [
    ['Plików różnicowych dla rejestru PRG', 'Porównanie sum kontrolnych treści i pełne przeładowanie'],
    ['Interfejsu podającego datę aktualizacji', 'Sprawdzono 6.08.2026: serwer nie zwraca ani ETag, ani Last-Modified dla żadnego z 16 województw. Obowiązuje harmonogram tygodniowy i porównanie sumy kontrolnej pobranego pliku'],
    ['Gwarancji stabilności adresów pobierania', 'Własne wersjonowane archiwum plików źródłowych'],
    ['Poprawnych schematów walidacyjnych XML', 'Własny parser strumieniowy zamiast narzędzi wymagających schematu'],
  ],
));

children.push(SPACER());
children.push(LEAD('Konsekwencja kosztowa braku sondażu: ',
  'każde sprawdzenie, czy dane się zmieniły, wymaga pobrania kompletu plików (1,8 GB) ' +
  'i policzenia sumy kontrolnej. To przesądza o tygodniowym, a nie dobowym cyklu ' +
  'aktualizacji — patrz 5.1.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ================= 5. ARCHITEKTURA =================
children.push(H1('5. Architektura rozwiązania'));

children.push(H2('5.1. Podział na komponenty'));
children.push(P(
  'Rozwiązanie dzieli się na dwa niezależnie skalowane elementy. Podział ten jest ' +
  'najważniejszą decyzją architektoniczną projektu.'));

children.push(table(
  { head: ['Komponent', 'Charakter', 'Uruchamianie', 'Odpowiedzialność'], widths: [1700, 1900, 2100, 3326] },
  [
    ['Proces przetwarzania danych', 'Stanowy, zasobożerny', 'Raz w tygodniu, zadanie cykliczne', 'Pobranie, przetworzenie, kontrole jakości, publikacja'],
    ['Mikroserwis HTTP', 'Bezstanowy, lekki', 'Ciągle, skalowany poziomo', 'Podpowiedzi, walidacja, geokodowanie'],
  ],
));

children.push(SPACER());
children.push(LEAD('Dlaczego tydzień, a nie doba: ',
  'brak nagłówków umożliwiających tani sondaż (4.3) oznacza, że każde sprawdzenie to pełne ' +
  'pobranie 1,8 GB. Rejestr aktualizowany jest przez gminy na bieżąco, ale opublikowana ' +
  'paczka zmienia się rzadziej niż raz na dobę, więc cykl dobowy generowałby ruch bez ' +
  'przyrostu wartości. Do archiwum trafia wyłącznie zrzut, w którym wykryto zmianę treści — ' +
  'stąd szacunki pojemności w 7.3 liczone są dla zrzutów miesięcznych.'));

children.push(H2('5.2. Kluczowa decyzja: artefakt wyszukiwania'));
children.push(P(
  'Proces przetwarzania wytwarza pojedynczy, niezmienny plik indeksu wyszukiwania, ' +
  'oznaczony wersją danych. Instancje mikroserwisu pobierają go przy starcie i utrzymują ' +
  'w pamięci operacyjnej. Podpowiedzi adresowe nie wymagają zapytań do bazy danych.'));

children.push(P('Korzyści tego rozwiązania:'));
children.push(BULLET('Wycofanie zmiany sprowadza się do przestawienia wskaźnika wersji — do minuty od przestawienia, plus czas pobrania artefaktu, bez migracji danych.'));
children.push(BULLET('Skalowanie poziome jest trywialne — instancje nie współdzielą stanu danych.'));
children.push(BULLET('Wyniki są w pełni powtarzalne, co umożliwia automatyczne testy regresyjne jakości wyszukiwania.'));
children.push(BULLET('Baza danych nie jest obciążana ruchem podpowiedzi, który jest najintensywniejszy.'));

children.push(...box(
  'Dwa ograniczenia obecnej wersji',
  [
    'Podmiana artefaktu działa przez odpytywanie wskaźnika wersji co 60 sekund, a nie przez powiadomienie. Bez jawnie skonfigurowanego wskaźnika podmiana bez restartu instancji nie działa wcale.',
    'Sonda gotowości instancji odpytuje bazę danych, więc awaria bazy wyłącza instancję z ruchu również dla podpowiedzi, które bazy nie potrzebują. Rozdzielenie sond to 1 dzień pracy — pozycja w etapie komercjalizacji, rozdz. 10.',
  ],
  C.warn,
));

children.push(H2('5.3. Warstwa danych'));
children.push(P(
  'Tabela rozdziela stan zbudowany od elementów przewidzianych w architekturze docelowej. ' +
  'Rozróżnienie jest istotne przy planowaniu wdrożenia.'));

children.push(table(
  { head: ['Technologia', 'Zastosowanie', 'Stan'], widths: [1900, 4300, 2826] },
  [
    ['PostgreSQL + PostGIS', 'Źródło prawdy, numery budynków, geokodowanie odwrotne', 'Wdrożone — dane adresowe są ściśle relacyjne i przestrzenne'],
    ['Indeks w pamięci procesu', 'Podpowiedzi adresowe', 'Wdrożone — ok. 30× szybciej niż zapytanie do bazy z indeksem tekstowym'],
    ['Redis', 'Limitowanie zapytań współdzielone między instancjami, pamięć podręczna, powiadamianie o nowej wersji', 'NIEWDROŻONE — licznik limitera działa dziś w pamięci pojedynczej instancji, więc przy N replikach efektywny limit jest N-krotnie wyższy'],
    ['Magazyn obiektowy', 'Archiwum plików źródłowych i artefaktów indeksu poza maszyną roboczą', 'NIEWDROŻONE — usługa zadeklarowana w konfiguracji uruchomieniowej, ale nic z niej nie korzysta. Archiwum leży na dysku lokalnym'],
  ],
  { rowFill: (r) => String(r[2]).startsWith('NIEWDROŻONE') ? C.warn : C.ok },
));

children.push(SPACER());
children.push(LEAD('Rozwiązania świadomie odrzucone: ',
  'MongoDB (brak zastosowania — model danych jest relacyjny), kolejka komunikatów w pierwszej ' +
  'wersji (proces aktualizacji nie wymaga brokera), zewnętrzne silniki wyszukiwania takie jak ' +
  'Elasticsearch czy Meilisearch (dodają infrastrukturę do problemu rozwiązanego w pamięci procesu).'));

children.push(H2('5.4. Interfejs udostępniany aplikacjom'));
children.push(P(
  'Mikroserwis udostępnia interfejs REST. Poniższa tabela opisuje zakres funkcjonalny. ' +
  'Formalny kontrakt — specyfikacja OpenAPI z metodami, ścieżkami, parametrami i kodami ' +
  'odpowiedzi — jest przedmiotem osobnego zadania (rozdz. 10, 1,5 dnia). Do czasu jego ' +
  'wykonania zespoły integrujące powinny uzgadniać szczegóły z zespołem wdrożeniowym, ' +
  'a nie wyprowadzać ich z tej tabeli.'));

children.push(table(
  { head: ['Funkcja', 'Przeznaczenie', 'Źródło danych'], widths: [2700, 4100, 2226] },
  [
    ['Podpowiedzi uniwersalne', 'Pojedyncze pole „zacznij pisać adres” — miejscowości i ulice łącznie', 'Indeks w pamięci'],
    ['Podpowiedzi miejscowości', 'Pole „miejscowość”', 'Indeks w pamięci'],
    ['Podpowiedzi ulic', 'Pole „ulica”, zawężone do wybranej miejscowości', 'Indeks w pamięci'],
    ['Szczegóły miejscowości', 'Zwraca m.in. znacznik występowania ulic sterujący formularzem', 'Baza danych'],
    ['Numery budynków', 'Lista numerów na wybranej ulicy lub w miejscowości bez ulic', 'Baza danych'],
    ['Kod pocztowy', 'Kod dla konkretnego adresu; w razie braku — kod dominujący na ulicy z oznaczeniem', 'Baza danych'],
    ['Rozbiór adresu', 'Rozdzielenie ciągu tekstowego na pola, bez odpytywania rejestru', 'Reguły lokalne'],
    ['Walidacja adresu', 'Pełna weryfikacja z poziomem pewności i listą uwag', 'Indeks + baza'],
    ['Walidacja wsadowa (synchroniczna)', 'Do 1000 adresów przekazanych w treści żądania. Bez wysyłki pliku i bez kolejki — przetwarzanie sekwencyjne w jednym żądaniu HTTP', 'Indeks + baza'],
    ['Geokodowanie odwrotne', 'Najbliższy adres dla podanych współrzędnych', 'Baza danych'],
    ['Metadane zbioru', 'Wersja danych, data ostatniego zrzutu, ostrzeżenie o przeterminowaniu', 'Indeks + baza'],
  ],
));

children.push(SPACER());
children.push(P(
  'Poza przestrzenią /v1 serwis udostępnia cztery punkty operacyjne: sondę żywotności, ' +
  'sondę gotowości, 17 metryk w formacie Prometheusa oraz czytelny dla człowieka podgląd ' +
  'stanu z gotowymi ostrzeżeniami. Razem daje to 15 punktów końcowych.'));

children.push(...box(
  'Uwaga dla analityka: dwa liczniki wieku danych, ta sama liczba 30 dni',
  [
    'Funkcja metadanych zwraca ostrzeżenie, gdy najnowszy zrzut ma ponad 30 dni. Liczy jednak wiek ostatniego POBRANEGO pliku dowolnego źródła — pobranie słowników TERYT albo paczki odrzuconej potem przez kontrole jakości wygasza to ostrzeżenie, mimo że dane produkcyjne stoją.',
    'Do monitorowania należy użyć metryki wieku danych z punktu /metrics, która liczy wiek ostatniego OPUBLIKOWANEGO zrzutu PRG. To ona odpowiada scenariuszowi z czerwca 2024 roku.',
    'Wyrównanie obu mechanizmów jest pozycją w planie prac. Do tego czasu ostrzeżenie z funkcji metadanych należy traktować jako informację dla aplikacji, a nie jako sygnał operacyjny.',
  ],
  C.head,
));

children.push(H2('5.5. Bezpieczeństwo dostępu — stan obecny'));

children.push(...box(
  'Zamknięte 8.08.2026: możliwość obejścia limitowania zapytań',
  [
    'Do 8 sierpnia 2026 kluczem limitowania był nagłówek klucza API, z odwrotem na adres sieciowy klienta. Nagłówka nikt nie weryfikował, więc klient wysyłający przy każdym żądaniu losową wartość otrzymywał świeży licznik i całkowicie omijał limitowanie. Nie był to brak funkcji, lecz działający mechanizm obejścia.',
    'Limitowanie idzie teraz wyłącznie po adresie klienta. Zaufanie do nagłówków warstwy wejściowej jest domyślnie wyłączone i wymaga jawnej konfiguracji — inaczej klient mógłby podać własny adres, czyli własny klucz limitowania, i luka wróciłaby innymi drzwiami. Zachowanie zabezpiecza test regresji.',
    'Uwaga wdrożeniowa: przy pracy za warstwą wejściową trzeba tę konfigurację ustawić, bo bez niej cały ruch trafia do jednego kubełka i limit obejmuje całą instalację zamiast pojedynczego klienta.',
  ],
  C.ok,
));

children.push(...box(
  'Pozostaje otwarte: serwis nie uwierzytelnia klientów',
  [
    'W mikroserwisie nadal nie ma mechanizmu weryfikacji tożsamości klienta. Nagłówek klucza API nie jest z niczym porównywany i nie pełni już żadnej funkcji.',
    'Konsekwencja jest produktowa, nie tylko techniczna: bez zweryfikowanej tożsamości nie da się nadać klientom różnych limitów, rozliczyć ruchu ani odciąć pojedynczego odbiorcy. Wszyscy dzielą jeden limit liczony po adresie sieciowym.',
    'Dodatkowo liczniki limitera żyją w pamięci pojedynczej instancji, więc przy kilku replikach efektywny limit mnoży się przez ich liczbę, a polityka pochodzenia zapytań (CORS) domyślnie dopuszcza dowolne źródło.',
    'Wniosek pozostaje w mocy: do czasu wdrożenia kluczy API z licencjami serwis nie powinien być wystawiany poza sieć wewnętrzną Zamawiającego.',
  ],
  C.stop,
));

children.push(LEAD('Pełne rozwiązanie — 9–11 dni. ',
  'Klucze API z terminem ważności, limitami i licencjami, wraz z limitowaniem ' +
  'współdzielonym między instancjami, opisano w rozdziale 10 jako etap komercjalizacji. ' +
  'Dopiero wtedy kluczem limitowania może ponownie stać się tożsamość klienta — ' +
  'wyłącznie taka, która została wcześniej zweryfikowana.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ================= 6. MODEL DANYCH =================
children.push(H1('6. Model danych i reguły — dla analityka'));

children.push(H2('6.1. Encje'));
children.push(table(
  { head: ['Encja', 'Klucz główny', 'Opis', 'Liczność docelowa'], widths: [1700, 1500, 3900, 1926] },
  [
    ['Jednostka TERYT', 'TERC (7 znaków)', 'Województwo, powiat, gmina — hierarchia', 'ok. 3 tys.'],
    ['Miejscowość', 'SIMC (7 znaków)', 'Nazwa, rodzaj, gmina, centroid, znacznik występowania ulic', 'ok. 103 tys.'],
    ['Ulica', 'identyfikator wewnętrzny', 'Cecha, nazwa oficjalna, nazwa potoczna, powiązanie z miejscowością. Encja scala katalog TERYT z ulicami występującymi wyłącznie w PRG', 'ponad 385 tys. — rośnie wraz z przetwarzaniem kolejnych województw'],
    ['Punkt adresowy', 'identyfikator wewnętrzny', 'Numer budynku, kod pocztowy, współrzędne, status', 'ok. 8,56 mln'],
  ],
));

children.push(SPACER());
children.push(P('Trzy rozwiązania w modelu wymagają wyjaśnienia, ponieważ nie są oczywiste:'));

children.push(LEADB('Znacznik występowania ulic przy miejscowości. ',
  'Znacząca część adresów w Polsce to adresy wiejskie, gdzie numer porządkowy odnosi się bezpośrednio do miejscowości, a ulica nie istnieje. Znacznik pozwala interfejsowi ukryć pole ulicy zanim użytkownik je zobaczy. Bez niego mieszkaniec wsi widzi puste, wymagane pole „ulica”.'));
children.push(LEADB('Identyfikator z rejestru jako klucz obcy. ',
  'Umożliwia trwałe powiązanie rekordów między kolejnymi zrzutami. Bez niego każda aktualizacja wymagałaby zgadywania, który rekord odpowiada któremu.'));
children.push(LEADB('Znacznik wycofania zamiast usuwania rekordów. ',
  'Gminy popełniają błędy i je cofają. Punkt adresowy, który zniknął z rejestru, może wrócić za miesiąc, a w międzyczasie może występować w zamówieniu klienta.'));

children.push(H2('6.2. Zależności między polami'));
children.push(P(
  'Kotwicą adresu jest miejscowość, nie kod pocztowy. Jest to rozstrzygnięcie wbrew ' +
  'powszechnej intuicji i wbrew konstrukcji wielu formularzy.'));

children.push(...box(
  'Dlaczego kod pocztowy nie może być kluczem',
  [
    'Kod pocztowy nie odwzorowuje się jednoznacznie na gminę ani na miejscowość. Jeden kod może obejmować kilka gmin, a jedna ulica może mieć wiele kodów przypisanych do zakresów numerycznych.',
    'Kod pocztowy jest bardzo dobrą podpowiedzią zawężającą listę kandydatów i nieprawidłowym kluczem identyfikującym adres.',
    'Dodatkowo: kody pocztowe w rejestrze PRG pochodzą z ewidencji gminnych, nie od Poczty Polskiej. Rozbieżności są zjawiskiem normalnym i nie powinny blokować zapisu adresu.',
  ],
  C.head,
));

children.push(P('Kolejność wypełniania i reguły przejść:'));
children.push(table(
  { head: ['Zdarzenie', 'Reakcja systemu'], widths: [3600, 5426] },
  [
    ['Zmiana miejscowości', 'Czyszczenie ulicy, numeru i lokalu. Pole ulicy pokazane lub ukryte zależnie od znacznika występowania ulic'],
    ['Wpisanie kodu pocztowego przed miejscowością', 'Zawężenie listy miejscowości. Automatyczny wybór wyłącznie gdy kandydat jest dokładnie jeden'],
    ['Miejscowość bez ulic', 'Pole ulicy ukryte (nie zablokowane). Numer odnosi się do miejscowości'],
    ['Zmiana ulicy', 'Czyszczenie numeru i lokalu'],
    ['Wybór numeru z rejestru', 'Automatyczne uzupełnienie kodu pocztowego i współrzędnych. Poziom pewności: zweryfikowany wobec rejestru'],
    ['Numer spoza rejestru', 'Ostrzeżenie, nie błąd. Zapis dozwolony. Poziom pewności: zweryfikowany częściowo'],
    ['Ręczna zmiana kodu pocztowego wbrew wyliczonemu', 'Ostrzeżenie z obiema wartościami. Wygrywa wpis użytkownika'],
    ['Numer lokalu', 'Nigdy nie weryfikowany wobec rejestru — po 1.09.2026 rejestr nie zawiera tej informacji'],
  ],
));

children.push(SPACER());
children.push(H2('6.3. Poziomy pewności'));
children.push(P(
  'Każdy zwalidowany adres otrzymuje poziom pewności. Jest on zapisywany razem z adresem ' +
  'i stanowi podstawę późniejszych decyzji biznesowych.'));

children.push(table(
  { head: ['Poziom', 'Znaczenie', 'Sugerowane zastosowanie', 'Kto nadaje'], widths: [1900, 2700, 2400, 2026] },
  [
    ['Zweryfikowany wobec rejestru', 'Pełne dopasowanie, dostępny identyfikator rejestrowy i współrzędne', 'Wysyłka bez dodatkowej weryfikacji', 'Komponent adresowy'],
    ['Zweryfikowany częściowo', 'Miejscowość i ulica z rejestru, numer nie odnaleziony', 'Wysyłka z oznaczeniem do przeglądu', 'Komponent adresowy'],
    ['Poza rejestrem', 'Użytkownik świadomie potwierdził adres spoza bazy', 'Nowe budownictwo — dopuścić', 'Aplikacja konsumencka — patrz uwaga poniżej'],
    ['Nietypowy', 'Tryb ręczny: skrytka pocztowa, adres tymczasowy', 'Odrębna ścieżka obsługi', 'Aplikacja konsumencka; komponent przepuszcza tę wartość'],
    ['Niezweryfikowany', 'Import bez walidacji', 'Kolejka do przeglądu', 'Komponent adresowy'],
  ],
));

children.push(SPACER());
children.push(LEAD('Uwaga istotna dla projektowania reguł biznesowych: ',
  'poziom „poza rejestrem” jest przewidziany w modelu danych, ale komponent adresowy nigdy ' +
  'go sam nie nadaje. Adres z miejscowością i ulicą z rejestru oraz numerem, którego ' +
  'w rejestrze nie ma, otrzymuje poziom „zweryfikowany częściowo”. Poziom „poza rejestrem” ' +
  'ustawia aplikacja konsumencka po świadomym potwierdzeniu przez użytkownika. Reguła ' +
  'biznesowa oczekująca tej wartości z komponentu nigdy się nie uruchomi.'));

children.push(...box(
  'Zasada nadrzędna: walidacja nie blokuje zapisu adresu',
  [
    'Rejestr PRG zawiera punkty o statusie planowanym, nie nadąża za nowym budownictwem, a część gmin zasila go z opóźnieniem.',
    'Formularz informujący, że adres nie istnieje, osobę która właśnie się pod nim wprowadziła, jest wadą produktu, a nie błędem użytkownika.',
    'System klasyfikuje i ostrzega. Decyzję o ewentualnym zablokowaniu procesu podejmuje logika biznesowa aplikacji, nie komponent adresowy.',
  ],
  C.ok,
));

children.push(H2('6.4. Przypadki brzegowe wymagające uwagi analityka'));
children.push(table(
  { head: ['Przypadek', 'Opis', 'Rozwiązanie'], widths: [2200, 3800, 3026] },
  [
    ['Numer typu 12/14', 'Zapis dwuznaczny: może być numerem budynku narożnego albo zapisem „budynek 12, lokal 14”', 'System sprawdza w rejestrze obie interpretacje i przyjmuje tę, która istnieje. Gdy istnieją obie — patrz uwaga pod tabelą'],
    ['Miejscowości bez ulic', 'Numer odnosi się bezpośrednio do miejscowości', 'Pole ulicy opcjonalne, sterowane znacznikiem'],
    ['Duplikaty nazw miejscowości', 'Nazwy takie jak „Nowa Wieś” występują setki razy', 'Wymagane rozstrzygnięcie przez użytkownika — prezentacja gminy i powiatu'],
    ['Nazwy potoczne ulic', 'Użytkownik wpisuje „Kościuszki”, rejestr zawiera „Tadeusza Kościuszki”', 'Forma potoczna wyliczana automatycznie i indeksowana jako dodatkowy klucz'],
    ['Punkty planowane', 'Adres nadany, budynek jeszcze nie istnieje', 'Informacja zwrotna, nie blokada. Atrybut zamrożony przed 1.09.2026'],
    ['Skrytki pocztowe', 'Brak odpowiednika w rejestrze', 'Tryb adresu nietypowego'],
    ['Dzielnice w polu miejscowości', 'Zapis „Warszawa-Mokotów”', 'Traktowane jako pole pomocnicze, nie element klucza'],
  ],
));

children.push(SPACER());
children.push(LEAD('Doprecyzowanie zapisu 12/14: ',
  'gdy przy danej ulicy istnieje zarówno punkt „12”, jak i punkt „12/14” — sytuacja typowa ' +
  'w miastach z budynkami narożnymi — obecna implementacja wybiera odczyt „budynek 12, ' +
  'lokal 14”. Reguła docelowa daje pierwszeństwo numerowi budynku „12/14” i wymaga zamiany ' +
  'kolejności sprawdzania; jest to pozycja do wykonania. Zapisy z literą po lewej stronie ' +
  'ukośnika, jak „12A/5”, nie są traktowane jako dwuznaczne — zawsze czytane są jako ' +
  'budynek i lokal.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ================= 7. PROCES AKTUALIZACJI =================
children.push(H1('7. Proces aktualizacji danych'));

children.push(H2('7.1. Przebieg'));
children.push(NUM('Pobranie plików w podziale na województwa według harmonogramu tygodniowego, z wyliczeniem sumy kontrolnej. Tani sondaż nagłówków HTTP jest niemożliwy — patrz 4.3.'));
children.push(NUM('Porównanie sumy kontrolnej treści z ostatnim zrzutem — dalsze kroki wykonują się tylko przy wykrytej zmianie.'));
children.push(NUM('Zapis do własnego archiwum — plik źródłowy zachowywany bez zmian.'));
children.push(NUM('Przetworzenie strumieniowe i zasilenie obszaru przejściowego bazy danych.'));
children.push(NUM('Wykonanie kontroli jakości — porównanie obszaru przejściowego z danymi produkcyjnymi.'));
children.push(NUM('Publikacja transakcyjna — wyłącznie po przejściu wszystkich kontroli blokujących.'));
children.push(NUM('Zbudowanie nowego artefaktu indeksu i przestawienie wskaźnika wersji. Instancje mikroserwisu wykrywają zmianę, odpytując wskaźnik co 60 sekund.'));

children.push(H2('7.2. Kontrole jakości'));
children.push(P(
  'Zaimplementowano pięć kontroli. Każda z nich odpowiada realnemu, udokumentowanemu ' +
  'zdarzeniu, a nie hipotetycznemu zagrożeniu.'));

children.push(table(
  { head: ['Kontrola', 'Wykrywa', 'Poziom'], widths: [2400, 4826, 1800] },
  [
    ['Minimalna liczba rekordów', 'Zmianę formatu pliku lub niekompletny zrzut', 'Blokująca'],
    ['Wielkość zmiany', 'Błąd konwersji powodujący masową utratę lub duplikację danych', 'Blokująca'],
    ['Spadek w pojedynczej gminie', 'Wzorzec „zrzut bez miasta” — przypadek Wrocławia z 2016 r.', 'Blokująca'],
    ['Brak zmian w danych', 'Zamrożenie źródła — przypadek z czerwca 2024 r.', 'Ostrzeżenie'],
    ['Poprawność geometrii', 'Odwróconą kolejność osi współrzędnych i punkty poza granicami kraju', 'Blokująca przy punktach poza granicami kraju'],
  ],
));

children.push(SPACER());
children.push(LEAD('Kontrola blokująca wstrzymuje publikację i pozostawia poprzedni zrzut jako aktywny. ',
  'Przyjęta zasada: lepiej udostępniać dane sprzed tygodnia niż dane obejmujące połowę kraju. ' +
  'Obejście kontroli jest możliwe, ale wymaga jawnej decyzji operatora i pozostawia ślad ' +
  'w dzienniku zdarzeń.'));

children.push(LEAD('Progi przy publikacji z 9 sierpnia 2026. ',
  'Próg minimalnej liczby rekordów zadziałał w wartości domyślnej, przewidzianej dla ' +
  'produkcji — wcześniejsze publikacje częściowe wymagały jego obniżania, ta potrzeba znika ' +
  'wraz z pełnym zakresem. Jednorazowo podniesiono natomiast próg wielkości zmiany: wejście ' +
  'z 1,99 mln na 8,61 mln punktów to wzrost o 332%, wobec 2% przewidzianych dla cyklu ' +
  'tygodniowego. Jest to parametryzacja kontroli, nie jej wyłączenie, i obowiązuje wyłącznie ' +
  'dla przebiegu pierwszego załadunku.'));

children.push(...box(
  'Kontrola „spadek w pojedynczej gminie” wymagała naprawy, zanim zadziałała',
  [
    'Przy publikacji z 9 sierpnia 2026 kontrola ta wstrzymała podmianę fałszywie, raportując utratę wszystkich punktów w 20 gminach. Przyczyną było liczenie jej przed rozwiązaniem referencji do miejscowości — szczegóły w rozdziale 8.4.',
    'Znaczenie jest szersze niż jeden przebieg: w dotychczasowej postaci kontrola przechodziła wyłącznie na pustej bazie, czyli nie zabezpieczała żadnej aktualizacji. Po poprawce działa i przepuściła zbiór krajowy bez zastrzeżeń.',
  ],
  C.warn,
));

children.push(H2('7.3. Odporność na niedostępność źródła'));
children.push(table(
  { head: ['Poziom', 'Źródło', 'Warunek uruchomienia', 'Stan'], widths: [900, 2600, 3300, 2226] },
  [
    ['1', 'PRG (GUGiK)', 'Domyślny', 'Działa'],
    ['2', 'iMPA (Geo-System)', 'Niedostępność PRG powyżej 7 dni lub brak zmian powyżej 30 dni', 'Zaplanowany — wymaga wyjaśnienia licencji'],
    ['3', 'Otwarte dane miast', 'Uzupełnienie luk w dużych ośrodkach', 'Zaplanowany'],
    ['4', 'Własne archiwum plików źródłowych', 'Awaria wszystkich źródeł zewnętrznych', 'Częściowo — archiwum istnieje, ale nie opuszcza maszyny roboczej'],
  ],
  { rowFill: (r) => r[3] === 'Działa' ? C.ok : C.warn },
));

children.push(SPACER());
children.push(P(
  'Poziom czwarty ma istotne znaczenie dla ciągłości działania. Własne wersjonowane ' +
  'archiwum — około 1,8 GB na zrzut, wielkość zmierzona dla kompletu 16 województw, ' +
  'przy zrzutach miesięcznych ok. 22 GB rocznie — oznacza, że trwała niedostępność ' +
  'rejestru PRG powoduje degradację usługi do stanu „dane nie starsze niż ostatni zrzut”, ' +
  'a nie jej wyłączenie.'));

children.push(...box(
  'Zastrzeżenie: dziś działają dwa poziomy z czterech',
  [
    'Poziomy 2 i 3 są zaprojektowane, ale nie zbudowane. Faktyczne zabezpieczenie stanowią dziś rejestr PRG i własne archiwum.',
    'Archiwum jest przy tym pojedynczą kopią na dysku roboczym. Awaria tego dysku oznacza jednoczesną utratę poziomu 4 i — co ważniejsze — bezpowrotną utratę zrzutu w strukturze sprzed 1 września 2026, którego po tej dacie nie da się odtworzyć z żadnego źródła.',
    'Wyniesienie archiwum do magazynu poza maszyną jest z tego powodu pozycją o wyższym priorytecie niż wynikałoby to z jej nakładu.',
  ],
  C.stop,
));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ================= 8. WYNIKI WERYFIKACJI =================
children.push(H1('8. Wyniki weryfikacji'));

children.push(H2('8.1. Test integracyjny'));
children.push(P(
  'Całą ścieżkę przetestowano na działającej instancji PostgreSQL 17.5 z PostGIS 3.5, ' +
  'dla obu struktur danych źródłowych — dotychczasowej i obowiązującej od września.'));

children.push(table(
  { head: ['Etap', 'Wynik'], widths: [2800, 6226] },
  [
    ['Rozpoznanie struktury pliku', 'Struktura i przestrzeń nazw wykryte automatycznie'],
    ['Przetworzenie, struktura nowa', 'Współrzędne przeliczone poprawnie z układu PL-1992 na WGS84'],
    ['Przetworzenie, struktura dotychczasowa', 'Identyczne współrzędne; rekordy oznaczone jako brak numeru odrzucone'],
    ['Kontrole jakości', 'Poprawnie wstrzymały publikację przy liczbie rekordów poniżej progu'],
    ['Publikacja', 'Wykonana transakcyjnie, z raportem zmian'],
    ['Pola pochodne', 'Znacznik występowania ulic, liczba punktów i nazwa potoczna wyliczone poprawnie'],
    ['Walidacja adresu', 'Zapis „ul. Kościuszki 12A, 00-950 Warszawa” rozpoznany jako „Tadeusza Kościuszki” wraz z identyfikatorami rejestrowymi, kodem gminy i współrzędnymi'],
    ['Numer spoza rejestru', 'Poziom pewności obniżony, zwrócone ostrzeżenie zamiast błędu'],
  ],
));

children.push(SPACER());
children.push(H2('8.2. Wydajność wyszukiwania — pomiar wstępny na zbiorze syntetycznym'));
children.push(P(
  'Pomiary z tego podrozdziału wykonano przed uruchomieniem na danych rzeczywistych, ' +
  'na zbiorze syntetycznym o zbliżonej liczebności: 103 tys. miejscowości i 270 tys. ulic, ' +
  'łącznie 373 tys. pozycji. Jak się później okazało, rozkład powtarzalności nazw w tym ' +
  'zbiorze odbiegał od rzeczywistego — dlatego wyniki bezwzględne zostały zastąpione ' +
  'pomiarami z podrozdziału 8.6. Zachowujemy je, ponieważ porównanie podejść pozostaje ważne.'));

children.push(table(
  { head: ['Podejście', 'Mediana czasu odpowiedzi', 'Ocena przydatności'], widths: [4000, 2500, 2526] },
  [
    ['Zapytanie do bazy z sortowaniem po podobieństwie tekstowym', '4 922 ms', 'Nie nadaje się'],
    ['Zapytanie do bazy z indeksem tekstowym, fraza 14 znaków', '117 ms', 'Koszt rośnie z długością zapytania'],
    ['Indeks w pamięci procesu (rozwiązanie przyjęte)', '0,49 ms', 'Przyjęte'],
    ['Pobranie numerów budynków z bazy po wyborze ulicy', '0,22 ms', 'Przyjęte'],
  ],
));

children.push(SPACER());
children.push(table(
  { head: ['Parametr', 'Zbiór syntetyczny', 'Dane rzeczywiste (8.3, 8.6)'], widths: [3200, 2900, 2926] },
  [
    ['Mediana czasu odpowiedzi', '0,49 ms', 'ok. 4 ms'],
    ['95. percentyl', '1,11 ms', 'nie przeliczono'],
    ['99. percentyl', '1,84 ms', 'nie przeliczono'],
    ['Rozmiar artefaktu indeksu', '53 MB', '66,4 MB'],
    ['Liczba pozycji w indeksie', '373 tys.', '487 301'],
    ['Czas budowy artefaktu', '12 s', '3,5 min'],
    ['Odporność na literówki', 'Zapytanie „mickievicza” zwraca „Mickiewicza”', 'Zachowana, koszt 27 ms'],
  ],
));

children.push(SPACER());
children.push(LEAD('Wniosek metodyczny: ',
  'o wydajności decyduje nie wybrana technologia, lecz liczba kandydatów, których zapytanie ' +
  'musi uszeregować. Dlatego indeksowane są miejscowości i ulice, a numery budynków pobierane ' +
  'są z bazy dopiero po wyborze ulicy, gdy jest ich od kilkudziesięciu do kilkuset. Rozwinięcie ' +
  'tej obserwacji na danych rzeczywistych znajduje się w 8.6.'));

children.push(H2('8.3. Uruchomienie na pełnym zbiorze krajowym'));
children.push(P(
  'Wyniki wydań 1.0–1.1 pochodziły z próbek i zbiorów syntetycznych, wydania 1.2–1.3 ' +
  'z czterech województw. 9 sierpnia 2026 cała ścieżka przeszła na komplecie danych ' +
  'krajowych — wszystkie 16 województw w jednej publikacji.'));

children.push(table(
  { head: ['Element', 'Wynik', 'Wydanie 1.3 (4 województwa)'], widths: [2600, 3400, 3026] },
  [
    ['Punkty adresowe opublikowane', '8 605 682', '1 990 483'],
    ['Punkty z przypisaną ulicą', '5 532 383 (64,3%)', '1 324 563'],
    ['Punkty z kodem pocztowym', '8 604 962 (99,99%)', '—'],
    ['Miejscowości w słowniku', '101 883', '101 865'],
    ['Ulice w katalogu', '689 328', '385 436'],
    ['Artefakt wyszukiwania', '791 211 pozycji, 109,3 MB', '487 301 pozycji, 66,4 MB'],
    ['Rozmiar bazy danych', '12 GB', '3 GB'],
    ['Zakres', '16 województw z 16 — cały kraj', '4 z 16, ok. 23% kraju'],
  ],
));

children.push(SPACER());
children.push(LEAD('Zgodność z zapowiedzią rejestru. ',
  'Rejestr PRG podaje 8 560 617 punktów według stanu na 31 marca 2026. Opublikowany zbiór ' +
  'liczy 8 605 682, czyli o 45 tys. więcej — różnica odpowiada przyrostowi za cztery ' +
  'miesiące i potwierdza kompletność zrzutu z 6 sierpnia.'));

children.push(LEAD('Wiszące referencje w źródle. ',
  'Z 8 605 908 punktów w obszarze przejściowym 226 (0,003%) miało odwołanie do miejscowości, ' +
  'której nie ma w tym samym pliku wojewódzkim. Skupiają się w czterech województwach, ' +
  'najwięcej w lubelskim. Punkty te nie trafiły do zbioru produktowego. Jest to wada danych ' +
  'źródłowych, nie przetwarzania.'));

children.push(LEAD('Zabezpieczenie zrzutu. ',
  'Pobrano komplet 16 województw (1,8 GB) z sumą kontrolną każdego pliku. Realizuje to ' +
  'decyzję o archiwizacji przed 1 września 2026. Sierpniowa paczka zawiera równolegle plik ' +
  'w strukturze dotychczasowej i nowej, więc zabezpieczono obie — łącznie z atrybutami, ' +
  'które po tej dacie znikną.'));

children.push(LEAD('Słowniki TERYT pobrano bez konta w GUS. ',
  'Usługa sieciowa nie odpowiadała na żadne zapytanie, ale te same katalogi są udostępniane ' +
  'jako pliki bez rejestracji. Pozycja „Import słowników TERYT” z planu prac jest zamknięta, ' +
  'a zależność od rejestracji w GUS — nieaktualna.'));

children.push(...box(
  'Najważniejszy wynik dla oceny ryzyka',
  [
    'Parser przeszedł przez rzeczywisty plik w strukturze obowiązującej od 1 września 2026 i nie odrzucił ani jednego rekordu. Wrześniowa zmiana formatu — dotąd największe ryzyko w tym opracowaniu — jest potwierdzona jako opanowana na danych, a nie tylko deklarowana.',
    'Publikacja całego kraju przeszła kontrole jakości przy progu minimalnej liczby rekordów ustawionym na wartość domyślną, czyli tę przewidzianą dla produkcji. Wcześniejsze publikacje częściowe wymagały jego obniżania; ta potrzeba znika wraz z pełnym zakresem danych.',
    'Jednorazowo podniesiono natomiast próg kontroli wielkości zmiany. Przejście z 1,99 mln na 8,61 mln punktów to wzrost o 332%, wobec domyślnych 2% przewidzianych dla cyklu tygodniowego. Przy kolejnym przebiegu próg wraca do wartości domyślnej — patrz 7.2.',
  ],
  C.ok,
));

children.push(H2('8.4. Usterki wykryte na danych rzeczywistych'));
children.push(P(
  'Osiem usterek ujawniło się dopiero na danych rzeczywistych — pięć przy pierwszym ' +
  'uruchomieniu na czterech województwach, trzy kolejne przy przejściu na pełny kraj. ' +
  'Wszystkie naprawiono. Podział jest istotny dla planowania: druga grupa była niewykrywalna ' +
  'przy zakresie częściowym.'));

children.push(H3('Wykryte przy pierwszym uruchomieniu (4 województwa)'));

children.push(table(
  { head: ['Usterka', 'Skutek przed naprawą'], widths: [4200, 4826] },
  [
    ['Dekodowanie porcji strumienia osobno rozcinało polskie znaki', 'Uszkodzone nazwy ulic — jedna na województwo, bez ostrzeżenia'],
    ['Błędne wiązanie punktów z miejscowościami w nowej strukturze', 'Publikacja przerywana; przy szerszej kolumnie — ciche śmieci zamiast identyfikatorów'],
    ['Zdublowane pozycje w słownikach źródłowych', 'Jeden zdublowany rekord wstrzymywał publikację całego kraju'],
    ['Zapytanie wiążące punkty z ulicami bez możliwości użycia indeksu', 'Ponad 100 mld porównań — przebieg przerwany po 8 godzinach bez wyniku'],
    ['Słowniki TERYT wstawiane rekord po rekordzie', 'Ponad 20 minut i zerwane połączenie; po zmianie — 8 minut'],
  ],
));

children.push(SPACER());
children.push(H3('Wykryte przy przejściu na pełny kraj (16 województw)'));
children.push(table(
  { head: ['Usterka', 'Skutek przed naprawą'], widths: [4200, 4826] },
  [
    ['Kontrola „spadek w gminie” liczona przed rozwiązaniem referencji do miejscowości', 'Kontrola blokująca nie działała nigdy poza pustą bazą i przy każdej kolejnej publikacji dawała fałszywe wstrzymanie — patrz ramka poniżej'],
    ['Pamięć dzielona kontenera bazy ograniczona do domyślnych 64 MB', 'Przy 8,6 mln wierszy planer wchodzi w tryb równoległy i przebieg przerywa się komunikatem o braku miejsca, niezwiązanym z dyskiem'],
    ['Rozwiązywanie referencji wykonywane poza oknem ładowania masowego', 'Aktualizacja 8,6 mln wierszy przy trzech nałożonych indeksach: 49 minut zamiast kilku i trzydziestokrotne wzmocnienie zapisu'],
  ],
));

children.push(SPACER());
children.push(...box(
  'Kontrola jakości, która nigdy nie zadziałała',
  [
    'Najpoważniejsza z trzech nowych usterek nie powodowała błędnych danych — powodowała fałszywe poczucie zabezpieczenia.',
    'Kontrola „spadek w pojedynczej gminie” pilnuje wzorca „zrzut bez miasta”, czyli incydentu z Wrocławiem z 2016 roku, i jest jednym z dwóch uzasadnień dla całego zestawu kontroli. Łączy dane przejściowe ze słownikiem miejscowości po identyfikatorze, który jednak wypełniany był dopiero wewnątrz publikacji — czyli już po kontrolach. W chwili liczenia identyfikator był pusty dla wszystkich rekordów.',
    'Przy pierwszej publikacji baza była pusta, więc kontrola nie miała czego porównywać i przechodziła. Przy drugiej — 20 gmin z Warszawą na czele „straciło” komplet punktów, które w rzeczywistości były na miejscu.',
    'W produkcji oznaczałoby to jedno z dwojga: albo wstrzymanie każdej aktualizacji, albo — po obejściu kontroli przez operatora zmęczonego fałszywymi alarmami — brak ochrony przed rzeczywistym niekompletnym zrzutem.',
  ],
  C.stop,
));

children.push(...box(
  'Wniosek metodyczny',
  [
    'Żadnej z ośmiu usterek nie dało się wykryć na danych testowych. Wykrywalność zależy przy tym od etapu: pięć pierwszych ujawnia sama skala, trzy kolejne wymagały pełnego zakresu danych albo drugiej publikacji na niepustej bazie.',
    'To ostatnie jest najważniejsze dla harmonogramu. Pierwsze uruchomienie zawsze odbywa się na pustej bazie, więc cała klasa błędów porównania „stan poprzedni wobec nowego” pozostaje wtedy niewidoczna. Plan wdrożenia musi przewidywać co najmniej dwie pełne publikacje pod obserwacją, nie jedną.',
    'Wnioskiem z wydania 1.3 było „przebieg na komplecie 16 województw przed produkcją”. Wydanie 1.4 go zaostrza: dwa przebiegi, drugi na danych już opublikowanych.',
  ],
  C.head,
));

children.push(H2('8.5. Wydajność przetwarzania'));
children.push(P(
  'Pomiary na komputerze przenośnym: 8 rdzeni, przetwarzanie w kontenerach, archiwum ' +
  'na dysku hosta. Na serwerze wyniki będą lepsze, proporcje pozostaną.'));

children.push(P('Zmierzony przebieg dla całego kraju, 9 sierpnia 2026:'));

children.push(table(
  { head: ['Etap', 'Czas', 'Uwagi'], widths: [3000, 1800, 4226] },
  [
    ['Pobranie z archiwum', '—', 'Pliki na dysku, bez pobierania z sieci'],
    ['Ładowanie 16 województw', '~17 minut', 'Cztery procesy równolegle, 8 605 908 punktów'],
    ['Rozwiązanie referencji', '~49 minut', 'Do naprawy — patrz uwaga poniżej'],
    ['Kontrole jakości', '~2 minuty', 'Pięć kontroli na pełnym zbiorze'],
    ['Publikacja transakcyjna', '2 godz. 16 minut', 'Dodane 6 615 199 punktów, wycofane 0'],
    ['Budowa artefaktu wyszukiwania', '55 sekund', '791 211 pozycji, 109,3 MB'],
    ['RAZEM', 'ok. 3 godz. 25 minut', 'Komputer przenośny, 8 rdzeni, przetwarzanie w kontenerach'],
  ],
  { rowFill: (r) => r[0] === 'RAZEM' ? C.head : undefined },
));

children.push(SPACER());
children.push(LEAD('Ładowanie okazało się znacznie szybsze od zakładanego. ',
  'Wydania 1.2–1.3 podawały ~38 minut na jedno województwo i ~4 godziny na kraj przy jednym ' +
  'procesie. Zmierzony przebieg to 17 minut na komplet 16 województw przy czterech procesach. ' +
  'Część różnicy tłumaczy zrównoleglenie, ale nie całą — poprzedni pomiar powstał w trakcie ' +
  'sesji, w której naprawiano jeszcze błędy wydajnościowe, i należy go uznać za nieaktualny.'));

children.push(...box(
  'Gdzie naprawdę uchodzi czas: dwie pełne aktualizacje obszaru przejściowego',
  [
    'Ładowanie danych zajmuje 17 minut, ale cały przebieg — ponad trzy godziny. Różnicę pochłaniają dwie operacje aktualizujące wszystkie 8,6 mln wierszy naraz, każda przy trzech nałożonych indeksach, czyli po ponad 25 mln operacji na indeksach.',
    'Pierwsza to rozwiązanie referencji do miejscowości (49 minut). Wypada tuż po odtworzeniu indeksów, choć mogłaby wykonać się chwilę wcześniej, gdy indeksów jeszcze nie ma — poprawka jest przygotowana.',
    'Druga to wiązanie punktów z ulicami wewnątrz transakcji publikującej. Tam przenieść jej nie można i wymaga osobnego podejścia.',
    'Skala zjawiska: kontener bazy zaraportował 303 GB zapisów przy zbiorze ważącym 12 GB. Jest to wzmocnienie zapisu rzędu dwudziestopięciokrotnego i to ono, a nie parsowanie, wyznacza dziś czas pełnego cyklu.',
  ],
  C.warn,
));

children.push(LEAD('Kosztem zrównoleglenia jest pamięć: ',
  'około 400 MB na proces. Liczbę procesów dobiera się do pamięci dostępnej dla zadania, ' +
  'nie do liczby rdzeni.'));

children.push(H2('8.6. Czasy odpowiedzi na pełnym kraju'));
children.push(P(
  'Pomiar powtórzono na komplecie danych krajowych — 791 211 pozycji w indeksie wobec ' +
  '487 301 w wydaniu 1.3. Zastosowano dwie metody, ponieważ dają istotnie różne liczby ' +
  'i każda odpowiada na inne pytanie. Każde zapytanie wykonano wielokrotnie po rozgrzewce, ' +
  'a podane wartości to mediany i percentyle z serii pomiarów.'));

children.push(table(
  { head: ['Zapytanie', 'Rodzaj', 'Silnik — mediana', 'HTTP — mediana'], widths: [1900, 2500, 2300, 2326] },
  [
    ['grojecka', 'nazwa jednoznaczna', '0,27 ms', '0,93 ms'],
    ['pulawska', 'nazwa jednoznaczna', '0,50 ms', '0,75 ms'],
    ['polna', 'nazwa częsta', '0,60 ms', '1,10 ms'],
    ['3 maja', 'nazwa częsta', '1,30 ms', '2,10 ms'],
    ['krakowska', 'nazwa częsta', '0,58 ms', '1,41 ms'],
    ['kosciuszki', 'nazwa patronacka', '0,87 ms', '2,55 ms'],
    ['mickievicza', 'zapytanie z literówką', '1,55 ms', '3,54 ms'],
    ['nowa wies', 'nazwa masowo powtarzalna', '0,96 ms', '1,55 ms'],
  ],
));

children.push(SPACER());
children.push(table(
  { head: ['Metoda pomiaru', 'Mediana', '95. percentyl', '99. percentyl'], widths: [3600, 1800, 1800, 1826] },
  [
    ['Silnik wyszukiwania bezpośrednio', '0,81 ms', '4,63 ms', '9,38 ms'],
    ['Pełna ścieżka HTTP mikroserwisu', '1,71 ms', '9,41 ms', '27,94 ms'],
  ],
  { boldFirst: true },
));

children.push(SPACER());
children.push(LEAD('Która liczba jest właściwa: ',
  'dla oceny produktu — ta z wiersza HTTP, bo tyle czeka aplikacja kliencka. Pomiar samego ' +
  'silnika pokazuje natomiast, że ok. 0,9 ms z każdego zapytania zabiera obsługa żądania ' +
  'i złożenie odpowiedzi, nie wyszukiwanie. Przy dalszym strojeniu to tam, a nie w indeksie, ' +
  'jest dziś więcej do zyskania.'));

children.push(...box(
  'Wyniki są lepsze niż w wydaniu 1.3, mimo dwukrotnie większego zbioru — dlaczego',
  [
    'Wydania 1.2–1.3 podawały medianę ok. 4 ms i najgorszy przypadek 42 ms dla nazwy „Nowa Wieś”, na zbiorze mniejszym o połowę. Pomiar na pełnym kraju daje medianę 1,71 ms, a „Nowa Wieś” wypada w środku stawki z wynikiem 1,55 ms.',
    'Wyjaśnieniem jest metodyka, nie poprawa silnika. Zmierzone tu pierwsze wywołanie po starcie procesu, bez rozgrzewki, daje 82 ms dla pierwszego zapytania i kilkadziesiąt milisekund dla kolejnych — czyli dokładnie ten rząd wielkości, który wydania 1.2–1.3 podawały jako koszt „nazw pospolitych”.',
    'Oznacza to, że wcześniejsze liczby mierzyły w znacznej części rozgrzewkę maszyny wykonującej kod, a nie koszt uszeregowania kandydatów. Teza z wydania 1.3, że o czasie decyduje liczba kandydatów, jest w świetle tego pomiaru co najmniej niepełna: przy dwukrotnie większym zbiorze i tych samych zapytaniach czasy spadły.',
    'Praktyczny wniosek jest inny niż dotychczasowy: budżet czasu odpowiedzi trzeba przewidzieć nie pod nazwy pospolite, lecz pod pierwsze zapytania po starcie instancji. Uzasadnia to rozgrzewanie instancji przed skierowaniem na nią ruchu — pozycja do dopisania do prac nad skalowaniem poziomym.',
  ],
  C.head,
));

children.push(LEAD('Zużycie pamięci: ',
  'proces mikroserwisu z wczytanym artefaktem 109,3 MB zajmuje 239 MB pamięci operacyjnej. ' +
  'Wydanie 1.0 szacowało 485 MB przy artefakcie 53 MB — rzeczywiste zużycie jest więc ' +
  'dwukrotnie niższe przy dwukrotnie większym artefakcie.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ================= 9. WARIANTY =================
children.push(H1('9. Warianty rozwiązania'));
children.push(P(
  'Poniżej porównano trzy możliwe podejścia. Wariant A jest realizowany i opisany ' +
  'w poprzednich rozdziałach.'));

children.push(H2('9.1. Porównanie'));
children.push(table(
  { head: ['Kryterium', 'A. Własna baza', 'B. Hybryda', 'C. Zewnętrzne API'], widths: [2000, 2542, 2242, 2242] },
  [
    ['Nakład wdrożeniowy', 'Wysoki (11–15 tygodni do produkcji, rdzeń już zbudowany)', 'Średni', 'Niski (kilka dni)'],
    ['Koszt bieżący', 'Infrastruktura + utrzymanie', 'Infrastruktura + opłaty za część ruchu', 'Opłata rosnąca liniowo z ruchem'],
    ['Uzależnienie od dostawcy', 'Brak', 'Częściowe', 'Pełne'],
    ['Dane osobowe poza organizacją', 'Nie', 'Dla części zapytań', 'Tak'],
    ['Czas odpowiedzi', 'ok. 4 ms (mediana), do 42 ms dla nazw masowo powtarzalnych — patrz 8.6', 'ok. 4 ms lokalnie / opóźnienie sieci dla ruchu kierowanego na zewnątrz', 'Opóźnienie sieci'],
    ['Identyfikatory rejestrowe', 'Tak', 'Tak', 'Zwykle nie'],
    ['Odporność na awarię źródła', 'Cztery poziomy w projekcie, dwa uruchomione — patrz 7.3', 'Dwa źródła', 'Usługa działa nadal, ale dane dostawcy też pochodzą z PRG i przestaną się aktualizować — patrz 3.2'],
    ['Utrzymanie', 'Konieczne, po stronie Zamawiającego', 'Konieczne', 'Po stronie dostawcy'],
  ],
  { boldFirst: true },
));

children.push(SPACER());
children.push(H2('9.2. Charakterystyka wariantów'));

children.push(H3('Wariant A — własna baza (rekomendowany)'));
children.push(P(
  'Pełna kontrola nad danymi i wynikami. Koszt danych zerowy, koszt wyłącznie po stronie ' +
  'infrastruktury i utrzymania. Wymaga stałej obserwacji komunikatów instytucji prowadzącej ' +
  'rejestr — zmiana formatu z 1 września 2026 jest tego przykładem. Zapewnia identyfikatory ' +
  'rejestrowe umożliwiające trwałe powiązanie danych między aktualizacjami.'));

children.push(H3('Wariant B — hybryda'));
children.push(P(
  'Własna baza obsługuje ruch podstawowy, a zapytania niedopasowane kierowane są do ' +
  'zewnętrznego dostawcy. Sensowne jako uzupełnienie wariantu A, gdy istotna jest ' +
  'skuteczność automatycznej korekty danych wprowadzanych ręcznie. Wymaga świadomej decyzji ' +
  'dotyczącej przekazywania danych osobowych poza infrastrukturę Zamawiającego oraz ' +
  'odpowiednich zapisów w rejestrze czynności przetwarzania.'));

children.push(H3('Wariant C — wyłącznie zewnętrzne API'));
children.push(P(
  'Najszybszy we wdrożeniu. Koszt rośnie liniowo z ruchem, a organizacja nie ma wpływu ' +
  'na cennik ani na dostępność usługi. Nie zapewnia identyfikatorów rejestrowych, co ' +
  'utrudnia utrzymanie spójności danych historycznych. W analizie rynku napotkano również ' +
  'dostawców, których wiarygodności nie udało się potwierdzić — rekomendujemy weryfikację ' +
  'danych rejestrowych operatora przed podpisaniem umowy.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ================= 10. PLAN =================
children.push(H1('10. Plan dalszych prac'));

children.push(P(
  'Plan przepisano w wydaniu 1.3. Poprzednia wersja wyceniała pracę już wykonaną ' +
  'i pomijała obszary ujawnione podczas uruchomienia na danych rzeczywistych. ' +
  'Nakłady podano w dniach roboczych jednej osoby.'));

children.push(H2('10.1. Pozycje zamknięte'));
children.push(table(
  { head: ['Pozycja z poprzednich wydań', 'Stan'], widths: [4000, 5026] },
  [
    ['Archiwizacja danych w dotychczasowej strukturze', 'WYKONANE 6.08.2026 — komplet 16 województw, 1,8 GB, sumy kontrolne'],
    ['Weryfikacja nowej struktury danych', 'WYKONANE 6.08.2026 — rozpoznanie i odwzorowanie pól potwierdzone na rzeczywistym pliku, zero odrzuconych rekordów'],
    ['Import słowników TERYT', 'WYKONANE 6.08.2026 — pliki pełne, bez konta w GUS. Zależność od rejestracji w GUS nieaktualna'],
    ['Uruchomienie na pełnym zbiorze krajowym', 'WYKONANE 9.08.2026 — 16 województw, 8 605 682 punkty, artefakt 109,3 MB'],
    ['Zamknięcie luki w limitowaniu zapytań', 'WYKONANE 8.08.2026 — limitowanie po adresie klienta, test regresji'],
  ],
  { rowFill: () => C.ok },
));

children.push(SPACER());
children.push(H2('10.2. Etapy do wykonania'));
children.push(table(
  { head: ['Etap', 'Zakres', 'Nakład'], widths: [2500, 4926, 1600] },
  [
    ['1. Dokończenie bazy produkcyjnej', 'Publikacja pełnego kraju i pomiary na komplecie danych — WYKONANE 9.08.2026. Pozostaje archiwum poza maszyną oraz kopie zapasowe bazy z testem odtworzenia', '2–3 dni'],
    ['2. Wydajność i przetwarzanie równoległe', 'Raportowanie postępu, wznawianie przerwanych przebiegów, limit czasu i wykrywanie zawieszenia, strojenie bazy pod ładowanie masowe, testy regresji wydajności', '6–8 dni'],
    ['3. Podział na dwa serwisy', 'Rozdzielenie ról w bazie, osobne potoki budowania, kontrakt między serwisami, test skalowania poziomego', '3–5 dni'],
    ['4. Wersjonowanie wydań', 'Rejestr wydań, wersja danych w każdej odpowiedzi, procedura wycofania, wydanie kanarkowe, przypięcie klienta do wersji', '4–5 dni'],
    ['5. Audyt zmian i kontrola nadpisywania', 'Dziennik zmian rekordów, raport różnic między wydaniami, jawne reguły precedencji źródeł, ochrona zmian ręcznych przed nadpisaniem przez automat', '5–7 dni'],
    ['6. Braki blokujące wdrożenie', 'Specyfikacja OpenAPI, retencja i anonimizacja logów zapytań, rejestr czynności przetwarzania, zbiór wzorcowy i testy regresji jakości wyszukiwania, cele dostępności, procedura przy awarii źródła', '8–10 dni'],
    ['7. Monitorowanie i obserwowalność', 'Odbiorca metryk i alertów, pulpit operacyjny, alerty dla usługi, sonda syntetyczna, centralne logi, zasady eskalacji', '6–8 dni'],
    ['8. Komercjalizacja', 'Klucze API z licencjami i limitami per klient, model wielodostępności, kopie zapasowe na osobną maszynę z cotygodniowym testem odtworzenia', '18–24 dni'],
    ['Narzędzie do migracji bazy (poza etapami)', 'Wersjonowanie schematu z rejestrem zastosowanych migracji', '1,5 dnia'],
  ],
));

children.push(SPACER());
children.push(P(
  'Łącznie 55–73 dni roboczych, czyli około 11–15 tygodni pracy jednej osoby na sam ' +
  'back-end. Panel administracyjny i interfejs użytkownika doliczane osobno.'));

children.push(...box(
  'Co można odłożyć, a czego nie',
  [
    'Etap 8 w całości dotyczy komercjalizacji. Jeśli nie jest ona celem pierwszego wdrożenia, można go odłożyć — jedyna pozycja pilna niezależnie od tej decyzji, zamknięcie luki w limitowaniu zapytań, została wykonana 8.08.2026 (rozdz. 5.5).',
    'Etapy 4 i 5 muszą poprzedzać prace nad panelem administracyjnym — bez rejestru wydań i dziennika zmian nie ma czym zarządzać.',
    'Z etapu 7 warto wykonać wcześnie dwie pierwsze pozycje (odbiorca metryk i pulpit operacyjny, ok. 3 dni). Zaczynają się zwracać już w trakcie etapów 1 i 2, bo dziś przebieg przetwarzania jest nieprzejrzysty.',
    'Etap 2 przed etapem 3, żeby nie przenosić problemów wydajnościowych do nowej struktury.',
  ],
  C.head,
));

children.push(H2('10.3. Zagadnienia otwarte'));
children.push(P(
  'Poniższe kwestie wymagają potwierdzenia empirycznego lub decyzji poza zespołem ' +
  'wdrożeniowym. Żadna nie zagraża przyjętej architekturze.'));

children.push(LEADB('ROZSTRZYGNIĘTE 6.08.2026: ',
  'serwer nie zwraca ani ETag, ani Last-Modified dla żadnego z 16 województw. Tani sondaż jest niemożliwy — obowiązuje harmonogram tygodniowy i porównywanie sumy kontrolnej pobranego pliku. Mechanizm jest już wbudowany.'));
children.push(LEADB('ROZSTRZYGNIĘTE 6.08.2026: ',
  'nowa struktura zachowuje wersjonowanie obiektów, więc wykrywanie zmian może opierać się na wersjach, a nie wyłącznie na sumach kontrolnych.'));
children.push(LEADB('CZĘŚCIOWO ROZSTRZYGNIĘTE 6.08.2026: ',
  'pliki w nowej strukturze z paczki sierpniowej zostały pobrane i przetworzone, więc nazewnictwo jest znane empirycznie. Pozostaje potwierdzenie, że nie zmieni się po wycofaniu struktury dotychczasowej 1 września.'));
children.push(LEADB('OTWARTE: ',
  'warunki licencyjne źródła iMPA — wymagane wystąpienie pisemne do podmiotu prowadzącego. Blokuje poziom 2 odporności na awarię źródła.'));
children.push(LEADB('OTWARTE: ',
  'czy mikroserwis ma zachować połączenie z bazą danych. Dziś potrzebuje go do numerów budynków, kodów pocztowych i geokodowania odwrotnego. Włączenie tych danych do artefaktu uniezależniłoby go całkowicie, ale powiększa artefakt i wydłuża budowę — wymaga oszacowania w etapie 3.'));

children.push(H2('10.4. Rozstrzygnięcia technologiczne'));
children.push(table(
  { head: ['Pytanie', 'Rozstrzygnięcie', 'Uzasadnienie'], widths: [2000, 2600, 4426] },
  [
    ['Framework serwisu danych', 'Zostaje Fastify', 'Serwis to 11 punktów końcowych bezstanowych, w których liczy się czas odpowiedzi. Projekt działa bez kroku kompilacji; przejście na framework oparty na dekoratorach odwróciłoby tę decyzję bez zysku'],
    ['Framework serwisu administracyjnego', 'Kandydat: NestJS', 'Autoryzacja, role, walidacja wejścia i generowanie kontraktu przydają się tam, gdzie jest ich dużo, a ruch administracyjny jest znikomy, więc narzut nie ma znaczenia'],
    ['Mapowanie obiektowo-relacyjne (ORM)', 'Nie w przetwarzaniu i w serwisie danych', 'Przetwarzanie opiera się na ładowaniu masowym, a zapytania serwisu są strojone pod konkretne indeksy, w tym przestrzenne. Ewentualnie w części administracyjnej — wtedy narzędzie leżące blisko SQL'],
    ['Wersjonowanie schematu bazy', 'Wymagane, dziś brak', 'Migracje wykonują się wyłącznie przy inicjalizacji kontenera bazy, a poprawki trzeba wgrywać ręcznie. Jest to kruche i wpływa na procedurę odtwarzania z kopii zapasowej'],
  ],
));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ================= 11. DECYZJE =================
children.push(H1('11. Decyzje wymagane od Zamawiającego'));

children.push(table(
  { head: ['Decyzja', 'Rekomendacja', 'Termin', 'Konsekwencja zaniechania'], widths: [2300, 2400, 1500, 2826] },
  [
    ['Archiwizacja danych w dotychczasowej strukturze', 'WYKONANE 6.08.2026', 'Zamknięte', 'Bezpowrotna utrata statusu budynku, numeru lokalu i przynależności administracyjnej'],
    ['Wyniesienie archiwum i kopii zapasowych poza maszynę roboczą', 'Wykonać niezwłocznie', 'Najbliższe tygodnie', 'Awaria dysku oznacza bezpowrotną utratę zrzutu w strukturze sprzed 1.09.2026, którego nie da się odtworzyć'],
    ['Zamknięcie luki w limitowaniu zapytań', 'WYKONANE 8.08.2026', 'Zamknięte', 'Limitowanie dało się obejść losowaniem nagłówka — usługa bez ochrony przed nadużyciem'],
    ['Czy komercjalizacja jest celem pierwszego wdrożenia', 'Rozstrzygnąć przed etapem 4', 'Najbliższe tygodnie', 'Etap 8 to 18–24 dni. Odłożenie go bez decyzji grozi budowaniem wersjonowania wydań bez uwzględnienia rozliczania klientów'],
    ['Model udostępniania: wspólna instalacja czy instancja per klient', 'Jedna wspólna instalacja', 'Przed etapem 3', 'Instancja per klient powiela ten sam artefakt w pamięci — przy 50 klientach to ponad 20 GB na dane identyczne dla wszystkich'],
    ['Wystąpienie o warunki licencyjne iMPA', 'Wystąpić teraz', 'Najbliższe tygodnie', 'Brak zabezpieczenia na wypadek awarii źródła podstawowego — poziom 2 pozostaje niedostępny'],
    ['Zakup licencji na spis kodów pocztowych', 'Odłożyć', '—', 'Kody z rejestru pozostają przybliżeniem — akceptowalne'],
    ['Zewnętrzne API jako uzupełnienie', 'Przewidzieć, uruchamiać warunkowo', 'Przed produkcją', 'Niższa skuteczność korekty danych wprowadzanych ręcznie'],
    ['Zakres pierwszego wdrożenia', 'ROZSTRZYGNIĘTE — cały kraj', 'Zamknięte', 'Komplet 16 województw opublikowany 9.08.2026'],
    ['Model utrzymania', 'Wskazać osobę odpowiedzialną za obserwację zmian po stronie rejestru', 'Przed produkcją', 'Zmiana formatu może pozostać niezauważona'],
  ],
  { boldFirst: true },
));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ================= 12. SLOWNIK =================
children.push(H1('12. Słownik pojęć'));

children.push(table(
  { head: ['Pojęcie', 'Wyjaśnienie'], widths: [2200, 6826] },
  [
    ['PRG', 'Państwowy Rejestr Granic i Powierzchni Jednostek Podziałów Terytorialnych Kraju. Prowadzony przez GUGiK. Zawiera m.in. punkty adresowe — podstawowe źródło danych w projekcie'],
    ['GUGiK', 'Główny Urząd Geodezji i Kartografii'],
    ['TERYT', 'Krajowy Rejestr Urzędowy Podziału Terytorialnego Kraju, prowadzony przez GUS'],
    ['TERC', 'Identyfikator jednostki podziału terytorialnego (województwo, powiat, gmina) w rejestrze TERYT'],
    ['SIMC', 'Identyfikator miejscowości w rejestrze TERYT. Siedem znaków, wiodące zera są znaczące'],
    ['ULIC', 'Centralny Katalog Ulic — część rejestru TERYT'],
    ['EMUiA', 'Ewidencja Miejscowości, Ulic i Adresów prowadzona przez gminy. Źródło zasilające rejestr PRG'],
    ['iMPA', 'Internetowy Manager Punktów Adresowych — system, w którym ok. 1400 gmin prowadzi ewidencję adresową'],
    ['PNA', 'Pocztowy Numer Adresowy, potocznie kod pocztowy'],
    ['Punkt adresowy', 'Pojedynczy adres w rejestrze: miejscowość, ewentualna ulica, numer porządkowy i współrzędne'],
    ['GML', 'Format wymiany danych przestrzennych oparty na XML, stosowany przez GUGiK'],
    ['PL-1992', 'Państwowy układ współrzędnych geodezyjnych stosowany w rejestrze PRG. Wymaga przeliczenia do układu stosowanego w mapach internetowych'],
    ['ODbL', 'Licencja danych OpenStreetMap zawierająca klauzulę zobowiązującą do udostępnienia bazy pochodnej na tych samych warunkach'],
    ['Artefakt indeksu', 'Niezmienny plik zawierający strukturę wyszukiwania, wytwarzany przez proces przetwarzania i ładowany przez mikroserwis'],
    ['Obszar przejściowy', 'Wydzielona część bazy danych, do której trafiają dane przed weryfikacją i publikacją'],
    ['Punkt końcowy', 'Pojedynczy adres funkcji w interfejsie REST — jedna operacja, którą aplikacja może wywołać'],
    ['Klucz API', 'Poświadczenie identyfikujące aplikację klienta. Podstawa limitowania zapytań i rozliczania. W obecnej wersji nieweryfikowany — patrz 5.5'],
    ['Wielodostępność', 'Obsługa wielu klientów przez jedną instalację, z rozdzieleniem limitów, uprawnień i rozliczeń'],
    ['Metryka', 'Liczba udostępniana przez usługę na potrzeby monitorowania, np. wiek danych lub czas odpowiedzi'],
    ['Sonda gotowości', 'Zapytanie kontrolne, na podstawie którego środowisko uruchomieniowe decyduje, czy kierować ruch do danej instancji'],
  ],
));

children.push(SPACER(300));
children.push(new Paragraph({
  border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'D5DBE0' } },
  spacing: { before: 200, after: 120 },
  children: [],
}));
children.push(P([new TextRun({
  text: 'Informacja o źródle danych: dane pochodzą z Państwowego Rejestru Granic i Powierzchni ' +
    'Jednostek Podziałów Terytorialnych Kraju (PRG), udostępnianego nieodpłatnie przez Główny ' +
    'Urząd Geodezji i Kartografii na podstawie art. 40a ust. 2 pkt 1 lit. a ustawy Prawo ' +
    'geodezyjne i kartograficzne. Licencji nie wydaje się (art. 40c ust. 5 tej ustawy).',
  size: 18, italics: true, color: C.muted,
})]));

// ================= DOKUMENT =================
const doc = new Document({
  creator: 'Zespół wdrożeniowy',
  title: 'Komponent walidacji danych adresowych — raport',
  description: 'Stan prac, ocena ryzyk, warianty rozwiązania',
  numbering: {
    config: [
      { reference: 'bul', levels: [
        { level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 420, hanging: 240 } } } },
        { level: 1, format: LevelFormat.BULLET, text: '◦', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 840, hanging: 240 } } } },
      ]},
      { reference: 'num', levels: [
        { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 420, hanging: 240 } } } },
      ]},
    ],
  },
  styles: {
    default: {
      document: { run: { font: 'Calibri', size: 21 } },
      heading1: { run: { font: 'Calibri', size: 30, bold: true, color: C.accent },
                  paragraph: { spacing: { before: 360, after: 180 } } },
      heading2: { run: { font: 'Calibri', size: 25, bold: true, color: '2C3E50' },
                  paragraph: { spacing: { before: 280, after: 140 } } },
      heading3: { run: { font: 'Calibri', size: 22, bold: true, color: '2C3E50' },
                  paragraph: { spacing: { before: 220, after: 110 } } },
    },
  },
  sections: [{
    properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
          border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'D5DBE0' } },
          spacing: { before: 120 },
          children: [
            new TextRun({ text: `Komponent walidacji danych adresowych  ·  wersja ${WERSJA}`, size: 16, color: C.muted }),
            new TextRun({ text: '\t', size: 16 }),
            new TextRun({ children: ['Strona ', PageNumber.CURRENT, ' z ', PageNumber.TOTAL_PAGES], size: 16, color: C.muted }),
          ],
        })],
      }),
    },
    children,
  }],
});

Packer.toBuffer(doc).then((buf) => {
  const dir = path.join(__dirname, 'raport');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `raport-baza-mikroserwis-v${WERSJA}.docx`);
  fs.writeFileSync(out, buf);
  console.log('OK', (buf.length / 1024).toFixed(0), 'KB ->', out);
});
