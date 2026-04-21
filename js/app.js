import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup,
  onAuthStateChanged, setPersistence, browserLocalPersistence
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, enableIndexedDbPersistence,
  collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp, query, orderBy
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { FIREBASE_CONFIG, AUTHORIZED_EMAIL } from './config.js';
import { FLEX_ZONES } from './flex-zones.js';

const fbApp = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

setPersistence(auth, browserLocalPersistence).catch(() => {});
enableIndexedDbPersistence(db).catch(() => {});

let orders = [];
let stock = {};
let flexZones = [...FLEX_ZONES];
let formItems = [];
let formEnvio = null;
let currentUser = null;
let alertTimers = [];

const PRODUCTOS = ['Mostaza', 'Total Black', 'Media caña', 'Borcegos', 'Caramelo'];
const TALLES = [38, 39, 40, 41, 42, 43, 44, 45];
const COSTO_COMUN = 21900;
const COSTO_ESPECIAL = 22400;
const TALLES_ESPECIALES = [43, 44, 45];

const loginScreen = document.getElementById('login-screen');
const appEl = document.getElementById('app');
const offlinePill = document.getElementById('offline-pill');
const alertBanner = document.getElementById('alert-banner');
const views = {
  pedidos: document.getElementById('view-pedidos'),
  corte: document.getElementById('view-corte'),
  stock: document.getElementById('view-stock'),
  config: document.getElementById('view-config'),
};
const sheetOverlay = document.getElementById('sheet-overlay');
const sheetNueva = document.getElementById('sheet-nueva');
const sheetDelivery = document.getElementById('sheet-delivery');
const sheetEditZone = document.getElementById('sheet-edit-zone');

// ── AUTH — persiste entre sesiones, nunca pide login si ya se logueó
const LS_AUTH = 'fs_auth_ok';
let appInited = false;

// Ambas pantallas ocultas hasta saber si hay usuario
loginScreen.style.display = 'none';
appEl.style.display = 'none';

document.getElementById('btn-google').addEventListener('click', async () => {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) { alert('Error al iniciar sesión: ' + e.message); }
});

onAuthStateChanged(auth, user => {
  if (user && user.email === AUTHORIZED_EMAIL) {
    localStorage.setItem(LS_AUTH, '1');
    currentUser = user;
    loginScreen.style.display = 'none';
    appEl.style.display = 'flex';
    const av = document.getElementById('user-avatar');
    av.textContent = user.displayName?.[0] || '?';
    if (user.photoURL) av.innerHTML = `<img src="${user.photoURL}">`;
    if (!appInited) { appInited = true; initApp(); }
  } else if (user) {
    auth.signOut();
    localStorage.removeItem(LS_AUTH);
  } else {
    // Si nunca se logueó → mostrar login
    // Si se logueó antes → Firebase aún está restaurando la sesión, esperar
    if (!localStorage.getItem(LS_AUTH)) {
      loginScreen.style.display = 'flex';
      appEl.style.display = 'none';
    }
    // Si había sesión previa, Firebase la va a restaurar sola en milisegundos
    // No mostramos login para evitar parpadeo
  }
});

function initApp() {
  listenOrders();
  listenStock();
  loadFlexZones();
  setupNav();
  setupSwipe();
  setupDispatchAlerts();
  setupOfflineDetection();
  requestNotificationPermission();
  navigateTo('pedidos');
}

function setupOfflineDetection() {
  const update = () => offlinePill.classList.toggle('show', !navigator.onLine);
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

function listenOrders() {
  const q = query(collection(db, 'orders'), orderBy('createdAt', 'desc'));
  onSnapshot(q, snap => {
    orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderPedidos();
    renderCorte();
  });
}

function listenStock() {
  onSnapshot(doc(db, 'meta', 'stock'), snap => {
    if (snap.exists()) stock = snap.data();
    renderStock();
  });
}

function loadFlexZones() {
  onSnapshot(doc(db, 'meta', 'flexZones'), snap => {
    if (snap.exists()) flexZones = snap.data().zones;
    renderConfig();
  });
}

function setupNav() {
  document.querySelectorAll('[data-nav]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.nav;
      if (target === 'nueva') { openNuevaSheet(); return; }
      navigateTo(target);
    });
  });
}

const TAB_ORDER = ['pedidos', 'corte', 'stock', 'config'];
let currentView = 'pedidos';

function navigateTo(name) {
  currentView = name;
  Object.values(views).forEach(v => v.classList.remove('active'));
  document.querySelectorAll('[data-nav]').forEach(b => b.classList.remove('active'));
  if (views[name]) views[name].classList.add('active');
  const btn = document.querySelector(`[data-nav="${name}"]`);
  if (btn) btn.classList.add('active');
  document.getElementById('topbar-title').textContent =
    { pedidos: 'FullSports', corte: 'Corte', stock: 'Stock', config: 'Configuración' }[name] || 'FullSports';
}

function setupSwipe() {
  let startX = 0, startY = 0;
  const mc = document.getElementById('main-content');
  mc.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });
  mc.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx) * 0.8) return;
    const idx = TAB_ORDER.indexOf(currentView);
    if (dx < 0 && idx < TAB_ORDER.length - 1) navigateTo(TAB_ORDER[idx + 1]);
    if (dx > 0 && idx > 0) navigateTo(TAB_ORDER[idx - 1]);
  }, { passive: true });
}

async function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default')
    await Notification.requestPermission();
}

