// Vérifie que l'origine de chaque prix est tracée ET dite, et que le cœur de
// l'app n'est plus inline.
//
// Avant : FALLBACK_BTC = 80000 et FALLBACK_GMT = 0.30, écrits dans le code,
// maintenus à la main (« updated 2026-05-07 ») et servis EN SILENCE. Si les
// quatre API échouaient, l'app rendait un dashboard complet — profit, ROI,
// projections, Portfolio — sur un prix inventé, sans rien dire. Même faute
// que le prix du TH figé à 12,34 $ pendant des mois.
//
// Usage :  node extension/tests/price-origin.test.mjs

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const HTML = readFileSync(join(root, 'index.html'), 'utf8');
const APP  = readFileSync(join(root, 'js', 'app.js'), 'utf8');
const SW   = readFileSync(join(root, 'sw.js'), 'utf8');
const SRC  = HTML + '\n' + APP;

function grab(name, src = SRC) {
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

// --- 1. renderPriceOrigin, exécutée ------------------------------------
// Trois états, et ils ne se valent pas. On les exerce vraiment.
function render(origin) {
  const el = { hidden: null, className: '', textContent: '' };
  const fn = new Function('document', 'state', 't', grab('renderPriceOrigin') + '; return renderPriceOrigin;')(
    { getElementById: (id) => (id === 'price-origin' ? el : null) },
    { priceOrigin: origin },
    (k, fb) => fb || k
  );
  fn();
  return el;
}

{
  // Tout va bien → rien ne s'affiche. Une bannière permanente n'est plus lue.
  const ok = render({ btc: 'binance', gmt: 'coingecko', ageMs: null, mempool: true });
  check(ok.hidden === true, `prix en direct → bannière masquée (obtenu hidden=${ok.hidden})`);
}
{
  // Prix inventé → le plus fort niveau, et il faut le dire sans détour.
  const bad = render({ btc: 'fallback', gmt: 'fallback', ageMs: null, mempool: true });
  check(bad.hidden === false, 'prix inventé → bannière visible');
  check(/price-origin--bad/.test(bad.className), `niveau « bad » (obtenu "${bad.className}")`);
  check(/placeholder/i.test(bad.textContent), 'le mot « placeholder » apparaît');
  check(/meaningless/i.test(bad.textContent),
        'et le texte dit que les chiffres dérivés ne veulent rien dire');
  check(/BTC/.test(bad.textContent) && /GMT/.test(bad.textContent), 'les deux prix sont nommés');
}
{
  // Un seul des deux inventé : nommer celui-là, pas les deux.
  const one = render({ btc: 'fallback', gmt: 'coingecko', ageMs: null, mempool: true });
  check(/BTC/.test(one.textContent) && !/GMT/.test(one.textContent),
        `seul BTC est nommé (obtenu "${one.textContent.slice(0, 70)}")`);
}
{
  // En cache : utilisable, mais on donne l'âge — c'est la différence entre
  // « périmé et je le sais » et « inventé ».
  const stale = render({ btc: 'cached', gmt: 'cached', ageMs: 3 * 3600000, mempool: true });
  check(/price-origin--warn/.test(stale.className), 'niveau « warn », pas « bad »');
  check(/3 h/.test(stale.textContent), `l'âge est donné (obtenu "${stale.textContent.slice(-30)}")`);
  const fresh = render({ btc: 'cached', gmt: 'cached', ageMs: 60000, mempool: true });
  check(/under an hour/i.test(fresh.textContent), 'moins d\'une heure est dit en mots');
}
{
  // mempool en panne : le PR retombe sur la dernière valeur synchronisée.
  const nm = render({ btc: 'binance', gmt: 'coingecko', ageMs: null, mempool: false });
  check(nm.hidden === false && /Pool Reward/.test(nm.textContent),
        'la difficulté indisponible est signalée aussi');
}
{
  // Pas d'origine connue du tout : masquer, ne pas inventer un message.
  check(render(null).hidden === true, 'sans origine → masqué, pas de message inventé');
}

// --- 2. Un prix de repli ne doit JAMAIS être mémorisé ------------------
// Sinon il devient « le dernier prix connu » à la visite suivante et le
// mensonge se rend permanent.
{
  const i = APP.indexOf('PRICE_CACHE_KEY, JSON.stringify(');
  check(i > 0, 'le prix est bien mis en cache quelque part');
  const guard = APP.slice(Math.max(0, i - 400), i);
  check(/!==\s*'fallback'/.test(guard), 'la mise en cache est gardée contre un prix de repli');
  check(/!==\s*'cached'/.test(guard), 'et contre un prix déjà en cache — pas de rafraîchissement de son âge');
}
check(/state\.priceOrigin\s*=/.test(APP), 'l\'origine est enregistrée dans state');
check(/renderPriceOrigin\(\);/.test(APP), 'et rendue après chaque récupération');

// --- 3. Le stockage qui échoue le dit -------------------------------
// Viser le CODE, pas la phrase : le commentaire qui explique la correction
// cite légitimement l'ancienne ligne, et une recherche de texte brut la
// retrouvait dans sa propre documentation.
check(!/catch\s*\(e\)\s*\{\s*\/\* quota exceeded — ignore \*\/\s*\}/.test(SRC),
      'plus de catch qui avale le quota en silence');
check(/function persist\(/.test(APP), 'un helper persist() centralise l\'écriture');
check(/QuotaExceededError/.test(APP), 'le quota est distingué des autres échecs');
check(/renderStorageWarning/.test(APP), 'et l\'échec est affiché');
{
  // Ne JAMAIS amputer l'historique pour faire de la place : celui d'un joueur
  // Miner Wars est irremplaçable, et une coupe a déjà failli détruire 5 semaines.
  const fn = grab('saveRewardHistory');
  check(/persist\(/.test(fn), 'saveRewardHistory passe par persist()');
  check(!/slice|splice|shift|pop/.test(fn), 'et ne coupe rien en cas d\'échec');
}

// --- 4. Le cœur de l'app n'est plus inline ---------------------------
{
  const inline = [...HTML.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(m => !/ld\+json/.test(m[1]))
    .map(m => m[2].length);
  const biggest = Math.max(0, ...inline);
  check(biggest < 40_000,
        `plus de gros bloc inline — le plus gros fait ${(biggest / 1024).toFixed(1)} Ko (était 320)`);
  const size = statSync(join(root, 'index.html')).size;
  check(size < 220 * 1024, `index.html sous 220 Ko (obtenu ${(size / 1024).toFixed(0)} Ko, était 489)`);
}
check(/<script src="js\/app\.js\?v=/.test(HTML), 'app.js est référencé AVEC une version');
{
  // L'ordre compte : app.js doit venir APRÈS les deux modules, comme le bloc
  // inline qu'il remplace — ils déclaraient des fonctions qu'il appelle au boot.
  const iLab = HTML.indexOf('js/strategy-lab.js');
  const iEff = HTML.indexOf('js/efficiency-calc.js');
  const iApp = HTML.indexOf('js/app.js');
  check(iLab > 0 && iEff > iLab && iApp > iEff, 'ordre strategy-lab → efficiency-calc → app');
}
check(/'\.\/js\/app\.js'/.test(SW), 'le service worker précharge app.js');

console.log(fails.length
  ? `  ÉCHEC — ${pass} ok, ${fails.length} échec(s)\n` + fails.map(f => '    · ' + f).join('\n')
  : `  OK — ${pass} vérifications origine des prix / stockage / extraction`);
process.exit(fails.length ? 1 : 0);
