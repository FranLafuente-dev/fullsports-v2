// ─── FIREBASE INIT ────────────────────────────────────────────────────────────
firebase.initializeApp(FIREBASE_CONFIG);
const db   = firebase.firestore();
const auth = firebase.auth();
const TS   = firebase.firestore.FieldValue.serverTimestamp;
db.enablePersistence({synchronizeTabs: false}).catch(() => {});
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
const PRODUCTOS = ['Mostaza','Total Black','Media caña','Borcegos','Caramelo','Banderas','Remeras Colapinto'];
const PRODUCTOS_FIJO = {
  'Banderas': ['60x90','90x150'],
  'Remeras Colapinto': ['L'],
};
const TALLES      = [38,39,40,41,42,43,44,45];
const TALLES_ESP  = [43,44,45];
const COSTO_COMUN = 21900;
const COSTO_ESP   = 22400;
const H24         = 86400000;
const LS_ORDERS        = 'fs_orders_v4';
const LS_STOCK         = 'fs_stock_v3';
const LS_ZONES         = 'fs_zones_v1';
const LS_FLEX_PERIODS  = 'fs_flexperiods_v1';
const LS_SORTED_PRODS  = 'fs_sorted_prods_v1';

const PROVINCIAS = [
  'Buenos Aires','CABA','Catamarca','Chaco','Chubut','Córdoba',
  'Corrientes','Entre Ríos','Formosa','Jujuy','La Pampa','La Rioja',
  'Mendoza','Misiones','Neuquén','Río Negro','Salta','San Juan',
  'San Luis','Santa Cruz','Santa Fe','Santiago del Estero',
  'Tierra del Fuego','Tucumán',
];
const STOCK_DEFAULTS = {
  'Banderas_60x90': 5,
  'Banderas_90x150': 5,
  'Remeras Colapinto_L': 5,
};

// ─── STATE ────────────────────────────────────────────────────────────────────
let orders = [], stock = {}, zones = [...FLEX_ZONES], flexPeriods = [], flexManualRecords = [];
let curView = 'pedidos', pedidosTab = 'preparar', corteCuenta = 'capi', flexFilter = null;
let _prodSortTs = 0;
let expandFlexPeriods = new Set();
let editingId = null, curCuenta = 'capi', curEnvio = 'FLEX';
let curProducto = null, formItems = [], formEnvio = null;
let deliveryId = null, deliveryAction = 'edit';
let fsConectado = false, stockInitialized = false;
let editZoneIdx = null, editZonePriceLabel = null;
let multiProd = null;
let stockAll = false;
let expandZonas = new Set(), expandParts = new Set();
let alertTimers = [], zoneHits = [];
const UNDO_STACK = [], REDO_STACK = [];
let editFlexId = null, addFlexCuenta = 'capi', addFlexZone = null;
let editFlexCuenta = 'capi', editFlexZone = null;
const LS_FLEX_MANUAL = 'fs_flexmanual_v1';

// ─── DOM ──────────────────────────────────────────────────────────────────────
const $loginScreen = document.getElementById('login-screen');
const $app     = document.getElementById('app');
const $offline = document.getElementById('status-pill');
const $alert   = document.getElementById('alert-banner');
const $overlay = document.getElementById('sheet-overlay');
const $shNueva = document.getElementById('sheet-nueva');
const $shDeliv = document.getElementById('sheet-delivery');
const $shZone  = document.getElementById('sheet-edit-zone');
const $shZoneP = document.getElementById('sheet-edit-precio-zona');
const $stockFab= document.getElementById('stock-fab');
const VIEWS = {
  pedidos: document.getElementById('view-pedidos'),
  corte:   document.getElementById('view-corte'),
  stock:   document.getElementById('view-stock'),
  config:  document.getElementById('view-config'),
};

// ─── ARRANQUE — sesión persiste, login screen empieza oculta ─────────────────
auth.onAuthStateChanged(user => {
  if (user) {
    entrarApp(user);
  } else {
    // Sin sesión: mostrar pantalla de login
    $loginScreen.classList.remove('hidden');
    document.getElementById('btn-google-login').onclick = () => {
      const provider = new firebase.auth.GoogleAuthProvider();
      auth.signInWithPopup(provider)
        .then(r => { $loginScreen.classList.add('hidden'); entrarApp(r.user); })
        .catch(() => {
          document.getElementById('login-error').textContent = 'Error al iniciar sesión. Intentá de nuevo.';
        });
    };
  }
});

function entrarApp(user) {
  $loginScreen.classList.add('hidden');
  $app.style.display = 'flex';
  document.getElementById('nueva-fab')?.classList.add('visible');
  const av = document.getElementById('user-avatar');
  if (av) {
    if (user.photoURL) {
      av.innerHTML = `<img src="${user.photoURL}" alt="">`;
    } else if (user.email) {
      av.textContent = user.email[0].toUpperCase();
    }
  }
  loadCache();
  renderAll();
  initUI();
  updateTopbarDate();
  setInterval(updateTopbarDate, 60000);
  connectFirestore();
}

// ─── CACHE LOCAL ──────────────────────────────────────────────────────────────
function loadCache() {
  try { const r = localStorage.getItem(LS_ORDERS);       if (r) orders            = JSON.parse(r); } catch(e) { orders = []; }
  try { const r = localStorage.getItem(LS_STOCK);        if (r) stock             = JSON.parse(r); } catch(e) { stock  = {}; }
  try { const r = localStorage.getItem(LS_ZONES);        if (r) zones             = JSON.parse(r); } catch(e) { zones  = [...FLEX_ZONES]; }
  try { const r = localStorage.getItem(LS_FLEX_PERIODS); if (r) flexPeriods       = JSON.parse(r); } catch(e) { flexPeriods = []; }
  try { const r = localStorage.getItem(LS_FLEX_MANUAL);  if (r) flexManualRecords = JSON.parse(r); } catch(e) { flexManualRecords = []; }
}
function saveOrders()        { try { localStorage.setItem(LS_ORDERS,       JSON.stringify(orders));            } catch(e) {} }
function saveStock()         { try { localStorage.setItem(LS_STOCK,        JSON.stringify(stock));             } catch(e) {} }
function saveZones()         { try { localStorage.setItem(LS_ZONES,        JSON.stringify(zones));             } catch(e) {} }
function saveFlexPeriods()   { try { localStorage.setItem(LS_FLEX_PERIODS, JSON.stringify(flexPeriods));       } catch(e) {} }
function saveFlexManual()    { try { localStorage.setItem(LS_FLEX_MANUAL,  JSON.stringify(flexManualRecords)); } catch(e) {} }

// ─── FIRESTORE ────────────────────────────────────────────────────────────────
function connectFirestore() {
  if (fsConectado) return;
  fsConectado = true;

  db.collection('orders').orderBy('createdAt','desc').onSnapshot(snap => {
    orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    saveOrders(); renderPedidos(); renderCorte(); checkAutoArchiveEnano();
  }, e => console.warn('orders:', e));

  db.collection('meta').doc('stock').onSnapshot(snap => {
    if (snap.exists) {
      stock = snap.data(); saveStock();
      initNewProductStock();
      invalidateProdSort();
      renderStock();
    }
  }, e => console.warn('stock:', e));

  db.collection('meta').doc('flexZones').onSnapshot(snap => {
    if (snap.exists) { zones = snap.data().zones; saveZones(); renderConfig(); }
  }, e => console.warn('zones:', e));

  db.collection('meta').doc('flexPeriods').onSnapshot(snap => {
    if (snap.exists && snap.data().periods) {
      flexPeriods = snap.data().periods; saveFlexPeriods(); renderCorte();
    }
  }, e => console.warn('flexPeriods:', e));

  db.collection('meta').doc('flexRecords').onSnapshot(snap => {
    if (snap.exists && snap.data().records) {
      flexManualRecords = snap.data().records; saveFlexManual(); renderCorte();
    }
  }, e => console.warn('flexRecords:', e));
}

function initNewProductStock() {
  if (stockInitialized) return;
  stockInitialized = true;
  let changed = false;
  // Migrar claves viejas de Banderas → nuevo esquema
  const migOld = { 'Banderas 60x90_U': 'Banderas_60x90', 'Banderas 90x150_U': 'Banderas_90x150' };
  Object.entries(migOld).forEach(([oldK, newK]) => {
    if (stock[oldK] !== undefined && stock[newK] === undefined) {
      stock[newK] = stock[oldK]; delete stock[oldK]; changed = true;
    }
  });
  Object.entries(STOCK_DEFAULTS).forEach(([k, v]) => {
    if (stock[k] === undefined) { stock[k] = v; changed = true; }
  });
  if (!changed) return;
  saveStock();
  // set() reemplaza el doc completo y elimina las claves viejas en Firestore
  db.collection('meta').doc('stock').set(stock).catch(() => {});
}

// ─── DIÁLOGO CUSTOM (reemplaza confirm nativo) ───────────────────────────────
function showConfirm(msg, opts = {}) {
  return new Promise(resolve => {
    const {
      sub          = '',
      confirmText  = 'Confirmar',
      cancelText   = 'Cancelar',
      confirmClass = 'btn-primary',
      icon         = '⚠️',
    } = opts;
    const bg = document.createElement('div');
    bg.className = 'custom-dialog-bg';
    bg.innerHTML = `
      <div class="custom-dialog">
        <div class="custom-dialog-icon">${icon}</div>
        <div class="custom-dialog-msg">${msg}</div>
        ${sub ? `<div class="custom-dialog-sub">${sub}</div>` : ''}
        <div class="custom-dialog-btns">
          <button class="btn ${confirmClass} cd-yes">${confirmText}</button>
          <button class="btn btn-ghost cd-no">${cancelText}</button>
        </div>
      </div>`;
    document.body.appendChild(bg);
    bg.querySelector('.cd-yes').onclick = () => { bg.remove(); resolve(true); };
    bg.querySelector('.cd-no').onclick  = () => { bg.remove(); resolve(false); };
    bg.addEventListener('click', e => { if (e.target === bg) { bg.remove(); resolve(false); } });
  });
}

// ─── DIÁLOGO INPUT CUSTOM (reemplaza prompt nativo) ──────────────────────────
function showInputDialog(label, defaultVal = 0) {
  return new Promise(resolve => {
    const bg = document.createElement('div');
    bg.className = 'custom-dialog-bg';
    bg.innerHTML = `<div class="custom-dialog">
      <div class="custom-dialog-msg">${label}</div>
      <div style="padding:12px 0 4px">
        <input class="form-input" id="cd-num-input" type="number" value="${defaultVal}" min="0" max="999" inputmode="numeric"
          style="text-align:center;font-size:28px;font-weight:700;padding:10px 4px">
      </div>
      <div class="custom-dialog-btns" style="margin-top:6px">
        <button class="btn btn-primary cd-yes">Confirmar</button>
        <button class="btn btn-ghost cd-no">Cancelar</button>
      </div>
    </div>`;
    document.body.appendChild(bg);
    const inp = bg.querySelector('#cd-num-input');
    requestAnimationFrame(() => { inp.focus(); inp.select(); });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { bg.remove(); resolve(inp.value); }
      if (e.key === 'Escape') { bg.remove(); resolve(null); }
    });
    bg.querySelector('.cd-yes').onclick = () => { bg.remove(); resolve(inp.value); };
    bg.querySelector('.cd-no').onclick  = () => { bg.remove(); resolve(null); };
    bg.addEventListener('click', e => { if (e.target === bg) { bg.remove(); resolve(null); } });
  });
}

// ─── PRODUCTOS ORDENADOS POR STOCK — caché 24h ───────────────────────────────
function getSortedProductos() {
  const now = Date.now();
  // Si hay caché vigente en localStorage, usarlo
  try {
    const c = JSON.parse(localStorage.getItem(LS_SORTED_PRODS) || 'null');
    if (c && now - c.ts < H24) return c.prods;
  } catch(e) {}
  // Calcular: no-fijos ordenados por stock total, fijos al final
  const fixed = Object.keys(PRODUCTOS_FIJO);
  const cats = PRODUCTOS.filter(p => !fixed.includes(p));
  cats.sort((a, b) => {
    const sA = TALLES.reduce((s, t) => s + (stock[`${a}_${t}`] || 0), 0);
    const sB = TALLES.reduce((s, t) => s + (stock[`${b}_${t}`] || 0), 0);
    return sB - sA;
  });
  const sorted = [...cats, ...fixed];
  _prodSortTs = now;
  try { localStorage.setItem(LS_SORTED_PRODS, JSON.stringify({ prods: sorted, ts: now })); } catch(e) {}
  return sorted;
}
function invalidateProdSort() {
  _prodSortTs = 0;
  try { localStorage.removeItem(LS_SORTED_PRODS); } catch(e) {}
}

// ─── FECHA HÁBIL FLEX (Mon-Thu = hoy, Vie/Sab/Dom = lunes) ───────────────────
function diaHabilFlex() {
  const d = new Date();
  const dow = d.getDay(); // 0=Dom, 5=Vie, 6=Sáb
  if (dow === 5) d.setDate(d.getDate() + 3); // Vie → Lun
  else if (dow === 6) d.setDate(d.getDate() + 2); // Sáb → Lun
  else if (dow === 0) d.setDate(d.getDate() + 1); // Dom → Lun
  return d.toLocaleDateString('es-AR');
}

// ─── SYNC FLEX RECORDS → FIRESTORE ───────────────────────────────────────────
function syncFlexRecords() {
  saveFlexManual();
  db.collection('meta').doc('flexRecords').set({ records: flexManualRecords }).catch(() => {});
}

// ─── AUTO-ARCHIVADO ENANO ─────────────────────────────────────────────────────
function checkAutoArchiveEnano() {
  const now = Date.now();
  const vencidos = orders.filter(o =>
    o.status === 'camino' && o.cuenta === 'enano' &&
    ms(o.despachadoAt) > 0 && now - ms(o.despachadoAt) >= H24
  );
  if (!vencidos.length) return;
  vencidos.forEach(async o => {
    const f = new Date().toLocaleDateString('es-AR');
    mutateOrder(o.id, { status:'entregado', fechaEntrega:f, deliveredAt:Date.now() });
    try { await db.collection('orders').doc(o.id).update({ status:'entregado', deliveredAt:TS(), fechaEntrega:f }); } catch(e) {}
  });
  renderPedidos();
}
setInterval(checkAutoArchiveEnano, 60000);

function ms(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts._seconds) return ts._seconds * 1000;
  if (typeof ts === 'number') return ts;
  return 0;
}

// ─── UI INIT ──────────────────────────────────────────────────────────────────
const DIAS_SEMANA  = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];

function updateTopbarDate() {
  const el = document.getElementById('topbar-date');
  if (!el) return;
  const n = new Date();
  el.textContent = `${DIAS_SEMANA[n.getDay()]} ${n.getDate()} ${MESES[n.getMonth()]}`;
}

function updateDispatchBar() {
  // La info de despacho vive en los botones mkDispBtn — la barra de chips está oculta
  const bar = document.getElementById('dispatch-bar');
  if (bar) bar.classList.remove('show');
}

