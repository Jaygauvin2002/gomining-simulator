// Vérifie le calculateur d'efficacité, extrait de js/efficiency-calc.js.
//
// Le calcul est vérifié contre la ferme réelle de Jérémie : 696,82 TH à
// 15 W/TH, 0,05 $/kWh, remise 7 %. Il a rapporté « je paie 10 $ et je
// paierais 8 $ » — le calcul doit tomber sur 2,33 $/jour, et l'upgrade
// complet doit coûter 5 582 $ pour 6,6 ans de retour.
//
// Usage :  node extension/tests/efficiency-calc.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', '..', 'js', 'efficiency-calc.js'), 'utf8');

// Charger le module en neutralisant ce qui touche au DOM : on ne garde que
// les fonctions pures, et on les prend DE LA SOURCE plutôt que de les
// réécrire — un test qui réimplémente la formule ne prouve rien.
const api = new Function(`
  const document = { getElementById: () => null, querySelectorAll: () => [] };
  const t = (k, fb) => fb || k;
  const formatUSD = n => '$' + Number(n).toFixed(2);
  ${SRC}
  return { effStepPrice, effCostPerTh, effDailyElecCost, effEvaluate, effLadder,
           effHashrateReturn, effBreakevenWth, effFarmInputs, effVerdict, EFF_BANDS, EFF_FLOOR, EFF_CEIL };
`)();

const { effStepPrice, effCostPerTh, effDailyElecCost, effEvaluate, effLadder,
        effHashrateReturn, effBreakevenWth, effFarmInputs, effVerdict, EFF_FLOOR, EFF_CEIL } = api;

let pass = 0; const fails = [];
const check = (c, l) => c ? pass++ : fails.push(l);
const near = (a, b, eps = 1e-6) => a !== null && Math.abs(a - b) < eps;

// --- 1. La table, palier par palier -------------------------------------
const EXPECTED = { 50: 0.10, 36: 0.10, 35: 0.50, 29: 0.50, 28: 1.00, 21: 1.00,
                   20: 1.10, 16: 1.10, 15: 2.67, 13: 2.67 };
for (const [w, p] of Object.entries(EXPECTED)) {
  check(effStepPrice(Number(w)) === p, `palier depuis ${w} = ${p} $ (obtenu ${effStepPrice(Number(w))})`);
}
// Hors table : 12 est le plancher (pas de 12→11), 51 est au-dessus du plafond.
check(effStepPrice(12) === null, `12 n'a pas de palier — c'est le plancher (obtenu ${effStepPrice(12)})`);
check(effStepPrice(51) === null, `51 hors table (obtenu ${effStepPrice(51)})`);

// --- 2. Coût cumulé ------------------------------------------------------
check(near(effCostPerTh(15, 12), 8.01), `15→12 = 8,01 $/TH (obtenu ${effCostPerTh(15, 12)})`);
check(near(effCostPerTh(25, 15), 10.50), `25→15 = 10,50 $/TH (obtenu ${effCostPerTh(25, 15)})`);
check(near(effCostPerTh(50, 12), 26.51), `50→12 = 26,51 $/TH (obtenu ${effCostPerTh(50, 12)})`);
// 38 paliers de 50 à 12 : la somme des bandes doit couvrir exactement l'écart.
{
  let steps = 0;
  for (let w = 50; w > 12; w--) if (effStepPrice(w) !== null) steps++;
  check(steps === 38, `38 paliers de 50 à 12 (obtenu ${steps})`);
}
check(effCostPerTh(15, 15) === 0, 'pas d\'upgrade → coût nul');
check(effCostPerTh(12, 15) === 0, 'cible au-dessus de l\'actuel → coût nul, pas négatif');
// Le plancher est appliqué par la table elle-même : 12 n'appartient à aucune
// bande, donc toute descente qui le franchit tombe sur un prix de palier null.
// Le garde-fou explicite `to < EFF_FLOOR` dans effCostPerTh est donc redondant
// (le retirer ne change aucun résultat) — il documente l'intention, il ne la
// porte pas. Ne pas conclure d'une mutation survivante qu'il manque un test.
check(effCostPerTh(15, 11) === null, 'sous le plancher → null, jamais un prix inventé');
check(effCostPerTh(60, 12) === null, 'au-dessus du plafond → null');

