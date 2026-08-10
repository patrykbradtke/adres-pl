/**
 * Tryb DISCOVER - rozpoznanie struktury nieznanego pliku GML.
 *
 * PO CO TO ISTNIEJE:
 * Namespace i dokladne zagniezdzenie nowej struktury EMUiA 2021 nie sa
 * publicznie udokumentowane. Zamiast zgadywac i wypuszczac parser, ktory
 * po cichu zwroci zero rekordow, uruchamiacie:
 *
 *     npm run etl -- discover <plik.gml|plik.zip>
 *
 * i dostajecie faktyczna liste elementow, namespace'ow i przykladowych
 * wartosci. Na tej podstawie w 5 minut dopisujecie/poprawiacie profile
 * w profiles.ts.
 *
 * Ten sam tryb sluzy jako TEST REGRESJI po kazdej zmianie formatu przez
 * GUGiK - jesli struktura sie zmieni, discover pokaze to od razu.
 */
import type { Readable } from 'node:stream';
import { SaxesParser, type SaxesTagNS } from 'saxes';

export interface DiscoveredElement {
  /** Sciezka local name'ow od korzenia dokumentu. */
  path: string;
  count: number;
  /** Do 3 przykladowych wartosci tekstowych. */
  samples: string[];
  /** Atrybuty widziane na tym elemencie. */
  attributes: Set<string>;
  hasText: boolean;
}

export interface DiscoveryReport {
  namespaces: Map<string, string>;
  rootElement?: string;
  /** Elementy wygladajace na feature'y (AD_*, PRG_*, *_Nazwa). */
  featureCandidates: Map<string, number>;
  elements: Map<string, DiscoveredElement>;
  totalElements: number;
  /** Zaobserwowane wartosci srsName. */
  srsNames: Set<string>;
  truncated: boolean;
}

const FEATURE_RE = /^(?:AD_|PRG_|EGB_|OT_)/;

/**
 * Skanuje poczatek pliku i buduje raport struktury.
 * Domyslnie zatrzymuje sie po 200 tys. elementow - to w zupelnosci wystarcza,
 * zeby zobaczyc wszystkie typy obiektow, a nie czyta 20 GB.
 */
export async function discoverGml(
  input: Readable,
  maxElements = 200_000,
): Promise<DiscoveryReport> {
  const report: DiscoveryReport = {
    namespaces: new Map(),
    featureCandidates: new Map(),
    elements: new Map(),
    totalElements: 0,
    srsNames: new Set(),
    truncated: false,
  };

  const parser = new SaxesParser({ xmlns: true, position: false });
  const stack: string[] = [];
  let text = '';
  let stop = false;

  parser.on('opentag', (tag: SaxesTagNS) => {
    if (stop) return;
    const local = tag.local || tag.name.replace(/^.*:/, '');
    // Namespace'y zbieramy z SAMEGO TAGU, bo saxes 6 nie ma zdarzenia
    // 'opennamespace' - stal tu na nie handler, ktory nigdy sie nie wykonal
    // (usuniety 10.08.2026 przy wlaczaniu sprawdzania typow). Odczyt z tagu
    // jest zreszta odporniejszy: lapie tez prefiks redeklarowany nizej
    // i plik ciety w polowie, a URI schematu to NAJWAZNIEJSZA informacja
    // z calego raportu.
    const uri: string = tag.uri ?? '';
    const prefix: string = tag.prefix ?? '';
    if (uri && !report.namespaces.has(prefix || '(default)')) {
      report.namespaces.set(prefix || '(default)', uri);
    }
    stack.push(local);
    report.totalElements++;
    if (report.totalElements > maxElements) { stop = true; report.truncated = true; return; }

    if (!report.rootElement) report.rootElement = local;
    if (FEATURE_RE.test(local)) {
      report.featureCandidates.set(local, (report.featureCandidates.get(local) ?? 0) + 1);
    }

    const path = stack.join('/');
    let el = report.elements.get(path);
    if (!el) {
      el = { path, count: 0, samples: [], attributes: new Set(), hasText: false };
      report.elements.set(path, el);
    }
    el.count++;

    const attrs = tag.attributes as Record<string, any>;
    for (const k of Object.keys(attrs)) {
      const a = attrs[k];
      const name = typeof a === 'object' && a !== null ? (a.prefix ? `${a.prefix}:${a.local}` : a.local) : k;
      el.attributes.add(name);
      const value = typeof a === 'object' && a !== null ? a.value : a;
      if (name.endsWith('srsName')) report.srsNames.add(value);
    }
    text = '';
  });

  parser.on('text', (t: string) => { if (!stop) text += t; });

  parser.on('closetag', () => {
    if (stop) { stack.pop(); return; }
    const path = stack.join('/');
    const el = report.elements.get(path);
    const value = text.trim();
    if (el && value) {
      el.hasText = true;
      if (el.samples.length < 3 && !el.samples.includes(value)) {
        el.samples.push(value.length > 120 ? value.slice(0, 120) + '...' : value);
      }
    }
    stack.pop();
    text = '';
  });

  let error: Error | null = null;
  parser.on('error', (e: Error) => { error = e; });

  for await (const chunk of input) {
    parser.write(chunk.toString('utf8'));
    if (error) break;
    if (stop) break;
  }
  if (!stop && !error) { try { parser.close(); } catch { /* niedomkniety plik przy limicie */ } }
  if (error && !report.truncated) throw error;

  return report;
}

