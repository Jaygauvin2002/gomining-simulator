// Vérifie la déduction du taux d'upgrade ($/TH).
//
// Le simulateur écrivait 12,34 $ en dur. Or ce taux suit le prix du GMT : sur 19
// jours consécutifs de juillet il valait 12,08 $ à un cent près, et une
// observation du 26 août implique ~10,19 $. Figé, il affichait 0,859 TH là où
// Jérémie en avait gagné 1,04 — 17 % d'erreur.
//
// Il se déduit exactement :
//   taux = revenu net du jour N × (1 + bonus) / (puissance N+1 − puissance N)
//
// Usage :  node extension/tests/upgrade-rate.test.mjs [export.json]

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC  = readFileSync(join(here, '..', 'extractor.js'), 'utf8');
const HTML = readFileSync(join(here, '..', '..', 'index.html'), 'utf8');

function grab(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} introuvable`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} non close`);
}
const derive = new Function(
  'const TH_REINVEST_BONUS = 0.05;' + grab(SRC, 'deriveUpgradeRate') + '; return deriveUpgradeRate;')();

let pass = 0; const fails = [];
const check = (c, l) => c ? pass++ : fails.push(l);

const day = (date, power, valueBtc, btcPrice = 78000, reinvestInTH = true) =>
  ({ date, power, valueBtc, btcPrice, reinvestInTH, partial: false });

// 1. Deux jours consécutifs suffisent, et le résultat est exact.
{
  // net 2,00 $, +0,175 TH → 2 × 1,05 / 0,175 = 12,00 $
  const r = derive([day('2026-07-02', 100, 2 / 78000), day('2026-07-03', 100.175, 2 / 78000)]);
  check(r && Math.abs(r.usdPerTh - 12) < 0.01, `taux exact (obtenu ${r && r.usdPerTh?.toFixed(2)})`);
  check(r.observations === 1, `une observation (obtenu ${r.observations})`);
}

// 2. Un TROU dans les dates doit être ignoré : le delta de puissance couvre alors
//    plusieurs jours de gains, donc le taux calculé serait faux d'autant.
//
//    Le delta est choisi pour donner un taux PLAUSIBLE (12 $), sinon les bornes
//    de sanité le rejetteraient et le test passerait sans rien vérifier — c'est
//    exactement le défaut de sa première version.
{
  const r = derive([day('2026-07-20', 100, 2 / 78000), day('2026-07-23', 100.175, 2 / 78000)]);
  check(r === null, `trois jours d'écart ignorés malgré un taux plausible (obtenu ${JSON.stringify(r)})`);
  // Et le même écart ramené à un jour DOIT produire une observation, sinon on ne
  // teste que l'immobilisme.
  const ok = derive([day('2026-07-20', 100, 2 / 78000), day('2026-07-21', 100.175, 2 / 78000)]);
  check(ok && Math.abs(ok.usdPerTh - 12) < 0.01, 'le même écart sur un jour est bien retenu');
}

// 3. Un jour sans réinvestissement en TH ne dit rien du taux.
{
  const r = derive([day('2026-07-02', 100, 2 / 78000, 78000, false), day('2026-07-03', 100.175, 2 / 78000)]);
  check(r === null, 'un jour hors mode TH ne produit pas d’observation');
}

// 4. La MÉDIANE doit résister à une valeur aberrante — un achat manuel le même
//    jour gonfle le delta de puissance et fausserait une moyenne.
{
  const d = [];
  for (let i = 1; i <= 7; i++) d.push(day(`2026-07-0${i}`, 100 + (i - 1) * 0.175, 2 / 78000));
  // Aberration DANS les bornes : +0,07 TH pour le même revenu → 30 $/TH. Une
  // valeur hors bornes serait écartée en amont et ne testerait pas la médiane —
  // c'était le défaut de la première version de ce cas.
  d.push(day('2026-07-08', 100 + 6 * 0.175 + 0.07, 2 / 78000));
  const r = derive(d);
  check(r.observations === 7, `7 observations dont l'aberration (obtenu ${r.observations})`);
  check(Math.abs(r.usdPerTh - 12) < 0.05,
        `la médiane ignore l'aberration (obtenu ${r.usdPerTh.toFixed(2)})`);
  // La moyenne, elle, serait tirée vers le haut : c'est ce qui distingue les deux.
  const mean = 12 * 6 / 7 + 30 / 7;
  check(Math.abs(mean - 12) > 2, `une moyenne serait faussée de ${(mean - 12).toFixed(1)} $`);
}

// 5. Bornes de sanité, et cas dégénérés sans exception.
{
  check(derive([day('2026-07-02', 100, 2 / 78000), day('2026-07-03', 100.0000001, 2 / 78000)]) === null,
        'un delta minuscule donnerait un taux absurde → écarté');
  for (const [label, input] of [['vide', []], ['un seul jour', [day('2026-07-02', 100, 1 / 78000)]],
                                ['null', null], ['undefined', undefined]]) {
    let threw = false, r;
    try { r = derive(input); } catch { threw = true; }
    check(!threw && r === null, `${label} → null sans exception`);
  }
}

// 6. Côté site : plus aucun nombre magique dans le calcul du calendrier.
check(/upgradeRate\(\)/.test(HTML), 'le site doit passer par upgradeRate()');
check(!/day\.valueBtc \* btcRef \/ 12\.34/.test(HTML), 'le 12,34 codé en dur du calendrier doit avoir disparu');
check(/state\.upgradeRateUsd/.test(HTML), 'le taux déduit doit être consommé');
check(/dataset\.userEdited !== '1'/.test(HTML), 'une valeur saisie par l’utilisateur ne doit pas être écrasée');
check(/const TH_BONUS = 0\.05/.test(HTML), 'le bonus doit être une constante nommée, pas un 1.05 dispersé');

// 7. Sur le vrai relevé : ~12,08 $, la valeur observée en juillet.
const real = process.argv[2];
if (real && existsSync(real)) {
  const d = JSON.parse(readFileSync(real, 'utf8'));
  const arr = ((d.rewards || {})['nft-income/find-aggregated-by-date'] || {})?.data?.data?.array || [];
  if (arr.length > 2) {
    const hist = arr.map(x => {
      const st = x.incomeStatistic || {}, il = x.incomeListV2 || x.incomeList || [];
      return { date: (st.calculatedAt || '').slice(0, 10), partial: false,
               power: il.reduce((a, i) => a + (i.power || 0), 0),
               valueBtc: x.valueV2 || x.value || 0, btcPrice: st.btcCourseInUsd || 0,
               reinvestInTH: il.some(i => i.reinvestmentInPowerNftId) };
    });
    const r = derive(hist);
    console.log(`\n  --- relevé réel : $${r?.usdPerTh?.toFixed(2)} / TH sur ${r?.observations} observations ---`);
    check(r && r.usdPerTh > 11 && r.usdPerTh < 13,
          `relevé réel entre 11 et 13 $ (obtenu ${r?.usdPerTh?.toFixed(2)})`);
    check(r.observations >= 15, `au moins 15 observations (obtenu ${r?.observations})`);
  }
}

const total = pass + fails.length;
if (fails.length) {
  console.error(`\n  ÉCHEC — ${fails.length}/${total} :\n`);
  for (const f of fails) console.error('   ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`\n  OK — ${pass}/${total} vérifications du taux d'upgrade passent.\n`);
