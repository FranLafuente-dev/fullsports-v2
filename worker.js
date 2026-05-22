const MELI_API = 'https://api.mercadolibre.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── KV helpers ───────────────────────────────────────────────────────────────────
async function kvGet(kv, key) {
  try { return await kv.get(key, 'json'); } catch { return null; }
}
async function kvPut(kv, key, value, opts = {}) {
  try { await kv.put(key, JSON.stringify(value), opts); } catch {}
}
async function kvDel(kv, key) {
  try { await kv.delete(key); } catch {}
}

// ── Lock best-effort en KV (TTL garantiza que nunca queda trabado) ────────────────
const LOCK_TTL = 20; // segundos
async function tryAcquireLock(kv, account) {
  const existing = await kvGet(kv, `lock:${account}`);
  if (existing && (Date.now() - existing.at) < LOCK_TTL * 1000) return false;
  await kvPut(kv, `lock:${account}`, { at: Date.now() }, { expirationTtl: LOCK_TTL });
  return true;
}
async function releaseLock(kv, account) { await kvDel(kv, `lock:${account}`); }

// ── Obtener token válido (con refresh si es necesario) ────────────────────────────
async function getValidToken(kv, account) {
  const stored = await kvGet(kv, `token:${account}`);
  if (!stored) return { ok: false, reason: 'no_token' };

  // Token aún válido: devolver siempre con refreshToken (el cron puede haberlo rotado)
  if ((stored.expiresAt || 0) > Date.now() + 5 * 60 * 1000) {
    return { ok: true, token: stored.token, expiresAt: stored.expiresAt, refreshToken: stored.refreshToken };
  }

  // Token expirado: intentar obtener el lock para refrescar
  const gotLock = await tryAcquireLock(kv, account);
  if (!gotLock) {
    // Otra instancia ya está refrescando — esperar y devolver lo que guardó
    await new Promise(r => setTimeout(r, 7000));
    const fresh = await kvGet(kv, `token:${account}`);
    if (fresh && (fresh.expiresAt || 0) > Date.now() + 60000) {
      return { ok: true, token: fresh.token, expiresAt: fresh.expiresAt };
    }
    // Si después de esperar sigue expirado, devolver el que tenemos (mejor que nada)
    return { ok: true, token: stored.token, expiresAt: stored.expiresAt, stale: true, refreshToken: stored.refreshToken };
  }

  try {
    // Doble-check: puede que otra instancia haya refrescado entre el kvGet y el lock
    const recheck = await kvGet(kv, `token:${account}`);
    if (recheck && (recheck.expiresAt || 0) > Date.now() + 60000) {
      return { ok: true, token: recheck.token, expiresAt: recheck.expiresAt, refreshToken: recheck.refreshToken };
    }

    const cfg = await kvGet(kv, 'config');
    if (!stored.refreshToken || !cfg?.appId) {
      return { ok: false, reason: 'missing_credentials' };
    }

    const params = new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     cfg.appId,
      refresh_token: stored.refreshToken,
    });
    if (cfg.secret) params.set('client_secret', cfg.secret);

    const res  = await fetch(`${MELI_API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params,
    });
    const data = await res.json();

    if (!res.ok || !data.access_token) {
      // Refresh fallido: devolver token actual aunque esté expirado (mejor que null)
      return { ok: false, reason: data.error || 'refresh_failed', token: stored.token };
    }

    const newToken = {
      token:        data.access_token,
      refreshToken: data.refresh_token || stored.refreshToken,
      expiresAt:    Date.now() + (data.expires_in * 1000) - 120000,
    };
    await kvPut(kv, `token:${account}`, newToken, { expirationTtl: 2592000 }); // 30 días — refresh_token dura meses
    return { ok: true, token: newToken.token, expiresAt: newToken.expiresAt, refreshToken: newToken.refreshToken };
  } finally {
    await releaseLock(kv, account);
  }
}

// ── Refresh proactivo — llamado por el cron cada hora ────────────────────────────
// Renueva el token si vence en menos de 5 horas, sin esperar a que un cliente lo pida.
// Garantiza que el KV siempre tenga tokens frescos aunque todos los dispositivos estén cerrados.
async function proactiveRefresh(kv, account) {
  const stored = await kvGet(kv, `token:${account}`);
  if (!stored?.refreshToken) return; // cuenta no configurada
  if ((stored.expiresAt || 0) > Date.now() + 5 * 60 * 60 * 1000) return; // más de 5h restantes

  const gotLock = await tryAcquireLock(kv, account);
  if (!gotLock) return; // otro Worker ya está refrescando

  try {
    // Doble-check: otra instancia puede haber refrescado entre el read y el lock
    const recheck = await kvGet(kv, `token:${account}`);
    if (recheck && (recheck.expiresAt || 0) > Date.now() + 5 * 60 * 60 * 1000) return;

    const cfg = await kvGet(kv, 'config');
    if (!cfg?.appId) return;

    const params = new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     cfg.appId,
      refresh_token: stored.refreshToken,
    });
    if (cfg.secret) params.set('client_secret', cfg.secret);

    const res  = await fetch(`${MELI_API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params,
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) return; // fallo → el siguiente cron reintentará

    await kvPut(kv, `token:${account}`, {
      token:        data.access_token,
      refreshToken: data.refresh_token || stored.refreshToken,
      expiresAt:    Date.now() + (data.expires_in * 1000) - 120000,
    }, { expirationTtl: 2592000 });
  } catch(_) {
    // Error de red → el siguiente cron reintentará
  } finally {
    await releaseLock(kv, account);
  }
}

