// ─── FIREBASE INIT ────────────────────────────────────────────────────────────
firebase.initializeApp(FIREBASE_CONFIG);
const db   = firebase.firestore();
const auth = firebase.auth();
const TS   = firebase.firestore.FieldValue.serverTimestamp;
db.enablePersistence({synchronizeTabs: false}).catch(() => {});
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
const PRODUCTOS = ['Mostaza','Total Black','Media caña','Borcegos','Caramelo','Banderas 60x90','Banderas 90x150','Remeras Colapinto'];

// Productos con talle fijo (no numérico)
const PRODUCTOS_FIJO = {
  'Banderas 60x90':  ['U'],
  'Banderas 90x150': ['U'],
  'Remeras Colapinto': ['L'],
};

const TALLES      = [38,39,40,41,42,43,44,45];
const TALLES_ESP  = [43,44,45];
const COSTO_COMUN = 21900;
const COSTO_ESP   = 22400;
const H24         = 86400000;
const LS_ORDERS   = 'fs_orders_v4';
const LS_STOCK    = 'fs_stock_v3';
const LS_ZONES    = 'fs_zones_v1';

// Stock defaults para nuevos productos (se aplican solo si no existen en Firestore)
const STOCK_DEFAULTS = {
  'Banderas 60x90_U': 5,
  'Banderas 90x150_U': 5,
  'Remeras Colapinto_L': 5,
};

// ─── STATE ────────────────────────────────────────────────────────────────────
let orders = [], stock = {}, zones = [...FLEX_ZONES];
let curView = 'pedidos', pedidosTab = 'preparar', corteCuenta = 'capi';
let editingId = null, curCuenta = 'capi', curEnvio = 'FLEX';
let curProducto = null, formItems = [], formEnvio = null;
let deliveryId = null, deliveryAction = 'edit';
let fsConectado = false, stockInitialized = false;
let editZoneIdx = null, editZonePriceLabel = null;
let multiProd = null, multiTalle = null;
let stockAll = false;
let expandZonas = new Set(), alertTimers = [], zoneHits = [];

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

// ─── ARRANQUE ─────────────────────────────────────────────────────────────────
auth.onAuthStateChanged(user => {
  if (user) {
    entrarApp(user);
  } else {
    $loginScreen.classList.remove('hidden');
    document.getElementById('btn-google-login').onclick = () => {
      const provider = new firebase.auth.GoogleAuthProvider();
      auth.signInWithPopup(provider)
        .then(r => entrarApp(r.user))
        .catch(() => {
          document.getElementById('login-error').textContent = 'Error al iniciar sesión. Intentá de nuevo.';
        });
    };
  }
});

function entrarApp(user) {
  $loginScreen.classList.add('hidden');
  $app.style.display = 'flex';
  const av = document.getElementById('user-avatar');
  if (av && user.email) av.textContent = user.email[0].toUpperCase();
  loadCache();
  renderAll();
  initUI();
  connectFirestore();
}

// ─── CACHE LOCAL ──────────────────────────────────────────────────────────────
function loadCache() {
  try { const r = localStorage.getItem(LS_ORDERS); if (r) orders = JSON.parse(r); } catch(e) { orders = []; }
  try { const r = localStorage.getItem(LS_STOCK);  if (r) stock  = JSON.parse(r); } catch(e) { stock  = {}; }
  try { const r = localStorage.getItem(LS_ZONES);  if (r) zones  = JSON.parse(r); } catch(e) { zones  = [...FLEX_ZONES]; }
}
function saveOrders() { try { localStorage.setItem(LS_ORDERS, JSON.stringify(orders)); } catch(e) {} }
function saveStock()  { try { localStorage.setItem(LS_STOCK,  JSON.stringify(stock));  } catch(e) {} }
function saveZones()  { try { localStorage.setItem(LS_ZONES,  JSON.stringify(zones));  } catch(e) {} }

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
      initNewProductStock(); // inicializar nuevos productos si faltan
      renderStock();
    }
  }, e => console.warn('stock:', e));

  db.collection('meta').doc('flexZones').onSnapshot(snap => {
    if (snap.exists) { zones = snap.data().zones; saveZones(); renderConfig(); }
  }, e => console.warn('zones:', e));
}

