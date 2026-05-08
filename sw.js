// FullSports SW v24 — + periodic background sync + meli.js en shell
const CACHE = 'fs-v24';

// Archivos del app shell a pre-cachear
const SHELL = ['./', './css/main.css', './js/app.js', './js/meli.js', './js/flex-zones.js', './js/config.js', './manifest.json'];

self.addEventListener('install', e => {
  self.skipWaiting();
  // Pre-cachear el shell sin bloquear si alguno falla
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.allSettled(
        SHELL.map(url => fetch(url).then(r => r.ok ? c.put(url, r) : null).catch(() => null))
      )
    )
  );
});

self.addEventListener('activate', e => {
  // Solo borrar caches de versiones anteriores
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('fullsports-v2') && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/fullsports-v2/');
    })
  );
});

// Periodic Background Sync — disponible en Chrome Android con PWA instalada
self.addEventListener('periodicsync', e => {
  if (e.tag !== 'meli-check') return;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Si hay tabs abiertos (en background), les mandamos mensaje para que sincen
      list.forEach(c => c.postMessage({ type: 'MELI_SYNC' }));
    })
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  // No interceptar llamadas a Firebase / Google Auth
  if (url.includes('googleapis.com') || url.includes('accounts.google') ||
      url.includes('firebasejs') || url.includes('firebaseapp.com') ||
      url.includes('firebase.google.com')) return;

  // Network first → actualiza caché → si falla usa caché
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request).then(cached =>
          cached || new Response('Sin conexión — abrí la app con internet al menos una vez', { status: 503 })
        )
      )
  );
});