function setupStockScrollFab() {
  const view = VIEWS.stock;
  const fab  = document.getElementById('stock-fab');
  if (!view || !fab) return;
  view.addEventListener('scroll', () => {
    fab.classList.toggle('compact', view.scrollTop > 40);
  }, { passive: true });
}

let uiOk = false;
function initUI() {
  if (uiOk) return; uiOk = true;
  setupNav();
  setupSwipe();
  setupSheetDrag();
  setupOffline();
  setupAlerts();
  setupLocalidadSearch();
  setupProvinciaSearch();
  setupFormListeners();
  setupDeliverySheet();
  setupZoneSheets();
  setupAvatarPopup();
  setupFabMenu();
  setupStockScrollFab();
  setupAddFlexSheet();
  setupEditFlexSheet();
  setupPedidosTabSwipe();
  setupCorteTabSwipe();
  requestNotificationPermission();
  navigateTo('pedidos');
  setTimeout(checkAutoArchiveEnano, 1000);
}

function renderAll() {
  renderPedidos(); renderCorte(); renderStock(); renderConfig();
}

// ─── NAVEGACIÓN ───────────────────────────────────────────────────────────────
const TABS = ['pedidos','corte','stock'];

function setupNav() {
  document.querySelectorAll('[data-nav]').forEach(btn =>
    btn.addEventListener('click', () => {
      const t = btn.dataset.nav;
      if (t === 'nueva') { openNuevaSheet(); return; }
      navigateTo(t);
    })
  );
  history.replaceState({ view:'pedidos' }, '');
  window.addEventListener('popstate', () => {
    const i = TABS.indexOf(curView);
    navInternal(i > 0 ? TABS[i-1] : 'pedidos');
  });
}

function navInternal(name) {
  const prevIdx = TABS.indexOf(curView);
  const nextIdx = TABS.indexOf(name);
  curView = name;
  Object.values(VIEWS).forEach(v => v.classList.remove('active','slide-right','slide-left'));
  document.querySelectorAll('[data-nav]').forEach(b => b.classList.remove('active'));
  const nv = VIEWS[name];
  if (nv) {
    nv.classList.add('active');
    if (prevIdx >= 0 && nextIdx >= 0 && prevIdx !== nextIdx) {
      const cls = nextIdx > prevIdx ? 'slide-right' : 'slide-left';
      nv.classList.add(cls);
      nv.addEventListener('animationend', () => nv.classList.remove(cls), { once:true });
    }
  }
  document.querySelector(`[data-nav="${name}"]`)?.classList.add('active');
  const T = { pedidos:'Full Sports', corte:'Corte', stock:'Stock', config:'Zonas FLEX' };
  const titleEl = document.getElementById('topbar-title');
  const titleText = T[name] || 'Full Sports';
  if (titleText === 'Full Sports') {
    titleEl.innerHTML = '<span style="font-weight:300;opacity:0.85">Full</span> <span style="font-weight:800">Sports</span>';
  } else {
    titleEl.textContent = titleText;
  }
  if ($stockFab) $stockFab.classList.toggle('visible', name === 'stock');
  document.getElementById('pedidos-tabbar')?.classList.toggle('show', name === 'pedidos');
  document.getElementById('corte-tabbar')?.classList.toggle('show', name === 'corte');
}
function navigateTo(name) { navInternal(name); history.pushState({ view:name }, ''); }

function setupSwipe() {
  let x0=0, y0=0;
  const mc = document.getElementById('main-content');
  mc.addEventListener('touchstart', e => { x0=e.touches[0].clientX; y0=e.touches[0].clientY; }, { passive:true });
  mc.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    // 200px para secciones principales — gestos muy pronunciados y casi horizontales
    if (Math.abs(dx) < 200 || Math.abs(dy) > Math.abs(dx) * 0.22) return;
    const i = TABS.indexOf(curView);
    if (dx < 0 && i < TABS.length-1) navigateTo(TABS[i+1]);
    if (dx > 0 && i > 0) navigateTo(TABS[i-1]);
  }, { passive:true });
}

function setupSheetDrag() {
  document.querySelectorAll('.sheet').forEach(sh => {
    let startY = 0, startScroll = 0, isDragging = false;
    sh.addEventListener('touchstart', e => {
      const body = sh.querySelector('.sheet-body');
      startY = e.touches[0].clientY;
      startScroll = body ? body.scrollTop : 0;
      isDragging = true;
    }, { passive:true });
    sh.addEventListener('touchend', e => {
      if (!isDragging) return; isDragging = false;
      const dy = e.changedTouches[0].clientY - startY;
      // Solo cierra si el body estaba al tope del scroll y el gesto es suficientemente largo
      if (dy > 130 && startScroll < 8) closeSheet(sh);
    }, { passive:true });
  });
}

function setupOffline() {
  const upd = () => {
    const online = navigator.onLine;
    $offline.className = 'status-pill ' + (online ? 'online' : 'offline');
    $offline.textContent = online ? 'En línea' : 'Sin conexión';
  };
  window.addEventListener('online',  () => { upd(); connectFirestore(); });
  window.addEventListener('offline', upd);
  upd();
}

// ─── AVATAR POPUP ─────────────────────────────────────────────────────────────
function setupAvatarPopup() {
  const av    = document.getElementById('user-avatar');
  const popup = document.getElementById('avatar-popup');
  if (!av || !popup) return;

  av.addEventListener('click', e => {
    e.stopPropagation();
    popup.classList.toggle('open');
  });

  document.addEventListener('click', e => {
    if (!popup.contains(e.target) && e.target !== av) {
      popup.classList.remove('open');
    }
  });

  document.getElementById('popup-config')?.addEventListener('click', () => {
    popup.classList.remove('open');
    navigateTo('config');
  });

  document.getElementById('popup-notif')?.addEventListener('click', async () => {
    popup.classList.remove('open');
    if (!('Notification' in window)) { toast('Notificaciones no disponibles'); return; }
    if (Notification.permission === 'denied') {
      toast('Notificaciones bloqueadas — activalas en configuración del sistema');
    } else if (Notification.permission === 'granted') {
      toast('✓ Notificaciones activas');
    } else {
      const p = await Notification.requestPermission().catch(() => 'default');
      toast(p === 'granted' ? '✓ Notificaciones activadas' : 'Notificaciones no activadas');
    }
  });

  document.getElementById('popup-auth')?.addEventListener('click', async () => {
    popup.classList.remove('open');
    if (!await showConfirm('¿Cerrar sesión?', { icon:'👋', confirmText:'Cerrar sesión', confirmClass:'btn-danger' })) return;
    auth.signOut().then(() => {
      $app.style.display = 'none';
      document.getElementById('nueva-fab')?.classList.remove('visible');
      $loginScreen.classList.remove('hidden');
      orders = []; stock = {}; zones = [...FLEX_ZONES];
      fsConectado = false;
    }).catch(() => toast('Error al cerrar sesión'));
  });
}

// ─── FAB RADIAL MENU ─────────────────────────────────────────────────────────
function setupFabMenu() {
  const fab  = document.getElementById('nueva-fab');
  const wrap = document.getElementById('fab-radial-wrap');
  if (!fab) return;

  let pressTimer     = null;
  let autoCloseTimer = null;
  let didLongPress   = false;

  const isOpen = () => fab.classList.contains('menu-open');

  function openRadial() {
    fab.classList.add('menu-open');
    clearTimeout(autoCloseTimer);
    autoCloseTimer = setTimeout(closeRadial, 5000);
    if (!wrap) return;
    const items = wrap.querySelectorAll('.fab-radial-item');
    items.forEach(i => { i.classList.remove('open'); i.classList.add('animating'); });
    requestAnimationFrame(() => items.forEach(i => i.classList.add('open')));
  }

  function closeRadial() {
    clearTimeout(autoCloseTimer);
    fab.classList.remove('menu-open');
    if (!wrap) return;
    const items = wrap.querySelectorAll('.fab-radial-item');
    items.forEach(i => { i.classList.add('animating'); i.classList.remove('open'); });
    setTimeout(() => items.forEach(i => i.classList.remove('animating')), 350);
  }

  fab.addEventListener('contextmenu', e => e.preventDefault());

  fab.addEventListener('touchstart', () => {
    didLongPress = false;
    pressTimer = setTimeout(() => {
      didLongPress = true;
      isOpen() ? closeRadial() : openRadial();
    }, 420);
  }, { passive: true });

  fab.addEventListener('touchmove', () => clearTimeout(pressTimer), { passive: true });

  // Non-passive para poder llamar preventDefault y evitar el click sintético del browser
  fab.addEventListener('touchend', e => {
    clearTimeout(pressTimer);
    if (didLongPress) { didLongPress = false; return; } // ya manejado en el timer
    e.preventDefault(); // bloquea el click sintético de 300ms
    if (isOpen()) closeRadial();
    openNuevaSheet();
  });

  // Solo desktop (sin eventos touch disponibles)
  fab.addEventListener('click', () => {
    if ('ontouchstart' in window) return;
    if (isOpen()) { closeRadial(); return; }
    openNuevaSheet();
  });

  // Cerrar al tocar fuera del FAB y del menú
  document.addEventListener('touchstart', e => {
    if (isOpen() && !fab.contains(e.target) && !(wrap && wrap.contains(e.target))) {
      closeRadial();
    }
  }, { passive: true });
}

window.fabRadialGo = name => {
  const fab  = document.getElementById('nueva-fab');
  const wrap = document.getElementById('fab-radial-wrap');
  fab?.classList.remove('menu-open');
  if (wrap) {
    const items = wrap.querySelectorAll('.fab-radial-item');
    items.forEach(i => { i.classList.add('animating'); i.classList.remove('open'); });
    setTimeout(() => items.forEach(i => i.classList.remove('animating')), 350);
  }
  navigateTo(name);
};

async function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default')
    await Notification.requestPermission().catch(() => {});
}

