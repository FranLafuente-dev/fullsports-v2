// FullSports SW v27 — tarifas FLEX 1/7, fix corte, despacho PE, limite query, refresh visual
const CACHE       = 'fs-v27';
const BG_STATE    = 'meli-bg-state-v1';
const WORKER_BASE = 'https://meli-test.lafuentefranciscolucas.workers.dev';

const SHELL = ['./', './css/main.css', './js/app.js', './js/meli.js', './js/flex-zones.js', './js/config.js', './manifest.json'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.allSettled(
        SHELL.map(url => fetch(url).then(r => r.ok ? c.put(url, r) : null).catch(() => null))
      )
    )
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      // Borrar caches viejos pero conservar el estado de bg (meli-bg-state-v1)
      Promise.all(keys.filter(k => k !== CACHE && k !== BG_STATE).map(k => caches.delete(k)))
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

async function _getBgState() {
  try {
    const c = await caches.open(BG_STATE);
    const r = await c.match('state.json');
    return r ? r.json() : null;
  } catch(e) { return null; }
}

async function _doMeliBgCheck() {
  const state = await _getBgState();
  if (!state?.savedAt) return;
  // Estado muy viejo (>2h): tokens pueden haber expirado, el Worker los renueva pero por seguridad
  if (Date.now() - state.savedAt > 2 * 60 * 60 * 1000) return;

  const knownIds   = new Set(state.knownIds   || []);
  const ignoredIds = new Set(state.ignoredIds || []);
  let newCount = 0;

  const accounts = [['capi', state.capiUserId], ['enano', state.enanoUserId]]
    .filter(([, uid]) => uid);

  for (const [acct, userId] of accounts) {
    try {
      const tokRes = await fetch(`${WORKER_BASE}/api/token/${acct}`);
      if (!tokRes.ok) continue;
      const tokData = await tokRes.json();
      if (!tokData?.token) continue;

      const ordRes = await fetch(
        `${WORKER_BASE}/api/meli/orders/search?seller=${userId}&limit=50&sort=date_desc`,
        { headers: { Authorization: `Bearer ${tokData.token}` } }
      );
      if (!ordRes.ok) continue;
      const data = await ordRes.json();

      const cutoff = Date.now() - 72 * 3600 * 1000;
      const dispatched = new Set(['shipped', 'delivered', 'not_delivered', 'cancelled']);
      for (const o of (data.results || [])) {
        if (o.status !== 'paid') continue;
        if (new Date(o.date_created).getTime() < cutoff) continue;
        if (dispatched.has(o.shipping?.status)) continue;
        const effId = o.pack_id ? String(o.pack_id) : String(o.id);
        const oid   = String(o.id);
        if (knownIds.has(effId) || knownIds.has(oid) || ignoredIds.has(effId) || ignoredIds.has(oid)) continue;
        newCount++;
      }
    } catch(e) {}
  }

  if (newCount > 0) {
    await self.registration.showNotification('FullSports — Pedidos nuevos 🔔', {
      body: `${newCount} pedido${newCount > 1 ? 's' : ''} sin cargar`,
      icon:     'icons/icon-192.png',
      badge:    'icons/badge.svg',
      tag:      'meli-bg-orders',
      renotify: true,
    });
  }
}

// Periodic Background Sync — Chrome Android con PWA instalada
self.addEventListener('periodicsync', e => {
  if (e.tag !== 'meli-check') return;
  e.waitUntil((async () => {
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (list.length) {
      // Hay tabs abiertos: pedirles que sincen (tienen Firebase Auth y datos frescos)
      list.forEach(c => c.postMessage({ type: 'MELI_SYNC' }));
    } else {
      // App completamente cerrada: hacer el check directamente desde el SW
      await _doMeliBgCheck();
    }
  })());
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  if (url.includes('googleapis.com') || url.includes('accounts.google') ||
      url.includes('firebasejs') || url.includes('firebaseapp.com') ||
      url.includes('firebase.google.com')) return;
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
