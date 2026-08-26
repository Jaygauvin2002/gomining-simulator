// Vérifie computeCapital() sur le vrai relevé, en l'extrayant de extractor.js.
// Le chiffre qu'elle produit devient le dénominateur du ROI affiché : s'il est
// faux, tout le Portfolio est faux — comme il l'était avec la saisie manuelle.
//
// Usage :  node extension/tests/capital.test.mjs [chemin-export.json]

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'extractor.js'), 'utf8');

function grab(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} introuvable`);
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error(`${name} non close`);
}

// Les regex de classification sont lues dans la source, pas recopiées.
const pick = (n) => {
  const line = SRC.slice(SRC.indexOf(`const ${n}`)).split('\n')[0];
  const m = line.match(/\/(.*)\/([a-z]*);/);
  if (!m) throw new Error(`regex ${n} illisible`);
  return `const ${n} = /${m[1]}/${m[2]};`;
};

// SPEND_CATEGORY est un objet, pas une regex : on l'extrait par accolades.
const spendCategorySrc = (() => {
  const i = SRC.indexOf('const SPEND_CATEGORY');
  if (i < 0) throw new Error('SPEND_CATEGORY introuvable');
  const end = SRC.indexOf('};', i);
  return SRC.slice(i, end + 2);
})();

const make = (DATA) => new Function('DATA',
  pick('EXTERNAL_IN') + pick('TH_SPEND') + spendCategorySrc + grab('computeCapital') +
  '; return computeCapital;')(DATA);

let pass = 0; const fails = [];
const check = (c, l) => c ? pass++ : fails.push(l);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const wrap = (arr) => ({ rewards: { 'wallet/transaction-history': {
  url: 'https://api.gomining.com/api/wallet/transaction-history',
  data: { data: { array: arr } } } }, miners: {} });

const tx = (o) => ({ id: String(o.id), createdAt: o.at, type: o.type, fromType: o.from,
                     valueNumeric: String(Math.round((o.amt || 0) * 1e18)),
                     walletType: 'VIRTUAL_' + (o.cur || 'GMT'),
                     hasDepositTx: !!o.extIn, hasWithdrawOrder: !!o.extOut });

// 1. Relevé absent → null, jamais 0. Le site doit distinguer « rien » de « inconnu ».
check(make({ rewards: {}, miners: {} })() === null, 'aucun relevé → null');
check(make(wrap([]))() === null, 'relevé vide → null');

// 2. Un dépôt externe en GMT compte tel quel.
{
  const r = make(wrap([tx({ id: 1, at: '2026-01-01T10:00:00Z', type: 'deposit', from: 'fireblocks-deposit', amt: 100, cur: 'GMT', extIn: 1 })]))();
  check(r.gmtEquivalent === 100, `dépôt GMT direct (obtenu ${r.gmtEquivalent})`);
}

// 3. Un achat n'est JAMAIS du capital, quelle que soit sa source.
{
  const r = make(wrap([
    tx({ id: 1, at: '2026-01-01T10:00:00Z', type: 'deposit',  from: 'fireblocks-deposit',  amt: 100, cur: 'GMT', extIn: 1 }),
    tx({ id: 2, at: '2026-02-01T10:00:00Z', type: 'withdraw', from: 'nft-upgrade-power',   amt: 900, cur: 'GMT' }),
    tx({ id: 3, at: '2026-03-01T10:00:00Z', type: 'withdraw', from: 'marketplace-withdraw', amt: 500, cur: 'GMT' }),
  ]))();
  check(r.gmtEquivalent === 100, `un achat ne gonfle pas le capital (obtenu ${r.gmtEquivalent})`);
  check(r.spentOnThGmt === 1400, `dépense en TH additionnée à part (obtenu ${r.spentOnThGmt})`);
}

// 3bis. Un mouvement de type `deposit` mais INTERNE ne doit pas compter.
//       C'est le risque réel, pas l'achat : le relevé contient 27
//       `deposit / asset-conversion` totalisant 18 288 GMT, plus des
//       `deposit / nft-reinvestment`. S'ils passaient pour du capital, le
//       dénominateur du ROI serait faux d'un facteur deux.
{
  const r = make(wrap([
    tx({ id: 1, at: '2026-01-01T10:00:00Z', type: 'deposit', from: 'fireblocks-deposit', amt: 100,   cur: 'GMT', extIn: 1 }),
    tx({ id: 2, at: '2026-02-01T10:00:00Z', type: 'deposit', from: 'asset-conversion',   amt: 18288, cur: 'GMT' }),
    tx({ id: 3, at: '2026-03-01T10:00:00Z', type: 'deposit', from: 'nft-reinvestment',   amt: 8,     cur: 'GMT' }),
    tx({ id: 4, at: '2026-04-01T10:00:00Z', type: 'deposit', from: 'simple-earn-reward', amt: 5,     cur: 'GMT' }),
  ]))();
  check(r.gmtEquivalent === 100,
        `seul le dépôt externe compte, pas les 18 301 GMT internes (obtenu ${r.gmtEquivalent})`);
}

// 4. Le taux vient des conversions de l'utilisateur, appariées à la minute.
{
  const r = make(wrap([
    tx({ id: 1, at: '2026-04-01T12:00:05Z', type: 'withdraw', from: 'asset-conversion', amt: 10, cur: 'SOL' }),
    tx({ id: 2, at: '2026-04-01T12:00:07Z', type: 'deposit',  from: 'asset-conversion', amt: 2800, cur: 'GMT' }),
    tx({ id: 3, at: '2026-05-01T10:00:00Z', type: 'deposit',  from: 'fireblocks-deposit', amt: 5, cur: 'SOL', extIn: 1 }),
  ]))();
  check(near(r.rates.SOL, 280, 0.01), `taux SOL mesuré = 280 (obtenu ${r.rates && r.rates.SOL})`);
  check(near(r.gmtEquivalent, 1400, 0.01), `5 SOL × 280 = 1400 GMT (obtenu ${r.gmtEquivalent})`);
}

// 5. Une devise jamais convertie n'est pas valorisée au doigt mouillé.
{
  const r = make(wrap([tx({ id: 1, at: '2026-01-01T10:00:00Z', type: 'deposit', from: 'fireblocks-deposit', amt: 3, cur: 'DOGE', extIn: 1 })]))();
  check(r.gmtEquivalent === null, `devise sans taux → gmtEquivalent null (obtenu ${r.gmtEquivalent})`);
  check(r.unvalued.DOGE === 3, `montant non valorisé déclaré (obtenu ${r.unvalued && r.unvalued.DOGE})`);
}

// 6. withdrawNetwork ne doit PAS faire une sortie externe — c'est le piège qui
//    aurait produit huit faux retraits sur le relevé réel.
{
  const t = tx({ id: 1, at: '2026-01-01T10:00:00Z', type: 'withdraw', from: 'asset-conversion', amt: 0.5, cur: 'BTC' });
  t.withdrawNetwork = 'BTC';   // présent, mais interne
  const r = make(wrap([t, tx({ id: 2, at: '2026-01-02T10:00:00Z', type: 'deposit', from: 'fireblocks-deposit', amt: 1, cur: 'GMT', extIn: 1 })]))();
  check(r.externalWithdrawals === 0, `withdrawNetwork seul ≠ sortie externe (obtenu ${r.externalWithdrawals})`);
}

// 7. Une vraie sortie externe est comptée.
{
  const r = make(wrap([
    tx({ id: 1, at: '2026-01-01T10:00:00Z', type: 'deposit',  from: 'fireblocks-deposit', amt: 10, cur: 'GMT', extIn: 1 }),
    tx({ id: 2, at: '2026-06-01T10:00:00Z', type: 'withdraw', from: 'user-withdraw',      amt: 4,  cur: 'GMT', extOut: 1 }),
  ]))();
  check(r.externalWithdrawals === 4, `sortie externe comptée (obtenu ${r.externalWithdrawals})`);
}

// 8. Sur le VRAI relevé, si un export est fourni en argument.
const real = process.argv[2];
if (real && existsSync(real)) {
  const d = JSON.parse(readFileSync(real, 'utf8'));
  const e = (d.rewards || {})['wallet/transaction-history'] || (d.miners || {})['wallet/transaction-history'];
  if (e) {
    const r = make({ rewards: { 'wallet/transaction-history': e }, miners: {} })();
    console.log(`\n  --- relevé réel : ${r.txCount} transactions ---`);
    console.log(`      dépôts externes : ${JSON.stringify(r.deposits)}`);
    console.log(`      taux mesurés    : ${JSON.stringify(Object.fromEntries(Object.entries(r.rates).map(([k, v]) => [k, +v.toFixed(2)])))}`);
    console.log(`      capital         : ${r.gmtEquivalent ? r.gmtEquivalent.toFixed(0) + ' GMT' : 'non valorisable'}`);
    console.log(`      non valorisé    : ${JSON.stringify(r.unvalued)}`);
    console.log(`      sorties externes: ${r.externalWithdrawals}`);
    console.log(`      dépensé en TH   : ${r.spentOnThGmt.toFixed(0)} GMT`);
    check(r.gmtEquivalent > 0, 'relevé réel → capital non nul');
    check(r.externalWithdrawals === 0, 'relevé réel → aucune sortie externe (attendu pour ce compte)');
    check(r.spentOnThGmt > 15000, `relevé réel → dépense TH > 15000 GMT (obtenu ${r.spentOnThGmt.toFixed(0)})`);
  }
}

// 9. Ventilation par catégorie : c'est ce qui remplit le Breakdown sans saisie.
{
  const r = make(wrap([
    tx({ id: 1, at: '2026-01-01T10:00:00Z', type: 'deposit',  from: 'fireblocks-deposit',   amt: 100, cur: 'GMT', extIn: 1 }),
    tx({ id: 2, at: '2026-02-01T10:00:00Z', type: 'withdraw', from: 'marketplace-withdraw', amt: 500, cur: 'GMT' }),
    tx({ id: 3, at: '2026-03-01T10:00:00Z', type: 'withdraw', from: 'nft-upgrade-power',    amt: 300, cur: 'GMT' }),
    tx({ id: 4, at: '2026-04-01T10:00:00Z', type: 'withdraw', from: 've-gomining-lock',     amt: 50,  cur: 'GMT' }),
    // Ceux-ci ne doivent atterrir dans AUCUNE catégorie : ce sont des échanges de
    // devise et des revenus, pas des emplois d'argent.
    tx({ id: 5, at: '2026-05-01T10:00:00Z', type: 'deposit',  from: 'asset-conversion',     amt: 9000, cur: 'GMT' }),
    tx({ id: 6, at: '2026-05-02T10:00:00Z', type: 'deposit',  from: 'nft-reinvestment',     amt: 7,   cur: 'GMT' }),
    tx({ id: 7, at: '2026-05-03T10:00:00Z', type: 'withdraw', from: 'internal-payment',     amt: 3,   cur: 'GMT' }),
  ]))();
  const c = r.byCategory || {};
  check(c.deposit?.gmt === 100, `catégorie deposit (obtenu ${c.deposit?.gmt})`);
  check(c.nft?.gmt === 500,     `catégorie nft (obtenu ${c.nft?.gmt})`);
  check(c.upgrade?.gmt === 300, `catégorie upgrade (obtenu ${c.upgrade?.gmt})`);
  check(c.lock?.gmt === 50,     `catégorie lock (obtenu ${c.lock?.gmt})`);
  check(c.nft?.txCount === 1,   `nombre de tx par catégorie (obtenu ${c.nft?.txCount})`);
  const totalCat = Object.values(c).reduce((a, x) => a + x.gmt, 0);
  check(totalCat === 950,
        `les mouvements internes restent hors ventilation : 950 attendu, obtenu ${totalCat}`);
}

// 10. Une devise sans taux ne doit pas être valorisée au hasard dans la ventilation.
{
  const r = make(wrap([tx({ id: 1, at: '2026-01-01T10:00:00Z', type: 'withdraw', from: 'nft-upgrade-power', amt: 4, cur: 'DOGE' })]))();
  check(!(r.byCategory.upgrade?.gmt > 0), 'devise sans taux → pas valorisée dans la catégorie');
  check(r.categoryUnvalued?.DOGE === 4, `montant non valorisé déclaré (obtenu ${r.categoryUnvalued?.DOGE})`);
}

const total = pass + fails.length;
if (fails.length) {
  console.error(`\n  ÉCHEC — ${fails.length}/${total} :\n`);
  for (const f of fails) console.error('   ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`\n  OK — ${pass}/${total} vérifications capital passent.\n`);
