const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
  TableOfContents, PageBreak, LevelFormat, convertInchesToTwip,
  Footer, PageNumber, TabStopType, TabStopPosition,
} = require('docx');
const fs = require('fs');
const path = require('path');

const W = 9026;                 // szerokosc kolumny tekstu A4 przy marginesach 1"
const C = {
  head: 'E8EDF2',
  alt:  'F5F7F9',
  warn: 'FDF1E7',
  ok:   'EDF5EE',
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
  P([new TextRun({ text: 'Wersja 1.0  ·  5 sierpnia 2026', size: 21, color: C.muted })], { align: AlignmentType.CENTER }),
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
  'PostgreSQL 16 z rozszerzeniem PostGIS.'));

children.push(table(
  { head: ['Obszar', 'Status', 'Uwagi'], widths: [3000, 1700, 4326] },
  [
    ['Pobieranie danych z rejestru PRG', 'Gotowe', 'Sondaż HTTP, pobieranie wojewódzkie, archiwizacja z sumą kontrolną'],
    ['Parser danych źródłowych (GML)', 'Gotowe', 'Obsługuje starą i nową strukturę; tryb rozpoznawania nieznanych plików'],
    ['Baza danych', 'Gotowe', 'Schemat, indeksy, publikacja transakcyjna'],
    ['Kontrole jakości danych', 'Gotowe', '5 kontroli, każda odpowiada realnemu incydentowi'],
    ['Silnik wyszukiwania', 'Gotowe', 'Zmierzona mediana 0,49 ms'],
    ['Mikroserwis HTTP', 'Gotowe', '11 punktów końcowych'],
    ['Reguły walidacji adresu', 'Gotowe', 'Format, zgodność z rejestrem, poziomy pewności'],
    ['Import słowników TERYT', 'Do zrobienia', 'Usługa sieciowa GUS, wymaga rejestracji'],
    ['Automatyzacja cyklu aktualizacji', 'Do zrobienia', 'Zadanie cykliczne + powiadomienia'],
    ['Drugie źródło danych (iMPA)', 'Do zrobienia', 'Zabezpieczenie na wypadek awarii źródła podstawowego'],
    ['Uruchomienie na pełnym zbiorze', 'Do zrobienia', '8,5 mln punktów, dotąd testy na próbkach'],
  ],
  { rowFill: (r) => r[1] === 'Gotowe' ? C.ok : C.warn },
));

children.push(SPACER());
children.push(P(
  'Szacowany nakład do wersji produkcyjnej: 5–7 tygodni pracy jednej osoby. ' +
  'Nie zawiera prac po stronie interfejsu użytkownika, które są przedmiotem odrębnego opracowania.'));

children.push(H2('1.2. Ryzyko wymagające decyzji w ciągu najbliższych tygodni'));

children.push(...box(
  'Termin: 1 września 2026',
  [
    'Główny Urząd Geodezji i Kartografii przestaje wtedy publikować dane adresowe w dotychczasowej strukturze. Format SHP przeszedł na nową strukturę już 1 lipca 2026.',
    'Nowa struktura nie zawiera trzech informacji, które dziś wykorzystujemy: statusu budynku (istniejący / w budowie / planowany), numeru lokalu oraz przynależności administracyjnej.',
    'Zalecenie: pobrać i zarchiwizować pełny zrzut w starej strukturze przed tą datą. Jest to jedyna możliwość zachowania statusu budynku jako danych historycznych.',
    'Parser obsługujący nową strukturę jest już zbudowany, więc samo przejście nie stanowi zagrożenia. Zagrożeniem jest wyłącznie bezpowrotna utrata atrybutów.',
  ],
  C.warn,
));

children.push(H2('1.3. Rekomendacja'));
children.push(P(
  'Rekomendujemy kontynuację w obecnym modelu: własna baza zbudowana na państwowym ' +
  'rejestrze PRG, uzupełniona o niezależne źródło zapasowe, serwowana przez bezstanowy ' +
  'mikroserwis. Uzasadnienie:'));