export default {
  async fetch(request, env) {
    const kv = env.MELI_TOKENS;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // POST /api/meli-notification — webhook de MELI: venta nueva registrada
    // MELI llama a esta URL en segundos cuando entra un pago. Necesita respuesta 200 en < 10s.
    if (url.pathname === '/api/meli-notification' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (body?.topic === 'orders' || body?.topic === 'orders_v2' ||
          String(body?.resource || '').includes('/orders/')) {
        await kvPut(kv, 'pending_orders', { at: Date.now(), userId: body?.user_id || null }, { expirationTtl: 900 });
      }
      return json({ ok: true });
    }

    // GET /api/pending — chequeo liviano: ¿hay pedidos nuevos desde el último sync?
    if (url.pathname === '/api/pending' && request.method === 'GET') {
      const flag = await kvGet(kv, 'pending_orders');
      return json({ pending: !!flag, at: flag?.at || null });
    }

    // POST /api/config — guarda appId y secret del Worker
    if (url.pathname === '/api/config' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body?.appId) return json({ error: 'missing appId' }, 400);
      const cfg = await kvGet(kv, 'config') || {};
      await kvPut(kv, 'config', { appId: body.appId, secret: body.secret || cfg.secret || null });
      return json({ ok: true });
    }

    // POST /api/token/store — registra token OAuth recién obtenido o existente
    if (url.pathname === '/api/token/store' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body?.account || !body?.refreshToken) return json({ error: 'missing fields' }, 400);
      // Solo actualizar si el token entrante es más reciente que el guardado
      const existing = await kvGet(kv, `token:${body.account}`);
      if (existing && (existing.expiresAt || 0) >= (body.expiresAt || 0)) {
        return json({ ok: true, skipped: true }); // ya hay uno igual o más nuevo
      }
      const tokenData = {
        token:        body.token,
        refreshToken: body.refreshToken,
        expiresAt:    body.expiresAt || (Date.now() + 21480000),
      };
      await kvPut(kv, `token:${body.account}`, tokenData, { expirationTtl: 2592000 }); // 30 días
      if (body.appId) {
        const cfg = await kvGet(kv, 'config') || {};
        await kvPut(kv, 'config', { appId: body.appId, secret: body.secret || cfg.secret || null });
      }
      return json({ ok: true });
    }

    // GET /api/token/:account — devuelve token válido (refresca en el Worker si expiró)
    if (/^\/api\/token\/(capi|enano)$/.test(url.pathname) && request.method === 'GET') {
      const account = url.pathname.split('/').pop();
      const result = await getValidToken(kv, account);
      if (result.ok) {
        return json({
          token:        result.token,
          expiresAt:    result.expiresAt,
          refreshToken: result.refreshToken || undefined, // solo cuando se refrescó
          stale:        result.stale || false,
        });
      }
      return json({ error: result.reason, token: result.token || null }, result.reason === 'no_token' ? 404 : 502);
    }

    // POST /api/token → intercambio de código OAuth (original)
    if (url.pathname === '/api/token' && request.method === 'POST') {
      const body = await request.text();
      const res  = await fetch(`${MELI_API}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
      });
      const data = await res.json();
      if (res.ok && data.access_token) {
        try {
          const u = await fetch(`${MELI_API}/users/me`, {
            headers: { Authorization: `Bearer ${data.access_token}` },
          });
          if (u.ok) data._user = await u.json();
        } catch (_) {}
      }
      return json(data, res.status);
    }

    // GET|POST /api/meli/* → proxy genérico a la API de MELI
    if (url.pathname.startsWith('/api/meli/')) {
      const meliPath = url.pathname.replace('/api/meli', '') + url.search;
      const auth = request.headers.get('Authorization');
      const res  = await fetch(`${MELI_API}${meliPath}`, {
        method: request.method,
        headers: auth ? { Authorization: auth } : {},
      });
      const data = await res.json();
      return json(data, res.status);
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },

  // Cron: se ejecuta cada hora en Cloudflare, renueva tokens antes de que expiren
  async scheduled(_event, env, _ctx) {
    const kv = env.MELI_TOKENS;
    await Promise.all([
      proactiveRefresh(kv, 'capi'),
      proactiveRefresh(kv, 'enano'),
    ]);
  },
};
