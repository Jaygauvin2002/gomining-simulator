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
const RATE_WINDOW = (() => {
  const m = SRC.match(/const RATE_WINDOW = (\d+)/);
  if (!m) throw new Error('RATE_WINDOW introuvable');
  return parseInt(m[1], 10);
})();
const derive = new Function(
  'const TH_REINVEST_BONUS = 0.05; const RATE_WINDOW = ' + RATE_WINDOW + ';'
  + grab(SRC, 'deriveUpgradeRate') + '; return deriveUpgradeRate;')();

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
  // `observations` compte désormais la FENÊTRE retenue, `totalObservations` le
  // total — ces deux assertions visaient l'ancien sens du champ.
  check(r.totalObservations === 7, `7 observations au total dont l'aberration (obtenu ${r.totalObservations})`);
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

// 5bis. Le taux doit suivre le MARCHÉ, pas la moyenne d'une longue période.
//
//       C'est le défaut qui a persisté : la médiane sur deux mois renvoyait
//       12,08 $ — la valeur de juillet — alors que le taux était tombé à ~10,19 $.
//       Le calendrier restait faux malgré la déduction.
{
  const d = [];
  // 20 jours à 12 $/TH…
  for (let i = 0; i < 20; i++) {
    const day1 = String(1 + i).padStart(2, '0');
    d.push(day(`2026-07-${day1}`, 100 + i * 0.175, 2 / 78000));
  }
  // …puis 5 jours à 10 $/TH (delta plus grand pour le même revenu).
  for (let i = 0; i < 6; i++) {
    const day1 = String(1 + i).padStart(2, '0');
    d.push(day(`2026-08-${day1}`, 200 + i * 0.21, 2 / 78000));
  }
  const r = derive(d);
  check(Math.abs(r.usdPerTh - 10) < 0.3,
        `le taux doit refléter les jours récents, pas les anciens (obtenu ${r.usdPerTh.toFixed(2)})`);
  check(r.observations <= RATE_WINDOW,
        `au plus ${RATE_WINDOW} observations retenues (obtenu ${r.observations})`);
  check(r.totalObservations > RATE_WINDOW,
        'le total des observations reste rapporté pour information');
}

// 6. Côté site : plus aucun nombre magique dans le calcul du calendrier.
check(/upgradeRate\(\)/.test(HTML), 'le site doit passer par upgradeRate()');
check(!/day\.valueBtc \* btcRef \/ 12\.34/.test(HTML), 'le 12,34 codé en dur du calendrier doit avoir disparu');
check(/state\.upgradeRateUsd/.test(HTML), 'le taux déduit doit être consommé');
check(/dataset\.userEdited !== '1'/.test(HTML), 'une valeur saisie par l’utilisateur ne doit pas être écrasée');
check(/const TH_BONUS = 0\.05/.test(HTML), 'le bonus doit être une constante nommée, pas un 1.05 dispersé');

// 6bis. Et pour un jour PASSÉ, on mesure au lieu d'estimer : la puissance du
//       lendemain moins celle du jour donne les TH ajoutés, sans taux ni bonus.
check(/function observedThGain/.test(HTML), 'observedThGain doit exister');
check(/const observed = observedThGain\(day\.date\)/.test(HTML),
      'la cellule TH doit préférer la mesure à l’estimation');
check(/valueText = '~'/.test(HTML),
      'une valeur estimée doit être marquée d’un tilde, pas présentée comme mesurée');

// 6ter. La valeur de remplacement doit afficher SA COMPOSITION.
//
//       Le 2026-08-28 elle est passée de 8 939 $ à 7 434 $ : −17 %, uniquement
//       parce que le prix du TH était tombé de 12,34 à 10,18 $. Les TH étaient
//       inchangés. Un total qui bouge sans dire de quoi il est fait se lit comme
//       une perte.
check(/port-asset-sub/.test(HTML), 'la carte doit avoir une sous-ligne de composition');
check(/thNow\.toFixed\(2\)\} TH × \$\{formatUSD\(thCost\)/.test(HTML),
      'la sous-ligne doit montrer les TH ET le prix unitaire utilisé');
{
  // Rejeu : à TH constants, seul le prix explique l'écart.
  const th = 696.8184, bal = 340;
  const v = (cost) => th * cost + bal;
  check(Math.abs(v(12.34) - 8938.74) < 1, `12,34 $ → 8 939 $ (obtenu ${v(12.34).toFixed(0)})`);
  check(Math.abs(v(10.18) - 7433.61) < 1, `10,18 $ → 7 434 $ (obtenu ${v(10.18).toFixed(0)})`);
  check(Math.abs((v(10.18) / v(12.34) - 1) * 100 + 16.8) < 0.5,
        'l’écart de −17 % s’explique entièrement par le prix');
}

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
    check(r.totalObservations >= 15, `au moins 15 observations au total (obtenu ${r?.totalObservations})`);
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