// --- 3. La ferme réelle de Jérémie --------------------------------------
const FARM = { th: 696.82, elecRateKwh: 0.05, discountPct: 7 };
{
  const r = effEvaluate({ ...FARM, fromWth: 15, toWth: 12 });
  check(near(r.dailySaving, 2.333, 0.005), `économie 2,33 $/jour (obtenu ${r.dailySaving.toFixed(3)})`);
  check(near(r.totalCost, 5581.53, 0.5), `coût 5 582 $ (obtenu ${r.totalCost.toFixed(0)})`);
  check(near(r.paybackYears, 6.55, 0.05), `retour 6,6 ans (obtenu ${r.paybackYears.toFixed(2)})`);
  check(near(r.annualReturnPct, 15.3, 0.5), `rendement 15 %/an (obtenu ${r.annualReturnPct.toFixed(1)})`);
  check(r.wattsSaved === 3, `3 W/TH économisés (obtenu ${r.wattsSaved})`);
  // Son exemple de vive voix : « je paie 10 $, je paierais 8 $ ».
  check(near(r.dailyBefore, 11.66, 0.02) && near(r.dailyAfter, 9.33, 0.02),
        `11,66 $ → 9,33 $ par jour (obtenu ${r.dailyBefore.toFixed(2)} → ${r.dailyAfter.toFixed(2)})`);
}

// --- 4. La remise allonge le retour, elle ne le raccourcit pas -----------
{
  const sans = effEvaluate({ ...FARM, discountPct: 0,  fromWth: 15, toWth: 12 });
  const avec = effEvaluate({ ...FARM, discountPct: 20, fromWth: 15, toWth: 12 });
  check(avec.totalCost === sans.totalCost, 'la remise ne touche PAS le prix de l\'upgrade');
  check(avec.dailySaving < sans.dailySaving, 'la remise réduit l\'économie');
  check(avec.paybackYears > sans.paybackYears,
        `donc elle allonge le retour (${sans.paybackYears.toFixed(1)} → ${avec.paybackYears.toFixed(1)} ans)`);
}

// --- 5. Le retour ne dépend pas de la taille de la ferme ----------------
{
  const petite = effEvaluate({ ...FARM, th: 16,   fromWth: 15, toWth: 12 });
  const grosse = effEvaluate({ ...FARM, th: 5000, fromWth: 15, toWth: 12 });
  check(near(petite.paybackYears, grosse.paybackYears, 1e-9),
        `16 TH et 5000 TH ont le même retour (${petite.paybackYears.toFixed(4)} vs ${grosse.paybackYears.toFixed(4)})`);
  check(grosse.totalCost > petite.totalCost, 'mais pas le même coût absolu');
}

// --- 6. Les bandes basses écrasent les hautes en rendement --------------
{
  const facile = effEvaluate({ ...FARM, fromWth: 50, toWth: 35 });   // bande 0,10 $
  const dure   = effEvaluate({ ...FARM, fromWth: 15, toWth: 12 });   // bande 2,67 $
  check(facile.annualReturnPct > dure.annualReturnPct * 10,
        `50→35 rapporte >10× plus que 15→12 (${facile.annualReturnPct.toFixed(0)}% vs ${dure.annualReturnPct.toFixed(0)}%)`);
  check(facile.paybackYears < 0.3,
        `50→35 se rentabilise en moins de 110 jours (obtenu ${(facile.paybackYears * 365).toFixed(0)} jours)`);
}

// --- 7. L'échelle : un segment par bande, cumul cohérent ---------------
{
  const rows = effLadder({ ...FARM, fromWth: 50 });
  check(rows.length === 5, `5 bandes de 50 à 12 (obtenu ${rows.length})`);
  check(rows[0].fromWth === 50 && rows[0].toWth === 35, `1re bande 50→35 (obtenu ${rows[0].fromWth}→${rows[0].toWth})`);
  check(rows[4].fromWth === 15 && rows[4].toWth === 12, `dernière bande 15→12 (obtenu ${rows[4].fromWth}→${rows[4].toWth})`);
  // Les segments doivent se chaîner sans trou ni chevauchement.
  let chained = true;
  for (let i = 1; i < rows.length; i++) if (rows[i].fromWth !== rows[i - 1].toWth) chained = false;
  check(chained, 'les segments se chaînent sans trou');
  const sum = rows.reduce((a, r) => a + r.costPerTh, 0);
  check(near(sum, 26.51, 1e-6), `la somme des bandes = 50→12 direct (${sum.toFixed(2)} vs 26,51)`);
  // Le rendement doit décroître en descendant : c'est toute la thèse.
  let decreasing = true;
  for (let i = 1; i < rows.length; i++) if (rows[i].annualReturnPct > rows[i - 1].annualReturnPct) decreasing = false;
  check(decreasing, 'le rendement décroît à chaque bande — les derniers watts coûtent cher');
  check(effLadder({ ...FARM, fromWth: 12 }).length === 0, 'au plancher, plus rien à proposer');
}