// Inicializar stock de nuevos productos la primera vez
function initNewProductStock() {
  if (stockInitialized) return;
  stockInitialized = true;
  const missing = {};
  Object.entries(STOCK_DEFAULTS).forEach(([k, v]) => {
    if (stock[k] === undefined) missing[k] = v;
  });
  if (!Object.keys(missing).length) return;
  Object.assign(stock, missing);
  saveStock();
  db.collection('meta').doc('stock').update(missing).catch(() => {});
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
let uiOk = false;
function initUI() {
  if (uiOk) return; uiOk = true;
  setupNav();
  setupSwipe();
  setupSheetDrag();
  setupOffline();
  setupAlerts();
  setupLocalidadSearch();
  setupFormListeners();
  setupDeliverySheet();
  setupZoneSheets();
  requestNotificationPermission();
  navigateTo('pedidos');
  setTimeout(checkAutoArchiveEnano, 1000);
}

function renderAll() {
  renderPedidos(); renderCorte(); renderStock(); renderConfig();
}

// ─── NAVEGACIÓN ───────────────────────────────────────────────────────────────
const TABS = ['pedidos','corte','stock','config'];

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
    if (prevIdx !== nextIdx) {
      const cls = nextIdx > prevIdx ? 'slide-right' : 'slide-left';
      nv.classList.add(cls);
      nv.addEventListener('animationend', () => nv.classList.remove(cls), { once:true });
    }
  }
  document.querySelector(`[data-nav="${name}"]`)?.classList.add('active');
  const T = { pedidos:'FullSports', corte:'Corte', stock:'Stock', config:'Zonas FLEX' };
  document.getElementById('topbar-title').textContent = T[name] || 'FullSports';
  // Mostrar/ocultar FAB de stock
  if ($stockFab) $stockFab.classList.toggle('visible', name === 'stock');
}
function navigateTo(name) { navInternal(name); history.pushState({ view:name }, ''); }

function setupSwipe() {
  let x0=0, y0=0;
  const mc = document.getElementById('main-content');
  mc.addEventListener('touchstart', e => { x0=e.touches[0].clientX; y0=e.touches[0].clientY; }, { passive:true });
  mc.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) < 80 || Math.abs(dy) > Math.abs(dx)/2.5) return;
    const i = TABS.indexOf(curView);
    if (dx < 0 && i < TABS.length-1) navigateTo(TABS[i+1]);
    if (dx > 0 && i > 0) navigateTo(TABS[i-1]);
  }, { passive:true });
}

