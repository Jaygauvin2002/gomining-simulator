// Vérifie l'accessibilité clavier de la navigation, les icônes du manifest,
// la stratégie du service worker, et le câblage des champs qui étaient captés
// sans jamais être affichés.
//
// Contexte : la nav était faite de onze <div onclick> avec zéro tabindex —
// impossible de changer d'onglet sans souris. Le manifest déclarait trois fois
// un JPEG renommé .png à des tailles qu'il n'avait pas. Et sw.js se
// désinscrivait lui-même, séquelle d'un mauvais cache, donc la PWA n'avait
// aucun mode hors-ligne.
//
// Usage :  node extension/tests/a11y-pwa.test.mjs

import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
// Le cœur de l'app a été extrait de index.html vers js/app.js le 2026-08-28.
// On lit donc l'UNION des deux : les tests cherchent du code et du markup, et
// l'app est la somme. Écrit ainsi, une prochaine extraction ne cassera pas
// onze suites d'un coup — il suffira d'ajouter le fichier à la liste.
const APP_SOURCES = ['index.html', 'js/app.js', 'js/strategy-lab.js', 'js/efficiency-calc.js'];
const HTML = APP_SOURCES
  .map(f => { try { return readFileSync(join(root, ...f.split('/')), 'utf8'); } catch { return ''; } })
  .join('\n');
const SW   = readFileSync(join(root, 'sw.js'), 'utf8');
const MAN  = JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));
const CSS  = ['components.css', 'main.css', 'tokens.css', 'efficiency-calc.css']
  .map(f => readFileSync(join(root, 'css', f), 'utf8')).join('\n');

let pass = 0; const fails = [];
const check = (c, l) => c ? pass++ : fails.push(l);

// --- 1. Navigation au clavier -------------------------------------------
const navItems = [...HTML.matchAll(/<div class="nav-item(?: active)?"[^>]*>/g)].map(m => m[0]);
check(navItems.length === 11, `11 onglets trouvés (obtenu ${navItems.length})`);
check(navItems.every(t => /role="tab"/.test(t)), 'chaque onglet porte role="tab"');
check(navItems.every(t => /tabindex="(0|-1)"/.test(t)), 'chaque onglet porte un tabindex');
check(navItems.every(t => /aria-selected="(true|false)"/.test(t)), 'chaque onglet porte aria-selected');

// Le motif ARIA veut UN SEUL arrêt de tabulation pour la liste.
const zeros = navItems.filter(t => /tabindex="0"/.test(t)).length;
check(zeros === 1, `exactement un tabindex="0" au chargement (obtenu ${zeros})`);
// Et cet onglet doit être celui qui est actif.
const active = navItems.find(t => /class="nav-item active"/.test(t));
check(active && /tabindex="0"/.test(active) && /aria-selected="true"/.test(active),
      'l\'onglet actif est celui qui est focusable');

check(/role="tablist"/.test(HTML) && /aria-label="Sections"/.test(HTML),
      'le conteneur est un tablist nommé');

// aria-controls doit pointer vers un panneau qui EXISTE — sinon l'annonce du
// lecteur d'écran désigne le vide.
for (const t of navItems) {
  const id = (t.match(/aria-controls="([^"]+)"/) || [])[1];
  check(id && HTML.includes(`id="${id}"`), `aria-controls="${id}" désigne un panneau existant`);
}
check((HTML.match(/role="tabpanel"/g) || []).length === 11, 'les 11 panneaux sont des tabpanel');
// Les panneaux contiennent des champs : leur donner tabindex ajouterait un
// arrêt de tabulation vide avant chaque contenu.
check(!/role="tabpanel" tabindex/.test(HTML), 'les panneaux ne prennent pas de tabindex');

