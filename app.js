/* ==========================================================================
   KJ CONCEPT — app.js
   Vanilla JS ES6+. No frameworks. Datos guardados en Supabase (nube),
   con una caché en memoria para que el resto de la app siga siendo síncrona.
   Modules: Supa, Auth, Utils, Store, Calc, Toast, Modal, Charts, Views, Nav, Export, App
   ========================================================================== */
'use strict';

/* ---------------------------------------------------------------------- */
/* SUPABASE — configuración del proyecto                                  */
/* Reemplaza estos dos valores con los de tu proyecto:                    */
/* Supabase → Project Settings → Data API → Project URL / anon public key */
/* ---------------------------------------------------------------------- */
const SUPABASE_URL = 'https://aisrrpzshxcwxojjpggy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_-nYtE7_EEzgBETC9vdiDnw_X5XkIuAF';

const supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ---------------------------------------------------------------------- */
/* AUTH — inicio de sesión compartido (varias personas, mismos datos)     */
/* ---------------------------------------------------------------------- */
const Auth = {
  session: null,

  async init(){
    const { data } = await supa.auth.getSession();
    this.session = data.session;
    supa.auth.onAuthStateChange((_event, session)=>{
      this.session = session;
      if(!session) this.showLogin();
    });
    if(!this.session) await this.waitForLogin();
  },

  waitForLogin(){
    return new Promise(resolve=>{
      this.showLogin();
      const form = document.getElementById('loginForm');
      const errEl = document.getElementById('loginError');
      form.onsubmit = async (e)=>{
        e.preventDefault();
        errEl.textContent = '';
        const email = document.getElementById('loginEmail').value.trim();
        const password = document.getElementById('loginPassword').value;
        const btn = document.getElementById('loginSubmit');
        btn.disabled = true; btn.textContent = 'Ingresando…';
        const { data, error } = await supa.auth.signInWithPassword({ email, password });
        btn.disabled = false; btn.textContent = 'Ingresar';
        if(error){ errEl.textContent = 'Correo o contraseña incorrectos.'; return; }
        this.session = data.session;
        this.hideLogin();
        resolve();
      };
    });
  },

  showLogin(){ document.getElementById('loginOverlay').style.display = 'flex'; },
  hideLogin(){ document.getElementById('loginOverlay').style.display = 'none'; },

  async logout(){
    await supa.auth.signOut();
    location.reload();
  }
};

/* ---------------------------------------------------------------------- */
/* UTILS                                                                   */
/* ---------------------------------------------------------------------- */
const Utils = {
  uid(){ return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8); },
  todayISO(){ return new Date().toISOString().slice(0,10); },
  monthKey(dateStr){ return (dateStr||'').slice(0,7); }, // YYYY-MM
  currentMonthKey(){ return Utils.todayISO().slice(0,7); },
  money(n){
    const cfg = Store.getConfig();
    const val = Number(n)||0;
    return `${cfg.moneda} ${val.toLocaleString('es-PE', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
  },
  num(n, dec=2){ return (Number(n)||0).toLocaleString('es-PE', {minimumFractionDigits:dec, maximumFractionDigits:dec}); },
  pct(n){ return `${(Number(n)||0).toFixed(0)}%`; },
  formatDate(d){
    if(!d) return '—';
    const dt = new Date(d + 'T00:00:00');
    if(isNaN(dt)) return d;
    return dt.toLocaleDateString('es-PE', {day:'2-digit', month:'short', year:'numeric'});
  },
  monthLabel(key){
    const [y,m] = key.split('-');
    const dt = new Date(Number(y), Number(m)-1, 1);
    return dt.toLocaleDateString('es-PE', {month:'short', year:'2-digit'});
  },
  last6Months(){
    const arr = [];
    const now = new Date();
    for(let i=5;i>=0;i--){
      const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
      arr.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
    }
    return arr;
  },
  debounce(fn, ms=250){
    let t;
    return (...args)=>{ clearTimeout(t); t = setTimeout(()=>fn(...args), ms); };
  },
  escapeHtml(str){
    return String(str??'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  },
  // Normaliza texto para comparar nombres de materiales de forma confiable:
  // quita espacios extra, tildes/acentos y diferencias de mayúsculas/minúsculas.
  normalizeText(str){
    return String(str??'')
      .trim()
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // quita tildes (á->a, ñ se mantiene con excepción abajo)
      .replace(/\s+/g,' '); // colapsa espacios múltiples/tabs/saltos de línea a uno solo
  },
  // Busca un material en el inventario que "es el mismo" aunque el texto no sea idéntico
  findMaterial(inv, nombre){
    const target = this.normalizeText(nombre);
    return inv.find(m => this.normalizeText(m.nombre) === target);
  }
};

/* ---------------------------------------------------------------------- */
/* STORE — LocalStorage persistence layer                                 */
/* ---------------------------------------------------------------------- */
const KEYS = {
  inventario: 'kj_inventario',
  compras: 'kj_compras',
  ventas: 'kj_ventas',
  gastos: 'kj_gastos',
  mermas: 'kj_mermas',
  config: 'kj_configuracion'
};

const Store = {
  _cache: {},      // espejo en memoria de lo que hay en Supabase (para leer síncrono)
  _channel: null,  // canal de Realtime

  // Carga inicial: trae todas las filas desde Supabase antes de que la app arranque.
  async init(){
    const { data, error } = await supa.from('app_data').select('key,value');
    if(error){
      console.error('Store init error', error);
      Toast.show('error','No se pudo conectar con la base de datos.');
    }
    this._cache = {};
    (data||[]).forEach(row => { this._cache[row.key] = row.value; });
    this.ensureDefaults();
    this._subscribeRealtime();
  },

  // Escucha cambios hechos desde OTRO dispositivo/usuario y refresca la vista actual.
  _subscribeRealtime(){
    if(this._channel) return;
    this._channel = supa.channel('app_data_sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'app_data' }, (payload)=>{
        const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
        if(!row) return;
        if(payload.eventType === 'DELETE') delete this._cache[row.key];
        else this._cache[row.key] = row.value;
        if(window.App){ App.renderCurrentView(); App.refreshBadges(); }
      })
      .subscribe();
  },

  _read(key, fallback){
    const v = this._cache[key];
    return v !== undefined ? v : fallback;
  },
  _write(key, value){
    this._cache[key] = value; // se refleja al toque en la UI de este dispositivo
    supa.from('app_data')
      .upsert({ key, value, updated_at: new Date().toISOString() })
      .then(({ error })=>{
        if(error){ console.error('Store write error', key, error); Toast.show('error','No se pudo guardar en la nube. Revisa tu conexión.'); }
      });
    return true;
  },

  ensureDefaults(){
    if(this._cache[KEYS.config] === undefined){
      this._write(KEYS.config, {
        nombreNegocio: 'KJ Concept',
        moneda: 'S/.',
        tema: 'light',
        categorias: ['Vinil','Papel Fotográfico','Imantado','Laminado','Empaque','Otros'],
        unidades: ['hojas','m','unid.','kg','rollo'],
        stockMinimoDefault: 10,
        capitalInicial: 0,
        precioHoraHombre: 8,
        precioImpresionHoja: 0.5,
        precioCorte: 0.3,
        comisionVendedoraPct: 10,
        precioEmpaqueBolsa: 0.5,
        precioEmpaqueCaja: 1
      });
    }
    if(this._cache[KEYS.inventario] === undefined) this._write(KEYS.inventario, []);
    if(this._cache[KEYS.compras] === undefined) this._write(KEYS.compras, []);
    if(this._cache[KEYS.ventas] === undefined) this._write(KEYS.ventas, []);
    if(this._cache[KEYS.gastos] === undefined) this._write(KEYS.gastos, []);
    if(this._cache[KEYS.mermas] === undefined) this._write(KEYS.mermas, []);
    this.migrateConfig();
  },

  // Si ya existe una configuración guardada de una versión anterior (sin los
  // campos nuevos de hora hombre / impresión / corte), les asigna el valor
  // estándar sin tocar el resto de lo que el usuario ya configuró.
  migrateConfig(){
    const cfg = this.getConfig();
    const defaults = { precioHoraHombre: 8, precioImpresionHoja: 0.5, precioCorte: 0.3, comisionVendedoraPct: 10, precioEmpaqueBolsa: 0.5, precioEmpaqueCaja: 1 };
    let changed = false;
    Object.keys(defaults).forEach(key=>{
      if(cfg[key] === undefined || cfg[key] === null){ cfg[key] = defaults[key]; changed = true; }
    });
    if(changed) this._write(KEYS.config, cfg);
  },

  getConfig(){ return this._read(KEYS.config, {}); },
  setConfig(cfg){ return this._write(KEYS.config, cfg); },

  getInventario(){ return this._read(KEYS.inventario, []); },
  setInventario(arr){ return this._write(KEYS.inventario, arr); },

  getCompras(){ return this._read(KEYS.compras, []); },
  setCompras(arr){ return this._write(KEYS.compras, arr); },

  getVentas(){ return this._read(KEYS.ventas, []); },
  setVentas(arr){ return this._write(KEYS.ventas, arr); },

  getGastos(){ return this._read(KEYS.gastos, []); },
  setGastos(arr){ return this._write(KEYS.gastos, arr); },

  getMermas(){ return this._read(KEYS.mermas, []); },
  setMermas(arr){ return this._write(KEYS.mermas, arr); },

  async resetAll(){
    const keys = Object.values(KEYS);
    this._cache = {};
    const { error } = await supa.from('app_data').delete().in('key', keys);
    if(error){ console.error('resetAll error', error); Toast.show('error','No se pudo restablecer en la nube.'); }
    this.ensureDefaults();
  },

  backupJSON(){
    return {
      exportadoEn: new Date().toISOString(),
      configuracion: this.getConfig(),
      inventario: this.getInventario(),
      compras: this.getCompras(),
      ventas: this.getVentas(),
      gastos: this.getGastos(),
      mermas: this.getMermas()
    };
  },
  restoreJSON(data){
    if(!data || typeof data !== 'object') throw new Error('Archivo inválido');
    if(data.configuracion) this.setConfig(data.configuracion);
    if(Array.isArray(data.inventario)) this.setInventario(data.inventario);
    if(Array.isArray(data.compras)) this.setCompras(data.compras);
    if(Array.isArray(data.ventas)) this.setVentas(data.ventas);
    if(Array.isArray(data.gastos)) this.setGastos(data.gastos);
    if(Array.isArray(data.mermas)) this.setMermas(data.mermas);
  }
};

/* ---------------------------------------------------------------------- */
/* CALC — all derived business metrics (never store computed values)      */
/* ---------------------------------------------------------------------- */
const Calc = {
  // Filtra un arreglo por mes (YYYY-MM) usando su campo `fecha`. Sin mesKey, no filtra (histórico completo).
  _byMonth(arr, mesKey){ return mesKey ? arr.filter(x => Utils.monthKey(x.fecha) === mesKey) : arr; },

  inversionTotal(mesKey){ return this._byMonth(Store.getCompras(), mesKey).reduce((s,c)=>s+Number(c.precioTotal||0),0); },
  valorInventarioActual(){ return Store.getInventario().reduce((s,m)=>s+ (Number(m.cantidad||0) * Number(m.costoPromedio||0)),0); },
  materialConsumido(mesKey){ return this._byMonth(Store.getVentas(), mesKey).reduce((s,v)=>s+Number(v.costoTotalMateriales||0),0); },
  // Costo de mano de obra + impresión + corte de los trabajos (todo el histórico o del mes indicado)
  costoProduccionExtra(mesKey){ return this._byMonth(Store.getVentas(), mesKey).reduce((s,v)=>s+Number(v.costoManoObra||0)+Number(v.costoImpresion||0)+Number(v.costoCorte||0),0); },
  // Solo mano de obra (lo que le corresponde al diseñador) — separado de impresión/corte a propósito
  manoObraTotal(mesKey){ return this._byMonth(Store.getVentas(), mesKey).reduce((s,v)=>s+Number(v.costoManoObra||0),0); },
  // Solo impresión + corte (desgaste/insumos de impresora y máquina de corte)
  impresionCorteTotal(mesKey){ return this._byMonth(Store.getVentas(), mesKey).reduce((s,v)=>s+Number(v.costoImpresion||0)+Number(v.costoCorte||0),0); },
  // Valor del material perdido/dañado (merma), separado de los gastos generales del negocio
  mermaTotal(mesKey){ return this._byMonth(Store.getMermas(), mesKey).reduce((s,m)=>s+Number(m.costoTotal||0),0); },
  ventasTotales(mesKey){ return this._byMonth(Store.getVentas(), mesKey).reduce((s,v)=>s+Number(v.precioCobrado||0),0); },
  // Suma la ganancia ya calculada de cada venta (precio - materiales - impresión - corte - mano de obra)
  gananciaBruta(mesKey){ return this._byMonth(Store.getVentas(), mesKey).reduce((s,v)=>s+Number(v.ganancia||0),0); },
  gastosTotales(mesKey){ return this._byMonth(Store.getGastos(), mesKey).reduce((s,g)=>s+Number(g.monto||0),0); },
  // Ganancia bruta de las ventas, menos gastos generales, menos lo perdido en merma
  utilidadNeta(mesKey){ return this.gananciaBruta(mesKey) - this.gastosTotales(mesKey) - this.mermaTotal(mesKey); },
  capitalDisponible(){
    const cfg = Store.getConfig();
    return Number(cfg.capitalInicial||0) + this.ventasTotales() - this.inversionTotal() - this.gastosTotales();
  },
  // Desglose de "en qué se va" cada sol vendido: cuánto es para reponer materiales,
  // cuánto para el diseñador (mano de obra), cuánto para la impresora/cameo, cuánto
  // se perdió en merma, cuánto en gastos generales (incluye inversión en máquinas,
  // pasajes, etc.) y cuánto queda realmente como ganancia del negocio.
  distribucionIngresos(mesKey){
    const ventas = this.ventasTotales(mesKey);
    const materiales = this.materialConsumido(mesKey);
    const impresionCorte = this.impresionCorteTotal(mesKey);
    const manoObra = this.manoObraTotal(mesKey);
    const merma = this.mermaTotal(mesKey);
    const gastos = this.gastosTotales(mesKey);
    const gananciaNeta = ventas - materiales - impresionCorte - manoObra - merma - gastos;
    return {ventas, materiales, impresionCorte, manoObra, merma, gastos, gananciaNeta};
  },
  trabajosRealizados(mesKey){ return this._byMonth(Store.getVentas(), mesKey).length; },
  materialesEnInventario(){ return Store.getInventario().length; },
  materialesStockBajo(){ return Store.getInventario().filter(m => Number(m.cantidad) <= Number(m.stockMinimo||0)); },
  recuperacionPct(){
    const inv = this.inversionTotal();
    if(inv <= 0) return 100;
    return Math.min(100, (this.ventasTotales() / inv) * 100);
  },
  estadoFinanciero(mesKey){
    const u = this.utilidadNeta(mesKey);
    if(u > 0) return 'ganancias';
    if(u === 0) return 'equilibrio';
    return 'rojo';
  },
  margen(precio, costo){
    if(!precio) return 0;
    return ((precio - costo) / precio) * 100;
  },
  ventasPorMes(){
    const meses = Utils.last6Months();
    const map = Object.fromEntries(meses.map(m=>[m,0]));
    Store.getVentas().forEach(v => { const k = Utils.monthKey(v.fecha); if(k in map) map[k]+=Number(v.precioCobrado||0); });
    return {labels: meses.map(Utils.monthLabel), data: meses.map(m=>map[m])};
  },
  gananciasPorMes(){
    const meses = Utils.last6Months();
    const map = Object.fromEntries(meses.map(m=>[m,0]));
    Store.getVentas().forEach(v => { const k = Utils.monthKey(v.fecha); if(k in map) map[k]+=Number(v.ganancia||0); });
    return {labels: meses.map(Utils.monthLabel), data: meses.map(m=>map[m])};
  },
  comprasPorMes(){
    const meses = Utils.last6Months();
    const map = Object.fromEntries(meses.map(m=>[m,0]));
    Store.getCompras().forEach(c => { const k = Utils.monthKey(c.fecha); if(k in map) map[k]+=Number(c.precioTotal||0); });
    return {labels: meses.map(Utils.monthLabel), data: meses.map(m=>map[m])};
  },
  gastosPorMes(){
    const meses = Utils.last6Months();
    const map = Object.fromEntries(meses.map(m=>[m,0]));
    Store.getGastos().forEach(g => { const k = Utils.monthKey(g.fecha); if(k in map) map[k]+=Number(g.monto||0); });
    return {labels: meses.map(Utils.monthLabel), data: meses.map(m=>map[m])};
  },
  gastosPorCategoria(){
    const map = {};
    Store.getGastos().forEach(g => { const c = g.categoria || 'Otros'; map[c] = (map[c]||0) + Number(g.monto||0); });
    return {labels: Object.keys(map), data: Object.values(map)};
  },
  materialesMasUtilizados(){
    const map = {};
    Store.getVentas().forEach(v => (v.materiales||[]).forEach(m => { map[m.nombre] = (map[m.nombre]||0) + Number(m.cantidad||0); }));
    const entries = Object.entries(map).sort((a,b)=>b[1]-a[1]).slice(0,6);
    return {labels: entries.map(e=>e[0]), data: entries.map(e=>e[1])};
  },
  stockMasBajo(){
    const inv = [...Store.getInventario()].sort((a,b)=> (Number(a.cantidad)/(Number(a.stockMinimo)||1)) - (Number(b.cantidad)/(Number(b.stockMinimo)||1))).slice(0,6);
    return {labels: inv.map(m=>m.nombre), data: inv.map(m=>Number(m.cantidad))};
  },
  flujoCajaPorMes(){
    const meses = Utils.last6Months();
    const ventas = Object.fromEntries(meses.map(m=>[m,0]));
    const compras = Object.fromEntries(meses.map(m=>[m,0]));
    const gastos = Object.fromEntries(meses.map(m=>[m,0]));
    Store.getVentas().forEach(v=>{ const k=Utils.monthKey(v.fecha); if(k in ventas) ventas[k]+=Number(v.precioCobrado||0); });
    Store.getCompras().forEach(c=>{ const k=Utils.monthKey(c.fecha); if(k in compras) compras[k]+=Number(c.precioTotal||0); });
    Store.getGastos().forEach(g=>{ const k=Utils.monthKey(g.fecha); if(k in gastos) gastos[k]+=Number(g.monto||0); });
    return {
      labels: meses.map(Utils.monthLabel),
      ingresos: meses.map(m=>ventas[m]),
      salidas: meses.map(m=>compras[m]+gastos[m]),
      saldo: meses.map(m=> ventas[m] - compras[m] - gastos[m])
    };
  },
  evolucionInventario(){
    // approximate cumulative inventory value using compras (add) minus material consumido cumulative (rough)
    const meses = Utils.last6Months();
    const compras = Object.fromEntries(meses.map(m=>[m,0]));
    Store.getCompras().forEach(c=>{ const k=Utils.monthKey(c.fecha); if(k in compras) compras[k]+=Number(c.precioTotal||0); });
    let running = 0;
    const data = meses.map(m => { running += compras[m]; return running; });
    return {labels: meses.map(Utils.monthLabel), data};
  }
};

/* ---------------------------------------------------------------------- */
/* TOAST                                                                   */
/* ---------------------------------------------------------------------- */
const Toast = {
  icons: {success:'✓', error:'⚠', warning:'!', info:'ℹ'},
  show(type, msg, timeout=3800){
    const c = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="toast-ico">${this.icons[type]||this.icons.info}</span><span>${Utils.escapeHtml(msg)}</span><button class="toast-close">✕</button>`;
    el.querySelector('.toast-close').onclick = ()=> el.remove();
    c.appendChild(el);
    setTimeout(()=>{ el.style.opacity='0'; el.style.transform='translateX(24px)'; setTimeout(()=>el.remove(),250); }, timeout);
  }
};

