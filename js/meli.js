// ─── MELI INTEGRATION ────────────────────────────────────────────────────────
// Archivo independiente: no modifica datos existentes de Firebase.
// Nuevas colecciones: meta/meliConfig · meta/meliIgnored

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
const MELI_AUTH_URL    = 'https://auth.mercadolibre.com.ar/authorization';
const MELI_WORKER_BASE = 'https://meli-test.lafuentefranciscolucas.workers.dev';
const MELI_POLL_MS     = 15 * 60 * 1000;
const LS_MELI_TOKENS   = 'fs_meli_tokens_v1';
const LS_MELI_IGNORED  = 'fs_meli_ignored_v1';
const LS_MELI_APPID    = 'fs_meli_appid_v1';
const LS_MELI_SECRET   = 'fs_meli_secret_v1';

// ─── ESTADO ───────────────────────────────────────────────────────────────────
let meliAppId       = '';
let meliSecret      = '';
let meliTokens      = { capi: null, enano: null };
let meliIgnoredIds  = new Set();
let meliSuggestions = [];
let meliPollTimer   = null;
let meliSelectedSug = null;
let meliAuthPopup   = null;

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function meliInit() {
  _meliLoadLocal();
  await _meliLoadFirestore();
  // Refresh inmediato si el access_token ya expiró (antes del primer sync)
  await Promise.all(['capi', 'enano'].map(async acct => {
    const ac = meliTokens[acct];
    if (ac && ac.refreshToken && Date.now() >= ac.expiresAt) {
      await _meliRefreshToken(acct);
    }
  }));
  updateMeliSettingsUI();
  startMeliPolling();
  if (meliTokens.capi || meliTokens.enano) syncMeli(false);
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
}

async function _meliLoadFirestore() {
  try {
    const s = await db.collection('meta').doc('meliConfig').get();
    if (s.exists) {
      const d = s.data();
      if (d.appId)  { meliAppId  = d.appId;  localStorage.setItem(LS_MELI_APPID,  d.appId);  }
      if (d.secret) { meliSecret = d.secret; localStorage.setItem(LS_MELI_SECRET, d.secret); }
      // Cargar siempre (incluso null) para que Firebase sea la fuente de verdad
      if ('capi'  in d) meliTokens.capi  = d.capi  || null;
      if ('enano' in d) meliTokens.enano = d.enano || null;
      _meliSaveTokensLocal();
    }
  } catch(e) {}
  try {
    const s = await db.collection('meta').doc('meliIgnored').get();
    if (s.exists && Array.isArray(s.data().ids)) {
      meliIgnoredIds = new Set(s.data().ids);
      localStorage.setItem(LS_MELI_IGNORED, JSON.stringify([...meliIgnoredIds]));
    }
  } catch(e) {}
}

function _meliSaveTokensLocal() {
  try { localStorage.setItem(LS_MELI_TOKENS, JSON.stringify(meliTokens)); } catch(e) {}
}

