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

// ── FIREBASE INIT ──────────────────────────────────────────────────────────
const fbApp = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

setPersistence(auth, browserLocalPersistence);
enableIndexedDbPersistence(db).catch(() => {});

// ── STATE ──────────────────────────────────────────────────────────────────
let orders = [];
let stock = {};
let flexZones = [...FLEX_ZONES]; // local copy (puede ser editada)
let formItems = [];
let formEnvio = null; // { localidad, zona, importe }
let currentUser = null;
let alertTimers = [];

const PRODUCTOS = ['Mostaza', 'Total Black', 'Media caña', 'Borcegos', 'Caramelo'];
const TALLES = [38, 39, 40, 41, 42, 43, 44, 45];
const COSTO_COMUN = 21900;
const COSTO_ESPECIAL = 22400;
const TALLES_ESPECIALES = [43, 44, 45];

// ── DOM REFS ───────────────────────────────────────────────────────────────
const loginScreen = document.getElementById('login-screen');
const appEl = document.getElementById('app');
const offlinePill = document.getElementById('offline-pill');
const alertBanner = document.getElementById('alert-banner');
const bottomNav = document.getElementById('bottom-nav');
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

// ── AUTH ───────────────────────────────────────────────────────────────────
document.getElementById('btn-google').addEventListener('click', async () => {
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    alert('Error al iniciar sesión: ' + e.message);
  }
});

onAuthStateChanged(auth, user => {
  if (user && user.email === AUTHORIZED_EMAIL) {
    currentUser = user;
    loginScreen.style.display = 'none';
    appEl.style.display = 'flex';
    document.getElementById('user-avatar').textContent = user.displayName?.[0] || '?';
    if (user.photoURL) {
      document.getElementById('user-avatar').innerHTML = `<img src="${user.photoURL}">`;
    }
    initApp();
  } else if (user) {
    auth.signOut();
    alert('Acceso no autorizado.');
  } else {
    loginScreen.style.display = 'flex';
    appEl.style.display = 'none';
  }
});

// ── INIT ───────────────────────────────────────────────────────────────────
function initApp() {
  listenOrders();
  listenStock();
  loadFlexZones();
  setupNav();
  setupDispatchAlerts();
  setupOfflineDetection();
  requestNotificationPermission();
  navigateTo('pedidos');
}

// ── OFFLINE ────────────────────────────────────────────────────────────────
function setupOfflineDetection() {
  const update = () => offlinePill.classList.toggle('show', !navigator.onLine);
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

// ── FIRESTORE LISTENERS ────────────────────────────────────────────────────
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

// ── NAVIGATION ─────────────────────────────────────────────────────────────
function setupNav() {
  document.querySelectorAll('[data-nav]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.nav;
      if (target === 'nueva') { openNuevaSheet(); return; }
      navigateTo(target);
    });
  });
}

function navigateTo(name) {
  Object.values(views).forEach(v => v.classList.remove('active'));
  document.querySelectorAll('[data-nav]').forEach(b => b.classList.remove('active'));
  if (views[name]) views[name].classList.add('active');
  const btn = document.querySelector(`[data-nav="${name}"]`);
  if (btn) btn.classList.add('active');
  document.getElementById('topbar-title').textContent = {
    pedidos: 'FullSports', corte: 'Corte', stock: 'Stock', config: 'Configuración'
  }[name] || 'FullSports';
}

// ── DISPATCH ALERTS ────────────────────────────────────────────────────────
async function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

function setupDispatchAlerts() {
  alertTimers.forEach(t => clearTimeout(t));
  alertTimers = [];
  const now = new Date();
  const schedule = [
    { h: 12, m: 30, type: 'warning', msg: '⏰ 30 min para despachar FLEX (tope 13:00hs)' },
    { h: 12, m: 50, type: 'urgent',  msg: '🚨 10 min para despachar FLEX' },
    { h: 13, m: 30, type: 'warning', msg: '⏰ 30 min para despachar Punto de Envío (tope 14:00hs)' },
    { h: 13, m: 50, type: 'urgent',  msg: '🚨 10 min para despachar Punto de Envío' },
  ];
  schedule.forEach(({ h, m, type, msg }) => {
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    const diff = target - now;
    if (diff > 0) {
      alertTimers.push(setTimeout(() => showAlert(type, msg), diff));
    }
  });

  // Countdown refresh each minute
  setInterval(updateCountdowns, 30000);
}