/** Raport w formie czytelnej dla czlowieka. */
export function formatDiscoveryReport(r: DiscoveryReport): string {
  const out: string[] = [];
  out.push('=== NAMESPACE ===');
  if (r.namespaces.size === 0) out.push('  (brak deklaracji xmlns)');
  for (const [prefix, uri] of r.namespaces) out.push(`  ${prefix.padEnd(12)} ${uri}`);

  out.push('');
  out.push('=== FEATURE\'Y ===');
  const feats = [...r.featureCandidates.entries()].sort((a, b) => b[1] - a[1]);
  if (feats.length === 0) out.push('  (nie rozpoznano zadnych - sprawdz prefiksy w FEATURE_RE)');
  for (const [name, count] of feats) out.push(`  ${name.padEnd(32)} ${count.toLocaleString('pl')}`);

  out.push('');
  out.push('=== UKLADY WSPOLRZEDNYCH ===');
  if (r.srsNames.size === 0) out.push('  (brak srsName - zakladamy EPSG:2180)');
  for (const s of r.srsNames) out.push(`  ${s}`);

  out.push('');
  out.push('=== POLA FEATURE\'OW (sciezka -> przyklady) ===');
  const featureNames = new Set(r.featureCandidates.keys());
  const rows = [...r.elements.values()]
    .filter((e) => {
      const parts = e.path.split('/');
      return parts.some((p) => featureNames.has(p)) && (e.hasText || e.attributes.size > 0);
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const e of rows) {
    // sciezka wzgledna wzgledem feature'a
    const parts = e.path.split('/');
    const fi = parts.findIndex((p) => featureNames.has(p));
    const rel = parts.slice(fi).join('/');
    const attrs = e.attributes.size ? `  [@${[...e.attributes].join(' @')}]` : '';
    const samples = e.samples.length ? `  ex: ${e.samples.join(' | ')}` : '';
    out.push(`  ${rel.padEnd(56)} n=${String(e.count).padStart(7)}${attrs}${samples}`);
  }

  if (r.truncated) {
    out.push('');
    out.push(`  (przerwano po ${r.totalElements.toLocaleString('pl')} elementach - to probka, nie caly plik)`);
  }

  out.push('');
  out.push('=== CO DALEJ ===');
  out.push('  1. Skopiuj namespace do profiles.ts (pole observedNamespace, tylko do logu).');
  out.push('  2. Sprawdz, czy nazwy feature\'ow zgadzaja sie z profilem EMUIA_2021.');
  out.push('  3. Sprawdz sciezki pol - szczegolnie lokalnyId, identyfikatorSIMC,');
  out.push('     identyfikatorULIC oraz sposob kodowania asocjacji (@xlink:href czy zagniezdzenie).');
  out.push('  4. Zwroc uwage, czy wersjaId / poczatekWersjiObiektu SA obecne -');
  out.push('     od tego zalezy, czy mozna robic diff po wersjach, czy tylko po hashu.');
  return out.join('\n');
}
