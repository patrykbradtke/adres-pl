// Benchmark na syntetycznym zbiorze o ksztalcie PRG:
// ~103k miejscowosci + ~270k ulic = 373k etykiet
import { buildIndex, type IndexDoc } from '../../../packages/etl/src/index-builder/build.ts';
import { SearchIndex } from '../../../packages/api/src/search/engine.ts';

// deterministyczny PRNG - benchmark musi byc powtarzalny
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];

const CORE = ['Nowa','Stara','Wielka','Mala','Dolna','Gorna','Biala','Czarna','Zielona','Dluga','Krotka','Polna','Lesna','Ogrodowa','Sloneczna','Kwiatowa','Szkolna','Kolejowa','Krakowska','Warszawska','Poznanska','Gdanska','Lubelska','Swietokrzyska','Mickiewicza','Slowackiego','Norwida','Chopina','Moniuszki','Kopernika'];
const SUF = ['Wies','Wola','Dabrowa','Gora','Lka','Bor','Grod','Mysl','Rzeka','Pole','Sad','Most','Brzeg','Staw','Las'];
const PATRON = ['Tadeusza Kosciuszki','Adama Mickiewicza','Juliusza Slowackiego','Jana Pawla II','gen. Wladyslawa Andersa','ks. Piotra Skargi','Marii Curie-Sklodowskiej','Stefana Batorego','Krola Kazimierza Wielkiego','3 Maja','1 Maja','Armii Krajowej','Boh. Getta','Fryderyka Chopina'];
const STREET_TYPES = ['ul.','ul.','ul.','ul.','al.','pl.','os.','rondo'];
const WOJ = ['mazowieckie','malopolskie','wielkopolskie','slaskie','dolnoslaskie','lubelskie','podkarpackie','lodzkie','pomorskie','kujawsko-pomorskie','warminsko-mazurskie','zachodniopomorskie','podlaskie','swietokrzyskie','lubuskie','opolskie'];

const docs: IndexDoc[] = [];
const localityNames: string[] = [];
for (let i = 0; i < 103_000; i++) {
  const name = rnd() < 0.55 ? `${pick(CORE)} ${pick(SUF)}` : rnd() < 0.5 ? pick(SUF) : `${pick(CORE)}${pick(['ow','yn','ice','ki','no'])}`;
  localityNames.push(name);
  docs.push({ type:'locality', label:name, simc:String(1000000+i), addressPointCount: Math.floor(Math.pow(rnd(),4)*40000)+1,
    gmina:`gm. ${name}`, powiat:`pow. ${pick(localityNames)||name}`, voivodeship:pick(WOJ), hasStreets: rnd()<0.3,
    lat: 49+rnd()*6, lon: 14+rnd()*10 });
}
// Warszawa jako realny przypadek testowy
docs.push({ type:'locality', label:'Warszawa', simc:'0918123', addressPointCount: 400000, gmina:'gm. Warszawa', powiat:'pow. Warszawa', voivodeship:'mazowieckie', hasStreets:true, lat:52.2297, lon:21.0122 });
docs.push({ type:'locality', label:'Warszawka', simc:'0918124', addressPointCount: 12, gmina:'gm. Zalesie', powiat:'pow. plocki', voivodeship:'mazowieckie', hasStreets:false, lat:52.5, lon:20.1 });

let ulicId = 1;
for (let i = 0; i < 270_000; i++) {
  const loc = pick(localityNames);
  const isPatron = rnd() < 0.35;
  const name = isPatron ? pick(PATRON) : pick(CORE);
  const streetType = pick(STREET_TYPES);
  const short = isPatron ? name.split(' ').pop()! : undefined;
  docs.push({ type:'street', label:`${streetType} ${name}, ${loc}`, simc:String(1000000+Math.floor(rnd()*103000)),
    ulicId: ulicId++, addressPointCount: Math.floor(Math.pow(rnd(),3)*800)+1,
    gmina:`gm. ${loc}`, powiat:'pow. x', voivodeship:pick(WOJ), hasStreets:true,
    aliases: short ? [`${short}, ${loc}`] : undefined });
}
docs.push({ type:'street', label:'ul. Tadeusza Kosciuszki, Warszawa', simc:'0918123', ulicId: ulicId++, addressPointCount: 340, gmina:'gm. Warszawa', powiat:'pow. Warszawa', voivodeship:'mazowieckie', hasStreets:true, aliases:['Kosciuszki, Warszawa'] });
docs.push({ type:'street', label:'al. Jerozolimskie, Warszawa', simc:'0918123', ulicId: ulicId++, addressPointCount: 512, gmina:'gm. Warszawa', powiat:'pow. Warszawa', voivodeship:'mazowieckie', hasStreets:true });

console.log(`dokumentow: ${docs.length.toLocaleString('pl')}`);
const memBefore = process.memoryUsage().rss;
const built = buildIndex(docs, '2026-08-05-test');
console.log(`budowa:     ${built.stats.buildMs.toFixed(0)} ms`);
console.log(`kluczy:     ${built.stats.keys.toLocaleString('pl')}`);
console.log(`artefakt:   ${(built.stats.totalBytes/1048576).toFixed(1)} MB  (etykiety ${(built.stats.labelsBytes/1048576).toFixed(1)} MB, klucze ${(built.stats.keysBytes/1048576).toFixed(1)} MB)`);

const idx = new SearchIndex(built.buffer);
console.log(`RSS delta:  ${((process.memoryUsage().rss-memBefore)/1048576).toFixed(0)} MB`);

const QUERIES = ['war','wars','warsz','warszawa','kosciuszki','kosciuszki warszawa','warszawa kosciuszki','jerozolimskie','mickievicza','nowa wies','polna','tadeusza kosciuszki warszawa','zielona gora','chopin'];
console.log('\n--- latencje (200 iteracji na zapytanie) ---');
const all: number[] = [];
for (const q of QUERIES) {
  const times: number[] = [];
  for (let i=0;i<200;i++){ const t=process.hrtime.bigint(); idx.search(q,{limit:10}); times.push(Number(process.hrtime.bigint()-t)/1e6); }
  times.sort((a,b)=>a-b); all.push(...times);
  const n = idx.search(q,{limit:10}).length;
  console.log(`  ${q.padEnd(30)} p50 ${times[100].toFixed(3)} ms  p95 ${times[190].toFixed(3)} ms  wynikow: ${n}`);
}
all.sort((a,b)=>a-b);
console.log(`\n  RAZEM  p50 ${all[Math.floor(all.length*0.5)].toFixed(3)} ms  p95 ${all[Math.floor(all.length*0.95)].toFixed(3)} ms  p99 ${all[Math.floor(all.length*0.99)].toFixed(3)} ms`);

console.log('\n--- jakosc wynikow ---');
for (const q of ['warszawa','kosciuszki warszawa','mickievicza','jerozolimskie']) {
  console.log(`  "${q}":`);
  for (const s of idx.search(q,{limit:3})) console.log(`      ${String(s.score).padStart(5)}  ${s.label}   [${s.type}, pkt=${s.addressPointCount}]`);
}
console.log('\n--- filtr po miejscowosci (pole "ulica") ---');
for (const s of idx.search('ko',{limit:3, simc:'0918123', type:'street'})) console.log(`      ${s.label}`);
