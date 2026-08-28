// Reproduit la formule que GoMining affiche lui-même, et exige le chiffre exact
// qu'il a crédité pour une journée réelle.
//
//   net sat     = PR + GBP − C1 − C2
//   C1          = kWh × 24 × EE / BTC / 1000 − remise
//   C2          = 0.0089 / BTC − remise
//   GMT crédité = (net BTC − commission de réinvestissement) × BTC / GMT
//
// Référence : 2026-08-25, 690,3184 TH, PR 50,0509 sat, 15 W/TH, $0,05/kWh,
// remise 5,69 %, BTC 78855,08111971179, GMT 0,3311 → GoMining a crédité
// 28,7417 GMT. Le simulateur doit tomber dessus.
//
// calcDailyReward est extraite de index.html, pas recopiée.
//
// Usage :  node extension/tests/reward-formula.test.mjs

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
  if (start < 0) throw new Error(`${name} introuvable dans index.html`);
  let depth = 0;
  for (let i = HTML.indexOf('{', start); i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}') { depth--; if (depth === 0) return HTML.slice(start, i + 1); }
  }
  throw new Error(`${name} non close`);
}

const SERVICE = (() => {
  const m = HTML.match(/const SERVICE_COST_PER_TH\s*=\s*([\d.]+)/);
  if (!m) throw new Error('SERVICE_COST_PER_TH introuvable');
  return parseFloat(m[1]);
})();

let pass = 0; const fails = [];
const check = (c, l) => c ? pass++ : fails.push(l);

check(Math.abs(SERVICE - 0.0089) < 1e-9, `SERVICE_COST_PER_TH doit valoir 0.0089 (lu ${SERVICE})`);

// --- la journée de référence ---
const REF = {
  th: 690.3184, prSat: 50.0509,
  // Σ metaData.goBtcPayBonus = 3.9180093934943444e-8 BTC sur 690,3184 TH
  gbpSat: 0.0056756554562276545,
  eff: 15, kwh: 0.05, discountPct: 5.69,
  btc: 78855.08111971179, gmt: 0.3311,
  // Σ metaData.reinvestmentCommissionBtc / valueV2 — exactement 2,25 %
  commission: 0.0225,
  expectedNetSat: 17.8844,
  expectedGmt: 28.7417,
};

const build = (st) => new Function('state', 'SERVICE_COST_PER_TH',
  grab('calcDailyReward') + '; return calcDailyReward;')(st, SERVICE);

// 1. Sans les nouveaux termes, le résultat doit rester celui d'avant : les
//    trente sites d'appel existants ne doivent pas changer de comportement.
{
  const f = build({ gmtPrice: REF.gmt });
  const r = f(REF.th, REF.eff, REF.kwh, REF.discountPct, REF.btc, REF.prSat);
  const satPerTh = r.netBtc * 1e8 / REF.th;
  check(Math.abs(satPerTh - (REF.expectedNetSat - REF.gbpSat)) < 0.01,
        `sans GBP ni commission : ${satPerTh.toFixed(4)} sat/TH attendu ~${(REF.expectedNetSat - REF.gbpSat).toFixed(4)}`);
}

// 2. Avec les deux termes lus dans state : le chiffre exact de GoMining.
{
  const f = build({ gmtPrice: REF.gmt, gbpSatPerTh: REF.gbpSat, reinvestCommissionRate: REF.commission });
  const r = f(REF.th, REF.eff, REF.kwh, REF.discountPct, REF.btc, REF.prSat);
  const gmt = r.netGmt;
  const ecart = Math.abs(gmt - REF.expectedGmt);
  console.log(`\n  --- journée de référence 2026-08-25 ---`);
  console.log(`      net       ${(r.netBtc * 1e8 / REF.th).toFixed(4)} sat/TH   (GoMining : ${REF.expectedNetSat})`);
  console.log(`      GMT       ${gmt.toFixed(4)}          (GoMining : ${REF.expectedGmt})`);
  console.log(`      écart     ${ecart.toFixed(4)} GMT (${(ecart / REF.expectedGmt * 100).toFixed(3)} %)`);
  check(ecart / REF.expectedGmt < 0.005,
        `GMT à moins de 0,5 % du crédit réel (écart ${(ecart / REF.expectedGmt * 100).toFixed(3)} %)`);
  // Le sat/TH doit rester celui que GoMining affiche : la commission ne touche
  // que la conversion en GMT, pas le gain en BTC.
  const satPerTh2 = r.netBtc * 1e8 / REF.th;
  console.log(`      sat/TH    ${satPerTh2.toFixed(4)}         (GoMining : ${REF.expectedNetSat})`);
  check(Math.abs(satPerTh2 - REF.expectedNetSat) < 0.01,
        `sat/TH doit rester ${REF.expectedNetSat} malgré la commission (obtenu ${satPerTh2.toFixed(4)})`);
  check(Math.abs(r.netGmtBeforeCommission - 29.4033) / 29.4033 < 0.005,
        `netGmtBeforeCommission ≈ 29,4033 (obtenu ${r.netGmtBeforeCommission?.toFixed(4)})`);
}

// 3. Les paramètres explicites doivent primer sur state.
{
  const f = build({ gmtPrice: REF.gmt, gbpSatPerTh: 999, reinvestCommissionRate: 0.9 });
  const a = f(REF.th, REF.eff, REF.kwh, REF.discountPct, REF.btc, REF.prSat, REF.gbpSat, REF.commission);
  check(Math.abs(a.netGmt - REF.expectedGmt) / REF.expectedGmt < 0.005,
        'les paramètres explicites doivent primer sur state');
}

// 4. La commission doit réduire, jamais augmenter, et 0 doit être neutre.
{
  const f0 = build({ gmtPrice: REF.gmt });
  const f1 = build({ gmtPrice: REF.gmt, reinvestCommissionRate: 0.10 });
  const r0 = f0(REF.th, REF.eff, REF.kwh, REF.discountPct, REF.btc, REF.prSat);
  const r1 = f1(REF.th, REF.eff, REF.kwh, REF.discountPct, REF.btc, REF.prSat);
  check(r1.netGmt < r0.netGmt, 'une commission doit réduire le net');
  check(Math.abs(r1.netGmt - r0.netGmt * 0.9) < 1e-6, 'une commission de 10 % retire exactement 10 %');
  const f2 = build({ gmtPrice: REF.gmt, reinvestCommissionRate: 0 });
  check(Math.abs(f2(REF.th, REF.eff, REF.kwh, REF.discountPct, REF.btc, REF.prSat).netGmt - r0.netGmt) < 1e-9,
        'une commission nulle est neutre');
}

// 5. Le GBP doit augmenter le brut.
{
  const f0 = build({ gmtPrice: REF.gmt });
  const f1 = build({ gmtPrice: REF.gmt, gbpSatPerTh: 1 });
  check(f1(REF.th, REF.eff, REF.kwh, REF.discountPct, REF.btc, REF.prSat).grossGmt >
        f0(REF.th, REF.eff, REF.kwh, REF.discountPct, REF.btc, REF.prSat).grossGmt,
        'le GBP doit augmenter le brut');
}

const total = pass + fails.length;
if (fails.length) {
  console.error(`\n  ÉCHEC — ${fails.length}/${total} :\n`);
  for (const f of fails) console.error('   ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`\n  OK — ${pass}/${total} vérifications de formule passent.\n`);
