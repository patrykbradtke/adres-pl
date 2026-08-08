/**
 * Test regresji dla zadania 8.1.
 *
 * Do 8.08.2026 kluczem limitowania byl naglowek x-api-key z odwrotem na req.ip.
 * Naglowka nikt nie weryfikuje, wiec klient losujacy jego wartosc przy kazdym
 * zadaniu dostawal swiezy licznik i calkowicie omijal limit. Ten test pilnuje,
 * zeby taka konstrukcja nie wrocila razem z kluczami API w etapie 8A: kluczem
 * limitowania moze byc wylacznie wartosc wczesniej zweryfikowana.
 *
 * Nie dotyka bazy - typeahead czyta z artefaktu indeksu.
 *
 *   node --experimental-strip-types packages/api/test/limit-obejscie.ts
 */
import { buildServer, loadConfig, parseTrustProxy } from '../src/server.ts';

const LIMIT = 5;
const NADMIAR = 4;

const app = await buildServer(loadConfig({
  ...process.env,
  RATE_LIMIT_MAX: String(LIMIT),
  LOG_LEVEL: 'error',
}));

let bledy = 0;
const zglos = (ok: boolean, opis: string) => {
  console.log(`${ok ? 'OK  ' : 'BLAD'} ${opis}`);
  if (!ok) bledy++;
};

// 1. Losowy naglowek przy kazdym zadaniu nie moze resetowac licznika.
const kody: number[] = [];
for (let i = 0; i < LIMIT + NADMIAR; i++) {
  const r = await app.inject({
    method: 'GET',
    url: '/v1/suggest?q=marszalkowska',
    headers: { 'x-api-key': `losowy-${i}-${'x'.repeat(i)}` },
  });
  kody.push(r.statusCode);
}
const odrzucone = kody.filter((s) => s === 429).length;
console.log('   kody przy losowanym naglowku:', kody.join(' '));
zglos(odrzucone === NADMIAR,
  `limit odrzucil ${odrzucone} z ${NADMIAR} zadan ponad limit mimo zmiany naglowka`);

// 2. Zaufanie do proxy domyslnie wylaczone - inaczej klient poda wlasny adres,
//    czyli wlasny klucz limitowania, i luka wraca innymi drzwiami.
const przypadki: Array<[string | undefined, boolean | number | string]> = [
  [undefined, false],
  ['false', false],
  ['true', true],
  ['1', 1],
  ['0', 0],
  ['10.0.0.0/8', '10.0.0.0/8'],
];
for (const [wejscie, oczekiwane] of przypadki) {
  const got = parseTrustProxy(wejscie);
  zglos(got === oczekiwane, `parseTrustProxy(${wejscie}) = ${JSON.stringify(got)}`);
}

await app.close();
console.log(bledy === 0 ? '\nWszystkie kontrole przeszly.' : `\n${bledy} kontroli nie przeszlo.`);
process.exit(bledy === 0 ? 0 : 1);
