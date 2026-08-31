// Vérifie que la saisie manuelle et l'extension coexistent sans que l'une
// écrase l'autre en silence, et que le mur d'authentification se traverse.
//
// Avant : l'extension gagnait TOUJOURS. Elle réécrivait le champ à chaque
// synchro, donc une valeur tapée à la main disparaissait sans un mot. Tant que
// le simulateur était derrière un mur et inutilisable sans extension, ça
// passait. Maintenant qu'on peut s'en servir sans compte ni extension, c'est
// inacceptable dans les deux sens.
//
// Invariant central : une écriture programmatique de .value ne déclenche PAS
// d'événement 'input'. C'est ce qui permet de distinguer une frappe humaine
// d'une écriture automatique sans poser de drapeau à chaque site d'appel — et
// c'est donc ce qu'il faut protéger.
//
// Usage :  node extension/tests/manual-vs-sync.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const APP  = readFileSync(join(root, 'js', 'app.js'), 'utf8');
const HTML = readFileSync(join(root, 'index.html'), 'utf8');
const AUTH = readFileSync(join(root, 'auth.js'), 'utf8');

let pass = 0; const fails = [];
const check = (c, l) => c ? pass++ : fails.push(l);

// --- charger le bloc d'arbitrage, extrait de la source -------------------
function build(initialPins = [], values = {}) {
  const a = APP.indexOf('const PIN_KEY');
  const b = APP.indexOf('// Auto-update discount quand les champs changent');
  if (a < 0 || b < 0 || b < a) throw new Error("bloc d'arbitrage introuvable");
  const block = APP.slice(a, b);

  const store = { [ 'gms_pinned_fields' ]: JSON.stringify(initialPins) };
  // Un vrai <input> convertit toute affectation de .value en chaîne. Le
  // premier stub stockait le nombre brut, et les comparaisons échouaient
  // pour une raison qui n'avait rien à voir avec le code testé.
  const fields = {};
  for (const [k, v] of Object.entries(values)) {
    let cur = String(v);
    fields[k] = { get value() { return cur; }, set value(x) { cur = String(x); } };
  }
  const notice = { hidden: null, className: '', innerHTML: '' };

  const scope = {
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    document: {
      getElementById: id => (id === 'pin-notice' ? notice : (fields[id] || null)),
    },
    t: (k, fb) => fb || k,
    saveSettings: () => {},
    calculate: () => {},
  };
  const names = Object.keys(scope);
  const api = new Function(...names, block +
    '; return { syncField, pinField, unpinAll, keepMine, renderPinNotice, ' +
    'pins: () => [...pinnedFields], pending: () => ({...syncPending}), ARBITRATED };'
  )(...names.map(n => scope[n]));
  return { ...api, fields, notice, store };
}

// --- 1. Champ libre : la synchro écrit ---------------------------------
{
  const { syncField, fields } = build([], { hashrate: '1' });
  check(syncField('hashrate', 698.95) === true, 'la synchro écrit un champ non épinglé');
  check(fields.hashrate.value === '698.95', `valeur écrite (obtenu ${fields.hashrate.value})`);
}

// --- 2. Champ épinglé : la synchro NE touche PAS -----------------------
{
  const { syncField, fields, pending } = build(['hashrate'], { hashrate: '100' });
  check(syncField('hashrate', 698.95) === false, 'la synchro refuse un champ épinglé');
  check(fields.hashrate.value === '100', `la saisie manuelle survit (obtenu ${fields.hashrate.value})`);
  check(pending().hashrate === 698.95, 'mais la valeur de l\'extension est CONSERVÉE, pas jetée');
}

// --- 3. Valeurs identiques : aucun conflit à signaler ------------------
{
  const { syncField, pending, notice } = build(['hashrate'], { hashrate: '698.95' });
  syncField('hashrate', 698.95);
  check(pending().hashrate === undefined, 'pas de conflit quand les deux sources concordent');
  check(notice.hidden === true, 'et donc aucune notice affichée');
}

// --- 4. Le conflit est MONTRÉ, avec les deux valeurs -------------------
{
  const { syncField, notice } = build(['efficiency'], { efficiency: '25' });
  syncField('efficiency', 15);
  check(notice.hidden === false, 'le conflit est affiché');
  check(/25/.test(notice.innerHTML) && /15/.test(notice.innerHTML),
        'les DEUX valeurs sont montrées, pas seulement une');
  check(/unpinAll\(\)/.test(notice.innerHTML), 'un bouton rend la main à l\'extension');
  check(/keepMine\(\)/.test(notice.innerHTML), 'un bouton garde la saisie manuelle');
}