function setupDispatchAlerts() {
  alertTimers.forEach(t => clearTimeout(t));
  alertTimers = [];
  const now = new Date();
  [
    { h: 12, m: 30, type: 'warning', msg: '⏰ 30 min para despachar FLEX (tope 13:00hs)' },
    { h: 12, m: 50, type: 'urgent',  msg: '🚨 10 min para despachar FLEX' },
    { h: 13, m: 30, type: 'warning', msg: '⏰ 30 min para despachar Punto de Envío (tope 14:00hs)' },
    { h: 13, m: 50, type: 'urgent',  msg: '🚨 10 min para despachar Punto de Envío' },
  ].forEach(({ h, m, type, msg }) => {
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    const diff = target - now;
    if (diff > 0) alertTimers.push(setTimeout(() => showAlert(type, msg), diff));
  });
  setInterval(updateCountdowns, 30000);
}

function showAlert(type, msg) {
  alertBanner.className = `alert-banner show ${type}`;
  alertBanner.textContent = msg;
  setTimeout(() => alertBanner.classList.remove('show'), 8000);
  if (Notification.permission === 'granted')
    new Notification('FullSports', { body: msg, icon: '/icons/icon-192.png' });
}

function updateCountdowns() {
  document.querySelectorAll('[data-countdown]').forEach(el => {
    const tipo = el.dataset.countdown;
    const now = new Date();
    const tope = new Date();
    if (tipo === 'FLEX') tope.setHours(13, 0, 0, 0);
    else tope.setHours(14, 0, 0, 0);
    const diff = tope - now;
    if (diff <= 0) { el.style.display = 'none'; return; }
    el.style.display = '';
    const min = Math.floor(diff / 60000);
    el.textContent = `${min} min`;
    el.className = 'countdown' + (min <= 15 ? ' urgent' : '');
  });
}

// ── PEDIDOS VIEW
let pedidosFilter = 'todos';

function renderPedidos() {
  const view = views.pedidos;
  const activeOrders = orders.filter(o => o.status !== 'entregado');
  const entregados = orders.filter(o => {
    if (o.status !== 'entregado') return false;
    return Date.now() - (o.deliveredAt?.toMillis?.() || 0) < 48 * 3600 * 1000;
  });
  const all = [...activeOrders, ...entregados];
  const filtered = pedidosFilter === 'todos' ? all
    : all.filter(o => o.status === pedidosFilter);
  const counts = {
    preparar: all.filter(o => o.status === 'preparar').length,
    pendiente: all.filter(o => o.status === 'pendiente').length,
    camino: all.filter(o => o.status === 'camino').length,
    entregado: entregados.length,
  };
  // FLEX siempre primero (más urgentes)
  filtered.sort((a, b) => {
    if (a.tipoEnvio !== b.tipoEnvio) return a.tipoEnvio === 'FLEX' ? -1 : 1;
    return 0;
  });

  const pendienteFlex = all.filter(o => o.status === 'pendiente' && o.tipoEnvio === 'FLEX').length;
  const pendientePE   = all.filter(o => o.status === 'pendiente' && o.tipoEnvio === 'PE').length;
  const dispatchStrip = (pendienteFlex > 0 || pendientePE > 0) ? `
    <div class="dispatch-strip">
      ${pendienteFlex > 0 ? `<button class="dispatch-btn flex-btn" onclick="despacharTodos('FLEX')">🚚 Despachar todos FLEX (${pendienteFlex})</button>` : ''}
      ${pendientePE   > 0 ? `<button class="dispatch-btn pe-btn"   onclick="despacharTodos('PE')">🚚 Despachar todos PE (${pendientePE})</button>` : ''}
    </div>` : '';

  view.innerHTML = `
    <div class="filter-pills">
      ${['todos','preparar','pendiente','camino','entregado'].map(f => `
        <button class="pill${pedidosFilter===f?' active':''}" onclick="setFilter('${f}')">
          ${{todos:'Todos',preparar:'Por preparar',pendiente:'Pendiente',camino:'En camino',entregado:'Entregados'}[f]}
          ${f!=='todos'&&counts[f]?`<span style="opacity:.7"> ${counts[f]}</span>`:''}
        </button>`).join('')}
    </div>
    ${dispatchStrip}
    ${filtered.length === 0
      ? `<div class="empty-state"><span>📦</span><p>No hay pedidos</p></div>`
      : filtered.map(o => renderOrderCard(o)).join('')}
  `;
  updateCountdowns();
}

window.setFilter = (f) => { pedidosFilter = f; renderPedidos(); };

