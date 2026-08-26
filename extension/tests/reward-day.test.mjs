// Vérifie la datation des jours de récompense.
//
// GoMining écrit l'enregistrement le LENDEMAIN du jour miné : `createdAt` est la
// date d'écriture, `incomeStatistic.calculatedAt` (23:59:59.999) est le jour
// réellement miné. Vérifié sur 20 jours consécutifs du relevé réel : décalage
// systématique de J-1.
//
// Se fier à createdAt décalait tout le calendrier d'un jour ET marquait
// « partiel » le jour daté d'aujourd'hui — qui est la journée COMPLÈTE de la
// veille. Le site remontait alors à un jour vieux de 36 jours et retombait sur
// son PR par défaut, sous-estimant le gain net de 38 %.
//
// Usage :  node extension/tests/reward-day.test.mjs [export.json]

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'extractor.js'), 'utf8');

let pass = 0; const fails = [];
const check = (c, l) => c ? pass++ : fails.push(l);

// La logique de datation, extraite de la source plutôt que réécrite.
const block = (() => {
  const i = SRC.indexOf('const calcDay = day.incomeStatistic?.calculatedAt');
  if (i < 0) return null;
  const j = SRC.indexOf('if (!dateStr || dateStr < cutoffDate)', i);
  return j > i ? SRC.slice(i, j) : null;
})();
check(!!block, 'le bloc de datation doit exister dans extractor.js');
check(!!block && /calculatedAt/.test(block), 'la date doit venir de calculatedAt');
check(!!block && /86400000/.test(block), 'un repli doit reculer d’un jour quand calculatedAt manque');

const dateOf = block
  ? new Function('day', block + '; return dateStr;')
  : () => null;

// 1. calculatedAt fait foi, même quand createdAt dit le lendemain.
{
  const day = { createdAt: '2026-08-26T02:13:58.701Z',
                incomeStatistic: { calculatedAt: '2026-08-25T23:59:59.999Z' } };
  check(dateOf(day) === '2026-08-25', `calculatedAt gagne (obtenu ${dateOf(day)})`);
}

// 2. Sans calculatedAt, on recule d'un jour — le décalage est la règle.
{
  check(dateOf({ createdAt: '2026-08-26T02:13:58.701Z' }) === '2026-08-25',
        `repli J-1 (obtenu ${dateOf({ createdAt: '2026-08-26T02:13:58.701Z' })})`);
  check(dateOf({ createdAt: '2026-01-01T02:00:00.000Z' }) === '2025-12-31',
        'le repli traverse correctement un changement d’année');
}

// 3. Ni l'un ni l'autre : pas de date inventée.
check(!dateOf({}), 'aucune date disponible → pas de date');

// 4. Sur le relevé réel : le décalage doit être systématique, et le jour le plus
//    récent doit devenir COMPLET (c'est lui que le site utilisait à tort comme
//    partiel).
const real = process.argv[2];
if (real && existsSync(real)) {
  const d = JSON.parse(readFileSync(real, 'utf8'));
  const arr = ((d.rewards || {})['nft-income/find-aggregated-by-date'] || {})
                ?.data?.data?.array || [];
  if (arr.length) {
    let offBy1 = 0, same = 0;
    for (const x of arr) {
      const c = (x.createdAt || '').slice(0, 10);
      const k = (x.incomeStatistic?.calculatedAt || '').slice(0, 10);
      if (c && k) (c === k ? same++ : offBy1++);
    }
    console.log(`\n  --- relevé réel : ${arr.length} jours, ${offBy1} décalés de J-1, ${same} identiques ---`);
    check(offBy1 === arr.length, `décalage systématique (${offBy1}/${arr.length})`);

    const last = arr[arr.length - 1];
    const corrected = dateOf(last);
    const naive = (last.createdAt || '').slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    console.log(`      dernier jour : naïf=${naive}  corrigé=${corrected}  (aujourd'hui ${today})`);
    check(corrected < naive, 'la correction recule bien la date du dernier jour');
    if (naive >= today) {
      check(corrected < today,
            'le jour que l’ancienne logique jugeait partiel devient COMPLET après correction');
    }
  }
}

const total = pass + fails.length;
if (fails.length) {
  console.error(`\n  ÉCHEC — ${fails.length}/${total} :\n`);
  for (const f of fails) console.error('   ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`\n  OK — ${pass}/${total} vérifications de datation passent.\n`);