children.push(BULLET('Dane rejestru PRG i TERYT są bezpłatne, bez licencji, z prawem do komercyjnego wykorzystania i redystrybucji. Jedynym obowiązkiem jest podanie źródła.'));
children.push(BULLET('Brak uzależnienia od zewnętrznego dostawcy w ścieżce krytycznej — żaden podmiot nie może podnieść ceny ani wycofać usługi.'));
children.push(BULLET('Adresy klientów nie opuszczają infrastruktury Zamawiającego, co upraszcza zgodność z RODO.'));
children.push(BULLET('Zmierzona wydajność jest o dwa rzędy wielkości lepsza niż rozwiązania oparte na zapytaniach do bazy danych.'));

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
    ['TERYT (GUS)', 'Rejestr jednostek podziału terytorialnego, miejscowości i ulic', 'Pliki bez rejestracji; usługa sieciowa po zgłoszeniu mailowym', 'Dane publiczne'],
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
    'Jedynym realnie niezależnym źródłem krajowym jest iMPA — system, w którym ok. 1400 gmin prowadzi ewidencję adresową, czyli źródło zasilające PRG. Prowadzi go podmiot komercyjny, więc ryzyko ma inny charakter niż ryzyko po stronie administracji.',
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
    ['1.09.2026', 'Koniec publikacji danych GML w starej strukturze', 'Wysoki — utrata trzech atrybutów; parser gotowy, wymagana archiwizacja'],
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

children.push(BULLET([
  new TextRun({ text: 'Czerwiec 2024 — dane zamrożone. ', bold: true, size: 21 }),
  new TextRun({ text: 'Paczki nie były odświeżane przez co najmniej dwa tygodnie. Problem wykryła i zgłosiła firma zewnętrzna, nie instytucja prowadząca rejestr.', size: 21 }),
]));
children.push(BULLET([
  new TextRun({ text: 'Marzec 2016 — zrzut niekompletny. ', bold: true, size: 21 }),
  new TextRun({ text: 'Opublikowany plik nie zawierał danych Wrocławia. Podobny przypadek dotyczył Białegostoku.', size: 21 }),
]));

children.push(P(
  'Wniosek: poprawna odpowiedź serwera i poprawny plik archiwum nie stanowią wystarczającego ' +
  'potwierdzenia jakości danych. Z tego powodu proces aktualizacji zawiera zestaw kontroli ' +
  'opisany w rozdziale 6.3.'));

children.push(H2('4.3. Ograniczenia po stronie źródła'));
children.push(table(
  { head: ['Czego brakuje', 'Zastosowane obejście'], widths: [4000, 5026] },
  [
    ['Plików różnicowych dla rejestru PRG', 'Porównanie sum kontrolnych treści i pełne przeładowanie'],
    ['Interfejsu podającego datę aktualizacji', 'Nagłówki HTTP, a w razie ich braku — harmonogram tygodniowy i porównanie sumy kontrolnej pliku'],
    ['Gwarancji stabilności adresów pobierania', 'Własne wersjonowane archiwum plików źródłowych'],
    ['Poprawnych schematów walidacyjnych XML', 'Własny parser strumieniowy zamiast narzędzi wymagających schematu'],
  ],
));

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
    ['Proces przetwarzania danych', 'Stanowy, zasobożerny', 'Raz na dobę, zadanie cykliczne', 'Pobranie, przetworzenie, kontrole jakości, publikacja'],
    ['Mikroserwis HTTP', 'Bezstanowy, lekki', 'Ciągle, skalowany poziomo', 'Podpowiedzi, walidacja, geokodowanie'],
  ],
));

children.push(SPACER());
children.push(H2('5.2. Kluczowa decyzja: artefakt wyszukiwania'));
children.push(P(
  'Proces przetwarzania wytwarza pojedynczy, niezmienny plik indeksu wyszukiwania, ' +
  'oznaczony wersją danych. Instancje mikroserwisu pobierają go przy starcie i utrzymują ' +
  'w pamięci operacyjnej. Podpowiedzi adresowe nie wymagają zapytań do bazy danych.'));

children.push(P('Korzyści tego rozwiązania:'));
children.push(BULLET('Wycofanie zmiany sprowadza się do zmiany wskaźnika wersji — kilkanaście sekund, bez migracji danych.'));
children.push(BULLET('Skalowanie poziome jest trywialne — brak stanu współdzielonego między instancjami.'));
children.push(BULLET('Wyniki są w pełni powtarzalne, co umożliwia automatyczne testy regresyjne jakości wyszukiwania.'));
children.push(BULLET('Baza danych nie jest obciążana ruchem podpowiedzi, który jest najintensywniejszy.'));

