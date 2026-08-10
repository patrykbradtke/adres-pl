/**
 * Silnik polityki - zestaw hermetyczny, bez bazy i bez sieci.
 *
 * Sprawdza przede wszystkim to, co przy autoryzacji kosztuje najwiecej, gdy
 * jest zle: ZAWEZENIE, ktore da sie obejsc. Kazdy przypadek "nie moze" jest
 * tu wazniejszy od kazdego "moze" - odmowa, ktora nie dziala, wyglada
 * identycznie jak dzialajaca, dopoki ktos jej nie sprobuje obejsc.
 *
 *   node --experimental-strip-types packages/core/test/policy.ts
 */
import {
  can, assertCan, Forbidden, PolicyUsageError,
  PERMISSIONS, findUnknownPermissions,
  type Actor, type Grant,
} from '../src/index.ts';

let errors = 0;
const report = (ok: boolean, description: string) => {
  console.log(`${ok ? 'OK  ' : 'ERROR'} ${description}`);
  if (!ok) errors++;
};

const grant = (permission: string, over: Partial<Grant> = {}): Grant => ({
  permission, scopeTerc: null, scopeClientId: null, via: 'test', ...over,
});

const actor = (grants: Grant[], kind: Actor['kind'] = 'user'): Actor =>
  ({ kind, id: '1', label: 'test', grants });

// --- katalog ---------------------------------------------------------------
console.log('--- katalog uprawnien ---');

report(new Set(PERMISSIONS.map((p) => p.name)).size === PERMISSIONS.length,
  `nazwy uprawnien sa unikatowe (${PERMISSIONS.length} pozycji)`);

report(PERMISSIONS.every((p) => /^[a-z_]+\.[a-z_]+$/.test(p.name)),
  'kazda nazwa ma postac obszar.czynnosc, po angielsku');

report(findUnknownPermissions(['user.read', 'nie.ma']).join() === 'nie.ma',
  'nieznane uprawnienie jest wykrywane');

// Publikacja wydania obejmuje caly kraj. Gdyby dalo sie ja zawezic
// terytorialnie, panel pozwalalby nadac ustawienie bez znaczenia.
report(PERMISSIONS.find((p) => p.name === 'release.publish')?.axis === 'global',
  'release.publish jest globalne - wydanie jest krajowe');
report(PERMISSIONS.find((p) => p.name === 'address.edit')?.axis === 'territorial',
  'address.edit jest terytorialne');

// --- os terytorialna -------------------------------------------------------
console.log('\n--- zakres terytorialny ---');

const mazowsze = actor([grant('address.edit', { scopeTerc: '14', via: 'rola redaktor' })]);

report(can(mazowsze, 'address.edit', { terc: '1465011' }).allowed,
  'redaktor Mazowsza moze edytowac w gminie Warszawa (1465011 zaczyna sie od 14)');

report(!can(mazowsze, 'address.edit', { terc: '1261011' }).allowed,
  'redaktor Mazowsza NIE moze edytowac w Malopolsce (1261011)');

// To jest przypadek, ktory obchodzilby zawezenie: pominiecie parametru.
report(!can(mazowsze, 'address.edit', {}).allowed,
  'zawezony redaktor NIE moze edytowac bez wskazania obszaru');

report(can(actor([grant('address.edit')]), 'address.edit', {}).allowed,
  'redaktor bez zawezenia moze edytowac bez wskazania obszaru');

// Prefiks nie moze dzialac "w bok": 146 nie obejmuje 1465011 przypadkiem,
// ale 1465 juz tak. Sprawdzamy, ze porownanie idzie po prefiksie, nie po
// zawieraniu gdziekolwiek.
report(!can(actor([grant('address.edit', { scopeTerc: '65' })]), 'address.edit',
  { terc: '1465011' }).allowed,
  'zakres 65 NIE obejmuje 1465011 - porownanie jest prefiksowe, nie "zawiera"');

// --- os kliencka -----------------------------------------------------------
console.log('\n--- zakres kliencki ---');

const opiekun = actor([grant('key.revoke', { scopeClientId: 7, via: 'rola operator' })]);
report(can(opiekun, 'key.revoke', { clientId: 7 }).allowed, 'opiekun moze uniewaznic klucz swojego klienta');
report(!can(opiekun, 'key.revoke', { clientId: 8 }).allowed, 'opiekun NIE moze tknac klucza cudzego klienta');
report(!can(opiekun, 'key.revoke', {}).allowed, 'opiekun NIE moze uniewazniac bez wskazania klienta');

// --- blad uzycia, nie odmowa ----------------------------------------------
console.log('\n--- pomylki wolajacego ---');

let rzucil = false;
try { can(actor([]), 'nie.istnieje'); } catch (e) { rzucil = e instanceof PolicyUsageError; }
report(rzucil, 'nieznane uprawnienie RZUCA, zamiast po cichu odmowic');

rzucil = false;
try {
  can(actor([grant('release.publish')]), 'release.publish', { terc: '14' });
} catch (e) { rzucil = e instanceof PolicyUsageError; }
report(rzucil, 'zakres terytorialny przy uprawnieniu globalnym RZUCA - to blad programisty, nie 403');

// --- uzasadnienie ----------------------------------------------------------
console.log('\n--- wyjasnialnosc ---');

const d = can(mazowsze, 'address.edit', { terc: '1465011' });
report(d.allowed && d.via === 'rola redaktor',
  `decyzja niesie sciezke nadania: ${d.allowed ? d.via : '(odmowa)'}`);

const odmowa = can(mazowsze, 'address.edit', { terc: '1261011' });
report(!odmowa.allowed && odmowa.reason.includes('14') && odmowa.reason.includes('1261011'),
  `odmowa mowi CZEGO dotyczy i DO CZEGO zawezono: "${!odmowa.allowed ? odmowa.reason : ''}"`);

// --- tryb ratunkowy --------------------------------------------------------
console.log('\n--- tryb ratunkowy ---');

const ratunek = actor([], 'break_glass');
const r = can(ratunek, 'release.publish');
report(r.allowed && r.via === 'TRYB RATUNKOWY',
  'tryb ratunkowy przechodzi, ale oznacza sie w uzasadnieniu');

// --- assertCan -------------------------------------------------------------
console.log('\n--- assertCan ---');

let zlapane: unknown;
try { assertCan(mazowsze, 'address.edit', { terc: '1261011' }); } catch (e) { zlapane = e; }
report(zlapane instanceof Forbidden && zlapane.reason.length > 0,
  'assertCan rzuca Forbidden z zachowanym uzasadnieniem');

report(assertCan(mazowsze, 'address.edit', { terc: '1465011' }).via === 'rola redaktor',
  'assertCan przepuszcza i zwraca sciezke');

console.log(errors === 0 ? '\nSilnik polityki dziala.' : `\n${errors} problemow.`);
process.exit(errors === 0 ? 0 : 1);
