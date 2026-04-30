import {
  doc, getDoc, setDoc, onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const WORKER         = 'https://meli-test.lafuentefranciscolucas.workers.dev';
const REDIRECT_URI   = 'https://franlafuente-dev.github.io/fullsports-v2/';
const POLL_MS        = 10 * 60 * 1000;   // tick cada 10 min
const REFRESH_MARGIN = 2 * 3600 * 1000;  // renovar si quedan < 2h

let _db, _getOrders, _marcarEntregado, _onConfigUpdate;
let _config     = {};
let _meliOrders = [];
let _tickTimer  = null;

// ── INIT ──────────────────────────────────────────────────────────────────────

export async function meliInit(db, getOrders, marcarEntregadoFn, onConfigUpdate) {
  _db              = db;
  _getOrders       = getOrders;
  _marcarEntregado = marcarEntregadoFn;
  _onConfigUpdate  = onConfigUpdate;

  const snap = await getDoc(doc(db, 'meta', 'meliConfig'));
  _config = snap.exists() ? snap.data() : {};

  await _handleOAuthCallback();

  onSnapshot(doc(db, 'meta', 'meliConfig'), s => {
    _config = s.exists() ? s.data() : {};
    _updateStatusBadge();
    if (_onConfigUpdate) _onConfigUpdate();
  });

  // Primer tick a los 6s para no bloquear el arranque
  setTimeout(_tick, 6000);
  _tickTimer = setInterval(_tick, POLL_MS);

  // Cuando vuelve la conexión → tick inmediato
  window.addEventListener('online', () => setTimeout(_tick, 2000));
}

// ── TOKEN MANAGEMENT ──────────────────────────────────────────────────────────

async function _saveConfig(data) {
  await setDoc(doc(_db, 'meta', 'meliConfig'), data, { merge: true });
}

async function _getToken(cuenta) {
  const acc = _config[cuenta];
  if (!acc?.accessToken) return null;

  const expiresAt    = acc.tokenExpiresAt || 0;
  const needsRefresh = Date.now() > expiresAt - REFRESH_MARGIN;

  if (needsRefresh) return _refreshToken(cuenta);
  return acc.accessToken;
}

async function _refreshToken(cuenta) {
  const acc = _config[cuenta];
  if (!acc?.refreshToken || !_config.appId || !_config.appSecret) {
    _markDisconnected(cuenta, 'Sin credenciales para renovar');
    return null;
  }

  _setAccountStatus(cuenta, 'refreshing');

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
      // Solo limpiar tokens si MELI dice explícitamente que son inválidos
      if (err.error === 'invalid_grant') {
        _markDisconnected(cuenta, 'La sesión fue revocada por MELI');
        await _saveConfig({ [cuenta]: {
          ...acc,
          accessToken: null, refreshToken: null,
          disconnectedAt: Date.now(),
          disconnectedReason: 'invalid_grant',
        }});
      } else {
        // Error de red o servidor → NO borrar tokens, reintentar en próximo tick
        console.warn(`MELI refresh error (${cuenta}): ${res.status}`, err);
        _setAccountStatus(cuenta, 'error');
      }
      return null;
    }

    const data    = await res.json();
    const updated = {
      accessToken:    data.access_token,
      refreshToken:   data.refresh_token || acc.refreshToken,
      tokenExpiresAt: Date.now() + (data.expires_in || 21600) * 1000,
      disconnectedAt: null,
      disconnectedReason: null,
    };
    await _saveConfig({ [cuenta]: { ...acc, ...updated } });
    _config[cuenta] = { ..._config[cuenta], ...updated };
    _setAccountStatus(cuenta, 'ok');
    return updated.accessToken;

  } catch {
    // Error de red → conservar tokens, reintentar luego
    _setAccountStatus(cuenta, 'error');
    return null;
  }
}

// ── ESTADO Y BADGE ────────────────────────────────────────────────────────────

const _accountStatus = { capi: 'unknown', enano: 'unknown' };

function _setAccountStatus(cuenta, status) {
  _accountStatus[cuenta] = status;
  _updateStatusBadge();
}

function _markDisconnected(cuenta, reason) {
  _setAccountStatus(cuenta, 'disconnected');
  _showReconnectBanner(cuenta, reason);
}