function setupSheetDrag() {
  document.querySelectorAll('.sheet').forEach(sh => {
    ['sheet-handle','sheet-title'].forEach(cls => {
      const el = sh.querySelector('.'+cls); if (!el) return;
      let y0 = 0;
      el.addEventListener('touchstart', e => { y0=e.touches[0].clientY; }, { passive:true });
      el.addEventListener('touchend',   e => { if (e.changedTouches[0].clientY - y0 > 60) closeSheet(sh); }, { passive:true });
    });
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

async function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default')
    await Notification.requestPermission().catch(() => {});
}

// ─── ALERTAS ──────────────────────────────────────────────────────────────────
function dispTarget(tipo) {
  const t = new Date(); t.setHours(tipo==='FLEX'?13:14,0,0,0);
  if (t <= new Date()) t.setDate(t.getDate()+1);
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
    {h:12,m:30,t:'warning',msg:'⏰ 30 min para despachar FLEX'},
    {h:12,m:50,t:'urgent', msg:'🚨 10 min para despachar FLEX'},
    {h:13,m:30,t:'warning',msg:'⏰ 30 min para despachar PE'},
    {h:13,m:50,t:'urgent', msg:'🚨 10 min para despachar PE'},
  ].forEach(({h,m,t,msg}) => {
    const d=new Date(now); d.setHours(h,m,0,0);
    const diff=d-now; if (diff>0) alertTimers.push(setTimeout(()=>showAlert(t,msg),diff));
  });
  setInterval(updateCountdowns, 30000);
}
function showAlert(type,msg) {
  $alert.className=`alert-banner show ${type}`; $alert.textContent=msg;
  setTimeout(()=>$alert.classList.remove('show'),8000);
  if (typeof Notification !== 'undefined' && Notification.permission==='granted')
    new Notification('FullSports',{body:msg});
}
function updateCountdowns() {
  document.querySelectorAll('[data-cd]').forEach(el => {
    const diff=dispTarget(el.dataset.cd)-new Date(), min=Math.floor(diff/60000);
    el.textContent=fmtDiff(diff);
    el.className='countdown'+(min<=15?' urgent':min<=60?' warn':'');
  });
}

// ─── PEDIDOS VIEW ─────────────────────────────────────────────────────────────
const SPRI = {preparar:0,pendiente:1,camino:2,entregado:3};

function renderPedidos() {
  const v = VIEWS.pedidos; if (!v) return;

  const preparar  = orders.filter(o=>o.status==='preparar');
  const pendiente = orders.filter(o=>o.status==='pendiente');
  const camino    = orders.filter(o=>o.status==='camino');
  const entregados= orders.filter(o=>o.status==='entregado' && Date.now()-ms(o.deliveredAt)<H24);

  const nPrep=preparar.length;
  const nDesp=pendiente.length+camino.length;
  const nEntr=entregados.length;
  const nFlex=pendiente.filter(o=>o.tipoEnvio==='FLEX').length;
  const nPE  =pendiente.filter(o=>o.tipoEnvio==='PE').length;

  let body='';
  if (pedidosTab==='preparar') {
    const sorted=[...preparar].sort((a,b)=>(a.tipoEnvio==='FLEX'?0:10)-(b.tipoEnvio==='FLEX'?0:10));
    const bar=`<div class="home-bar">
      ${nFlex?`<button class="dispatch-btn flex-btn" onclick="despacharTodos('FLEX')">🚚 Despachar FLEX (${nFlex})</button>`:''}
      ${nPE  ?`<button class="dispatch-btn pe-btn" onclick="despacharTodos('PE')">📦 Despachar PE (${nPE})</button>`:''}
      <button class="btn-dep" id="btn-dep" onclick="toggleDep()">🏪 Depósito</button>
    </div>
    <div id="dep-box" style="display:none" class="dep-box"></div>`;
    body = bar + (sorted.length
      ? `<div class="ped-body">${sorted.map(orderCard).join('')}</div>`
      : `<div class="empty-state"><span>✅</span><p>Sin pedidos por preparar</p></div>`);

  } else if (pedidosTab==='despacho') {
    const sorted=[...pendiente,...camino].sort((a,b)=>{
      const sp=SPRI[a.status]-SPRI[b.status]; if(sp!==0) return sp;
      if(a.status==='camino'&&b.status==='camino') return parseLocalDate(a.fechaEstimada)-parseLocalDate(b.fechaEstimada);
      return 0;
    });
    body = sorted.length
      ? `<div class="ped-body">${sorted.map(orderCard).join('')}</div>`
      : `<div class="empty-state"><span>📦</span><p>Sin pedidos en camino</p></div>`;

  } else {
    const sorted=[...entregados].sort((a,b)=>ms(b.deliveredAt)-ms(a.deliveredAt));
    body = sorted.length
      ? `<div class="ped-body">${sorted.map(orderCard).join('')}</div>`
      : `<div class="empty-state"><span>📭</span><p>Sin entregados en las últimas 24hs</p></div>`;
  }

  v.innerHTML=`
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
    </div>
    ${body}`;
  updateCountdowns();
}
window.setTab = t => { pedidosTab=t; renderPedidos(); };

function parseLocalDate(s) {
  if (!s) return Infinity;
  const p=s.split('/'); if (p.length!==3) return Infinity;
  return new Date(p[2],p[1]-1,p[0]).getTime();
}

// Depósito inline
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
  const lines=calcDep(), nP=orders.filter(o=>o.status==='preparar').length;
  box.innerHTML = !lines.length
    ? `<p class="hint-text">Sin pedidos para preparar</p>`
    : `<div class="dep-hdr">${lines.reduce((a,l)=>a+l.qty,0)} pares · ${nP} pedido${nP!==1?'s':''}</div>
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
    fechaLine=`<div class="order-fecha">📅 Entrega estimada: <b>${o.fechaEstimada}</b> <button class="btn-link" onclick="openDelivery('${o.id}','edit')">✏️</button></div>`;
    if (o.cuenta==='enano'&&ms(o.despachadoAt)>0) {
      const elapsed=Math.min(1,(Date.now()-ms(o.despachadoAt))/H24);
      fechaLine+=`<div class="transit-bar"><div class="transit-bar-fill" style="width:${Math.round(elapsed*100)}%"></div></div>`;
    }
  }

  let act='';
  if (o.status==='preparar') act=`<div class="card-act">
    <button class="btn btn-green btn-sm" onclick="acPreparado('${o.id}')">✓ Preparado</button>
    <button class="btn btn-ghost btn-sm" onclick="acEditar('${o.id}')">✏️ Editar</button>
    <button class="btn btn-danger btn-sm" onclick="acEliminar('${o.id}')">🗑</button>
  </div>`;
  else if (o.status==='pendiente') act=`<div class="card-act">
    <button class="btn btn-primary btn-sm" onclick="acDespachado('${o.id}')">🚚 Despachar</button>
    <button class="btn btn-ghost btn-sm" onclick="acEditar('${o.id}')">✏️</button>
    <button class="btn btn-danger btn-sm" onclick="acEliminar('${o.id}')">🗑</button>
  </div>`;
  else if (o.status==='camino') act=`<div class="card-act">
    <button class="btn btn-green btn-sm" onclick="acEntregado('${o.id}')">✓ Entregado</button>
    <button class="btn btn-ghost btn-sm" onclick="acEditar('${o.id}')">✏️</button>
  </div>`;
  else if (o.status==='entregado') act=`<div class="card-ok">✓ Entregado${o.fechaEntrega?' el '+o.fechaEntrega:''}</div>`;

  return `<div class="order-card${['preparar','pendiente'].includes(o.status)&&o.tipoEnvio==='FLEX'?' flex-active':''}">
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
  if (t==='U') return 'Único';
  return isNaN(parseInt(t)) ? String(t) : `T${t}`;
}