children.push(H2('5.3. Warstwa danych'));
children.push(table(
  { head: ['Technologia', 'Zastosowanie', 'Uzasadnienie'], widths: [1900, 2600, 4526] },
  [
    ['PostgreSQL + PostGIS', 'Źródło prawdy, numery budynków, geokodowanie', 'Dane adresowe są ściśle relacyjne i przestrzenne'],
    ['Indeks w pamięci procesu', 'Podpowiedzi adresowe', 'Dwa rzędy wielkości szybciej niż zapytania do bazy'],
    ['Redis', 'Limitowanie zapytań, pamięć podręczna, powiadamianie o nowej wersji', 'Nie uczestniczy w wyszukiwaniu'],
    ['Magazyn obiektowy', 'Archiwum plików źródłowych i artefaktów indeksu', 'Zabezpieczenie na wypadek niedostępności źródła'],
  ],
));

children.push(SPACER());
children.push(P([
  new TextRun({ text: 'Rozwiązania świadomie odrzucone: ', bold: true, size: 21 }),
  new TextRun({ text: 'MongoDB (brak zastosowania — model danych jest relacyjny), kolejka komunikatów w pierwszej wersji (proces aktualizacji nie wymaga brokera), zewnętrzne silniki wyszukiwania takie jak Elasticsearch czy Meilisearch (dodają infrastrukturę do problemu rozwiązanego w pamięci procesu).', size: 21 }),
]));

children.push(H2('5.4. Interfejs udostępniany aplikacjom'));
children.push(P(
  'Mikroserwis udostępnia interfejs REST. Poniższa tabela stanowi kontrakt ' +
  'dla zespołów budujących aplikacje konsumenckie.'));

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
    ['Walidacja wsadowa', 'Przetworzenie zbioru adresów, np. z pliku', 'Indeks + baza'],
    ['Geokodowanie odwrotne', 'Najbliższy adres dla podanych współrzędnych', 'Baza danych'],
    ['Metadane zbioru', 'Wersja danych, data ostatniego zrzutu, ostrzeżenie o przeterminowaniu', 'Baza danych'],
  ],
));

children.push(SPACER());
children.push(P([
  new TextRun({ text: 'Uwaga dla analityka: ', bold: true, size: 21 }),
  new TextRun({ text: 'funkcja metadanych zwraca wiek najnowszego zrzutu oraz ostrzeżenie, gdy przekracza on 30 dni. Jest to mechanizm wykrywania sytuacji, w której źródło przestało być aktualizowane — dokładnie takiej jak incydent z czerwca 2024 roku. Zaleca się objęcie tej funkcji monitorowaniem.', size: 21 }),
]));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ================= 6. MODEL DANYCH =================
children.push(H1('6. Model danych i reguły — dla analityka'));

children.push(H2('6.1. Encje'));
children.push(table(
  { head: ['Encja', 'Klucz główny', 'Opis', 'Liczność docelowa'], widths: [1900, 1500, 3800, 1826] },
  [
    ['Jednostka TERYT', 'TERC (7 znaków)', 'Województwo, powiat, gmina — hierarchia', 'ok. 3 tys.'],
    ['Miejscowość', 'SIMC (7 znaków)', 'Nazwa, rodzaj, gmina, centroid, znacznik występowania ulic', 'ok. 103 tys.'],
    ['Ulica', 'identyfikator wewnętrzny', 'Cecha, nazwa oficjalna, nazwa potoczna, powiązanie z miejscowością', 'ok. 303 tys.'],
    ['Punkt adresowy', 'identyfikator wewnętrzny', 'Numer budynku, kod pocztowy, współrzędne, status', 'ok. 8,56 mln'],
  ],
));

children.push(SPACER());
children.push(P('Trzy rozwiązania w modelu wymagają wyjaśnienia, ponieważ nie są oczywiste:'));

