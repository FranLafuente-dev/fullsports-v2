import {
  doc, getDoc, setDoc, onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const WORKER           = 'https://meli-test.lafuentefranciscolucas.workers.dev';
const REDIRECT_URI     = 'https://franlafuente-dev.github.io/fullsports-v2/';
const POLL_MS          = 15 * 60 * 1000;
const REFRESH_MARGIN   = 3 * 3600 * 1000; // renovar si quedan < 3h

let _db, _getOrders, _marcarEntregado, _onConfigUpdate;
let _config    = {};
let _meliOrders = []; // pedidos MELI recientes sin vincular aún

// ── INIT ──────────────────────────────────────────────────────────────────────

export async function meliInit(db, getOrders, marcarEntregadoFn, onConfigUpdate) {
  _db              = db;
  _getOrders       = getOrders;
  _marcarEntregado = marcarEntregadoFn;
  _onConfigUpdate  = onConfigUpdate;

  // Cargar config inicial antes de manejar el OAuth callback
  const snap = await getDoc(doc(db, 'meta', 'meliConfig'));
  _config = snap.exists() ? snap.data() : {};

  // Manejar redirect de OAuth si hay ?code= en la URL
  await _handleOAuthCallback();

  // Listener en tiempo real para actualizar el UI de config
  onSnapshot(doc(db, 'meta', 'meliConfig'), s => {
    _config = s.exists() ? s.data() : {};
    if (_onConfigUpdate) _onConfigUpdate();
  });

  // Primer tick a los 8s, luego cada 15 min
  setTimeout(_tick, 8000);
  setInterval(_tick, POLL_MS);
}

// ── TOKEN MANAGEMENT ──────────────────────────────────────────────────────────

async function _saveConfig(data) {
  await setDoc(doc(_db, 'meta', 'meliConfig'), data, { merge: true });
}

async function _getToken(cuenta) {
  const acc = _config[cuenta];
  if (!acc?.accessToken) return null;

  const needsRefresh = acc.tokenExpiresAt
    ? Date.now() > acc.tokenExpiresAt - REFRESH_MARGIN
    : false;

  if (needsRefresh) return _refreshToken(cuenta);
  return acc.accessToken;
}

async function _refreshToken(cuenta) {
  const acc = _config[cuenta];
  if (!acc?.refreshToken || !_config.appId || !_config.appSecret) return null;

  try {
    const res = await fetch(`${WORKER}/api/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        grant_type:    'refresh_token',
        client_id:     _config.appId,
        client_secret: _config.appSecret,
        refresh_token: acc.refreshToken,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      // Si MELI revocó el token → limpiar
      if (err.error === 'invalid_grant') {
        await _saveConfig({ [cuenta]: { accessToken: null, refreshToken: null } });
      }
      return null;
    }

    const data    = await res.json();
    const updated = {
      accessToken:    data.access_token,
      refreshToken:   data.refresh_token || acc.refreshToken,
      tokenExpiresAt: Date.now() + (data.expires_in || 21600) * 1000,
    };
    await _saveConfig({ [cuenta]: updated });
    _config[cuenta] = { ..._config[cuenta], ...updated };
    return updated.accessToken;
  } catch {
    return null;
  }
}

// ── OAUTH CALLBACK ────────────────────────────────────────────────────────────

async function _handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get('code');
  const state  = params.get('state');
  if (!code || !['capi', 'enano'].includes(state)) return;

  // Limpiar URL antes de cualquier await
  window.history.replaceState({}, '', window.location.pathname);

  if (!_config.appId || !_config.appSecret) {
    alert('Guardá el App ID y App Secret antes de conectar cuentas.');
    return;
  }

  try {
    const res = await fetch(`${WORKER}/api/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        grant_type:    'authorization_code',
        client_id:     _config.appId,
        client_secret: _config.appSecret,
        code,
        redirect_uri:  REDIRECT_URI,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Error en autenticación');
    }

    const data = await res.json();

    // Obtener nickname de la cuenta
    let nickname = state.toUpperCase();
    try {
      const me = await fetch(`${WORKER}/api/meli/users/me`, {
        headers: { Authorization: `Bearer ${data.access_token}` }
      });
      if (me.ok) {
        const u = await me.json();
        nickname = u.nickname || nickname;
      }
    } catch {}

    await _saveConfig({
      [state]: {
        accessToken:    data.access_token,
        refreshToken:   data.refresh_token,
        tokenExpiresAt: Date.now() + (data.expires_in || 21600) * 1000,
        nickname,
        userId: data.user_id,
      }
    });

    alert(`✓ Cuenta ${state.toUpperCase()} conectada: ${nickname}`);
  } catch (e) {
    alert('Error al conectar: ' + e.message);
  }
}

// ── TICK: polling de entregas + fetch de sugerencias ─────────────────────────

async function _tick() {
  await Promise.all([_pollDeliveries(), _fetchSuggestions()]);
}

async function _pollDeliveries() {
  const orders   = _getOrders();
  const enCamino = orders.filter(o => o.status === 'camino' && o.meliOrderId);
  if (!enCamino.length) return;

  for (const o of enCamino) {
    const token = await _getToken(o.cuenta);
    if (!token) continue;

    try {
      const res = await fetch(`${WORKER}/api/meli/orders/${o.meliOrderId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.shipping?.status === 'delivered') {
        await _marcarEntregado(o.id);
      }
    } catch {}
  }
}

async function _fetchSuggestions() {
  const cuentas = ['capi', 'enano'].filter(c => _config[c]?.userId);
  if (!cuentas.length) return;

  const cutoff   = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  const nuevos   = [];

  for (const cuenta of cuentas) {
    const token = await _getToken(cuenta);
    if (!token) continue;
    const userId = _config[cuenta].userId;

    try {
      const res = await fetch(
        `${WORKER}/api/meli/orders/search?seller=${userId}&order.status=paid&sort=date_desc&limit=30`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) continue;
      const data = await res.json();

      for (const o of (data.results || [])) {
        if ((o.date_created || '') < cutoff) continue;
        nuevos.push({
          id:       String(o.id),
          cuenta,
          name:     `${o.buyer?.first_name || ''} ${o.buyer?.last_name || ''}`.trim(),
          nickname: o.buyer?.nickname || '',
          itemsText: (o.order_items || []).map(i => i.item?.title || '').join(', '),
        });
      }
    } catch {}
  }

  _meliOrders = nuevos;
  // Notificar para que el form refresque si está abierto
  if (typeof window._onMeliSuggestionsUpdate === 'function') {
    window._onMeliSuggestionsUpdate();
  }
}

export function getMeliSuggestions() {
  if (!_getOrders) return [];
  const linkedIds = new Set(_getOrders().map(o => o.meliOrderId).filter(Boolean));
  return _meliOrders.filter(mo => !linkedIds.has(mo.id));
}

// ── CONFIG HTML ───────────────────────────────────────────────────────────────

export function meliRenderConfig() {
  const capiStatus = _config.capi?.accessToken
    ? `<span style="color:var(--green)">✓ Conectado${_config.capi.nickname ? ' — ' + _config.capi.nickname : ''}</span>`
    : `<span style="color:var(--gray)">No conectado</span>`;

  const enanoStatus = _config.enano?.accessToken
    ? `<span style="color:var(--green)">✓ Conectado${_config.enano.nickname ? ' — ' + _config.enano.nickname : ''}</span>`
    : `<span style="color:var(--gray)">No conectado</span>`;

  return `
    <div class="section-title">Integración MELI</div>
    <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:14px">
      <div class="form-group" style="gap:6px">
        <div class="form-label">App ID</div>
        <input class="form-input" id="meli-app-id" type="text"
          placeholder="Ej: 123456789" value="${_config.appId || ''}" autocomplete="off">
      </div>
      <div class="form-group" style="gap:6px">
        <div class="form-label">App Secret</div>
        <input class="form-input" id="meli-app-secret" type="password"
          placeholder="••••••••••••" value="${_config.appSecret || ''}" autocomplete="off">
      </div>
      <button class="btn btn-primary btn-sm" onclick="meliSaveAppConfig()">Guardar credenciales</button>
      <div style="border-top:1px solid var(--sep);padding-top:12px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <div>
            <div style="font-weight:600;font-size:14px">CAPI</div>
            <div style="font-size:13px;margin-top:2px">${capiStatus}</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="meliConnect('capi')">Conectar</button>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <div>
            <div style="font-weight:600;font-size:14px">ENANO</div>
            <div style="font-size:13px;margin-top:2px">${enanoStatus}</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="meliConnect('enano')">Conectar</button>
        </div>
      </div>
    </div>`;
}

// ── WINDOW GLOBALS ────────────────────────────────────────────────────────────

window.meliConnect = (cuenta) => {
  if (!_config.appId) {
    alert('Primero guardá el App ID y App Secret.');
    return;
  }
  const url = `https://auth.mercadolibre.com.ar/authorization?response_type=code`
    + `&client_id=${encodeURIComponent(_config.appId)}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&state=${cuenta}`;
  window.location.href = url;
};

window.meliSaveAppConfig = async () => {
  const appId     = document.getElementById('meli-app-id')?.value.trim();
  const appSecret = document.getElementById('meli-app-secret')?.value.trim();
  if (!appId || !appSecret) { alert('Completá App ID y App Secret.'); return; }
  await _saveConfig({ appId, appSecret });
  const btn = document.querySelector('[onclick="meliSaveAppConfig()"]');
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = '✓ Guardado';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }
};