// ─── ACCIONES ─────────────────────────────────────────────────────────────────
window.acPreparado = async id => {
  const o=orders.find(o=>o.id===id); if (!o) return;
  mutateOrder(id,{status:'pendiente'});
  pedidosTab='despacho'; renderPedidos(); renderCorte();
  try {
    await db.collection('orders').doc(id).update({status:'pendiente'});
    if (o.items) {
      const ns={...stock};
      o.items.forEach(i=>{const k=`${i.producto}_${i.talle}`;ns[k]=Math.max(0,(ns[k]||0)-1);});
      stock=ns; saveStock();
      await db.collection('meta').doc('stock').set(ns);
    }
  } catch(e){toast('Sin red — se sincronizará');}
};

window.acDespachado = async id => {
  const o=orders.find(o=>o.id===id); if (!o) return;
  if (o.cuenta==='capi') { openDelivery(id,'dispatch'); return; }
  const fecha=proximoDia();
  mutateOrder(id,{status:'camino',fechaEstimada:fecha,despachadoAt:Date.now()});
  renderPedidos();
  try { await db.collection('orders').doc(id).update({status:'camino',despachadoAt:TS(),fechaEstimada:fecha}); }
  catch(e){toast('Sin red');}
};

window.despacharTodos = async tipo => {
  const pend=orders.filter(o=>o.status==='pendiente'&&o.tipoEnvio===tipo);
  if (!pend.length) return;
  if (!confirm(`¿Despachar ${pend.length} pedido${pend.length>1?'s':''} ${tipo}?`)) return;
  const fecha=proximoDia();
  pend.forEach(o=>mutateOrder(o.id,{status:'camino',fechaEstimada:fecha,despachadoAt:Date.now()}));
  pedidosTab='despacho'; renderPedidos(); renderCorte();
  try {
    for(const o of pend)
      await db.collection('orders').doc(o.id).update({status:'camino',despachadoAt:TS(),fechaEstimada:fecha});
    toast(`${pend.length} pedidos ${tipo} despachados ✓`);
  } catch(e){toast('Sin red');}
};

