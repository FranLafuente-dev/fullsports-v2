// FullSports SW v19 — network first + cache fallback para offline
const CACHE = 'fs-v19';

// Archivos del app shell a pre-cachear
const SHELL = ['./', './css/main.css', './js/app.js', './js/flex-zones.js', './manifest.json'];

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