// ─── ALERTAS ──────────────────────────────────────────────────────────────────
function nextBusinessDay(d) {
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}
function dispTarget(tipo) {
  const now = new Date();
  const t = new Date(now);
  t.setHours(tipo === 'FLEX' ? 13 : 14, 0, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  nextBusinessDay(t);
  return t;
}
function fmtDiff(diff) {
  if (diff <= 0) return 'Ya!';
  const h=Math.floor(diff/3600000), m=Math.floor(diff/60000);
  return h>0 ? `${h}h ${String(m%60).padStart(2,'0')}m` : `${m}m`;
}
function setupAlerts() {
  alertTimers.forEach(clearTimeout); alertTimers=[];
  const now=new Date();
  [
    {h:12,m:30,t:'warning',msg:'⏰ 30 min para despachar FLEX',tipo:'FLEX'},
    {h:12,m:50,t:'urgent', msg:'🚨 10 min para despachar FLEX',tipo:'FLEX'},
    {h:13,m:30,t:'warning',msg:'⏰ 30 min para despachar PE',  tipo:'PE'},
    {h:13,m:50,t:'urgent', msg:'🚨 10 min para despachar PE',  tipo:'PE'},
  ].forEach(({h,m,t,msg,tipo}) => {
    const d=new Date(now); d.setHours(h,m,0,0);
    const diff=d-now; if (diff>0) alertTimers.push(setTimeout(()=>showAlert(t,msg,tipo),diff));
  });
  setInterval(updateCountdowns, 30000);
}
function showAlert(type, msg, tipo) {
  // Solo alertar si hay pedidos pendientes del tipo correspondiente
  const hasPending = orders.some(o =>
    (o.status==='pendiente'||o.status==='preparar') && (!tipo || o.tipoEnvio===tipo)
  );
  if (!hasPending) return;
  $alert.className=`alert-banner show ${type}`; $alert.textContent=msg;
  setTimeout(()=>$alert.classList.remove('show'),8000);
  if (typeof Notification !== 'undefined' && Notification.permission==='granted')
    new Notification('Full Sports',{body:msg});
}
function updateCountdowns() {
  document.querySelectorAll('[data-cd]').forEach(el => {
    const diff=dispTarget(el.dataset.cd)-new Date(), min=Math.floor(diff/60000);
    el.textContent=fmtDiff(diff);
    const urg=min<=15?'urgent':min<=60?'warn':'';
    el.className='countdown'+(urg?' '+urg:'');
    const btn=el.closest('.dispatch-btn');
    if (btn) { btn.classList.remove('warn','urgent'); if (urg) btn.classList.add(urg); }
  });
  updateDispatchBar();
}

// ─── PEDIDOS VIEW ─────────────────────────────────────────────────────────────
const SPRI = {preparar:0,pendiente:1,camino:2,entregado:3};

function renderPedidos(animDir='') {
  const v = VIEWS.pedidos; if (!v) return;

  const preparar  = orders.filter(o=>o.status==='preparar');
  const pendiente = orders.filter(o=>o.status==='pendiente');
  const camino    = orders.filter(o=>o.status==='camino');
  const entregados= orders.filter(o=>o.status==='entregado' && Date.now()-ms(o.deliveredAt)<H24);

  const nPrep=preparar.length, nDesp=pendiente.length+camino.length, nEntr=entregados.length;
  const nFlex=pendiente.filter(o=>o.tipoEnvio==='FLEX').length;

  const mkDispBtn = (tipo, icon, n) => {
    const diff = dispTarget(tipo) - new Date();
    const min  = Math.floor(diff / 60000);
    const urg  = min <= 15 ? 'urgent' : min <= 60 ? 'warn' : '';
    const cls  = tipo === 'FLEX' ? 'flex-btn' : 'pe-btn';
    return `<button class="dispatch-btn ${cls}${urg?' '+urg:''}" onclick="despacharTodos('${tipo}')">
      ${icon} Despachar ${tipo} (${n}) <span class="countdown${urg?' '+urg:''}" data-cd="${tipo}">${fmtDiff(diff)}</span>
    </button>`;
  };
  const nPE  =pendiente.filter(o=>o.tipoEnvio==='PE').length;

  let body='';
  if (pedidosTab==='preparar') {
    const sorted=[...preparar].sort((a,b)=>(a.tipoEnvio==='FLEX'?0:10)-(b.tipoEnvio==='FLEX'?0:10));
    const bar=`<div style="display:flex;flex-direction:column;gap:8px">
      <div class="home-bar">
        ${mkDispBtn('FLEX','🚚',nFlex)}
        ${mkDispBtn('PE',  '📦',nPE)}
      </div>
      <button class="btn-dep" id="btn-dep" onclick="toggleDep()" style="width:100%">🏪 Depósito</button>
    </div>
    <div id="dep-box" style="display:none" class="dep-box"></div>`;
    body = bar + (sorted.length
      ? `<div class="ped-body">${sorted.map(orderCard).join('')}</div>`
      : `<div class="empty-state empty-preparar"><div class="empty-check-circle">✓</div><p>¡Estás al día!</p></div>`);

  } else if (pedidosTab === 'despacho') {
    const nFlexPend=pendiente.filter(o=>o.tipoEnvio==='FLEX').length;
    const nPEPend  =pendiente.filter(o=>o.tipoEnvio==='PE').length;
    const sorted=[...pendiente,...camino].sort((a,b)=>{
      const sp=SPRI[a.status]-SPRI[b.status]; if(sp!==0) return sp;
      if(a.status==='camino'&&b.status==='camino') return parseLocalDate(a.fechaEstimada)-parseLocalDate(b.fechaEstimada);
      return 0;
    });
    const dispBar=`<div class="home-bar">
      ${mkDispBtn('FLEX','🚚',nFlexPend)}
      ${mkDispBtn('PE',  '📦',nPEPend)}
    </div>`;
    body = dispBar + (sorted.length
      ? `<div class="ped-body">${sorted.map(orderCard).join('')}</div>`
      : `<div class="empty-state"><span>📦</span><p>Sin pedidos en camino</p></div>`);

  } else {
    const sorted=[...entregados].sort((a,b)=>ms(b.deliveredAt)-ms(a.deliveredAt));
    body = sorted.length
      ? `<div class="ped-body">${sorted.map(orderCard).join('')}</div>`
      : `<div class="empty-state"><span>📭</span><p>Sin entregados en las últimas 24hs</p></div>`;
  }

  // Tabs → fuera del scroll en #pedidos-tabbar
  const pedTabbar = document.getElementById('pedidos-tabbar');
  if (pedTabbar) pedTabbar.innerHTML = `
    <div class="pedidos-tabs">
      <button class="pedidos-tab${pedidosTab==='preparar'?' active':''}" onclick="setTab('preparar')">
        Preparar${nPrep?`<span class="tab-badge">${nPrep}</span>`:''}
      </button>
      <button class="pedidos-tab${pedidosTab==='despacho'?' active':''}" onclick="setTab('despacho')">
        En camino${nDesp?`<span class="tab-badge">${nDesp}</span>`:''}
      </button>
      <button class="pedidos-tab${pedidosTab==='entregados'?' active':''}" onclick="setTab('entregados')">
        Entregados${nEntr?`<span class="tab-badge">${nEntr}</span>`:''}
      </button>
    </div>`;
  v.innerHTML = `<div class="ped-main-content${animDir?' '+animDir:''}">${body}</div>`;
  updateCountdowns();
}
window.setTab = t => {
  const tabs=['preparar','despacho','entregados'];
  const dir = tabs.indexOf(t) > tabs.indexOf(pedidosTab) ? 'slide-in-right' : 'slide-in-left';
  pedidosTab=t;
  renderPedidos(dir);
};

function parseLocalDate(s) {
  if (!s) return Infinity;
  const p=s.split('/'); if (p.length!==3) return Infinity;
  return new Date(p[2],p[1]-1,p[0]).getTime();
}

// Depósito — solo muestra pedidos en estado 'preparar' (pendientes de buscar en depósito)
function calcDep() {
  const g={};
  orders.filter(o=>o.status==='preparar').forEach(o=>(o.items||[]).forEach(item=>{
    const k=`${item.producto}||${item.talle}`; g[k]=(g[k]||0)+1;
  }));
  return Object.entries(g)
    .sort(([a],[b])=>{ const[aP,aT]=a.split('||'),[bP,bT]=b.split('||'); return aP!==bP?aP.localeCompare(bP):String(aT).localeCompare(String(bT)); })
    .map(([k,qty])=>{ const[prod,talle]=k.split('||'); return {prod,talle,qty,queda:Math.max(0,(stock[`${prod}_${talle}`]??0)-qty)}; });
}
window.toggleDep = () => {
  const box=document.getElementById('dep-box'), btn=document.getElementById('btn-dep'); if (!box) return;
  if (box.style.display!=='none') { box.style.display='none'; btn.textContent='🏪 Depósito'; return; }
  const lines=calcDep();
  const nP=orders.filter(o=>o.status==='preparar').length;
  box.innerHTML = !lines.length
    ? `<p class="hint-text">Sin pedidos para preparar</p>`
    : `<div class="dep-hdr">A buscar: ${lines.reduce((a,l)=>a+l.qty,0)} pares · ${nP} pedido${nP!==1?'s':''}</div>
       ${lines.map(l=>`<div class="dep-row"><span class="dep-n">${l.prod} ${displayTalle(l.talle)}</span><span class="dep-q">×${l.qty}</span><span class="dep-r ${l.queda===0?'cero':l.queda<=2?'bajo':'ok'}">queda ${l.queda}</span></div>`).join('')}`;
  box.style.display='block'; btn.textContent='🏪 Ocultar';
};

function orderCard(o) {
  const cb=`<span class="badge badge-${o.cuenta}">${o.cuenta.toUpperCase()}</span>`;
  const eb=o.tipoEnvio==='FLEX'?`<span class="badge badge-flex">FLEX</span>`:`<span class="badge badge-pe">PE</span>`;
  const sc=!o.corteDone?'<span class="badge badge-sin-corte">Sin corte</span>':'';

  let cd='';
  if (['preparar','pendiente'].includes(o.status)) {
    const diff=dispTarget(o.tipoEnvio)-new Date(), min=Math.floor(diff/60000);
    cd=`<span class="countdown${min<=15?' urgent':min<=60?' warn':''}" data-cd="${o.tipoEnvio}">${fmtDiff(diff)}</span>`;
  }

  let monto='';
  if (o.tipoEnvio==='FLEX'&&o.importeVenta) {
    monto=o.cuenta==='capi'
      ?`<div class="order-monto">Acreditado <b>$${fmt(o.importeNeto)}</b></div>`
      :`<div class="order-monto">$${fmt(o.importeVenta)} − FLEX $${fmt(o.flexImporte)} = <b>$${fmt(o.importeNeto)}</b></div>`;
  } else {
    monto=`<div class="order-monto">Acreditado $${fmt(o.importeAcreditado)}</div>`;
  }

  const iibb=o.cuenta==='enano'&&o.provincia?`<div class="order-iibb">${o.provincia} — IIBB $${fmtDec(o.iibb)}</div>`:'';

  let fechaLine='';
  if (o.status==='camino'&&o.fechaEstimada) {
    fechaLine=`<div class="order-fecha">📅 Entrega est.: <b>${o.fechaEstimada}</b> <button class="btn-link" onclick="openDelivery('${o.id}','edit')">✏️</button></div>`;
    if (o.cuenta==='enano'&&ms(o.despachadoAt)>0) {
      const elapsed=Math.min(1,(Date.now()-ms(o.despachadoAt))/H24);
      fechaLine+=`<div class="transit-bar"><div class="transit-bar-fill" style="width:${Math.round(elapsed*100)}%"></div></div>`;
    }
  }
  // Fecha de entrega real
  if (o.status==='entregado'&&o.fechaEntrega) {
    fechaLine=`<div class="order-fecha">✅ Entregado el <b>${o.fechaEntrega}</b></div>`;
  }

  // Acciones — eliminar disponible en todos los estados
  let act='';
  if (o.status==='preparar') {
    act=`<div class="card-act">
      <button class="btn btn-green btn-sm" onclick="acPreparado('${o.id}',this)">✓ Preparado</button>
      <button class="btn btn-ghost btn-sm" onclick="acEditar('${o.id}')">✏️ Editar</button>
      <button class="btn btn-danger btn-sm" onclick="acEliminar('${o.id}')">🗑</button>
    </div>`;
  } else if (o.status==='pendiente') {
    act=`<div class="card-act">
      <button class="btn btn-primary btn-sm" onclick="acDespachado('${o.id}',this)">🚚 Despachar</button>
      <button class="btn btn-ghost btn-sm" onclick="acEditar('${o.id}')">✏️</button>
      <button class="btn btn-danger btn-sm" onclick="acEliminar('${o.id}')">🗑</button>
    </div>`;
  } else if (o.status==='camino') {
    act=`<div class="card-act">
      <button class="btn btn-green btn-sm" onclick="acEntregado('${o.id}',this)">✓ Entregado</button>
      <button class="btn btn-ghost btn-sm" onclick="acEditar('${o.id}')">✏️</button>
      <button class="btn btn-danger btn-sm" onclick="acEliminar('${o.id}')">🗑</button>
    </div>`;
  } else if (o.status==='entregado') {
    act=`<div class="card-act" style="margin-top:2px">
      <div class="card-ok" style="flex:1">✓ Entregado</div>
      <button class="btn btn-danger btn-sm" onclick="acEliminar('${o.id}')">🗑</button>
    </div>`;
  }

  return `<div class="order-card${['preparar','pendiente'].includes(o.status)&&o.tipoEnvio==='FLEX'?' flex-active':''}" data-oid="${o.id}">
    <div class="order-header">${cb}${eb}${sc}${cd}</div>
    <div class="order-name">${o.nombreComprador}</div>
    <div class="order-items">${fmtItemsShort(o.items)}</div>
    ${fechaLine}${iibb}${monto}${act}
  </div>`;
}

function sortIt(items) {
  return [...(items||[])].sort((a,b)=>{
    if (a.producto!==b.producto) return a.producto.localeCompare(b.producto);
    const na=parseInt(a.talle), nb=parseInt(b.talle);
    if (!isNaN(na)&&!isNaN(nb)) return na-nb;
    return String(a.talle).localeCompare(String(b.talle));
  });
}
function fmtItemsShort(items) {
  if (!items||!items.length) return '';
  const s=sortIt(items);
  if (s.length===1) return `${s[0].producto} ${displayTalle(s[0].talle)}`;
  const g={}; s.forEach(i=>{const k=`${i.producto} ${displayTalle(i.talle)}`;g[k]=(g[k]||0)+1;});
  return `${s.length} pares — ${Object.entries(g).map(([k,q])=>q>1?`${k}×${q}`:k).join(' · ')}`;
}
function displayTalle(t) {
  if (t === 'U') return 'Único';
  const n = parseInt(t, 10);
  // Solo añade "T" si el valor entero representa exactamente el string (evita "T60x90")
  return (!isNaN(n) && String(n) === String(t)) ? `T${t}` : String(t);
}

// ─── ACCIONES ─────────────────────────────────────────────────────────────────
window.acPreparado = async (id, btn) => {
  const o=orders.find(o=>o.id===id); if (!o) return;
  haptic([28]);
  animCard(id, 'card-state-ok', btn, async () => {
    pushUndo({type:'patch', id, prev:{status:o.status}, next:{status:'pendiente'}});
    mutateOrder(id,{status:'pendiente'});
    renderPedidos(); renderCorte();
    try {
      await db.collection('orders').doc(id).update({status:'pendiente'});
      if (o.items) {
        const ns={...stock};
        o.items.forEach(i=>{const k=`${i.producto}_${i.talle}`;ns[k]=Math.max(0,(ns[k]||0)-1);});
        stock=ns; saveStock();
        await db.collection('meta').doc('stock').set(ns);
      }
    } catch(e){toast('Sin red — se sincronizará');}
  });
};

window.acDespachado = async (id, btn) => {
  const o=orders.find(o=>o.id===id); if (!o) return;
  if (o.cuenta==='capi') {
    haptic([18, 55, 25]);
    if (btn) btn.classList.add('btn-pop');
    openDelivery(id,'dispatch'); return;
  }
  haptic([18, 55, 25]);
  const fecha = o.tipoEnvio==='FLEX' ? diaHabilFlex() : proximoDia();
  const now = Date.now();
  animCard(id, 'card-state-dispatch', btn, async () => {
    pushUndo({type:'patch', id, prev:{status:o.status,fechaEstimada:o.fechaEstimada||null,despachadoAt:o.despachadoAt||null}, next:{status:'camino',fechaEstimada:fecha,despachadoAt:now}});
    mutateOrder(id,{status:'camino',fechaEstimada:fecha,despachadoAt:now});
    if (o.tipoEnvio==='FLEX' && o.flexImporte) _addFlexRecord(o, now);
    renderPedidos();
    try { await db.collection('orders').doc(id).update({status:'camino',despachadoAt:TS(),fechaEstimada:fecha}); }
    catch(e){toast('Sin red');}
  });
};

window.despacharTodos = async tipo => {
  const pend=orders.filter(o=>o.status==='pendiente'&&o.tipoEnvio===tipo);
  if (!pend.length) { toast(`Sin pedidos ${tipo} listos para despachar`); return; }
  const ok = await showConfirm(`¿Despachar ${pend.length} pedido${pend.length>1?'s':''} ${tipo}?`, {
    icon: tipo==='FLEX'?'🚚':'📦', confirmText:'Despachar', confirmClass:'btn-primary',
    sub: pend.map(o=>o.nombreComprador).join(', '),
  });
  if (!ok) return;
  const now  = Date.now();
  const fecha= tipo==='FLEX' ? diaHabilFlex() : proximoDia();
  pushUndo({
    type:'multi',
    prevs: pend.map(o=>({id:o.id, data:{status:'pendiente', fechaEstimada:o.fechaEstimada||null, despachadoAt:o.despachadoAt||null}})),
    nexts: pend.map(o=>({id:o.id, data:{status:'camino', fechaEstimada:fecha, despachadoAt:now}})),
  });
  pend.forEach(o=>{
    mutateOrder(o.id,{status:'camino',fechaEstimada:fecha,despachadoAt:now});
    if (tipo==='FLEX' && o.flexImporte) _addFlexRecord(o, now);
  });
  pedidosTab='despacho'; renderPedidos(); renderCorte();
  try {
    for(const o of pend)
      await db.collection('orders').doc(o.id).update({status:'camino',despachadoAt:TS(),fechaEstimada:fecha});
    toast(`${pend.length} pedidos ${tipo} despachados ✓`);
  } catch(e){toast('Sin red');}
};

window.acEntregado = async (id, btn) => {
  const o=orders.find(o=>o.id===id);
  haptic([15, 35, 70]);
  const f=new Date().toLocaleDateString('es-AR');
  animCard(id, 'card-state-entregado', btn, async () => {
    pushUndo({type:'patch', id, prev:{status:o?.status||'camino',fechaEntrega:o?.fechaEntrega||null,deliveredAt:o?.deliveredAt||null}, next:{status:'entregado',fechaEntrega:f,deliveredAt:Date.now()}});
    mutateOrder(id,{status:'entregado',fechaEntrega:f,deliveredAt:Date.now()});
    renderPedidos(); renderCorte();
    try { await db.collection('orders').doc(id).update({status:'entregado',deliveredAt:TS(),fechaEntrega:f}); }
    catch(e){toast('Sin red');}
  });
};

window.acEliminar = async id => {
  const order = orders.find(o=>o.id===id);
  const ok = await showConfirm('¿Eliminar este pedido?', {
    icon:'🗑', confirmText:'Eliminar', confirmClass:'btn-danger',
    sub: order ? `${order.nombreComprador} — ${order.tipoEnvio}` : '',
  });
  if (!ok) return;

  // Si es FLEX despachado, preguntar si mantener el registro
  if (order?.tipoEnvio==='FLEX' && ms(order.despachadoAt)) {
    const keepFlex = await showConfirm('¿Conservar el registro FLEX en la quincena?', {
      icon:'📦',
      sub:`${order.nombreComprador} · $${fmt(order.flexImporte||0)}`,
      confirmText:'Conservar', cancelText:'Borrar también', confirmClass:'btn-primary',
    });
    if (keepFlex) {
      // Guardar como registro manual si no existe ya
      if (!flexManualRecords.some(r=>r.orderId===id)) {
        const period=getCurrentPeriod();
        flexManualRecords.push({
          id:`${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
          cuenta: order.cuenta,
          nombre: order.nombreComprador,
          localidad: order.flexLocalidad||'',
          zona: order.flexZona||'',
          flexImporte: order.flexImporte||0,
          fechaMs: ms(order.despachadoAt)||Date.now(),
          orderId: id,
        });
        syncFlexRecords();
      }
    } else {
      flexManualRecords=flexManualRecords.filter(r=>r.orderId!==id);
      syncFlexRecords();
    }
  }

  if (order) pushUndo({type:'delete', id, order:JSON.parse(JSON.stringify(order))});
  orders=orders.filter(o=>o.id!==id); saveOrders(); renderPedidos(); renderCorte();
  try { await db.collection('orders').doc(id).delete(); } catch(e){toast('Sin red');}
};

window.acEditar = id => {
  const o=orders.find(o=>o.id===id);
  if (o) openNuevaSheet(o);
};

function mutateOrder(id,patch) {
  const i=orders.findIndex(o=>o.id===id);
  if (i>=0) { orders[i]={...orders[i],...patch}; saveOrders(); }
}

// ─── UNDO / REDO ──────────────────────────────────────────────────────────────
function pushUndo(entry) {
  UNDO_STACK.push(entry);
  REDO_STACK.length = 0;
  if (UNDO_STACK.length > 20) UNDO_STACK.shift();
  updateUndoUI();
}
function updateUndoUI() {
  const u = document.getElementById('btn-undo');
  const r = document.getElementById('btn-redo');
  if (u) u.disabled = !UNDO_STACK.length;
  if (r) r.disabled = !REDO_STACK.length;
}
window.doUndo = async () => {
  if (!UNDO_STACK.length) { toast('Sin acciones para deshacer'); return; }
  const entry = UNDO_STACK.pop();
  REDO_STACK.push(entry);
  await applyHistoryEntry(entry, 'undo');
  updateUndoUI();
  toast('Deshecho ✓');
};
window.doRedo = async () => {
  if (!REDO_STACK.length) { toast('Sin acciones para rehacer'); return; }
  const entry = REDO_STACK.pop();
  UNDO_STACK.push(entry);
  await applyHistoryEntry(entry, 'redo');
  updateUndoUI();
  toast('Rehecho ✓');
};
async function applyHistoryEntry(entry, dir) {
  if (entry.type === 'patch') {
    const patch = dir === 'undo' ? entry.prev : entry.next;
    mutateOrder(entry.id, patch);
    renderPedidos(); renderCorte();
    try { await db.collection('orders').doc(entry.id).update(patch); } catch(e) {}
  } else if (entry.type === 'multi') {
    const list = dir === 'undo' ? entry.prevs : entry.nexts;
    list.forEach(({id, data}) => mutateOrder(id, data));
    renderPedidos(); renderCorte();
    try { for (const {id, data} of list) await db.collection('orders').doc(id).update(data); } catch(e) {}
  } else if (entry.type === 'delete') {
    if (dir === 'undo') {
      orders.unshift({id: entry.id, ...entry.order});
      saveOrders(); renderPedidos(); renderCorte();
      try { await db.collection('orders').doc(entry.id).set(entry.order); } catch(e) {}
    } else {
      orders = orders.filter(o => o.id !== entry.id);
      saveOrders(); renderPedidos(); renderCorte();
      try { await db.collection('orders').doc(entry.id).delete(); } catch(e) {}
    }
  }
}

function proximoDia() {
  const d=new Date(); d.setDate(d.getDate()+1);
  return d.toLocaleDateString('es-AR');
}

// ─── FLEX RECORD AUTO-ADD AL DESPACHAR ───────────────────────────────────────
function _addFlexRecord(order, fechaMs) {
  if (flexManualRecords.some(r=>r.orderId===order.id)) return;
  flexManualRecords.push({
    id:`${fechaMs}-${Math.random().toString(36).slice(2,7)}`,
    cuenta: order.cuenta,
    nombre: order.nombreComprador,
    localidad: order.flexLocalidad||'',
    zona: order.flexZona||'',
    flexImporte: order.flexImporte||0,
    fechaMs,
    orderId: order.id,
  });
  syncFlexRecords();
}

// ─── DELIVERY SHEET ───────────────────────────────────────────────────────────
function setupDeliverySheet() {
  document.getElementById('btn-save-delivery')?.addEventListener('click', async () => {
    const val=document.getElementById('delivery-date-input').value;
    if (!val||!deliveryId) { closeSheet($shDeliv); return; }
    const fechaStr=inputToDate(val);
    if (deliveryAction==='dispatch') {
      const now=Date.now();
      mutateOrder(deliveryId,{status:'camino',fechaEstimada:fechaStr,despachadoAt:now});
      const o=orders.find(o=>o.id===deliveryId);
      if (o?.tipoEnvio==='FLEX' && o.flexImporte) _addFlexRecord(o, now);
      renderPedidos(); renderCorte();
      try { await db.collection('orders').doc(deliveryId).update({status:'camino',despachadoAt:TS(),fechaEstimada:fechaStr}); toast('Despachado ✓'); }
      catch(e){toast('Sin red');}
    } else {
      mutateOrder(deliveryId,{fechaEstimada:fechaStr}); renderPedidos();
      try { await db.collection('orders').doc(deliveryId).update({fechaEstimada:fechaStr}); } catch(e){}
    }
    closeSheet($shDeliv);
  });
}

window.openDelivery = (id, action='edit') => {
  deliveryId=id; deliveryAction=action;
  const o=orders.find(o=>o.id===id);
  const titleEl=document.getElementById('delivery-sheet-title');
  if (titleEl) titleEl.textContent=action==='dispatch'?'Fecha de entrega estimada (CAPI)':'Editar fecha estimada';
  const inp=document.getElementById('delivery-date-input');
  if (inp) inp.value=action==='edit'?(dateToInput(o?.fechaEstimada)||''):tomorrowInput();
  openSheet($shDeliv);
};

function dateToInput(s) {
  if (!s) return '';
  const p=s.split('/'); if (p.length!==3) return '';
  return `${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
}
function inputToDate(s) {
  if (!s) return '';
  const [y,m,d]=s.split('-');
  return `${d}/${m}/${y}`;
}
function tomorrowInput() {
  const d=new Date(); d.setDate(d.getDate()+1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ─── FORMULARIO NUEVA VENTA ───────────────────────────────────────────────────
function openNuevaSheet(data=null) {
  // Reset estado del formulario
  editingId = data?.id || null;
  formItems = data?.items ? [...data.items] : [];
  formEnvio = null;
  curProducto = null;
  stockAll = false;

  $shNueva.querySelector('.sheet-title').textContent = editingId ? 'Editar pedido' : 'Nueva venta';
  setCuenta(data?.cuenta || 'capi');
  setEnvio(data?.tipoEnvio || 'FLEX');

  // Valores de inputs
  V('f-nombre').value         = data?.nombreComprador || '';
  V('f-provincia').value      = data?.provincia || '';
  V('f-iibb').value           = data?.iibb ? fmtDec(data.iibb) : '';
  V('f-importe-pe').value     = data?.importeAcreditado || '';
  V('f-importe-flex').value   = data?.importeVenta || '';
  V('btn-stock-override').textContent = '✏️ Manual';

  // Zona seleccionada (si editando FLEX)
  if (data?.tipoEnvio==='FLEX' && data.flexLocalidad) {
    formEnvio = { localidad:data.flexLocalidad, zona:data.flexZona, importe:data.flexImporte };
    showZoneSelected();
  } else {
    clearZone();
  }

  // Selector de productos
  renderProdBtns();
  V('talle-wrap').style.display = 'none';

  // Multi panel
  V('multi-wrap').style.display = 'none';
  V('multi-talle-wrap').style.display = 'none';

  // Items lista
  renderFormItems();

  // Mostrar botones de agregar si ya hay items (edición)
  const hasItems = formItems.length > 0;
  V('btn-add-otro').style.display = hasItems ? 'flex' : 'none';
  V('btn-multi').style.display    = hasItems ? 'flex' : 'none';

  openSheet($shNueva);
  // Scroll al inicio de forma suave
  requestAnimationFrame(() => {
    const body = $shNueva.querySelector('.sheet-body');
    if (body) body.scrollTop = 0;
  });
}

function setCuenta(c) {
  curCuenta=c;
  document.querySelectorAll('[data-cuenta]').forEach(b=>b.classList.toggle('active',b.dataset.cuenta===c));
  V('enano-fields').style.display=c==='enano'?'flex':'none';
}
function setEnvio(t) {
  curEnvio=t;
  document.querySelectorAll('[data-envio]').forEach(b=>b.classList.toggle('active',b.dataset.envio===t));
  V('flex-fields').style.display=t==='FLEX'?'flex':'none';
  V('pe-fields').style.display=t==='PE'?'flex':'none';
}

function setupFormListeners() {
  document.querySelectorAll('[data-cuenta]').forEach(b=>b.addEventListener('click',()=>setCuenta(b.dataset.cuenta)));
  document.querySelectorAll('[data-envio]').forEach(b=>b.addEventListener('click',()=>setEnvio(b.dataset.envio)));
  V('f-importe-flex').addEventListener('input',updateNeto);
  // Title case en tiempo real para campos de nombre
  function liveTitleCase(e) {
    const el = e.target, pos = el.selectionStart, val = el.value;
    const tc = titleCase(val);
    if (tc !== val) { el.value = tc; el.setSelectionRange(pos, pos); }
  }
  V('f-nombre')?.addEventListener('input', liveTitleCase);
  V('f-nombre')?.addEventListener('blur', e => { e.target.value = titleCase(e.target.value); });

  V('btn-stock-override').addEventListener('click',()=>{
    stockAll=!stockAll;
    V('btn-stock-override').textContent=stockAll?'✏️ Todo':'✏️ Manual';
    curProducto=null;
    renderProdBtns();
    V('talle-wrap').style.display='none';
  });

  V('btn-add-otro').addEventListener('click',()=>{
    curProducto=null;
    renderProdBtns();
    V('talle-wrap').style.display='none';
    V('btn-add-otro').style.display='none';
    V('btn-multi').style.display='none';
    V('multi-wrap').style.display='none';
    requestAnimationFrame(()=>V('item-selector-wrap')?.scrollIntoView({behavior:'smooth',block:'start'}));
  });

  V('btn-multi').addEventListener('click',()=>{
    multiProd=null;
    renderMultiProd();
    V('multi-talle-wrap').style.display='none';
    V('multi-cant-wrap').style.display='none';
    V('multi-wrap').style.display='block';
    requestAnimationFrame(()=>V('multi-wrap')?.scrollIntoView({behavior:'smooth',block:'start'}));
  });

  V('btn-guardar-venta').addEventListener('click', guardarVenta);
}

// ─── BÚSQUEDA PROVINCIA ───────────────────────────────────────────────────────
function setupProvinciaSearch() {
  const inp = V('f-provincia'), res = V('provincia-results');
  if (!inp || !res) return;

  function positionDropdown() {
    const r = inp.getBoundingClientRect();
    res.style.top   = `${r.bottom + 4}px`;
    res.style.left  = `${r.left}px`;
    res.style.width = `${r.width}px`;
  }
  function buildResults() {
    const q = normalizeStr(inp.value.trim());
    if (!q) { res.classList.remove('show'); return; }
    const hits = PROVINCIAS.filter(p =>
      normalizeStr(p).startsWith(q) || normalizeStr(p).includes(q)
    ).slice(0, 8);
    if (!hits.length) { res.classList.remove('show'); return; }
    res.innerHTML = hits.map(p => `<div class="search-result-item prov-item"><span class="sri-name">${p}</span></div>`).join('');
    positionDropdown(); res.classList.add('show');
    res.querySelectorAll('.prov-item').forEach((el, i) => {
      const pick = e => {
        e.preventDefault(); e.stopPropagation();
        inp.value = hits[i]; res.classList.remove('show');
      };
      el.addEventListener('mousedown', pick);
      el.addEventListener('touchstart', pick, { passive: false });
    });
  }
  inp.addEventListener('input', buildResults);
  inp.addEventListener('focus', buildResults);
  document.addEventListener('scroll', () => { if (res.classList.contains('show')) positionDropdown(); }, true);
  document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrap') && !res.contains(e.target)) res.classList.remove('show');
  });
}

// ─── BÚSQUEDA LOCALIDAD ───────────────────────────────────────────────────────
function setupLocalidadSearch() {
  const inp=V('f-localidad'), res=V('localidad-results');
  if (!inp||!res) return;

  function positionDropdown() {
    const r=inp.getBoundingClientRect();
    res.style.top=`${r.bottom+4}px`; res.style.left=`${r.left}px`; res.style.width=`${r.width}px`;
  }
  function buildResults() {
    const q=normalizeStr(inp.value.trim());
    if (!q) { res.classList.remove('show'); zoneHits=[]; return; }
    zoneHits=zones.filter(z=>normalizeStr(z.localidad).includes(q)).slice(0,8);
    if (!zoneHits.length) { res.classList.remove('show'); return; }
    res.innerHTML=zoneHits.map((z,i)=>`
      <div class="search-result-item" data-zi="${i}">
        <div><div class="sri-name">${z.localidad}</div><div class="search-result-zona">${z.zona}</div></div>
        <div class="sri-precio">$${fmt(z.importe)}</div>
      </div>`).join('');
    positionDropdown(); res.classList.add('show');
    res.querySelectorAll('.search-result-item').forEach(el=>{
      const pick=e=>{
        e.preventDefault(); e.stopPropagation();
        const z=zoneHits[parseInt(el.dataset.zi)]; if (!z) return;
        formEnvio={localidad:z.localidad,zona:z.zona,importe:z.importe};
        inp.value=''; res.classList.remove('show');
        showZoneSelected(); updateNeto();
      };
      el.addEventListener('mousedown',pick);
      el.addEventListener('touchstart',pick,{passive:false});
    });
  }
  inp.addEventListener('input',buildResults);
  document.addEventListener('scroll',()=>{ if(res.classList.contains('show')) positionDropdown(); },true);
  document.addEventListener('click',e=>{ if(!e.target.closest('.search-wrap')&&!res.contains(e.target)) res.classList.remove('show'); });
}

function showZoneSelected() {
  const el=V('flex-selected'); if (!el||!formEnvio) return;
  el.innerHTML=`
    <div><div class="flex-selected-name">${formEnvio.localidad}</div><div style="font-size:11px;color:var(--text-3)">${formEnvio.zona}</div></div>
    <div style="text-align:right">
      <div class="flex-selected-importe">−$${fmt(formEnvio.importe)}</div>
      <button class="btn-link" style="color:var(--red);font-size:11px" id="btn-clear-zone">Cambiar</button>
    </div>`;
  el.classList.add('show');
  // Remover listener anterior con cloneNode trick
  const btn = document.getElementById('btn-clear-zone');
  if (btn) { const fresh = btn.cloneNode(true); btn.replaceWith(fresh); fresh.addEventListener('click', clearZone); }
  updateNeto();
}
function clearZone() {
  formEnvio=null;
  const el=V('flex-selected'); if(el) el.classList.remove('show');
  const fn=V('flex-neto'); if(fn) fn.textContent='';
}
function updateNeto() {
  const v=parseNum(V('f-importe-flex')?.value||'');
  const fn=V('flex-neto'); if(fn) fn.textContent=formEnvio&&v>0?`Neto: $${fmt(v-formEnvio.importe)}`:'';
}

// ─── SELECTOR PRODUCTOS / TALLES ──────────────────────────────────────────────
function getProductTalles(p) {
  const fixed=PRODUCTOS_FIJO[p];
  if (fixed) return fixed;
  return TALLES.filter(t=>stockAll||(stock[`${p}_${t}`]??0)>0);
}

function renderProdBtns() {
  const sorted = getSortedProductos();
  const disp = sorted.filter(p => stockAll || getProductTalles(p).length > 0);
  const c = V('producto-btns'); if (!c) return;
  c.innerHTML = disp.length
    ? disp.map(p => `<button class="producto-btn" onclick="selProd('${p.replace(/'/g,"\\'")}')">${p}</button>`).join('')
    : `<p class="hint-text">Sin stock — activá ✏️ Manual</p>`;
}

window.selProd = p => {
  curProducto=p;
  document.querySelectorAll('#producto-btns .producto-btn').forEach(b=>b.classList.toggle('active',b.textContent.trim()===p));
  const talles=getProductTalles(p);
  V('talle-btns').innerHTML=talles.map(t=>{
    const js=typeof t==='string'?`'${t}'`:t;
    const unico=PRODUCTOS_FIJO[p]&&talles.length===1;
    return `<button class="talle-btn${unico?' talle-unico':''}" onclick="selTalle(${js})">${displayTalle(t)}</button>`;
  }).join('');
  V('talle-wrap').style.display='flex';
  if (talles.length===1) selTalle(talles[0]);
};

window.selTalle = t => {
  if (!curProducto) return;
  formItems.push({producto:curProducto,talle:t});
  renderFormItems();
  curProducto=null;
  V('talle-wrap').style.display='none';
  document.querySelectorAll('#producto-btns .producto-btn').forEach(b=>b.classList.remove('active'));
  V('btn-add-otro').style.display='flex';
  V('btn-multi').style.display='flex';
  toast('Par agregado ✓');
};

// ─── ITEMS LISTA ──────────────────────────────────────────────────────────────
function renderFormItems() {
  const list=V('items-list'); if (!list) return;
  if (!formItems.length) { list.innerHTML=''; return; }
  const g={};
  formItems.forEach(item=>{
    const k=`${item.producto}||${item.talle}`;
    if(!g[k]) g[k]={...item,count:0};
    g[k].count++;
  });
  list.innerHTML=Object.entries(g).map(([k,{producto,talle,count}])=>{
    const kEnc=encodeURIComponent(k);
    return `<div class="item-row">
      <span class="item-row-text">${producto} ${displayTalle(talle)}</span>
      <div class="item-row-right">
        ${count>1?`<span class="item-qty-badge">×${count}</span>`:''}
        <button class="btn-pencil item-pencil" onclick="editItemQty('${kEnc}')">✏️</button>
        <button class="item-remove" onclick="removeGroup('${kEnc}')">×</button>
      </div>
    </div>`;
  }).join('');
}

window.editItemQty = async kEnc => {
  const k=decodeURIComponent(kEnc);
  const [producto,talleStr]=k.split('||');
  const talle=isNaN(parseInt(talleStr))?talleStr:parseInt(talleStr);
  const current=formItems.filter(i=>i.producto===producto&&String(i.talle)===talleStr).length;
  const v = await showInputDialog(`${producto} ${displayTalle(talle)}`, current);
  if (v===null) return;
  const n=parseInt(v);
  if (isNaN(n)||n<0) { toast('Número inválido'); return; }
  formItems=formItems.filter(i=>!(i.producto===producto&&String(i.talle)===talleStr));
  for(let i=0;i<n;i++) formItems.push({producto,talle});
  renderFormItems();
};

window.removeGroup = kEnc => {
  const k=decodeURIComponent(kEnc);
  const [producto,talleStr]=k.split('||');
  formItems=formItems.filter(i=>!(i.producto===producto&&String(i.talle)===talleStr));
  renderFormItems();
  if(!formItems.length) { V('btn-add-otro').style.display='none'; V('btn-multi').style.display='none'; }
};

// ─── MULTI PANEL ─────────────────────────────────────────────────────────────
function renderMultiProd() {
  const sorted = getSortedProductos();
  const disp = sorted.filter(p => stockAll || getProductTalles(p).length > 0);
  V('multi-producto-btns').innerHTML = disp.map(p =>
    `<button class="producto-btn" onclick="mSelProd('${p.replace(/'/g,"\\'")}')">${p}</button>`
  ).join('');
}
window.mSelProd = p => {
  multiProd=p;
  document.querySelectorAll('#multi-producto-btns .producto-btn').forEach(b=>b.classList.toggle('active',b.textContent.trim()===p));
  const talles=getProductTalles(p);
  V('multi-talle-btns').innerHTML=talles.map(t=>{
    const js=typeof t==='string'?`'${t}'`:t;
    return `<button class="talle-btn" onclick="mSelTalle(${js})">${displayTalle(t)}</button>`;
  }).join('');
  V('multi-talle-wrap').style.display='flex';
  if (talles.length===1) mSelTalle(talles[0]);
};
window.mSelTalle = t => {
  if (!multiProd) return;
  formItems.push({producto:multiProd,talle:t});
  renderFormItems();
  multiProd=null;
  V('multi-wrap').style.display='none';
  V('multi-talle-wrap').style.display='none';
  V('btn-add-otro').style.display='flex';
  V('btn-multi').style.display='flex';
  toast('Ítem agregado ✓');
};

// ─── GUARDAR VENTA ────────────────────────────────────────────────────────────
async function guardarVenta() {
  const nombre=titleCase(V('f-nombre').value.trim());
  if (!nombre)           { toast('Ingresá el nombre'); return; }
  if (!formItems.length) { toast('Agregá al menos un ítem'); return; }

  // Detección de duplicados solo en nuevos pedidos
  if (!editingId) {
    const dups=orders.filter(o=>
      o.nombreComprador.toLowerCase()===nombre.toLowerCase() && o.status!=='entregado'
    );
    if (dups.length && !await showConfirm(`Ya existe un pedido activo de "${nombre}"`, {
      icon:'⚠️', confirmText:'Cargar igual', confirmClass:'btn-primary', cancelText:'Cancelar',
    })) return;
  }

  const base={
    cuenta:curCuenta, nombreComprador:nombre, tipoEnvio:curEnvio, items:formItems,
    status:editingId?(orders.find(o=>o.id===editingId)?.status||'preparar'):'preparar',
    corteDone:editingId?(orders.find(o=>o.id===editingId)?.corteDone||false):false,
  };
  if (curCuenta==='enano') {
    base.provincia=V('f-provincia').value.trim();
    base.iibb=parseNum(V('f-iibb').value)||0;
  }
  if (curEnvio==='FLEX') {
    if (!formEnvio) { toast('Seleccioná la localidad'); return; }
    const v=parseNum(V('f-importe-flex').value); if (!v) { toast('Ingresá el importe'); return; }
    base.importeVenta=v; base.flexLocalidad=formEnvio.localidad; base.flexZona=formEnvio.zona;
    base.flexImporte=formEnvio.importe; base.importeNeto=v-formEnvio.importe; base.importeAcreditado=base.importeNeto;
  } else {
    const m=parseNum(V('f-importe-pe').value); if (!m) { toast('Ingresá el importe'); return; }
    base.importeAcreditado=m;
  }
  if (!editingId) {
    const hoy=new Date(), man=new Date(hoy); man.setDate(hoy.getDate()+1);
    base.fechaEstimada=curEnvio==='FLEX'?hoy.toLocaleDateString('es-AR'):man.toLocaleDateString('es-AR');
  }

  closeSheet($shNueva);

  try {
    if (editingId) {
      await db.collection('orders').doc(editingId).update(base);
      mutateOrder(editingId,base); saveOrders(); renderPedidos(); renderCorte();
      toast('Actualizado ✓');
    } else {
      base.createdAt=TS();
      const ref=await db.collection('orders').add(base);
      orders.unshift({id:ref.id,...base}); saveOrders(); renderPedidos(); renderCorte();
      toast('Venta guardada ✓');
    }
  } catch(e){ toast('Error al guardar'); console.error(e); }
}

// ─── CORTE VIEW ───────────────────────────────────────────────────────────────
function renderCorte(animDir='') {
  const v=VIEWS.corte; if (!v) return;
  const nC=orders.filter(o=>!o.corteDone&&o.cuenta==='capi').length;
  const nE=orders.filter(o=>!o.corteDone&&o.cuenta==='enano').length;
  if (corteCuenta==='deposito') corteCuenta='capi';
  // Tabs → fuera del scroll en #corte-tabbar
  const corteTabbar = document.getElementById('corte-tabbar');
  if (corteTabbar) corteTabbar.innerHTML = `
    <div class="corte-tabs">
      <button class="corte-tab${corteCuenta==='capi'?' active':''}"  onclick="setCorte('capi')">CAPI${nC?` <span class="corte-count">${nC}</span>`:''}</button>
      <button class="corte-tab${corteCuenta==='enano'?' active':''}" onclick="setCorte('enano')">ENANO${nE?` <span class="corte-count">${nE}</span>`:''}</button>
      <button class="corte-tab${corteCuenta==='flex'?' active':''}"  onclick="setCorte('flex')">FLEX $</button>
    </div>`;
  v.innerHTML = `<div class="ped-main-content${animDir?' '+animDir:''}">${renderCorteBody()}</div>`;
}
window.setCorte = (c, dir='') => { corteCuenta=c; flexFilter=null; renderCorte(dir); };
window.setFlexFilter = cuenta => { flexFilter = (flexFilter === cuenta ? null : cuenta); renderCorte(); };

function renderCorteBody() {
  if (corteCuenta==='deposito') return renderDepCorte();
  if (corteCuenta==='flex')     return renderCorteFlexBody();
  const pend=orders.filter(o=>!o.corteDone&&o.cuenta===corteCuenta);
  if (!pend.length) return `<div class="empty-state"><span>✂️</span><p>Sin ventas pendientes de corte</p></div>`;
  const tV=corteCuenta==='capi'?textoCapi(pend):textoEnano(pend);
  const tC=textoCostos(pend,corteCuenta);
  return `
    <div class="card" style="padding:16px">
      <div class="section-title">Ventas ${corteCuenta.toUpperCase()}</div>
      <div class="text-output" style="margin-top:8px">${renderWA(tV)}</div>
      <div class="card-act" style="margin-top:10px">
        <button class="btn btn-ghost btn-sm" onclick="copyTxt(${esc(tV)})">📋 Copiar</button>
        <button class="btn btn-primary btn-sm" onclick="doCortado('${corteCuenta}')">✓ Marcar cortado</button>
      </div>
    </div>
    <div class="card" style="padding:16px">
      <div class="section-title">Costos ${corteCuenta.toUpperCase()}</div>
      <div class="text-output" style="margin-top:8px">${renderWA(tC)}</div>
      <div class="card-act" style="margin-top:10px">
        <button class="btn btn-ghost btn-sm" onclick="copyTxt(${esc(tC)})">📋 Copiar</button>
      </div>
    </div>
    <div class="section-title">Incluidos (${pend.length})</div>
    ${pend.map(o=>`<div class="card" style="padding:12px 14px">
      <b>${o.nombreComprador}</b>
      <div style="font-size:13px;color:var(--text-2)">${fmtItemsShort(o.items)}</div>
      <div style="font-size:12px;color:var(--text-3)">$${fmt(o.importeAcreditado)}</div>
    </div>`).join('')}`;
}

function renderDepCorte() {
  const prep=orders.filter(o=>o.status==='preparar');
  if (!prep.length) return `<div class="empty-state"><span>🏪</span><p>Sin pedidos para preparar</p></div>`;
  const lines=calcDep();
  const pm={}; lines.forEach(l=>{if(!pm[l.prod])pm[l.prod]=[];pm[l.prod].push(l);});
  const txt=`A buscar:\n${lines.map(l=>`${l.prod} ${displayTalle(l.talle)} ×${l.qty}`).join('\n')}\n\nTotal: ${prep.length} pedidos`;
  return `<div class="card" style="padding:16px">
    <div class="section-title">A buscar en depósito</div>
    ${Object.entries(pm).map(([m,ls])=>`
      <div class="deposito-modelo"><div class="deposito-modelo-name">${m}</div>
        <div class="deposito-talles">${ls.map(l=>`<div class="deposito-item"><span class="deposito-talle">${displayTalle(l.talle)}</span><span class="deposito-qty">×${l.qty}</span></div>`).join('')}</div>
      </div>`).join('')}
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--sep)">
      <div class="dep-hdr" style="margin-bottom:6px">Stock restante tras preparar</div>
      ${lines.map(l=>`<div class="dep-row"><span class="dep-n">${l.prod} ${displayTalle(l.talle)}</span><span class="dep-q">−${l.qty}</span><span class="dep-r ${l.queda===0?'cero':l.queda<=2?'bajo':'ok'}">queda ${l.queda}</span></div>`).join('')}
    </div>
    <button class="btn btn-primary" style="margin-top:14px;width:100%" onclick="copyTxt(${esc(txt)})">📋 Copiar lista</button>
  </div>
  <div class="section-title">Por preparar (${prep.length})</div>
  ${prep.map(o=>`<div class="card" style="padding:12px 14px">
    <b>${o.nombreComprador}</b>
    <div style="font-size:13px;color:var(--text-2)">${fmtItemsShort(o.items)}</div>
    <div style="font-size:12px;color:var(--text-3)">${o.cuenta.toUpperCase()} — ${o.tipoEnvio}</div>
  </div>`).join('')}`;
}

function textoCapi(pend) {
  let tot=0; const L=['Ventas Meli capi'];
  pend.forEach((o,i)=>{
    let m;
    if (o.tipoEnvio==='FLEX'&&o.importeVenta) {
      m=`importe venta $${fmt(o.importeVenta)} menos envio FLEX $${fmt(o.flexImporte)} se acredito $${fmt(o.importeNeto)}`;
    } else {
      m=`se acredito $${fmt(o.importeAcreditado)}`;
    }
    L.push(`${i+1}. ${o.nombreComprador} - ${fmtItemsCorte(o.items)} - ${m}`); tot+=o.importeAcreditado||0;
  });
  L.push('',`Total acreditado a mp capi $${fmt(Math.round(tot/100)*100)}`); return L.join('\n');
}
function textoEnano(pend) {
  let tot=0; const L=['Ventas meli enano'];
  pend.forEach((o,i)=>{
    const iibb=o.provincia&&o.iibb?` (${o.provincia} IIBB ya descontado $${fmtDec(o.iibb)})`:'';
    const m=o.tipoEnvio==='FLEX'&&o.importeVenta
      ?`importe venta $${fmt(o.importeVenta)} menos *ENVIO FLEX $${fmt(o.flexImporte)}* total sin envío $${fmt(o.importeNeto)}`
      :`se acredito $${fmt(o.importeAcreditado)}`;
    L.push(`${i+1}. ${o.nombreComprador}${iibb} - ${fmtItemsCorte(o.items)} - ${m}`); tot+=o.importeAcreditado||0;
  });
  L.push('',`*Total acreditado a mp enano $${fmt(tot)}*`); return L.join('\n');
}
function textoCostos(pend,c) {
  let e=0,n=0; pend.forEach(o=>(o.items||[]).forEach(i=>TALLES_ESP.includes(i.talle)?e++:n++));
  const L=[`Costo ${c.toUpperCase()}`];
  if(e>0)L.push(`${e} cat especiales $${fmt(COSTO_ESP)}`);
  if(n>0)L.push(`${n} cat comunes $${fmt(COSTO_COMUN)}`);
  L.push('',`Total costos $${fmt(e*COSTO_ESP+n*COSTO_COMUN)}`); return L.join('\n');
}
function fmtItemsCorte(items) {
  if(!items||!items.length)return'';
  const s=sortIt(items);
  if(s.length===1)return`${s[0].producto.toLowerCase()} ${displayTalle(s[0].talle)}`;
  const g={}; s.forEach(i=>{const k=`${i.producto} ${displayTalle(i.talle)}`;g[k]=(g[k]||0)+1;});
  return`${s.length} pares (${Object.entries(g).map(([k,q])=>q>1?`${k} x${q}`:k).join(' - ')})`;
}
function renderWA(t){return t.replace(/\*(.*?)\*/g,'<b>$1</b>').replace(/\n/g,'<br>');}
function esc(t){return JSON.stringify(t).replace(/"/g,'&quot;');}
window.copyTxt = t=>navigator.clipboard.writeText(t).then(()=>toast('¡Copiado!')).catch(()=>toast('Error al copiar'));
window.doCortado = async c=>{
  const pend=orders.filter(o=>!o.corteDone&&o.cuenta===c);
  pend.forEach(o=>mutateOrder(o.id,{corteDone:true})); renderCorte();
  try{for(const o of pend) await db.collection('orders').doc(o.id).update({corteDone:true}); toast('Cortado ✓');}
  catch(e){toast('Sin red');}
};

// ─── FLEX QUINCENA ────────────────────────────────────────────────────────────
const MESES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

function getCurrentPeriod() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const half = d <= 15 ? 1 : 2;
  const fromMs = half===1
    ? new Date(y,m,1).getTime()
    : new Date(y,m,16).getTime();
  const lastDay = new Date(y,m+1,0).getDate();
  const toMs = half===1
    ? new Date(y,m,15,23,59,59,999).getTime()
    : new Date(y,m+1,0,23,59,59,999).getTime();
  const label = half===1
    ? `1-15 ${MESES[m]} ${y}`
    : `16-${lastDay} ${MESES[m]} ${y}`;
  return { id:`${y}-${String(m+1).padStart(2,'0')}-${half}`, label, fromMs, toMs, year:y, month:m+1, half };
}

function calcFlexPeriod(fromMs, toMs) {
  const r = {
    capi:  { total:0, count:0, orders:[] },
    enano: { total:0, count:0, orders:[] },
  };
  const seen = new Set();

  // Primera pasada: recolectar IDs excluidos por tombstones
  flexManualRecords.forEach(rec => {
    if (rec.deleted && rec.orderId) seen.add(rec.orderId);
  });

  // Registros manuales activos (incluye los guardados al despachar y al borrar)
  flexManualRecords.forEach(rec => {
    if (rec.deleted) return;
    if (!rec.fechaMs || rec.fechaMs < fromMs || rec.fechaMs > toMs) return;
    seen.add(rec.orderId || rec.id);
    const acc = rec.cuenta==='capi' ? r.capi : r.enano;
    acc.total += rec.flexImporte;
    acc.count++;
    acc.orders.push({ id:rec.id, nombre:rec.nombre, cuenta:rec.cuenta,
      localidad:rec.localidad||'', zona:rec.zona||'', flexImporte:rec.flexImporte, despachadoAt:rec.fechaMs,
      isManual:true, recordId:rec.id });
  });

  // Órdenes activas que aún no tienen registro manual (fallback para órdenes viejas)
  orders.forEach(o => {
    if (o.tipoEnvio!=='FLEX' || !o.flexImporte) return;
    const dAt = ms(o.despachadoAt);
    if (!dAt || dAt < fromMs || dAt > toMs) return;
    if (seen.has(o.id)) return; // ya cubierta por registro manual o excluida por tombstone
    const acc = o.cuenta==='capi' ? r.capi : r.enano;
    acc.total += o.flexImporte;
    acc.count++;
    acc.orders.push({ id:o.id, nombre:o.nombreComprador, cuenta:o.cuenta,
      localidad:o.flexLocalidad||'', zona:o.flexZona||'', flexImporte:o.flexImporte, despachadoAt:dAt,
      isManual:false, orderId:o.id });
  });

  return r;
}

function renderCorteFlexBody() {
  const period = getCurrentPeriod();
  const stats  = calcFlexPeriod(period.fromMs, period.toMs);
  const allOrders = [...stats.capi.orders, ...stats.enano.orders]
    .sort((a,b) => b.despachadoAt - a.despachadoAt);
  const filteredOrders = flexFilter ? allOrders.filter(o => o.cuenta === flexFilter) : allOrders;
  const alreadyClosed = flexPeriods.some(p => p.id === period.id);

  let html = `<div class="card" style="padding:16px">
    <div class="section-title">Quincena actual — ${period.label}</div>
    <div class="flex-stat-row">
      <div class="flex-stat-box${flexFilter==='capi'?' stat-active':''}" style="background:var(--blue-light)" onclick="setFlexFilter('capi')" title="Filtrar por CAPI">
        <div class="flex-stat-label">CAPI</div>
        <div class="flex-stat-val">$${fmt(stats.capi.total)}</div>
        <div class="flex-stat-n">${stats.capi.count} envío${stats.capi.count!==1?'s':''}</div>
        <div style="font-size:9px;color:var(--text-3);margin-top:3px">${flexFilter==='capi'?'● Filtrando':'Toca para filtrar'}</div>
      </div>
      <div class="flex-stat-box${flexFilter==='enano'?' stat-active':''}" style="background:var(--purple-light)" onclick="setFlexFilter('enano')" title="Filtrar por ENANO">
        <div class="flex-stat-label">ENANO</div>
        <div class="flex-stat-val">$${fmt(stats.enano.total)}</div>
        <div class="flex-stat-n">${stats.enano.count} envío${stats.enano.count!==1?'s':''}</div>
        <div style="font-size:9px;color:var(--text-3);margin-top:3px">${flexFilter==='enano'?'● Filtrando':'Toca para filtrar'}</div>
      </div>
    </div>
    <div style="margin-top:8px;font-size:13px;color:var(--text-2)">Total: <b>$${fmt(stats.capi.total+stats.enano.total)}</b>${flexFilter?` &nbsp;<span style="font-size:11px;color:var(--orange);font-weight:600">· Filtro activo: ${flexFilter.toUpperCase()} <button onclick="setFlexFilter(null)" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:11px;padding:0 2px">✕</button></span>`:''}</div>
    <div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;gap:8px">
        <button class="btn ${alreadyClosed?'btn-ghost':'btn-primary'}" style="flex:1" onclick="cerrarQuincena()">
          ${alreadyClosed ? '↻ Recalcular' : '📥 Cerrar quincena'}
        </button>
        <button class="btn-circle-icon" onclick="downloadFlexPDF()" title="Descargar PDF">📄</button>
      </div>
      <button class="btn btn-ghost" style="width:100%" onclick="openAddFlexSheet()">➕ Agregar registro</button>
    </div>
    ${filteredOrders.length ? `<div style="margin-top:12px;border-top:1px solid var(--sep);padding-top:8px">
      ${filteredOrders.map(o=>{
        const d=new Date(o.despachadoAt);
        const fecha=`${d.getDate()}/${d.getMonth()+1}`;
        const editBtn = `<button onclick="event.stopPropagation();openEditFlexSheet('${o.isManual?(o.recordId||o.id):o.id}')" style="background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px;color:var(--text-3)">✏️</button>`;
        const delBtn  = o.isManual
          ? `<button onclick="event.stopPropagation();deleteFlexRecord('${o.id}',true)" style="background:none;border:none;cursor:pointer;font-size:13px;padding:2px 4px;color:var(--red);opacity:0.65">🗑</button>`
          : `<button onclick="event.stopPropagation();deleteFlexRecord('${o.id}',false)" style="background:none;border:none;cursor:pointer;font-size:13px;padding:2px 4px;color:var(--red);opacity:0.65">🗑</button>`;
        return `<div class="flex-order-row">
          <div style="flex:1;min-width:0">
            <span class="badge badge-${o.cuenta}" style="font-size:9px;padding:2px 6px">${o.cuenta.toUpperCase()}</span>
            <span style="margin-left:6px;font-weight:600">${o.nombre}</span>
            <div style="font-size:11px;color:var(--text-3);margin-top:1px">${o.localidad} <span style="opacity:0.7">· ${fecha}</span></div>
          </div>
          <div style="display:flex;align-items:center;gap:2px;flex-shrink:0;margin-left:8px">
            <div style="font-size:13px;font-weight:700;color:var(--red)">−$${fmt(o.flexImporte)}</div>
            ${editBtn}${delBtn}
          </div>
        </div>`;
      }).join('')}
    </div>` : `<p class="hint-text" style="margin-top:8px">${flexFilter ? `Sin envíos de ${flexFilter.toUpperCase()} en este período` : 'Sin envíos FLEX despachados en este período'}</p>`}
  </div>`;

  // Historial agrupado por mes
  if (flexPeriods.length) {
    const porMes = {};
    flexPeriods.forEach(p => {
      const k = `${p.year}-${String(p.month).padStart(2,'0')}`;
      if (!porMes[k]) porMes[k] = { label: `${MESES[p.month-1]} ${p.year}`, periods: [] };
      porMes[k].periods.push(p);
    });
    const monthKeys = Object.keys(porMes).sort((a,b)=>b.localeCompare(a));
    // Auto-expandir el mes más reciente si no hay nada expandido aún
    if (expandFlexPeriods.size === 0 && monthKeys.length > 0) expandFlexPeriods.add(monthKeys[0]);

    html += `<div class="section-title" style="margin-top:4px">Historial de quincenas</div>`;
    monthKeys.forEach(mk => {
      const { label: mLabel, periods: mPers } = porMes[mk];
      const mCapiT  = mPers.reduce((s,p)=>s+(p.capi?.total||0),0);
      const mEnanoT = mPers.reduce((s,p)=>s+(p.enano?.total||0),0);
      const expanded = expandFlexPeriods.has(mk);
      html += `<div class="card flex-period-card">
        <div style="padding:14px 16px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;gap:12px" onclick="toggleFlexMonth('${mk}')">
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:15px">${mLabel}</div>
            <div style="font-size:12px;color:var(--text-3)">${mPers.length} quincena${mPers.length>1?'s':''} · Total $${fmt(mCapiT+mEnanoT)}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex-shrink:0">
            <div style="font-size:12px;color:var(--blue);font-weight:600">C $${fmt(mCapiT)}</div>
            <div style="font-size:12px;color:var(--purple);font-weight:600">E $${fmt(mEnanoT)}</div>
          </div>
          <div style="color:var(--text-3);font-size:12px;transition:transform 0.2s;transform:rotate(${expanded?180:0}deg)">▼</div>
        </div>
        ${expanded ? `<div class="flex-period-body" style="padding:0 16px 12px">
          ${mPers.sort((a,b)=>b.half-a.half).map(p=>`
            <div style="padding:10px 0;border-top:1px solid var(--sep)">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                <div style="flex:1;min-width:0">
                  <div style="font-weight:700;font-size:14px">${p.label}</div>
                  <div style="font-size:11px;color:var(--text-3)">Cerrado ${p.closedAt} · C $${fmt(p.capi?.total||0)} · E $${fmt(p.enano?.total||0)}</div>
                </div>
                <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
                  <button onclick="event.stopPropagation();downloadFlexPeriodPDF('${p.id}')" class="btn-circle-icon" title="PDF" style="width:34px;height:34px;font-size:14px">📄</button>
                  <button onclick="event.stopPropagation();eliminarPeriodo('${p.id}')" class="btn-circle-icon" title="Eliminar" style="width:34px;height:34px;font-size:14px;background:var(--red-light);border-color:rgba(255,59,48,0.3)">🗑</button>
                </div>
              </div>
              ${(p.capi?.orders||[]).length+(p.enano?.orders||[]).length > 0 ? `
                <div style="margin-top:8px;display:flex;flex-direction:column;gap:4px">
                  ${[...(p.capi?.orders||[]),...(p.enano?.orders||[])].sort((a,b)=>(b.despachadoAt||0)-(a.despachadoAt||0)).map(o=>{
                    const fecha = o.despachadoAt ? `${new Date(o.despachadoAt).getDate()}/${new Date(o.despachadoAt).getMonth()+1}` : '';
                    return `<div class="flex-order-row">
                      <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0">
                        <span class="badge badge-${o.cuenta}" style="font-size:9px;flex-shrink:0">${o.cuenta.toUpperCase()}</span>
                        <span style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${o.nombre}</span>
                        ${fecha?`<span style="font-size:11px;color:var(--text-3);flex-shrink:0">${fecha}</span>`:''}
                      </div>
                      <div style="font-size:12px;font-weight:700;color:var(--red);flex-shrink:0">−$${fmt(o.flexImporte)}</div>
                    </div>`;
                  }).join('')}
                </div>` : `<p class="hint-text" style="margin-top:6px">Sin detalle guardado</p>`}
            </div>`).join('')}
        </div>` : ''}
      </div>`;
    });
  } else {
    html += `<div class="empty-state" style="padding:32px 24px;min-height:auto">
      <span style="font-size:32px">📋</span>
      <p style="font-size:14px">Acá vas a ver el historial una vez que cierres tu primera quincena</p>
    </div>`;
  }
  return html;
}

window.toggleFlexMonth = mk => {
  expandFlexPeriods.has(mk) ? expandFlexPeriods.delete(mk) : expandFlexPeriods.add(mk);
  renderCorte();
};

window.cerrarQuincena = async () => {
  const period = getCurrentPeriod();
  const stats  = calcFlexPeriod(period.fromMs, period.toMs);
  if (!stats.capi.count && !stats.enano.count) { toast('Sin envíos FLEX en esta quincena'); return; }
  const ok = await showConfirm(`Cerrar quincena "${period.label}"`, {
    icon:'📥', confirmText:'Cerrar quincena', confirmClass:'btn-primary',
    sub:`CAPI $${fmt(stats.capi.total)} · ENANO $${fmt(stats.enano.total)}`,
  });
  if (!ok) return;

  const record = {
    id:        period.id,
    label:     period.label,
    year:      period.year,
    month:     period.month,
    half:      period.half,
    closedAt:  new Date().toLocaleDateString('es-AR'),
    capi:  { total:stats.capi.total,  count:stats.capi.count,  orders:stats.capi.orders.map(({nombre,localidad,zona,flexImporte,cuenta,despachadoAt})=>({nombre,localidad,zona:zona||'',flexImporte,cuenta,despachadoAt})) },
    enano: { total:stats.enano.total, count:stats.enano.count, orders:stats.enano.orders.map(({nombre,localidad,zona,flexImporte,cuenta,despachadoAt})=>({nombre,localidad,zona:zona||'',flexImporte,cuenta,despachadoAt})) },
  };
  flexPeriods = flexPeriods.filter(p => p.id !== period.id);
  flexPeriods.push(record);
  saveFlexPeriods();
  try {
    await db.collection('meta').doc('flexPeriods').set({ periods: flexPeriods });
    toast('Quincena cerrada ✓');
  } catch(e) { toast('Guardado local ✓'); }
  renderCorte();
};

function buildFlexPdfHtml(label, orders, capiTotal, capiCount, enanoTotal, enanoCount) {
  const capiOrders  = orders.filter(o => o.cuenta === 'capi') .sort((a,b) => (a.despachadoAt||0)-(b.despachadoAt||0));
  const enanoOrders = orders.filter(o => o.cuenta === 'enano').sort((a,b) => (a.despachadoAt||0)-(b.despachadoAt||0));
  function mkRows(list) {
    return list.map(o => {
      const d = new Date(o.despachadoAt);
      const f = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
      const zonaLabel = o.zona ? `<span style="background:#e8eaf0;color:#555;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:bold">${o.zona}</span>` : '';
      return `<tr><td>${f}</td><td>${o.nombre}</td><td>${o.localidad}${o.zona?` ${zonaLabel}`:''}</td><td style="text-align:right;font-weight:600">$${fmt(o.flexImporte)}</td></tr>`;
    }).join('');
  }
  function mkSection(titulo, list, total, count, color) {
    if (!list.length) return '';
    return `<div style="background:${color};color:#fff;padding:8px 12px;border-radius:6px;margin:20px 0 6px;font-size:13px;font-weight:bold">
      ${titulo} — ${count} envío${count!==1?'s':''}</div>
    <table><tr><th>Fecha</th><th>Cliente</th><th>Localidad / Zona</th><th>Costo FLEX</th></tr>
    ${mkRows(list)}
    <tr style="background:#f0f4f8"><td colspan="3" style="text-align:right;font-weight:bold;padding-right:12px">Subtotal ${titulo}</td><td style="text-align:right;font-weight:800;font-size:14px">$${fmt(total)}</td></tr>
    </table>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>FLEX ${label}</title>
<style>
body{font-family:Arial,sans-serif;font-size:12px;padding:24px;color:#111}
h2{margin:0 0 2px;font-size:18px;color:#1a1a2e}
.gen{color:#888;font-size:11px;margin-bottom:20px}
table{width:100%;border-collapse:collapse;margin-bottom:4px}
th,td{border:1px solid #ddd;padding:7px 10px;text-align:left}
th{background:#f0f0f0;font-weight:bold;font-size:11px;text-transform:uppercase;color:#555}
.grand{margin-top:20px;text-align:right;padding:14px 16px;background:#1a1a2e;color:#fff;border-radius:8px;font-size:16px;font-weight:800}
.resumen{display:flex;gap:16px;margin-bottom:8px}
.res-box{flex:1;border:1px solid #ddd;border-radius:6px;padding:10px 14px}
.res-label{font-size:10px;text-transform:uppercase;color:#888;font-weight:600}
.res-val{font-size:20px;font-weight:800;margin-top:2px}
.res-n{font-size:11px;color:#888}
@media print{body{padding:10px}}
</style></head><body>
<h2>Envíos FLEX — ${label}</h2>
<div class="gen">Generado el ${new Date().toLocaleDateString('es-AR')}</div>
<div class="resumen">
  <div class="res-box"><div class="res-label">CAPI</div><div class="res-val" style="color:#007AFF">$${fmt(capiTotal)}</div><div class="res-n">${capiCount} envío${capiCount!==1?'s':''}</div></div>
  <div class="res-box"><div class="res-label">ENANO</div><div class="res-val" style="color:#AF52DE">$${fmt(enanoTotal)}</div><div class="res-n">${enanoCount} envío${enanoCount!==1?'s':''}</div></div>
</div>
${mkSection('CAPI', capiOrders, capiTotal, capiCount, '#007AFF')}
${mkSection('ENANO', enanoOrders, enanoTotal, enanoCount, '#AF52DE')}
<div class="grand">TOTAL FLEX: $${fmt(capiTotal + enanoTotal)}</div>
<script>window.onload=()=>{window.print();}<\/script></body></html>`;
}
window.downloadFlexPDF = () => {
  const period = getCurrentPeriod();
  const stats = calcFlexPeriod(period.fromMs, period.toMs);
  const allOrders = [...stats.capi.orders, ...stats.enano.orders].sort((a,b) => b.despachadoAt - a.despachadoAt);
  if (!allOrders.length) { toast('Sin envíos FLEX para exportar'); return; }
  const w = window.open('', '_blank');
  if (!w) { toast('Habilitá pop-ups para descargar'); return; }
  w.document.write(buildFlexPdfHtml(period.label, allOrders, stats.capi.total, stats.capi.count, stats.enano.total, stats.enano.count));
  w.document.close();
};
window.downloadFlexPeriodPDF = pid => {
  const p = flexPeriods.find(x => x.id === pid);
  if (!p) return;
  const allOrders = [...(p.capi?.orders||[]), ...(p.enano?.orders||[])].sort((a,b) => (b.despachadoAt||0) - (a.despachadoAt||0));
  if (!allOrders.length) { toast('Sin envíos guardados en esta quincena'); return; }
  const w = window.open('', '_blank');
  if (!w) { toast('Habilitá pop-ups para descargar'); return; }
  w.document.write(buildFlexPdfHtml(p.label, allOrders, p.capi?.total||0, p.capi?.count||0, p.enano?.total||0, p.enano?.count||0));
  w.document.close();
};

window.deleteFlexRecord = async (id, isManual) => {
  const rec = isManual ? flexManualRecords.find(r => r.id === id) : null;
  const nombre = rec?.nombre || '';
  const ok = await showConfirm('¿Eliminar este registro FLEX?', {
    icon: '🗑',
    sub: nombre,
    confirmText: 'Eliminar',
    confirmClass: 'btn-danger',
  });
  if (!ok) return;
  if (isManual) {
    flexManualRecords = flexManualRecords.filter(r => r.id !== id);
  } else {
    // Tombstone: marca el pedido como excluido del período sin borrarlo del historial
    flexManualRecords.push({
      id: `del-${Date.now()}-${id}`,
      deleted: true,
      orderId: id,
      fechaMs: 0, cuenta: 'capi', nombre: '', localidad: '', zona: '', flexImporte: 0,
    });
  }
  syncFlexRecords();
  renderCorte();
  toast('Registro eliminado ✓');
};

window.eliminarPeriodo = async id => {
  const p = flexPeriods.find(p => p.id === id);
  if (!p) return;
  if (!await showConfirm(`¿Eliminar quincena "${p.label}"?`, { icon:'🗑', confirmText:'Eliminar', confirmClass:'btn-danger' })) return;
  flexPeriods = flexPeriods.filter(p => p.id !== id);
  saveFlexPeriods();
  try {
    await db.collection('meta').doc('flexPeriods').set({ periods: flexPeriods });
    toast('Quincena eliminada ✓');
  } catch(e) { toast('Guardado local ✓'); }
  renderCorte();
};

// ─── ADD / EDIT FLEX MANUAL ──────────────────────────────────────────────────
const $shAddFlex  = document.getElementById('sheet-add-flex');
const $shEditFlex = document.getElementById('sheet-edit-flex');

window.openAddFlexSheet = () => {
  addFlexCuenta = 'capi'; addFlexZone = null;
  document.querySelectorAll('[data-af-cuenta]').forEach(b=>b.classList.toggle('active',b.dataset.afCuenta==='capi'));
  V('af-fecha').value = tomorrowInput().replace(/(\d{4})-(\d{2})-(\d{2})/,'$1-$2-$3'); // hoy
  // default = today
  const t=new Date(); V('af-fecha').value=`${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`;
  V('af-nombre').value=''; V('af-localidad-input').value='';
  V('af-selected').innerHTML=''; V('af-selected').classList.remove('show');
  V('af-costo-wrap').style.display='none';
  openSheet($shAddFlex);
};

window.openEditFlexSheet = id => {
  const rec = flexManualRecords.find(r=>r.id===id);
  // Si no es manual, buscar en orders y crear vista-edición
  if (!rec) {
    const o = orders.find(o=>o.id===id);
    if (!o) return;
    // Convertir a manual antes de editar
    _addFlexRecord(o, ms(o.despachadoAt)||Date.now());
    const newRec = flexManualRecords.find(r=>r.orderId===id);
    if (newRec) window.openEditFlexSheet(newRec.id);
    return;
  }
  editFlexId=id; editFlexCuenta=rec.cuenta;
  document.querySelectorAll('[data-ef-cuenta]').forEach(b=>b.classList.toggle('active',b.dataset.efCuenta===rec.cuenta));
  V('ef-nombre').value=rec.nombre;
  V('ef-localidad').value='';
  V('ef-importe').value=rec.flexImporte;
  editFlexZone = { localidad:rec.localidad, zona:rec.zona, importe:rec.flexImporte };
  const sel=V('ef-selected');
  sel.innerHTML=`<div><div class="flex-selected-name">${rec.localidad}</div><div style="font-size:11px;color:var(--text-3)">${rec.zona}</div></div><div class="flex-selected-importe">−$${fmt(rec.flexImporte)}</div>`;
  sel.classList.add('show');
  openSheet($shEditFlex);
};

function setupAddFlexSheet() {
  if (!$shAddFlex) return;
  document.querySelectorAll('[data-af-cuenta]').forEach(b=>b.addEventListener('click',()=>{
    addFlexCuenta=b.dataset.afCuenta;
    document.querySelectorAll('[data-af-cuenta]').forEach(x=>x.classList.toggle('active',x===b));
  }));

  // Localidad search
  const inp=V('af-localidad-input'), sel=V('af-selected');
  if (inp) {
    let hits=[];
    inp.addEventListener('input',()=>{
      const q=normalizeStr(inp.value.trim());
      if (!q) { sel.classList.remove('show'); return; }
      hits=zones.filter(z=>normalizeStr(z.localidad).includes(q)).slice(0,6);
      if (!hits.length) { sel.classList.remove('show'); return; }
      sel.innerHTML=hits.map((z,i)=>`<div class="search-result-item" data-zi="${i}"><div class="sri-name">${z.localidad}</div><div class="sri-precio">$${fmt(z.importe)}</div></div>`).join('');
      sel.classList.add('show');
      sel.querySelectorAll('.search-result-item').forEach(el=>{
        el.addEventListener('mousedown',e=>{e.preventDefault();_pickAddZone(hits[+el.dataset.zi],inp,sel);});
        el.addEventListener('touchstart',e=>{e.preventDefault();_pickAddZone(hits[+el.dataset.zi],inp,sel);},{passive:false});
      });
    });
  }

  V('af-nombre')?.addEventListener('input', e => { const p=e.target.selectionStart,v=e.target.value,tc=titleCase(v); if(tc!==v){e.target.value=tc;e.target.setSelectionRange(p,p);} });
  V('af-nombre')?.addEventListener('blur', e => { e.target.value = titleCase(e.target.value); });
  V('btn-save-add-flex')?.addEventListener('click', async () => {
    const nombre=titleCase(V('af-nombre').value.trim());
    if (!nombre) { toast('Ingresá el nombre'); return; }
    if (!addFlexZone) { toast('Seleccioná la localidad'); return; }
    const fecha=V('af-fecha').value;
    if (!fecha) { toast('Ingresá la fecha'); return; }
    const [y,m,d]=fecha.split('-');
    const fechaMs=new Date(+y,+m-1,+d,12,0,0).getTime();

    // Detección de duplicados: mismo día + misma localidad
    const nuevoDia = new Date(fechaMs);
    const nuevoDiaStr = `${nuevoDia.getFullYear()}-${nuevoDia.getMonth()}-${nuevoDia.getDate()}`;
    const dupes = flexManualRecords.filter(r => {
      if (r.deleted || !r.fechaMs) return false;
      const rDia = new Date(r.fechaMs);
      return `${rDia.getFullYear()}-${rDia.getMonth()}-${rDia.getDate()}` === nuevoDiaStr
        && r.localidad === addFlexZone.localidad;
    });
    if (dupes.length) {
      const ok = await showConfirm(
        `Ya hay ${dupes.length} envío${dupes.length>1?'s':''} a ${addFlexZone.localidad} ese día`,
        { icon:'⚠️', sub:dupes.map(r=>r.nombre).join(' · '),
          confirmText:'Guardar igual', cancelText:'Revisar', confirmClass:'btn-primary' }
      );
      if (!ok) return;
    }

    flexManualRecords.push({
      id:`${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      cuenta:addFlexCuenta, nombre, localidad:addFlexZone.localidad,
      zona:addFlexZone.zona, flexImporte:addFlexZone.importe,
      fechaMs, orderId:null,
    });
    syncFlexRecords(); renderCorte(); closeSheet($shAddFlex); toast('Registro agregado ✓');
  });
}

function _pickAddZone(z, inp, sel) {
  addFlexZone=z; inp.value='';
  sel.innerHTML=`<div><div class="flex-selected-name">${z.localidad}</div><div style="font-size:11px;color:var(--text-3)">${z.zona}</div></div><div class="flex-selected-importe">−$${fmt(z.importe)}</div>`;
  V('af-costo-wrap').style.display='block';
  V('af-costo-display').textContent=`$${fmt(z.importe)}`;
}

function setupEditFlexSheet() {
  if (!$shEditFlex) return;
  document.querySelectorAll('[data-ef-cuenta]').forEach(b=>b.addEventListener('click',()=>{
    editFlexCuenta=b.dataset.efCuenta;
    document.querySelectorAll('[data-ef-cuenta]').forEach(x=>x.classList.toggle('active',x===b));
  }));

  // Localidad search en edit
  const inp=V('ef-localidad'), sel=V('ef-selected');
  if (inp) {
    let hits=[];
    inp.addEventListener('input',()=>{
      const q=normalizeStr(inp.value.trim());
      if (!q) return;
      hits=zones.filter(z=>normalizeStr(z.localidad).includes(q)).slice(0,6);
      if (!hits.length) return;
      sel.innerHTML=hits.map((z,i)=>`<div class="search-result-item" data-zi="${i}"><div class="sri-name">${z.localidad}</div><div class="sri-precio">$${fmt(z.importe)}</div></div>`).join('');
      sel.classList.add('show');
      sel.querySelectorAll('.search-result-item').forEach(el=>{
        const pick=e=>{e.preventDefault();const z=hits[+el.dataset.zi];
          editFlexZone=z; inp.value='';
          sel.innerHTML=`<div><div class="flex-selected-name">${z.localidad}</div><div style="font-size:11px;color:var(--text-3)">${z.zona}</div></div><div class="flex-selected-importe">−$${fmt(z.importe)}</div>`;
          sel.classList.add('show');
          V('ef-importe').value=z.importe;
        };
        el.addEventListener('mousedown',pick);
        el.addEventListener('touchstart',pick,{passive:false});
      });
    });
  }

  V('ef-nombre')?.addEventListener('input', e => { const p=e.target.selectionStart,v=e.target.value,tc=titleCase(v); if(tc!==v){e.target.value=tc;e.target.setSelectionRange(p,p);} });
  V('ef-nombre')?.addEventListener('blur', e => { e.target.value = titleCase(e.target.value); });
  V('btn-save-edit-flex')?.addEventListener('click',()=>{
    if (!editFlexId) return;
    const idx=flexManualRecords.findIndex(r=>r.id===editFlexId);
    if (idx<0) return;
    flexManualRecords[idx]={
      ...flexManualRecords[idx],
      cuenta:editFlexCuenta,
      nombre:titleCase(V('ef-nombre').value.trim()||flexManualRecords[idx].nombre),
      localidad:editFlexZone?.localidad||flexManualRecords[idx].localidad,
      zona:editFlexZone?.zona||flexManualRecords[idx].zona,
      flexImporte:parseInt(V('ef-importe').value)||flexManualRecords[idx].flexImporte,
    };
    syncFlexRecords(); renderCorte(); closeSheet($shEditFlex); toast('Registro actualizado ✓');
  });
}

// ─── SWIPE ENTRE TABS DE PEDIDOS ─────────────────────────────────────────────
function setupPedidosTabSwipe() {
  const view = VIEWS.pedidos; if (!view) return;
  let x0=0, y0=0;
  view.addEventListener('touchstart',e=>{x0=e.touches[0].clientX;y0=e.touches[0].clientY;},{passive:true});
  view.addEventListener('touchend',e=>{
    const dx=e.changedTouches[0].clientX-x0, dy=e.changedTouches[0].clientY-y0;
    const adx=Math.abs(dx);
    if (adx<80||Math.abs(dy)>adx*0.55) return;
    if (adx>=200) return; // gestos grandes pasan al swipe de sección
    e.stopPropagation();
    const tabs=['preparar','despacho','entregados'], i=tabs.indexOf(pedidosTab);
    if (dx<0&&i<tabs.length-1) setTab(tabs[i+1]);
    if (dx>0&&i>0)              setTab(tabs[i-1]);
  },{passive:true});
}

// ─── SWIPE ENTRE TABS DE CORTE ────────────────────────────────────────────────
function setupCorteTabSwipe() {
  const view = VIEWS.corte; if (!view) return;
  const tabs = ['capi','enano','flex'];
  let x0=0, y0=0;
  view.addEventListener('touchstart',e=>{x0=e.touches[0].clientX;y0=e.touches[0].clientY;},{passive:true});
  view.addEventListener('touchend',e=>{
    const dx=e.changedTouches[0].clientX-x0, dy=e.changedTouches[0].clientY-y0;
    const adx=Math.abs(dx);
    if (adx<80||Math.abs(dy)>adx*0.55) return;
    if (adx>=200) return; // gestos grandes pasan al swipe de sección
    e.stopPropagation();
    const i=tabs.indexOf(corteCuenta);
    const dir = dx < 0 ? 'slide-in-right' : 'slide-in-left';
    if (dx<0&&i<tabs.length-1) setCorte(tabs[i+1], dir);
    if (dx>0&&i>0) setCorte(tabs[i-1], dir);
  },{passive:true});
}

// ─── STOCK VIEW ───────────────────────────────────────────────────────────────
function renderStock() {
  const v=VIEWS.stock; if (!v) return;
  v.innerHTML=PRODUCTOS.map(p=>{
    const talles=PRODUCTOS_FIJO[p]?PRODUCTOS_FIJO[p]:TALLES;
    const conStock=talles.filter(t=>(stock[`${p}_${t}`]??0)>0);
    const sinStock=talles.filter(t=>(stock[`${p}_${t}`]??0)===0);
    const pEnc=encodeURIComponent(p);
    return `<div class="card stock-product-card">
      <div class="stock-product-name">${p}</div>
      ${conStock.length
        ? conStock.map(t=>renderStockRow(p,t)).join('')
        : `<div class="hint-text" style="padding:6px 0;color:var(--red)">Sin stock disponible</div>`}
      ${sinStock.length?`
        <button class="zero-toggle btn-link" onclick="toggleZeroStock('${pEnc}')">▼ Sin stock (${sinStock.length})</button>
        <div id="zero-${pEnc}" class="zero-section" style="display:none">${sinStock.map(t=>renderStockRow(p,t)).join('')}</div>
      `:''}
    </div>`;
  }).join('');
}

function renderStockRow(p,t) {
  const k=`${p}_${t}`,val=stock[k]??0,cls=val===0?'cero':val<=2?'bajo':'ok';
  return `<div class="stock-row ${cls}">
    <span class="stock-talle">${displayTalle(t)}</span>
    <div class="stock-stepper">
      <button class="stepper-btn" onclick="adjSt('${k}',-1)">−</button>
      <span class="stepper-val" id="sv-${k}">${val}</span>
      <button class="stepper-btn" onclick="adjSt('${k}',1)">+</button>
      <button class="stepper-btn stepper-pencil" onclick="editSt('${k}')">✏️</button>
    </div>
  </div>`;
}

window.toggleZeroStock=pEnc=>{
  const div=document.getElementById(`zero-${pEnc}`); if(!div) return;
  const btn=div.previousElementSibling;
  const show=div.style.display==='none';
  div.style.display=show?'block':'none';
  if(btn) btn.textContent=show?'▲ Ocultar agotados':`▼ Sin stock (${div.querySelectorAll('.stock-row').length})`;
};
function animNumPop(el) {
  if (!el) return;
  el.classList.remove('num-pop');
  void el.offsetWidth; // reflow para reiniciar animación
  el.classList.add('num-pop');
}
window.adjSt=(k,d)=>{
  stock[k]=Math.max(0,(stock[k]??0)+d);
  const el=document.getElementById(`sv-${k}`);
  if(el){el.textContent=stock[k];upRowCls(el,stock[k]);animNumPop(el);}
};
window.editSt=async k=>{
  const el=document.getElementById(`sv-${k}`); if(!el)return;
  const v = await showInputDialog(k.replace('_',' '), stock[k]??0);
  if(v===null)return; const n=parseInt(v);
  if(isNaN(n)||n<0){toast('Número inválido');return;}
  stock[k]=n; el.textContent=n; upRowCls(el,n); animNumPop(el);
};
function upRowCls(el,v){const r=el.closest('.stock-row');if(r)r.className=`stock-row ${v===0?'cero':v<=2?'bajo':'ok'}`;}
window.doSaveStock=async()=>{
  saveStock();
  try{ await db.collection('meta').doc('stock').set(stock); toast('Stock guardado ✓'); }
  catch(e){ toast('Guardado local ✓'); }
};

// ─── CONFIG / ZONAS FLEX — Zona 1 → Partido → Localidades ────────────────────
function parseZona(zonaStr) {
  const idx=zonaStr.indexOf(' - ');
  return {
    zonaNum: idx>=0 ? zonaStr.substring(0,idx) : zonaStr,
    partido: idx>=0 ? zonaStr.substring(idx+3) : zonaStr,
  };
}

function renderConfig() {
  const v=VIEWS.config; if (!v) return;

  // Agrupar: { "Zona 1": { importe, partidos: { "CABA": [{localidad,importe,idx}] } } }
  const gruposZona={};
  zones.forEach((z,i)=>{
    const {zonaNum,partido}=parseZona(z.zona);
    if(!gruposZona[zonaNum]) gruposZona[zonaNum]={importe:z.importe,partidos:{}};
    if(!gruposZona[zonaNum].partidos[partido]) gruposZona[zonaNum].partidos[partido]=[];
    gruposZona[zonaNum].partidos[partido].push({...z,idx:i});
  });

  // Ordenar por número de zona
  const sortedZonas=Object.entries(gruposZona).sort(([a],[b])=>{
    const na=parseInt(a.replace(/\D/g,'')), nb=parseInt(b.replace(/\D/g,''));
    return na-nb;
  });

  v.innerHTML=sortedZonas.map(([zonaNum,{importe,partidos}])=>{
    const isExpanded=expandZonas.has(zonaNum);
    const totalLocs=Object.values(partidos).reduce((s,l)=>s+l.length,0);
    const zEnc=encodeURIComponent(zonaNum);

    let body='';
    if (isExpanded) {
      body=Object.entries(partidos).map(([partido,locs])=>{
        const partKey=`${zonaNum}||${partido}`;
        const isPExpanded=expandParts.has(partKey);
        const pEnc=encodeURIComponent(partKey);
        return `<div class="config-partido">
          <div class="config-partido-hdr" onclick="togglePart('${pEnc}')">
            <span class="config-partido-name">${partido}</span>
            <span class="config-partido-n">${locs.length} localidades</span>
            <span class="zona-arrow">${isPExpanded?'▲':'▼'}</span>
          </div>
          ${isPExpanded?`<div class="config-partido-locs">
            ${locs.map(l=>`<div class="config-loc-row">
              <span>${l.localidad}</span>
              <div style="display:flex;align-items:center;gap:8px">
                <span style="font-size:12px;color:var(--text-3)">$${fmt(l.importe)}</span>
                <button class="icon-btn" onclick="editLoc(${l.idx})">✏️</button>
              </div>
            </div>`).join('')}
          </div>`:''}
        </div>`;
      }).join('');
    }

    return `<div class="card config-zona-card">
      <div class="config-zona-header" onclick="toggleZona('${zEnc}')">
        <div class="config-zona-info">
          <div class="config-zona-label">${zonaNum}</div>
          <div class="config-zona-sub">$${fmt(importe)} · ${Object.keys(partidos).length} partidos · ${totalLocs} localidades</div>
        </div>
        <div class="config-zona-right">
          <span class="config-zona-precio">$${fmt(importe)}</span>
          <button class="icon-btn" onclick="event.stopPropagation();editZonaPrice('${zEnc}',${importe})" style="font-size:16px;padding:2px 4px">✏️</button>
          <span class="zona-arrow">${isExpanded?'▲':'▼'}</span>
        </div>
      </div>
      ${isExpanded?`<div class="config-zona-body">${body}</div>`:''}
    </div>`;
  }).join('');
}

window.toggleZona = zEnc => {
  const zonaNum=decodeURIComponent(zEnc);
  expandZonas.has(zonaNum)?expandZonas.delete(zonaNum):expandZonas.add(zonaNum);
  renderConfig();
};
window.togglePart = pEnc => {
  const partKey=decodeURIComponent(pEnc);
  expandParts.has(partKey)?expandParts.delete(partKey):expandParts.add(partKey);
  renderConfig();
};
window.editZonaPrice = (zEnc, precio) => {
  const zonaNum=decodeURIComponent(zEnc);
  editZonePriceLabel=zonaNum;
  // Label muestra zonaNum (ej: "Zona 1") y precio actual
  V('ez-zona-label').textContent=`${zonaNum} — precio actual $${fmt(precio)}`;
  V('ez-zona-precio').value=precio;
  openSheet($shZoneP);
};
window.editLoc = idx => {
  editZoneIdx=idx; const z=zones[idx];
  V('ez-localidad').value=z.localidad; V('ez-importe').value=z.importe; V('ez-zona').value=z.zona;
  openSheet($shZone);
};

function setupZoneSheets() {
  document.getElementById('btn-save-precio-zona')?.addEventListener('click', async()=>{
    if (!editZonePriceLabel) return;
    const precio=parseInt(V('ez-zona-precio').value)||0;
    // Actualizar todas las localidades de la zona (match por zonaNum prefix)
    zones=zones.map(z=>{
      const {zonaNum}=parseZona(z.zona);
      return zonaNum===editZonePriceLabel ? {...z,importe:precio} : z;
    });
    saveZones();
    try{ await db.collection('meta').doc('flexZones').set({zones}); toast(`${editZonePriceLabel} actualizada ✓`); }
    catch(e){ toast('Guardado localmente ✓'); }
    closeSheet($shZoneP); renderConfig();
  });

  document.getElementById('btn-save-zone')?.addEventListener('click', async()=>{
    if(editZoneIdx===null)return;
    zones[editZoneIdx]={localidad:V('ez-localidad').value.trim(),zona:V('ez-zona').value.trim(),importe:parseInt(V('ez-importe').value)||0};
    saveZones();
    try{ await db.collection('meta').doc('flexZones').set({zones}); }catch(e){}
    closeSheet($shZone); renderConfig();
  });
}

// ─── SHEETS ───────────────────────────────────────────────────────────────────
function openSheet(sh) {
  $overlay.classList.add('open');
  sh.classList.add('open');
}
function closeSheet(sh) {
  sh.classList.remove('open');
  if (!document.querySelectorAll('.sheet.open').length) $overlay.classList.remove('open');
}
$overlay.addEventListener('click', () => {
  document.querySelectorAll('.sheet.open').forEach(s=>s.classList.remove('open'));
  $overlay.classList.remove('open');
});
document.querySelectorAll('[data-close-sheet]').forEach(b=>
  b.addEventListener('click', () => { const s=b.closest('.sheet'); if(s) closeSheet(s); })
);

// ─── TOAST ────────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg) {
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>t.classList.remove('show'),2500);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function V(id){ return document.getElementById(id); }
function fmt(n){ return Math.round(n||0).toLocaleString('es-AR'); }
function fmtDec(n){ return (n||0).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function parseNum(s){ return parseFloat(String(s).replace(/\./g,'').replace(',','.'))||0; }
function titleCase(s){ return s.replace(/\b\w/g, c => c.toUpperCase()); }
function normalizeStr(s){ return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,''); }

function haptic(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch(e) {}
}

function animCard(id, cls, btn, cb) {
  if (btn) { btn.classList.add('btn-pop'); }
  const card = document.querySelector(`.order-card[data-oid="${id}"]`);
  if (card) {
    card.classList.add(cls);
    setTimeout(cb, 270);
  } else {
    cb();
  }
}
