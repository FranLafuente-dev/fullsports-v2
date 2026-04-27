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

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // POST /api/token → intercambio de código OAuth o refresh
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
};