window.acEntregado = async id => {
  const f=new Date().toLocaleDateString('es-AR');
  mutateOrder(id,{status:'entregado',fechaEntrega:f,deliveredAt:Date.now()});
  renderPedidos(); renderCorte();
  try { await db.collection('orders').doc(id).update({status:'entregado',deliveredAt:TS(),fechaEntrega:f}); }
  catch(e){toast('Sin red');}
};

window.acEliminar = async id => {
  if (!confirm('¿Eliminar este pedido?')) return;
  orders=orders.filter(o=>o.id!==id); saveOrders(); renderPedidos(); renderCorte();
  try { await db.collection('orders').doc(id).delete(); } catch(e){toast('Sin red');}
};

window.acEditar = id => { const o=orders.find(o=>o.id===id); if(o) openNuevaSheet(o); };

function mutateOrder(id,patch) {
  const i=orders.findIndex(o=>o.id===id);
  if (i>=0) { orders[i]={...orders[i],...patch}; saveOrders(); }
}
function proximoDia() {
  const d=new Date(); d.setDate(d.getDate()+1);
  return d.toLocaleDateString('es-AR');
}

// ─── DELIVERY SHEET ───────────────────────────────────────────────────────────
function setupDeliverySheet() {
  document.getElementById('btn-save-delivery')?.addEventListener('click', async () => {
    const val=document.getElementById('delivery-date-input').value;
    if (!val||!deliveryId) { closeSheet($shDeliv); return; }
    const fechaStr=inputToDate(val);
    if (deliveryAction==='dispatch') {
      mutateOrder(deliveryId,{status:'camino',fechaEstimada:fechaStr,despachadoAt:Date.now()});
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
  if (titleEl) titleEl.textContent=action==='dispatch'?'Fecha estimada de entrega (CAPI)':'Editar fecha estimada';
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
  editingId=data?.id||null; formItems=data?.items?[...data.items]:[]; formEnvio=null; curProducto=null; stockAll=false;
  $shNueva.querySelector('.sheet-title').textContent=editingId?'Editar pedido':'Nueva venta';
  setCuenta(data?.cuenta||'capi');
  setEnvio(data?.tipoEnvio||'FLEX');
  V('f-nombre').value=data?.nombreComprador||'';
  V('f-provincia').value=data?.provincia||'';
  V('f-iibb').value=data?.iibb?fmtDec(data.iibb):'';
  V('f-importe-pe').value=data?.importeAcreditado||'';
  V('f-importe-flex').value=data?.importeVenta||'';
  V('btn-stock-override').textContent='✏️ Manual';
  if (data?.tipoEnvio==='FLEX'&&data.flexLocalidad) {
    formEnvio={localidad:data.flexLocalidad,zona:data.flexZona,importe:data.flexImporte};
    showZoneSelected();
  } else clearZone();
  renderProdBtns();
  V('talle-wrap').style.display='none';
  V('btn-add-otro').style.display='none';
  V('btn-multi').style.display='none';
  V('multi-wrap').style.display='none';
  renderFormItems();
  openSheet($shNueva);
  setTimeout(()=>$shNueva.querySelector('.sheet-body').scrollTop=0,50);
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
  V('btn-stock-override').addEventListener('click',()=>{
    stockAll=!stockAll;
    V('btn-stock-override').textContent=stockAll?'✏️ Todo':'✏️ Manual';
    curProducto=null; renderProdBtns(); V('talle-wrap').style.display='none';
  });
  V('btn-add-otro').addEventListener('click',()=>{
    renderProdBtns(); V('talle-wrap').style.display='none'; curProducto=null;
    V('btn-add-otro').style.display='none'; V('btn-multi').style.display='none';
    V('item-selector-wrap').scrollIntoView({behavior:'smooth',block:'start'});
  });
  V('btn-multi').addEventListener('click',()=>{
    multiProd=null; multiTalle=null;
    renderMultiProd();
    V('multi-talle-wrap').style.display='none';
    V('multi-cant-wrap').style.display='none';
    V('multi-wrap').style.display='block';
    V('multi-wrap').scrollIntoView({behavior:'smooth',block:'start'});
  });
  V('btn-guardar-venta').addEventListener('click', guardarVenta);
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
    const q=inp.value.toLowerCase().trim();
    if (!q) { res.classList.remove('show'); zoneHits=[]; return; }
    zoneHits=zones.filter(z=>z.localidad.toLowerCase().includes(q)).slice(0,8);
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
  document.getElementById('btn-clear-zone')?.addEventListener('click',clearZone);
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
  const fixed = PRODUCTOS_FIJO[p];
  if (fixed) return fixed;
  return TALLES.filter(t => stockAll || (stock[`${p}_${t}`] ?? 0) > 0);
}

function renderProdBtns() {
  const disp=PRODUCTOS.filter(p=>{
    if (stockAll) return true;
    return getProductTalles(p).length > 0;
  });
  const c=V('producto-btns'); if (!c) return;
  c.innerHTML=disp.length
    ?disp.map(p=>`<button class="producto-btn" onclick="selProd('${p.replace(/'/g,"\\'")}')">${p}</button>`).join('')
    :`<p class="hint-text">Sin stock — activá ✏️ Manual</p>`;
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
  // Auto-seleccionar si solo hay un talle posible
  if (talles.length===1) selTalle(talles[0]);
};

// Auto-agregar al tocar talle (sin botón "Agregar")
window.selTalle = t => {
  if (!curProducto) return;
  formItems.push({producto:curProducto, talle:t});
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

window.editItemQty = kEnc => {
  const k=decodeURIComponent(kEnc);
  const [producto,talleStr]=k.split('||');
  const talle=isNaN(parseInt(talleStr))?talleStr:parseInt(talleStr);
  const current=formItems.filter(i=>i.producto===producto&&String(i.talle)===talleStr).length;
  const v=prompt(`Cantidad — ${producto} ${displayTalle(talle)}:`,current);
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

// ─── MULTI PANEL (agregar otro modelo) ───────────────────────────────────────
function renderMultiProd() {
  const disp=PRODUCTOS.filter(p=>stockAll||getProductTalles(p).length>0);
  V('multi-producto-btns').innerHTML=disp.map(p=>`<button class="producto-btn" onclick="mSelProd('${p.replace(/'/g,"\\'")}')">${p}</button>`).join('');
}
window.mSelProd = p => {
  multiProd=p; multiTalle=null;
  document.querySelectorAll('#multi-producto-btns .producto-btn').forEach(b=>b.classList.toggle('active',b.textContent.trim()===p));
  const talles=getProductTalles(p);
  V('multi-talle-btns').innerHTML=talles.map(t=>{
    const js=typeof t==='string'?`'${t}'`:t;
    return `<button class="talle-btn" onclick="mSelTalle(${js})">${displayTalle(t)}</button>`;
  }).join('');
  V('multi-talle-wrap').style.display='flex';
  V('multi-cant-wrap').style.display='none';
  if (talles.length===1) mSelTalle(talles[0]);
};
window.mSelTalle = t => {
  if (!multiProd) return;
  formItems.push({producto:multiProd,talle:t});
  renderFormItems();
  multiProd=null; multiTalle=null;
  V('multi-wrap').style.display='none';
  V('multi-talle-wrap').style.display='none';
  V('btn-add-otro').style.display='flex';
  V('btn-multi').style.display='flex';
  toast('Ítem agregado ✓');
};

// ─── GUARDAR VENTA ────────────────────────────────────────────────────────────
async function guardarVenta() {
  const nombre=V('f-nombre').value.trim();
  if (!nombre)           { toast('Ingresá el nombre'); return; }
  if (!formItems.length) { toast('Agregá al menos un ítem'); return; }
  if (!editingId) {
    const dups=orders.filter(o=>o.nombreComprador.toLowerCase()===nombre.toLowerCase()&&o.status!=='entregado');
    if (dups.length&&!confirm(`Ya hay un pedido de "${nombre}". ¿Continuar?`)) return;
  }
  const base={
    cuenta:curCuenta, nombreComprador:nombre, tipoEnvio:curEnvio, items:formItems,
    status:editingId?(orders.find(o=>o.id===editingId)?.status||'preparar'):'preparar',
    corteDone:editingId?(orders.find(o=>o.id===editingId)?.corteDone||false):false,
  };
  if (curCuenta==='enano') { base.provincia=V('f-provincia').value.trim(); base.iibb=parseNum(V('f-iibb').value)||0; }
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
  } catch(e){ toast('Error al guardar: '+e.message); }
}

// ─── CORTE VIEW ───────────────────────────────────────────────────────────────
function renderCorte() {
  const v=VIEWS.corte; if (!v) return;
  const nC=orders.filter(o=>!o.corteDone&&o.cuenta==='capi').length;
  const nE=orders.filter(o=>!o.corteDone&&o.cuenta==='enano').length;
  const nP=orders.filter(o=>o.status==='preparar').length;
  v.innerHTML=`
    <div class="corte-tabs">
      <button class="corte-tab${corteCuenta==='capi'?' active':''}" onclick="setCorte('capi')">CAPI <span class="corte-count">${nC}</span></button>
      <button class="corte-tab${corteCuenta==='enano'?' active':''}" onclick="setCorte('enano')">ENANO <span class="corte-count">${nE}</span></button>
      <button class="corte-tab${corteCuenta==='deposito'?' active':''}" onclick="setCorte('deposito')">Depósito${nP?` <span class="corte-count">${nP}</span>`:''}</button>
    </div>
    ${renderCorteBody()}`;
}
window.setCorte = c => { corteCuenta=c; renderCorte(); };

function renderCorteBody() {
  if (corteCuenta==='deposito') return renderDepCorte();
  const pend=orders.filter(o=>!o.corteDone&&o.cuenta===corteCuenta);
  if (!pend.length) return `<div class="empty-state"><span>✂️</span><p>Sin ventas pendientes de corte para ${corteCuenta.toUpperCase()}</p></div>`;
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
      <div class="dep-hdr" style="margin-bottom:6px">Stock restante</div>
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
    const m=o.tipoEnvio==='FLEX'&&o.importeVenta?`se acredito $${fmt(o.importeNeto)}`:`se acredito $${fmt(o.importeAcreditado)}`;
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

// ─── STOCK VIEW ───────────────────────────────────────────────────────────────
function renderStock() {
  const v=VIEWS.stock; if (!v) return;

  const cardsHtml = PRODUCTOS.map(p => {
    const talles = PRODUCTOS_FIJO[p] ? PRODUCTOS_FIJO[p] : TALLES;
    const conStock = talles.filter(t=>(stock[`${p}_${t}`]??0)>0);
    const sinStock = talles.filter(t=>(stock[`${p}_${t}`]??0)===0);
    const pEnc = encodeURIComponent(p);

    const activeRows = conStock.map(t=>renderStockRow(p,t)).join('');
    const zeroRows   = sinStock.map(t=>renderStockRow(p,t)).join('');
    const zeroSection = sinStock.length ? `
      <button class="zero-toggle btn-link" onclick="toggleZeroStock('${pEnc}')">▼ Sin stock (${sinStock.length})</button>
      <div id="zero-${pEnc}" class="zero-section" style="display:none">${zeroRows}</div>
    ` : '';

    return `<div class="card stock-product-card">
      <div class="stock-product-name">${p}</div>
      ${activeRows || `<div class="hint-text" style="padding:6px 0;color:var(--red)">Sin stock disponible</div>`}
      ${zeroSection}
    </div>`;
  }).join('');

  v.innerHTML = cardsHtml;
}

function renderStockRow(p, t) {
  const k=`${p}_${t}`, val=stock[k]??0, cls=val===0?'cero':val<=2?'bajo':'ok';
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

window.toggleZeroStock = pEnc => {
  const div = document.getElementById(`zero-${pEnc}`); if (!div) return;
  const btn = div.previousElementSibling;
  const show = div.style.display === 'none';
  div.style.display = show ? 'block' : 'none';
  if (btn) btn.textContent = show ? '▲ Ocultar agotados' : `▼ Sin stock (${div.querySelectorAll('.stock-row').length})`;
};

window.adjSt=(k,d)=>{
  stock[k]=Math.max(0,(stock[k]??0)+d);
  const el=document.getElementById(`sv-${k}`);
  if(el){el.textContent=stock[k];upRowCls(el,stock[k]);}
};
window.editSt=k=>{
  const el=document.getElementById(`sv-${k}`); if(!el)return;
  const v=prompt(`Cantidad para ${k.replace('_',' ')}:`,stock[k]??0);
  if(v===null)return; const n=parseInt(v);
  if(isNaN(n)||n<0){toast('Número inválido');return;}
  stock[k]=n; el.textContent=n; upRowCls(el,n);
};
function upRowCls(el,v){const r=el.closest('.stock-row');if(r)r.className=`stock-row ${v===0?'cero':v<=2?'bajo':'ok'}`;}
window.doSaveStock = async ()=>{
  saveStock();
  try{ await db.collection('meta').doc('stock').set(stock); toast('Stock guardado ✓'); }
  catch(e){ toast('Guardado local ✓'); }
};

// ─── CONFIG / ZONAS FLEX ──────────────────────────────────────────────────────
function renderConfig() {
  const v=VIEWS.config; if (!v) return;
  const grupos={};
  zones.forEach((z,i)=>{
    if(!grupos[z.zona])grupos[z.zona]=[];
    grupos[z.zona].push({...z,idx:i});
  });
  v.innerHTML=`
    <div class="section-title">Zonas FLEX</div>
    <div class="config-zona-list">
    ${Object.entries(grupos).map(([zona,locs])=>`
      <div class="card">
        <div class="config-zona-header" onclick="toggleZona('${zona.replace(/'/g,"\\'")}')">
          <div class="config-zona-info">
            <div class="config-zona-label">${zona}</div>
            <div class="config-zona-sub">$${fmt(locs[0].importe)} · ${locs.length} localidades</div>
          </div>
          <div class="config-zona-right">
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();editZonaPrice('${zona.replace(/'/g,"\\'")}',${locs[0].importe})">✏️ Precio</button>
            <span class="zona-arrow">${expandZonas.has(zona)?'▲':'▼'}</span>
          </div>
        </div>
        ${expandZonas.has(zona)?`
        <div class="config-zona-body">
          ${locs.map(l=>`
            <div class="config-partido-hdr">
              <span>${l.localidad}</span>
              <div style="display:flex;align-items:center;gap:8px">
                <span style="font-size:12px;color:var(--text-3)">$${fmt(l.importe)}</span>
                <button class="btn btn-ghost btn-sm" onclick="editLoc(${l.idx})">✏️</button>
              </div>
            </div>`).join('')}
        </div>`:''}
      </div>`).join('')}
    </div>`;
}
window.toggleZona = z=>{expandZonas.has(z)?expandZonas.delete(z):expandZonas.add(z);renderConfig();};
window.editZonaPrice = (zona,precio)=>{
  editZonePriceLabel=zona;
  V('ez-zona-label').textContent=zona;
  V('ez-zona-precio').value=precio;
  openSheet($shZoneP);
};
window.editLoc = idx=>{
  editZoneIdx=idx; const z=zones[idx];
  V('ez-localidad').value=z.localidad; V('ez-importe').value=z.importe; V('ez-zona').value=z.zona;
  openSheet($shZone);
};

function setupZoneSheets() {
  document.getElementById('btn-save-precio-zona')?.addEventListener('click', async()=>{
    if (!editZonePriceLabel) return;
    const precio=parseInt(V('ez-zona-precio').value)||0;
    zones=zones.map(z=>z.zona===editZonePriceLabel?{...z,importe:precio}:z);
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
function openSheet(sh){ $overlay.classList.add('open'); sh.classList.add('open'); }
function closeSheet(sh){
  sh.classList.remove('open');
  if(!document.querySelectorAll('.sheet.open').length) $overlay.classList.remove('open');
}
$overlay.addEventListener('click',()=>{
  document.querySelectorAll('.sheet.open').forEach(s=>s.classList.remove('open'));
  $overlay.classList.remove('open');
});
document.querySelectorAll('[data-close-sheet]').forEach(b=>
  b.addEventListener('click',()=>{ const s=b.closest('.sheet'); if(s) closeSheet(s); })
);

// ─── TOAST ────────────────────────────────────────────────────────────────────
function toast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2500);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function V(id){ return document.getElementById(id); }
function fmt(n){ return Math.round(n||0).toLocaleString('es-AR'); }
function fmtDec(n){ return (n||0).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function parseNum(s){ return parseFloat(String(s).replace(/\./g,'').replace(',','.'))||0; }
