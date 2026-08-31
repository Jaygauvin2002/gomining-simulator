// Vérifie le seuil de version de l'extension et sa comparaison.
//
// Deux façons de se tromper ici, et les deux envoient l'utilisateur dans un
// mur :
//   · un seuil qui exige une version que le store ne SERT pas encore affiche
//     une bannière « mets à jour » vers une fiche qui propose l'ancienne ;
//   · une comparaison faite sur des chaînes déclare 4.10 plus vieux que 4.6.
//
// Usage :  node extension/tests/ext-version.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const APP = readFileSync(join(root, 'js', 'app.js'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));

const MIN = (APP.match(/const MIN_EXT_VERSION\s*=\s*'([^']+)'/) || [])[1];

function grab(name) {
  const start = APP.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} introuvable`);
  let depth = 0;
  for (let i = APP.indexOf('{', start); i < APP.length; i++) {
    if (APP[i] === '{') depth++;
    else if (APP[i] === '}') { depth--; if (depth === 0) return APP.slice(start, i + 1); }
  }
  throw new Error(`${name} non close`);
}
// Extraite de la source, pas réécrite.
const outdated = new Function('MIN_EXT_VERSION',
  grab('extVersionOutdated') + '; return extVersionOutdated;')(MIN);

const cmp = (v) => {
  const a = String(v).split('.').map(Number), b = MIN.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
};

let pass = 0; const fails = [];
const check = (c, l) => c ? pass++ : fails.push(l);

check(!!MIN, `MIN_EXT_VERSION est lisible (obtenu ${MIN})`);

// --- 1. Le seuil ne doit jamais dépasser ce que le dépôt produit ---------
// Exiger une version qui n'existe pas encore dans le manifest, c'est
// promettre au store quelque chose qu'il ne peut pas servir.
check(cmp(MANIFEST.version) >= 0,
      `le manifest (${MANIFEST.version}) est au moins au niveau du seuil (${MIN})`);

// --- 2. La version exacte du seuil passe -------------------------------
check(outdated(MIN) === false, `${MIN} n'est pas périmée`);

// --- 3 & 4. Les cas sont DÉRIVÉS du seuil, pas codés en dur ------------
// Une première version listait '4.6.1' parmi les versions récentes : vrai
// face à un seuil de 4.6, faux dès qu'il est passé à 4.7. Le test cassait
// à chaque relèvement, pour rien. On construit les cas depuis le seuil.
const [maj, min] = MIN.split('.').map(Number);

for (const v of [`${maj - 1}.${min}`, `${maj}.${min - 1}`, `${maj}.${min - 1}.9`, '1.0']) {
  check(outdated(v) === true, `${v} est périmée face à ${MIN}`);
}
for (const v of [`${maj}.${min + 1}`, `${maj + 1}.0`, `${maj}.${min}.1`, `${maj + 10}.0`]) {
  check(outdated(v) === false, `${v} n'est pas périmée face à ${MIN}`);
}

// --- 5. Le piège des chaînes ------------------------------------------
// '4.10' < '4.7' en comparaison textuelle. Numériquement, 10 > 7. Une
// extension au-delà du dixième mineur ne doit PAS se voir dire de se
// mettre à jour. Le cas n'a de sens que si le seuil est sous 10.
if (min < 10) {
  const trap = `${maj}.10`;
  check(outdated(trap) === false,
        `${trap} est PLUS RÉCENTE que ${MIN} — piège de la comparaison de chaînes`);
  check(trap < MIN, `la comparaison textuelle se trompe bien sur ${trap} vs ${MIN}`);
}

// --- 6. Absence de version : périmée, jamais une exception -------------
for (const v of [undefined, null, '', 0, false]) {
  let threw = false, r;
  try { r = outdated(v); } catch { threw = true; }
  check(!threw, `${JSON.stringify(v)} ne jette pas`);
  check(r === true, `${JSON.stringify(v)} compte comme périmée (build pré-2.0)`);
}

// --- 7. Saletés diverses : ne jamais jeter -----------------------------
for (const v of ['abc', '4.x', '..', '4..6', ' 4.6 ']) {
  let threw = false;
  try { outdated(v); } catch { threw = true; }
  check(!threw, `${JSON.stringify(v)} ne jette pas`);
}

// --- 8. L'URL du store est celle de la vraie fiche ---------------------
check(/llchhkfpkjbkiabpofbpfilicpbnihhp/.test(APP),
      'EXT_STORE_URL pointe sur l\'identifiant réel de l\'extension');

console.log(fails.length
  ? `  ÉCHEC — ${pass} ok, ${fails.length} échec(s)\n` + fails.map(f => '    · ' + f).join('\n')
  : `  OK — ${pass} vérifications du seuil de version (seuil ${MIN}, manifest ${MANIFEST.version})`);
process.exit(fails.length ? 1 : 0);
