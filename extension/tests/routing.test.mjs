// Vérifie les décisions de routage de extractor.js contre des URLs réelles,
// relevées dans de vrais exports de l'extension.
//
// Pourquoi ce fichier existe : le correctif du 2026-08-26 était incomplet.
// Retirer /nft-income de l'allowlist des mineurs ne suffisait pas — le repli
// « loose » le rattrapait parce que son payload contient les mots "miner" et
// "nft". Lire les regex ne l'avait pas montré ; les rejouer contre les données
// réelles, oui. Ce test rend cette vérification reproductible.
//
// Il lit les regex DANS extractor.js — pas des copies — pour qu'une
// modification du fichier soit forcément couverte.
//
// Usage :  node extension/tests/routing.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'extractor.js'), 'utf8');

// ---------- extraction des regex depuis la source ----------
function grabRegex(label, anchor) {
  const i = SRC.indexOf(anchor);
  if (i < 0) throw new Error(`ancrage introuvable pour ${label} : ${anchor}`);
  const line = SRC.slice(i, SRC.indexOf('\n', i));
  const m = line.match(/\/(.*)\/([a-z]*)\s*(?:\.test\(url\))?\s*;?\s*$/);
  if (!m) throw new Error(`regex illisible pour ${label} : ${line.trim().slice(0, 120)}`);
  return new RegExp(m[1], m[2] || '');
}

const ALLOW  = grabRegex('SOLO_ALLOWLIST',  'const SOLO_ALLOWLIST = ');
const DENY   = grabRegex('HARD_DENYLIST',   'const HARD_DENYLIST = ');
const SOLO   = grabRegex('isSoloMinerUrl',  'const isSoloMinerUrl = ');
const MW     = grabRegex('isMwUrl',         'const isMwUrl = ');

const storable = (u) => !DENY.test(u) && ALLOW.test(u);

// Le repli « loose » de analyzeResponse. On n'en réécrit PAS la logique : on
// extrait la condition telle qu'elle est dans la source et on l'évalue. Une
// première version de ce test recopiait la condition à la main — elle passait
// donc même avec le bug remis en place, ce qui ne servait à rien.
function extractLooseCondition() {
  // On repère le bloc par son log, puis on remonte au `} else if (` qui le
  // précède : ancrer sur le premier `} else if (` du fichier attrapait la
  // branche SSE, plus haut dans handleInterceptedMessage.
  const marker = SRC.indexOf("'Données mineur (loose): '");
  if (marker < 0) throw new Error('log du repli loose introuvable');
  const i = SRC.lastIndexOf('} else if (', marker);
  if (i < 0) throw new Error('repli loose introuvable');
  const open = SRC.indexOf('(', i);
  let depth = 0, end = -1;
  for (let j = open; j < SRC.length; j++) {
    const c = SRC[j];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) { end = j; break; } }
  }
  if (end < 0) throw new Error('condition du repli loose non close');
  return SRC.slice(open + 1, end);
}

const LOOSE_COND = extractLooseCondition();
const looseEval = new Function('isMwUrl', 'str', 'url', 'return (' + LOOSE_COND + ');');

function looseFallback(url, bodyHasMiner, bodyHasNft, bodyHasThs) {
  const words = [];
  if (bodyHasMiner) words.push('miner');
  if (bodyHasNft) words.push('nft');
  if (bodyHasThs) words.push('th/s');
  const str = { includes: (w) => words.includes(w) };
  return !!looseEval(MW.test(url), str, url);
}

// ---------- fixtures : URLs relevées dans de vrais exports ----------
const API = 'https://api.gomining.com/api/';