function renderOrderCard(o) {
  const sinCorte = !o.corteDone ? '<span class="badge badge-sin-corte">Sin corte</span>' : '';
  const cuentaBadge = `<span class="badge badge-${o.cuenta}">${o.cuenta.toUpperCase()}</span>`;
  const envBadge = o.tipoEnvio === 'FLEX'
    ? `<span class="badge badge-flex">FLEX</span>`
    : `<span class="badge badge-pe">PE</span>`;

  let montoHtml = '';
  if (o.tipoEnvio === 'FLEX' && o.importeVenta) {
    montoHtml = `<div class="order-monto flex-detail">Venta $${fmt(o.importeVenta)} − FLEX $${fmt(o.flexImporte)} = <b>$${fmt(o.importeNeto)}</b></div>`;
  } else {
    montoHtml = `<div class="order-monto">Se acreditó $${fmt(o.importeAcreditado)}</div>`;
  }

  let iibbHtml = '';
  if (o.cuenta === 'enano' && o.provincia)
    iibbHtml = `<div class="order-iibb">${o.provincia} — IIBB $${fmtDec(o.iibb)}</div>`;

  let countdownHtml = '';
  if (o.status === 'preparar') {
    const tope = new Date();
    if (o.tipoEnvio === 'FLEX') tope.setHours(13, 0, 0, 0);
    else tope.setHours(14, 0, 0, 0);
    if (tope - new Date() > 0)
      countdownHtml = `<span class="countdown" data-countdown="${o.tipoEnvio}">${o.tipoEnvio === 'FLEX' ? '13:00hs' : '14:00hs'}</span>`;
  }

  const fechaHtml = (o.status !== 'entregado' && o.fechaEstimada) ? `
    <div class="order-fecha">📅 Llega ${o.fechaEstimada}
      <button class="btn-edit-fecha" onclick="openDeliveryDate('${o.id}')">✏️</button>
    </div>` : '';

  let statusActions = '';
  if (o.status === 'preparar') {
    statusActions = `
      <button class="btn btn-green" onclick="marcarPreparado('${o.id}')">✓ Preparado</button>
      <button class="btn btn-ghost btn-sm" onclick="editOrder('${o.id}')">Editar</button>
      <button class="btn btn-danger btn-sm" onclick="deleteOrder('${o.id}')">Eliminar</button>`;
  } else if (o.status === 'pendiente') {
    statusActions = `
      <button class="btn btn-primary" onclick="marcarDespachado('${o.id}')">🚚 Despachado</button>
      <button class="btn btn-danger btn-sm" onclick="deleteOrder('${o.id}')">Eliminar</button>`;
  } else if (o.status === 'camino') {
    statusActions = `
      <button class="btn btn-green" onclick="marcarEntregado('${o.id}')">✓ Entregado</button>`;
  } else if (o.status === 'entregado') {
    statusActions = `<div class="order-meta" style="color:var(--green)">✓ Entregado${o.fechaEntrega ? ' — ' + o.fechaEntrega : ''}</div>`;
  }

  return `
    <div class="order-card">
      <div class="order-header">${cuentaBadge}${envBadge}${sinCorte}${countdownHtml}</div>
      <div class="order-name">${o.nombreComprador}</div>
      <div class="order-items">${formatItemsShort(o.items)}</div>
      ${fechaHtml}${iibbHtml}${montoHtml}
      <div class="order-actions">${statusActions}</div>
    </div>`;
}

function sortItems(items) {
  if (!items) return [];
  return [...items].sort((a, b) =>
    a.producto !== b.producto ? a.producto.localeCompare(b.producto) : a.talle - b.talle
  );
}

function formatItemsShort(items) {
  if (!items || items.length === 0) return '';
  const sorted = sortItems(items);
  if (sorted.length === 1) return `${sorted[0].producto} T${sorted[0].talle}`;
  const groups = {};
  sorted.forEach(i => { const k = `${i.producto} T${i.talle}`; groups[k] = (groups[k] || 0) + 1; });
  return `${sorted.length} pares — ${Object.entries(groups).map(([k,q]) => q>1?`${k} ×${q}`:k).join(' · ')}`;
}

// ── ORDER ACTIONS
window.marcarPreparado = async (id) => {
  const order = orders.find(o => o.id === id);
  await updateDoc(doc(db, 'orders', id), { status: 'pendiente' });
  if (order?.items) {
    const newStock = { ...stock };
    order.items.forEach(item => {
      const key = `${item.producto}_${item.talle}`;
      newStock[key] = Math.max(0, (newStock[key] || 0) - 1);
    });
    await updateDoc(doc(db, 'meta', 'stock'), newStock);
  }
};

window.marcarDespachado = async (id) => {
  await updateDoc(doc(db, 'orders', id), { status: 'camino', despachadoAt: serverTimestamp() });
};

window.despacharTodos = async (tipoEnvio) => {
  const pendientes = orders.filter(o => o.status === 'pendiente' && o.tipoEnvio === tipoEnvio);
  if (!pendientes.length) return;
  if (!confirm(`¿Despachar ${pendientes.length} pedido${pendientes.length>1?'s':''} ${tipoEnvio}?`)) return;
  for (const o of pendientes)
    await updateDoc(doc(db, 'orders', o.id), { status: 'camino', despachadoAt: serverTimestamp() });
  showToast(`${pendientes.length} pedidos ${tipoEnvio} despachados`);
};

window.marcarEntregado = async (id) => {
  await updateDoc(doc(db, 'orders', id), {
    status: 'entregado', deliveredAt: serverTimestamp(),
    fechaEntrega: new Date().toLocaleDateString('es-AR')
  });
};

window.deleteOrder = async (id) => {
  if (!confirm('¿Eliminar este pedido?')) return;
  await deleteDoc(doc(db, 'orders', id));
};

let deliveryOrderId = null;
window.openDeliveryDate = (id) => {
  deliveryOrderId = id;
  const o = orders.find(o => o.id === id);
  document.getElementById('delivery-date-input').value = o?.fechaEstimada || '';
  openSheet(sheetDelivery);
};
document.getElementById('btn-save-delivery').addEventListener('click', async () => {
  const val = document.getElementById('delivery-date-input').value;
  if (!val || !deliveryOrderId) return;
  await updateDoc(doc(db, 'orders', deliveryOrderId), { fechaEstimada: val });
  closeSheet(sheetDelivery);
});

