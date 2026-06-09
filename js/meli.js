// ─── MELI INTEGRATION ────────────────────────────────────────────────────────
// Archivo independiente: no modifica datos existentes de Firebase.
// Nuevas colecciones: meta/meliConfig · meta/meliIgnored

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
const MELI_AUTH_URL    = 'https://auth.mercadolibre.com.ar/authorization';
const MELI_WORKER_BASE = 'https://meli-test.lafuentefranciscolucas.workers.dev';
const MELI_POLL_MS     = 5 * 60 * 1000;
const LS_MELI_TOKENS        = 'fs_meli_tokens_v1';
const LS_MELI_IGNORED       = 'fs_meli_ignored_v1';
const LS_MELI_IGNORED_SUGS  = 'fs_meli_ignored_sugs_v1';
const LS_MELI_APPID         = 'fs_meli_appid_v1';
const LS_MELI_SECRET        = 'fs_meli_secret_v1';

// ─── ESTADO ───────────────────────────────────────────────────────────────────
let meliAppId       = '';
let meliSecret      = '';
let meliTokens      = { capi: null, enano: null };
let meliIgnoredIds   = new Set();
let meliIgnoredSugs  = [];   // objetos completos de sugerencias descartadas
let _meliIgnoredOpen = false; // panel descartados expandido
let meliSuggestions  = [];
let meliPollTimer   = null;
let meliSelectedSug = null;
let meliAuthPopup   = null;
// Dedup: evita que dos pestañas/llamadas simultáneas renueven el mismo token
const _meliRefreshing = {};
// Cuentas que fallaron por error transitorio en el último sync (token presente pero sin señal)
const _meliSyncFailedAccts = new Set();
let _meliRetryTimer = null; // timer de auto-retry para fallas transitorias
let _meliRetryCount = 0;   // contador de fallos consecutivos para backoff exponencial
// Contador de refreshes fallidos consecutivos por cuenta (invalid_grant) — no borrar token hasta X fallos
const _meliInvalidCount = { capi: 0, enano: 0 };
// IDs de pedidos MELI que están siendo guardados ahora mismo (entre el add() y el onSnapshot)
const _meliPendingSaves = new Set();
// Timestamp del último sync exitoso — para comparar con la flag del Worker
let _meliLastSyncAt = 0;
// Cache de enriquecimiento por sesión — evita refetch de shipment/payment ya consultados
const _meliEnrichCache = new Map();

