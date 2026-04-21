// SW mínimo — limpia caches viejos, no cachea nada nuevo
// Esto evita que Android sirva contenido desactualizado
const CACHE_V = 'fs-v5';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// Sin fetch handler → todo va directo a la red (sin cache stale)