function _updateStatusBadge() {
  const pill = document.getElementById('meli-status-pill');
  if (!pill) return;

  const cuentas  = ['capi', 'enano'];
  const hasToken = cuentas.some(c => _config[c]?.accessToken);
  const allOk    = cuentas.filter(c => _config[c]?.accessToken)
                          .every(c => _accountStatus[c] !== 'disconnected' && _accountStatus[c] !== 'error');

  if (!hasToken) {
    pill.style.display = 'none';
    return;
  }

  pill.style.display = 'inline-flex';

  const refreshing = cuentas.some(c => _accountStatus[c] === 'refreshing');
  const error      = cuentas.some(c => ['disconnected','error'].includes(_accountStatus[c]));

  if (refreshing) {
    pill.textContent = '⟳ MELI';
    pill.className   = 'meli-pill syncing';
  } else if (error) {
    pill.textContent = '! MELI';
    pill.className   = 'meli-pill error';
  } else {
    pill.textContent = '● MELI';
    pill.className   = 'meli-pill ok';
  }
}

function _showReconnectBanner(cuenta, reason) {
  const banner = document.getElementById('meli-reconnect-banner');
  if (!banner) return;
  const nick = _config[cuenta]?.nickname || cuenta.toUpperCase();
  banner.innerHTML = `
    <span>⚠️ ${nick} desconectado — ${reason || 'necesita reconectarse'}</span>
    <button onclick="meliConnect('${cuenta}')" class="meli-reconnect-btn">Reconectar</button>`;
  banner.classList.add('show');
}

// ── OAUTH CALLBACK ────────────────────────────────────────────────────────────

async function _handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get('code');
  const state  = params.get('state');
  if (!code || !['capi', 'enano'].includes(state)) return;

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

    const newAcc = {
      accessToken:    data.access_token,
      refreshToken:   data.refresh_token,
      tokenExpiresAt: Date.now() + (data.expires_in || 21600) * 1000,
      nickname,
      userId: data.user_id,
      disconnectedAt: null,
      disconnectedReason: null,
    };
    await _saveConfig({ [state]: newAcc });
    _config[state] = newAcc;
    _setAccountStatus(state, 'ok');

    // Cerrar banner de reconexión si estaba visible
    const banner = document.getElementById('meli-reconnect-banner');
    if (banner) banner.classList.remove('show');

    showToast(`✓ ${state.toUpperCase()} conectado — ${nickname}`);
  } catch (e) {
    alert('Error al conectar: ' + e.message);
  }
}

// ── TICK PRINCIPAL ────────────────────────────────────────────────────────────

async function _tick() {
  // Siempre verificar y renovar tokens proactivamente
  await _proactiveRefresh();
  await Promise.all([_pollDeliveries(), _fetchSuggestions()]);
}

async function _proactiveRefresh() {
  for (const cuenta of ['capi', 'enano']) {
    const acc = _config[cuenta];
    if (!acc?.accessToken) continue;
    // Si expira en menos de REFRESH_MARGIN → renovar ahora
    const expiresAt = acc.tokenExpiresAt || 0;
    if (Date.now() > expiresAt - REFRESH_MARGIN) {
      await _refreshToken(cuenta);
    }
  }
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

  const cutoff = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  const nuevos = [];

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
  const capiAcc  = _config.capi;
  const enanoAcc = _config.enano;

  const statusHtml = (acc, cuenta) => {
    if (!acc?.accessToken) {
      const wasDisconnected = acc?.disconnectedAt;
      return wasDisconnected
        ? `<span style="color:var(--red)">⚠️ Desconectado — ${acc.disconnectedReason || 'sesión caducada'}</span>`
        : `<span style="color:var(--gray)">No conectado</span>`;
    }
    const st  = _accountStatus[cuenta];
    const min = acc.tokenExpiresAt ? Math.floor((acc.tokenExpiresAt - Date.now()) / 60000) : 0;
    const exp = min > 0 ? ` · expira en ${min < 60 ? min + 'm' : Math.floor(min/60) + 'h'}` : '';
    if (st === 'error')  return `<span style="color:var(--orange)">⚠️ Error de conexión${exp}</span>`;
    return `<span style="color:var(--green)">✓ Conectado${acc.nickname ? ' — ' + acc.nickname : ''}${exp}</span>`;
  };

  return `
    <div class="section-title" style="margin-top:8px">Integración MELI</div>
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
            <div style="font-size:13px;margin-top:2px">${statusHtml(capiAcc, 'capi')}</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="meliConnect('capi')">
            ${capiAcc?.accessToken ? 'Reconectar' : 'Conectar'}
          </button>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <div>
            <div style="font-weight:600;font-size:14px">ENANO</div>
            <div style="font-size:13px;margin-top:2px">${statusHtml(enanoAcc, 'enano')}</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="meliConnect('enano')">
            ${enanoAcc?.accessToken ? 'Reconectar' : 'Conectar'}
          </button>
        </div>
      </div>
    </div>`;
}

// ── WINDOW GLOBALS ────────────────────────────────────────────────────────────

window.meliConnect = (cuenta) => {
  if (!_config.appId) {
    alert('Primero guardá el App ID y App Secret en Configuración.');
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

// Exponer para que app.js pueda llamar showToast
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}
