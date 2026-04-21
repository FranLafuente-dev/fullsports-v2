const CACHE = 'fullsports-v3';
const BASE = '/fullsports-v2';
const ASSETS = [
  `${BASE}/`,
  `${BASE}/index.html`,
  `${BASE}/css/main.css`,
  `${BASE}/js/app.js`,
  `${BASE}/js/config.js`,
  `${BASE}/js/flex-zones.js`,
  `${BASE}/manifest.json`,
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {})));
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
  if (e.request.url.includes('firestore') || e.request.url.includes('googleapis') || e.request.url.includes('gstatic')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).catch(() => caches.match(`${BASE}/index.html`)))
  );
});
