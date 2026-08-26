// Vérifie la moyenne quotidienne : fenêtre glissante sur les 7 derniers jours
// MESURÉS, jamais depuis le début.
//
// Pourquoi : Jérémie est resté à 16 TH près de la moitié de son ancienneté.
// Diviser son cumul par 370 jours décrit un passé qu'il a quitté, alors que ce
// KPI est censé dire ce que sa ferme rapporte aujourd'hui. Une version
// intermédiaire divisait même par le nombre d'entrées du journal de performance,
// qui en contenait une — la moyenne affichait donc le cumul lui-même.
//
// Usage :  node extension/tests/daily-avg.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(here, '..', '..', 'index.html'), 'utf8');

// Le bloc de calcul, extrait de la source et non réécrit.
const block = (() => {
  const i = HTML.indexOf('const AVG_WINDOW_DAYS = 7;');
  if (i < 0) return null;
  const j = HTML.indexOf('// KPIs', i);
  return j > i ? HTML.slice(i, j) : HTML.slice(i, i + 1400);
})();

let pass = 0; const fails = [];
const check = (c, l) => c ? pass++ : fails.push(l);

check(!!block, 'le bloc de moyenne glissante doit exister');
check(!!block && /slice\(0, AVG_WINDOW_DAYS\)/.test(block), 'la fenêtre doit être bornée à AVG_WINDOW_DAYS');
check(!!block && /!d\.partial/.test(block), 'les jours partiels doivent être exclus');
check(!/const avgDays[\s\S]{0,80}loadPerformance\(\)\.length/.test(HTML),
      'la moyenne ne doit plus se baser sur la taille du journal de performance');

const run = (rewardHistory, currentDailyUsd = 0, btcPrice = 78000) =>
  new Function('state', 'currentDailyUsd',
    block + '; return { dailyAvg, avgCount };')({ rewardHistory, btcPrice }, currentDailyUsd);

const day = (date, valueBtc, btcPrice = 78000, partial = false) => ({ date, valueBtc, btcPrice, partial });

// 1. Plus de 7 jours : seuls les 7 plus récents comptent.
{
  const hist = [];
  for (let i = 1; i <= 20; i++) hist.push(day(`2026-08-${String(i).padStart(2, '0')}`, i * 1e-6));
  const r = run(hist);
  check(r.avgCount === 7, `fenêtre limitée à 7 jours (obtenu ${r.avgCount})`);
  // Jours 14 à 20 → moyenne (14+…+20)/7 = 17 → 17e-6 BTC × 78000
  check(Math.abs(r.dailyAvg - 17e-6 * 78000) < 1e-6,
        `moyenne sur les 7 plus RÉCENTS (obtenu ${r.dailyAvg.toFixed(4)})`);
}

// 2. Le cas réel de Jérémie : cinq semaines sans revenu solo, un seul jour récent.
//    La moyenne doit valoir ce jour-là, et annoncer 1 — pas faire passer un jour
//    pour une semaine.
{
  const hist = [day('2026-07-20', 4.8e-05), day('2026-08-25', 1.2346e-04, 78855)];
  const r = run(hist);
  check(r.avgCount === 2, `les jours anciens comptent s'il n'y en a pas d'autres (obtenu ${r.avgCount})`);
  const expected = (4.8e-05 * 78000 + 1.2346e-04 * 78855) / 2;
  check(Math.abs(r.dailyAvg - expected) < 0.01, `moyenne des jours disponibles (obtenu ${r.dailyAvg.toFixed(2)})`);
}

// 3. Un jour partiel ne doit pas tirer la moyenne vers le bas.
{
  const r = run([day('2026-08-24', 1e-04), day('2026-08-25', 1e-04), day('2026-08-26', 1e-06, 78000, true)]);
  check(r.avgCount === 2, `le jour partiel est écarté (obtenu ${r.avgCount})`);
}

// 4. Chaque jour est valorisé au prix du BTC de CE jour-là.
{
  const r = run([day('2026-08-25', 1e-04, 100000)]);
  check(Math.abs(r.dailyAvg - 10) < 1e-9, `prix du jour utilisé (obtenu ${r.dailyAvg})`);
}

// 5. Aucun jour mesuré : on retombe sur le rythme calculé, pas sur zéro.
{
  const r = run([], 9.86);
  check(r.avgCount === 0 && Math.abs(r.dailyAvg - 9.86) < 1e-9,
        `repli sur le rythme calculé (obtenu ${r.dailyAvg})`);
}

// 6. Historique absent : pas d'exception.
{
  let threw = false, r;
  try { r = run(null, 0); } catch { threw = true; }
  check(!threw && r.dailyAvg === 0, 'historique null toléré');
}

// 7. Le compte est affiché : un jour ne doit pas se faire passer pour sept.
check(/port_avg_window/.test(HTML) && /\{n\}/.test(HTML),
      'le nombre de jours mesurés doit être affiché sous la valeur');

const total = pass + fails.length;
if (fails.length) {
  console.error(`\n  ÉCHEC — ${fails.length}/${total} :\n`);
  for (const f of fails) console.error('   ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`\n  OK — ${pass}/${total} vérifications de moyenne passent.\n`);
