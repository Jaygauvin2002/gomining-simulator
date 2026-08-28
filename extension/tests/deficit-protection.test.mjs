// Vérifie la protection de déficit de GoMining, telle qu'exposée par
// calcDailyReward et consommée par les affichages.
//
// GoMining évalue une ferme UNE FOIS PAR JOUR, au moment du paiement, et la
// ferme si elle serait négative — TOUS FRAIS ARRÊTÉS. Le résultat réel d'une
// journée est donc max(0, net) : une ferme au-delà de son seuil ne perd rien,
// elle ne gagne rien. (Mécanique confirmée par Jérémie le 2026-08-28.)
//
// Avant ce changement, un scénario de chute du BTC annonçait « −4 $/jour,
// −1 460 $/an » là où la vérité est « 0 $/jour, ferme en pause ». L'app
// surestimait donc le risque de baisse, et présentait à l'envers ce qui est
// un argument de vente de GoMining.
//
// Point crucial : les champs net* GARDENT leur signe. La recherche du prix BTC
// de seuil et effBreakevenWth() en dépendent — les borner en place casserait
// les deux. Ce sont les champs *Paid qui disent ce qui est crédité.
//
// calcDailyReward est extraite de index.html, pas recopiée.
//
// Usage :  node extension/tests/deficit-protection.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(here, '..', '..', 'index.html'), 'utf8');
const LAB  = readFileSync(join(here, '..', '..', 'js', 'strategy-lab.js'), 'utf8');

