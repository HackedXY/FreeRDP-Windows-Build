// Service worker de SBS MediGest.
// RÈGLE : aucune donnée médicale, financière ou personnelle n'est jamais mise en cache.
//  - /api/* et /socket.io/* : jamais interceptés (réseau direct ; l'API répond en no-store) ;
//  - fichiers /assets/* (JS/CSS versionnés par empreinte, sans donnée) : cache d'abord ;
//  - navigation : réseau d'abord ; hors connexion, page statique « hors ligne » ;
//  - tout le reste (PDF, justificatifs…) : réseau uniquement.
const VERSION = 'sbs-v1';
const STATIC_CACHE = `${VERSION}-static`;
const PRECACHE = ['/offline.html', '/icon-192.png', '/icon-512.png', '/icon.svg', '/manifest.webmanifest'];

/** Stratégie pour une requête : 'bypass' | 'asset' | 'navigate' | 'network'. */
function strategyFor(url, request, origin) {
  if (request.method !== 'GET' || url.origin !== origin) return 'bypass';
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io')) return 'bypass';
  if (request.mode === 'navigate') return 'navigate';
  if (url.pathname.startsWith('/assets/')) return 'asset';
  if (PRECACHE.includes(url.pathname)) return 'asset';
  return 'network';
}

/** Une réponse n'est mise en cache que si elle est publique, complète et réutilisable. */
function cacheable(response) {
  if (!response || response.status !== 200 || response.type !== 'basic') return false;
  const cc = (response.headers.get('Cache-Control') || '').toLowerCase();
  return !cc.includes('no-store') && !cc.includes('private');
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function' && typeof caches !== 'undefined') {
  self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
  });
  self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
  });
  self.addEventListener('message', (event) => {
    // déconnexion : purge de tout cache (par précaution, même s'il ne contient aucune donnée)
    if (event.data === 'purge') event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  });
  self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const s = strategyFor(url, event.request, self.location.origin);
    if (s === 'bypass' || s === 'network') return; // le navigateur traite la requête normalement
    if (s === 'navigate') {
      event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
      return;
    }
    event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request).then((res) => {
      if (cacheable(res)) { const copy = res.clone(); caches.open(STATIC_CACHE).then((c) => c.put(event.request, copy)); }
      return res;
    })));
  });
}

// Exposé pour les tests (sans effet dans le navigateur)
if (typeof module === 'object' && module.exports) module.exports = { strategyFor, cacheable, PRECACHE };
