// Vérifie le guide de scan : la liste vivante qui dit quelle page GoMining
// ouvrir pour débloquer quoi.
//
// Pourquoi il existe : chaque automatisation dépend d'un endpoint, et chaque
// endpoint n'est appelé que sur SA page. Un utilisateur resté sur « My miners » a
// une puissance juste et un historique vide, sans que rien ne le lui dise. Ça a
// coûté plusieurs allers-retours pendant la mise au point — l'utilisateur n'a pas
// l'export JSON pour s'en rendre compte.
//
// Usage :  node extension/tests/scan-guide.test.mjs [export.json]

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(here, '..', '..', 'index.html'), 'utf8');
const SRC  = readFileSync(join(here, '..', 'extractor.js'), 'utf8');

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

let pass = 0; const fails = [];
const check = (c, l) => c ? pass++ : fails.push(l);

// ---------- côté extension ----------
const computeCoverage = (DATA) =>
  new Function('DATA', grab(SRC, 'computeCoverage') + '; return computeCoverage;')(DATA)();

const entry = (url) => ({ url, data: {} });

// 1. Chaque clé doit refléter la présence de SON endpoint, pas d'un autre.
{
  const c = computeCoverage({ miners: { a: entry('https://api.gomining.com/api/nft/get-my') }, rewards: {} });
  check(c.miners === true, 'nft/get-my → miners coché');
  check(c.rewards === false, 'sans find-aggregated-by-date, rewards reste décoché');
  check(c.transactions === false, 'sans relevé, transactions reste décoché');
}

// 2. Tous les endpoints présents → tout coché.
{
  const urls = [
    'https://api.gomining.com/api/nft/get-my',
    'https://api.gomining.com/api/nft-income/find-aggregated-by-date',
    'https://api.gomining.com/api/wallet/transaction-history',
    'https://api.gomining.com/api/wallet/find-by-user',
    'https://api.gomining.com/api/ve-gomining-lock/find-by-user',
    'https://api.bonus-miner.gomining.com/api/bonus-miner/client/find-one',
    'https://api.gomining.com/api/home-page/get-info-v2',
    'https://api.gomining.com/api/user/get-my-nft-discount',
  ];
  const pool = {}; urls.forEach((u, i) => pool['k' + i] = entry(u));
  const c = computeCoverage({ miners: pool, rewards: {} });
  check(Object.values(c).every(Boolean), `tout coché (obtenu ${JSON.stringify(c)})`);
}

// 3. Pools vides ou absents : tout décoché, pas d'exception.
{
  let threw = false, c;
  try { c = computeCoverage({}); } catch { threw = true; }
  check(!threw && Object.values(c).every(v => v === false), 'pools absents → tout décoché sans exception');
}

// ---------- côté site ----------
check(/SCAN_TARGETS/.test(HTML), 'la liste des cibles doit exister');
check(/renderScanChecklist/.test(HTML), 'le rendu doit exister');
check(/state\.coverage = data\.coverage/.test(HTML), 'la couverture doit être lue depuis la synchro');
check(/gms_coverage/.test(HTML), 'la couverture doit être persistée');

// 4. Une cible sans chemin vérifié ne doit PAS être transformée en lien :
//    envoyer quelqu'un sur une URL devinée est pire que de ne pas l'envoyer.
check(/path: null/.test(HTML), 'au moins une cible doit avoir path: null (page non vérifiée)');
check(/target\.path\s*\n?\s*\?/.test(HTML) || /target\.path[\s\S]{0,40}\?/.test(HTML),
      'le lien ne doit être créé que si un chemin existe');

// 5. Sans extension, l'état doit être « inconnu », pas « pas fait ».
check(/scan_note_none/.test(HTML), 'un message doit couvrir l’absence d’extension');
check(/'unknown'|\bunknown\b/.test(HTML), 'un état « inconnu » distinct doit exister');

// 6. Les chemins liés doivent être ceux réellement observés dans les captures.
for (const p of ['/nft-miners', '/nft-rewards/solo', '/finance/wallets/virtual/overview/transactions']) {
  check(HTML.includes(p), `le chemin vérifié ${p} doit être présent`);
}

// 7. Sur un export réel, la couverture doit correspondre au contenu.
const real = process.argv[2];
if (real && existsSync(real)) {
  const d = JSON.parse(readFileSync(real, 'utf8'));
  const c = computeCoverage({ miners: d.miners || {}, rewards: d.rewards || {} });
  const urls = JSON.stringify([...Object.values(d.miners || {}), ...Object.values(d.rewards || {})]
    .map(x => x?.url || ''));
  console.log(`\n  --- export réel : ${Object.entries(c).filter(([, v]) => v).map(([k]) => k).join(', ')} ---`);
  check(c.miners === /nft\/get-my/.test(urls), 'miners cohérent avec l’export');
  check(c.transactions === /transaction-history/.test(urls), 'transactions cohérent avec l’export');
  check(c.rewards === /find-aggregated-by-date/.test(urls), 'rewards cohérent avec l’export');
}

const total = pass + fails.length;
if (fails.length) {
  console.error(`\n  ÉCHEC — ${fails.length}/${total} :\n`);
  for (const f of fails) console.error('   ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`\n  OK — ${pass}/${total} vérifications du guide de scan passent.\n`);