function showAlert(type, msg) {
  alertBanner.className = `alert-banner show ${type}`;
  alertBanner.textContent = msg;
  setTimeout(() => alertBanner.classList.remove('show'), 8000);
  if (Notification.permission === 'granted') {
    new Notification('FullSports', { body: msg, icon: '/icons/icon-192.png' });
  }
}

function updateCountdowns() {
  document.querySelectorAll('[data-countdown]').forEach(el => {
    const tipo = el.dataset.countdown;
    const now = new Date();
    const tope = new Date();
    if (tipo === 'FLEX') tope.setHours(13, 0, 0, 0);
    else tope.setHours(14, 0, 0, 0);
    const diff = tope - now;
    if (diff <= 0) { el.textContent = 'VENCIDO'; el.className = 'countdown urgent'; return; }
    const min = Math.floor(diff / 60000);
    el.textContent = `${min} min`;
    el.className = 'countdown' + (min <= 15 ? ' urgent' : '');
  });
}

// ── PEDIDOS VIEW ───────────────────────────────────────────────────────────
let pedidosFilter = 'todos';

function renderPedidos() {
  const view = views.pedidos;
  const activeOrders = orders.filter(o => o.status !== 'entregado');
  const entregados = orders.filter(o => {
    if (o.status !== 'entregado') return false;
    const diff = Date.now() - (o.deliveredAt?.toMillis?.() || 0);
    return diff < 48 * 3600 * 1000;
  });
  const all = [...activeOrders, ...entregados];

  const filtered = pedidosFilter === 'todos' ? all
    : pedidosFilter === 'preparar' ? all.filter(o => o.status === 'preparar')
    : pedidosFilter === 'pendiente' ? all.filter(o => o.status === 'pendiente')
    : pedidosFilter === 'camino' ? all.filter(o => o.status === 'camino')
    : all.filter(o => o.status === 'entregado');

  const counts = {
    preparar: all.filter(o => o.status === 'preparar').length,
    pendiente: all.filter(o => o.status === 'pendiente').length,
    camino: all.filter(o => o.status === 'camino').length,
    entregado: entregados.length,
  };

  view.innerHTML = `
    <div class="filter-pills">
      ${['todos','preparar','pendiente','camino','entregado'].map(f => `
        <button class="pill${pedidosFilter===f?' active':''}" onclick="setFilter('${f}')">
          ${{todos:'Todos',preparar:'Por preparar',pendiente:'Pendiente',camino:'En camino',entregado:'Entregados'}[f]}
          ${f!=='todos' && counts[f] ? `<span style="opacity:.7"> ${counts[f]}</span>` : ''}
        </button>
      `).join('')}
    </div>
    ${filtered.length === 0 ? `
      <div class="empty-state">
        <span>📦</span>
        <p>No hay pedidos</p>
      </div>
    ` : filtered.map(o => renderOrderCard(o)).join('')}
  `;
  updateCountdowns();
}

window.setFilter = (f) => { pedidosFilter = f; renderPedidos(); };

