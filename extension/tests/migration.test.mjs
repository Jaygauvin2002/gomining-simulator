// Vérifie que la migration de l'historique de récompenses est SANS PERTE.
//
// Le correctif de datation a décalé les dates d'un jour : les entrées v1 étaient
// datées de createdAt (la date d'écriture GoMining), le jour miné est la veille.
// La première version de ce changement JETAIT le stockage v1. C'était un mauvais
// choix : le décalage est déterministe, donc réparable exactement, et un
// utilisateur qui avait accumulé plus de jours que l'extension n'en retient
// perdait la différence pour de bon.
//
// Règle à tenir : migrer, pas jeter.
//
// Usage :  node extension/tests/migration.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(here, '..', '..', 'index.html'), 'utf8');

function grab(name) {
  const start = HTML.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} introuvable`);
  let depth = 0;
  for (let i = HTML.indexOf('{', start); i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}') { depth--; if (depth === 0) return HTML.slice(start, i + 1); }
  }
  throw new Error(`${name} non close`);
}

const migrate = new Function(grab('migrateRewardHistoryV1toV2') + '; return migrateRewardHistoryV1toV2;')();

let pass = 0; const fails = [];
const check = (c, l) => c ? pass++ : fails.push(l);

// 1. Rien ne doit disparaître, et chaque date recule d'un jour.
{
  const v1 = [
    { date: '2026-07-03', power: 452.3, poolReward: 0.00021, partial: false },
    { date: '2026-07-04', power: 452.5, poolReward: 0.00021, partial: false },
    { date: '2026-08-26', power: 690.3, poolReward: 0.00034, partial: true },
  ];
  const out = migrate(v1);
  check(out.length === 3, `aucun jour perdu (${out.length}/3)`);
  check(out.map(d => d.date).join(',') === '2026-07-02,2026-07-03,2026-08-25',
        `dates reculées d'un jour (obtenu ${out.map(d => d.date).join(',')})`);
  check(out[2].power === 690.3 && out[2].poolReward === 0.00034,
        'les mesures du jour sont conservées intactes');
  check(out.every(d => d.partial === false),
        'le drapeau partial est recalculé, plus hérité de l’ancienne datation');
}

// 2. Le passage d'année doit être correct.
{
  const out = migrate([{ date: '2026-01-01' }]);
  check(out[0].date === '2025-12-31', `passage d'année (obtenu ${out[0].date})`);
}

// 3. Tri croissant, quel que soit l'ordre d'entrée.
{
  const out = migrate([{ date: '2026-08-26' }, { date: '2026-07-03' }, { date: '2026-08-01' }]);
  const dates = out.map(d => d.date);
  check(String(dates) === String([...dates].sort()), `trié croissant (${dates})`);
}

// 4. Entrées invalides ignorées, sans exception.
{
  let threw = false, out = [];
  try { out = migrate([{ date: 'pas-une-date' }, {}, null, { date: '2026-05-05' }]); } catch { threw = true; }
  check(!threw, 'aucune exception sur des entrées invalides');
  check(out.length === 1 && out[0].date === '2026-05-04', `seule l'entrée valide survit (${out.length})`);
}

// 5. Doublons de date après décalage : une seule entrée conservée.
{
  const out = migrate([{ date: '2026-06-02', power: 1 }, { date: '2026-06-02', power: 2 }]);
  check(out.length === 1, `dates identiques dédoublonnées (${out.length})`);
}

// 6. Vide ou absent : pas d'exception.
for (const [label, input] of [['tableau vide', []], ['null', null], ['undefined', undefined]]) {
  let threw = false, out;
  try { out = migrate(input); } catch { threw = true; }
  check(!threw && Array.isArray(out) && out.length === 0, `${label} → tableau vide sans exception`);
}

// 7. Le câblage : loadRewardHistory doit MIGRER un stockage non versionné,
//    pas le supprimer. C'est le cœur de la leçon.
check(/migrateRewardHistoryV1toV2\(raw\)/.test(HTML),
      'loadRewardHistory doit appeler la migration sur un stockage v1');
check(!/localStorage\.removeItem\(RH_KEY\)/.test(HTML),
      'loadRewardHistory ne doit plus supprimer purement et simplement l’historique');

const total = pass + fails.length;
if (fails.length) {
  console.error(`\n  ÉCHEC — ${fails.length}/${total} :\n`);
  for (const f of fails) console.error('   ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`\n  OK — ${pass}/${total} vérifications de migration passent.\n`);
