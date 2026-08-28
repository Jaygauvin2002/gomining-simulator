// Vérifie les pourcentages de la ventilation.
//
// Le dépôt est de l'argent qui ENTRE, les autres catégories de l'argent qui SORT.
// Une première version les additionnait dans un même dénominateur : le dépôt de
// Jérémie pesait alors « 50 % » d'un total qui ne représentait rien du tout.
//
// Règle : chaque dépense est une part du total DÉPENSÉ ; le dépôt n'a pas de
// pourcentage, c'est le capital dont le reste est issu.
//
// Usage :  node extension/tests/breakdown-pct.test.mjs

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

let pass = 0; const fails = [];
const check = (c, l) => c ? pass++ : fails.push(l);

// 1. Le dénominateur doit exclure le dépôt, des deux côtés (relevé et manuel).
const denomBlock = (() => {
  const i = HTML.indexOf('const bdSpendTotal');
  return i < 0 ? '' : HTML.slice(i, i + 700);
})();
check(denomBlock.length > 0, 'bdSpendTotal doit exister');
check((denomBlock.match(/cat !== 'deposit'/g) || []).length >= 2,
      'le dépôt doit être exclu du dénominateur pour le relevé ET pour les saisies manuelles');
check(!/const bdTotal\b/.test(HTML), 'l’ancien dénominateur commun ne doit plus exister');

// 2. Le dépôt ne doit porter aucun pourcentage.
check(/cat === 'deposit'[\s\S]{0,60}\?\s*''/.test(HTML),
      'la catégorie deposit doit rendre une étiquette de pourcentage vide');

// 3. Aucun pourcentage non plus quand rien n'a été dépensé — pas de 0/0.
check(/bdSpendTotal <= 0/.test(HTML), 'un total dépensé nul doit supprimer le pourcentage');

// 4. Contrôle arithmétique sur ses vrais chiffres.
{
  const nft = 3484.36, up = 4114.06, lock = 339.88, dep = 7814.70;
  const spend = nft + up + lock;
  const pct = (v) => Math.round(v / spend * 100);
  check(pct(nft) === 44, `Buy NFT = 44 % de la dépense (obtenu ${pct(nft)})`);
  check(pct(up) === 52, `Upgrade TH = 52 % (obtenu ${pct(up)})`);
  check(pct(lock) === 4, `Lock GMT = 4 % (obtenu ${pct(lock)})`);
  check(pct(nft) + pct(up) + pct(lock) === 100, 'les parts de dépense totalisent 100 %');
  // L'ancienne formule, celle qui était fausse :
  const oldPct = Math.round(dep / (spend + dep) * 100);
  check(oldPct === 50, `l'ancienne formule donnait bien 50 % au dépôt (obtenu ${oldPct})`);
  check(pct(nft) !== Math.round(nft / (spend + dep) * 100),
        'la nouvelle formule diffère de l’ancienne — sinon rien n’a changé');
}

// 5. Le texte doit expliquer le dénominateur : un pourcentage sans base annoncée
//    est exactement ce qui a induit en erreur.
check(/shares of what you spent/.test(HTML) && /parts de ce que tu as dépensé/.test(HTML),
      'la note doit dire, en EN et FR, que les pourcentages sont des parts de la dépense');

const total = pass + fails.length;
if (fails.length) {
  console.error(`\n  ÉCHEC — ${fails.length}/${total} :\n`);
  for (const f of fails) console.error('   ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`\n  OK — ${pass}/${total} vérifications de pourcentages passent.\n`);