function renderOrderCard(o) {
  const itemsText = formatItemsShort(o.items);
  const sinCorte = !o.corteDone ? '<span class="badge badge-sin-corte">Sin corte</span>' : '';
  const cuentaBadge = `<span class="badge badge-${o.cuenta}">${o.cuenta.toUpperCase()}</span>`;
  const envBadge = o.tipoEnvio === 'FLEX'
    ? `<span class="badge badge-flex">FLEX</span>`
    : `<span class="badge badge-pe">PE</span>`;

  let montoHtml = '';
  if (o.tipoEnvio === 'FLEX' && o.importeVenta) {
    montoHtml = `
      <div class="order-monto flex-detail">Venta $${fmt(o.importeVenta)} − FLEX $${fmt(o.flexImporte)} = <b>$${fmt(o.importeNeto)}</b></div>`;
  } else {
    montoHtml = `<div class="order-monto">Se acreditó $${fmt(o.importeAcreditado)}</div>`;
  }

  let iibbHtml = '';
  if (o.cuenta === 'enano' && o.provincia) {
    iibbHtml = `<div class="order-iibb">${o.provincia} — IIBB $${fmtDec(o.iibb)}</div>`;
  }

  let countdownHtml = '';
  if (o.status === 'preparar') {
    const tipo = o.tipoEnvio;
    countdownHtml = `<span class="countdown" data-countdown="${tipo}">${tipo === 'FLEX' ? '13:00hs' : '14:00hs'}</span>`;
  }

  let statusActions = '';
  if (o.status === 'preparar') {
    statusActions = `
      <button class="btn btn-green" onclick="marcarPreparado('${o.id}')">✓ Preparado</button>
      <button class="btn btn-ghost btn-sm" onclick="editOrder('${o.id}')">Editar</button>
      <button class="btn btn-danger btn-sm" onclick="deleteOrder('${o.id}')">Eliminar</button>
    `;
  } else if (o.status === 'pendiente') {
    statusActions = `
      <button class="btn btn-primary" onclick="marcarDespachado('${o.id}')">🚚 Despachado</button>
      <button class="btn btn-danger btn-sm" onclick="deleteOrder('${o.id}')">Eliminar</button>
    `;
  } else if (o.status === 'camino') {
    const fecha = o.fechaEstimada ? `<div class="order-meta">Entrega est: ${o.fechaEstimada}</div>` : '';
    statusActions = `
      ${fecha}
      <button class="btn btn-green" onclick="marcarEntregado('${o.id}')">✓ Entregado</button>
      <button class="btn btn-ghost btn-sm" onclick="openDeliveryDate('${o.id}')">📅 Fecha</button>
    `;
  } else if (o.status === 'entregado') {
    statusActions = `<div class="order-meta" style="color:var(--green)">✓ Entregado${o.fechaEntrega ? ' — ' + o.fechaEntrega : ''}</div>`;
  }

  const nroPedido = o.nroPedido ? `<div class="order-meta">Pedido #${o.nroPedido}</div>` : '';

  return `
    <div class="order-card">
      <div class="order-header">
        ${cuentaBadge}${envBadge}${sinCorte}${countdownHtml}
      </div>
      <div class="order-name">${o.nombreComprador}</div>
      <div class="order-items">${itemsText}</div>
      ${iibbHtml}
      ${montoHtml}
      ${nroPedido}
      <div class="order-actions">${statusActions}</div>
    </div>
  `;
}

function formatItemsShort(items) {
  if (!items || items.length === 0) return '';
  if (items.length === 1) return `${items[0].producto} T${items[0].talle}`;
  const groups = {};
  items.forEach(i => {
    const k = `${i.producto} ${i.talle}`;
    groups[k] = (groups[k] || 0) + 1;
  });
  const parts = Object.entries(groups).map(([k, q]) => q > 1 ? `${k} x${q}` : k);
  return `${items.length} pares (${parts.join(' - ')})`;
}