/* ---------------------------------------------------------------------- */
/* MODAL                                                                   */
/* ---------------------------------------------------------------------- */
const Modal = {
  open({title, bodyHtml, footButtons=[], onMount}){
    this.close();
    const root = document.getElementById('modalRoot');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box" role="dialog" aria-modal="true">
        <div class="modal-head"><h3>${Utils.escapeHtml(title)}</h3><button class="modal-close" id="modalCloseBtn">✕</button></div>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-foot" id="modalFoot"></div>
      </div>`;
    root.appendChild(overlay);
    overlay.addEventListener('mousedown', (e)=>{ if(e.target === overlay) this.close(); });
    overlay.querySelector('#modalCloseBtn').onclick = ()=> this.close();
    const foot = overlay.querySelector('#modalFoot');
    footButtons.forEach(b=>{
      const btn = document.createElement('button');
      btn.className = `btn ${b.className||'btn-secondary'}`;
      btn.textContent = b.label;
      btn.onclick = b.onClick;
      foot.appendChild(btn);
    });
    if(onMount) onMount(overlay);
    this._esc = (e)=>{ if(e.key==='Escape') this.close(); };
    document.addEventListener('keydown', this._esc);
  },
  close(){
    const root = document.getElementById('modalRoot');
    root.innerHTML = '';
    if(this._esc) document.removeEventListener('keydown', this._esc);
  },
  confirm(message, onConfirm, title='¿Confirmar acción?'){
    this.open({
      title,
      bodyHtml: `<p class="confirm-text">${Utils.escapeHtml(message)}</p>`,
      footButtons: [
        {label:'Cancelar', className:'btn-ghost', onClick: ()=> this.close()},
        {label:'Eliminar', className:'btn-danger', onClick: ()=>{ onConfirm(); this.close(); }}
      ]
    });
  }
};

/* ---------------------------------------------------------------------- */
/* CHARTS                                                                  */
/* ---------------------------------------------------------------------- */
const Charts = {
  _instances: {},
  _themeColors(){
    const styles = getComputedStyle(document.documentElement);
    return {
      text: styles.getPropertyValue('--text-dim').trim() || '#736C88',
      grid: styles.getPropertyValue('--border-soft').trim() || '#F0ECF9',
      accent: styles.getPropertyValue('--accent').trim() || '#7C4DFF',
      success: styles.getPropertyValue('--success').trim() || '#17B893',
      warning: styles.getPropertyValue('--warning').trim() || '#FBA834',
      danger: styles.getPropertyValue('--danger').trim() || '#F0483F',
      pink: styles.getPropertyValue('--pink').trim() || '#F0398F',
      teal: styles.getPropertyValue('--teal').trim() || '#12BFC2',
      orange: styles.getPropertyValue('--orange').trim() || '#FBA834'
    };
  },
  _baseOptions(colors){
    return {
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ labels:{ color: colors.text, font:{family:"'Plus Jakarta Sans'", size:11} } } },
      scales:{
        x:{ ticks:{ color: colors.text, font:{size:10.5} }, grid:{ color:'transparent' } },
        y:{ ticks:{ color: colors.text, font:{size:10.5} }, grid:{ color: colors.grid } }
      }
    };
  },
  _make(id, config){
    const ctx = document.getElementById(id);
    if(!ctx) return;
    if(this._instances[id]) this._instances[id].destroy();
    this._instances[id] = new Chart(ctx, config);
  },
  renderAll(){
    const colors = this._themeColors();
    const base = this._baseOptions(colors);

    const vm = Calc.ventasPorMes();
    this._make('chartVentasMes', {type:'bar', data:{labels:vm.labels, datasets:[{label:'Ventas', data:vm.data, backgroundColor: colors.accent, borderRadius:6}]}, options:{...base, plugins:{legend:{display:false}}}});

    const gm = Calc.gananciasPorMes();
    this._make('chartGananciasMes', {type:'line', data:{labels:gm.labels, datasets:[{label:'Ganancia', data:gm.data, borderColor: colors.success, backgroundColor: 'transparent', tension:.35, pointRadius:3}]}, options:{...base, plugins:{legend:{display:false}}}});

    const fc = Calc.flujoCajaPorMes();
    this._make('chartIngresosGastos', {type:'bar', data:{labels:fc.labels, datasets:[
      {label:'Ingresos', data:fc.ingresos, backgroundColor: colors.success, borderRadius:6},
      {label:'Gastos+Compras', data:fc.salidas, backgroundColor: colors.danger, borderRadius:6}
    ]}, options:base});

    const mu = Calc.materialesMasUtilizados();
    this._make('chartMaterialesUsados', {type:'bar', data:{labels:mu.labels, datasets:[{label:'Cantidad usada', data:mu.data, backgroundColor: colors.accent, borderRadius:6}]}, options:{...base, indexAxis:'y', plugins:{legend:{display:false}}}});

    const gc = Calc.gastosPorCategoria();
    this._make('chartGastosCategoria', {type:'doughnut', data:{labels:gc.labels.length?gc.labels:['Sin datos'], datasets:[{data:gc.data.length?gc.data:[1], backgroundColor:[colors.accent,colors.pink,colors.teal,colors.orange,colors.success,colors.danger]}]}, options:{responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'right', labels:{color:colors.text, font:{size:10.5}}}}}});

    const sb = Calc.stockMasBajo();
    this._make('chartStockBajo', {type:'bar', data:{labels:sb.labels, datasets:[{label:'Cantidad', data:sb.data, backgroundColor: colors.warning, borderRadius:6}]}, options:{...base, indexAxis:'y', plugins:{legend:{display:false}}}});

    if(document.getElementById('chartFlujoCaja')){
      this._make('chartFlujoCaja', {type:'line', data:{labels:fc.labels, datasets:[{label:'Saldo neto', data:fc.saldo, borderColor: colors.accent, backgroundColor:'transparent', tension:.35, pointRadius:3}]}, options:{...base, plugins:{legend:{display:false}}}});
    }
    if(document.getElementById('chartEvolInventario')){
      const ei = Calc.evolucionInventario();
      this._make('chartEvolInventario', {type:'line', data:{labels:ei.labels, datasets:[{label:'Inventario acumulado', data:ei.data, borderColor: colors.success, backgroundColor:'rgba(74,222,128,0.12)', fill:true, tension:.35}]}, options:{...base, plugins:{legend:{display:false}}}});
    }
    if(document.getElementById('chartRecuperacion')){
      const pct = Calc.recuperacionPct();
      this._make('chartRecuperacion', {type:'doughnut', data:{labels:['Recuperado','Pendiente'], datasets:[{data:[pct, Math.max(0,100-pct)], backgroundColor:[colors.success, colors.grid], borderWidth:0}]}, options:{responsive:true, maintainAspectRatio:false, cutout:'72%', plugins:{legend:{display:false}}}});
    }
    if(document.getElementById('chartComprasMes')){
      const cm = Calc.comprasPorMes();
      this._make('chartComprasMes', {type:'bar', data:{labels:cm.labels, datasets:[{label:'Compras', data:cm.data, backgroundColor: colors.danger, borderRadius:6}]}, options:{...base, plugins:{legend:{display:false}}}});
    }
  }
};

/* ---------------------------------------------------------------------- */
/* VIEWS — DASHBOARD                                                       */
/* ---------------------------------------------------------------------- */
const DashboardView = {
  mode: 'mes', // 'mes' | 'general'
  mesKey: Utils.currentMonthKey(),
  init(){
    document.querySelectorAll('#dashViewToggle .seg-btn').forEach(btn=>{
      btn.onclick = ()=>{
        this.mode = btn.dataset.mode;
        document.querySelectorAll('#dashViewToggle .seg-btn').forEach(b=> b.classList.toggle('active', b===btn));
        document.getElementById('dashMonthNav').style.display = this.mode==='mes' ? 'flex':'none';
        this.render();
      };
    });
    document.getElementById('dashMonthPrev').onclick = ()=> this._shiftMonth(-1);
    document.getElementById('dashMonthNext').onclick = ()=> this._shiftMonth(1);
    this._updateMonthLabel();
  },
  _shiftMonth(delta){
    const [y,m] = this.mesKey.split('-').map(Number);
    const d = new Date(y, (m-1)+delta, 1);
    this.mesKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    this._updateMonthLabel();
    this.render();
  },
  _updateMonthLabel(){
    const el = document.getElementById('dashMonthLabel');
    if(el) el.textContent = Utils.monthLabel(this.mesKey);
  },
  render(){
    const skel = document.getElementById('dashboardSkeleton');
    const content = document.getElementById('dashboardContent');
    skel.innerHTML = Array.from({length:8}).map(()=>'<div class="skeleton"></div>').join('');
    skel.style.display = 'grid';
    content.style.display = 'none';

    this._updateMonthLabel();
    document.getElementById('dashMonthNav').style.display = this.mode==='mes' ? 'flex':'none';

    setTimeout(()=>{
      const periodo = this.mode==='mes' ? this.mesKey : null;
      this._renderKpis(periodo);
      this._renderRecovery();
      this._renderEstado(periodo);
      Charts.renderAll();
      skel.style.display = 'none';
      content.style.display = 'block';
    }, 260);
  },
  _renderKpis(periodo){
    const grid = document.getElementById('kpiGrid');
    const sufijo = periodo ? ' (este mes)' : ' (histórico)';
    const inv = Calc.inversionTotal(periodo);
    const valInv = Calc.valorInventarioActual();
    const matCons = Calc.materialConsumido(periodo);
    const manoObra = Calc.manoObraTotal(periodo);
    const impresionCorte = Calc.impresionCorteTotal(periodo);
    const merma = Calc.mermaTotal(periodo);
    const ventas = Calc.ventasTotales(periodo);
    const gBruta = Calc.gananciaBruta(periodo);
    const gastos = Calc.gastosTotales(periodo);
    const uNeta = Calc.utilidadNeta(periodo);
    const capDisp = Calc.capitalDisponible();
    const trabajos = Calc.trabajosRealizados(periodo);
    const numMat = Calc.materialesEnInventario();
    const stockBajo = Calc.materialesStockBajo().length;

    const cards = [
      {label:'Compras'+sufijo, value: Utils.money(inv), tone:''},
      {label:'Valor actual del inventario', value: Utils.money(valInv), tone:'accent'},
      {label:'Material consumido'+sufijo, value: Utils.money(matCons), tone:''},
      {label:'Mano de obra (diseñador)'+sufijo, value: Utils.money(manoObra), tone:''},
      {label:'Impresión y corte'+sufijo, value: Utils.money(impresionCorte), tone:''},
      {label:'Merma'+sufijo, value: Utils.money(merma), tone: merma>0?'danger':''},
      {label:'Ventas'+sufijo, value: Utils.money(ventas), tone:'success'},
      {label:'Ganancia bruta'+sufijo, value: Utils.money(gBruta), tone: gBruta>=0?'success':'danger'},
      {label:'Gastos'+sufijo, value: Utils.money(gastos), tone:'warning'},
      {label:'Utilidad neta'+sufijo, value: Utils.money(uNeta), tone: uNeta>=0?'success':'danger', big:true},
      {label:'Capital disponible (actual)', value: Utils.money(capDisp), tone: capDisp>=0?'accent':'danger', big:true},
      {label:'Trabajos'+sufijo, value: trabajos, tone:''},
      {label:'Materiales en inventario', value: numMat, tone:''},
      {label:'Materiales con stock bajo', value: stockBajo, tone: stockBajo>0?'danger':'success'}
    ];
    grid.innerHTML = cards.map(c => `
      <div class="kpi-card ${c.tone?('tone-'+c.tone):''} ${c.big?'big':''}">
        <div class="kpi-label">${c.label}</div>
        <div class="kpi-value">${c.value}</div>
      </div>
    `).join('');
  },
  _renderRecovery(){
    const pct = Calc.recuperacionPct();
    const inv = Calc.inversionTotal();
    const recuperado = Math.min(Calc.ventasTotales(), inv) || (inv<=0?0:0);
    const el = document.getElementById('recoveryBlock');
    if(pct >= 100 && inv > 0){
      el.innerHTML = `
        <div class="recovery-big">${Utils.pct(pct)}</div>
        <div class="progress-track"><div class="progress-fill done" style="width:100%"></div></div>
        <div class="recovery-done-banner">🟢 INVERSIÓN RECUPERADA — Ganancia real: ${Utils.money(Calc.utilidadNeta())}</div>
      `;
    } else {
      const falta = Math.max(0, inv - Calc.ventasTotales());
      el.innerHTML = `
        <div class="recovery-big">${Utils.pct(pct)}</div>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="recovery-meta"><span>Recuperado: ${Utils.money(Math.min(Calc.ventasTotales(), inv))}</span><span>Faltan: ${Utils.money(falta)}</span></div>
      `;
    }
  },
  _renderEstado(periodo){
    const estado = Calc.estadoFinanciero(periodo);
    const u = Calc.utilidadNeta(periodo);
    const sufijo = periodo ? ` en ${Utils.monthLabel(periodo)}` : ' (histórico)';
    const map = {
      ganancias: {cls:'ok', tag:'🟢 GANANCIAS', text:`El negocio genera una utilidad neta positiva de ${Utils.money(u)}${sufijo}. Ingresos superan costos y gastos.`},
      equilibrio: {cls:'mid', tag:'🟡 EQUILIBRIO', text:`Los ingresos igualan exactamente a los costos y gastos${sufijo}. Ni ganancia ni pérdida.`},
      rojo: {cls:'bad', tag:'🔴 EN ROJO', text:`El negocio está en pérdida de ${Utils.money(Math.abs(u))}${sufijo}. Los costos y gastos superan los ingresos.`}
    };
    const info = map[estado];
    document.getElementById('estadoFinancieroBody').innerHTML = `
      <span class="estado-tag ${info.cls}">${info.tag}</span>
      <p class="estado-explain">${info.text}</p>
    `;
    const pill = document.getElementById('sidebarStatusPill');
    pill.className = 'status-pill ' + (estado==='ganancias'?'':(estado==='equilibrio'?'warn':'danger'));
    document.getElementById('sidebarStatusText').textContent = info.tag.replace(/^\S+\s/,'');
  }
};

/* ---------------------------------------------------------------------- */
/* VIEWS — NUEVO TRABAJO                                                   */
/* ---------------------------------------------------------------------- */
const NuevoTrabajoView = {
  rows: [],
  init(){
    document.getElementById('trabajoFecha').value = Utils.todayISO();
    document.getElementById('btnAgregarMaterial').onclick = ()=> this.addRow();
    document.getElementById('btnRegistrarVenta').onclick = ()=> this.registrar();
    document.getElementById('trabajoPrecioHora').value = Store.getConfig().precioHoraHombre ?? 8;
    document.getElementById('trabajoEmpaque').value = 'ninguno';
    document.getElementById('trabajoComision').checked = false;
    ['trabajoPrecio','trabajoHoras','trabajoPrecioHora'].forEach(id=>{
      document.getElementById(id).oninput = ()=> this.updateTotals();
    });
    document.getElementById('trabajoEmpaque').onchange = ()=> this.updateTotals();
    document.getElementById('trabajoComision').onchange = ()=> this.updateTotals();
    this.rows = [];
    this.renderRows();
  },
  addRow(){
    const inv = Store.getInventario();
    if(inv.length === 0){ Toast.show('warning','Primero registra materiales en Inventario.'); return; }
    this.rows.push({rowId: Utils.uid(), materialId:'', cantidad:0, impresion:false, corte:false});
    this.renderRows();
  },
  removeRow(rowId){
    this.rows = this.rows.filter(r=>r.rowId!==rowId);
    this.renderRows();
  },
  renderRows(){
    const wrap = document.getElementById('materialRows');
    const inv = Store.getInventario();
    const cfg = Store.getConfig();
    document.getElementById('materialRowsEmpty').style.display = this.rows.length? 'none':'block';
    wrap.innerHTML = this.rows.map(r=>{
      const mat = inv.find(m=>m.id===r.materialId);
      const costoUnit = mat ? Number(mat.costoPromedio) : 0;
      const cant = Number(r.cantidad||0);
      const costoTotal = costoUnit * cant;
      const costoImpresion = r.impresion ? cant * Number(cfg.precioImpresionHoja||0) : 0;
      const costoCorte = r.corte ? cant * Number(cfg.precioCorte||0) : 0;
      return `
      <div class="material-row" data-row="${r.rowId}">
        <div class="material-row-main">
          <div class="field">
            <label>Material</label>
            <select class="mr-material" data-row="${r.rowId}">
              <option value="">Selecciona…</option>
              ${inv.map(m=>`<option value="${m.id}" ${m.id===r.materialId?'selected':''}>${Utils.escapeHtml(m.nombre)} (${Utils.num(m.cantidad,1)} ${Utils.escapeHtml(m.unidad)} disp.)</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Cantidad usada</label>
            <input type="number" step="0.01" min="0" class="mr-cantidad" data-row="${r.rowId}" value="${r.cantidad||''}">
          </div>
          <div class="field">
            <label>Unidad</label>
            <input type="text" value="${mat?Utils.escapeHtml(mat.unidad):'—'}" disabled>
          </div>
          <div class="field">
            <label>Costo unitario</label>
            <input type="text" value="${Utils.money(costoUnit)}" disabled>
          </div>
          <div class="field">
            <label>Costo usado</label>
            <input type="text" class="mr-costo-usado" value="${Utils.money(costoTotal)}" disabled>
          </div>
          <button class="material-row-remove" data-row="${r.rowId}" title="Eliminar">✕</button>
        </div>
        <div class="material-row-extra">
          <label class="chk-label"><input type="checkbox" class="mr-impresion" data-row="${r.rowId}" ${r.impresion?'checked':''}> Impresión (${Utils.money(cfg.precioImpresionHoja||0)} / hoja)</label>
          <label class="chk-label"><input type="checkbox" class="mr-corte" data-row="${r.rowId}" ${r.corte?'checked':''}> Corte (${Utils.money(cfg.precioCorte||0)} / unid.)</label>
          <span class="extra-cost mr-extra-cost">+ ${Utils.money(costoImpresion+costoCorte)}</span>
        </div>
      </div>`;
    }).join('');

    wrap.querySelectorAll('.mr-material').forEach(sel=>{
      sel.onchange = (e)=>{
        const r = this.rows.find(x=>x.rowId===e.target.dataset.row);
        r.materialId = e.target.value;
        this.renderRows();
        this.updateTotals();
      };
    });
    wrap.querySelectorAll('.mr-cantidad').forEach(inp=>{
      inp.oninput = (e)=>{
        const r = this.rows.find(x=>x.rowId===e.target.dataset.row);
        r.cantidad = Number(e.target.value)||0;
        this.updateTotalsOnly();
      };
    });
    wrap.querySelectorAll('.mr-impresion').forEach(chk=>{
      chk.onchange = (e)=>{
        const r = this.rows.find(x=>x.rowId===e.target.dataset.row);
        r.impresion = e.target.checked;
        this.updateTotalsOnly();
      };
    });
    wrap.querySelectorAll('.mr-corte').forEach(chk=>{
      chk.onchange = (e)=>{
        const r = this.rows.find(x=>x.rowId===e.target.dataset.row);
        r.corte = e.target.checked;
        this.updateTotalsOnly();
      };
    });
    wrap.querySelectorAll('.material-row-remove').forEach(btn=>{
      btn.onclick = (e)=> this.removeRow(e.target.dataset.row);
    });
    this.updateTotals();
  },
  updateTotalsOnly(){
    // update just the costo usado / extra-cost fields without re-render (keeps focus)
    const inv = Store.getInventario();
    const cfg = Store.getConfig();
    document.querySelectorAll('#materialRows .material-row').forEach(rowEl=>{
      const rowId = rowEl.dataset.row;
      const r = this.rows.find(x=>x.rowId===rowId);
      const mat = inv.find(m=>m.id===r.materialId);
      const costoUnit = mat? Number(mat.costoPromedio):0;
      const cant = Number(r.cantidad||0);
      const costoTotal = costoUnit * cant;
      const costoImpresion = r.impresion ? cant * Number(cfg.precioImpresionHoja||0) : 0;
      const costoCorte = r.corte ? cant * Number(cfg.precioCorte||0) : 0;
      const costoUsadoEl = rowEl.querySelector('.mr-costo-usado');
      if(costoUsadoEl) costoUsadoEl.value = Utils.money(costoTotal);
      const extraCostEl = rowEl.querySelector('.mr-extra-cost');
      if(extraCostEl) extraCostEl.textContent = `+ ${Utils.money(costoImpresion+costoCorte)}`;
    });
    this.updateTotals();
  },
  // Costo de mano de obra del trabajo (horas x precio por hora)
  _costoManoObra(){
    const horas = Number(document.getElementById('trabajoHoras').value)||0;
    const precioHora = Number(document.getElementById('trabajoPrecioHora').value)||0;
    return horas * precioHora;
  },
  // Costo de impresión + corte sumando todas las filas de materiales marcadas
  _costoImpresionCorte(){
    const inv = Store.getInventario();
    const cfg = Store.getConfig();
    let total = 0;
    this.rows.forEach(r=>{
      const mat = inv.find(m=>m.id===r.materialId);
      if(!mat) return;
      const cant = Number(r.cantidad||0);
      if(r.impresion) total += cant * Number(cfg.precioImpresionHoja||0);
      if(r.corte) total += cant * Number(cfg.precioCorte||0);
    });
    return total;
  },
  // Costo de empaque según lo elegido: bolsa o caja (tarifa fija, configurable)
  _costoEmpaque(){
    const cfg = Store.getConfig();
    const tipo = document.getElementById('trabajoEmpaque').value;
    if(tipo === 'bolsa') return Number(cfg.precioEmpaqueBolsa||0);
    if(tipo === 'caja') return Number(cfg.precioEmpaqueCaja||0);
    return 0;
  },
  // Comisión de la vendedora: % configurado, calculado SOBRE LA UTILIDAD del
  // trabajo (no sobre el precio cobrado), y solo si el trabajo lo requiere.
  _comision(gananciaAntesComision){
    const cfg = Store.getConfig();
    const requiere = document.getElementById('trabajoComision').checked;
    if(!requiere) return 0;
    const pct = Number(cfg.comisionVendedoraPct||0)/100;
    return Math.max(0, gananciaAntesComision) * pct;
  },
  updateTotals(){
    const inv = Store.getInventario();
    let costoMateriales = 0;
    this.rows.forEach(r=>{
      const mat = inv.find(m=>m.id===r.materialId);
      if(mat) costoMateriales += Number(mat.costoPromedio) * Number(r.cantidad||0);
    });
    const costoImpresionCorte = this._costoImpresionCorte();
    const costoManoObra = this._costoManoObra();
    const costoEmpaque = this._costoEmpaque();
    const costoProduccion = costoMateriales + costoImpresionCorte + costoManoObra + costoEmpaque;
    const precio = Number(document.getElementById('trabajoPrecio').value)||0;
    const gananciaAntesComision = precio - costoProduccion;
    const comision = this._comision(gananciaAntesComision);
    const ganancia = gananciaAntesComision - comision;
    const margen = Calc.margen(precio, costoProduccion + comision);
    document.getElementById('totCostoMateriales').textContent = Utils.money(costoMateriales);
    document.getElementById('totCostoImpresionCorte').textContent = Utils.money(costoImpresionCorte);
    document.getElementById('totCostoManoObra').textContent = Utils.money(costoManoObra);
    document.getElementById('totCostoEmpaque').textContent = Utils.money(costoEmpaque);
    document.getElementById('totPrecioCobrado').textContent = Utils.money(precio);
    document.getElementById('totComision').textContent = Utils.money(comision);
    document.getElementById('totGanancia').textContent = Utils.money(ganancia);
    document.getElementById('totMargen').textContent = Utils.pct(margen);
  },
  registrar(){
    const nombre = document.getElementById('trabajoNombre').value.trim();
    const cliente = document.getElementById('trabajoCliente').value.trim();
    const fecha = document.getElementById('trabajoFecha').value || Utils.todayISO();
    const precio = Number(document.getElementById('trabajoPrecio').value);
    const obs = document.getElementById('trabajoObs').value.trim();
    const horasHombre = Number(document.getElementById('trabajoHoras').value)||0;
    const precioHoraHombre = Number(document.getElementById('trabajoPrecioHora').value)||0;

    if(!nombre){ Toast.show('warning','Escribe el nombre del trabajo.'); return; }
    if(!precio || precio<=0){ Toast.show('warning','Ingresa un precio cobrado válido.'); return; }
    if(this.rows.some(r=>!r.materialId)){ Toast.show('warning','Selecciona un material en cada fila, o elimínala.'); return; }

    const cfg = Store.getConfig();
    const inv = Store.getInventario();
    // validate stock
    const usados = [];
    for(const r of this.rows){
      const mat = inv.find(m=>m.id===r.materialId);
      const cant = Number(r.cantidad||0);
      if(!mat || cant<=0){ Toast.show('warning','Revisa las cantidades de los materiales.'); return; }
      if(cant > Number(mat.cantidad)){
        Toast.show('error', `Stock insuficiente de "${mat.nombre}". Disponible: ${Utils.num(mat.cantidad,1)} ${mat.unidad}.`);
        return;
      }
      const costoImpresion = r.impresion ? cant * Number(cfg.precioImpresionHoja||0) : 0;
      const costoCorte = r.corte ? cant * Number(cfg.precioCorte||0) : 0;
      usados.push({
        materialId:mat.id, nombre:mat.nombre, cantidad:cant, unidad:mat.unidad,
        costoUnitario:Number(mat.costoPromedio), costoTotal: Number(mat.costoPromedio)*cant,
        impresion: !!r.impresion, corte: !!r.corte, costoImpresion, costoCorte
      });
    }

    const empaqueTipo = document.getElementById('trabajoEmpaque').value;
    const requiereVendedora = document.getElementById('trabajoComision').checked;

    const costoTotalMateriales = usados.reduce((s,u)=>s+u.costoTotal,0);
    const costoImpresion = usados.reduce((s,u)=>s+u.costoImpresion,0);
    const costoCorte = usados.reduce((s,u)=>s+u.costoCorte,0);
    const costoManoObra = horasHombre * precioHoraHombre;
    const costoEmpaque = this._costoEmpaque();
    const costoProduccionTotal = costoTotalMateriales + costoImpresion + costoCorte + costoManoObra + costoEmpaque;
    const gananciaAntesComision = precio - costoProduccionTotal;
    const comisionPct = Number(cfg.comisionVendedoraPct||0);
    const comision = requiereVendedora ? Math.max(0, gananciaAntesComision) * (comisionPct/100) : 0;
    const ganancia = gananciaAntesComision - comision;
    const margen = Calc.margen(precio, costoProduccionTotal + comision);

    // discount inventory
    usados.forEach(u=>{
      const mat = inv.find(m=>m.id===u.materialId);
      mat.cantidad = Number(mat.cantidad) - u.cantidad;
    });
    Store.setInventario(inv);

    const ventas = Store.getVentas();
    ventas.push({
      id: Utils.uid(), fecha, nombreTrabajo: nombre, cliente, precioCobrado: precio,
      observaciones: obs, materiales: usados,
      costoTotalMateriales, costoImpresion, costoCorte,
      horasHombre, precioHoraHombre, costoManoObra,
      empaqueTipo, costoEmpaque,
      requiereVendedora, comisionPct, comision, gananciaAntesComision,
      costoProduccionTotal, ganancia, margen
    });
    Store.setVentas(ventas);

    Toast.show('success', `Venta registrada. Ganancia: ${Utils.money(ganancia)}`);
    // reset form
    document.getElementById('formTrabajo').reset();
    document.getElementById('trabajoFecha').value = Utils.todayISO();
    document.getElementById('trabajoPrecioHora').value = cfg.precioHoraHombre ?? 8;
    document.getElementById('trabajoEmpaque').value = 'ninguno';
    document.getElementById('trabajoComision').checked = false;
    this.rows = [];
    this.renderRows();
    App.refreshBadges();
  }
};

