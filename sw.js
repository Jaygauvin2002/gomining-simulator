// =============================================================
//  sw.js — Service worker GMSim
// =============================================================
//
//  Remplace un worker AUTO-DESTRUCTEUR qui se désinscrivait et vidait les
//  caches. Il avait été mis là pour tuer un mauvais cache, et il est resté :
//  résultat, la PWA était installable mais sans aucun mode hors-ligne.
//
//  La leçon de ce mauvais cache est intégrée : le HTML n'est JAMAIS servi
//  depuis le cache quand le réseau répond. Un simulateur qui affiche une
//  version périmée de lui-même est pire qu'un simulateur hors-ligne.
//
//    · navigation (HTML)      réseau d'abord, cache en secours hors-ligne
//    · assets versionnés      cache d'abord — l'URL change quand le contenu
//                             change (?v=…), donc un hit ne peut pas être périmé
//    · prix et API externes   réseau uniquement, jamais de cache : un prix
//                             périmé fausse tous les calculs en silence
//
//  Bumper CACHE la version invalide tout l'ancien cache à l'activation.
// =============================================================

const CACHE = 'gmsim-v20260828a';

// Coquille minimale, pour que le hors-ligne marche dès la première visite.
const SHELL = [
    './',
    './index.html',
    './css/tokens.css',
    './css/main.css',
    './css/components.css',
    './icon-192.png',
    './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            // addAll échoue en bloc si un seul fichier manque : on ajoute un
            // par un pour qu'un asset renommé n'empêche pas l'installation.
            .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {}))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Permet à la page de forcer l'activation d'une mise à jour sans rechargement.
self.addEventListener('message', (e) => {
    if (e.data === 'skipWaiting') self.skipWaiting();
});

const isVersionedAsset = (url) =>
    url.searchParams.has('v') && /\.(css|js)$/.test(url.pathname);

const isCacheableStatic = (url) =>
    /\.(css|js|png|jpg|jpeg|svg|webp|woff2?|webmanifest)$/.test(url.pathname);

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Hors de notre origine : prix, Firebase, analytics, polices. On ne
    // s'en mêle pas — un prix mis en cache fausserait chaque calcul.
    if (url.origin !== self.location.origin) return;

    // HTML : réseau d'abord, toujours. Le cache ne sert qu'hors-ligne.
    if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
        event.respondWith(
            fetch(req)
                .then(res => {
                    const copy = res.clone();
                    caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
                    return res;
                })
                .catch(() => caches.match(req)
                    .then(hit => hit || caches.match('./index.html'))
                    .then(hit => hit || new Response(
                        '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
                        '<body style="background:#0a0e14;color:#e6edf3;font:16px system-ui;padding:2rem">' +
                        '<h1>Offline</h1><p>GMSim needs a connection the first time. ' +
                        'Reconnect and reload.</p>',
                        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
                    ))
                )
        );
        return;
    }

    // Assets versionnés : cache d'abord. Sûr parce que l'URL porte la version.
    if (isVersionedAsset(url) || isCacheableStatic(url)) {
        event.respondWith(
            caches.match(req).then(hit => hit || fetch(req).then(res => {
                if (res.ok && res.type === 'basic') {
                    const copy = res.clone();
                    caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
                }
                return res;
            // On arrive ici seulement si le cache était vide (sinon `hit` aurait
            // court-circuité), donc renvoyer `hit` renverrait undefined à
            // respondWith — ce qui lève. Une vraie réponse d'erreur, plutôt.
            }).catch(() => new Response('', { status: 504, statusText: 'Offline' })))
        );
    }
});