// ─── ALERTA DESCONEXIÓN — notifica siempre, incluso en background ─────────────
let _lastDisconnectNotifAt = 0;
function _notifyDisconnected(names) {
  const now = Date.now();
  if (now - _lastDisconnectNotifAt < 60 * 60 * 1000) return; // máx una notif por hora
  _lastDisconnectNotifAt = now;
  if (typeof _notify === 'function') {
    _notify('⚠️ MELI desconectada', `${names} — Abrí Ajustes MELI para reconectar`, 'meli-disconnected');
  }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function meliInit() {
  // Si la URL tiene ?code= y ?state=, estamos en el popup de redirect de MELI OAuth.
  // No hacer nada: la ventana principal detecta el código y cierra el popup.
  const _qs = new URLSearchParams(window.location.search);
  if (_qs.has('code') && _qs.has('state')) return;

  _meliLoadLocal();
  await _meliLoadFirestore();
  // Subir config al Worker (fire-and-forget — solo appId/secret, no tokens)
  _meliSyncToWorkerConfig();
  // Refresh inmediato si el access_token ya expiró (antes del primer sync)
  await Promise.all(['capi', 'enano'].map(async acct => {
    const ac = meliTokens[acct];
    if (ac && ac.refreshToken && Date.now() >= ac.expiresAt) {
      await _meliRefreshToken(acct);
    }
  }));
  // Garantizar que los tokens estén en el KV del Worker con retry (no bloquea el arranque)
  Promise.all(['capi', 'enano'].map(a => _meliSyncToWorkerAccount(a))).catch(() => {});
  updateMeliSettingsUI();
  _updateMeliConnectionBanner();
  _meliWatchTokens(); // listener en tiempo real — propaga tokens renovados a todos los dispositivos
  startMeliPolling();
  _meliSetupVisibilityWatch();
  if (meliTokens.capi || meliTokens.enano) syncMeli(false);
  // Modal de alerta solo si el objeto de token es null del todo (cuenta nunca conectada).
  // Cualquier token guardado (con o sin refreshToken) significa que hubo conexión previa.
  if (meliAppId) {
    const disc = ['capi', 'enano'].filter(a => !meliTokens[a]);
    if (disc.length) _meliShowReconnectModal(disc);
  }
}

// Listener en tiempo real sobre meliConfig en Firestore.
// Cuando cualquier dispositivo renueva un token y lo guarda, todos los demás
// reciben el nuevo token inmediatamente sin necesidad de reconectarse.
function _meliWatchTokens() {
  db.collection('meta').doc('meliConfig').onSnapshot(snap => {
    if (!snap.exists) return;
    const d = snap.data();
    let changed = false;
    const recovered = []; // cuentas que estaban fallando y recibieron token nuevo
    for (const acct of ['capi', 'enano']) {
      if (!(acct in d)) continue;
      const fsToken    = d[acct] || null;
      const localToken = meliTokens[acct];
      if (!localToken && fsToken) {
        meliTokens[acct] = fsToken;
        changed = true;
        recovered.push(acct);
      } else if (fsToken && localToken && (fsToken.expiresAt || 0) > (localToken.expiresAt || 0)) {
        meliTokens[acct] = fsToken;
        changed = true;
        if (_meliSyncFailedAccts.has(acct)) recovered.push(acct);
      }
      // Si Firestore tiene null pero local tiene token: no actualizar
    }
    if (changed) {
      _meliSaveTokensLocal();
      _updateMeliConnectionBanner();
      updateMeliSettingsUI();
      // Cuentas recuperadas: limpiar estado de fallo y sync inmediato
      if (recovered.length) {
        recovered.forEach(a => { _meliSyncFailedAccts.delete(a); _meliInvalidCount[a] = 0; });
        if (_meliRetryTimer) { clearTimeout(_meliRetryTimer); _meliRetryTimer = null; }
        _meliRetryCount = 0;
        syncMeli(false);
      }
    }
  }, () => {}); // silenciar error del listener sin romper nada
}

function _meliLoadLocal() {
  try { const v = localStorage.getItem(LS_MELI_APPID);   if (v) meliAppId  = v; } catch(e) {}
  try { const v = localStorage.getItem(LS_MELI_SECRET);  if (v) meliSecret = v; } catch(e) {}
  try {
    const t = JSON.parse(localStorage.getItem(LS_MELI_TOKENS) || 'null');
    if (t) { meliTokens.capi = t.capi || null; meliTokens.enano = t.enano || null; }
  } catch(e) {}
  try {
    const ig = JSON.parse(localStorage.getItem(LS_MELI_IGNORED) || 'null');
    if (ig) meliIgnoredIds = new Set(ig);
  } catch(e) {}
  try {
    const is = JSON.parse(localStorage.getItem(LS_MELI_IGNORED_SUGS) || 'null');
    if (Array.isArray(is)) meliIgnoredSugs = is;
  } catch(e) {}
}

async function _meliLoadFirestore() {
  try {
    const s = await db.collection('meta').doc('meliConfig').get();
    if (s.exists) {
      const d = s.data();
      if (d.appId)  { meliAppId  = d.appId;  localStorage.setItem(LS_MELI_APPID,  d.appId);  }
      if (d.secret) { meliSecret = d.secret; localStorage.setItem(LS_MELI_SECRET, d.secret); }
      const needsUpSync = [];
      for (const acct of ['capi', 'enano']) {
        const fsToken    = (acct in d) ? (d[acct] || null) : undefined;
        const localToken = meliTokens[acct];
        if (!localToken) {
          // Sin token local: cargar desde Firestore (puede ser null si nunca conectó)
          meliTokens[acct] = fsToken ?? null;
        } else if (fsToken && (fsToken.expiresAt || 0) > (localToken.expiresAt || 0)) {
          // Firestore más reciente: adoptar
          meliTokens[acct] = fsToken;
        } else if (localToken && (!fsToken || (localToken.expiresAt || 0) > (fsToken.expiresAt || 0) + 30000)) {
          // Local más reciente que Firestore (write anterior falló): re-sincronizar hacia arriba
          needsUpSync.push(acct);
        }
        // Si Firestore es null pero local tiene token: conservar local
      }
      _meliSaveTokensLocal();
      // Subir tokens locales más nuevos a Firestore (sin await para no bloquear la carga)
      if (needsUpSync.length) {
        const upPayload = {};
        needsUpSync.forEach(a => { upPayload[a] = meliTokens[a]; });
        db.collection('meta').doc('meliConfig').set(upPayload, { merge: true }).catch(() => {});
      }
    }
  } catch(e) {}
  try {
    const s = await db.collection('meta').doc('meliIgnored').get();
    if (s.exists) {
      if (Array.isArray(s.data().ids)) {
        meliIgnoredIds = new Set(s.data().ids);
        localStorage.setItem(LS_MELI_IGNORED, JSON.stringify([...meliIgnoredIds]));
      }
      if (Array.isArray(s.data().sug)) {
        meliIgnoredSugs = s.data().sug;
        try { localStorage.setItem(LS_MELI_IGNORED_SUGS, JSON.stringify(meliIgnoredSugs)); } catch(e) {}
      }
    }
  } catch(e) {}
}

function _meliSaveTokensLocal() {
  try { localStorage.setItem(LS_MELI_TOKENS, JSON.stringify(meliTokens)); } catch(e) {}
}

// Guarda UN SOLO token de cuenta — reintenta hasta 3 veces para no perder el refresh_token nuevo
async function _meliSaveToken(acct) {
  _meliSaveTokensLocal();
  const payload = { [acct]: meliTokens[acct] || null };
  for (let i = 0; i < 3; i++) {
    try {
      await db.collection('meta').doc('meliConfig').set(payload, { merge: true });
      return; // éxito
    } catch(e) {
      if (i < 2) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  // Silenciar error después de 3 intentos fallidos
}

// ─── SINCRONIZACIÓN CON WORKER (KV de Cloudflare) ────────────────────────────
// Solo sube appId/secret — los tokens se suben por separado con retry via _meliSyncToWorkerAccount
function _meliSyncToWorkerConfig() {
  if (!meliAppId) return;
  fetch(`${MELI_WORKER_BASE}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: meliAppId, secret: meliSecret || undefined }),
  }).catch(() => {});
}

// Guarda solo App ID y Secret — merge:true para no tocar los tokens
function _meliSaveMeta() {
  try { localStorage.setItem(LS_MELI_APPID,  meliAppId);  } catch(e) {}
  try { localStorage.setItem(LS_MELI_SECRET, meliSecret); } catch(e) {}
  db.collection('meta').doc('meliConfig').set(
    { appId: meliAppId, secret: meliSecret || null },
    { merge: true }
  ).catch(() => {});
}

function _meliSaveIgnored() {
  try { localStorage.setItem(LS_MELI_IGNORED,      JSON.stringify([...meliIgnoredIds])); } catch(e) {}
  try { localStorage.setItem(LS_MELI_IGNORED_SUGS, JSON.stringify(meliIgnoredSugs));     } catch(e) {}
  db.collection('meta').doc('meliIgnored').set({ ids: [...meliIgnoredIds], sug: meliIgnoredSugs }).catch(() => {});
}

window.meliClearIgnored = async function() {
  const prevCount = meliIgnoredIds.size;
  meliIgnoredIds = new Set();
  _meliSaveIgnored();
  await syncMeli(false);
  const pending = meliSuggestions.length;
  toast(`${prevCount} pedido${prevCount !== 1 ? 's' : ''} recuperado${prevCount !== 1 ? 's' : ''} — quedan ${pending} pendiente${pending !== 1 ? 's' : ''}`);
};

// ─── PKCE ─────────────────────────────────────────────────────────────────────
function _b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function _generatePKCE() {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier  = _b64url(raw.buffer);
  const hashBuf   = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = _b64url(hashBuf);
  return { verifier, challenge };
}

// ─── OAUTH — Authorization Code + PKCE ───────────────────────────────────────
window.meliOpenAuth = async (account) => {
  const inp = document.getElementById('meli-app-id-input');
  const appId = inp?.value?.trim() || meliAppId;
  if (!appId) { toast('Primero ingresá el App ID de MELI'); return; }
  meliAppId = appId;
  localStorage.setItem(LS_MELI_APPID, appId);

  const redirectUri = window.location.origin + window.location.pathname;
  const state = `${account}_${Date.now()}`;
  const { verifier, challenge } = await _generatePKCE();

  // Guardar verifier para el intercambio de código
  localStorage.setItem('meli_pkce_verifier', verifier);
  localStorage.setItem('meli_pkce_account', account);

  const url = `${MELI_AUTH_URL}?response_type=code`
    + `&client_id=${encodeURIComponent(appId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&state=${encodeURIComponent(state)}`
    + `&code_challenge=${encodeURIComponent(challenge)}`
    + `&code_challenge_method=S256`
    + `&scope=offline_access`;

  if (meliAuthPopup && !meliAuthPopup.closed) meliAuthPopup.close();
  meliAuthPopup = window.open(url, 'meli_auth', 'width=620,height=740,left=100,top=60');
  if (!meliAuthPopup) { toast('Habilitá pop-ups para conectar MELI'); return; }

  toast('Esperando autorización MELI...');

  // Pollear hasta que el popup vuelva a nuestro dominio con ?code=
  const poll = setInterval(async () => {
    try {
      if (!meliAuthPopup || meliAuthPopup.closed) { clearInterval(poll); return; }
      const qs = meliAuthPopup.location.search; // solo funciona cuando ya es same-origin
      if (qs && qs.includes('code=')) {
        clearInterval(poll);
        const params = new URLSearchParams(qs.substring(1));
        const code   = params.get('code');
        meliAuthPopup.close();
        if (code) await _meliExchangeCode(account, code, verifier, redirectUri);
        else toast('No se recibió código de MELI');
      }
    } catch(e) { /* Popup en dominio de MELI, seguir esperando */ }
  }, 600);
};

async function _meliExchangeCode(account, code, verifier, redirectUri) {
  try {
    const params = {
      grant_type:    'authorization_code',
      client_id:     meliAppId,
      code,
      redirect_uri:  redirectUri,
      code_verifier: verifier,
    };
    if (meliSecret) params.client_secret = meliSecret;
    const res = await fetch(`${MELI_WORKER_BASE}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      toast(`Error MELI: ${data.message || data.error || res.status}`);
      return;
    }
    meliTokens[account] = {
      token:        data.access_token,
      refreshToken: data.refresh_token || null,
      userId:       String(data._user?.id || data.user_id),
      expiresAt:    Date.now() + (data.expires_in * 1000) - 120000,
    };
    _meliSaveToken(account);
    _meliSaveMeta();
    // Registrar en el Worker para que todos los dispositivos encuentren el token nuevo
    _meliSyncToWorkerAccount(account);
    localStorage.removeItem('meli_pkce_verifier');
    localStorage.removeItem('meli_pkce_account');
    updateMeliSettingsUI();
    toast(`✓ MELI ${account.toUpperCase()} conectado`);
    syncMeli(false);
  } catch(e) {
    toast('Error al conectar con MELI — revisá el App ID');
    console.error('MELI exchange:', e);
  }
}

async function _meliRefreshToken(account) {
  // Dedup: si ya hay un refresh en curso en esta pestaña, esperar ese resultado
  if (_meliRefreshing[account]) return _meliRefreshing[account];
  const p = (async () => {
    const ac = meliTokens[account];
    if (!ac?.refreshToken) return false;

    // ── PASO 0: Firestore-first — si otro dispositivo o el cron ya renovó, adoptarlo ──
    // Evita race condition entre dispositivos: si Firestore ya tiene un token fresco,
    // no es necesario refrescar — simplemente adoptarlo.
    try {
      const fsSnap = await db.collection('meta').doc('meliConfig').get();
      if (fsSnap.exists) {
        const fsToken = fsSnap.data()[account] || null;
        if (fsToken?.refreshToken && (fsToken.expiresAt || 0) > Date.now() + 5 * 60 * 1000) {
          meliTokens[account] = fsToken;
          _meliSaveTokensLocal();
          _meliSyncToWorkerAccount(account); // asegurar que el Worker también tiene el token fresco
          updateMeliSettingsUI();
          return true;
        }
      }
    } catch(_e) {} // offline o error → continuar con Worker

    // ── PASO 1: pedir token válido al Worker ─────────────────────────────────
    // El Worker usa KV con lock — garantiza que solo una instancia refresca
    // aunque haya 3 dispositivos pidiendo al mismo tiempo.
    try {
      const res = await fetch(`${MELI_WORKER_BASE}/api/token/${account}`);
      if (res.ok) {
        const data = await res.json();
        if (data?.token) {
          meliTokens[account] = {
            ...meliTokens[account],
            token:        data.token,
            expiresAt:    data.expiresAt,
            refreshToken: data.refreshToken || meliTokens[account]?.refreshToken || ac.refreshToken,
          };
          await _meliSaveToken(account);
          updateMeliSettingsUI();
          return true;
        }
      }
      // Worker dice no_token (KV vacío): registrar el token local y reintentar
      if (res.status === 404 || res.status === 502) {
        await _meliSyncToWorkerAccount(account);
        const res2 = await fetch(`${MELI_WORKER_BASE}/api/token/${account}`);
        if (res2.ok) {
          const data2 = await res2.json();
          if (data2?.token) {
            meliTokens[account] = {
              ...meliTokens[account],
              token:        data2.token,
              expiresAt:    data2.expiresAt,
              refreshToken: data2.refreshToken || meliTokens[account]?.refreshToken || ac.refreshToken,
            };
            await _meliSaveToken(account);
            updateMeliSettingsUI();
            return true;
          }
        }
      }
    } catch(e) {
      // Worker no disponible → caer al refresh local
    }

    // ── PASO 2: fallback local (Worker caído / sin red) ───────────────────────
    try {
      const params = {
        grant_type:    'refresh_token',
        client_id:     meliAppId,
        refresh_token: meliTokens[account]?.refreshToken || ac.refreshToken,
      };
      if (meliSecret) params.client_secret = meliSecret;
      const res = await fetch(`${MELI_WORKER_BASE}/api/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(params),
      });
      const data = await res.json();
      if (!res.ok || !data.access_token) {
        if (data.error === 'invalid_grant') {
          // Antes de declarar fallo definitivo, verificar si otro dispositivo ya renovó en Firestore
          try {
            const fsSnap = await db.collection('meta').doc('meliConfig').get();
            if (fsSnap.exists) {
              const fsToken = fsSnap.data()[account] || null;
              if (fsToken && (fsToken.expiresAt || 0) > (meliTokens[account]?.expiresAt || 0) && (fsToken.expiresAt || 0) > Date.now()) {
                meliTokens[account] = fsToken;
                await _meliSaveToken(account);
                _meliSyncToWorkerAccount(account);
                updateMeliSettingsUI();
                return true;
              }
            }
          } catch(_e) {}
          return 'invalid';
        }
        return false;
      }
      meliTokens[account] = {
        ...meliTokens[account],
        token:        data.access_token,
        refreshToken: data.refresh_token || meliTokens[account]?.refreshToken || ac.refreshToken,
        expiresAt:    Date.now() + (data.expires_in * 1000) - 120000,
      };
      await _meliSaveToken(account);
      // Subir el nuevo token al Worker para que los otros dispositivos lo encuentren
      _meliSyncToWorkerAccount(account);
      updateMeliSettingsUI();
      return true;
    } catch(e) { return false; }
  })();
  _meliRefreshing[account] = p;
  try { return await p; } finally { _meliRefreshing[account] = null; }
}

// Sube el token de UNA cuenta al Worker — reintenta hasta 3 veces para garantizar que el cron lo encuentre
async function _meliSyncToWorkerAccount(account) {
  const ac = meliTokens[account];
  if (!ac?.refreshToken) return;
  const body = JSON.stringify({
    account,
    token:        ac.token,
    refreshToken: ac.refreshToken,
    expiresAt:    ac.expiresAt,
    appId:        meliAppId,
    secret:       meliSecret || undefined,
  });
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${MELI_WORKER_BASE}/api/token/store`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (res.ok) return;
    } catch(_) {}
    if (i < 2) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }
}

// Obtener token válido (renueva automáticamente con refresh_token)
async function _meliGetToken(account) {
  const ac = meliTokens[account];
  if (!ac) return null;
  if (Date.now() < ac.expiresAt) {
    _meliInvalidCount[account] = 0; // reset al usar token válido
    return ac.token;
  }
  const result = await _meliRefreshToken(account);
  if (result === true) {
    _meliInvalidCount[account] = 0;
    return meliTokens[account].token;
  }
  // Siempre marcar como falla transitoria — NUNCA borrar el token automáticamente.
  // El usuario conectó una vez y solo él puede desconectar desde Ajustes MELI.
  _meliSyncFailedAccts.add(account);
  if (result === 'invalid') {
    _meliInvalidCount[account] = (_meliInvalidCount[account] || 0) + 1;
    // Solo notificar en background después de 5 fallos consecutivos para no molestar
    if (_meliInvalidCount[account] === 5) {
      _notifyDisconnected(account.toUpperCase());
    }
  }
  return null;
}

// ─── API HELPERS ──────────────────────────────────────────────────────────────
async function _meliGet(path, token) {
  const res = await fetch(`${MELI_WORKER_BASE}/api/meli${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`MELI ${res.status} ${path}`);
  return res.json();
}

// ─── FETCH ÓRDENES RECIENTES ──────────────────────────────────────────────────
async function _fetchTodayOrders(account) {
  const token = await _meliGetToken(account);
  if (!token) return [];
  const ac = meliTokens[account];
  if (!ac?.userId) return [];

  const endpoints = [
    `/orders/search?seller=${ac.userId}&limit=50&sort=date_desc`,
    `/users/${ac.userId}/orders/search?limit=50&sort=date_desc`,
  ];
  let results = null;

  for (const ep of endpoints) {
    try {
      const data = await _meliGet(ep, token);
      results = data.results || [];
      break;
    } catch(e) { /* siguiente endpoint */ }
  }
  if (!results) return [];

  const cutoff = Date.now() - 72 * 3600 * 1000;
  return results
    .filter(o => o.status === 'paid' && new Date(o.date_created).getTime() >= cutoff)
    .map(o => ({ ...o, _account: account }));
}

// ─── MERGE PACK ───────────────────────────────────────────────────────────────
function _mergePack(orders) {
  if (orders.length === 1) return orders[0];
  const base = { ...orders[0] };
  base.order_items  = orders.flatMap(o => o.order_items || []);
  base.total_amount = orders.reduce((s, o) => s + (o.total_amount || 0), 0);
  base._packOrderIds = orders.map(o => String(o.id));
  return base;
}

// ─── SYNC PRINCIPAL ───────────────────────────────────────────────────────────
async function syncMeli(showToast = true) {
  if (!meliTokens.capi && !meliTokens.enano) {
    _notifyDisconnected('CAPI y ENANO'); // siempre, aunque sea polling en background
    if (showToast) toast('⚠️ MELI no conectado — abrí Ajustes MELI');
    _updateMeliConnectionBanner();
    return;
  }
  const syncBtn = document.getElementById('btn-sync');
  if (syncBtn) syncBtn.classList.add('syncing');
  if (showToast) toast('Sincronizando MELI...');
  _meliSyncFailedAccts.clear();
  if (_meliRetryTimer) { clearTimeout(_meliRetryTimer); _meliRetryTimer = null; }

  try {
    const [capiOrders, enanoOrders] = await Promise.all([
      _fetchTodayOrders('capi'),
      _fetchTodayOrders('enano'),
    ]);
    const all = [...capiOrders, ...enanoOrders];

    // Dedup + filtro dispatched por orden individual
    const rawCandidates = [];
    const seenIds = new Set();
    for (const o of all) {
      const id = String(o.id);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      if (_isMeliDispatched(o)) continue;
      rawCandidates.push(o);
    }
    // Agrupar por pack_id (compras múltiples MELI = un solo pedido)
    const packMap = new Map();
    const nonPacked = [];
    for (const o of rawCandidates) {
      if (o.pack_id) {
        const pk = String(o.pack_id);
        if (!packMap.has(pk)) packMap.set(pk, []);
        packMap.get(pk).push(o);
      } else {
        nonPacked.push(o);
      }
    }
    const preMerged = [...Array.from(packMap.values()).map(_mergePack), ...nonPacked];
    // Filtrar ya cargados/ignorados: chequear pack_id, order_id individual, y cada ID del pack
    const candidates = preMerged.filter(o => {
      const mid = o.pack_id ? String(o.pack_id) : String(o.id);
      if (meliIgnoredIds.has(mid) || _isMeliOrderLoaded(mid)) return false;
      // Backward compat: órdenes guardadas con ID individual antes del merge por pack
      const oid = String(o.id);
      if (meliIgnoredIds.has(oid) || _isMeliOrderLoaded(oid)) return false;
      if (o._packOrderIds) {
        for (const pid of o._packOrderIds) {
          if (meliIgnoredIds.has(pid) || _isMeliOrderLoaded(pid)) return false;
        }
      }
      return true;
    });
    if (candidates.length) {
      await Promise.all([
        _enrichFromShipment(candidates),
        _enrichFromPayment(candidates),
        _enrichFromBuyer(candidates),
      ]);
    }
    const suggestions = candidates.map(o => _buildSuggestion(o));
    meliSuggestions = suggestions;
    updateMeliBadge();

    // Guardar estado para background sync (se usa cuando la app está cerrada)
    _saveBgState();

    // Notificar pedidos genuinamente nuevos — siempre, incluso con la app abierta
    const newCount = suggestions.filter(s => !_lastNotifiedSugIds.has(s.meliOrderId)).length;
    if (newCount > 0) _notifyNewOrders(newCount);
    _lastNotifiedSugIds = new Set(suggestions.map(s => s.meliOrderId));

    await _updateTracking(all);

    // Verificar cuentas desconectadas o con señal débil — SIEMPRE
    const disc = ['capi', 'enano'].filter(a => !meliTokens[a]);
    const silentFailed = ['capi', 'enano'].filter(a => _meliSyncFailedAccts.has(a) && meliTokens[a]);
    if (disc.length) {
      const names   = disc.map(a => a.toUpperCase()).join(' y ');
      const pedPart = suggestions.length > 0
        ? ` — ${suggestions.length} pedido${suggestions.length > 1 ? 's' : ''} nuevo${suggestions.length > 1 ? 's' : ''}`
        : '';
      _notifyDisconnected(names);
      if (showToast) toast(`⚠️ ${names} desconectada${disc.length > 1 ? 's' : ''}${pedPart}`);
    } else if (silentFailed.length) {
      const names = silentFailed.map(a => a.toUpperCase()).join(' y ');
      const retryDelays = [30, 60, 120, 300]; // backoff: 30s → 1min → 2min → 5min
      const delaySec = retryDelays[Math.min(_meliRetryCount, retryDelays.length - 1)];
      if (showToast) toast(`⚠️ MELI ${names} sin señal — reintentando en ${delaySec}s`);
      if (!_meliRetryTimer) {
        _meliRetryTimer = setTimeout(() => {
          _meliRetryTimer = null;
          _meliRetryCount++;
          _meliSyncFailedAccts.clear();
          syncMeli(false);
        }, delaySec * 1000);
      }
    } else {
      _meliRetryCount = 0; // reset backoff en éxito
      _meliLastSyncAt = Date.now(); // marca para el poll de webhooks
      if (showToast) toast(suggestions.length > 0
        ? `${suggestions.length} pedido${suggestions.length > 1 ? 's' : ''} nuevo${suggestions.length > 1 ? 's' : ''} en MELI ✓`
        : '✓ Sin pedidos pendientes de carga'
      );
    }
  } catch(e) {
    if (showToast) toast('⚠️ Error al sincronizar con MELI');
  } finally {
    if (syncBtn) syncBtn.classList.remove('syncing');
    _updateMeliConnectionBanner([..._meliSyncFailedAccts].filter(a => meliTokens[a]));
  }
}
window.syncMeli = syncMeli;

// ─── ENRIQUECIMIENTO DE PAGOS (IIBB para ENANO) ──────────────────────────────
async function _enrichFromPayment(orders) {
  await Promise.all(orders.map(async o => {
    const payId = o.payments?.[0]?.id;
    if (!payId) return;
    const ckey = 'pay:' + payId;
    let pay = _meliEnrichCache.get(ckey);
    if (!pay) {
      try {
        const token = await _meliGetToken(o._account);
        if (!token) return;
        pay = await _meliGet(`/payments/${payId}`, token);
        _meliEnrichCache.set(ckey, pay);
      } catch(e) { return; }
    }
    try {
      const fees = pay.fee_details || [];

      // ── Importe neto ──────────────────────────────────────────────────────
      // 1. net_received_amount del detalle si es distinto al bruto
      if (pay.net_received_amount && pay.net_received_amount !== pay.total_paid_amount) {
        o.payments[0].net_received_amount = pay.net_received_amount;
      }
      // 2. Si sigue igual al bruto (o vacío), calcular sumando fee_details (todos negativos)
      if ((!o.payments[0].net_received_amount ||
           o.payments[0].net_received_amount === pay.total_paid_amount) &&
          pay.total_paid_amount && fees.length) {
        const feesSum = fees.reduce((s, f) => s + (f.amount || 0), 0);
        const computed = pay.total_paid_amount + feesSum;
        if (computed > 0 && computed < pay.total_paid_amount) {
          o.payments[0].net_received_amount = computed;
        }
      }

      // ── IIBB (solo ENANO — retención provincial) ──────────────────────────
      if (o._account === 'enano') {
        const taxEntry = fees.find(f =>
          f.type === 'tax' ||
          String(f.type).toLowerCase().includes('tax') ||
          String(f.type).toLowerCase().includes('iibb') ||
          String(f.type).toLowerCase().includes('withhold')
        );
        let iibb = taxEntry ? Math.abs(taxEntry.amount || 0) : 0;
        if (!iibb) {
          for (const fee of fees) {
            if (Array.isArray(fee.included_taxes)) {
              const s = fee.included_taxes.reduce((a, t) => a + Math.abs(t.amount || 0), 0);
              if (s > 0) { iibb = s; break; }
            }
          }
        }
        if (!iibb && pay.taxes_amount) iibb = Math.abs(pay.taxes_amount);
        if (iibb) o._iibb = iibb;
      }
    } catch(e) { /* skip silently */ }
  }));
}

// ─── ENRIQUECIMIENTO DE NOMBRES ──────────────────────────────────────────────
async function _enrichFromBuyer(orders) {
  const byId = new Map();
  for (const o of orders) {
    const bid = o.buyer?.id;
    if (!bid || o.buyer?.first_name) continue;
    if (!byId.has(bid)) byId.set(bid, []);
    byId.get(bid).push(o);
  }
  await Promise.all([...byId.entries()].map(async ([buyerId, group]) => {
    const ckey = 'user:' + buyerId;
    let user = _meliEnrichCache.get(ckey);
    if (!user) {
      try {
        const token = await _meliGetToken(group[0]._account);
        if (!token) return;
        user = await _meliGet(`/users/${buyerId}`, token);
        _meliEnrichCache.set(ckey, user);
      } catch(e) { return; }
    }
    if (user?.first_name) {
      for (const o of group) {
        o.buyer = { ...o.buyer, first_name: user.first_name, last_name: user.last_name || '' };
      }
    }
  }));
}

async function _enrichFromShipment(orders) {
  await Promise.all(orders.map(async o => {
    if (!o.shipping?.id) return;
    const sid  = String(o.shipping.id);
    const ckey = 'ship:' + sid;
    let s = _meliEnrichCache.get(ckey);
    if (!s) {
      try {
        const token = await _meliGetToken(o._account);
        if (!token) return;
        s = await _meliGet(`/shipments/${sid}`, token);
        _meliEnrichCache.set(ckey, s);
      } catch(e) { return; }
    }
    if (s.receiver_address) o.shipping.receiver_address = s.receiver_address;
    if (s.logistic_type)    o.shipping.logistic_type    = s.logistic_type;
    if (s.mode)             o.shipping.mode             = s.mode;
    if (s.tags)             o.shipping.tags             = s.tags;
  }));
}

// ─── FILTROS ──────────────────────────────────────────────────────────────────
function _isMeliOrderLoaded(meliId) {
  // También verificar el set de guardados en vuelo (entre add() y onSnapshot)
  if (_meliPendingSaves.has(String(meliId))) return true;
  return orders.some(o => o.meliOrderId && String(o.meliOrderId) === String(meliId));
}

// Llamar antes de await add() para bloquear sugerencias mientras se guarda
window.meliBeginSave = function(meliOrderId) {
  if (meliOrderId) _meliPendingSaves.add(String(meliOrderId));
};
function _isMeliDispatched(order) {
  return ['shipped', 'delivered', 'not_delivered', 'cancelled'].includes(order.shipping?.status);
}

// ─── CONSTRUIR SUGERENCIA ─────────────────────────────────────────────────────
function _findFlexZone(localidad, provincia) {
  const norm     = localidad ? normalizeStr(localidad.toLowerCase()) : '';
  const provNorm = provincia ? normalizeStr(provincia.toLowerCase()) : '';
  // Solo GBA/CABA entran en FLEX; otras provincias → PE
  const isCaba = provNorm.includes('autonoma') || provNorm.includes('capital federal');
  const isBsAs = !isCaba && provNorm.includes('buenos aires');
  if (!norm || (!isCaba && !isBsAs)) return null;
  const allZones = typeof zones !== 'undefined' ? zones : [];
  return allZones.find(z => {
    const zNorm = normalizeStr(z.localidad.toLowerCase());
    if (!(zNorm === norm || zNorm.includes(norm) || norm.includes(zNorm))) return false;
    // Evitar falsos positivos: "Chacabuco" (BsAs) no debe caer en "Parque Chacabuco" (CABA)
    return isCaba ? z.zona.includes('CABA') : !z.zona.includes('CABA');
  }) || null;
}

function _buildSuggestion(order) {
  const localidad = _getLocality(order);
  const provincia = _getProvince(order);
  const zone      = _findFlexZone(localidad, provincia);
  return {
    meliOrderId:   order.pack_id ? String(order.pack_id) : String(order.id),
    packOrderIds:  order._packOrderIds || null,
    account:       order._account,
    nombre:        _getBuyerName(order),
    nickname:      order.buyer?.nickname || '',
    tipoEnvio:     zone ? 'FLEX' : 'PE',
    localidad,
    provincia,
    importe:       0,
    iibb:          order._iibb || 0,
    importeBruto:  order.total_amount || (order.payments||[]).reduce((s,p) => s + (p.total_paid_amount||0), 0),
    items:         _parseItems(order.order_items),
    dateCreated:   order.date_created,
  };
}

function _detectShipping(order) {
  const logistic  = order.shipping?.logistic_type || '';
  const mode      = order.shipping?.mode || '';
  const tags      = order.tags || [];
  const shipTags  = order.shipping?.tags || [];
  const allTags   = [...tags, ...shipTags].map(t => String(t).toLowerCase());

  const flexLogistics = ['self_service', 'me2', 'fulfillment', 'cross_docking'];
  const flexTagWords  = ['flex', 'self_service', 'fulfillment', 'delivered_by_seller', 'same_day'];

  if (flexLogistics.includes(logistic)) return 'FLEX';
  if (mode === 'me2') return 'FLEX';
  if (allTags.some(t => flexTagWords.some(w => t.includes(w)))) return 'FLEX';
  return 'PE';
}
function _getBuyerName(order) {
  const b = order.buyer;
  if (b?.first_name) return titleCase(`${b.first_name} ${b.last_name || ''}`.trim());
  if (b?.nickname) return b.nickname.trim(); // nickname tal cual (AMITRANOCARLOTA) — fácil de buscar en MELI
  return '';
}
function _getLocality(order) {
  const a = order.shipping?.receiver_address;
  return a?.city?.name || a?.municipality?.name || '';
}
function _getProvince(order) {
  const a = order.shipping?.receiver_address;
  return a?.state?.name || '';
}
function _getAmount(order) {
  const pay = (order.payments || [])[0];
  if (!pay) return 0;
  if (pay.net_received_amount) return pay.net_received_amount;
  // Fallback si net_received_amount todavía no fue calculado (pago en proceso)
  if (pay.total_paid_amount && pay.marketplace_fee) {
    return pay.total_paid_amount + pay.marketplace_fee; // marketplace_fee es negativo
  }
  return pay.total_paid_amount || 0;
}

// ─── PARSEO DE ÍTEMS ─────────────────────────────────────────────────────────
function _parseSku(sku) {
  if (!sku) return null;
  const c = sku.replace(/-/g, '').toUpperCase();
  let product = null;
  if (/MEDIAMOST|MEDIAMOSTAZA/.test(c)) product = 'Media caña';
  else if (/MOST/.test(c))             product = 'Mostaza';
  else if (/TOTAL/.test(c))            product = 'Total Black';
  else if (/CARAM/.test(c))            product = 'Caramelo';
  else if (/BORCEG/.test(c))           product = 'Borcegos';
  else if (/BANDERA/.test(c))          product = 'Banderas';
  else if (/COLAP/.test(c))            product = 'Remeras Colapinto';
  if (!product) return null;
  const numMatch = sku.match(/(\d{2})$/);
  let talle = numMatch ? parseInt(numMatch[1], 10) : null;
  if (!talle && product === 'Remeras Colapinto') talle = 'L';
  return { product, talle };
}
function _parseTalleFromVariant(name) {
  if (!name) return null;
  const mMatch = name.match(/(\d+x\d+)/i);
  if (mMatch) return mMatch[1];
  const nMatch = name.match(/\|\s*(\d{2})\s*AR/i) || name.match(/\b(3[89]|4[0-5])\b/);
  return nMatch ? parseInt(nMatch[1], 10) : null;
}
function _parseProductFromTitle(title) {
  const c = (title || '').replace(/-/g, '').toUpperCase();
  if (/MEDIAMOST|MEDIAMOSTAZA/.test(c)) return 'Media caña';
  if (/TOTAL/.test(c))  return 'Total Black';
  if (/MOST/.test(c))   return 'Mostaza';
  if (/CARAM/.test(c))  return 'Caramelo';
  if (/BORCEG/.test(c)) return 'Borcegos';
  if (/BANDERA/.test(c))return 'Banderas';
  if (/COLAP/.test(c))  return 'Remeras Colapinto';
  return null;
}
function _parseItems(orderItems) {
  const result = [];
  for (const item of (orderItems || [])) {
    const qty = item.quantity || 1;
    let parsed = _parseSku(item.item?.seller_sku);
    if (!parsed || !parsed.talle) {
      const varAttr = (item.item?.variation_attributes || []).find(a =>
        /SIZE|talle|número|number/i.test(a.id || a.name || '')
      );
      const variantName = varAttr?.value_name || item.item?.title || '';
      if (!parsed) {
        const product = _parseProductFromTitle(item.item?.seller_sku || item.item?.title || '');
        parsed = product ? { product, talle: null } : null;
      }
      if (parsed && !parsed.talle) {
        parsed.talle = _parseTalleFromVariant(variantName);
        if (!parsed.talle && parsed.product === 'Remeras Colapinto') parsed.talle = 'L';
      }
    }
    if (parsed?.product) {
      for (let i = 0; i < qty; i++) result.push({ producto: parsed.product, talle: parsed.talle });
    }
  }
  return result;
}

// ─── BADGE ────────────────────────────────────────────────────────────────────
function updateMeliBadge() {
  const badge = document.getElementById('meli-badge');
  if (!badge) return;
  const n = meliSuggestions.length;
  badge.textContent = n > 0 ? String(n) : '';
  badge.classList.toggle('show', n > 0);
  // Contadores por cuenta encima del nombre en el selector del formulario
  for (const acct of ['capi', 'enano']) {
    const btn = document.querySelector(`.toggle-btn[data-cuenta="${acct}"]`);
    if (!btn) continue;
    const ct = meliSuggestions.filter(s => s.account === acct).length;
    let span = btn.querySelector('.cuenta-meli-ct');
    if (!span) {
      span = document.createElement('span');
      span.className = 'cuenta-meli-ct';
      btn.prepend(span);
    }
    span.textContent = ct > 0 ? String(ct) : '';
    btn.classList.toggle('has-meli-ct', ct > 0);
  }
  if (typeof updateAppBadge === 'function') updateAppBadge();
}
window.updateMeliBadge = updateMeliBadge;
window.getMeliBadgeCount = () => meliSuggestions.length;

let _lastNotifiedSugIds = new Set();

function _notifyNewOrders(newOnes) {
  if (!newOnes) return;
  _notify(
    'FullSports — Pedidos nuevos',
    `${newOnes} pedido${newOnes > 1 ? 's' : ''} sin cargar`,
    'meli-new-orders'
  );
}

// ─── BACKGROUND STATE — persiste info para el SW cuando la app está cerrada ──
async function _saveBgState() {
  try {
    const capiUserId  = meliTokens.capi?.userId  || '';
    const enanoUserId = meliTokens.enano?.userId || '';
    if (!capiUserId && !enanoUserId) return;
    const loadedIds = typeof orders !== 'undefined'
      ? orders.filter(o => o.meliOrderId).map(o => String(o.meliOrderId))
      : [];
    const state = {
      capiUserId, enanoUserId,
      knownIds:   [...new Set([...loadedIds, ...meliSuggestions.map(s => s.meliOrderId)])],
      ignoredIds: [...meliIgnoredIds],
      savedAt:    Date.now(),
    };
    const c = await caches.open('meli-bg-state-v1');
    await c.put('state.json', new Response(JSON.stringify(state), {
      headers: { 'Content-Type': 'application/json' },
    }));
  } catch(e) {}
}

// ─── POLLING ──────────────────────────────────────────────────────────────────
function startMeliPolling() {
  if (meliPollTimer) clearInterval(meliPollTimer);
  meliPollTimer = setInterval(() => syncMeli(false), MELI_POLL_MS);
  _meliStartTokenKeepAlive();
  _meliStartWebhookPoll();
}

// Poll liviano cada 30s: solo chequea una flag en KV, no consulta MELI directamente.
// Cuando MELI dispara el webhook (venta nueva), el Worker guarda la flag y este poll la detecta.
// Resultado: sync automático en < 30s desde que MELI registra el pago.
function _meliStartWebhookPoll() {
  setInterval(async () => {
    if (!meliTokens.capi && !meliTokens.enano) return; // sin cuentas conectadas, no chequear
    try {
      const res = await fetch(`${MELI_WORKER_BASE}/api/pending`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.pending && (data.at || 0) > _meliLastSyncAt) {
        syncMeli(false);
      }
    } catch(e) {}
  }, 30 * 1000);
}

// Refresca tokens proactivamente antes de que expiren
function _meliStartTokenKeepAlive() {
  setInterval(async () => {
    for (const acct of ['capi', 'enano']) {
      const ac = meliTokens[acct];
      if (!ac?.refreshToken) continue;
      // Refresh si quedan menos de 5 horas (token dura 6h — margen amplio)
      if (ac.expiresAt - Date.now() < 5 * 60 * 60 * 1000) {
        await _meliRefreshToken(acct);
      }
    }
  }, 15 * 60 * 1000); // revisar cada 15 minutos
}

// ─── FOREGROUND WATCH — sync inmediato al volver al app ──────────────────────
function _meliSetupVisibilityWatch() {
  let _lastFgSync = 0;
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) return;
    const now = Date.now();
    if (now - _lastFgSync < 5 * 60 * 1000) return; // al menos 5 min entre syncs por visibilidad
    _lastFgSync = now;
    // Refresh proactivo si el token vence en menos de 5 horas
    await Promise.all(['capi', 'enano'].map(async acct => {
      const ac = meliTokens[acct];
      if (ac?.refreshToken && ac.expiresAt - Date.now() < 5 * 60 * 60 * 1000) {
        await _meliRefreshToken(acct);
      }
    }));
    syncMeli(false);
  });
}

// ─── MODAL DE RECONEXIÓN ─────────────────────────────────────────────────────
function _meliShowReconnectModal(disconnectedAccts) {
  const modal = document.getElementById('meli-reconnect-modal');
  if (!modal) return;
  const names = disconnectedAccts.map(a => a.toUpperCase()).join(' y ');
  const plural = disconnectedAccts.length > 1;
  document.getElementById('meli-modal-msg').textContent =
    `La cuenta ${names} ${plural ? 'están desconectadas' : 'está desconectada'} de MELI. `
    + `Sin conexión los pedidos nuevos no llegan a la app. Para reconectar abrí Ajustes MELI.`;
  modal.classList.remove('hidden');
}
window.closeMeliReconnectModal = function() {
  document.getElementById('meli-reconnect-modal')?.classList.add('hidden');
};
window.meliModalGoToSettings = function() {
  window.closeMeliReconnectModal();
  // Abrir avatar popup primero y luego disparar el botón MELI
  document.getElementById('user-avatar')?.click();
  setTimeout(() => document.getElementById('popup-meli')?.click(), 120);
};

// ─── SUGERENCIAS EN FORMULARIO ────────────────────────────────────────────────
window.toggleMeliPanel = function() {
  document.getElementById('meli-suggestions-panel')?.classList.toggle('collapsed');
  document.getElementById('meli-chip-btn')?.classList.toggle('open');
};

window.renderMeliSuggestions = function() {
  const chipWrap  = document.getElementById('meli-chip-wrap');
  const chipCount = document.getElementById('meli-chip-count');
  const chipLabel = document.getElementById('meli-chip-label');
  const panel     = document.getElementById('meli-suggestions-panel');
  const list      = document.getElementById('meli-suggestions-list');
  if (!chipWrap || !list) return;

  const cuenta   = document.querySelector('[data-cuenta].active')?.dataset.cuenta || null;
  const filtered = cuenta ? meliSuggestions.filter(s => s.account === cuenta) : meliSuggestions;

  if (!filtered.length && !meliIgnoredSugs.length) { chipWrap.classList.add('hidden'); return; }

  chipWrap.classList.remove('hidden');
  chipWrap.dataset.cuenta = cuenta || '';
  const n = filtered.length;
  chipCount.textContent   = n || '';
  chipCount.style.display = n ? '' : 'none';
  chipLabel.textContent   = n
    ? `pedido${n > 1 ? 's' : ''} pendiente${n > 1 ? 's' : ''} de carga`
    : `↩ ver descartados`;

  list.innerHTML = filtered.map(sug => {
    const itemsTxt = sug.items.length
      ? sug.items.map(i => `${i.producto}${i.talle ? ' T'+i.talle : ' (talle?)'}`).join(', ')
      : '';
    const importeTxt = sug.importe ? `$${Math.round(sug.importe).toLocaleString('es-AR')}` : '';
    return `
      <div class="meli-sug-item">
        <div class="meli-sug-body" onclick="meliSelectSuggestion('${sug.meliOrderId}')">
          <div class="meli-sug-row1">
            <span class="meli-sug-account ${sug.account}">${sug.account.toUpperCase()}</span>
            <span class="meli-sug-name">${sug.nombre || '—'}</span>
            <span class="meli-sug-tag ${sug.tipoEnvio.toLowerCase()}">${sug.tipoEnvio}</span>
          </div>
          ${sug.localidad || importeTxt ? `
          <div class="meli-sug-row2">
            ${sug.localidad ? `<span>📍 ${sug.localidad}</span>` : ''}
            ${importeTxt ? `<span>💰 ${importeTxt}</span>` : ''}
          </div>` : ''}
          ${itemsTxt ? `<div class="meli-sug-items">${itemsTxt}</div>` : ''}
        </div>
        <button class="meli-sug-dismiss" onclick="event.stopPropagation();meliDismiss('${sug.meliOrderId}')" title="Descartar">✕</button>
      </div>`;
  }).join('');

  // Sección descartados
  const ignoredSection = document.getElementById('meli-ignored-section');
  if (ignoredSection) {
    if (meliIgnoredSugs.length) {
      ignoredSection.innerHTML = `<div class="meli-ignored-sep"></div>
        <button class="meli-ignored-toggle" onclick="toggleMeliIgnoredPanel()">
          ↩ ${meliIgnoredSugs.length} descartado${meliIgnoredSugs.length !== 1 ? 's' : ''} <span style="opacity:.6">${_meliIgnoredOpen ? '▲' : '▼'}</span>
        </button>
        ${_meliIgnoredOpen ? `<div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
          ${meliIgnoredSugs.slice().reverse().map(s => `
          <div class="meli-sug-item">
            <div class="meli-sug-body" style="cursor:default">
              <div class="meli-sug-row1">
                <span class="meli-sug-account ${s.account}">${s.account.toUpperCase()}</span>
                <span class="meli-sug-name">${s.nombre || '—'}</span>
                <span class="meli-sug-tag ${(s.tipoEnvio||'pe').toLowerCase()}">${s.tipoEnvio||'PE'}</span>
              </div>
              ${s.items?.length ? `<div class="meli-sug-items">${s.items.map(i=>`${i.producto}${i.talle?' T'+i.talle:''}`).join(', ')}</div>` : ''}
            </div>
            <button class="meli-sug-dismiss" style="color:var(--green)" onclick="meliRecover('${s.meliOrderId}')" title="Recuperar">↩</button>
          </div>`).join('')}
        </div>` : ''}`;
    } else {
      ignoredSection.innerHTML = '';
    }
  }
};

window.meliSelectSuggestion = function(meliOrderId) {
  const sug = meliSuggestions.find(s => s.meliOrderId === meliOrderId);
  if (!sug) return;
  meliSelectedSug = sug;
  _fillFormFromSuggestion(sug);
  document.getElementById('meli-suggestions-panel')?.classList.add('collapsed');
  document.getElementById('meli-chip-btn')?.classList.remove('open');
};

// ─── LÁPIZ — preview de campo precargado desde MELI ─────────────────────────
function meliSetField(inputId, rawValue, displayText) {
  const input   = document.getElementById(inputId);
  const preview = document.getElementById(inputId + '-preview');
  const valEl   = document.getElementById(inputId + '-preview-val');
  if (!input) return;
  const hasValue = rawValue !== '' && rawValue !== null && rawValue !== undefined && rawValue !== 0;
  if (preview && valEl && hasValue) {
    input.value = rawValue;
    valEl.textContent = displayText || String(rawValue);
    preview.classList.remove('hidden');
    input.style.display = 'none';
  } else {
    input.value = rawValue || '';
  }
}

window.meliFieldEdit = function(inputId) {
  const input   = document.getElementById(inputId);
  const preview = document.getElementById(inputId + '-preview');
  if (preview) preview.classList.add('hidden');
  if (input) {
    input.style.display = '';
    input.focus();
    if (input.select) input.select();
  }
};

function meliResetPreviews() {
  ['f-nombre', 'f-iibb', 'f-provincia', 'f-importe-bruto'].forEach(id => {
    const preview = document.getElementById(id + '-preview');
    const input   = document.getElementById(id);
    if (preview) preview.classList.add('hidden');
    if (input)   input.style.display = '';
  });
}
window.meliResetPreviews = meliResetPreviews;

function _fillFormFromSuggestion(sug) {
  setCuenta(sug.account || 'capi');
  meliSetField('f-nombre', sug.nombre || '', sug.nombre || '');
  const tag = document.getElementById('meli-order-tag');
  if (tag) {
    document.getElementById('meli-order-num').textContent = '#' + sug.meliOrderId;
    const userEl = document.getElementById('meli-order-user');
    const sepEl  = document.getElementById('meli-order-sep');
    if (sug.nickname) {
      userEl.textContent = '@' + sug.nickname;
      if (sepEl) sepEl.style.display = '';
    } else {
      userEl.textContent = '';
      if (sepEl) sepEl.style.display = 'none';
    }
    tag.classList.remove('hidden');
  }
  if (sug.localidad) {
    const zone = _findFlexZone(sug.localidad, sug.provincia);
    if (zone) {
      setEnvio('FLEX');
      formEnvio = { localidad: zone.localidad, zona: zone.zona, importe: zone.importe };
      showZoneSelected();
      const provName = zone.zona.includes('CABA') ? 'Ciudad Autónoma de Buenos Aires' : 'Buenos Aires';
      meliSetField('f-provincia', provName, provName);
    } else {
      setEnvio('PE');
      if (sug.provincia) meliSetField('f-provincia', sug.provincia, sug.provincia);
    }
  } else {
    setEnvio(sug.tipoEnvio || 'PE');
  }
  // IIBB e importe bruto solo para ENANO
  if (sug.account === 'enano' && sug.iibb) {
    meliSetField('f-iibb', fmtDec(sug.iibb), '$' + fmtDec(sug.iibb));
  }
  if (sug.account === 'enano' && sug.importeBruto) {
    meliSetField('f-importe-bruto', String(sug.importeBruto), '$' + fmt(sug.importeBruto));
  }
  const validItems = sug.items.filter(i => i.talle);
  if (validItems.length) { formItems = validItems; renderFormItems(); }
  haptic([10, 30, 10]);
  toast('Datos cargados desde MELI ✓');
}

window.meliDismiss = function(meliOrderId) {
  const id  = String(meliOrderId);
  const sug = meliSuggestions.find(s => s.meliOrderId === id);
  meliIgnoredIds.add(id);
  if (sug) {
    meliIgnoredSugs = meliIgnoredSugs.filter(s => s.meliOrderId !== id);
    meliIgnoredSugs.push(sug);
    if (meliIgnoredSugs.length > 30) meliIgnoredSugs = meliIgnoredSugs.slice(-30);
  }
  _meliSaveIgnored();
  meliSuggestions = meliSuggestions.filter(s => s.meliOrderId !== id);
  updateMeliBadge();
  window.renderMeliSuggestions();
};

window.meliRecover = function(meliOrderId) {
  const id  = String(meliOrderId);
  const sug = meliIgnoredSugs.find(s => s.meliOrderId === id);
  if (!sug) return;
  meliIgnoredIds.delete(id);
  meliIgnoredSugs = meliIgnoredSugs.filter(s => s.meliOrderId !== id);
  meliSuggestions.push(sug);
  _meliSaveIgnored();
  updateMeliBadge();
  window.renderMeliSuggestions();
};

window.toggleMeliIgnoredPanel = function() {
  _meliIgnoredOpen = !_meliIgnoredOpen;
  window.renderMeliSuggestions();
};

function meliMarkLoaded(meliOrderId) {
  if (!meliOrderId) return;
  meliSuggestions = meliSuggestions.filter(s => s.meliOrderId !== String(meliOrderId));
  meliSelectedSug = null;
  updateMeliBadge();
}
window.meliMarkLoaded = meliMarkLoaded;

function meliGetSelectedId()    { return meliSelectedSug?.meliOrderId  || null; }
function meliGetPackOrderIds()  { return meliSelectedSug?.packOrderIds || null; }
function meliGetNickname()      { return meliSelectedSug?.nickname     || null; }
window.meliGetPackOrderIds = meliGetPackOrderIds;
window.meliGetNickname     = meliGetNickname;
function meliResetSelected() {
  meliSelectedSug = null;
  const tag = document.getElementById('meli-order-tag');
  if (tag) tag.classList.add('hidden');
  meliResetPreviews();
}
window.meliGetSelectedId  = meliGetSelectedId;
window.meliResetSelected  = meliResetSelected;

// ─── ALERTA DESPACHO INCONSISTENTE ───────────────────────────────────────────
async function meliCheckDispatch(pendOrders) {
  const withMeli = pendOrders.filter(o => o.meliOrderId);
  if (!withMeli.length) return;
  const inconsistentes = [];
  for (const order of withMeli) {
    const token = await _meliGetToken(order.cuenta);
    if (!token) continue;
    try {
      const mo = await _meliGet(`/orders/${order.meliOrderId}`, token);
      const st = mo.shipping?.status;
      if (!['shipped', 'delivered', 'handling', 'ready_to_ship'].includes(st))
        inconsistentes.push(order.nombreComprador);
    } catch(e) { /* dispatch check failed — skip silently */ }
  }
  if (inconsistentes.length)
    toast(`⚠️ Sin despacho en MELI: ${inconsistentes.join(', ')}`, 6000);
}
window.meliCheckDispatch = meliCheckDispatch;

// ─── TRACKING ────────────────────────────────────────────────────────────────
async function _trackOne(order, freshMeliOrders) {
  let mo = freshMeliOrders.find(m =>
    String(m.id) === String(order.meliOrderId) ||
    (order.meliPackOrderIds?.some(pid => String(m.id) === pid))
  );
  if (!mo) {
    const acctsTry = order.cuenta ? [order.cuenta] : ['capi', 'enano'];
    for (const acct of acctsTry) {
      try {
        const token = await _meliGetToken(acct);
        if (token) {
          const trackId = order.meliPackOrderIds?.[0] || order.meliOrderId;
          const fetched = await _meliGet(`/orders/${trackId}`, token);
          mo = { ...fetched, _account: acct };
          break;
        }
      } catch(e) {}
    }
  }
  if (!mo) return false;

  if (mo.shipping?.status === 'delivered') {
    const f = new Date().toLocaleDateString('es-AR');
    mutateOrder(order.id, { status: 'entregado', fechaEntrega: f, deliveredAt: Date.now() });
    try { await db.collection('orders').doc(order.id).update({ status: 'entregado', deliveredAt: TS(), fechaEntrega: f }); } catch(e) {}
    const cuenta = order.cuenta || mo._account;
    if (cuenta === 'capi') {
      _notify('✅ Entregado — CAPI', `${order.nombreComprador} recibió su pedido`, `capi-delivered-${order.id}`);
    }
    return true;
  }

  if (mo.shipping?.id) {
    try {
      const acct  = mo._account || order.cuenta;
      const token = await _meliGetToken(acct);
      if (token) {
        const sid = String(mo.shipping.id);
        // Reusar cache de enrichment si ya fue consultado en este sync
        let s = _meliEnrichCache.get('ship:' + sid);
        if (!s) {
          s = await _meliGet(`/shipments/${sid}`, token);
          _meliEnrichCache.set('ship:' + sid, s);
        }
        const etaRaw = s.shipping_option?.estimated_delivery_time?.date
          || s.estimated_delivery_limit?.date
          || null;
        if (etaRaw) {
          const etaDate = new Date(etaRaw).toLocaleDateString('es-AR');
          if (etaDate !== order.fechaEstimada) {
            mutateOrder(order.id, { fechaEstimada: etaDate });
            try { await db.collection('orders').doc(order.id).update({ fechaEstimada: etaDate }); } catch(e) {}
            return true;
          }
        }
      }
    } catch(e) {}
  }
  return false;
}

async function _updateTracking(freshMeliOrders) {
  const inTransit = orders.filter(o => o.status === 'camino' && o.meliOrderId);
  if (!inTransit.length) return;
  const results = await Promise.all(inTransit.map(o => _trackOne(o, freshMeliOrders)));
  if (results.some(Boolean)) renderPedidos();
}

// ─── SETTINGS UI ─────────────────────────────────────────────────────────────
function updateMeliSettingsUI() {
  _setStatusEl('meli-capi-status',  meliTokens.capi,  'CAPI');
  _setStatusEl('meli-enano-status', meliTokens.enano, 'ENANO');
  const inpId  = document.getElementById('meli-app-id-input');
  if (inpId  && meliAppId  && !inpId.value)  inpId.value  = meliAppId;
  const inpSec = document.getElementById('meli-secret-input');
  if (inpSec && meliSecret && !inpSec.value) inpSec.value = meliSecret;
  const uriEl = document.getElementById('meli-redirect-uri');
  if (uriEl && !uriEl.textContent) uriEl.textContent = window.location.origin + window.location.pathname;
  _updateMeliConnectionBanner();
}

// Banner persistente que aparece en la app cuando hay cuentas desconectadas o sin señal
function _updateMeliConnectionBanner(silentFailedAccts = []) {
  const banner = document.getElementById('meli-conn-banner');
  if (!banner) return;
  const disc = ['capi', 'enano'].filter(a => !meliTokens[a]);
  if (disc.length === 0 && silentFailedAccts.length === 0) {
    banner.className = 'alert-banner';
    banner.textContent = '';
    return;
  }
  if (disc.length > 0) {
    const names = disc.map(a => a.toUpperCase()).join(' y ');
    const plural = disc.length > 1;
    banner.className = 'alert-banner show warning';
    banner.innerHTML = `⚠️ MELI ${names} desconectada${plural ? 's' : ''} — `
      + `<span style="text-decoration:underline;cursor:pointer" onclick="document.getElementById('popup-meli')?.click()">abrí Ajustes MELI</span> para reconectar`;
  } else {
    const names = silentFailedAccts.map(a => a.toUpperCase()).join(' y ');
    banner.className = 'alert-banner show warning';
    banner.textContent = `⚠️ MELI ${names} sin señal — reintentando automáticamente`;
  }
}
function _setStatusEl(elId, ac, label) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (ac && (ac.token || ac.refreshToken)) {
    el.textContent = '✓ Conectado';
    el.className = 'meli-conn-status connected';
  } else {
    el.textContent = 'No conectado';
    el.className = 'meli-conn-status';
  }
}
window.meliSaveAppId = function() {
  const inp = document.getElementById('meli-app-id-input');
  const val = inp?.value?.trim();
  if (!val) { toast('Ingresá el App ID'); return; }
  meliAppId = val; _meliSaveMeta(); toast('App ID guardado ✓');
};
window.meliSaveSecret = function() {
  const inp = document.getElementById('meli-secret-input');
  const val = inp?.value?.trim();
  if (!val) { toast('Ingresá el Secret Key'); return; }
  meliSecret = val; _meliSaveMeta(); toast('Secret Key guardado ✓');
};