// ── ORDER ACTIONS ──────────────────────────────────────────────────────────
window.marcarPreparado = async (id) => {
  const order = orders.find(o => o.id === id);
  await updateDoc(doc(db, 'orders', id), { status: 'pendiente' });
  // Descontar del stock
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

window.marcarEntregado = async (id) => {
  const today = new Date().toLocaleDateString('es-AR');
  await updateDoc(doc(db, 'orders', id), { status: 'entregado', deliveredAt: serverTimestamp(), fechaEntrega: today });
};

window.deleteOrder = async (id) => {
  if (!confirm('¿Eliminar este pedido?')) return;
  await deleteDoc(doc(db, 'orders', id));
};

// Delivery date sheet
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

// ── NUEVA VENTA FORM ───────────────────────────────────────────────────────
let editingOrderId = null;

function openNuevaSheet(orderData = null) {
  editingOrderId = orderData?.id || null;
  formItems = orderData?.items ? [...orderData.items] : [];
  formEnvio = null;

  const s = sheetNueva;
  s.querySelector('.sheet-title').textContent = editingOrderId ? 'Editar pedido' : 'Nueva venta';

  // Reset form
  setCuenta(orderData?.cuenta || 'capi');
  setTipoEnvio(orderData?.tipoEnvio || 'FLEX');
  document.getElementById('f-nombre').value = orderData?.nombreComprador || '';
  document.getElementById('f-nro').value = orderData?.nroPedido || '';
  document.getElementById('f-provincia').value = orderData?.provincia || '';
  document.getElementById('f-iibb').value = orderData?.iibb || '';
  document.getElementById('f-importe-pe').value = orderData?.importeAcreditado || '';
  document.getElementById('f-importe-flex').value = orderData?.importeVenta || '';

  if (orderData?.tipoEnvio === 'FLEX' && orderData.flexLocalidad) {
    formEnvio = { localidad: orderData.flexLocalidad, zona: orderData.flexZona, importe: orderData.flexImporte };
    showSelectedZone(formEnvio);
  } else {
    clearZoneSelection();
  }

  renderFormItems();
  openSheet(s);
}

window.editOrder = (id) => {
  const o = orders.find(o => o.id === id);
  if (o) openNuevaSheet(o);
};

// Cuenta toggle
let currentCuenta = 'capi';
function setCuenta(c) {
  currentCuenta = c;
  document.querySelectorAll('[data-cuenta]').forEach(b => b.classList.toggle('active', b.dataset.cuenta === c));
  document.getElementById('enano-fields').style.display = c === 'enano' ? 'flex' : 'none';
}
document.querySelectorAll('[data-cuenta]').forEach(b => b.addEventListener('click', () => setCuenta(b.dataset.cuenta)));

// Tipo envío toggle
let currentTipoEnvio = 'FLEX';
function setTipoEnvio(t) {
  currentTipoEnvio = t;
  document.querySelectorAll('[data-envio]').forEach(b => b.classList.toggle('active', b.dataset.envio === t));
  document.getElementById('flex-fields').style.display = t === 'FLEX' ? 'flex' : 'none';
  document.getElementById('pe-fields').style.display = t === 'PE' ? 'flex' : 'none';
}
document.querySelectorAll('[data-envio]').forEach(b => b.addEventListener('click', () => setTipoEnvio(b.dataset.envio)));

// Localidad search
const localidadInput = document.getElementById('f-localidad');
const searchResults = document.getElementById('localidad-results');

localidadInput.addEventListener('input', () => {
  const q = localidadInput.value.toLowerCase().trim();
  if (!q) { searchResults.classList.remove('show'); return; }
  const matches = flexZones.filter(z => z.localidad.toLowerCase().includes(q)).slice(0, 8);
  if (matches.length === 0) { searchResults.classList.remove('show'); return; }
  searchResults.innerHTML = matches.map(z => `
    <div class="search-result-item" onclick="selectZone('${z.localidad}','${z.zona}',${z.importe})">
      <div>
        <div>${z.localidad}</div>
        <div class="search-result-zona">${z.zona}</div>
      </div>
      <div style="font-weight:700">$${fmt(z.importe)}</div>
    </div>
  `).join('');
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
    </div>
  `;
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
    const neto = venta - formEnvio.importe;
    document.getElementById('flex-neto').textContent = `Total sin envío: $${fmt(neto)}`;
  } else {
    document.getElementById('flex-neto').textContent = '';
  }
}

// Items
let formProducto = null;
let formTalle = null;

document.querySelectorAll('[data-producto]').forEach(b => {
  b.addEventListener('click', () => {
    formProducto = b.dataset.producto;
    document.querySelectorAll('[data-producto]').forEach(x => x.classList.toggle('active', x.dataset.producto === formProducto));
  });
});

document.querySelectorAll('[data-talle]').forEach(b => {
  b.addEventListener('click', () => {
    formTalle = parseInt(b.dataset.talle);
    document.querySelectorAll('[data-talle]').forEach(x => x.classList.toggle('active', x.dataset.talle === b.dataset.talle));
  });
});

document.getElementById('btn-add-item').addEventListener('click', () => {
  if (!formProducto || !formTalle) { alert('Seleccioná producto y talle.'); return; }
  formItems.push({ producto: formProducto, talle: formTalle });
  formProducto = null; formTalle = null;
  document.querySelectorAll('[data-producto]').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('[data-talle]').forEach(x => x.classList.remove('active'));
  renderFormItems();
});

function renderFormItems() {
  const list = document.getElementById('items-list');
  if (formItems.length === 0) {
    list.innerHTML = '<div style="color:var(--text-tertiary);font-size:14px;padding:8px 0">Sin ítems. Seleccioná producto y talle.</div>';
    return;
  }
  list.innerHTML = formItems.map((item, i) => `
    <div class="item-row">
      <span class="item-row-text">${item.producto} T${item.talle}</span>
      <button class="item-remove" onclick="removeItem(${i})">×</button>
    </div>
  `).join('');
}

window.removeItem = (i) => { formItems.splice(i, 1); renderFormItems(); };

// Submit
document.getElementById('btn-guardar-venta').addEventListener('click', async () => {
  const nombre = document.getElementById('f-nombre').value.trim();
  if (!nombre) { alert('Ingresá el nombre del comprador.'); return; }
  if (formItems.length === 0) { alert('Agregá al menos un ítem.'); return; }

  const base = {
    cuenta: currentCuenta,
    nombreComprador: nombre,
    nroPedido: document.getElementById('f-nro').value.trim(),
    tipoEnvio: currentTipoEnvio,
    items: formItems,
    status: editingOrderId ? (orders.find(o => o.id === editingOrderId)?.status || 'preparar') : 'preparar',
    corteDone: editingOrderId ? (orders.find(o => o.id === editingOrderId)?.corteDone || false) : false,
  };

  if (currentCuenta === 'enano') {
    base.provincia = document.getElementById('f-provincia').value.trim();
    const iibbRaw = document.getElementById('f-iibb').value.replace(/[.,]/g, '');
    base.iibb = parseFloat(iibbRaw) || 0;
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

  if (editingOrderId) {
    await updateDoc(doc(db, 'orders', editingOrderId), base);
  } else {
    base.createdAt = serverTimestamp();
    await addDoc(collection(db, 'orders'), base);
  }

  closeSheet(sheetNueva);
});

// ── CORTE VIEW ─────────────────────────────────────────────────────────────
let corteCuenta = 'capi';

function renderCorte() {
  const view = views.corte;
  const sinCorteCapi = orders.filter(o => !o.corteDone && o.cuenta === 'capi').length;
  const sinCorteEnano = orders.filter(o => !o.corteDone && o.cuenta === 'enano').length;

  view.innerHTML = `
    <div class="corte-tabs">
      <button class="corte-tab${corteCuenta==='capi'?' active':''}" onclick="setCorte('capi')">
        CAPI <span class="corte-count">${sinCorteCapi}</span>
      </button>
      <button class="corte-tab${corteCuenta==='enano'?' active':''}" onclick="setCorte('enano')">
        ENANO <span class="corte-count">${sinCorteEnano}</span>
      </button>
      <button class="corte-tab${corteCuenta==='costos'?' active':''}" onclick="setCorte('costos')">
        Costos
      </button>
    </div>
    ${renderCorteContent()}
  `;
}

window.setCorte = (c) => { corteCuenta = c; renderCorte(); };

function renderCorteContent() {
  const pendientes = orders.filter(o => !o.corteDone && o.cuenta === corteCuenta);

  if (corteCuenta === 'costos') {
    const allPending = orders.filter(o => !o.corteDone);
    const texto = generarTextoCostos(allPending);
    return `
      <div class="card" style="padding:16px">
        <div class="section-title" style="margin-bottom:10px">Texto para WhatsApp</div>
        <div class="text-output">${renderWhatsAppText(texto)}</div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn btn-primary" onclick="copyText(${JSON.stringify(texto).replace(/"/g,'&quot;')})">📋 Copiar</button>
        </div>
      </div>
    `;
  }

  if (pendientes.length === 0) {
    return `<div class="empty-state"><span>✂️</span><p>No hay ventas pendientes de corte para ${corteCuenta.toUpperCase()}</p></div>`;
  }

  const texto = corteCuenta === 'capi' ? generarTextoCapi(pendientes) : generarTextoEnano(pendientes);
  return `
    <div class="card" style="padding:16px">
      <div class="section-title" style="margin-bottom:10px">Texto para WhatsApp</div>
      <div class="text-output">${renderWhatsAppText(texto)}</div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-primary" onclick="copyAndMark('${corteCuenta}')">📋 Copiar y marcar cortado</button>
      </div>
    </div>
    <div class="section-title">Pedidos incluidos (${pendientes.length})</div>
    ${pendientes.map(o => `
      <div class="card" style="padding:12px 14px">
        <div style="font-weight:600">${o.nombreComprador}</div>
        <div style="font-size:14px;color:var(--text-secondary)">${formatItemsShort(o.items)}</div>
        <div style="font-size:13px;color:var(--text-tertiary)">$${fmt(o.importeAcreditado)}</div>
      </div>
    `).join('')}
  `;
}

function generarTextoCapi(pendientes) {
  let lines = ['Ventas Meli capi'];
  let total = 0;
  pendientes.forEach((o, i) => {
    const items = formatItemsCorte(o.items);
    lines.push(`${i+1}. ${o.nombreComprador} - ${items} - se acredito $${fmt(o.importeAcreditado)}`);
    total += o.importeAcreditado || 0;
  });
  lines.push('');
  lines.push(`Total acreditado a mp capi $${fmt(total)}`);
  return lines.join('\n');
}

function generarTextoEnano(pendientes) {
  let lines = ['Ventas meli enano'];
  let total = 0;
  pendientes.forEach((o, i) => {
    const items = formatItemsCorte(o.items);
    const iibb = o.provincia && o.iibb ? ` (${o.provincia} IIBB ya descontado $${fmtDec(o.iibb)})` : '';
    let montoLine;
    if (o.tipoEnvio === 'FLEX' && o.importeVenta) {
      montoLine = `importe venta $${fmt(o.importeVenta)} menos *ENVIO FLEX $${fmt(o.flexImporte)}* total sin envío $${fmt(o.importeNeto)}`;
    } else {
      montoLine = `se acredito $${fmt(o.importeAcreditado)}`;
    }
    lines.push(`${i+1}. ${o.nombreComprador}${iibb} - ${items} - ${montoLine}`);
    total += o.importeAcreditado || 0;
  });
  lines.push('');
  lines.push(`*Total acreditado a mp enano $${fmt(total)}*`);
  return lines.join('\n');
}

function generarTextoCostos(pendientes) {
  let especiales = 0, comunes = 0;
  pendientes.forEach(o => {
    (o.items || []).forEach(item => {
      if (TALLES_ESPECIALES.includes(item.talle)) especiales++;
      else comunes++;
    });
  });
  const total = especiales * COSTO_ESPECIAL + comunes * COSTO_COMUN;
  const lines = ['Costo'];
  if (especiales > 0) lines.push(`${especiales} cat especiales $${fmt(COSTO_ESPECIAL)}`);
  if (comunes > 0) lines.push(`${comunes} cat comunes $${fmt(COSTO_COMUN)}`);
  lines.push('');
  lines.push(`Total costos $${fmt(total)}`);
  return lines.join('\n');
}

function formatItemsCorte(items) {
  if (!items || items.length === 0) return '';
  if (items.length === 1) return `${items[0].producto.toLowerCase()} ${items[0].talle}`;
  const groups = {};
  items.forEach(i => {
    const k = `${i.producto} ${i.talle}`;
    groups[k] = (groups[k] || 0) + 1;
  });
  const parts = Object.entries(groups).map(([k, q]) => q > 1 ? `${k} x${q}` : k);
  return `${items.length} pares (${parts.join(' - ')})`;
}

function renderWhatsAppText(text) {
  return text
    .replace(/\*(.*?)\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br>');
}

window.copyText = (text) => {
  navigator.clipboard.writeText(text).then(() => showToast('¡Copiado!'));
};

window.copyAndMark = async (cuenta) => {
  const pendientes = orders.filter(o => !o.corteDone && o.cuenta === cuenta);
  const texto = cuenta === 'capi' ? generarTextoCapi(pendientes) : generarTextoEnano(pendientes);
  await navigator.clipboard.writeText(texto);
  for (const o of pendientes) {
    await updateDoc(doc(db, 'orders', o.id), { corteDone: true });
  }
  showToast('¡Copiado y marcado como cortado!');
};

// ── STOCK VIEW ─────────────────────────────────────────────────────────────
function renderStock() {
  const view = views.stock;
  view.innerHTML = `
    <div class="card" style="padding:0;overflow:hidden">
      <table class="stock-table">
        <thead>
          <tr>
            <th>Producto</th>
            ${TALLES.map(t => `<th>${t}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${PRODUCTOS.map(p => `
            <tr>
              <td>${p}</td>
              ${TALLES.map(t => {
                const key = `${p}_${t}`;
                const val = stock[key] ?? 0;
                const cls = val === 0 ? 'cero' : val <= 2 ? 'bajo' : '';
                return `<td><input class="stock-input ${cls}" type="number" min="0" value="${val}"
                  data-key="${key}" onchange="updateStock('${key}', this.value)"></td>`;
              }).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <button class="btn btn-primary" onclick="saveStock()">Guardar stock</button>
  `;
}

window.updateStock = (key, val) => {
  stock[key] = parseInt(val) || 0;
};

window.saveStock = async () => {
  const data = {};
  document.querySelectorAll('[data-key]').forEach(input => {
    data[input.dataset.key] = parseInt(input.value) || 0;
  });
  await updateDoc(doc(db, 'meta', 'stock'), data);
  showToast('Stock guardado');
};

// ── CONFIG VIEW ────────────────────────────────────────────────────────────
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
      ${filtered.map((z, i) => `
        <div class="config-row">
          <div class="config-localidad">
            <div>${z.localidad}</div>
            <div class="config-zona">${z.zona}</div>
          </div>
          <div class="config-importe">$${fmt(z.importe)}</div>
          <button class="config-edit" onclick="openEditZone(${flexZones.indexOf(z)})">✏️</button>
        </div>
      `).join('')}
    </div>
    <div style="height:16px"></div>
  `;
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

// ── SHEET UTILS ────────────────────────────────────────────────────────────
function openSheet(sheet) {
  sheetOverlay.classList.add('open');
  sheet.classList.add('open');
}
function closeSheet(sheet) {
  sheet.classList.remove('open');
  sheetOverlay.classList.remove('open');
}

sheetOverlay.addEventListener('click', () => {
  [sheetNueva, sheetDelivery, sheetEditZone].forEach(s => s.classList.remove('open'));
  sheetOverlay.classList.remove('open');
});

document.querySelectorAll('[data-close-sheet]').forEach(btn => {
  btn.addEventListener('click', () => {
    const sheet = btn.closest('.sheet');
    if (sheet) closeSheet(sheet);
  });
});

// ── TOAST ──────────────────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ── HELPERS ────────────────────────────────────────────────────────────────
function fmt(n) {
  return Math.round(n || 0).toLocaleString('es-AR');
}
function fmtDec(n) {
  return (n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function parseNum(str) {
  return parseFloat(String(str).replace(/\./g, '').replace(',', '.')) || 0;
}
