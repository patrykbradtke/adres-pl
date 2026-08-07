// Pobranie plikow pelnych TERYT z eteryt.stat.gov.pl bez konta do uslugi SOAP.
// Strona to ASP.NET WebForms - pobieranie idzie przez __doPostBack, wiec
// odtwarzamy formularz: GET po __VIEWSTATE -> POST z __EVENTTARGET.
import { writeFile, mkdir } from 'node:fs/promises';

const URL_PLIKI = 'https://eteryt.stat.gov.pl/eTeryt/rejestr_teryt/udostepnianie_danych/'
  + 'baza_teryt/uzytkownicy_indywidualni/pobieranie/pliki_pelne.aspx';
const OUT = process.argv[2] ?? '.';

// Wersja "urzedowa" (podstawowa) - jej uklad kolumn odpowiada temu, czego
// oczekuje parser w packages/etl/src/sources/teryt/format.ts.
const PRZYCISKI = {
  TERC: 'ctl00$body$BTERCUrzedowyPobierz',
  SIMC: 'ctl00$body$BSIMCUrzedowyPobierz',
  ULIC: 'ctl00$body$BULICUrzedowyPobierz',
  WMRODZ: 'ctl00$body$BRodzMiejPobierz',
};

function poleFormularza(html) {
  const pola = {};
  for (const m of html.matchAll(/<input\b[^>]*>/g)) {
    const tag = m[0];
    const name = tag.match(/name="([^"]+)"/)?.[1];
    if (!name) continue;
    const type = (tag.match(/type="([^"]+)"/)?.[1] ?? 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'image') continue;
    if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/.test(tag)) continue;
    pola[name] = (tag.match(/value="([^"]*)"/)?.[1] ?? '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  }
  return pola;
}

const res0 = await fetch(URL_PLIKI);
const html = await res0.text();
const ciasteczka = (res0.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const bazowe = poleFormularza(html);
console.log('pola formularza:', Object.keys(bazowe).join(', '));
console.log('stan danych   :', Object.entries(bazowe).find(([k]) => /Data|Stan/i.test(k))?.[1] ?? '(brak pola daty)');

await mkdir(OUT, { recursive: true });

for (const [katalog, target] of Object.entries(PRZYCISKI)) {
  const body = new URLSearchParams({ ...bazowe, __EVENTTARGET: target, __EVENTARGUMENT: '' });
  const t0 = Date.now();
  const r = await fetch(URL_PLIKI, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': URL_PLIKI,
      ...(ciasteczka ? { Cookie: ciasteczka } : {}),
    },
    body,
    redirect: 'follow',
  });

  const ctype = r.headers.get('content-type') ?? '';
  const cdisp = r.headers.get('content-disposition') ?? '';
  const buf = Buffer.from(await r.arrayBuffer());
  const nazwaZSerwera = cdisp.match(/filename="?([^";]+)"?/i)?.[1];

  if (/text\/html/i.test(ctype)) {
    console.log(`${katalog.padEnd(7)} ZWROCONO HTML (${buf.length} B) - postback nie dal pliku`);
    continue;
  }
  const plik = `${OUT}/${katalog}.zip`;
  await writeFile(plik, buf);
  console.log(`${katalog.padEnd(7)} OK ${(buf.length / 1024).toFixed(0)} KB | ${ctype} | serwer: ${nazwaZSerwera ?? '-'} | ${Date.now() - t0} ms`);
}
