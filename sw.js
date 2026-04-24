// FullSports SW v15 — network first, sin problemas de cache
const CACHE = 'fs-v15';

self.addEventListener('install', e => { self.skipWaiting(); });

self.addEventListener('activate', e => {
  // Eliminar todos los caches viejos
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// Sin cache — siempre de red. Evita que versiones viejas queden trabadas.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  if (url.includes('googleapis.com') || url.includes('accounts.google')) return;
  // Pasar todo directo a la red
  e.respondWith(fetch(e.request).catch(() => new Response('Sin conexión', { status: 503 })));
});
