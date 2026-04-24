// FullSports SW v12 — compat SDK cacheado
const CACHE = 'fs-v12';
const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';

const SHELL = [
  './',
  './index.html',
  './css/main.css',
  './js/app.js',
  './js/flex-zones.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  FB + 'firebase-app-compat.js',
  FB + 'firebase-auth-compat.js',
  FB + 'firebase-firestore-compat.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Solo excluir APIs en tiempo real de Firestore/Auth (streams, no cacheables)
  if (url.includes('googleapis.com') || url.includes('accounts.google')) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      const fresh = fetch(e.request).then(resp => {
        if (resp && resp.status === 200)
          caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
        return resp;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});