// Guarda UN SOLO token de cuenta — merge:true para no pisar el token de la otra cuenta
function _meliSaveToken(acct) {
  _meliSaveTokensLocal();
  db.collection('meta').doc('meliConfig').set(
    { [acct]: meliTokens[acct] || null },
    { merge: true }
  ).catch(() => {});
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
  try { localStorage.setItem(LS_MELI_IGNORED, JSON.stringify([...meliIgnoredIds])); } catch(e) {}
  db.collection('meta').doc('meliIgnored').set({ ids: [...meliIgnoredIds] }).catch(() => {});
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

  console.log('[MELI] App ID:', appId);
  console.log('[MELI] Redirect URI:', redirectUri);
  console.log('[MELI] Auth URL:', url);

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
    console.log('[MELI] exchange response:', res.status, JSON.stringify(data));
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
  const ac = meliTokens[account];
  if (!ac?.refreshToken) return false;
  try {
    const params = {
      grant_type:    'refresh_token',
      client_id:     meliAppId,
      refresh_token: ac.refreshToken,
    };
    if (meliSecret) params.client_secret = meliSecret;
    const res = await fetch(`${MELI_WORKER_BASE}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      // 'invalid_grant' = refresh_token muerto. Otros errores son transitorios.
      if (data.error === 'invalid_grant' || (data.message || '').toLowerCase().includes('invalid')) return 'invalid';
      return false;
    }
    meliTokens[account] = {
      ...ac,
      token:        data.access_token,
      refreshToken: data.refresh_token || ac.refreshToken,
      expiresAt:    Date.now() + (data.expires_in * 1000) - 120000,
    };
    _meliSaveToken(account);
    updateMeliSettingsUI();
    return true;
  } catch(e) { return false; } // error de red → no borrar tokens
}

// Obtener token válido (renueva automáticamente con refresh_token)
async function _meliGetToken(account) {
  const ac = meliTokens[account];
  if (!ac) return null;
  if (Date.now() < ac.expiresAt) return ac.token;
  const result = await _meliRefreshToken(account);
  if (result === true) return meliTokens[account].token;
  if (result === 'invalid') {
    // Refresh token definitivamente muerto — requiere reconexión manual
    meliTokens[account] = null;
    _meliSaveToken(account);
    updateMeliSettingsUI();
    toast(`Sesión MELI ${account.toUpperCase()} expirada — reconectá`);
  }
  // false = error transitorio → no borrar tokens, reintentará en próximo ciclo
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
  if (!token) { console.warn(`[MELI] ${account}: sin token`); return []; }
  const ac = meliTokens[account];
  if (!ac?.userId) { console.warn(`[MELI] ${account}: sin userId`); return []; }

  console.log(`[MELI] ${account}: seller ${ac.userId} — verificando token...`);
  try {
    const me = await _meliGet('/users/me', token);
    console.log(`[MELI] ${account}: token OK — user ${me.id} (${me.nickname})`);
  } catch(e) {
    console.warn(`[MELI] ${account}: token inválido —`, e.message);
    return [];
  }

  // Probar dos variantes del endpoint
  const endpoints = [
    `/orders/search?seller=${ac.userId}&limit=50&sort=date_desc`,
    `/users/${ac.userId}/orders/search?limit=50&sort=date_desc`,
  ];
  let results = null;
  for (const ep of endpoints) {
    try {
      console.log(`[MELI] ${account}: probando ${ep}`);
      const data = await _meliGet(ep, token);
      console.log(`[MELI] ${account}: ${ep} → ${(data.results||[]).length} órdenes`);
      results = data.results || [];
      break;
    } catch(e) {
      console.warn(`[MELI] ${account}: ${ep} falló — ${e.message}`);
    }
  }
  if (!results) return [];

  const cutoff = Date.now() - 48 * 3600 * 1000;
  const filtered = results.filter(o =>
    o.status === 'paid' && new Date(o.date_created).getTime() >= cutoff
  );
  console.log(`[MELI] ${account}: ${filtered.length} órdenes pagadas en últimas 48h`);
  return filtered.map(o => ({ ...o, _account: account }));
}

// ─── SYNC PRINCIPAL ───────────────────────────────────────────────────────────
async function syncMeli(showToast = true) {
  if (!meliTokens.capi && !meliTokens.enano) {
    if (showToast) toast('MELI no conectado — configurá en ajustes');
    return;
  }
  const syncBtn = document.getElementById('btn-sync');
  if (syncBtn) syncBtn.classList.add('syncing');
  if (showToast) toast('Sincronizando MELI...');

  try {
    const [capiOrders, enanoOrders] = await Promise.all([
      _fetchTodayOrders('capi'),
      _fetchTodayOrders('enano'),
    ]);
    const all = [...capiOrders, ...enanoOrders];

    const candidates = [];
    for (const o of all) {
      const id        = String(o.id);
      const ignored   = meliIgnoredIds.has(id);
      const loaded    = _isMeliOrderLoaded(id);
      const dispatched= _isMeliDispatched(o);
      console.log(`[MELI] orden ${id} (${o._account}) status=${o.status} shipping=${o.shipping?.status} → ignored=${ignored} loaded=${loaded} dispatched=${dispatched}`);
      if (ignored || loaded || dispatched) continue;
      candidates.push(o);
    }
    if (candidates.length) await _enrichFromShipment(candidates);
    const suggestions = candidates.map(o => _buildSuggestion(o));
    meliSuggestions = suggestions;
    updateMeliBadge();

    if (suggestions.length > 0 && document.hidden) _notifyNewOrders(suggestions.length);
    await _updateTracking(all);

    if (showToast) {
      toast(suggestions.length > 0
        ? `${suggestions.length} pedido${suggestions.length > 1 ? 's' : ''} nuevo${suggestions.length > 1 ? 's' : ''} en MELI ✓`
        : 'MELI sincronizado ✓'
      );
    }
  } catch(e) {
    console.warn('MELI sync:', e);
    if (showToast) toast('Error al sincronizar con MELI');
  } finally {
    if (syncBtn) syncBtn.classList.remove('syncing');
  }
}
window.syncMeli = syncMeli;

// ─── ENRIQUECIMIENTO DE NOMBRES ──────────────────────────────────────────────
async function _enrichFromShipment(orders) {
  await Promise.all(orders.map(async o => {
    if (!o.shipping?.id) return;
    try {
      const token = await _meliGetToken(o._account);
      if (!token) return;
      const s = await _meliGet(`/shipments/${o.shipping.id}`, token);
      if (s.receiver_address) o.shipping.receiver_address = s.receiver_address;
      if (s.logistic_type) o.shipping.logistic_type = s.logistic_type;
      if (s.mode)          o.shipping.mode          = s.mode;
      if (s.tags)          o.shipping.tags          = s.tags;
    } catch(e) { console.warn(`[MELI] shipment ${o.shipping?.id}:`, e.message); }
  }));
}

// ─── FILTROS ──────────────────────────────────────────────────────────────────
function _isMeliOrderLoaded(meliId) {
  return orders.some(o => o.meliOrderId && String(o.meliOrderId) === String(meliId));
}
function _isMeliDispatched(order) {
  return ['shipped', 'delivered', 'not_delivered', 'cancelled'].includes(order.shipping?.status);
}

// ─── CONSTRUIR SUGERENCIA ─────────────────────────────────────────────────────
function _buildSuggestion(order) {
  const localidad = _getLocality(order);
  const norm = localidad ? normalizeStr(localidad.toLowerCase()) : '';
  const zone = norm && (typeof zones !== 'undefined' ? zones : []).find(z =>
    normalizeStr(z.localidad.toLowerCase()).includes(norm) ||
    norm.includes(normalizeStr(z.localidad.toLowerCase()))
  );
  return {
    meliOrderId: String(order.id),
    account:     order._account,
    nombre:      _getBuyerName(order),
    nickname:    order.buyer?.nickname || '',
    tipoEnvio:   zone ? 'FLEX' : 'PE',
    localidad,
    provincia:   _getProvince(order),
    importe:     _getAmount(order),
    items:       _parseItems(order.order_items),
    dateCreated: order.date_created,
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
  console.log(`[MELI] shipping detect — logistic=${logistic} mode=${mode} tags=${JSON.stringify([...tags,...shipTags])}`);
  return 'PE';
}
function _getBuyerName(order) {
  const rec = order.shipping?.receiver_address;
  if (rec?.receiver_name) return titleCase(rec.receiver_name.trim());
  const b = order.buyer;
  if (b?.first_name) return titleCase(`${b.first_name} ${b.last_name || ''}`.trim());
  if (b?.nickname)   return titleCase(b.nickname.trim());
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
  return pay.net_received_amount || 0;
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
}
window.updateMeliBadge = updateMeliBadge;

function _notifyNewOrders(count) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  new Notification('FullSports — Pedidos nuevos', {
    body: `${count} pedido${count > 1 ? 's' : ''} sin cargar`,
    icon: 'icons/icon-192.png',
    tag: 'meli-new-orders', renotify: true,
  });
}

// ─── POLLING ──────────────────────────────────────────────────────────────────
function startMeliPolling() {
  if (meliPollTimer) clearInterval(meliPollTimer);
  meliPollTimer = setInterval(() => syncMeli(false), MELI_POLL_MS);
  _meliStartTokenKeepAlive();
}

// Refresca tokens proactivamente antes de que expiren
function _meliStartTokenKeepAlive() {
  setInterval(async () => {
    for (const acct of ['capi', 'enano']) {
      const ac = meliTokens[acct];
      if (!ac?.refreshToken) continue;
      // Refresh si quedan menos de 3 horas
      if (ac.expiresAt - Date.now() < 3 * 60 * 60 * 1000) {
        await _meliRefreshToken(acct);
      }
    }
  }, 30 * 60 * 1000); // revisar cada 30 minutos
}

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

  if (!filtered.length) { chipWrap.classList.add('hidden'); return; }

  const n = filtered.length;
  chipWrap.classList.remove('hidden');
  chipWrap.dataset.cuenta = cuenta || '';
  chipCount.textContent = n;
  chipLabel.textContent = `pedido${n > 1 ? 's' : ''} pendiente${n > 1 ? 's' : ''} de carga`;

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
};

window.meliSelectSuggestion = function(meliOrderId) {
  const sug = meliSuggestions.find(s => s.meliOrderId === meliOrderId);
  if (!sug) return;
  meliSelectedSug = sug;
  _fillFormFromSuggestion(sug);
  document.getElementById('meli-suggestions-panel')?.classList.add('collapsed');
  document.getElementById('meli-chip-btn')?.classList.remove('open');
};

function _fillFormFromSuggestion(sug) {
  setCuenta(sug.account || 'capi');
  V('f-nombre').value = sug.nombre || '';
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
    const norm = normalizeStr(sug.localidad.toLowerCase());
    const zone = (typeof zones !== 'undefined' ? zones : []).find(z =>
      normalizeStr(z.localidad.toLowerCase()).includes(norm) ||
      norm.includes(normalizeStr(z.localidad.toLowerCase()))
    );
    if (zone) {
      setEnvio('FLEX');
      formEnvio = { localidad: zone.localidad, zona: zone.zona, importe: zone.importe };
      showZoneSelected();
      updateNeto();
      V('f-provincia').value = zone.zona.includes('CABA')
        ? 'Ciudad Autónoma de Buenos Aires'
        : 'Buenos Aires';
    } else {
      setEnvio('PE');
      if (sug.provincia) V('f-provincia').value = sug.provincia;
    }
  }
  const validItems = sug.items.filter(i => i.talle);
  if (validItems.length) { formItems = validItems; renderFormItems(); }
  haptic([10, 30, 10]);
  toast('Datos cargados desde MELI ✓');
}

window.meliDismiss = function(meliOrderId) {
  meliIgnoredIds.add(String(meliOrderId));
  _meliSaveIgnored();
  meliSuggestions = meliSuggestions.filter(s => s.meliOrderId !== String(meliOrderId));
  updateMeliBadge();
  window.renderMeliSuggestions();
};

function meliMarkLoaded(meliOrderId) {
  if (!meliOrderId) return;
  meliSuggestions = meliSuggestions.filter(s => s.meliOrderId !== String(meliOrderId));
  meliSelectedSug = null;
  updateMeliBadge();
}
window.meliMarkLoaded = meliMarkLoaded;

function meliGetSelectedId()  { return meliSelectedSug?.meliOrderId || null; }
function meliResetSelected() {
  meliSelectedSug = null;
  const tag = document.getElementById('meli-order-tag');
  if (tag) tag.classList.add('hidden');
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
    } catch(e) { console.warn('MELI dispatch check:', e.message); }
  }
  if (inconsistentes.length)
    toast(`⚠️ Sin despacho en MELI: ${inconsistentes.join(', ')}`, 6000);
}
window.meliCheckDispatch = meliCheckDispatch;

// ─── TRACKING ────────────────────────────────────────────────────────────────
async function _updateTracking(freshMeliOrders) {
  const inTransit = orders.filter(o => o.status === 'camino' && o.meliOrderId);
  if (!inTransit.length) return;
  let changed = false;
  for (const order of inTransit) {
    const mo = freshMeliOrders.find(m => String(m.id) === String(order.meliOrderId));
    if (mo?.shipping?.status === 'delivered') {
      const f = new Date().toLocaleDateString('es-AR');
      mutateOrder(order.id, { status: 'entregado', fechaEntrega: f, deliveredAt: Date.now() });
      try { await db.collection('orders').doc(order.id).update({ status: 'entregado', deliveredAt: TS(), fechaEntrega: f }); } catch(e) {}
      changed = true;
    }
  }
  if (changed) renderPedidos();
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