children.push(BULLET([
  new TextRun({ text: 'Znacznik występowania ulic przy miejscowości. ', bold: true, size: 21 }),
  new TextRun({ text: 'Znacząca część adresów w Polsce to adresy wiejskie, gdzie numer porządkowy odnosi się bezpośrednio do miejscowości, a ulica nie istnieje. Znacznik pozwala interfejsowi ukryć pole ulicy zanim użytkownik je zobaczy. Bez niego mieszkaniec wsi widzi puste, wymagane pole „ulica”.', size: 21 }),
]));
children.push(BULLET([
  new TextRun({ text: 'Identyfikator z rejestru jako klucz obcy. ', bold: true, size: 21 }),
  new TextRun({ text: 'Umożliwia trwałe powiązanie rekordów między kolejnymi zrzutami. Bez niego każda aktualizacja wymagałaby zgadywania, który rekord odpowiada któremu.', size: 21 }),
]));
children.push(BULLET([
  new TextRun({ text: 'Znacznik wycofania zamiast usuwania rekordów. ', bold: true, size: 21 }),
  new TextRun({ text: 'Gminy popełniają błędy i je cofają. Punkt adresowy, który zniknął z rejestru, może wrócić za miesiąc, a w międzyczasie może występować w zamówieniu klienta.', size: 21 }),
]));

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
  { head: ['Poziom', 'Znaczenie', 'Sugerowane zastosowanie'], widths: [2200, 3600, 3226] },
  [
    ['Zweryfikowany wobec rejestru', 'Pełne dopasowanie, dostępny identyfikator rejestrowy i współrzędne', 'Wysyłka bez dodatkowej weryfikacji'],
    ['Zweryfikowany częściowo', 'Miejscowość i ulica z rejestru, numer nie odnaleziony', 'Wysyłka z oznaczeniem do przeglądu'],
    ['Poza rejestrem', 'Użytkownik świadomie potwierdził adres spoza bazy', 'Nowe budownictwo — dopuścić'],
    ['Nietypowy', 'Tryb ręczny: skrytka pocztowa, adres tymczasowy', 'Odrębna ścieżka obsługi'],
    ['Niezweryfikowany', 'Import bez walidacji', 'Kolejka do przeglądu'],
  ],
));

children.push(SPACER());
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
    ['Numer typu 12/14', 'Zapis dwuznaczny: może być numerem budynku narożnego albo zapisem „budynek 12, lokal 14”', 'System sprawdza w rejestrze obie interpretacje i przyjmuje tę, która istnieje'],
    ['Miejscowości bez ulic', 'Numer odnosi się bezpośrednio do miejscowości', 'Pole ulicy opcjonalne, sterowane znacznikiem'],
    ['Duplikaty nazw miejscowości', 'Nazwy takie jak „Nowa Wieś” występują setki razy', 'Wymagane rozstrzygnięcie przez użytkownika — prezentacja gminy i powiatu'],
    ['Nazwy potoczne ulic', 'Użytkownik wpisuje „Kościuszki”, rejestr zawiera „Tadeusza Kościuszki”', 'Forma potoczna wyliczana automatycznie i indeksowana jako dodatkowy klucz'],
    ['Punkty planowane', 'Adres nadany, budynek jeszcze nie istnieje', 'Informacja zwrotna, nie blokada. Atrybut zamrożony przed 1.09.2026'],
    ['Skrytki pocztowe', 'Brak odpowiednika w rejestrze', 'Tryb adresu nietypowego'],
    ['Dzielnice w polu miejscowości', 'Zapis „Warszawa-Mokotów”', 'Traktowane jako pole pomocnicze, nie element klucza'],
  ],
));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ================= 7. PROCES AKTUALIZACJI =================
children.push(H1('7. Proces aktualizacji danych'));

children.push(H2('7.1. Przebieg'));
children.push(NUM('Sondaż nagłówków HTTP — sprawdzenie, czy plik źródłowy uległ zmianie, bez pobierania pełnych danych.'));
children.push(NUM('Pobranie plików w podziale na województwa, z wyliczeniem sumy kontrolnej.'));
children.push(NUM('Zapis do własnego archiwum — plik źródłowy zachowywany bez zmian.'));
children.push(NUM('Przetworzenie strumieniowe i zasilenie obszaru przejściowego bazy danych.'));
children.push(NUM('Wykonanie kontroli jakości — porównanie obszaru przejściowego z danymi produkcyjnymi.'));
children.push(NUM('Publikacja transakcyjna — wyłącznie po przejściu wszystkich kontroli blokujących.'));
children.push(NUM('Zbudowanie nowego artefaktu indeksu i powiadomienie instancji mikroserwisu.'));

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
    ['Poprawność geometrii', 'Odwróconą kolejność osi współrzędnych i punkty poza granicami kraju', 'Blokująca'],
  ],
));

children.push(SPACER());
children.push(P([
  new TextRun({ text: 'Kontrola blokująca wstrzymuje publikację i pozostawia poprzedni zrzut jako aktywny. ', bold: true, size: 21 }),
  new TextRun({ text: 'Przyjęta zasada: lepiej udostępniać dane sprzed tygodnia niż dane obejmujące połowę kraju. Obejście kontroli jest możliwe, ale wymaga jawnej decyzji operatora i pozostawia ślad w dzienniku zdarzeń.', size: 21 }),
]));

