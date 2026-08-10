/**
 * Generator zbioru testowego o SKALI i ROZKLADZIE realnego PRG.
 *
 * PO CO:
 * Dotychczasowe pomiary pochodzily z probek (kilka rekordow) albo
 * z izolowanego benchmarku indeksu. Nie odpowiadaly na pytania, ktore
 * decyduja o wdrozeniu:
 *   - ile trwa COPY 8,5 mln wierszy do obszaru przejsciowego
 *   - ile trwaja kontrole jakosci na pelnym zbiorze
 *   - ile trwa publikacja transakcyjna
 *   - jaki jest realny rozmiar artefaktu i zuzycie pamieci instancji
 *
 * Zbior odwzorowuje realne proporcje PRG (stan 31.03.2026):
 *   8 560 617 punktow adresowych
 *   302 793 ulic i placow
 *   ~103 000 miejscowosci
 *   2 477 gmin, 380 powiatow, 16 wojewodztw
 *
 * Odwzorowane sa tez wlasciwosci, ktore obciazaja wyszukiwanie:
 *   - rozklad Zipfa liczby adresow na miejscowosc (Warszawa vs wies)
 *   - masowe duplikaty nazw miejscowosci ("Nowa Wies")
 *   - nazwy patronackie wymagajace formy potocznej
 *   - polskie znaki diakrytyczne
 *   - ~35% adresow bez ulicy (adresy wiejskie)
 *
 * Zapis prosto do plikow COPY, bez posrednictwa GML - celem jest
 * pomiar bazy i indeksu, nie ponowny test parsera.
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  normalizeText, titleCasePl, shortStreetName,
  buildingNumberKey, buildingSortKey,
} from '@adres-pl/core';

// deterministyczny PRNG - pomiar musi byc powtarzalny
let seed = 20260806;
const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
const zipf = (max: number, skew = 3): number => Math.floor(Math.pow(rnd(), skew) * max) + 1;

const RDZENIE = [
  'Nowa', 'Stara', 'Wielka', 'Mała', 'Dolna', 'Górna', 'Biała', 'Czarna', 'Zielona',
  'Długa', 'Krótka', 'Polna', 'Leśna', 'Ogrodowa', 'Słoneczna', 'Kwiatowa', 'Szkolna',
  'Kolejowa', 'Kościelna', 'Świętokrzyska', 'Łąkowa', 'Brzozowa', 'Dębowa', 'Sosnowa',
];
const KONCOWKI = [
  'Wieś', 'Wola', 'Dąbrowa', 'Góra', 'Łąka', 'Bór', 'Gród', 'Rzeka', 'Pole', 'Sad',
  'Most', 'Brzeg', 'Staw', 'Las', 'Młyn', 'Kąt', 'Ostrów', 'Zdrój',
];
const SUFIKSY = ['ów', 'yn', 'ice', 'ki', 'no', 'ówka', 'in', 'any', 'ele', 'iska'];

const PATRONI = [
  'Tadeusza Kościuszki', 'Adama Mickiewicza', 'Juliusza Słowackiego', 'Jana Pawła II',
  'gen. Władysława Andersa', 'ks. Piotra Skargi', 'Marii Curie-Skłodowskiej',
  'Stefana Batorego', 'Króla Kazimierza Wielkiego', 'Fryderyka Chopina',
  'Stanisława Moniuszki', 'Mikołaja Kopernika', 'Cypriana Norwida', 'Bolesława Prusa',
  'Henryka Sienkiewicza', 'Władysława Reymonta', 'gen. Józefa Bema', 'płk. Leopolda Okulickiego',
  '3 Maja', '1 Maja', 'Armii Krajowej', 'Bohaterów Getta', 'Konstytucji 3 Maja',
];
const STREET_TYPES = ['ul.', 'ul.', 'ul.', 'ul.', 'ul.', 'al.', 'pl.', 'os.', 'rondo', 'skwer'];
const WOJ = [
  ['02', 'dolnośląskie'], ['04', 'kujawsko-pomorskie'], ['06', 'lubelskie'], ['08', 'lubuskie'],
  ['10', 'łódzkie'], ['12', 'małopolskie'], ['14', 'mazowieckie'], ['16', 'opolskie'],
  ['18', 'podkarpackie'], ['20', 'podlaskie'], ['22', 'pomorskie'], ['24', 'śląskie'],
  ['26', 'świętokrzyskie'], ['28', 'warmińsko-mazurskie'], ['30', 'wielkopolskie'],
  ['32', 'zachodniopomorskie'],
] as const;

export interface ScaleConfig {
  points: number;
  localities: number;
  ulic: number;
  gmin: number;
  outDir: string;
}

export const PRG_REALNA_SKALA: Omit<ScaleConfig, 'outDir'> = {
  points: 8_560_617,
  localities: 103_000,
  ulic: 302_793,
  gmin: 2_477,
};

function esc(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '\\N';
  return String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

/** Losowy punkt w przyblizonym obrysie Polski. */
function randomPosition(): [number, number] {
  return [14.2 + rnd() * 9.8, 49.1 + rnd() * 5.6];
}