/* ---------------------------------------------------------------------- */
/* VIEWS — INVENTARIO                                                      */
/* ---------------------------------------------------------------------- */
const InventarioView = {
  init(){
    document.getElementById('btnNuevoMaterial').onclick = ()=> this.openForm();
    document.getElementById('btnRegistrarMerma').onclick = ()=> this.openMermaForm();
    document.getElementById('invSearch').oninput = Utils.debounce(()=> this.render(), 200);
    document.getElementById('invFiltroCategoria').onchange = ()=> this.render();
    document.getElementById('invOrden').onchange = ()=> this.render();
    this.populateCategoriaFilter();
    this.render();
    this.renderMermas();
  },
  populateCategoriaFilter(){
    const cfg = Store.getConfig();
    const sel = document.getElementById('invFiltroCategoria');
    const current = sel.value;
    sel.innerHTML = '<option value="">Todas las categorías</option>' + cfg.categorias.map(c=>`<option value="${Utils.escapeHtml(c)}">${Utils.escapeHtml(c)}</option>`).join('');
    sel.value = current;
  },
  render(){
    let inv = Store.getInventario();
    const q = document.getElementById('invSearch').value.trim().toLowerCase();
    const cat = document.getElementById('invFiltroCategoria').value;
    const orden = document.getElementById('invOrden').value;

    if(q) inv = inv.filter(m=>m.nombre.toLowerCase().includes(q));
    if(cat) inv = inv.filter(m=>m.categoria===cat);

    if(orden==='cantidad') inv.sort((a,b)=>b.cantidad-a.cantidad);
    else if(orden==='valor') inv.sort((a,b)=>(b.cantidad*b.costoPromedio)-(a.cantidad*a.costoPromedio));
    else if(orden==='stock') inv.sort((a,b)=>(a.cantidad-a.stockMinimo)-(b.cantidad-b.stockMinimo));
    else inv.sort((a,b)=>a.nombre.localeCompare(b.nombre));

    const tbody = document.getElementById('tbodyInventario');
    document.getElementById('invEmptyState').style.display = inv.length? 'none':'block';
    tbody.innerHTML = inv.map(m=>{
      const bajo = Number(m.cantidad) <= Number(m.stockMinimo||0);
      return `
      <tr>
        <td class="wrap">${Utils.escapeHtml(m.nombre)}</td>
        <td><span class="tag">${Utils.escapeHtml(m.categoria||'—')}</span></td>
        <td>${Utils.num(m.cantidad,1)} ${Utils.escapeHtml(m.unidad)}</td>
        <td>${Utils.money(m.costoPromedio)}</td>
        <td>${Utils.money(Number(m.cantidad)*Number(m.costoPromedio))}</td>
        <td>${bajo?`<span class="tag low">⚠ ${Utils.num(m.stockMinimo,1)}</span>`:Utils.num(m.stockMinimo,1)}</td>
        <td>${Utils.formatDate(m.ultimaCompra)}</td>
        <td>
          <button class="row-icon-btn" data-edit="${m.id}" title="Editar">✎</button>
          <button class="row-icon-btn danger" data-del="${m.id}" title="Eliminar">🗑</button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-edit]').forEach(b=> b.onclick = ()=> this.openForm(b.dataset.edit));
    tbody.querySelectorAll('[data-del]').forEach(b=> b.onclick = ()=> this.remove(b.dataset.del));
  },
  openForm(id){
    const cfg = Store.getConfig();
    const inv = Store.getInventario();
    const mat = id ? inv.find(m=>m.id===id) : null;
    const bodyHtml = `
      <div class="field"><label>Nombre</label><input type="text" id="mNombre" value="${mat?Utils.escapeHtml(mat.nombre):''}"></div>
      <div class="field"><label>Categoría</label>
        <select id="mCategoria">${cfg.categorias.map(c=>`<option value="${Utils.escapeHtml(c)}" ${mat&&mat.categoria===c?'selected':''}>${Utils.escapeHtml(c)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Unidad</label>
        <select id="mUnidad">${cfg.unidades.map(u=>`<option value="${Utils.escapeHtml(u)}" ${mat&&mat.unidad===u?'selected':''}>${Utils.escapeHtml(u)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Cantidad disponible</label><input type="number" step="0.01" id="mCantidad" value="${mat?mat.cantidad:0}"></div>
      <div class="field"><label>Costo promedio</label><input type="number" step="0.01" id="mCosto" value="${mat?mat.costoPromedio:0}"></div>
      <div class="field"><label>Stock mínimo</label><input type="number" step="0.01" id="mStockMin" value="${mat?mat.stockMinimo:cfg.stockMinimoDefault}"></div>
    `;
    Modal.open({
      title: mat? 'Editar material' : 'Nuevo material',
      bodyHtml,
      footButtons: [
        {label:'Cancelar', className:'btn-ghost', onClick: ()=>Modal.close()},
        {label:'Guardar', className:'btn-primary', onClick: ()=>{
          const nombre = document.getElementById('mNombre').value.trim();
          if(!nombre){ Toast.show('warning','El nombre es obligatorio.'); return; }
          const data = {
            nombre,
            categoria: document.getElementById('mCategoria').value,
            unidad: document.getElementById('mUnidad').value,
            cantidad: Number(document.getElementById('mCantidad').value)||0,
            costoPromedio: Number(document.getElementById('mCosto').value)||0,
            stockMinimo: Number(document.getElementById('mStockMin').value)||0
          };
          const list = Store.getInventario();
          if(mat){
            const target = list.find(m=>m.id===mat.id);
            if(target){
              Object.assign(target, data);
              Store.setInventario(list);
              Toast.show('success','Material actualizado.');
            } else {
              Toast.show('error','No se encontró el material a actualizar.');
            }
          } else {
            list.push({id: Utils.uid(), ultimaCompra:null, ...data});
            Store.setInventario(list);
            Toast.show('success','Material creado.');
          }
          Modal.close();
          this.render();
          App.refreshBadges();
        }}
      ]
    });
  },
  remove(id){
    Modal.confirm('¿Eliminar este material del inventario? Esta acción no se puede deshacer.', ()=>{
      const list = Store.getInventario().filter(m=>m.id!==id);
      Store.setInventario(list);
      Toast.show('success','Material eliminado.');
      this.render();
      App.refreshBadges();
    });
  },

  /* ---- MERMA: material dañado / perdido ---- */
  openMermaForm(){
    const inv = Store.getInventario();
    if(inv.length === 0){ Toast.show('warning','Primero registra materiales en Inventario.'); return; }
    const motivos = ['Dañado en impresión','Error de corte','Vencido / deteriorado','Pérdida o robo','Otro'];
    const bodyHtml = `
      <div class="field">
        <label>Material</label>
        <select id="mmMaterial">
          <option value="">Selecciona…</option>
          ${inv.map(m=>`<option value="${m.id}">${Utils.escapeHtml(m.nombre)} (${Utils.num(m.cantidad,1)} ${Utils.escapeHtml(m.unidad)} disp.)</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Cantidad perdida</label><input type="number" step="0.01" min="0" id="mmCantidad" placeholder="0"></div>
      <div class="field"><label>Costo estimado</label><input type="text" id="mmCostoPreview" value="${Utils.money(0)}" disabled></div>
      <div class="field"><label>Motivo</label><select id="mmMotivo">${motivos.map(m=>`<option>${m}</option>`).join('')}</select></div>
      <div class="field"><label>Fecha</label><input type="date" id="mmFecha" value="${Utils.todayISO()}"></div>
      <div class="field"><label>Observaciones</label><input type="text" id="mmObs" placeholder="Opcional"></div>
    `;
    Modal.open({
      title:'Registrar merma',
      bodyHtml,
      onMount:(overlay)=>{
        const updatePreview = ()=>{
          const matId = overlay.querySelector('#mmMaterial').value;
          const mat = inv.find(m=>m.id===matId);
          const cant = Number(overlay.querySelector('#mmCantidad').value)||0;
          overlay.querySelector('#mmCostoPreview').value = Utils.money(mat ? mat.costoPromedio*cant : 0);
        };
        overlay.querySelector('#mmMaterial').onchange = updatePreview;
        overlay.querySelector('#mmCantidad').oninput = updatePreview;
      },
      footButtons: [
        {label:'Cancelar', className:'btn-ghost', onClick: ()=>Modal.close()},
        {label:'Registrar merma', className:'btn-danger', onClick: ()=>{
          const matId = document.getElementById('mmMaterial').value;
          const cantidad = Number(document.getElementById('mmCantidad').value)||0;
          const motivo = document.getElementById('mmMotivo').value;
          const fecha = document.getElementById('mmFecha').value || Utils.todayISO();
          const obs = document.getElementById('mmObs').value.trim();
          const list = Store.getInventario();
          const mat = list.find(m=>m.id===matId);
          if(!mat){ Toast.show('warning','Selecciona un material.'); return; }
          if(!cantidad || cantidad<=0){ Toast.show('warning','Ingresa una cantidad válida.'); return; }
          if(cantidad > Number(mat.cantidad)){
            Toast.show('error', `Solo tienes ${Utils.num(mat.cantidad,1)} ${mat.unidad} de "${mat.nombre}" en stock.`);
            return;
          }
          mat.cantidad = Number(mat.cantidad) - cantidad;
          Store.setInventario(list);

          const costoTotal = Number(mat.costoPromedio) * cantidad;
          const mermas = Store.getMermas();
          mermas.push({
            id: Utils.uid(), fecha, materialId: mat.id, materialNombre: mat.nombre,
            cantidad, unidad: mat.unidad, costoUnitario: Number(mat.costoPromedio),
            costoTotal, motivo, observaciones: obs
          });
          Store.setMermas(mermas);

          Toast.show('success', `Merma registrada: ${Utils.money(costoTotal)} en pérdida.`);
          Modal.close();
          this.render();
          this.renderMermas();
          App.refreshBadges();
        }}
      ]
    });
  },
  renderMermas(){
    const mermas = [...Store.getMermas()].sort((a,b)=> b.fecha.localeCompare(a.fecha)).slice(0,50);
    const tbody = document.getElementById('tbodyMermas');
    if(!tbody) return;
    document.getElementById('mermasEmptyState').style.display = mermas.length? 'none':'block';
    tbody.innerHTML = mermas.map(m=>`
      <tr>
        <td>${Utils.formatDate(m.fecha)}</td>
        <td class="wrap">${Utils.escapeHtml(m.materialNombre)}</td>
        <td>${Utils.num(m.cantidad,1)} ${Utils.escapeHtml(m.unidad)}</td>
        <td>${Utils.money(m.costoTotal)}</td>
        <td><span class="tag low">${Utils.escapeHtml(m.motivo||'—')}</span></td>
        <td><button class="row-icon-btn danger" data-del="${m.id}" title="Eliminar">🗑</button></td>
      </tr>`).join('');
    tbody.querySelectorAll('[data-del]').forEach(b=> b.onclick = ()=>{
      Modal.confirm('¿Eliminar este registro de merma? (El material no se devolverá automáticamente al inventario)', ()=>{
        Store.setMermas(Store.getMermas().filter(m=>m.id!==b.dataset.del));
        Toast.show('success','Merma eliminada.');
        this.renderMermas();
        App.refreshBadges();
      });
    });
  }
};

/* ---------------------------------------------------------------------- */
/* VIEWS — COMPRAS                                                         */
/* ---------------------------------------------------------------------- */
const ComprasView = {
  init(){
    document.getElementById('compraFecha').value = Utils.todayISO();
    document.getElementById('btnRegistrarCompra').onclick = ()=> this.registrar();
    ['compraCantidad','compraPrecioTotal','compraMaterial'].forEach(id=>{
      document.getElementById(id).oninput = ()=> this.updatePreview();
    });
    this.populateDatalists();
    this.render();
  },
  populateDatalists(){
    const cfg = Store.getConfig();
    document.getElementById('categoriasDatalist').innerHTML = cfg.categorias.map(c=>`<option value="${Utils.escapeHtml(c)}">`).join('');
    document.getElementById('unidadesDatalist').innerHTML = cfg.unidades.map(u=>`<option value="${Utils.escapeHtml(u)}">`).join('');
    document.getElementById('materialesDatalist').innerHTML = Store.getInventario().map(m=>`<option value="${Utils.escapeHtml(m.nombre)}">`).join('');
  },
  updatePreview(){
    const cant = Number(document.getElementById('compraCantidad').value)||0;
    const total = Number(document.getElementById('compraPrecioTotal').value)||0;
    const nombreMat = document.getElementById('compraMaterial').value.trim();
    const box = document.getElementById('compraPreview');

    box.classList.remove('is-existing','is-new');
    let html = '';

    if(cant>0 && total>0){
      const unit = total/cant;
      html += `Precio unitario calculado: <strong>${Utils.money(unit)}</strong>`;
    }

    if(nombreMat){
      const inv = Store.getInventario();
      const mat = Utils.findMaterial(inv, nombreMat);
      if(mat){
        box.classList.add('is-existing');
        html += `<br>✓ Coincide con <strong>"${Utils.escapeHtml(mat.nombre)}"</strong> — se sumará al stock actual (${Utils.num(mat.cantidad,1)} ${Utils.escapeHtml(mat.unidad)}).`;
      } else {
        box.classList.add('is-new');
        html += `<br>🆕 No existe aún: se creará <strong>"${Utils.escapeHtml(nombreMat)}"</strong> como material nuevo.`;
      }
    }

    if(html){ box.style.display='block'; box.innerHTML = html; }
    else box.style.display='none';
  },
  registrar(){
    const fecha = document.getElementById('compraFecha').value || Utils.todayISO();
    const proveedor = document.getElementById('compraProveedor').value.trim();
    const nombreMat = document.getElementById('compraMaterial').value.trim();
    const categoria = document.getElementById('compraCategoria').value.trim() || 'Otros';
    const cantidad = Number(document.getElementById('compraCantidad').value);
    const unidad = document.getElementById('compraUnidad').value.trim() || 'unid.';
    const precioTotal = Number(document.getElementById('compraPrecioTotal').value);
    const obs = document.getElementById('compraObs').value.trim();

    if(!nombreMat){ Toast.show('warning','Escribe el nombre del material.'); return; }
    if(!cantidad || cantidad<=0){ Toast.show('warning','Ingresa una cantidad válida.'); return; }
    if(!precioTotal || precioTotal<=0){ Toast.show('warning','Ingresa el precio total pagado.'); return; }

    const precioUnitario = precioTotal / cantidad;
    const inv = Store.getInventario();
    let mat = Utils.findMaterial(inv, nombreMat);

    if(mat){
      const cantidadAnterior = Number(mat.cantidad);
      const costoAnterior = Number(mat.costoPromedio);
      const nuevaCantidad = cantidadAnterior + cantidad;
      const nuevoCostoPromedio = nuevaCantidad>0 ? ((cantidadAnterior*costoAnterior) + (cantidad*precioUnitario)) / nuevaCantidad : precioUnitario;
      mat.cantidad = nuevaCantidad;
      mat.costoPromedio = nuevoCostoPromedio;
      mat.ultimaCompra = fecha;
      if(categoria) mat.categoria = mat.categoria || categoria;
    } else {
      mat = {id: Utils.uid(), nombre: nombreMat, categoria, unidad, cantidad, costoPromedio: precioUnitario, stockMinimo: Store.getConfig().stockMinimoDefault||10, ultimaCompra: fecha};
      inv.push(mat);
    }
    Store.setInventario(inv);

    const compras = Store.getCompras();
    compras.push({id: Utils.uid(), fecha, proveedor, materialId: mat.id, materialNombre: mat.nombre, categoria, cantidad, unidad, precioUnitario, precioTotal, observaciones: obs});
    Store.setCompras(compras);

    Toast.show('success', `Compra registrada. Costo unitario: ${Utils.money(precioUnitario)}`);
    document.getElementById('formCompra').reset();
    document.getElementById('compraFecha').value = Utils.todayISO();
    document.getElementById('compraPreview').style.display='none';
    this.populateDatalists();
    this.render();
    App.refreshBadges();
  },
  render(){
    const compras = [...Store.getCompras()].sort((a,b)=> b.fecha.localeCompare(a.fecha)).slice(0,50);
    const tbody = document.getElementById('tbodyCompras');
    document.getElementById('comprasEmptyState').style.display = compras.length? 'none':'block';
    tbody.innerHTML = compras.map(c=>`
      <tr>
        <td>${Utils.formatDate(c.fecha)}</td>
        <td class="wrap">${Utils.escapeHtml(c.materialNombre)}</td>
        <td>${Utils.num(c.cantidad,1)} ${Utils.escapeHtml(c.unidad)}</td>
        <td>${Utils.money(c.precioUnitario)}</td>
        <td>${Utils.money(c.precioTotal)}</td>
        <td><button class="row-icon-btn danger" data-del="${c.id}" title="Eliminar">🗑</button></td>
      </tr>`).join('');
    tbody.querySelectorAll('[data-del]').forEach(b=> b.onclick = ()=> this.remove(b.dataset.del));
  },
  remove(id){
    const compra = Store.getCompras().find(c=>c.id===id);
    const mensaje = compra
      ? `¿Eliminar este registro de compra? Se le quitará al inventario ${Utils.num(compra.cantidad,1)} ${compra.unidad} de "${compra.materialNombre}" (como si nunca se hubiera comprado). El costo promedio del material no se recalculará.`
      : '¿Eliminar este registro de compra?';
    Modal.confirm(mensaje, ()=>{
      if(compra){
        const inv = Store.getInventario();
        const mat = inv.find(m=>m.id===compra.materialId) || Utils.findMaterial(inv, compra.materialNombre);
        if(mat){
          mat.cantidad = Math.max(0, Number(mat.cantidad) - Number(compra.cantidad||0));
          Store.setInventario(inv);
        }
      }
      Store.setCompras(Store.getCompras().filter(c=>c.id!==id));
      Toast.show('success','Compra eliminada y stock del inventario actualizado.');
      this.render();
      this.populateDatalists();
      App.refreshBadges();
    });
  }
};

/* ---------------------------------------------------------------------- */
/* VIEWS — HISTORIAL                                                       */
/* ---------------------------------------------------------------------- */
const HistorialView = {
  init(){
    document.getElementById('histSearch').oninput = Utils.debounce(()=>this.render(), 200);
    document.getElementById('histMes').onchange = ()=> this.render();
    document.getElementById('histClearFilters').onclick = ()=>{
      document.getElementById('histSearch').value='';
      document.getElementById('histMes').value='';
      this.render();
    };
    this.render();
  },
  render(){
    let ventas = [...Store.getVentas()].sort((a,b)=> b.fecha.localeCompare(a.fecha));
    const q = document.getElementById('histSearch').value.trim().toLowerCase();
    const mes = document.getElementById('histMes').value;
    if(q) ventas = ventas.filter(v => (v.cliente||'').toLowerCase().includes(q) || (v.nombreTrabajo||'').toLowerCase().includes(q));
    if(mes) ventas = ventas.filter(v => Utils.monthKey(v.fecha)===mes);

    const tbody = document.getElementById('tbodyHistorial');
    document.getElementById('histEmptyState').style.display = ventas.length? 'none':'block';
    tbody.innerHTML = ventas.map(v=>`
      <tr>
        <td>${Utils.formatDate(v.fecha)}</td>
        <td class="wrap">${Utils.escapeHtml(v.cliente||'—')}</td>
        <td class="wrap">${Utils.escapeHtml(v.nombreTrabajo)}</td>
        <td>${Utils.money(v.precioCobrado)}</td>
        <td>${Utils.money(v.costoTotalMateriales)}</td>
        <td class="${v.ganancia>=0?'':''}" style="color:${v.ganancia>=0?'var(--success)':'var(--danger)'}">${Utils.money(v.ganancia)}</td>
        <td>${Utils.pct(v.margen)}</td>
        <td>
          <button class="row-icon-btn" data-detail="${v.id}">Ver</button>
          <button class="row-icon-btn" data-edit="${v.id}" title="Editar venta">✎</button>
        </td>
      </tr>`).join('');
    tbody.querySelectorAll('[data-detail]').forEach(b=> b.onclick = ()=> this.showDetail(b.dataset.detail));
    tbody.querySelectorAll('[data-edit]').forEach(b=> b.onclick = ()=> this.openEditForm(b.dataset.edit));
  },
  showDetail(id){
    const v = Store.getVentas().find(x=>x.id===id);
    if(!v) return;
    const matHtml = (v.materiales||[]).map(m=>{
      const tags = [m.impresion?'Impresión':'', m.corte?'Corte':''].filter(Boolean).join(' + ');
      return `
      <div class="detail-mat-row">
        <span>${Utils.escapeHtml(m.nombre)} — ${Utils.num(m.cantidad,1)} ${Utils.escapeHtml(m.unidad)}${tags?` <span class="tag">${tags}</span>`:''}</span>
        <span>${Utils.money(m.costoTotal + (m.costoImpresion||0) + (m.costoCorte||0))}</span>
      </div>`;
    }).join('');
    const manoObraHtml = Number(v.horasHombre)>0 ? `
      <div class="detail-mat-row"><span>Mano de obra — ${Utils.num(v.horasHombre,2)} h × ${Utils.money(v.precioHoraHombre)}</span><span>${Utils.money(v.costoManoObra)}</span></div>
    ` : '';
    const empaqueLabelMap = {bolsa:'Bolsa', caja:'Caja'};
    const empaqueHtml = (v.empaqueTipo && v.empaqueTipo!=='ninguno') ? `
      <div class="detail-mat-row"><span>Empaque — ${empaqueLabelMap[v.empaqueTipo]||v.empaqueTipo}</span><span>${Utils.money(v.costoEmpaque||0)}</span></div>
    ` : '';
    Modal.open({
      title: v.nombreTrabajo,
      bodyHtml: `
        <p class="muted">Cliente: ${Utils.escapeHtml(v.cliente||'—')} · ${Utils.formatDate(v.fecha)}</p>
        <div class="detail-mat-list">${matHtml || '<p class="muted">Sin materiales registrados.</p>'}${manoObraHtml}${empaqueHtml}</div>
        <div class="totals-strip" style="margin-top:16px">
          <div class="tot-item"><span class="tot-label">Costo materiales</span><span class="tot-value">${Utils.money(v.costoTotalMateriales)}</span></div>
          <div class="tot-item"><span class="tot-label">Impresión + corte</span><span class="tot-value">${Utils.money((v.costoImpresion||0)+(v.costoCorte||0))}</span></div>
          <div class="tot-item"><span class="tot-label">Mano de obra</span><span class="tot-value">${Utils.money(v.costoManoObra||0)}</span></div>
          <div class="tot-item"><span class="tot-label">Empaque</span><span class="tot-value">${Utils.money(v.costoEmpaque||0)}</span></div>
          <div class="tot-item"><span class="tot-label">Precio</span><span class="tot-value">${Utils.money(v.precioCobrado)}</span></div>
          ${v.requiereVendedora ? `<div class="tot-item"><span class="tot-label">Comisión vendedora (${Utils.pct(v.comisionPct||0)})</span><span class="tot-value">${Utils.money(v.comision||0)}</span></div>` : ''}
          <div class="tot-item"><span class="tot-label">Ganancia</span><span class="tot-value accent-text">${Utils.money(v.ganancia)}</span></div>
          <div class="tot-item"><span class="tot-label">Margen</span><span class="tot-value">${Utils.pct(v.margen)}</span></div>
        </div>
        ${v.observaciones? `<p class="muted" style="margin-top:12px">Notas: ${Utils.escapeHtml(v.observaciones)}</p>`:''}
      `,
      footButtons: [
        {label:'Editar venta', className:'btn-primary', onClick: ()=>{ Modal.close(); HistorialView.openEditForm(id); }},
        {label:'Eliminar venta', className:'btn-danger', onClick: ()=>{
          Modal.confirm('¿Eliminar esta venta del historial? (El inventario ya descontado no se restaurará automáticamente)', ()=>{
            Store.setVentas(Store.getVentas().filter(x=>x.id!==id));
            Toast.show('success','Venta eliminada.');
            HistorialView.render();
            App.refreshBadges();
          });
        }},
        {label:'Cerrar', className:'btn-secondary', onClick: ()=>Modal.close()}
      ]
    });
  },

  /* ---- EDITAR VENTA ---- */
  openEditForm(id){
    const venta = Store.getVentas().find(x=>x.id===id);
    if(!venta){ Toast.show('error','No se encontró la venta.'); return; }
    const cfg = Store.getConfig();
    // Estado local de edición: filas de materiales partiendo de lo ya registrado en la venta
    this._edit = {
      ventaId: id,
      rows: (venta.materiales||[]).map(m=>({rowId:Utils.uid(), materialId:m.materialId, cantidad:Number(m.cantidad||0), impresion:!!m.impresion, corte:!!m.corte}))
    };
    const bodyHtml = `
      <div class="form-grid">
        <div class="field"><label>Nombre del trabajo</label><input type="text" id="editNombre" value="${Utils.escapeHtml(venta.nombreTrabajo||'')}"></div>
        <div class="field"><label>Cliente</label><input type="text" id="editCliente" value="${Utils.escapeHtml(venta.cliente||'')}"></div>
        <div class="field"><label>Fecha</label><input type="date" id="editFecha" value="${venta.fecha||Utils.todayISO()}"></div>
        <div class="field"><label>Precio cobrado</label><input type="number" step="0.01" min="0" id="editPrecio" value="${venta.precioCobrado||0}"></div>
        <div class="field"><label>Horas hombre trabajadas</label><input type="number" step="0.25" min="0" id="editHoras" value="${venta.horasHombre||0}"></div>
        <div class="field"><label>Precio por hora (S/.)</label><input type="number" step="0.01" min="0" id="editPrecioHora" value="${venta.precioHoraHombre ?? cfg.precioHoraHombre ?? 8}"></div>
        <div class="field">
          <label>Empaque</label>
          <select id="editEmpaque" class="select-input">
            <option value="ninguno" ${(!venta.empaqueTipo||venta.empaqueTipo==='ninguno')?'selected':''}>Sin empaque</option>
            <option value="bolsa" ${venta.empaqueTipo==='bolsa'?'selected':''}>Bolsa (+${Utils.money(cfg.precioEmpaqueBolsa||0)})</option>
            <option value="caja" ${venta.empaqueTipo==='caja'?'selected':''}>Caja (+${Utils.money(cfg.precioEmpaqueCaja||0)})</option>
          </select>
        </div>
        <div class="field">
          <label>Vendedora</label>
          <label class="chk-label" style="margin-top:10px">
            <input type="checkbox" id="editComision" ${venta.requiereVendedora?'checked':''}> Requiere vendedora (${Utils.pct(cfg.comisionVendedoraPct||0)} comisión sobre la utilidad)
          </label>
        </div>
        <div class="field field-wide"><label>Observaciones</label><textarea id="editObs" rows="2">${Utils.escapeHtml(venta.observaciones||'')}</textarea></div>
      </div>
      <div class="materials-block">
        <div class="materials-head">
          <h4>Materiales utilizados</h4>
          <button class="btn btn-secondary btn-sm" id="editBtnAgregarMaterial" type="button">+ Agregar material</button>
        </div>
        <div id="editMaterialRows" class="material-rows"></div>
        <div class="empty-hint" id="editMaterialRowsEmpty">Sin materiales agregados.</div>
      </div>
      <div class="totals-strip" style="margin-top:14px">
        <div class="tot-item"><span class="tot-label">Costo materiales</span><span class="tot-value" id="editTotCostoMateriales">S/. 0.00</span></div>
        <div class="tot-item"><span class="tot-label">Impresión + corte</span><span class="tot-value" id="editTotCostoImpresionCorte">S/. 0.00</span></div>
        <div class="tot-item"><span class="tot-label">Mano de obra</span><span class="tot-value" id="editTotCostoManoObra">S/. 0.00</span></div>
        <div class="tot-item"><span class="tot-label">Empaque</span><span class="tot-value" id="editTotCostoEmpaque">S/. 0.00</span></div>
        <div class="tot-item"><span class="tot-label">Precio cobrado</span><span class="tot-value" id="editTotPrecioCobrado">S/. 0.00</span></div>
        <div class="tot-item"><span class="tot-label">Comisión vendedora</span><span class="tot-value" id="editTotComision">S/. 0.00</span></div>
        <div class="tot-item"><span class="tot-label">Ganancia</span><span class="tot-value accent-text" id="editTotGanancia">S/. 0.00</span></div>
        <div class="tot-item"><span class="tot-label">Margen</span><span class="tot-value" id="editTotMargen">0%</span></div>
      </div>
    `;
    Modal.open({
      title: 'Editar venta',
      bodyHtml,
      onMount:(overlay)=>{
        overlay.querySelector('#editBtnAgregarMaterial').onclick = ()=> this._editAddRow(overlay);
        ['editPrecio','editHoras','editPrecioHora'].forEach(fid=>{
          overlay.querySelector('#'+fid).oninput = ()=> this._editUpdateTotals(overlay);
        });
        overlay.querySelector('#editEmpaque').onchange = ()=> this._editUpdateTotals(overlay);
        overlay.querySelector('#editComision').onchange = ()=> this._editUpdateTotals(overlay);
        this._editRenderRows(overlay);
      },
      footButtons: [
        {label:'Cancelar', className:'btn-ghost', onClick: ()=>Modal.close()},
        {label:'Guardar cambios', className:'btn-primary', onClick: ()=> this._editSave(id)}
      ]
    });
  },
  // Inventario "virtual": stock actual + lo que esta venta ya tenía reservado
  // (así, al editar, no choca contra su propio consumo original)
  _editStockDisponible(materialId, venta){
    const inv = Store.getInventario();
    const mat = inv.find(m=>m.id===materialId);
    if(!mat) return {mat:null, disponible:0};
    const reservadoOriginal = (venta.materiales||[]).filter(m=>m.materialId===materialId).reduce((s,m)=>s+Number(m.cantidad||0),0);
    return {mat, disponible: Number(mat.cantidad) + reservadoOriginal};
  },
  _editAddRow(overlay){
    const inv = Store.getInventario();
    if(inv.length === 0){ Toast.show('warning','Primero registra materiales en Inventario.'); return; }
    this._edit.rows.push({rowId:Utils.uid(), materialId:'', cantidad:0, impresion:false, corte:false});
    this._editRenderRows(overlay);
  },
  _editRemoveRow(overlay, rowId){
    this._edit.rows = this._edit.rows.filter(r=>r.rowId!==rowId);
    this._editRenderRows(overlay);
  },
  _editRenderRows(overlay){
    const venta = Store.getVentas().find(x=>x.id===this._edit.ventaId);
    const inv = Store.getInventario();
    const cfg = Store.getConfig();
    const wrap = overlay.querySelector('#editMaterialRows');
    overlay.querySelector('#editMaterialRowsEmpty').style.display = this._edit.rows.length? 'none':'block';
    wrap.innerHTML = this._edit.rows.map(r=>{
      const mat = inv.find(m=>m.id===r.materialId);
      const costoUnit = mat ? Number(mat.costoPromedio) : 0;
      const cant = Number(r.cantidad||0);
      const costoTotal = costoUnit * cant;
      const costoImpresion = r.impresion ? cant * Number(cfg.precioImpresionHoja||0) : 0;
      const costoCorte = r.corte ? cant * Number(cfg.precioCorte||0) : 0;
      return `
      <div class="material-row" data-row="${r.rowId}">
        <div class="material-row-main">
          <div class="field">
            <label>Material</label>
            <select class="emr-material" data-row="${r.rowId}">
              <option value="">Selecciona…</option>
              ${inv.map(m=>{
                const {disponible} = this._editStockDisponible(m.id, venta);
                return `<option value="${m.id}" ${m.id===r.materialId?'selected':''}>${Utils.escapeHtml(m.nombre)} (${Utils.num(disponible,1)} ${Utils.escapeHtml(m.unidad)} disp.)</option>`;
              }).join('')}
            </select>
          </div>
          <div class="field"><label>Cantidad usada</label><input type="number" step="0.01" min="0" class="emr-cantidad" data-row="${r.rowId}" value="${r.cantidad||''}"></div>
          <div class="field"><label>Unidad</label><input type="text" value="${mat?Utils.escapeHtml(mat.unidad):'—'}" disabled></div>
          <div class="field"><label>Costo unitario</label><input type="text" value="${Utils.money(costoUnit)}" disabled></div>
          <div class="field"><label>Costo usado</label><input type="text" class="emr-costo-usado" value="${Utils.money(costoTotal)}" disabled></div>
          <button class="material-row-remove" data-row="${r.rowId}" type="button" title="Eliminar">✕</button>
        </div>
        <div class="material-row-extra">
          <label class="chk-label"><input type="checkbox" class="emr-impresion" data-row="${r.rowId}" ${r.impresion?'checked':''}> Impresión (${Utils.money(cfg.precioImpresionHoja||0)} / hoja)</label>
          <label class="chk-label"><input type="checkbox" class="emr-corte" data-row="${r.rowId}" ${r.corte?'checked':''}> Corte (${Utils.money(cfg.precioCorte||0)} / unid.)</label>
          <span class="extra-cost emr-extra-cost">+ ${Utils.money(costoImpresion+costoCorte)}</span>
        </div>
      </div>`;
    }).join('');

    wrap.querySelectorAll('.emr-material').forEach(sel=>{
      sel.onchange = (e)=>{
        const r = this._edit.rows.find(x=>x.rowId===e.target.dataset.row);
        r.materialId = e.target.value;
        this._editRenderRows(overlay);
      };
    });
    wrap.querySelectorAll('.emr-cantidad').forEach(inp=>{
      inp.oninput = (e)=>{
        const r = this._edit.rows.find(x=>x.rowId===e.target.dataset.row);
        r.cantidad = Number(e.target.value)||0;
        this._editRenderRows(overlay);
      };
    });
    wrap.querySelectorAll('.emr-impresion').forEach(chk=>{
      chk.onchange = (e)=>{
        const r = this._edit.rows.find(x=>x.rowId===e.target.dataset.row);
        r.impresion = e.target.checked;
        this._editRenderRows(overlay);
      };
    });
    wrap.querySelectorAll('.emr-corte').forEach(chk=>{
      chk.onchange = (e)=>{
        const r = this._edit.rows.find(x=>x.rowId===e.target.dataset.row);
        r.corte = e.target.checked;
        this._editRenderRows(overlay);
      };
    });
    wrap.querySelectorAll('.material-row-remove').forEach(btn=>{
      btn.onclick = (e)=> this._editRemoveRow(overlay, e.target.dataset.row);
    });
    this._editUpdateTotals(overlay);
  },
  _editUpdateTotals(overlay){
    const inv = Store.getInventario();
    const cfg = Store.getConfig();
    let costoMateriales = 0, costoImpresionCorte = 0;
    this._edit.rows.forEach(r=>{
      const mat = inv.find(m=>m.id===r.materialId);
      if(!mat) return;
      const cant = Number(r.cantidad||0);
      costoMateriales += Number(mat.costoPromedio) * cant;
      if(r.impresion) costoImpresionCorte += cant * Number(cfg.precioImpresionHoja||0);
      if(r.corte) costoImpresionCorte += cant * Number(cfg.precioCorte||0);
    });
    const horas = Number(overlay.querySelector('#editHoras').value)||0;
    const precioHora = Number(overlay.querySelector('#editPrecioHora').value)||0;
    const costoManoObra = horas * precioHora;
    const empaqueTipo = overlay.querySelector('#editEmpaque').value;
    const costoEmpaque = empaqueTipo==='bolsa' ? Number(cfg.precioEmpaqueBolsa||0) : empaqueTipo==='caja' ? Number(cfg.precioEmpaqueCaja||0) : 0;
    const costoProduccion = costoMateriales + costoImpresionCorte + costoManoObra + costoEmpaque;
    const precio = Number(overlay.querySelector('#editPrecio').value)||0;
    const gananciaAntesComision = precio - costoProduccion;
    const requiereVendedora = overlay.querySelector('#editComision').checked;
    const comision = requiereVendedora ? Math.max(0, gananciaAntesComision) * (Number(cfg.comisionVendedoraPct||0)/100) : 0;
    const ganancia = gananciaAntesComision - comision;
    const margen = Calc.margen(precio, costoProduccion + comision);
    overlay.querySelector('#editTotCostoMateriales').textContent = Utils.money(costoMateriales);
    overlay.querySelector('#editTotCostoImpresionCorte').textContent = Utils.money(costoImpresionCorte);
    overlay.querySelector('#editTotCostoManoObra').textContent = Utils.money(costoManoObra);
    overlay.querySelector('#editTotCostoEmpaque').textContent = Utils.money(costoEmpaque);
    overlay.querySelector('#editTotPrecioCobrado').textContent = Utils.money(precio);
    overlay.querySelector('#editTotComision').textContent = Utils.money(comision);
    overlay.querySelector('#editTotGanancia').textContent = Utils.money(ganancia);
    overlay.querySelector('#editTotMargen').textContent = Utils.pct(margen);
  },
  _editSave(id){
    const venta = Store.getVentas().find(x=>x.id===id);
    if(!venta) return;
    const nombre = document.getElementById('editNombre').value.trim();
    const precio = Number(document.getElementById('editPrecio').value);
    if(!nombre){ Toast.show('warning','Escribe el nombre del trabajo.'); return; }
    if(!precio || precio<=0){ Toast.show('warning','Ingresa un precio cobrado válido.'); return; }
    if(this._edit.rows.some(r=>!r.materialId)){ Toast.show('warning','Selecciona un material en cada fila, o elimínala.'); return; }

    const cfg = Store.getConfig();
    const inv = Store.getInventario();

    // Valida stock disponible considerando lo que esta venta ya tenía reservado
    const usados = [];
    for(const r of this._edit.rows){
      const {mat, disponible} = this._editStockDisponible(r.materialId, venta);
      const cant = Number(r.cantidad||0);
      if(!mat || cant<=0){ Toast.show('warning','Revisa las cantidades de los materiales.'); return; }
      if(cant > disponible){
        Toast.show('error', `Stock insuficiente de "${mat.nombre}". Disponible: ${Utils.num(disponible,1)} ${mat.unidad}.`);
        return;
      }
      const costoImpresion = r.impresion ? cant * Number(cfg.precioImpresionHoja||0) : 0;
      const costoCorte = r.corte ? cant * Number(cfg.precioCorte||0) : 0;
      usados.push({
        materialId:mat.id, nombre:mat.nombre, cantidad:cant, unidad:mat.unidad,
        costoUnitario:Number(mat.costoPromedio), costoTotal: Number(mat.costoPromedio)*cant,
        impresion: !!r.impresion, corte: !!r.corte, costoImpresion, costoCorte
      });
    }

    // Devuelve al inventario lo que esta venta había consumido originalmente…
    (venta.materiales||[]).forEach(m=>{
      const mat = inv.find(x=>x.id===m.materialId);
      if(mat) mat.cantidad = Number(mat.cantidad) + Number(m.cantidad||0);
    });
    // …y descuenta lo nuevo
    usados.forEach(u=>{
      const mat = inv.find(x=>x.id===u.materialId);
      if(mat) mat.cantidad = Number(mat.cantidad) - u.cantidad;
    });
    Store.setInventario(inv);

    const costoTotalMateriales = usados.reduce((s,u)=>s+u.costoTotal,0);
    const costoImpresion = usados.reduce((s,u)=>s+u.costoImpresion,0);
    const costoCorte = usados.reduce((s,u)=>s+u.costoCorte,0);
    const horasHombre = Number(document.getElementById('editHoras').value)||0;
    const precioHoraHombre = Number(document.getElementById('editPrecioHora').value)||0;
    const costoManoObra = horasHombre * precioHoraHombre;
    const empaqueTipo = document.getElementById('editEmpaque').value;
    const costoEmpaque = empaqueTipo==='bolsa' ? Number(cfg.precioEmpaqueBolsa||0) : empaqueTipo==='caja' ? Number(cfg.precioEmpaqueCaja||0) : 0;
    const costoProduccionTotal = costoTotalMateriales + costoImpresion + costoCorte + costoManoObra + costoEmpaque;
    const gananciaAntesComision = precio - costoProduccionTotal;
    const requiereVendedora = document.getElementById('editComision').checked;
    const comisionPct = Number(cfg.comisionVendedoraPct||0);
    const comision = requiereVendedora ? Math.max(0, gananciaAntesComision) * (comisionPct/100) : 0;
    const ganancia = gananciaAntesComision - comision;
    const margen = Calc.margen(precio, costoProduccionTotal + comision);

    Object.assign(venta, {
      nombreTrabajo: nombre,
      cliente: document.getElementById('editCliente').value.trim(),
      fecha: document.getElementById('editFecha').value || venta.fecha,
      precioCobrado: precio,
      observaciones: document.getElementById('editObs').value.trim(),
      materiales: usados,
      costoTotalMateriales, costoImpresion, costoCorte,
      horasHombre, precioHoraHombre, costoManoObra,
      empaqueTipo, costoEmpaque,
      requiereVendedora, comisionPct, comision, gananciaAntesComision,
      costoProduccionTotal, ganancia, margen
    });
    Store.setVentas(Store.getVentas().map(v=> v.id===id ? venta : v));

    Toast.show('success','Venta actualizada.');
    Modal.close();
    this.render();
    App.refreshBadges();
  }
};

/* ---------------------------------------------------------------------- */
/* VIEWS — FINANZAS                                                        */
/* ---------------------------------------------------------------------- */
const FinanzasView = {
  init(){
    document.getElementById('btnGuardarCapital').onclick = ()=> this.saveCapital();
    document.getElementById('btnNuevoGasto').onclick = ()=> this.openGastoForm();
    document.getElementById('btnExportInventario').onclick = ()=> Exporter.inventario();
    document.getElementById('btnExportVentas').onclick = ()=> Exporter.ventas();
    document.getElementById('btnExportFinanzas').onclick = ()=> Exporter.finanzas();
    document.getElementById('btnExportCompras').onclick = ()=> Exporter.compras();
    document.getElementById('btnExportMermas').onclick = ()=> Exporter.mermas();
    document.getElementById('btnRespaldarJSON').onclick = ()=> Exporter.backupJSON();
    document.getElementById('inputImportarJSON').onchange = (e)=> Exporter.importJSON(e);
    document.getElementById('btnResetApp').onclick = ()=>{
      Modal.confirm('Esto borrará TODOS los datos (inventario, compras, ventas, gastos y configuración) para TODOS los que usan la app. ¿Deseas continuar?', async ()=>{
        await Store.resetAll();
        Toast.show('success','Aplicación restablecida.');
        App.renderCurrentView();
      }, 'Restablecer aplicación');
    };
    this.render();
  },
  render(){
    const cfg = Store.getConfig();
    document.getElementById('capitalInicialInput').value = cfg.capitalInicial || 0;
    this.renderKpis();
    this.renderEstado();
    this.renderDistribucion();
    this.renderGastos();
    Charts.renderAll();
  },
  saveCapital(){
    const cfg = Store.getConfig();
    cfg.capitalInicial = Number(document.getElementById('capitalInicialInput').value)||0;
    Store.setConfig(cfg);
    Toast.show('success','Capital inicial actualizado.');
    this.render();
    App.refreshBadges();
  },
  renderKpis(){
    const grid = document.getElementById('finanzasKpiGrid');
    const cards = [
      {label:'Total invertido', value: Utils.money(Calc.inversionTotal())},
      {label:'Dinero recuperado', value: Utils.money(Calc.ventasTotales())},
      {label:'Dinero aún invertido (inventario)', value: Utils.money(Calc.valorInventarioActual())},
      {label:'Material consumido', value: Utils.money(Calc.materialConsumido())},
      {label:'Mano de obra (diseñador)', value: Utils.money(Calc.manoObraTotal())},
      {label:'Impresión y corte (impresora/cameo)', value: Utils.money(Calc.impresionCorteTotal())},
      {label:'Merma (material dañado/perdido)', value: Utils.money(Calc.mermaTotal()), tone: Calc.mermaTotal()>0?'danger':''},
      {label:'Gastos totales', value: Utils.money(Calc.gastosTotales())},
      {label:'Utilidad neta', value: Utils.money(Calc.utilidadNeta()), tone: Calc.utilidadNeta()>=0?'success':'danger'},
      {label:'Capital disponible para reinvertir', value: Utils.money(Calc.capitalDisponible()), tone:'accent', big:true}
    ];
    grid.innerHTML = cards.map(c=>`
      <div class="kpi-card ${c.tone?('tone-'+c.tone):''} ${c.big?'wide big':''}">
        <div class="kpi-label">${c.label}</div>
        <div class="kpi-value">${c.value}</div>
      </div>`).join('');
  },
  renderEstado(){
    const inv = Calc.inversionTotal();
    const recuperado = Calc.ventasTotales();
    const body = document.getElementById('finanzasEstadoBody');
    if(recuperado < inv){
      body.innerHTML = `
        <span class="estado-tag bad">🔴 EN ROJO</span>
        <p class="estado-explain">Has recuperado ${Utils.money(recuperado)} de ${Utils.money(inv)}. Aún faltan recuperar ${Utils.money(inv-recuperado)}.</p>`;
    } else {
      body.innerHTML = `
        <span class="estado-tag ok">🟢 INVERSIÓN RECUPERADA</span>
        <p class="estado-explain">Ganancia real: ${Utils.money(Calc.utilidadNeta())}</p>`;
    }
  },
  renderDistribucion(){
    const d = Calc.distribucionIngresos();
    const body = document.getElementById('distribucionBody');
    if(!body) return;
    if(d.ventas <= 0){
      body.innerHTML = `<p class="muted">Aún no registras ventas — este desglose aparecerá apenas registres tu primer trabajo.</p>`;
      return;
    }
    const pct = (n)=> Math.max(0, Math.min(100, (n/d.ventas)*100));
    const rows = [
      {label:'Materiales', hint:'para reponer stock de insumos', value:d.materiales, color:'var(--accent)'},
      {label:'Impresión y corte', hint:'mantenimiento/insumos de impresora y cameo', value:d.impresionCorte, color:'var(--teal)'},
      {label:'Mano de obra', hint:'lo que le corresponde al diseñador', value:d.manoObra, color:'var(--pink)'},
      {label:'Merma', hint:'material dañado o perdido', value:d.merma, color:'var(--warning)'},
      {label:'Otros gastos', hint:'publicidad, herramientas, inversión en máquinas, pasajes, etc.', value:d.gastos, color:'var(--danger)'}
    ];
    body.innerHTML = rows.map(r=>`
      <div class="dist-row">
        <div class="dist-row-top">
          <span class="dist-row-label">${r.label}<span class="dist-row-hint">${r.hint}</span></span>
          <span class="dist-row-right"><span class="dist-row-pct">${pct(r.value).toFixed(0)}%</span><span class="dist-row-value">${Utils.money(r.value)}</span></span>
        </div>
        <div class="dist-bar-track"><div class="dist-bar-fill" style="width:${pct(r.value)}%; background:${r.color}"></div></div>
      </div>`).join('') + `
      <div class="dist-row total">
        <div class="dist-row-top">
          <span class="dist-row-label">Ganancia neta del negocio<span class="dist-row-hint">lo que realmente te queda, sobre ${Utils.money(d.ventas)} vendidos</span></span>
          <span class="dist-row-right"><span class="dist-row-pct">${pct(d.gananciaNeta).toFixed(0)}%</span><span class="dist-row-value" style="color:${d.gananciaNeta>=0?'var(--success)':'var(--danger)'}">${Utils.money(d.gananciaNeta)}</span></span>
        </div>
        <div class="dist-bar-track"><div class="dist-bar-fill" style="width:${pct(d.gananciaNeta)}%; background:${d.gananciaNeta>=0?'var(--success)':'var(--danger)'}"></div></div>
      </div>`;
  },
  renderGastos(){
    const gastos = [...Store.getGastos()].sort((a,b)=> b.fecha.localeCompare(a.fecha));
    const tbody = document.getElementById('tbodyGastos');
    document.getElementById('gastosEmptyState').style.display = gastos.length? 'none':'block';
    tbody.innerHTML = gastos.map(g=>`
      <tr>
        <td>${Utils.formatDate(g.fecha)}</td>
        <td class="wrap">${Utils.escapeHtml(g.descripcion)}</td>
        <td><span class="tag">${Utils.escapeHtml(g.categoria)}</span></td>
        <td>${Utils.money(g.monto)}</td>
        <td><button class="row-icon-btn danger" data-del="${g.id}">🗑</button></td>
      </tr>`).join('');
    tbody.querySelectorAll('[data-del]').forEach(b=> b.onclick = ()=>{
      Modal.confirm('¿Eliminar este gasto?', ()=>{
        Store.setGastos(Store.getGastos().filter(g=>g.id!==b.dataset.del));
        Toast.show('success','Gasto eliminado.');
        this.render();
        App.refreshBadges();
      });
    });
  },
  openGastoForm(){
    const categoriasGasto = ['Publicidad','Gasolina','Pasajes / Movilidad','Delivery','Empaques','Luz','Internet','Herramientas','Mantenimiento','Inversión en máquinas','Otros'];
    Modal.open({
      title:'Nuevo gasto',
      bodyHtml: `
        <div class="field"><label>Fecha</label><input type="date" id="gFecha" value="${Utils.todayISO()}"></div>
        <div class="field"><label>Descripción</label><input type="text" id="gDesc" placeholder="Ej. Publicidad en Instagram"></div>
        <div class="field"><label>Categoría</label><select id="gCategoria">${categoriasGasto.map(c=>`<option>${c}</option>`).join('')}</select></div>
        <div class="field"><label>Monto</label><input type="number" step="0.01" id="gMonto" placeholder="0.00"></div>
        <div class="field"><label>Observaciones</label><input type="text" id="gObs" placeholder="Opcional"></div>
      `,
      footButtons: [
        {label:'Cancelar', className:'btn-ghost', onClick: ()=>Modal.close()},
        {label:'Guardar gasto', className:'btn-primary', onClick: ()=>{
          const monto = Number(document.getElementById('gMonto').value);
          const desc = document.getElementById('gDesc').value.trim();
          if(!desc){ Toast.show('warning','Escribe una descripción.'); return; }
          if(!monto || monto<=0){ Toast.show('warning','Ingresa un monto válido.'); return; }
          const gastos = Store.getGastos();
          gastos.push({id:Utils.uid(), fecha: document.getElementById('gFecha').value||Utils.todayISO(), descripcion: desc, categoria: document.getElementById('gCategoria').value, monto, observaciones: document.getElementById('gObs').value.trim()});
          Store.setGastos(gastos);
          Toast.show('success','Gasto registrado.');
          Modal.close();
          this.render();
          App.refreshBadges();
        }}
      ]
    });
  }
};

/* ---------------------------------------------------------------------- */
/* VIEWS — CONFIGURACIÓN                                                   */
/* ---------------------------------------------------------------------- */
const ConfigView = {
  init(){
    document.getElementById('btnGuardarConfig').onclick = ()=> this.save();
    this.render();
  },
  render(){
    const cfg = Store.getConfig();
    document.getElementById('cfgNombre').value = cfg.nombreNegocio||'';
    document.getElementById('cfgMoneda').value = cfg.moneda||'';
    document.getElementById('cfgStockMin').value = cfg.stockMinimoDefault||0;
    document.getElementById('cfgTema').value = cfg.tema||'dark';
    document.getElementById('cfgCategorias').value = (cfg.categorias||[]).join(', ');
    document.getElementById('cfgUnidades').value = (cfg.unidades||[]).join(', ');
    document.getElementById('cfgPrecioHora').value = cfg.precioHoraHombre ?? 8;
    document.getElementById('cfgPrecioImpresion').value = cfg.precioImpresionHoja ?? 0.5;
    document.getElementById('cfgPrecioCorte').value = cfg.precioCorte ?? 0.3;
    document.getElementById('cfgComisionPct').value = cfg.comisionVendedoraPct ?? 10;
    document.getElementById('cfgPrecioBolsa').value = cfg.precioEmpaqueBolsa ?? 0.5;
    document.getElementById('cfgPrecioCaja').value = cfg.precioEmpaqueCaja ?? 1;
  },
  save(){
    const cfg = Store.getConfig();
    cfg.nombreNegocio = document.getElementById('cfgNombre').value.trim() || 'KJ Concept';
    cfg.moneda = document.getElementById('cfgMoneda').value.trim() || 'S/.';
    cfg.stockMinimoDefault = Number(document.getElementById('cfgStockMin').value)||0;
    cfg.tema = document.getElementById('cfgTema').value;
    cfg.categorias = document.getElementById('cfgCategorias').value.split(',').map(s=>s.trim()).filter(Boolean);
    cfg.unidades = document.getElementById('cfgUnidades').value.split(',').map(s=>s.trim()).filter(Boolean);
    cfg.precioHoraHombre = Number(document.getElementById('cfgPrecioHora').value)||0;
    cfg.precioImpresionHoja = Number(document.getElementById('cfgPrecioImpresion').value)||0;
    cfg.precioCorte = Number(document.getElementById('cfgPrecioCorte').value)||0;
    cfg.comisionVendedoraPct = Number(document.getElementById('cfgComisionPct').value)||0;
    cfg.precioEmpaqueBolsa = Number(document.getElementById('cfgPrecioBolsa').value)||0;
    cfg.precioEmpaqueCaja = Number(document.getElementById('cfgPrecioCaja').value)||0;
    Store.setConfig(cfg);
    App.applyTheme(cfg.tema);
    App.applyBrand(cfg.nombreNegocio);
    Toast.show('success','Configuración guardada.');
  }
};

/* ---------------------------------------------------------------------- */
/* EXPORT                                                                  */
/* ---------------------------------------------------------------------- */
const Exporter = {
  _download(wb, filename){
    XLSX.writeFile(wb, filename);
    Toast.show('success', `Archivo "${filename}" descargado.`);
  },
  inventario(){
    const data = Store.getInventario().map(m=>({
      Material:m.nombre, Categoria:m.categoria, Unidad:m.unidad, Cantidad:m.cantidad,
      'Costo Promedio':m.costoPromedio, 'Valor Total':Number(m.cantidad)*Number(m.costoPromedio),
      'Stock Minimo':m.stockMinimo, 'Ultima Compra':m.ultimaCompra
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Inventario');
    this._download(wb, 'KJConcept_Inventario.xlsx');
  },
  ventas(){
    const data = Store.getVentas().map(v=>({
      Fecha:v.fecha, Cliente:v.cliente, Trabajo:v.nombreTrabajo, 'Precio Cobrado':v.precioCobrado,
      'Costo Materiales':v.costoTotalMateriales, 'Impresión':v.costoImpresion||0, 'Corte':v.costoCorte||0,
      'Horas Hombre':v.horasHombre||0, 'Precio Hora':v.precioHoraHombre||0, 'Mano de Obra':v.costoManoObra||0,
      Empaque: v.empaqueTipo && v.empaqueTipo!=='ninguno' ? (v.empaqueTipo==='bolsa'?'Bolsa':'Caja') : '—',
      'Costo Empaque':v.costoEmpaque||0,
      'Requiere Vendedora': v.requiereVendedora ? 'Sí' : 'No',
      'Comisión Vendedora': v.comision||0,
      Ganancia:v.ganancia, 'Margen %':v.margen
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Ventas');
    this._download(wb, 'KJConcept_Ventas.xlsx');
  },
  compras(){
    const data = Store.getCompras().map(c=>({
      Fecha:c.fecha, Proveedor:c.proveedor, Material:c.materialNombre, Categoria:c.categoria,
      Cantidad:c.cantidad, Unidad:c.unidad, 'Precio Unitario':c.precioUnitario, 'Precio Total':c.precioTotal
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Compras');
    this._download(wb, 'KJConcept_Compras.xlsx');
  },
  finanzas(){
    const data = [{
      'Inversion Total': Calc.inversionTotal(),
      'Valor Inventario Actual': Calc.valorInventarioActual(),
      'Material Consumido': Calc.materialConsumido(),
      'Mano de Obra (Diseñador)': Calc.manoObraTotal(),
      'Impresion y Corte': Calc.impresionCorteTotal(),
      'Merma': Calc.mermaTotal(),
      'Ventas Totales': Calc.ventasTotales(),
      'Ganancia Bruta': Calc.gananciaBruta(),
      'Gastos Totales': Calc.gastosTotales(),
      'Utilidad Neta': Calc.utilidadNeta(),
      'Capital Disponible': Calc.capitalDisponible(),
      'Recuperacion %': Calc.recuperacionPct().toFixed(1)
    }];
    const ws = XLSX.utils.json_to_sheet(data);
    const wsGastos = XLSX.utils.json_to_sheet(Store.getGastos().map(g=>({Fecha:g.fecha, Descripcion:g.descripcion, Categoria:g.categoria, Monto:g.monto})));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Resumen Finanzas');
    XLSX.utils.book_append_sheet(wb, wsGastos, 'Gastos');
    this._download(wb, 'KJConcept_Finanzas.xlsx');
  },
  mermas(){
    const data = Store.getMermas().map(m=>({
      Fecha:m.fecha, Material:m.materialNombre, Cantidad:m.cantidad, Unidad:m.unidad,
      'Costo Unitario':m.costoUnitario, 'Costo Total':m.costoTotal, Motivo:m.motivo, Observaciones:m.observaciones||''
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Mermas');
    this._download(wb, 'KJConcept_Mermas.xlsx');
  },
  backupJSON(){
    const data = Store.backupJSON();
    const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `KJConcept_Respaldo_${Utils.todayISO()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    Toast.show('success','Respaldo JSON descargado.');
  },
  importJSON(e){
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = (ev)=>{
      try{
        const data = JSON.parse(ev.target.result);
        Modal.confirm('Esto reemplazará todos los datos actuales con los del archivo importado. ¿Continuar?', ()=>{
          Store.restoreJSON(data);
          Toast.show('success','Datos importados correctamente.');
          App.renderCurrentView();
        }, 'Importar respaldo');
      }catch(err){
        Toast.show('error','El archivo JSON no es válido.');
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  }
};

/* ---------------------------------------------------------------------- */
/* APP — Navigation, theming, bootstrap                                    */
/* ---------------------------------------------------------------------- */
const App = {
  currentTab: 'dashboard',
  async init(){
    await Auth.init();          // espera a que haya sesión (login compartido)
    await Store.init();         // trae inventario/ventas/etc. desde Supabase

    const cfg = Store.getConfig();
    this.applyTheme(cfg.tema);
    this.applyBrand(cfg.nombreNegocio);

    this.bindNav();
    this.bindThemeToggle();
    this.bindMobileMenu();
    this.bindLogout();

    DashboardView.init();
    NuevoTrabajoView.init();
    InventarioView.init();
    ComprasView.init();
    HistorialView.init();
    FinanzasView.init();
    ConfigView.init();

    this.goTo('dashboard');
    this.refreshBadges();
  },
  bindNav(){
    document.querySelectorAll('[data-tab]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const tab = btn.dataset.tab;
        if(tab === 'mas'){
          document.getElementById('moreSheet').classList.toggle('open');
          return;
        }
        document.getElementById('moreSheet').classList.remove('open');
        this.goTo(tab);
      });
    });
  },
  bindThemeToggle(){
    document.getElementById('themeToggle').onclick = ()=>{
      const cfg = Store.getConfig();
      cfg.tema = cfg.tema === 'dark' ? 'light' : 'dark';
      Store.setConfig(cfg);
      this.applyTheme(cfg.tema);
      ConfigView.render();
      Charts.renderAll();
    };
  },
  bindMobileMenu(){
    document.getElementById('menuBtn').onclick = ()=>{
      document.getElementById('moreSheet').classList.toggle('open');
    };
  },
  bindLogout(){
    const btn = document.getElementById('logoutBtn');
    if(btn) btn.onclick = ()=> Auth.logout();
  },
  applyTheme(theme){
    document.documentElement.setAttribute('data-theme', theme==='light'?'light':'dark');
    document.getElementById('themeToggle').textContent = theme==='light' ? '◑' : '◐';
  },
  applyBrand(name){
    document.getElementById('brandName').textContent = name || 'KJ Concept';
    document.title = `${name || 'KJ Concept'} — Panel de Control`;
  },
  goTo(tab){
    this.currentTab = tab;
    document.querySelectorAll('.nav-item').forEach(b=> b.classList.toggle('active', b.dataset.tab===tab));
    document.querySelectorAll('.bn-item').forEach(b=> b.classList.toggle('active', b.dataset.tab===tab));
    document.querySelectorAll('.view').forEach(v=> v.classList.remove('active'));
    const view = document.getElementById('view-'+tab);
    if(view) view.classList.add('active');

    const titles = {dashboard:'Dashboard', nuevoTrabajo:'Nuevo Trabajo', inventario:'Inventario', compras:'Compras', historial:'Historial', finanzas:'Finanzas', configuracion:'Configuración'};
    document.getElementById('topbarTitle').textContent = titles[tab] || 'Dashboard';

    this.renderCurrentView();
  },
  renderCurrentView(){
    switch(this.currentTab){
      case 'dashboard': DashboardView.render(); break;
      case 'inventario': InventarioView.populateCategoriaFilter(); InventarioView.render(); InventarioView.renderMermas(); break;
      case 'compras': ComprasView.populateDatalists(); ComprasView.render(); break;
      case 'historial': HistorialView.render(); break;
      case 'finanzas': FinanzasView.render(); break;
      case 'configuracion': ConfigView.render(); break;
      case 'nuevoTrabajo': NuevoTrabajoView.renderRows(); break;
    }
  },
  refreshBadges(){
    const estado = Calc.estadoFinanciero();
    const pill = document.getElementById('sidebarStatusPill');
    const map = {ganancias:{cls:'', text:'GANANCIAS'}, equilibrio:{cls:'warn', text:'EQUILIBRIO'}, rojo:{cls:'danger', text:'EN ROJO'}};
    pill.className = 'status-pill ' + map[estado].cls;
    document.getElementById('sidebarStatusText').textContent = map[estado].text;

    if(this.currentTab === 'dashboard') DashboardView.render();
    if(this.currentTab === 'finanzas') FinanzasView.render();
    if(this.currentTab === 'inventario'){ InventarioView.render(); InventarioView.renderMermas(); }
    if(this.currentTab === 'compras') ComprasView.render();
  }
};

document.addEventListener('DOMContentLoaded', ()=> App.init());
