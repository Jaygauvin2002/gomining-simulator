// Vérifie que le Portfolio est redessiné quand la synchro arrive.
//
// Le symptôme : la ventilation affichait « d'après tes saisies manuelles » alors
// que le relevé était bien capté, la bonne version d'extension chargée et les
// données en mémoire. La cause n'était pas dans le calcul — updatePortfolio()
// n'était appelé QUE lors du passage sur l'onglet. Un utilisateur déjà dessus
// regardait un rendu antérieur à l'arrivée des données, indéfiniment.
//
// Leçon : calculer juste ne sert à rien si rien ne redemande le rendu.
//
// Usage :  node extension/tests/portfolio-refresh.test.mjs

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

// Le bloc de fin de synchro : celui qui suit « // Recalculate ».
// Ancrage précis : « // Recalculate » seul sur sa ligne. Une première version
// prenait la première occurrence du texte, qui tombait sur le commentaire
// « // Recalculate everything: token discount changes… » mille lignes plus haut —
// le test échouait alors même que le code était correct.
const tail = (() => {
  const m = HTML.match(/\n\s*\/\/ Recalculate\n[\s\S]{0,900}/);
  return m ? m[0] : '';
})();

check(tail.length > 0, 'le bloc de fin de synchro doit exister');
check(/calcTotalDiscount\(\)/.test(tail), 'la synchro doit recalculer les remises');
check(/calculate\(\)/.test(tail), 'la synchro doit relancer le calcul');
check(/updatePortfolio\(\)/.test(tail),
      'la synchro doit AUSSI redessiner le Portfolio — sinon ses données arrivent sans être affichées');

// L'appel doit être défensif : updatePortfolio touche beaucoup de DOM, et une
// exception ici ferait échouer toute la synchro, y compris ce qui a déjà réussi.
check(/typeof updatePortfolio === 'function'/.test(tail),
      'l’appel doit vérifier que la fonction existe');
check(/try \{ updatePortfolio\(\); \} catch/.test(tail),
      'l’appel doit être protégé : une erreur d’affichage ne doit pas casser la synchro');

// Et le chemin d'origine doit rester : passer sur l'onglet redessine toujours.
check(/if \(name === 'portfolio'\) updatePortfolio\(\);/.test(HTML),
      'le rendu au changement d’onglet doit être conservé');

const total = pass + fails.length;
if (fails.length) {
  console.error(`\n  ÉCHEC — ${fails.length}/${total} :\n`);
  for (const f of fails) console.error('   ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`\n  OK — ${pass}/${total} vérifications de rafraîchissement passent.\n`);