// Le clavier doit être réellement branché, pas seulement les attributs.
check(/function initTabKeyboard\(/.test(HTML), 'initTabKeyboard existe');
check(/initTabKeyboard\(\);/.test(HTML), 'et elle est appelée au démarrage');
for (const k of ['Enter', 'ArrowRight', 'ArrowLeft', 'Home', 'End']) {
  check(HTML.includes(`'${k}'`), `la touche ${k} est gérée`);
}
// Focusable sans anneau visible = accessible en théorie, aveugle en pratique.
check(/\.nav-item:focus-visible/.test(CSS), 'un anneau de focus visible existe pour les onglets');

// --- 2. Icônes du manifest : vrais PNG, vraies tailles ------------------
function pngSize(file) {
  const b = readFileSync(join(root, file));
  const isPng = b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG';
  if (!isPng) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
check(MAN.icons.length >= 3, `au moins 3 icônes déclarées (obtenu ${MAN.icons.length})`);
for (const ic of MAN.icons) {
  check(existsSync(join(root, ic.src)), `${ic.src} existe`);
  const dim = pngSize(ic.src);
  check(dim !== null, `${ic.src} est un VRAI PNG, pas un JPEG renommé`);
  if (dim) {
    const [w, h] = ic.sizes.split('x').map(Number);
    check(dim.w === w && dim.h === h,
          `${ic.src} mesure vraiment ${ic.sizes} (réel ${dim.w}x${dim.h})`);
  }
}
check(MAN.icons.some(i => (i.purpose || '').includes('maskable')), 'une icône maskable est déclarée');
check(MAN.icons.some(i => (i.purpose || '').includes('any')), 'une icône « any » est déclarée');

// Les logos affichés en petit ne doivent plus tirer le fichier de 1024 px.
check(!/<img src="icon\.png"/.test(HTML), 'plus de logo affiché depuis icon.png (282 Ko pour 50 px)');
check(statSync(join(root, 'icon-192.png')).size < 60 * 1024,
      `icon-192.png reste léger (${(statSync(join(root, 'icon-192.png')).size / 1024).toFixed(0)} Ko)`);

// --- 3. Service worker : le HTML n'est jamais servi périmé --------------
check(!/registration\.unregister|r\.unregister\(\)/.test(SW), 'sw.js ne s\'auto-détruit plus');
check(/self\.location\.origin/.test(SW) && /url\.origin !== self\.location\.origin/.test(SW),
      'les origines externes sont ignorées — un prix mis en cache fausserait tout');
{
  // Dans la branche navigation, fetch() doit venir AVANT caches.match :
  // c'est toute la garantie contre le retour du mauvais cache.
  const navBranch = SW.slice(SW.indexOf("req.mode === 'navigate'"), SW.indexOf('Assets versionnés'));
  const iFetch = navBranch.indexOf('fetch(req)');
  const iCache = navBranch.indexOf('caches.match');
  check(iFetch >= 0 && iCache > iFetch, 'HTML : réseau d\'abord, cache seulement en secours');
}
check(/CACHE\s*=\s*'gmsim-v/.test(SW), 'le cache est versionné');
check(/keys\.filter\(k => k !== CACHE\)/.test(SW), 'les anciens caches sont purgés à l\'activation');
check(/navigator\.serviceWorker\.register\('sw\.js'\)/.test(HTML), 'sw.js est enregistré par la page');
check(!/regs\.forEach\(r => r\.unregister\(\)\)/.test(HTML), 'la page ne désinscrit plus tout');

// --- 4. Les champs captés sont enfin affichés --------------------------
for (const [f, label] of [
  ['minerCount', 'le nombre de mineurs'],
  ['efficiencyPartial', 'le drapeau de moyenne partielle'],
  ['prPerThSource', 'la provenance du PR'],
  ['gmtPriceSource', 'la provenance du prix GMT'],
  ['btcPriceSource', 'la provenance du prix BTC'],
  ['c2PerTh', 'la composante de frais C2 de GoMining'],
]) check(HTML.includes(f), `${label} (${f}) est lu par le site`);
check(/vegmt-yield/.test(HTML), 'le rendement annuel veGMT est affiché');
check(/yearlyIncomePerVote/.test(HTML), 'et il retombe sur yearlyIncomePerVote si besoin');

// --- 5. Le texte explicatif n'est plus dans la plus petite police -----
check(/--fs-note/.test(CSS), 'un token dédié au texte explicatif existe');
check(!/font-size:0\.72em/.test(HTML), 'plus de 0,72em codé en dur dans les sous-lignes');
{
  const m = CSS.match(/--fs-note:\s*([\d.]+)rem/);
  check(m && parseFloat(m[1]) >= 0.75, `--fs-note vaut au moins 12px (lu ${m && m[1]}rem)`);
}

console.log(fails.length
  ? `  ÉCHEC — ${pass} ok, ${fails.length} échec(s)\n` + fails.map(f => '    · ' + f).join('\n')
  : `  OK — ${pass} vérifications accessibilité / PWA / données`);
process.exit(fails.length ? 1 : 0);
