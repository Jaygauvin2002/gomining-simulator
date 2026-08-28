// Vérifie l'indicateur de fraîcheur des récompenses.
//
// GoMining écrit l'enregistrement d'un jour le LENDEMAIN. Le 27, le jour complet
// le plus récent POSSIBLE est le 26 : `staleDays = 1` est donc parfaitement à
// jour, et 2 signifie qu'il manque UN jour.
//
// L'ancien message affichait « Data 2d old — reopen GoMining to refresh » à un
// utilisateur qui venait de rouvrir GoMining à 11h04. Ce n'est pas GoMining qu'il
// faut rouvrir, c'est la page Rewards — la seule qui porte cette donnée.
//
// Usage :  node extension/tests/staleness.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(here, '..', '..', 'index.html'), 'utf8');

let pass = 0; const fails = [];
const check = (c, l) => c ? pass++ : fails.push(l);

// 1. Le décalage inhérent d'un jour doit être retiré avant de juger.
check(/const missing = Math\.max\(0, staleDays - 1\)/.test(HTML),
      'le jour de décalage inhérent doit être soustrait');

// 2. Trois paliers, pas deux : à jour, un jour de retard, vraiment décroché.
check(/missing >= 3/.test(HTML), 'le rouge doit être réservé à 3 jours manquants ou plus');
check(/missing >= 1/.test(HTML), 'un palier intermédiaire doit exister');
check(/'sync-dot warn'/.test(HTML), 'le palier intermédiaire doit être ambre, pas rouge');

// 3. Le message doit nommer la page Rewards, et non « rouvre GoMining ».
// Les libellés français contiennent des apostrophes échappées (\'), donc un
// `[^']*` naïf coupe le message avant sa fin — la première version de ce test
// échouait pour cette seule raison, sur du code correct.
const msgs = HTML.match(/sync_(?:stale|behind): '(?:[^'\\]|\\.)*'/g) || [];
check(msgs.length === 4, `4 libellés attendus (EN+FR × 2 paliers), trouvés ${msgs.length}`);
check(msgs.every(m => /Rewards/i.test(m)),
      'chaque message doit nommer la page Rewards');
check(!msgs.some(m => /reopen GoMining|rouvre GoMining/i.test(m)),
      'aucun message ne doit plus dire seulement « rouvre GoMining »');

// 4. Et il doit donner la DATE du dernier jour connu, pas un compteur à
//    interpréter — « 2 jours » ne dit pas s'il en manque un ou deux.
check(msgs.every(m => m.includes('{d}')),
      'chaque message doit interpoler la date du dernier jour');
check(!/sync_stale[^']*'\{n\}/.test(HTML), 'l’ancien compteur {n} ne doit plus être utilisé');

// 5. Rejouer les paliers.
const grade = (staleDays) => {
  const missing = Math.max(0, staleDays - 1);
  return missing >= 3 ? 'stale' : missing >= 1 ? 'warn' : 'live';
};
check(grade(0) === 'live', 'aucun retard → vert');
check(grade(1) === 'live', 'un jour d’écart = à jour (décalage inhérent) → vert');
check(grade(2) === 'warn', 'deux jours d’écart = un jour manquant → ambre');
check(grade(3) === 'warn', 'trois jours → ambre');
check(grade(4) === 'stale', 'quatre jours = trois manquants → rouge');
check(grade(30) === 'stale', 'un mois → rouge');

// 5bis. Les DEUX indicateurs doivent partager la même arithmétique.
//
//       La pastille du calendrier annonçait « Last solo sync: 2 days ago » quand
//       la pastille de synchro, corrigée, disait « un jour de retard ». Deux
//       indicateurs côte à côte, deux vérités — celui qui les lit ne peut que
//       douter des deux.
{
  const occurrences = (HTML.match(/Math\.max\(0, (?:staleDays|days) - 1\)/g) || []).length;
  check(occurrences >= 2,
        `le décalage d'un jour doit être retiré dans les DEUX indicateurs (trouvé ${occurrences})`);
  check(/hist_missing_pre/.test(HTML),
        'la pastille du calendrier doit annoncer les jours MANQUANTS, pas l’ancienneté brute');
  check(!/hist_recent/.test(HTML.replace(/\/\/[^\n]*/g, '')),
        'l’ancien libellé « Last solo sync: N days ago » ne doit plus être utilisé');
}

// 6. Le style du palier ambre doit exister, sinon la pastille est invisible.
const CSS = readFileSync(join(here, '..', '..', 'css', 'components.css'), 'utf8');
check(/\.sync-dot\.warn/.test(CSS), 'la classe .sync-dot.warn doit être stylée');

const total = pass + fails.length;
if (fails.length) {
  console.error(`\n  ÉCHEC — ${fails.length}/${total} :\n`);
  for (const f of fails) console.error('   ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`\n  OK — ${pass}/${total} vérifications de fraîcheur passent.\n`);
