// Vérifie le KPI « Optimal Strategy » du dashboard, en EXÉCUTANT
// updateDashboard extraite de index.html avec un faux DOM.
//
// L'ancienne version comparait des grandeurs incompatibles :
//   btcVal = net × 180 × prix        → 180 jours de revenu ENCAISSÉ
//   thVal  = (net au jour 180) × 365 → un RYTHME ANNUEL
// Sur une ferme de 700 TH elle annonçait TH gagnant de +164 % quand l'écart
// réel est de +20 %. Elle codait aussi 0,05 $/kWh en dur — ignorant le tarif
// détecté — et retombait sur 45 sat/TH là où l'app utilise 47 ou la valeur
// captée.
//
// Les trois contrôles qui comptent ici sont COMPORTEMENTAUX : on change une
// entrée et on exige que la sortie bouge. Une regex ne peut pas prouver
// qu'un champ est réellement lu.
//
// Usage :  node extension/tests/optimal-strategy.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Le cœur de l'app a été extrait de index.html vers js/app.js le 2026-08-28.
// On lit donc l'UNION des deux : les tests cherchent du code et du markup, et
// l'app est la somme. Écrit ainsi, une prochaine extraction ne cassera pas
// onze suites d'un coup — il suffira d'ajouter le fichier à la liste.
const APP_SOURCES = ['index.html', 'js/app.js', 'js/strategy-lab.js', 'js/efficiency-calc.js'];
const HTML = APP_SOURCES
  .map(f => { try { return readFileSync(join(here, '..', '..', ...f.split('/')), 'utf8'); } catch { return ''; } })
  .join('\n');

