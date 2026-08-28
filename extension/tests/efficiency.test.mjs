// Vérifie la moyenne d'efficacité de la ferme, extraite de la source.
//
// Deux bugs couverts ici :
//   1. un mineur sans efficacité déclarée était supposé à 15 W/TH — le
//      MEILLEUR cas — ce qui sous-estimait le coût électrique de toute ferme
//      moins efficace (jusqu'à 3,3× à 50 W/TH) ;
//   2. le fold-in du bonus miner multipliait par cette valeur, donc par null
//      dès qu'aucune efficacité n'était connue.
//
// La plage réelle est 12–50 W/TH : la table de prix GoMining n'a pas de
// ligne 12→11, donc 12 est le plancher et deviner 15 est hors plage.
//
// Usage :  node extension/tests/efficiency.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'extractor.js'), 'utf8');

// --- extraire le bloc de moyenne de la source, pas le réécrire -------------
function slice(startMark, endMark) {
  const a = SRC.indexOf(startMark);
  if (a < 0) throw new Error('introuvable: ' + startMark);
  const b = SRC.indexOf(endMark, a);
  if (b < 0) throw new Error('fin introuvable: ' + endMark);
  return SRC.slice(a, b + endMark.length);
}

// Ancre de fin sur le nom de la constante, pas sur son expression : la mutation
// « moyenne arithmétique » cassait l'extraction avant d'atteindre le contrôle 1,
// donc l'échec ne disait rien de l'arithmétique. Cette forme survit à une
// réécriture du membre droit et laisse les contrôles faire leur travail.
const AVG_BLOCK = (() => {
  const a = SRC.indexOf("const basePower = nfts.reduce(");
  const b = SRC.indexOf("const avgEfficiency =", a);
  if (a < 0 || b < 0) throw new Error("bloc de moyenne introuvable");
  return SRC.slice(a, SRC.indexOf("\n", b));
})();

const avg = new Function('nfts',
  AVG_BLOCK + '; return { basePower, ratedPower, avgEfficiency, ' +
  'partial: ratedPower > 0 && ratedPower < basePower - 1e-6 };');

const BONUS_BLOCK = slice(
  "const farmEff = result.miner.energyEfficiency;",
  "result.miner.power = withBonus;");

const foldBonus = new Function('result', 'bonus',
  'const withBonus = result.miner.power + bonus.power;\n' +
  BONUS_BLOCK + '; return result.miner;');

let pass = 0; const fails = [];
const check = (c, l) => c ? pass++ : fails.push(l);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// 1. Pondérée par le hashrate, pas arithmétique.
{
  const r = avg([{ power: 100, energyEfficiency: 15 }, { power: 20, energyEfficiency: 40 }]);
  check(near(r.avgEfficiency, 2300 / 120), `pondérée: attendu 19.1667, obtenu ${r.avgEfficiency}`);
  check(!near(r.avgEfficiency, 27.5), 'ce n\'est pas la moyenne arithmétique (27.5)');
  check(r.partial === false, 'complète quand tous les mineurs sont notés');
}

// 2. Un mineur sans efficacité est EXCLU, pas supposé au meilleur cas.
//    C'est le bug : (100*40 + 20*15)/120 = 35.83 au lieu de 40.
{
  const r = avg([{ power: 100, energyEfficiency: 40 }, { power: 20, energyEfficiency: null }]);
  check(near(r.avgEfficiency, 40), `exclu: attendu 40, obtenu ${r.avgEfficiency}`);
  check(!near(r.avgEfficiency, 35.8333333, 1e-4), 'ne retombe pas sur 15 pour le mineur muet');
  check(r.ratedPower === 100, `couverture: attendu 100 TH, obtenu ${r.ratedPower}`);
  check(r.partial === true, 'marquée partielle quand un mineur manque');
}
// même chose avec un champ absent, 0, ou une chaîne vide
for (const bad of [undefined, 0, '', NaN]) {
  const r = avg([{ power: 100, energyEfficiency: 40 }, { power: 20, energyEfficiency: bad }]);
  check(near(r.avgEfficiency, 40), `exclu aussi pour ${JSON.stringify(bad)} (obtenu ${r.avgEfficiency})`);
}

// 3. Aucune efficacité connue → null, pour que le site garde la valeur saisie.
{
  const r = avg([{ power: 100 }, { power: 20 }]);
  check(r.avgEfficiency === null, `attendu null, obtenu ${r.avgEfficiency}`);
  check(r.basePower === 120, 'basePower reste la somme complète');
}

// 4. 12 W/TH survit — c'est le plancher réel, pas une valeur à écraser.
{
  const r = avg([{ power: 350, energyEfficiency: 12 }]);
  check(near(r.avgEfficiency, 12), `12 W/TH conservé (obtenu ${r.avgEfficiency})`);
}

// 5. Le bonus miner entre dans la moyenne, pondéré par sa puissance.
{
  const m = foldBonus({ miner: { power: 696.4212, energyEfficiency: 15, efficiencyRatedPower: 696.4212 } },
                      { power: 0.3972, efficiency: 30 });
  const want = (696.4212 * 15 + 0.3972 * 30) / 696.8184;
  check(near(m.energyEfficiency, want), `bonus pondéré: attendu ${want}, obtenu ${m.energyEfficiency}`);
  check(m.power === 696.8184, `puissance sommée (obtenu ${m.power})`);
}

// 6. Un bonus sans efficacité hérite de la ferme : neutre pour la moyenne.
{
  const m = foldBonus({ miner: { power: 700, energyEfficiency: 15, efficiencyRatedPower: 700 } },
                      { power: 0.4, efficiency: null });
  check(near(m.energyEfficiency, 15), `hérite, ne dévie pas (obtenu ${m.energyEfficiency})`);
  check(m.efficiencyPartial === true, 'la ferme est marquée partielle: 0,4 TH non noté');
}

// 7. Le bonus miner ne DÉFINIT pas l'efficacité d'une ferme qui n'en a aucune.
//    0,4 TH ne décrit pas une ferme de 700.
{
  const m = foldBonus({ miner: { power: 700, energyEfficiency: null, efficiencyRatedPower: 0 } },
                      { power: 0.4, efficiency: 12 });
  check(m.energyEfficiency === null, `reste null, pas 12 (obtenu ${m.energyEfficiency})`);
  check(m.power === 700.4, 'la puissance est quand même sommée');
}

console.log(fails.length
  ? `  ÉCHEC — ${pass} ok, ${fails.length} échec(s)\n` + fails.map(f => '    · ' + f).join('\n')
  : `  OK — ${pass} vérifications`);
process.exit(fails.length ? 1 : 0);