export async function generuj(cfg: ScaleConfig): Promise<Record<string, string>> {
  await mkdir(cfg.outDir, { recursive: true });
  const f = (n: string) => `${cfg.outDir}/${n}.tsv`;
  const out: Record<string, string> = {};

  // --- hierarchia administracyjna ------------------------------------
  // Lista gmin budowana RAZ i uzywana zarowno do pliku TERC, jak i do
  // przypisania miejscowosci. Dwie niezalezne petle z osobnymi losowaniami
  // rozjezdzaly cyfre RODZ i lamaly klucz obcy.
  const powiaty: string[] = [];
  const gminy: string[] = [];
  {
    const POWIATOW = 380;
    const naWoj = Math.ceil(POWIATOW / WOJ.length);
    for (const [wkod] of WOJ) {
      for (let p = 1; p <= naWoj; p++) {
        powiaty.push(`${wkod}${String(p).padStart(2, '0')}000`);
      }
    }
    const naPowiat = Math.ceil(cfg.gmin / powiaty.length);
    for (const pterc of powiaty) {
      for (let g = 1; g <= naPowiat && gminy.length < cfg.gmin; g++) {
        const kind = pick([1, 2, 3, 3, 2, 2]);
        gminy.push(`${pterc.slice(0, 4)}${String(g).padStart(2, '0')}${kind}`);
      }
      if (gminy.length >= cfg.gmin) break;
    }
  }

  {
    const w = createWriteStream(f('terc'));
    for (const [code, name] of WOJ) {
      w.write([`${code}00000`, name, 1, '\\N', '\\N', '2026-08-01'].join('\t') + '\n');
    }
    for (const pterc of powiaty) {
      w.write([pterc, `powiat ${pterc.slice(0, 4)}`, 2, '\\N', `${pterc.slice(0, 2)}00000`, '2026-08-01'].join('\t') + '\n');
    }
    for (const gterc of gminy) {
      w.write([gterc, `${pick(RDZENIE)} ${pick(KONCOWKI)}`, 3, gterc[6], `${gterc.slice(0, 4)}000`, '2026-08-01'].join('\t') + '\n');
    }
    await new Promise((r) => w.end(r));
    out.terc = f('terc');
  }

  const localityNames: string[] = [];
  const hasStreets: boolean[] = [];
  {
    const w = createWriteStream(f('miejscowosc'));
    for (let i = 0; i < cfg.localities; i++) {
      // 55% nazw dwuczlonowych -> masowe duplikaty typu "Nowa Wies"
      const name = rnd() < 0.55
        ? `${pick(RDZENIE)} ${pick(KONCOWKI)}`
        : rnd() < 0.5 ? pick(KONCOWKI) : `${pick(RDZENIE)}${pick(SUFIKSY)}`;
      const simc = String(1_000_000 + i);
      // ~30% miejscowosci ma ulice (miasta i wieksze wsie)
      const withStreets = rnd() < 0.30;
      localityNames.push(name);
      hasStreets.push(withStreets);
      const [lon, lat] = randomPosition();
      w.write([
        simc, name, normalizeText(name),
        pick([1, 1, 1, 1, 2, 3, 4, 96, 99]),
        pick(gminy), '\\N', '\\N',
        withStreets ? 't' : 'f', 0,
        `SRID=4326;POINT(${lon.toFixed(6)} ${lat.toFixed(6)})`,
        'test', 'skala', '\\N',
      ].join('\t') + '\n');
    }
    await new Promise((r) => w.end(r));
    out.locality = f('miejscowosc');
  }

  // --- ulice ------------------------------------------------------------
  const withStreets = localityNames.map((_, i) => i).filter((i) => hasStreets[i]);
  const streetSimcs: number[] = [];
  {
    const w = createWriteStream(f('ulica'));
    const seen = new Set<string>();
    let id = 0;
    for (let i = 0; i < cfg.ulic; i++) {
      const mi = pick(withStreets);
      // 35% ulic patronackich - te wymagaja wyliczenia formy potocznej
      const patron = rnd() < 0.35;
      const name = patron ? pick(PATRONI) : pick(RDZENIE);
      const streetType = pick(STREET_TYPES);
      const simc = String(1_000_000 + mi);
      const norm = normalizeText(name);
      const key = `${simc}|${norm}|${streetType}`;
      if (seen.has(key)) continue;   // UNIQUE(simc, nazwa_norm, cecha)
      seen.add(key);
      const shortName = shortStreetName(name);
      id++;
      streetSimcs.push(mi);
      w.write([
        id, simc, String(10_000 + (id % 90_000)).padStart(5, '0'), streetType,
        name, norm,
        shortName ?? '\\N', shortName ? normalizeText(shortName) : '\\N',
        '\\N', '\\N', 0, 'test', 'skala', '\\N',
      ].join('\t') + '\n');
    }
    await new Promise((r) => w.end(r));
    out.street = f('ulica');
    out._ulicCount = String(id);
  }

  // --- punkty adresowe --------------------------------------------------
  {
    const w = createWriteStream(f('punkt'), { highWaterMark: 1 << 20 });
    const ulicCount = Number(out._ulicCount);
    let bufor = '';
    for (let i = 0; i < cfg.points; i++) {
      // 65% adresow przy ulicy, 35% bez ulicy (adresy wiejskie)
      const onStreet = rnd() < 0.65 && ulicCount > 0;
      const ulicId = onStreet ? zipf(ulicCount, 2) : null;
      const mi = onStreet ? streetSimcs[ulicId! - 1] : Math.floor(rnd() * cfg.localities);
      const simc = String(1_000_000 + mi);

      // rozklad numerow zblizony do realnego: krotkie czesciej niz dlugie
      const n = zipf(300, 2);
      const nr = rnd() < 0.08 ? `${n}${pick(['A', 'B', 'C', 'a'])}`
        : rnd() < 0.03 ? `${n}/${n + 2}` : String(n);

      const [lon, lat] = randomPosition();
      const code = `${String(10 + Math.floor(rnd() * 89)).padStart(2, '0')}-${String(Math.floor(rnd() * 1000)).padStart(3, '0')}`;
      const hash = createHash('sha256').update(`${simc}|${ulicId}|${nr}`).digest('hex');

      bufor += [
        `PA-${i}`, '\\N', '\\N', simc, ulicId ?? '\\N',
        nr, buildingNumberKey(nr), buildingSortKey(nr),
        code, rnd() < 0.02 ? 'wTrakcieBudowy' : 'istniejacy', '\\N',
        `SRID=4326;POINT(${lon.toFixed(6)} ${lat.toFixed(6)})`,
        'prg', 'skala', `\\\\x${hash}`, pick(WOJ)[0],
      ].join('\t') + '\n';

      if (bufor.length > (1 << 20)) {
        if (!w.write(bufor)) await new Promise((r) => w.once('drain', r));
        bufor = '';
      }
    }
    if (bufor) w.write(bufor);
    await new Promise((r) => w.end(r));
    out.point = f('punkt');
  }

  return out;
}