// ── NUEVA VENTA FORM
let editingOrderId = null;

function openNuevaSheet(orderData = null) {
  editingOrderId = orderData?.id || null;
  formItems = orderData?.items ? [...orderData.items] : [];
  formEnvio = null;

  sheetNueva.querySelector('.sheet-title').textContent = editingOrderId ? 'Editar pedido' : 'Nueva venta';
  setCuenta(orderData?.cuenta || 'capi');
  setTipoEnvio(orderData?.tipoEnvio || 'FLEX');
  document.getElementById('f-nombre').value = orderData?.nombreComprador || '';
  document.getElementById('f-provincia').value = orderData?.provincia || '';
  document.getElementById('f-iibb').value = orderData?.iibb ? fmtDec(orderData.iibb) : '';
  document.getElementById('f-importe-pe').value = orderData?.importeAcreditado || '';
  document.getElementById('f-importe-flex').value = orderData?.importeVenta || '';

  if (orderData?.tipoEnvio === 'FLEX' && orderData.flexLocalidad) {
    formEnvio = { localidad: orderData.flexLocalidad, zona: orderData.flexZona, importe: orderData.flexImporte };
    showSelectedZone(formEnvio);
  } else {
    clearZoneSelection();
  }

  initItemSelector();
  renderFormItems();
  openSheet(sheetNueva);
  setTimeout(() => { sheetNueva.querySelector('.sheet-body').scrollTop = 0; }, 50);
}

window.editOrder = (id) => {
  const o = orders.find(o => o.id === id);
  if (o) openNuevaSheet(o);
};

let currentCuenta = 'capi';
function setCuenta(c) {
  currentCuenta = c;
  document.querySelectorAll('[data-cuenta]').forEach(b => b.classList.toggle('active', b.dataset.cuenta === c));
  document.getElementById('enano-fields').style.display = c === 'enano' ? 'flex' : 'none';
}
document.querySelectorAll('[data-cuenta]').forEach(b => b.addEventListener('click', () => setCuenta(b.dataset.cuenta)));

let currentTipoEnvio = 'FLEX';
function setTipoEnvio(t) {
  currentTipoEnvio = t;
  document.querySelectorAll('[data-envio]').forEach(b => b.classList.toggle('active', b.dataset.envio === t));
  document.getElementById('flex-fields').style.display = t === 'FLEX' ? 'flex' : 'none';
  document.getElementById('pe-fields').style.display = t === 'PE' ? 'flex' : 'none';
}
document.querySelectorAll('[data-envio]').forEach(b => b.addEventListener('click', () => setTipoEnvio(b.dataset.envio)));

const localidadInput = document.getElementById('f-localidad');
const searchResults = document.getElementById('localidad-results');
localidadInput.addEventListener('input', () => {
  const q = localidadInput.value.toLowerCase().trim();
  if (!q) { searchResults.classList.remove('show'); return; }
  const matches = flexZones.filter(z => z.localidad.toLowerCase().includes(q)).slice(0, 8);
  if (!matches.length) { searchResults.classList.remove('show'); return; }
  searchResults.innerHTML = matches.map(z => `
    <div class="search-result-item" onclick="selectZone('${z.localidad}','${z.zona}',${z.importe})">
      <div><div>${z.localidad}</div><div class="search-result-zona">${z.zona}</div></div>
      <div style="font-weight:700">$${fmt(z.importe)}</div>
    </div>`).join('');
  searchResults.classList.add('show');
});
document.addEventListener('click', e => {
  if (!e.target.closest('.search-wrap')) searchResults.classList.remove('show');
});
window.selectZone = (localidad, zona, importe) => {
  formEnvio = { localidad, zona, importe };
  searchResults.classList.remove('show');
  localidadInput.value = '';
  showSelectedZone(formEnvio);
  updateFlexNeto();
};
function showSelectedZone(z) {
  const el = document.getElementById('flex-selected');
  el.innerHTML = `
    <div>
      <div class="flex-selected-name">${z.localidad}</div>
      <div style="font-size:12px;color:var(--text-secondary)">${z.zona}</div>
    </div>
    <div>
      <div class="flex-selected-importe">−$${fmt(z.importe)}</div>
      <button onclick="clearZoneSelection()" style="background:none;border:none;color:var(--red);font-size:12px;cursor:pointer">Cambiar</button>
    </div>`;
  el.classList.add('show');
  updateFlexNeto();
}
window.clearZoneSelection = () => {
  formEnvio = null;
  document.getElementById('flex-selected').classList.remove('show');
  document.getElementById('flex-neto').textContent = '';
};
document.getElementById('f-importe-flex').addEventListener('input', updateFlexNeto);
function updateFlexNeto() {
  const venta = parseNum(document.getElementById('f-importe-flex').value);
  if (formEnvio && venta > 0) {
    document.getElementById('flex-neto').textContent = `Total sin envío: $${fmt(venta - formEnvio.importe)}`;
  } else {
    document.getElementById('flex-neto').textContent = '';
  }
}

// ── ITEM SELECTOR: modelo → talle → auto-agrega (1 unidad)
let formProducto = null;
let formTalle = null;
let stockOverride = false;

// estado para venta múltiple
let multiProducto = null;
let multiTalle = null;
let multiCant = null;