function grab(name) {
  const start = HTML.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} introuvable`);
  let depth = 0;
  for (let i = HTML.indexOf('{', start); i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}') { depth--; if (depth === 0) return HTML.slice(start, i + 1); }
  }
  throw new Error(`${name} non close`);
}
const num = (re, label) => {
  const m = HTML.match(re);
  if (!m) throw new Error(label + ' introuvable');
  return parseFloat(m[1]);
};
const SERVICE   = num(/const SERVICE_COST_PER_TH\s*=\s*([\d.]+)/, 'SERVICE_COST_PER_TH');
const TH_BONUS  = num(/const TH_BONUS\s*=\s*([\d.]+)/, 'TH_BONUS');
const ELEC_DEF  = num(/const ELEC_COST_DEFAULT\s*=\s*([\d.]+)/, 'ELEC_COST_DEFAULT');

let pass = 0; const fails = [];
const check = (c, l) => c ? pass++ : fails.push(l);

// --- faux DOM permissif : tout id existe, rien ne jette ------------------
//
// updateDashboard fait 190 lignes et touche des dizaines de globals définis
// ailleurs dans le script inline. Plutôt que de les énumérer un par un — jeu
// de taupes où chaque oubli fait échouer le test pour la mauvaise raison — on
// exécute le code dans un `with` sur un Proxy qui résout TOUT : les vraies
// valeurs qu'on fournit, sinon les globals de Node, sinon un objet inerte.
// Ce qu'on mesure reste le comportement réel de la fonction extraite.
const INERT = new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : INERT),
  set: () => true, apply: () => INERT, construct: () => INERT, has: () => true,
});

function run({ elec, sat, th = 700, eff = 15, disc = 5.69, costPerTH = 10.18,
               btc = 95000, gmt = 0.28 }) {
  const vals = {
    'elec-cost': String(elec), 'sat-per-th': String(sat), 'discount': String(disc),
    'reinv-cost-per-th': String(costPerTH), 'hashrate': String(th), 'efficiency': String(eff),
  };
  const written = {};
  const fake = (id) => ({
    get value() { return vals[id] ?? ''; }, set value(v) { vals[id] = String(v); },
    set textContent(v) { written[id] = String(v); }, get textContent() { return written[id] ?? ''; },
    set innerHTML(v) { written[id] = String(v); }, get innerHTML() { return written[id] ?? ''; },
    style: new Proxy({}, { set: () => true, get: () => '' }),
    classList: { add() {}, remove() {}, contains: () => false },
    className: '', dataset: {}, addEventListener() {}, appendChild() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    getAttribute: () => null, setAttribute() {}, removeAttribute() {},
  });

  const real = {
    document: {
      getElementById: fake, querySelector: () => null, querySelectorAll: () => [],
      documentElement: { style: { setProperty() {} } },
    },
    state: {
      btcPrice: btc, gmtPrice: gmt, satPerTH: sat, currency: 'usd',
      rewardHistory: [], capital: null, customBtcPrices: [], feeMode: 'gmt',
      // Sans ce taux, calcDailyReward met la commission à zéro et netGmt
      // devient identique à netUsd — le contrôle 4 ne testerait alors rien.
      reinvestCommissionRate: 0.0225,
    },
    SERVICE_COST_PER_TH: SERVICE, TH_BONUS, ELEC_COST_DEFAULT: ELEC_DEF,
    t: (k, fb) => fb || k,
    formatUSD: (n) => '$' + Number(n).toFixed(2),
    formatNumber: (n) => String(n),
    formatVal: (a) => String(a),
    formatProfit: (a) => String(a),
    getCurrentLevel: () => 1,
    getNextLevelTH: () => null,
    upgradeRate: () => costPerTH,
    currentLang: 'en',
  };

  const SCOPE = new Proxy(real, {
    has: () => true,
    get: (t, k) => {
      // `with` consulte Symbol.unscopables sur l'objet de portée. Y répondre
      // par notre objet inerte — truthy — faisait déclarer CHAQUE identifiant
      // hors portée, et tout échouait sur « state is not defined ».
      if (k === Symbol.unscopables) return undefined;
      return k in t ? t[k] : (k in globalThis ? globalThis[k] : INERT);
    },
    set: (t, k, v) => { t[k] = v; return true; },
  });

  const body = 'with (SCOPE) {\n' + grab('calcDailyReward') + '\n' + grab('updateDashboard') +
    '\n return function (th, eff) {' +
    '   const r = calcDailyReward(th, eff, ' + elec + ', ' + disc + ', ' + btc + ', ' + sat + ');' +
    '   updateDashboard(r, th, eff);' +
    ' }; }';
  let fn;
  try { fn = new Function('SCOPE', body)(SCOPE); }
  catch (e) { return { error: 'compilation: ' + e.message, written, vals }; }
  try { fn(th, eff); } catch (e) { return { error: e.message, written, vals }; }
  return { written, vals };
}

const parseSub = (sub) => {
  const g = (label) => {
    const m = sub.match(new RegExp(label + '\\s*\\$?(-?[\\d,]+\\.?\\d*)'));
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  };
  const thGain = sub.match(/\+([\d.]+) TH/);
  return { btc: g('BTC'), gmt: g('GMT'), th: g('TH'), thGained: thGain ? parseFloat(thGain[1]) : null };
};

// --- 1. Ça tourne, et la sous-ligne nomme l'horizon ---------------------
const base = run({ elec: 0.05, sat: 50.05 });
check(!base.error, `updateDashboard s'exécute (erreur: ${base.error})`);
const sub = base.written['dash-strategy-sub'] || '';
check(sub.length > 0, 'la sous-ligne de stratégie est écrite');
check(/180/.test(sub), `l'horizon est nommé dans la sous-ligne (obtenu "${sub}")`);
const v = parseSub(sub);

// --- 2. Les trois valeurs sont du même ordre ---------------------------
// C'est le cœur du bug : l'ancien code donnait TH ≈ 2,6 × BTC par pur
// artefact d'unité. Même horizon, même unité → le rapport doit rester sobre.
check(v.btc > 0 && v.th > 0, `BTC et TH positifs (BTC ${v.btc}, TH ${v.th})`);
check(v.th / v.btc > 0.5 && v.th / v.btc < 2,
      `TH/BTC doit rester entre 0,5 et 2 — l'artefact d'unité donnait ~2,6 (obtenu ${(v.th / v.btc).toFixed(2)})`);