children.push(H2('7.3. Odporność na niedostępność źródła'));
children.push(table(
  { head: ['Poziom', 'Źródło', 'Warunek uruchomienia'], widths: [1200, 3400, 4426] },
  [
    ['1', 'PRG (GUGiK)', 'Domyślny'],
    ['2', 'iMPA (Geo-System)', 'Niedostępność PRG powyżej 7 dni lub brak zmian powyżej 30 dni'],
    ['3', 'Otwarte dane miast', 'Uzupełnienie luk w dużych ośrodkach'],
    ['4', 'Własne archiwum plików źródłowych', 'Awaria wszystkich źródeł zewnętrznych'],
  ],
));

children.push(SPACER());
children.push(P(
  'Poziom czwarty ma istotne znaczenie dla ciągłości działania. Własne wersjonowane ' +
  'archiwum — około 900 MB na zrzut, przy zrzutach miesięcznych ok. 22 GB rocznie — ' +
  'oznacza, że trwała niedostępność rejestru PRG powoduje degradację usługi do stanu ' +
  '„dane nie starsze niż ostatni zrzut”, a nie jej wyłączenie.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ================= 8. WYNIKI TESTOW =================
children.push(H1('8. Wyniki weryfikacji'));

children.push(H2('8.1. Test integracyjny'));
children.push(P(
  'Całą ścieżkę przetestowano na działającej instancji PostgreSQL 16.13 z PostGIS 3, ' +
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
children.push(H2('8.2. Wydajność wyszukiwania'));
children.push(P(
  'Pomiary wykonano na zbiorze syntetycznym odwzorowującym rozkład danych rzeczywistych: ' +
  '103 tys. miejscowości i 270 tys. ulic, łącznie 373 tys. pozycji, z uwzględnieniem ' +
  'polskich znaków, duplikatów nazw i nazw patronackich.'));

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
  { head: ['Parametr', 'Wartość zmierzona'], widths: [4500, 4526] },
  [
    ['Mediana czasu odpowiedzi', '0,49 ms'],
    ['95. percentyl', '1,11 ms'],
    ['99. percentyl', '1,84 ms'],
    ['Rozmiar artefaktu indeksu', '53 MB'],
    ['Zużycie pamięci przez instancję', 'ok. 485 MB'],
    ['Czas budowy artefaktu', '12 s'],
    ['Odporność na literówki', 'Zapytanie „mickievicza” zwraca „Mickiewicza”'],
  ],
));

children.push(SPACER());
children.push(P([
  new TextRun({ text: 'Wniosek metodyczny: ', bold: true, size: 21 }),
  new TextRun({ text: 'czynnikiem decydującym o wydajności jest liczba pozycji w indeksie, nie wybrana technologia. Ten sam mechanizm zastosowany do zbioru mniejszego 23-krotnie daje czas odpowiedzi niższy około 300-krotnie. Z tego powodu indeksowane są miejscowości i ulice, a numery budynków pobierane są z bazy dopiero po wyborze ulicy, gdy jest ich od kilkudziesięciu do kilkuset.', size: 21 }),
]));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ================= 9. WARIANTY =================
children.push(H1('9. Warianty rozwiązania'));
children.push(P(
  'Poniżej porównano trzy możliwe podejścia. Wariant A jest realizowany i opisany ' +
  'w poprzednich rozdziałach.'));

children.push(H2('9.1. Porównanie'));
children.push(table(
  { head: ['Kryterium', 'A. Własna baza', 'B. Hybryda', 'C. Zewnętrzne API'], widths: [2300, 2242, 2242, 2242] },
  [
    ['Nakład wdrożeniowy', 'Wysoki (5–7 tygodni)', 'Średni', 'Niski (kilka dni)'],
    ['Koszt bieżący', 'Infrastruktura + utrzymanie', 'Infrastruktura + opłaty za część ruchu', 'Opłata rosnąca liniowo z ruchem'],
    ['Uzależnienie od dostawcy', 'Brak', 'Częściowe', 'Pełne'],
    ['Dane osobowe poza organizacją', 'Nie', 'Dla części zapytań', 'Tak'],
    ['Czas odpowiedzi', '0,5 ms', '0,5 ms / opóźnienie sieci', 'Opóźnienie sieci'],
    ['Identyfikatory rejestrowe', 'Tak', 'Tak', 'Zwykle nie'],
    ['Odporność na awarię źródła', 'Cztery poziomy zabezpieczeń', 'Dwa źródła', 'Brak wpływu'],
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

children.push(table(
  { head: ['Etap', 'Zakres', 'Nakład', 'Zależności'], widths: [2400, 3200, 1500, 1926] },
  [
    ['Archiwizacja danych', 'Pobranie i zabezpieczenie zrzutu w dotychczasowej strukturze', '1 dzień', 'Termin: przed 1.09.2026'],
    ['Weryfikacja nowej struktury', 'Uruchomienie rozpoznania na rzeczywistym pliku, korekta odwzorowania pól', '2–3 dni', 'Dostępność pliku'],
    ['Import słowników TERYT', 'Integracja z usługą sieciową GUS, obsługa plików różnicowych', '3–5 dni', 'Rejestracja w GUS'],
    ['Uruchomienie na pełnym zbiorze', 'Import 8,5 mln punktów, strojenie, weryfikacja czasów', '5–8 dni', 'Poprzednie etapy'],
    ['Automatyzacja i monitorowanie', 'Zadanie cykliczne, powiadomienia, dziennik zdarzeń', '3–5 dni', '—'],
    ['Drugie źródło danych', 'Integracja iMPA, uzgadnianie rozbieżności', '5–8 dni', 'Wyjaśnienie licencji'],
    ['Walidacja wsadowa', 'Przetwarzanie plików z adresami, kolejka zadań', '3–5 dni', '—'],
    ['Utwardzenie i dokumentacja', 'Testy, zabezpieczenia, dokumentacja powdrożeniowa', '5 dni', 'Poprzednie etapy'],
  ],
));

children.push(SPACER());
children.push(P('Łączny szacowany nakład: 5–7 tygodni pracy jednej osoby, przy założeniu braku istotnych niespodzianek po stronie struktury danych źródłowych.'));

children.push(H2('10.1. Zagadnienia do zweryfikowania w trakcie wdrożenia'));
children.push(P(
  'Poniższe kwestie nie były możliwe do rozstrzygnięcia na etapie analizy i wymagają ' +
  'potwierdzenia empirycznego. Żadna z nich nie zagraża przyjętej architekturze, ale każda ' +
  'może wpłynąć na szczegóły realizacji.'));

children.push(BULLET('Czy serwer instytucji prowadzącej rejestr zwraca nagłówki umożliwiające tani sondaż zmian. W razie ich braku konieczne jest przejście na harmonogram tygodniowy.'));
children.push(BULLET('Dokładne nazwy plików w nowej strukturze po 1 września. Kod dopasowuje pliki według wzorca, nie stałej nazwy, więc zmiana nie powinna być odczuwalna.'));
children.push(BULLET('Czy nowa struktura zachowuje atrybuty wersjonowania obiektów. Od tego zależy, czy wykrywanie zmian może opierać się na wersjach, czy wyłącznie na sumach kontrolnych.'));
children.push(BULLET('Warunki licencyjne źródła iMPA — wymagane wystąpienie pisemne do podmiotu prowadzącego.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ================= 11. DECYZJE =================
children.push(H1('11. Decyzje wymagane od Zamawiającego'));

children.push(table(
  { head: ['Decyzja', 'Rekomendacja', 'Termin', 'Konsekwencja zaniechania'], widths: [2400, 2500, 1400, 2726] },
  [
    ['Archiwizacja danych w dotychczasowej strukturze', 'Wykonać niezwłocznie', 'Do 31.08.2026', 'Bezpowrotna utrata statusu budynku i numeru lokalu'],
    ['Wystąpienie o warunki licencyjne iMPA', 'Wystąpić teraz', 'Najbliższe tygodnie', 'Brak zabezpieczenia na wypadek awarii źródła podstawowego'],
    ['Zakup licencji na spis kodów pocztowych', 'Odłożyć', '—', 'Kody z rejestru pozostają przybliżeniem — akceptowalne'],
    ['Zewnętrzne API jako uzupełnienie', 'Przewidzieć, uruchamiać warunkowo', 'Przed produkcją', 'Niższa skuteczność korekty danych wprowadzanych ręcznie'],
    ['Zakres pierwszego wdrożenia', 'Cały kraj', 'Przed etapem importu', 'Ograniczenie do wybranych województw skraca czas o ok. tydzień'],
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
            new TextRun({ text: 'Komponent walidacji danych adresowych  ·  wersja 1.0', size: 16, color: C.muted }),
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
  const out = path.join(__dirname, 'raport-baza-mikroserwis.docx');
  fs.writeFileSync(out, buf);
  console.log('OK', (buf.length / 1024).toFixed(0), 'KB ->', out);
});