function initItemSelector() {
  stockOverride = false;
  formProducto = null;
  formTalle = null;
  multiProducto = null; multiTalle = null; multiCant = null;
  const overrideBtn = document.getElementById('btn-stock-override');
  if (overrideBtn) overrideBtn.textContent = '✏️ Manual';
  renderProductoButtons();
  document.getElementById('talle-wrap').style.display = 'none';
  document.getElementById('btn-add-otro').style.display = 'none';
  document.getElementById('btn-multi').style.display = 'none';
  document.getElementById('multi-wrap').style.display = 'none';
}

function renderProductoButtons() {
  const productosDisp = PRODUCTOS.filter(p =>
    stockOverride || TALLES.some(t => (stock[`${p}_${t}`] ?? 0) > 0)
  );
  const container = document.getElementById('producto-btns');
  if (!container) return;
  container.innerHTML = productosDisp.length
    ? productosDisp.map(p => `<button class="producto-btn" onclick="selectProducto('${p}')">${p}</button>`).join('')
    : `<div style="color:var(--text-3);font-size:14px;padding:4px 0">Sin stock — activá ✏️ Manual.</div>`;
}

window.selectProducto = (p) => {
  formProducto = p;
  formTalle = null;
  document.querySelectorAll('#producto-btns .producto-btn').forEach(b =>
    b.classList.toggle('active', b.textContent.trim() === p));
  const tallesDisp = TALLES.filter(t => stockOverride || (stock[`${p}_${t}`] ?? 0) > 0);
  document.getElementById('talle-btns').innerHTML = tallesDisp.map(t =>
    `<button class="talle-btn" onclick="selectTalle(${t})">${t}</button>`).join('');
  document.getElementById('talle-wrap').style.display = 'flex';
};