// --- 5. « Utiliser l'extension » applique et désépingle ---------------
{
  const { syncField, unpinAll, fields, pins, pending, notice } =
    build(['hashrate', 'efficiency'], { hashrate: '100', efficiency: '25' });
  syncField('hashrate', 698.95);
  syncField('efficiency', 15);
  unpinAll();
  check(fields.hashrate.value === '698.95', `hashrate appliqué (obtenu ${fields.hashrate.value})`);
  check(fields.efficiency.value === '15', `efficacité appliquée (obtenu ${fields.efficiency.value})`);
  check(pins().length === 0, 'plus rien n\'est épinglé');
  check(Object.keys(pending()).length === 0, 'plus rien en attente');
  check(notice.hidden === true, 'la notice disparaît');
}

// --- 6. « Garder les miennes » masque sans rien changer ---------------
{
  const { syncField, keepMine, fields, pins, notice } = build(['hashrate'], { hashrate: '100' });
  syncField('hashrate', 698.95);
  keepMine();
  check(notice.hidden === true, 'la notice se masque');
  check(fields.hashrate.value === '100', 'la valeur manuelle est intacte');
  check(pins().includes('hashrate'), 'et le champ reste épinglé');
}

// --- 7. Les épingles survivent au rechargement ------------------------
{
  const { pinField, store } = build([], { hashrate: '100' });
  pinField('hashrate');
  check(/hashrate/.test(store['gms_pinned_fields']),
        'l\'épingle est persistée — sinon un rechargement rendrait la main à l\'extension');
  const again = build(JSON.parse(store['gms_pinned_fields']), { hashrate: '100' });
  check(again.syncField('hashrate', 698.95) === false, 'et elle tient après rechargement');
}

// --- 8. Seuls les champs arbitrés s'épinglent -------------------------
{
  const { pinField, pins, ARBITRATED } = build([], {});
  pinField('gmt-prepaid');
  check(pins().length === 0, 'un champ hors périmètre ne s\'épingle pas');
  check(ARBITRATED.length === 4 && ARBITRATED.includes('sat-per-th'),
        `les 4 champs arbitrés incluent sat-per-th (obtenu ${ARBITRATED.join(',')})`);
}

// --- 9. Entrées vides : la synchro ne détruit rien -------------------
{
  const { syncField, fields } = build([], { hashrate: '100' });
  for (const bad of [undefined, null, '']) {
    syncField('hashrate', bad);
    check(fields.hashrate.value === '100', `synchro avec ${JSON.stringify(bad)} ne vide pas le champ`);
  }
}

// --- 10. Garde-fous : plus d'écriture directe dans un champ arbitré ---
// La régression à craindre est un nouveau site de synchro qui écrit
// `.value =` sans passer par syncField, ce qui rétablirait l'écrasement
// silencieux sans qu'aucun test ne le voie.
for (const id of ['hashrate', 'efficiency', 'elec-cost', 'sat-per-th']) {
  const re = new RegExp("getElementById\\('" + id + "'\\)\\.value\\s*=", 'g');
  const hits = (APP.match(re) || []).length;
  check(hits === 0, `aucune écriture directe dans '${id}' hors syncField (${hits} trouvée(s))`);
}
check(/function syncField\(/.test(APP), 'syncField existe');
check((APP.match(/syncField\(/g) || []).length >= 6, 'et elle est utilisée par tous les sites de synchro');

// --- 11. Le mur se traverse, et le choix est mémorisé ----------------
check(/id="gate-guest"/.test(HTML), 'le bouton « sans compte » existe dans le markup');
check(/GUEST_KEY/.test(AUTH) && /function isGuest\(/.test(AUTH), 'le mode invité est implémenté');
{
  // showGate doit court-circuiter pour un invité, sinon le mur revient à
  // chaque visite : un mur avec une porte reste un mur.
  const i = AUTH.indexOf('function showGate()');
  const body = AUTH.slice(i, AUTH.indexOf('function hideGate()'));
  check(/isGuest\(\)/.test(body), 'showGate respecte le mode invité');
  check(body.indexOf('isGuest()') < body.indexOf('style.display = "flex"'),
        'et il le vérifie AVANT d\'afficher le mur');
}
check(/setGuest\(false\)/.test(AUTH),
      'une vraie connexion annule le mode invité — sinon on reste invité à vie');
check(/id="pin-notice"/.test(HTML), 'le conteneur de la notice de conflit existe');

console.log(fails.length
  ? `  ÉCHEC — ${pass} ok, ${fails.length} échec(s)\n` + fails.map(f => '    · ' + f).join('\n')
  : `  OK — ${pass} vérifications arbitrage manuel/extension + mode invité`);
process.exit(fails.length ? 1 : 0);
