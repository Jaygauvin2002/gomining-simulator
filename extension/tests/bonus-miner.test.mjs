// Vérifie findBonusMiner + l'arithmétique de la somme, sur le vrai payload.
// Le Bonus miner n'est pas dans /nft/get-my : sans lui la ferme est
// sous-comptée, et c'est l'écart que le scan global et le scraping du DOM
// tentaient de deviner depuis mai.
//
// Usage :  node extension/tests/bonus-miner.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'extractor.js'), 'utf8');

// Extraire findBonusMiner de la source, pas la réécrire.
const start = SRC.indexOf('function findBonusMiner(');
if (start < 0) { console.error('  ÉCHEC — findBonusMiner introuvable'); process.exit(1); }
let depth = 0, end = -1;
for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
  if (SRC[i] === '{') depth++;
  else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const make = new Function('DATA', SRC.slice(start, end) + '; return findBonusMiner;');

let pass = 0; const fails = [];
const check = (c, l) => c ? pass++ : fails.push(l);

const REAL = {
  url: 'https://api.bonus-miner.gomining.com/api/bonus-miner/client/find-one',
  data: { data: { is_paid: true, totalIncome: 0,
                  miner: { power: 0.3972, energy_efficiency: 15, eligible_power: 0.3972 } } },
};

// 1. Repérage par URL, même rangé sous une clé qui ne dit rien.
{
  const f = make({ miners: { 'client/find-one': REAL }, rewards: {} });
  const r = f();
  check(r && r.power === 0.3972, `power lu (obtenu ${r && r.power})`);
  check(r && r.efficiency === 15, `efficacité lue (obtenu ${r && r.efficiency})`);
}

// 2. Trouvé aussi s'il a atterri dans rewards.
{
  const r = make({ miners: {}, rewards: { 'client/find-one': REAL } })();
  check(r && r.power === 0.3972, 'trouvé dans rewards aussi');
}

// 3. Une autre entrée nommée client/find-one ne doit PAS être confondue.
{
  const impostor = { url: 'https://api.autre-service.com/api/client/find-one',
                     data: { data: { miner: { power: 999 } } } };
  const r = make({ miners: { 'client/find-one': impostor }, rewards: {} })();
  check(r === null, `imposteur ignoré (obtenu ${JSON.stringify(r)})`);
}

// 4. Absence, payload vide, puissance nulle ou non numérique : null, pas d'exception.
for (const [label, DATA] of [
  ['aucune entrée',      { miners: {}, rewards: {} }],
  ['sans objet miner',   { miners: { a: { url: 'x/bonus-miner/y', data: { data: {} } } }, rewards: {} }],
  ['puissance nulle',    { miners: { a: { url: 'x/bonus-miner/y', data: { data: { miner: { power: 0 } } } } }, rewards: {} }],
  ['puissance texte',    { miners: { a: { url: 'x/bonus-miner/y', data: { data: { miner: { power: 'abc' } } } } }, rewards: {} }],
  ['pools absents',      {}],
]) {
  let r, threw = false;
  try { r = make(DATA)(); } catch { threw = true; }
  check(!threw && r === null, `${label} → null sans exception (obtenu ${threw ? 'exception' : JSON.stringify(r)})`);
}

// 5. L'arithmétique réelle : 696,4212 + 0,3972 doit donner ce que GoMining affiche.
{
  const summed = 696.4212, bonus = 0.3972, displayed = 696.82;
  check(Math.abs(summed + bonus - displayed) < 0.01,
        `696,4212 + 0,3972 ≈ 696,82 (écart ${Math.abs(summed + bonus - displayed).toFixed(4)})`);
  check(Math.abs(summed - displayed) > 0.3,
        'sans le bonus, l’écart avec l’affichage est significatif — donc le sommer compte');
}

// 6. Le code doit sommer, et pondérer l'efficacité par la puissance.
// La fonction doit être APPELÉE, pas seulement définie. Une version antérieure
// de ce test ne vérifiait que la définition et les lignes voisines : remplacer
// l'appel par `null` laissait le bonus non sommé sans faire échouer un seul
// contrôle. Les lignes de somme existaient encore, simplement inatteignables.
const calls = (SRC.match(/findBonusMiner\(\)/g) || []).length;
check(calls >= 1, `findBonusMiner() doit être appelée (${calls} appel(s) trouvé(s))`);
check(/const bonus = findBonusMiner\(\);/.test(SRC),
      'la somme doit consommer le résultat de findBonusMiner(), pas une constante');
check(/bonusMinerPower/.test(SRC), 'result.miner.bonusMinerPower doit être exposé pour diagnostic');
check(/api\+bonus/.test(SRC), 'powerSource doit signaler api+bonus');
check(/bonus\.power \* \(bonus\.efficiency/.test(SRC), 'l’efficacité doit être pondérée par la puissance du bonus');

const total = pass + fails.length;
if (fails.length) {
  console.error(`\n  ÉCHEC — ${fails.length}/${total} :\n`);
  for (const f of fails) console.error('   ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`\n  OK — ${pass}/${total} vérifications Bonus miner passent.\n`);