window.selectTalle = (t) => {
  // auto-agrega inmediatamente (1 unidad)
  formItems.push({ producto: formProducto, talle: t });
  renderFormItems();
  // reset selector
  formProducto = null; formTalle = null;
  document.getElementById('talle-wrap').style.display = 'none';
  document.querySelectorAll('#producto-btns .producto-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('btn-add-otro').style.display = 'flex';
  document.getElementById('btn-multi').style.display = 'flex';
};

document.getElementById('btn-add-otro').addEventListener('click', () => {
  renderProductoButtons();
  document.getElementById('talle-wrap').style.display = 'none';
  document.getElementById('btn-add-otro').style.display = 'none';
  document.getElementById('item-selector-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

document.getElementById('btn-multi').addEventListener('click', () => {
  document.getElementById('btn-multi').style.display = 'none';
  document.getElementById('btn-add-otro').style.display = 'none';
  multiProducto = null; multiTalle = null; multiCant = null;
  renderMultiProductoButtons();
  document.getElementById('multi-talle-wrap').style.display = 'none';
  document.getElementById('multi-cant-wrap').style.display = 'none';
  document.getElementById('multi-wrap').style.display = 'block';
  document.getElementById('multi-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

document.getElementById('btn-stock-override').addEventListener('click', () => {
  stockOverride = !stockOverride;
  document.getElementById('btn-stock-override').textContent = stockOverride ? '✏️ Mostrando todo' : '✏️ Manual';
  formProducto = null; formTalle = null;
  renderProductoButtons();
  document.getElementById('talle-wrap').style.display = 'none';
});

// ── VENTA MÚLTIPLE
function renderMultiProductoButtons() {
  const productosDisp = PRODUCTOS.filter(p =>
    stockOverride || TALLES.some(t => (stock[`${p}_${t}`] ?? 0) > 0)
  );
  document.getElementById('multi-producto-btns').innerHTML = productosDisp.map(p =>
    `<button class="producto-btn" onclick="multiSelectProducto('${p}')">${p}</button>`
  ).join('');
}

window.multiSelectProducto = (p) => {
  multiProducto = p; multiTalle = null; multiCant = null;
  document.querySelectorAll('#multi-producto-btns .producto-btn').forEach(b =>
    b.classList.toggle('active', b.textContent.trim() === p));
  const tallesDisp = TALLES.filter(t => stockOverride || (stock[`${p}_${t}`] ?? 0) > 0);
  document.getElementById('multi-talle-btns').innerHTML = tallesDisp.map(t =>
    `<button class="talle-btn" onclick="multiSelectTalle(${t})">${t}</button>`).join('');
  document.getElementById('multi-talle-wrap').style.display = 'flex';
  document.getElementById('multi-cant-wrap').style.display = 'none';
  document.querySelectorAll('#multi-cant-wrap .cantidad-btn').forEach(b => b.classList.remove('active'));
};

window.multiSelectTalle = (t) => {
  multiTalle = t;
  document.querySelectorAll('#multi-talle-btns .talle-btn').forEach(b =>
    b.classList.toggle('active', parseInt(b.textContent) === t));
  document.getElementById('multi-cant-wrap').style.display = 'flex';
  multiCant = null;
  document.querySelectorAll('#multi-cant-wrap .cantidad-btn').forEach(b => b.classList.remove('active'));
};

window.multiSetCant = (c) => {
  multiCant = c;
  document.querySelectorAll('#multi-cant-wrap .cantidad-btn').forEach(b =>
    b.classList.toggle('active', b.textContent.trim() === String(c)));
  if (multiProducto && multiTalle && multiCant) {
    for (let i = 0; i < multiCant; i++)
      formItems.push({ producto: multiProducto, talle: multiTalle });
    renderFormItems();
    // reset multi para seguir agregando
    multiTalle = null; multiCant = null;
    document.getElementById('multi-talle-wrap').style.display = 'none';
    document.getElementById('multi-cant-wrap').style.display = 'none';
    document.querySelectorAll('#multi-producto-btns .producto-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('btn-add-otro').style.display = 'flex';
  }
};

function renderFormItems() {
  const list = document.getElementById('items-list');
  if (!formItems.length) { list.innerHTML = ''; return; }
  list.innerHTML = formItems.map((item, i) => `
    <div class="item-row">
      <span class="item-row-text">${item.producto} T${item.talle}</span>
      <button class="item-remove" onclick="removeItem(${i})">×</button>
    </div>`).join('');
}

window.removeItem = (i) => { formItems.splice(i, 1); renderFormItems(); };

// ── SUBMIT
document.getElementById('btn-guardar-venta').addEventListener('click', async () => {
  const nombre = document.getElementById('f-nombre').value.trim();
  if (!nombre) { alert('Ingresá el nombre del comprador.'); return; }
  if (!formItems.length) { alert('Agregá al menos un ítem.'); return; }

  if (!editingOrderId) {
    const dups = orders.filter(o =>
      o.nombreComprador.toLowerCase().trim() === nombre.toLowerCase() && o.status !== 'entregado'
    );
    if (dups.length > 0) {
      const det = dups.map(o => `• ${o.nombreComprador} — ${formatItemsShort(o.items)} (${o.status})`).join('\n');
      const ok = confirm(`Ya existe un pedido activo a nombre de "${nombre}":\n\n${det}\n\n¿Cargar de todas formas?`);
      if (!ok) return;
    }
  }

  const base = {
    cuenta: currentCuenta,
    nombreComprador: nombre,
    tipoEnvio: currentTipoEnvio,
    items: formItems,
    status: editingOrderId ? (orders.find(o => o.id === editingOrderId)?.status || 'preparar') : 'preparar',
    corteDone: editingOrderId ? (orders.find(o => o.id === editingOrderId)?.corteDone || false) : false,
  };

  if (currentCuenta === 'enano') {
    base.provincia = document.getElementById('f-provincia').value.trim();
    base.iibb = parseNum(document.getElementById('f-iibb').value) || 0;
  }

  if (currentTipoEnvio === 'FLEX') {
    if (!formEnvio) { alert('Seleccioná la localidad FLEX.'); return; }
    const venta = parseNum(document.getElementById('f-importe-flex').value);
    if (!venta) { alert('Ingresá el importe de venta.'); return; }
    base.importeVenta = venta;
    base.flexLocalidad = formEnvio.localidad;
    base.flexZona = formEnvio.zona;
    base.flexImporte = formEnvio.importe;
    base.importeNeto = venta - formEnvio.importe;
    base.importeAcreditado = base.importeNeto;
  } else {
    const monto = parseNum(document.getElementById('f-importe-pe').value);
    if (!monto) { alert('Ingresá el importe acreditado.'); return; }
    base.importeAcreditado = monto;
  }

  if (!editingOrderId) {
    const hoy = new Date();
    const manana = new Date(hoy); manana.setDate(hoy.getDate() + 1);
    const fmtFecha = d => d.toLocaleDateString('es-AR');
    base.fechaEstimada = currentTipoEnvio === 'FLEX' ? fmtFecha(hoy) : fmtFecha(manana);
  }

  if (editingOrderId) {
    await updateDoc(doc(db, 'orders', editingOrderId), base);
  } else {
    base.createdAt = serverTimestamp();
    await addDoc(collection(db, 'orders'), base);
  }
  closeSheet(sheetNueva);
});

// ── CORTE VIEW
let corteCuenta = 'capi';

function renderCorte() {
  const view = views.corte;
  const sinCorteCapi = orders.filter(o => !o.corteDone && o.cuenta === 'capi').length;
  const sinCorteEnano = orders.filter(o => !o.corteDone && o.cuenta === 'enano').length;
  const aPrepCount = orders.filter(o => o.status === 'preparar').length;
  view.innerHTML = `
    <div class="corte-tabs">
      <button class="corte-tab${corteCuenta==='capi'?' active':''}" onclick="setCorte('capi')">
        CAPI <span class="corte-count">${sinCorteCapi}</span>
      </button>
      <button class="corte-tab${corteCuenta==='enano'?' active':''}" onclick="setCorte('enano')">
        ENANO <span class="corte-count">${sinCorteEnano}</span>
      </button>
      <button class="corte-tab${corteCuenta==='deposito'?' active':''}" onclick="setCorte('deposito')">
        Depósito${aPrepCount ? ` <span class="corte-count">${aPrepCount}</span>` : ''}
      </button>
    </div>
    ${renderCorteContent()}`;
}

window.setCorte = (c) => { corteCuenta = c; renderCorte(); };

function renderCorteContent() {
  if (corteCuenta === 'deposito') return renderDeposito();

  const pendientes = orders.filter(o => !o.corteDone && o.cuenta === corteCuenta);
  if (!pendientes.length)
    return `<div class="empty-state"><span>✂️</span><p>No hay ventas pendientes para ${corteCuenta.toUpperCase()}</p></div>`;

  const textoVentas = corteCuenta === 'capi' ? generarTextoCapi(pendientes) : generarTextoEnano(pendientes);
  const textoCostos = generarTextoCostos(pendientes, corteCuenta);

  return `
    <div class="card" style="padding:16px">
      <div class="section-title" style="margin-bottom:10px">Ventas ${corteCuenta.toUpperCase()}</div>
      <div class="text-output">${renderWAText(textoVentas)}</div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" onclick="copyText(${JSON.stringify(textoVentas).replace(/"/g,'&quot;')})">📋 Copiar ventas</button>
        <button class="btn btn-primary btn-sm" onclick="marcarCortado('${corteCuenta}')">✓ Marcar cortado</button>
      </div>
    </div>
    <div class="card" style="padding:16px">
      <div class="section-title" style="margin-bottom:10px">Costos ${corteCuenta.toUpperCase()}</div>
      <div class="text-output">${renderWAText(textoCostos)}</div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-ghost btn-sm" onclick="copyText(${JSON.stringify(textoCostos).replace(/"/g,'&quot;')})">📋 Copiar costos</button>
      </div>
    </div>
    <div class="section-title">Pedidos incluidos (${pendientes.length})</div>
    ${pendientes.map(o => `
      <div class="card" style="padding:12px 14px">
        <div style="font-weight:600">${o.nombreComprador}</div>
        <div style="font-size:14px;color:var(--text-secondary)">${formatItemsShort(o.items)}</div>
        <div style="font-size:13px;color:var(--text-tertiary)">$${fmt(o.importeAcreditado)}</div>
      </div>`).join('')}`;
}

function renderDeposito() {
  const aPrepararOrders = orders.filter(o => o.status === 'preparar');
  if (!aPrepararOrders.length)
    return `<div class="empty-state"><span>🏪</span><p>No hay pedidos para preparar</p></div>`;

  const grupos = {};
  aPrepararOrders.forEach(o => {
    (o.items || []).forEach(item => {
      const k = `${item.producto} T${item.talle}`;
      grupos[k] = (grupos[k] || 0) + 1;
    });
  });
  const lineas = Object.entries(grupos).sort(([a],[b]) => a.localeCompare(b)).map(([k,q]) => `${k} x${q}`);
  const texto = `A buscar en depósito:\n${lineas.join('\n')}\n\nTotal: ${aPrepararOrders.length} pedidos`;

  return `
    <div class="card" style="padding:16px">
      <div class="section-title" style="margin-bottom:10px">A buscar en depósito</div>
      <div class="text-output">${renderWAText(texto)}</div>
      <button class="btn btn-primary" style="margin-top:12px" onclick="copyText(${JSON.stringify(texto).replace(/"/g,'&quot;')})">📋 Copiar lista</button>
    </div>
    <div class="section-title">Pedidos (${aPrepararOrders.length})</div>
    ${aPrepararOrders.map(o => `
      <div class="card" style="padding:12px 14px">
        <div style="font-weight:600">${o.nombreComprador}</div>
        <div style="font-size:14px;color:var(--text-secondary)">${formatItemsShort(o.items)}</div>
        <div style="font-size:12px;color:var(--text-tertiary)">${o.cuenta.toUpperCase()} — ${o.tipoEnvio}</div>
      </div>`).join('')}`;
}

function generarTextoCapi(pendientes) {
  let total = 0;
  const lines = ['Ventas Meli capi'];
  pendientes.forEach((o, i) => {
    lines.push(`${i+1}. ${o.nombreComprador} - ${formatItemsCorte(o.items)} - se acredito $${fmt(o.importeAcreditado)}`);
    total += o.importeAcreditado || 0;
  });
  const totalRedondeado = Math.round(total / 100) * 100;
  lines.push('', `Total acreditado a mp capi $${fmt(totalRedondeado)}`);
  return lines.join('\n');
}

function generarTextoEnano(pendientes) {
  let total = 0;
  const lines = ['Ventas meli enano'];
  pendientes.forEach((o, i) => {
    const iibb = o.provincia && o.iibb ? ` (${o.provincia} IIBB ya descontado $${fmtDec(o.iibb)})` : '';
    const monto = o.tipoEnvio === 'FLEX' && o.importeVenta
      ? `importe venta $${fmt(o.importeVenta)} menos *ENVIO FLEX $${fmt(o.flexImporte)}* total sin envío $${fmt(o.importeNeto)}`
      : `se acredito $${fmt(o.importeAcreditado)}`;
    lines.push(`${i+1}. ${o.nombreComprador}${iibb} - ${formatItemsCorte(o.items)} - ${monto}`);
    total += o.importeAcreditado || 0;
  });
  lines.push('', `*Total acreditado a mp enano $${fmt(total)}*`);
  return lines.join('\n');
}

function generarTextoCostos(pendientes, cuenta) {
  let especiales = 0, comunes = 0;
  pendientes.forEach(o => {
    (o.items || []).forEach(item => {
      if (TALLES_ESPECIALES.includes(item.talle)) especiales++; else comunes++;
    });
  });
  const total = especiales * COSTO_ESPECIAL + comunes * COSTO_COMUN;
  const lines = [`Costo ${cuenta.toUpperCase()}`];
  if (especiales > 0) lines.push(`${especiales} cat especiales $${fmt(COSTO_ESPECIAL)}`);
  if (comunes > 0) lines.push(`${comunes} cat comunes $${fmt(COSTO_COMUN)}`);
  lines.push('', `Total costos $${fmt(total)}`);
  return lines.join('\n');
}

function formatItemsCorte(items) {
  if (!items || !items.length) return '';
  const sorted = sortItems(items);
  if (sorted.length === 1) return `${sorted[0].producto.toLowerCase()} ${sorted[0].talle}`;
  const groups = {};
  sorted.forEach(i => { const k = `${i.producto} ${i.talle}`; groups[k] = (groups[k]||0)+1; });
  return `${sorted.length} pares (${Object.entries(groups).map(([k,q]) => q>1?`${k} x${q}`:k).join(' - ')})`;
}

function renderWAText(text) {
  return text.replace(/\*(.*?)\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
}

window.copyText = (text) => {
  navigator.clipboard.writeText(text).then(() => showToast('¡Copiado!'));
};

window.marcarCortado = async (cuenta) => {
  const pendientes = orders.filter(o => !o.corteDone && o.cuenta === cuenta);
  for (const o of pendientes)
    await updateDoc(doc(db, 'orders', o.id), { corteDone: true });
  showToast('¡Marcado como cortado!');
};

// ── STOCK VIEW (lista por producto)
function renderStock() {
  const view = views.stock;
  view.innerHTML = `
    ${PRODUCTOS.map(p => `
      <div class="card stock-product-card">
        <div class="stock-product-name">${p}</div>
        ${TALLES.map(t => {
          const key = `${p}_${t}`;
          const val = stock[key] ?? 0;
          const cls = val === 0 ? 'cero' : val <= 2 ? 'bajo' : 'ok';
          return `
            <div class="stock-row ${cls}">
              <span class="stock-talle">T${t}</span>
              <div class="stock-stepper">
                <button class="stepper-btn" data-key="${key}" onclick="adjustStock(this.dataset.key,-1)">−</button>
                <span class="stepper-val" data-key="${key}">${val}</span>
                <button class="stepper-btn" data-key="${key}" onclick="adjustStock(this.dataset.key,1)">+</button>
              </div>
            </div>`;
        }).join('')}
      </div>`).join('')}
    <button class="btn btn-primary" onclick="saveStock()">Guardar stock</button>`;
}

window.adjustStock = (key, delta) => {
  stock[key] = Math.max(0, (stock[key] ?? 0) + delta);
  const el = document.querySelector(`.stepper-val[data-key="${key}"]`);
  if (el) {
    el.textContent = stock[key];
    const row = el.closest('.stock-row');
    if (row) row.className = `stock-row ${stock[key] === 0 ? 'cero' : stock[key] <= 2 ? 'bajo' : 'ok'}`;
  }
};

window.saveStock = async () => {
  if (!Object.keys(stock).length) { showToast('Stock no cargado aún'); return; }
  await updateDoc(doc(db, 'meta', 'stock'), { ...stock });
  showToast('Stock guardado ✓');
};

// ── CONFIG VIEW
let configSearch = '';

function renderConfig() {
  const view = views.config;
  const filtered = configSearch
    ? flexZones.filter(z => z.localidad.toLowerCase().includes(configSearch.toLowerCase()))
    : flexZones;
  view.innerHTML = `
    <div class="section-title">Tabla de zonas FLEX</div>
    <input class="form-input config-search" placeholder="Buscar localidad..."
      value="${configSearch}" oninput="filterConfig(this.value)">
    <div class="card" style="padding:0;overflow:hidden">
      ${filtered.map(z => `
        <div class="config-row">
          <div class="config-localidad">
            <div>${z.localidad}</div>
            <div class="config-zona">${z.zona}</div>
          </div>
          <div class="config-importe">$${fmt(z.importe)}</div>
          <button class="config-edit" onclick="openEditZone(${flexZones.indexOf(z)})">✏️</button>
        </div>`).join('')}
    </div>
    <div style="height:16px"></div>`;
}

window.filterConfig = (v) => { configSearch = v; renderConfig(); };

let editingZoneIdx = null;
window.openEditZone = (idx) => {
  editingZoneIdx = idx;
  const z = flexZones[idx];
  document.getElementById('ez-localidad').value = z.localidad;
  document.getElementById('ez-importe').value = z.importe;
  document.getElementById('ez-zona').value = z.zona;
  openSheet(sheetEditZone);
};
document.getElementById('btn-save-zone').addEventListener('click', async () => {
  if (editingZoneIdx === null) return;
  flexZones[editingZoneIdx] = {
    localidad: document.getElementById('ez-localidad').value.trim(),
    zona: document.getElementById('ez-zona').value.trim(),
    importe: parseInt(document.getElementById('ez-importe').value) || 0,
  };
  await updateDoc(doc(db, 'meta', 'flexZones'), { zones: flexZones });
  closeSheet(sheetEditZone);
  renderConfig();
});

// ── SHEETS
function openSheet(sheet) { sheetOverlay.classList.add('open'); sheet.classList.add('open'); }
function closeSheet(sheet) { sheet.classList.remove('open'); sheetOverlay.classList.remove('open'); }

sheetOverlay.addEventListener('click', () => {
  [sheetNueva, sheetDelivery, sheetEditZone].forEach(s => s.classList.remove('open'));
  sheetOverlay.classList.remove('open');
});
document.querySelectorAll('[data-close-sheet]').forEach(btn => {
  btn.addEventListener('click', () => { const s = btn.closest('.sheet'); if (s) closeSheet(s); });
});

// ── TOAST
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ── HELPERS
function fmt(n) { return Math.round(n || 0).toLocaleString('es-AR'); }
function fmtDec(n) { return (n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function parseNum(str) { return parseFloat(String(str).replace(/\./g, '').replace(',', '.')) || 0; }
