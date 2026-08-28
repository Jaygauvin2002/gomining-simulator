// Vérifie que le réinvestissement en TH part du NET, pas du brut.
//
// Preuve empirique (relevé réel, 19 jours consécutifs de juillet 2026 pendant
// lesquels Jérémie réinvestissait en TH) : la croissance observée était de
// +0,14 à +0,33 TH/jour. Prédire depuis le net donne 0,14–0,27 — l'écart est
// d'environ 2 %. Prédire depuis le brut donne 1,11–1,25, soit 5 à 8× trop.
//
// Le bonus de +5 % est annoncé par GoMining lui-même : « Get 5% more rewards by
// converting them into power ».
//
// Usage :  node extension/tests/reinvest-th.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
// Le cœur de l'app a été extrait de index.html vers js/app.js le 2026-08-28.
// On lit donc l'UNION des deux : les tests cherchent du code et du markup, et
// l'app est la somme. Écrit ainsi, une prochaine extraction ne cassera pas
// onze suites d'un coup — il suffira d'ajouter le fichier à la liste.
const APP_SOURCES = ['index.html', 'js/app.js', 'js/strategy-lab.js', 'js/efficiency-calc.js'];
const HTML = APP_SOURCES
  .map(f => { try { return readFileSync(join(root, ...f.split('/')), 'utf8'); } catch { return ''; } })
  .join('\n');
const LAB  = readFileSync(join(root, 'js', 'strategy-lab.js'), 'utf8');

let pass = 0; const fails = [];
const check = (c, l) => c ? pass++ : fails.push(l);

// 1. Aucune boucle de composition ne doit repartir du brut.
for (const [name, src] of [['index.html', HTML], ['strategy-lab.js', LAB]]) {
  const bad = src.split('\n').filter(l =>
    /grossUsd/.test(l) && /(costPerTH|cost|thGain|dayTh|th \+=)/.test(l) && !/^\s*\/\//.test(l));
  check(bad.length === 0,
        `${name} : aucune composition ne doit utiliser grossUsd (${bad.length} trouvée(s))` +
        (bad.length ? ' → ' + bad[0].trim().slice(0, 70) : ''));
}

// 2. Et elles doivent bien repartir du net.
const netLoops = (HTML.match(/netUsd\s*[*/]/g) || []).length + (LAB.match(/netUsd\s*\*/g) || []).length;
check(netLoops >= 5, `au moins 5 compositions doivent partir de netUsd (trouvé ${netLoops})`);

// 3. Le bonus de +5 % doit rester présent.
check(/STRATEGY_TH_BONUS\s*=\s*0\.05/.test(LAB), 'STRATEGY_TH_BONUS doit valoir 0.05');
check(/1\.05|1 \+ bonusPct|1 \+ STRATEGY_TH_BONUS/.test(HTML), 'le bonus de réinvestissement doit être appliqué');

// 4. Contrôle numérique sur la journée de référence : la croissance prédite doit
//    tomber dans la plage observée, et le calcul depuis le brut doit en sortir
//    largement — c'est ce qui distingue les deux hypothèses.
{
  const netBtc = 0.00002700, btc = 61600, cost = 12.34, bonus = 1.05;
  const grossBtc = 0.00021324;
  const fromNet = netBtc * btc / cost * bonus;
  const fromGross = grossBtc * btc / cost * bonus;
  const observedLo = 0.14, observedHi = 0.33;
  check(fromNet >= observedLo * 0.8 && fromNet <= observedHi * 1.2,
        `prédiction depuis le net dans la plage observée (${fromNet.toFixed(4)} TH/jour)`);
  check(fromGross > observedHi * 3,
        `prédiction depuis le brut hors plage, d'un facteur ${(fromGross / fromNet).toFixed(1)}×`);
}

const total = pass + fails.length;
if (fails.length) {
  console.error(`\n  ÉCHEC — ${fails.length}/${total} :\n`);
  for (const f of fails) console.error('   ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`\n  OK — ${pass}/${total} vérifications de réinvestissement TH passent.\n`);