function grab(name) {
  const start = HTML.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} introuvable dans index.html`);
  let depth = 0;
  for (let i = HTML.indexOf('{', start); i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}') { depth--; if (depth === 0) return HTML.slice(start, i + 1); }
  }
  throw new Error(`${name} non close`);
}
const SERVICE = parseFloat(HTML.match(/const SERVICE_COST_PER_TH\s*=\s*([\d.]+)/)[1]);
const build = (st) => new Function('state', 'SERVICE_COST_PER_TH',
  grab('calcDailyReward') + '; return calcDailyReward;')(st, SERVICE);

let pass = 0; const fails = [];
const check = (c, l) => c ? pass++ : fails.push(l);
const eq = (a, b) => Math.abs(a - b) < 1e-12;

// --- 1. Journée rentable : rien ne change ------------------------------
// Les trente sites d'appel existants doivent voir exactement l'ancien
// comportement. Les nouveaux champs sont additifs, pas un changement en place.
{
  const f = build({ gmtPrice: 0.3311 });
  const r = f(690.3184, 15, 0.05, 5.69, 78855.08, 50.0509);
  check(r.paused === false, `journée rentable → paused=false (obtenu ${r.paused})`);
  check(r.netUsd > 0, 'net positif sur la journée de référence');
  check(eq(r.netUsdPaid, r.netUsd), 'netUsdPaid === netUsd quand la ferme tourne');
  check(eq(r.netBtcPaid, r.netBtc), 'netBtcPaid === netBtc quand la ferme tourne');
  check(eq(r.netGmtPaid, r.netGmt), 'netGmtPaid === netGmt quand la ferme tourne');
  check(eq(r.grossBtcPaid, r.grossBtc), 'grossBtcPaid === grossBtc quand la ferme tourne');
}

// --- 2. Journée déficitaire : zéro versé, signe conservé ---------------
// 100 TH à 50 W/TH, 0,15 $/kWh, PR 20 sat, BTC 50 k : largement négatif.
{
  const f = build({ gmtPrice: 0.30 });
  const r = f(100, 50, 0.15, 0, 50000, 20);
  check(r.netUsd < 0, `la config est bien déficitaire (net ${r.netUsd.toFixed(4)} $)`);
  check(r.paused === true, `→ paused=true (obtenu ${r.paused})`);
  check(eq(r.netUsdPaid, 0), `netUsdPaid = 0 (obtenu ${r.netUsdPaid})`);
  check(eq(r.netBtcPaid, 0), `netBtcPaid = 0 (obtenu ${r.netBtcPaid})`);
  check(eq(r.netGmtPaid, 0), `netGmtPaid = 0 (obtenu ${r.netGmtPaid})`);
  // Tous frais arrêtés : le brut versé est nul aussi, pas seulement le net.
  check(eq(r.grossBtcPaid, 0), `grossBtcPaid = 0 — les frais sont arrêtés (obtenu ${r.grossBtcPaid})`);
  // ET le signe doit survivre : sans lui, plus de seuil calculable.
  check(r.netUsd < 0 && r.netBtc < 0,
        'netUsd et netBtc gardent leur signe négatif — la recherche de seuil en dépend');
}

// --- 3. Le seuil est bien à net = 0, sans zone morte -------------------
{
  const f = build({ gmtPrice: 0.30 });
  // On cherche le prix BTC où ça basculerait, puis on vérifie des deux côtés.
  let lo = 1000, hi = 400000;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(100, 30, 0.05, 0, mid, 40).netUsd > 0) hi = mid; else lo = mid;
  }
  const juste = f(100, 30, 0.05, 0, hi * 1.02, 40);
  const dessous = f(100, 30, 0.05, 0, lo * 0.98, 40);
  check(juste.paused === false, `2 % au-dessus du seuil: la ferme tourne (obtenu paused=${juste.paused})`);
  check(dessous.paused === true, `2 % en dessous: la ferme est en pause (obtenu paused=${dessous.paused})`);
  check(juste.netUsdPaid > 0 && eq(dessous.netUsdPaid, 0), 'et les montants versés suivent le basculement');
}

// --- 4. Garde-fous de forme sur les affichages -------------------------
// Ce ne sont que des garde-fous : une regex sur le texte source ne peut pas
// distinguer un affichage juste d'un faux. Ils existent parce que la régression
// à craindre est précisément un retour de `netUsd` là où `netUsdPaid` est
// requis — un remplacement d'un mot, invisible en relecture.
const shapes = [
  [/netEl\.textContent = formatProfit\(r\.netBtcPaid/, 'dashboard: le net du jour lit netBtcPaid'],
  [/res-month-btc'\)\.textContent = formatProfit\(r\.netBtcPaid \* 30/, 'dashboard: le mois lit netBtcPaid'],
  [/res-year-btc'\)\.textContent = formatProfit\(r\.netBtcPaid \* 365/, 'dashboard: l’an lit netBtcPaid'],
  [/netEl\.textContent = formatUSD\(r\.netUsdPaid\) \+ '\/day'/, 'scénarios hero: lit netUsdPaid'],
  [/scn-card-net \$\{netClass\}">\$\{formatUSD\(r\.netUsdPaid\)\}/, 'scénarios cartes: lit netUsdPaid'],
  [/const netClass = r\.paused \? 'neg' : 'pos'/, 'scénarios cartes: la couleur suit paused, pas le signe'],
];
for (const [re, label] of shapes) check(re.test(HTML), label);

// Le théorique doit RESTER affiché quelque part : le jeter perdrait
// l'information « de combien suis-je sous l'eau », donc « quelle remontée du
// BTC me remet en route » — l'info la plus utile de l'écran de scénarios.
check(/paused_would_be/.test(HTML), 'le montant théorique reste affiché à côté du zéro');
check((HTML.match(/formatUSD\(r\.netUsd\)/g) || []).length >= 2,
      'le net théorique est encore rendu (dashboard + scénarios)');

// --- 5. Strategy Lab : un jour en pause ne contribue rien -------------
// Le corps de boucle est trop entrelacé (cfg, state, DOM) pour être extrait
// honnêtement, donc ceci reste un garde-fou de forme. Le comportement borné
// lui-même est vérifié par exécution dans efficiency-calc.test.mjs (8b).
check(/if \(dayR\.paused\)/.test(LAB), 'strategy-lab teste dayR.paused');
check(/paused: true/.test(LAB), 'le jour en pause est journalisé comme tel');
{
  // Le `continue` doit précéder toute accumulation, sinon le jour compte quand même.
  const iPaused = LAB.indexOf('if (dayR.paused)');
  const iCont   = LAB.indexOf('continue;', iPaused);
  const iAccum  = LAB.indexOf('totalBtc += dayBtc', iPaused);
  const iFees   = LAB.indexOf('const dayFeesGmt = dayR.feesGmt', iPaused);
  check(iPaused >= 0 && iCont > iPaused && iCont < iAccum,
        'le continue vient avant l’accumulation des totaux');
  check(iCont < iFees, 'et avant même le calcul des frais du jour');
}

console.log(fails.length
  ? `  ÉCHEC — ${pass} ok, ${fails.length} échec(s)\n` + fails.map(f => '    · ' + f).join('\n')
  : `  OK — ${pass} vérifications de la protection de déficit`);
process.exit(fails.length ? 1 : 0);