// --- 3. TH = hashrate gagné × prix, pas un débit annualisé -------------
check(v.thGained !== null, 'le hashrate gagné est affiché');
check(Math.abs(v.th - v.thGained * 10.18) / v.th < 0.02,
      `la valeur TH est bien (TH gagnés × prix) : ${v.thGained} × 10,18 = ${(v.thGained * 10.18).toFixed(0)} vs ${v.th}`);

// --- 4. GMT juste sous BTC : la commission de conversion ---------------
check(v.gmt < v.btc, `GMT sous BTC — la commission de 2,25 % s'applique (GMT ${v.gmt}, BTC ${v.btc})`);
check((v.btc - v.gmt) / v.btc < 0.05, `et l'écart reste petit (${((v.btc - v.gmt) / v.btc * 100).toFixed(2)} %)`);

// --- 5. COMPORTEMENTAL : le tarif électrique est vraiment lu -----------
// L'ancien code écrivait 0.05 en dur dans les deux appels de la boucle TH :
// changer le champ ne changeait RIEN. Une regex n'aurait pas pu le prouver.
{
  const cher = run({ elec: 0.15, sat: 50.05 });
  const v2 = parseSub(cher.written['dash-strategy-sub'] || '');
  check(v2.th !== null && v2.th < v.th,
        `un tarif à 0,15 $/kWh réduit la valeur TH (${v.th} → ${v2.th}) — donc le champ est lu`);
  check(v2.btc < v.btc, 'et la valeur BTC baisse aussi');
}

// --- 6. COMPORTEMENTAL : le PR est vraiment lu -------------------------
{
  const faible = run({ elec: 0.05, sat: 30 });
  const v3 = parseSub(faible.written['dash-strategy-sub'] || '');
  check(v3.th !== null && v3.th < v.th,
        `un PR de 30 sat réduit la valeur TH (${v.th} → ${v3.th}) — donc le champ est lu`);
}

// --- 7. Protection de déficit : une ferme en pause n'accumule rien -----
{
  const pause = run({ elec: 0.30, sat: 15, eff: 50 });
  const v4 = parseSub(pause.written['dash-strategy-sub'] || '');
  check(v4.btc === 0, `ferme en pause → BTC à 0, pas négatif (obtenu ${v4.btc})`);
  check(v4.th === 0, `→ TH à 0, aucun réinvestissement (obtenu ${v4.th})`);
  check(v4.gmt === 0, `→ GMT à 0 (obtenu ${v4.gmt})`);
}

// --- 8. Garde-fou : plus de constantes codées en dur dans ce bloc ------
{
  const blk = grab('updateDashboard');
  const stratBlk = blk.slice(blk.indexOf('STRATÉGIE OPTIMALE'), blk.indexOf('const strategies'));
  check(!/,\s*0\.05\s*,/.test(stratBlk), 'plus de 0,05 $/kWh codé en dur dans le bloc stratégie');
  check(!/\|\|\s*45\b/.test(stratBlk), 'plus de repli à 45 sat/TH');
  check(/STRAT_HORIZON_DAYS/.test(stratBlk), 'l\'horizon est une constante nommée');
  check(/netUsdPaid/.test(stratBlk), 'le bloc respecte la protection de déficit');
  check(!/\*\s*365/.test(stratBlk), 'plus de × 365 : on ne mélange plus cumul et rythme annuel');
}

console.log(fails.length
  ? `  ÉCHEC — ${pass} ok, ${fails.length} échec(s)\n` + fails.map(f => '    · ' + f).join('\n')
  : `  OK — ${pass} vérifications du KPI de stratégie`);
process.exit(fails.length ? 1 : 0);