// --- 8. Robustesse : rien ne doit jeter ni renvoyer NaN -----------------
for (const bad of [null, undefined, NaN, 'abc', -5]) {
  let threw = false, r;
  try { r = effEvaluate({ th: 100, fromWth: bad, toWth: 12, elecRateKwh: 0.05, discountPct: 0 }); }
  catch { threw = true; }
  check(!threw, `fromWth=${JSON.stringify(bad)} ne jette pas`);
  check(r === null || isFinite(r.totalCost), `fromWth=${JSON.stringify(bad)} → null ou fini, jamais NaN`);
}
check(effDailyElecCost(100, 15, 0.05, 0) > 0, 'coût électrique positif sur des entrées valides');

// --- 8b. Protection de déficit : le résultat d'une journée est max(0, net) --
// GoMining évalue une fois par jour au paiement et ferme la ferme si elle est
// négative, TOUS FRAIS ARRÊTÉS. Une ferme au-delà du seuil ne perd donc rien,
// elle ne gagne rien — et l'upgrade ne réduit pas une facture, il restaure un
// revenu. Confondre les deux surestimait le risque de baisse.
{
  // net(w) = (PR − C2) − C1(w), en USD par TH et par jour.
  //
  // La pente DOIT être le vrai coût électrique par W/TH : 24 h / 1000 × tarif,
  // soit 0,0012 $ à 0,05 $/kWh sans remise. Un premier jet l'avait prise en
  // GMT : l'égalité (a) ne pouvait alors pas tenir, et l'échec accusait le code
  // au lieu du fixture. Vérifier les unités avant de conclure.
  const FARM2 = { th: 100, elecRateKwh: 0.05, discountPct: 0 };
  const SLOPE = 24 / 1000 * FARM2.elecRateKwh;      // 0,0012 $/TH/jour par W/TH
  const K = 20.5 * SLOPE;                            // seuil entre 20 et 21 W/TH
  const net = w => K - w * SLOPE;

  // (a) Les deux états rentables : la généralisation doit rendre EXACTEMENT
  //     l'écart d'électricité, puisque net(a) − net(b) = C1(b) − C1(a).
  const sansFn = effEvaluate({ ...FARM2, fromWth: 18, toWth: 16 });
  const avecFn = effEvaluate({ ...FARM2, fromWth: 18, toWth: 16, netPerThFn: net });
  check(near(avecFn.dailySaving, (net(16) - net(18)) * 100, 1e-9), 'gain = écart de net × TH');
  check(net(20) > 0 && net(21) < 0, `le seuil du fixture est bien à 20 W/TH (net20=${net(20).toFixed(5)}, net21=${net(21).toFixed(5)})`);
  check(avecFn.paused === false, 'pas en pause quand le départ est rentable');
  // L'égalité est la thèse : mêmes chiffres par deux chemins indépendants.
  check(near(avecFn.dailySaving, sansFn.dailySaving, 1e-6),
        `écart d'électricité et écart de net coïncident (${sansFn.dailySaving.toFixed(6)} vs ${avecFn.dailySaving.toFixed(6)})`);

  // (b) Départ en pause : le gain est le revenu ENTIER restauré, pas un delta
  //     d'électricité qu'on ne paie pas pendant l'arrêt.
  const r = effEvaluate({ ...FARM2, fromWth: 30, toWth: 16, netPerThFn: net });
  check(r.paused === true, 'marquée en pause quand net(départ) ≤ 0');
  check(near(r.dailySaving, net(16) * 100, 1e-9),
        `gain = tout le net à l'arrivée (attendu ${(net(16)*100).toFixed(4)}, obtenu ${r.dailySaving.toFixed(4)})`);
  // Et il doit être PLUS GRAND que le simple écart d'électricité : c'est tout
  // l'enjeu, l'ancien calcul sous-estimait l'intérêt de l'upgrade.
  const elecOnly = effEvaluate({ ...FARM2, fromWth: 30, toWth: 16 });
  check(r.dailySaving < elecOnly.dailySaving,
        `le gain réel est plus petit que l'écart d'électricité brut ici (${r.dailySaving.toFixed(4)} vs ${elecOnly.dailySaving.toFixed(4)}) — on ne crédite pas une économie sur une facture non payée`);

  // (c) Arrivée encore en pause : aucun gain, et aucun crédit fantôme.
  const still = effEvaluate({ ...FARM2, fromWth: 40, toWth: 30, netPerThFn: net });
  check(near(still.dailySaving, 0, 1e-12), `toujours en pause → gain nul (obtenu ${still.dailySaving})`);
  check(still.paybackYears === null, 'pas de retour calculable sans gain');

  // (d) L'échelle transmet bien la fonction.
  const rows = effLadder({ ...FARM2, fromWth: 45, netPerThFn: net });
  check(rows.some(x => x.paused === true), 'l\'échelle marque les bandes partant d\'une ferme en pause');
  check(rows.every(x => x.dailySaving >= 0), 'aucune bande ne montre un gain négatif');
}