const MUST_STORE = [
  API + 'nft/get-my',
  API + 'wallet/find-by-user',
  API + 'user/get-my-nft-discount',
  API + 'user/get-total-income-values',
  API + 'nft-income/find-aggregated-by-date',
  API + 'nft-income/find-aggregated-by-date?from=2026-07-01',
  API + 'nft-income-aggregation/get-last',
  API + 'home-page/get-info-v2',
  API + 'nft/my-computing-power-chart',
  API + 'nft/get-power-upgrade-info',
  API + 'nft/get-upgrade-rate',
  API + 've-gomining-lock/find-by-user',
  API + 've-gomining-lock/statistics',
  API + 'exchanges/getTokenPrice',
];

// Tout ce qui suit a réellement été capté par une version antérieure.
const MUST_REJECT = [
  API + 'auth/isAuth-v2',                                   // e-mail, IP, KYC, JWT vivant
  '../../../assets/i18n/en.json?v=1787571113367',            // 464 Ko de traductions
  API + 'nft-collection/index',                              // 406 Ko, puissances trompeuses
  API + 'banner-configuration/find-all',
  API + 'achievement-template/index',
  API + 'academy/course/find-all',
  API + 'config/ab-tests/get-user-info',
  API + 'bonus-cashback-miner/get',
  API + 'wallet/transaction-history',
  'https://api.bonus-miner.gomining.com/api/bonus-miner/client/find-one',
  'https://internal-api.btc-loans.gomining.com/api/loan-api/v2/loans/positions',
  'https://internal-api.btc-loans.gomining.com/api/loan-api/v2/loans/total-debt',
  'https://api.gomining-notification-server.gmt.io/api/promos-notification/client/notification/get',
  'https://api.se.gomining.com/api/simple-earn/user/get',
  'https://config.ton.org/wallets-v2.json',
];

// Ne doivent jamais atterrir dans les pools solo (bug historique des 2 M TH).
const MW_URLS = [
  API + 'nft-game/nft-game-income/find-aggregated-by-date',
  API + 'clan-leaderboard/index',
  API + 'clan/get-by-id',
  'wss://ws.gomining.com:443/socket.io/?EIO=4&transport=websocket',
];

// ---------- exécution ----------
let pass = 0;
const fails = [];
const check = (cond, label) => cond ? pass++ : fails.push(label);

for (const u of MUST_STORE) check(storable(u), `devrait être stocké : ${u}`);
for (const u of MUST_REJECT) check(!storable(u), `NE devrait PAS être stocké : ${u}`);
for (const u of MW_URLS)     check(MW.test(u),  `devrait être reconnu Miner Wars : ${u}`);

// L'historique ne doit pas être dupliqué dans DATA.miners : ni par l'allowlist
// solo, ni par le repli « loose ». C'est précisément ce que le premier
// correctif avait manqué.
const HIST = API + 'nft-income/find-aggregated-by-date';
check(!SOLO.test(HIST), 'historique : ne doit pas passer par isSoloMinerUrl');
check(!looseFallback(HIST, true, true, false),
      'historique : ne doit pas passer par le repli loose (son payload contient "miner" et "nft")');
check(storable(HIST), 'historique : doit rester stockable (il va dans DATA.rewards)');

// nft/get-my doit, lui, rester dans les pools solo.
check(SOLO.test(API + 'nft/get-my'), 'nft/get-my doit passer par isSoloMinerUrl');

// La coupe à 30 jours doit être appliquée au STOCKAGE, pas seulement à la synchro.
check(/keepFrom/.test(SRC) && /MAX_HISTORY_DAYS \* 24 \* 3600 \* 1000/.test(SRC),
      'la fusion de l’historique doit élaguer à MAX_HISTORY_DAYS');

// prices.raw ne doit être gardé que pour une vraie source de prix.
check(/isPriceSource/.test(SRC), 'prices.raw doit être restreint aux sources de prix');

// ---------- rapport ----------
const total = pass + fails.length;
if (fails.length) {
  console.error(`\n  ÉCHEC — ${fails.length}/${total} vérifications en échec :\n`);
  for (const f of fails) console.error('   ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`\n  OK — ${pass}/${total} vérifications de routage passent.\n`);
