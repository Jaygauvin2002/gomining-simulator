// Vérifie la persistance du capital externe, extraite de index.html.
//
// Pourquoi ça existe : le relevé de transactions brut est purgé par l'extension
// au bout de 24 h — c'est ce que la politique de confidentialité annonce, et on
// ne va pas la contredire pour du confort. On garde donc le RÉSULTAT du calcul.
//
// Le risque, c'est la régression silencieuse : une visite qui ne touche pas la
// page des transactions ne voit que quelques lignes. Si elle écrasait un calcul
// fondé sur tout l'historique, l'utilisateur devrait refaire défiler des dizaines
// de pages — exactement ce qu'on cherche à éviter.
//
// Usage :  node extension/tests/capital-persist.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(here, '..', '..', 'index.html'), 'utf8');

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

const mergeCapital = new Function(grab('mergeCapital') + '; return mergeCapital;')();

let pass = 0; const fails = [];
const check = (c, l) => c ? pass++ : fails.push(l);

const full    = { txCount: 121, gmtEquivalent: 23705, source: 'transaction-history' };
const partial = { txCount: 5,   gmtEquivalent: 1200,  source: 'transaction-history' };

// 1. Le cas qui motive tout : une visite partielle ne doit rien écraser.
check(mergeCapital(full, partial).gmtEquivalent === 23705,
      `une mesure sur 5 tx ne doit pas écraser celle sur 121 (obtenu ${mergeCapital(full, partial).gmtEquivalent})`);

// 2. Mais un scan plus complet doit bien prendre le dessus.
check(mergeCapital(partial, full).gmtEquivalent === 23705,
      'une mesure plus complète doit remplacer la précédente');

// 3. À égalité, la nouvelle gagne — c'est la plus fraîche, et les dépôts bougent.
{
  const a = { txCount: 121, gmtEquivalent: 23705 };
  const b = { txCount: 121, gmtEquivalent: 24900 };
  check(mergeCapital(a, b).gmtEquivalent === 24900, 'à txCount égal, la plus récente gagne');
}

// 4. Premier calcul : rien en mémoire.
check(mergeCapital(null, full).gmtEquivalent === 23705, 'aucun stocké → on prend le nouveau');

// 5. Une synchro sans capital ne doit rien détruire. C'est le cas courant :
//    la plupart des visites ne passent pas par la page des transactions.
check(mergeCapital(full, null).gmtEquivalent === 23705, 'incoming null → on garde le stocké');
check(mergeCapital(full, undefined).gmtEquivalent === 23705, 'incoming undefined → on garde le stocké');
check(mergeCapital(null, null) === null, 'rien de part et d’autre → null');

// 6. txCount absent ne doit pas faire tomber la comparaison.
{
  const noCount = { gmtEquivalent: 999 };
  check(mergeCapital(full, noCount).gmtEquivalent === 23705,
        'sans txCount, on ne remplace pas une mesure complète');
  check(mergeCapital(noCount, full).gmtEquivalent === 23705,
        'sans txCount côté stocké, une mesure complète passe');
}

// 6bis. Un schéma plus ancien ne doit JAMAIS gagner, même avec plus de
//       transactions. C'était le piège : un capital sur 121 tx calculé avant
//       l'existence de `byCategory` battait éternellement un calcul récent sur
//       moins de lignes, et la ventilation ne pouvait plus jamais se remplir.
{
  const oldSchema = { txCount: 121, gmtEquivalent: 23705 };                     // sans byCategory
  const newSchema = { txCount: 9, gmtEquivalent: 900, byCategory: { nft: { gmt: 500, txCount: 1 } } };
  check(mergeCapital(oldSchema, newSchema).byCategory !== undefined,
        'un calcul récent avec ventilation doit battre un ancien sans, même sur moins de tx');
  check(mergeCapital(newSchema, oldSchema).byCategory !== undefined,
        'et l’inverse : un ancien sans ventilation ne doit pas écraser un récent qui en a');
}

// 6ter. À schémas égaux, on retombe sur la règle du nombre de transactions.
{
  const a = { txCount: 121, gmtEquivalent: 23705, byCategory: { nft: { gmt: 10569, txCount: 10 } } };
  const b = { txCount: 9,   gmtEquivalent: 900,   byCategory: { nft: { gmt: 500, txCount: 1 } } };
  check(mergeCapital(a, b).gmtEquivalent === 23705,
        'deux objets ventilés : le plus complet gagne (obtenu ' + mergeCapital(a, b).gmtEquivalent + ')');
}

// 7. Le câblage doit être là : chargement au boot et sauvegarde à la synchro.
check(/state\.capital = loadCapital\(\)/.test(HTML), 'le capital doit être chargé au démarrage');
check(/saveCapital\(state\.capital\)/.test(HTML), 'le capital doit être sauvegardé après fusion');
check(/mergeCapital\(state\.capital, data\.capital\)/.test(HTML),
      'la synchro doit passer par mergeCapital, pas écraser directement');

const total = pass + fails.length;
if (fails.length) {
  console.error(`\n  ÉCHEC — ${fails.length}/${total} :\n`);
  for (const f of fails) console.error('   ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`\n  OK — ${pass}/${total} vérifications de persistance passent.\n`);