// --- 9. Dégradation propre quand l'app n'est pas chargée ----------------
// Le premier jet lisait state.lastCalc.dailyProfitUsd, un champ qui N'EXISTE
// PAS (lastCalc ne porte que hashrate/efficiency/elecCost/discount/satPerTH) :
// la comparaison avec l'achat de hashrate ne se serait jamais affichée, en
// silence. Ce contrôle vérifie au moins qu'on renvoie null sans exploser.
{
  let threw = false, r;
  try { r = effHashrateReturn(); } catch { threw = true; }
  check(!threw, 'effHashrateReturn ne jette pas sans calcDailyReward');
  check(r && r.pct === null, `pct null quand l'app n'est pas là (obtenu ${r && r.pct})`);
  // « inconnu » et « déficitaire » doivent rester DEUX états distincts : les
  // confondre faisait dire « données non chargées » à un utilisateur dont un TH
  // de plus perd de l'argent — soit exactement celui qui doit baisser son W/TH.
  check(r && r.status === 'unknown', `status 'unknown' hors app (obtenu ${r && r.status})`);

  // Le seuil de rentabilité doit dégrader pareil, sans jeter.
  let threw2 = false, be;
  try { be = effBreakevenWth(); } catch { threw2 = true; }
  check(!threw2, 'effBreakevenWth ne jette pas sans calcDailyReward');
  check(be === null, `null hors app plutôt qu'un seuil inventé (obtenu ${be})`);
  check(effFarmInputs() === null, 'effFarmInputs renvoie null hors app');
}

// --- 10. Les verdicts se comparent à l'alternative, pas à un seuil inventé
{
  // Face à un hashrate qui rend 50 %/an :
  check(effVerdict(407, 50).cls === 'eff-v-great', 'un rendement 8× supérieur est excellent');
  check(effVerdict(60, 50).cls  === 'eff-v-good',  'au-dessus du hashrate: bon');
  check(effVerdict(46, 50).cls  === 'eff-v-close', 'à 8 % près du hashrate: équivalent');
  check(effVerdict(15, 50).cls  === 'eff-v-poor',  'bien en dessous: moins bien');
  // Le seuil « équivalent » était à 0,6 : 15 % contre 22 % passait pour pareil.
  check(effVerdict(33, 50).cls  === 'eff-v-poor',  'un tiers de moins n\'est PAS équivalent');
  // Sans alternative connue, on retombe sur des seuils absolus explicites.
  check(effVerdict(407, null).cls === 'eff-v-great', 'sans référence, 407 % reste excellent');
  check(effVerdict(15, null).cls  === 'eff-v-poor',  'sans référence, 15 % reste faible');
  check(effVerdict(null, 50).label === '—', 'rendement inconnu → tiret, pas de verdict');
}
check(near(effDailyElecCost(100, 15, 0.05, 100), 0), 'remise de 100 % → coût nul, pas négatif');

// --- 11. Le tableau doit déclarer l'alignement des DEUX côtés -----------
// main.css pose `th, td { text-align: right }` pour toute l'app. Ne styler que
// les th donne une spécificité plus forte sur les en-têtes tout en laissant les
// td suivre la règle globale : les colonnes se décalent visiblement. Ce contrôle
// existe parce que le bug est passé en production et n'était visible qu'à l'œil.
{
  const css = readFileSync(join(here, '..', '..', 'css', 'efficiency-calc.css'), 'utf8');
  const align = css.match(/\.eff-ladder[^{]*\{[^}]*text-align[^}]*\}/g) || [];
  const blob = align.join(' ');
  check(/\.eff-ladder\s+thead\s+th/.test(blob), 'l\'alignement couvre les en-têtes');
  check(/\.eff-ladder\s+tbody\s+td/.test(blob), 'l\'alignement couvre AUSSI les cellules');
  check(/first-child/.test(blob), 'et la première colonne est traitée à part');
}

console.log(fails.length
  ? `  ÉCHEC — ${pass} ok, ${fails.length} échec(s)\n` + fails.map(f => '    · ' + f).join('\n')
  : `  OK — ${pass} vérifications du calculateur d'efficacité`);
process.exit(fails.length ? 1 : 0);
