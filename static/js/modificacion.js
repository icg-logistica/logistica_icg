// ===== SECCIÓN 6 — Modificación manual de rutas =====
// Cambios: verifica sesión activa al iniciar y maneja 400 en todos los fetches.
// Los pesos y rutas ahora se leen de MongoDB vinculados a la logística activa.

let _rutas           = [];
let _rutasFiltradas  = [];
let _pesos           = {};
let _sucDisponibles  = [];
let _indiceActivo    = 0;
let _tiempos         = {};
let _confirmadas     = {};
let _diaActivo       = "__todos__";
let _mapa            = null;
let _rutaLayer       = null;
let _markersLayer    = null;
let _cancelarBatch   = false;

const MSG_MOD = {
  recalcular: [
    "Consultando servicio OSRM…",
    "Calculando trayecto real por carretera…",
    "Procesando segmentos de la ruta…",
    "Actualizando tiempos estimados…",
  ],
  guardar: [
    "Guardando rutas modificadas…",
    "Registrando sucursales por ruta…",
    "Actualizando tiempos y pesos…",
    "Finalizando guardado…",
  ],
};

const MIN_DESCARGA_POR_KG  = 0.1;
const MAX_DESCARGA_MIN     = 120;
const HORAS_EXTRA_RUTA_MIN = 0;

const DIAS_ORDEN = [
  { key: "lunes", label: "Lun" }, { key: "martes", label: "Mar" },
  { key: "miercoles", label: "Mié" }, { key: "jueves", label: "Jue" },
  { key: "viernes", label: "Vie" }, { key: "sabado", label: "Sáb" },
  { key: "domingo", label: "Dom" },
];

document.addEventListener("DOMContentLoaded", async () => {
  const activa = await verificarSesionLogistica();
  if (!activa) return;
  await cargarDatos();
  bindEventos();
});

// ── Verificar sesión ─────────────────────────────────────────
async function verificarSesionLogistica() {
  try {
    const res  = await fetch('/api/activa');
    const data = await res.json();
    if (data.status !== 'ok') { redirigirAlMenu('No hay ninguna logística activa.'); return false; }
    return true;
  } catch { redirigirAlMenu('Error de conexión.'); return false; }
}
function redirigirAlMenu(msg) {
  alert(`⚠ ${msg}\n\nSerás redirigido al menú principal.`);
  window.location.href = '/';
}

function bindEventos() {
  document.getElementById("btn-recalcular").addEventListener("click", recalcularActiva);
  document.getElementById("btn-confirmar").addEventListener("click", confirmarActiva);
  // ── Nuevas acciones del header ──────────────────────────────
  document.getElementById("btn-autorizar-todas").addEventListener("click", autorizarTodas);
  document.getElementById("btn-guardar-solo").addEventListener("click",   () => guardarTodo(false));
  document.getElementById("btn-guardar-seguir").addEventListener("click", () => guardarTodo(true));
  // ────────────────────────────────────────────────────────────
  document.getElementById("btn-agregar-suc").addEventListener("click", abrirModalAgregar);
  document.getElementById("modal-agregar-close").addEventListener("click", cerrarModalAgregar);
  document.getElementById("buscar-sucursal").addEventListener("input", filtrarDisponibles);
  document.getElementById("modal-agregar").addEventListener("click", (e) => {
    if (e.target.id === "modal-agregar") cerrarModalAgregar();
  });
  document.getElementById("btn-calcular-todas").addEventListener("click", calcularTodasOSRM);
  document.getElementById("btn-cancelar-osrm").addEventListener("click", () => { _cancelarBatch = true; });
}

async function cargarDatos() {
  const banner = document.getElementById("banner-cargando");
  banner.style.display = "flex";

  try {
    const [rutasRes, pesosRes, sucRes] = await Promise.all([
      fetch("/modificacion/rutas"),
      fetch("/modificacion/pesos"),
      fetch("/modificacion/sucursales"),
    ]);

    if (rutasRes.status === 400 || pesosRes.status === 400) {
      redirigirAlMenu('Sin logística activa.');
      return;
    }

    const rutasData = await rutasRes.json();
    _pesos          = await pesosRes.json();
    _sucDisponibles = await sucRes.json();

    if (rutasData.status !== "ok" || !rutasData.rutas || rutasData.rutas.length === 0) {
      banner.style.display = "none";
      document.getElementById("estado-vacio").style.display = "block";
      return;
    }

    _rutas = rutasData.rutas;
    document.getElementById("cnt-autorizadas").textContent = rutasData.total_autorizadas || 0;
    document.getElementById("cnt-subrutas").textContent    = rutasData.total_subrutas || 0;
    document.getElementById("resumen-fuentes").style.display = "flex";

    inicializarMapa();
    actualizarStatusOSRM();
    renderFiltroDias();
    aplicarFiltroDia("__todos__");

    banner.style.display = "none";
    document.getElementById("filtro-dias").style.display    = "flex";
    document.getElementById("panel-principal").style.display = "grid";

  } catch (err) {
    console.error("[cargarDatos]", err);
    banner.style.display = "none";
    document.getElementById("estado-vacio").style.display = "block";
  }
}

// ── OSRM: cálculo individual ─────────────────────────────────
async function calcularOSRMParaRuta(ruta) {
  if (!ruta.sucursales || ruta.sucursales.length === 0) {
    _tiempos[ruta.id] = tiempoVacio(); return;
  }
  const statusEl = document.getElementById("osrm-ruta-status");
  statusEl.style.display = "flex";
  try {
    const res = await fetch("/modificacion/recalcular-tiempos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sucursales: ruta.sucursales }),
    });
    if (res.status === 400) { redirigirAlMenu('Sin logística activa.'); return; }
    _tiempos[ruta.id] = res.ok ? await res.json() : { ...tiempoVacio(), origen_tiempo: "error" };
  } catch (err) {
    console.error(`[OSRM:${ruta.id}]`, err);
    _tiempos[ruta.id] = { ...tiempoVacio(), origen_tiempo: "error" };
  }
  statusEl.style.display = "none";
  actualizarStatusOSRM();
}

function tiempoVacio() {
  return {
    traslado_min: 0, descarga_min: 0, extra_min: HORAS_EXTRA_RUTA_MIN,
    total_min: 0, distancia_km: 0,
    origen_tiempo: "pendiente", geometry: [], hora_regreso: "—", matriz: null,
  };
}

function rutaTieneOSRM(rutaId) {
  const t = _tiempos[rutaId];
  return t && t.origen_tiempo && t.origen_tiempo !== "pendiente" && t.origen_tiempo !== "error";
}

// ── OSRM: cálculo batch ──────────────────────────────────────
async function calcularTodasOSRM() {
  const btn = document.getElementById("btn-calcular-todas");
  btn.disabled = true;
  _cancelarBatch = false;
  const banner = document.getElementById("banner-osrm");
  const texto  = document.getElementById("banner-osrm-texto");
  const fill   = document.getElementById("osrm-progress-fill");
  banner.style.display = "flex";

  const pendientes = _rutas.filter(r => !rutaTieneOSRM(r.id) && r.sucursales?.length > 0);
  const total = pendientes.length;
  let completadas = 0;

  for (const ruta of pendientes) {
    if (_cancelarBatch) break;
    texto.textContent = `Calculando ${ruta.nombre} (${completadas + 1}/${total})…`;
    fill.style.width  = `${(completadas / total) * 100}%`;
    try {
      const res = await fetch("/modificacion/recalcular-tiempos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sucursales: ruta.sucursales }),
      });
      if (res.status === 400) { redirigirAlMenu('Sin logística activa.'); return; }
      _tiempos[ruta.id] = res.ok ? await res.json() : { ...tiempoVacio(), origen_tiempo: "error" };
    } catch {
      _tiempos[ruta.id] = { ...tiempoVacio(), origen_tiempo: "error" };
    }
    completadas++;
    actualizarStatusOSRM();
    renderNavRutas();
    if (_rutasFiltradas[_indiceActivo]?.id === ruta.id) renderContenidoRuta(_rutasFiltradas[_indiceActivo]);
    if (!_cancelarBatch && completadas < total) await sleep(1200);
  }

  fill.style.width = "100%";
  texto.textContent = _cancelarBatch
    ? `Detenido. ${completadas} de ${total} calculadas.`
    : `✓ ${completadas} rutas calculadas con OSRM.`;
  setTimeout(() => { banner.style.display = "none"; btn.disabled = false; }, 2000);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function actualizarStatusOSRM() {
  const total      = _rutas.filter(r => r.sucursales?.length > 0).length;
  const calculadas = _rutas.filter(r => rutaTieneOSRM(r.id)).length;
  const dot        = document.querySelector(".osrm-dot");
  const text       = document.getElementById("osrm-status-text");
  const btn        = document.getElementById("btn-calcular-todas");
  text.textContent = `OSRM: ${calculadas} / ${total} calculadas`;
  dot.className = "osrm-dot " + (calculadas === total ? "completo" : calculadas > 0 ? "calculando" : "pendiente");
  btn.disabled = calculadas === total;
  btn.textContent = calculadas === total ? "✓ Todas calculadas" : `🗺️ Calcular ${total - calculadas} rutas restantes`;
}

// ── Mapa Leaflet ────────────────────────────────────────────
function inicializarMapa() {
  _mapa = L.map("mapa", { zoomControl: true }).setView([18.87, -96.95], 9);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>', maxZoom: 18,
  }).addTo(_mapa);
  _markersLayer = L.layerGroup().addTo(_mapa);
  _rutaLayer    = L.layerGroup().addTo(_mapa);
}

function actualizarMapa(ruta) {
  if (!_mapa) return;
  _markersLayer.clearLayers();
  _rutaLayer.clearLayers();
  const tiempos    = _tiempos[ruta.id] || {};
  const sucursales = ruta.sucursales || [];
  const bounds     = [];

  if (tiempos.matriz) {
    const [lat, lon] = tiempos.matriz;
    bounds.push([lat, lon]);
    L.marker([lat, lon], {
      icon: L.divIcon({ className: "", html: '<div class="marker-matriz">M</div>', iconSize: [32,32], iconAnchor: [16,16] }),
    }).bindPopup("<b>Matriz / Bodega</b>").addTo(_markersLayer);
  }

  sucursales.forEach((suc, i) => {
    if (suc.latitud == null || suc.longitud == null) return;
    bounds.push([suc.latitud, suc.longitud]);
    const peso = _pesos[String(suc.num_tienda)] || suc.peso_kg || 0;
    L.marker([suc.latitud, suc.longitud], {
      icon: L.divIcon({ className: "", html: `<div class="marker-orden">${i+1}</div>`, iconSize: [28,28], iconAnchor: [14,14] }),
    }).bindPopup(`<b>${i+1}. ${h(suc.nombre)}</b><br>#${suc.num_tienda}<br>${peso} kg`).addTo(_markersLayer);
  });

  if (tiempos.geometry && tiempos.geometry.length > 1) {
    const latlngs = tiempos.geometry.map(c => [c[1], c[0]]);
    L.polyline(latlngs, { color: "#2563eb", weight: 4, opacity: 0.85, lineJoin: "round" }).addTo(_rutaLayer);
  } else if (sucursales.length > 0 && tiempos.matriz) {
    const pts = [tiempos.matriz];
    sucursales.forEach(s => { if (s.latitud != null && s.longitud != null) pts.push([s.latitud, s.longitud]); });
    pts.push(tiempos.matriz);
    L.polyline(pts, { color: "#94a3b8", weight: 2, opacity: 0.6, dashArray: "8 6" }).addTo(_rutaLayer);
  }

  if (bounds.length > 0) _mapa.fitBounds(bounds, { padding: [40,40], maxZoom: 13 });
}

// ── Filtro por día ──────────────────────────────────────────
function renderFiltroDias() {
  const conteo = {};
  _rutas.forEach(r => { conteo[r.dia] = (conteo[r.dia] || 0) + 1; });
  const container = document.getElementById("filtro-dias");
  let html = `<button class="filtro-dia-btn activo" data-dia="__todos__">Todas <span class="cnt">(${_rutas.length})</span></button>`;
  DIAS_ORDEN.forEach(({ key, label }) => {
    if (!conteo[key]) return;
    html += `<button class="filtro-dia-btn" data-dia="${key}">${label} <span class="cnt">(${conteo[key]})</span></button>`;
  });
  container.innerHTML = html;
  container.querySelectorAll(".filtro-dia-btn").forEach(btn => {
    btn.addEventListener("click", () => aplicarFiltroDia(btn.dataset.dia));
  });
}

function aplicarFiltroDia(diaKey) {
  _diaActivo = diaKey;
  document.querySelectorAll(".filtro-dia-btn").forEach(btn =>
    btn.classList.toggle("activo", btn.dataset.dia === diaKey));
  _rutasFiltradas = diaKey === "__todos__" ? _rutas : _rutas.filter(r => r.dia === diaKey);
  _indiceActivo = 0;
  renderNavRutas();
  if (_rutasFiltradas.length > 0) seleccionarRuta(0);
}

// ── Navegador de rutas ──────────────────────────────────────
function renderNavRutas() {
  const nav = document.getElementById("nav-rutas");
  if (_rutasFiltradas.length === 0) {
    nav.innerHTML = '<div style="color:#94a3b8;font-size:0.82rem;padding:8px">No hay rutas en este día.</div>';
    return;
  }
  nav.innerHTML = _rutasFiltradas.map((ruta, i) => {
    const n       = ruta.sucursales?.length || ruta.num_sucursales || 0;
    const tiene   = rutaTieneOSRM(ruta.id);
    const esError = _tiempos[ruta.id]?.origen_tiempo === "error";
    const dotClass = tiene ? "osrm-ok" : esError ? "osrm-fail" : "osrm-pending";
    const dotText  = tiene ? "OSRM ✓" : esError ? "Error" : "Pendiente";
    const tipoClass = ruta.tipo === "subruta" ? "tipo-subruta" : "tipo-autorizada";
    return `
      <button class="nav-ruta-btn${i === _indiceActivo ? " activo" : ""}${_confirmadas[ruta.id] ? " confirmada" : ""}" data-idx="${i}">
        <div class="nav-ruta-nombre">${h(ruta.nombre)}</div>
        <div class="nav-ruta-dia">${capitalizar(ruta.dia)} · ${n} paradas</div>
        <div class="nav-ruta-info">${ruta.vehiculo_abrev || "—"} · ${ruta.vehiculo_placas || "—"}</div>
        <span class="nav-ruta-tipo ${tipoClass}">${ruta.tipo === "subruta" ? "subruta" : "autorizada"}</span>
        <div class="nav-ruta-osrm"><span class="mini-dot ${dotClass}"></span> ${dotText}</div>
      </button>`;
  }).join("");
  nav.querySelectorAll(".nav-ruta-btn").forEach(btn => {
    btn.addEventListener("click", () => seleccionarRuta(Number(btn.dataset.idx)));
  });
  actualizarProgreso();
}

// ── Seleccionar ruta ────────────────────────────────────────
async function seleccionarRuta(idx) {
  if (idx < 0 || idx >= _rutasFiltradas.length) return;
  _indiceActivo = idx;
  const ruta = _rutasFiltradas[idx];

  document.querySelectorAll(".nav-ruta-btn").forEach((btn, i) =>
    btn.classList.toggle("activo", i === idx));

  document.getElementById("titulo-ruta").textContent = ruta.nombre;
  const pesoTotal = calcularPesoRuta(ruta);
  document.getElementById("meta-ruta").innerHTML = `
    <span class="meta-item">📅 ${capitalizar(ruta.dia)}</span>
    <span class="meta-item">🚚 ${ruta.vehiculo_abrev || "—"} (${ruta.vehiculo_placas || "—"})</span>
    <span class="meta-item">📦 ${pesoTotal} kg</span>
    ${ruta.parte ? `<span class="meta-item">Parte ${ruta.parte} de ${ruta.total_partes}</span>` : ""}
  `;

  const tipoBadge = document.getElementById("tipo-badge-wrap");
  if (ruta.tipo === "subruta") {
    tipoBadge.innerHTML = `<span class="tipo-badge subruta">⚡ Subruta — de ${h(ruta.ruta_origen_nombre || "")}</span>`;
  } else {
    tipoBadge.innerHTML = `<span class="tipo-badge autorizada">✓ Ruta autorizada</span>`;
  }

  const btnConf = document.getElementById("btn-confirmar");
  if (_confirmadas[ruta.id]) {
    btnConf.textContent = "✓ Ruta confirmada"; btnConf.classList.add("confirmada"); btnConf.disabled = true;
  } else {
    btnConf.textContent = "✓ Confirmar ruta"; btnConf.classList.remove("confirmada"); btnConf.disabled = false;
  }

  renderListaSucursales(ruta);

  if (!rutaTieneOSRM(ruta.id)) {
    renderResumenTiempos(ruta);
    renderIndicadores(ruta);
    actualizarMapa(ruta);
    await calcularOSRMParaRuta(ruta);
    renderNavRutas();
    if (_rutasFiltradas[_indiceActivo]?.id === ruta.id) renderContenidoRuta(ruta);
  } else {
    renderContenidoRuta(ruta);
  }

  setTimeout(() => _mapa && _mapa.invalidateSize(), 100);
}

function renderContenidoRuta(ruta) {
  renderResumenTiempos(ruta);
  renderIndicadores(ruta);
  actualizarMapa(ruta);
}

function renderResumenTiempos(ruta) {
  const t = _tiempos[ruta.id] || {};
  const origenClass = t.origen_tiempo === "osrm" ? "osrm" : t.origen_tiempo === "haversine_fallback" ? "haversine" : "pendiente";
  const origenLabel = t.origen_tiempo === "osrm" ? "🛣️ OSRM real" : t.origen_tiempo === "haversine_fallback" ? "📐 Haversine" : "⏳ Pendiente";
  document.getElementById("resumen-tiempos").innerHTML = `
    <div class="tiempo-celda"><div class="t-label">Conducción</div><div class="t-valor">${formatMin(t.traslado_min)}</div></div>
    <div class="tiempo-celda"><div class="t-label">Descarga</div><div class="t-valor">${formatMin(t.descarga_min)}</div></div>
    <div class="tiempo-celda"><div class="t-label">Distancia</div><div class="t-valor">${t.distancia_km ? t.distancia_km + " km" : "…"}</div></div>
    <div class="tiempo-celda"><div class="t-label">Fuente</div><div class="t-valor"><span class="origen-badge ${origenClass}">${origenLabel}</span></div></div>
  `;
}

function renderIndicadores(ruta) {
  const zona = document.getElementById("zona-indicadores");
  const t    = _tiempos[ruta.id] || {};
  const pesoKg = calcularPesoRuta(ruta);
  let capTon = ruta.capacidad_ton;
  if (!capTon && ruta.pct_utilizacion > 0 && pesoKg > 0) {
    capTon = parseFloat(((pesoKg / 1000) / (ruta.pct_utilizacion / 100)).toFixed(2));
  }
  capTon = capTon || 2.5;
  const pct      = (pesoKg / 1000 / capTon) * 100;
  const barClass = pct <= 100 ? "verde" : pct <= 120 ? "naranja" : "rojo";
  const horaReg  = t.hora_regreso || ruta.hora_regreso || "—";
  const cumple   = ruta.cumple_horario !== false;

  zona.innerHTML = `
    <div class="cap-bar-wrap">
      <div class="cap-bar-label">
        <span>Utilización: ${pct.toFixed(1)}%</span>
        <span>${(pesoKg / 1000).toFixed(2)} / ${capTon} ton</span>
      </div>
      <div class="cap-bar"><div class="cap-bar-fill ${barClass}" style="width:${Math.min(pct,100)}%"></div></div>
    </div>
    <div class="hora-regreso">
      <span>Salida: ${ruta.hora_salida || "08:00"} · Regreso estimado:</span>
      <span class="badge-hora ${cumple ? "ok" : "tarde"}">${horaReg}</span>
      ${!cumple ? '<span style="font-size:0.72rem;color:#991b1b">⚠ Fuera de horario</span>' : ""}
    </div>
  `;
}

// ── Lista de sucursales con drag-and-drop ────────────────────
function renderListaSucursales(ruta) {
  const lista = document.getElementById("lista-sucursales");
  const sucursales = ruta.sucursales || [];
  if (sucursales.length === 0) {
    lista.innerHTML = '<div class="lista-sucursales-vacia">Esta ruta no tiene sucursales asignadas.</div>';
    return;
  }
  lista.innerHTML = sucursales.map((suc, i) => {
    const peso    = _pesos[String(suc.num_tienda)] || suc.peso_kg || 0;
    const descMin = Math.min(peso * MIN_DESCARGA_POR_KG, MAX_DESCARGA_MIN).toFixed(0);
    const sinCoords = (suc.latitud == null || suc.longitud == null);
    return `
      <div class="suc-item" draggable="true" data-idx="${i}">
        <span class="suc-grip">⠿</span>
        <span class="suc-orden">${i+1}</span>
        <div class="suc-info">
          <div class="suc-nombre">${h(suc.nombre)}${sinCoords ? ' <span style="color:#ef4444;font-size:0.65rem">⚠ sin coords</span>' : ''}</div>
          <div class="suc-detalle">#${suc.num_tienda} · ${peso} kg · ~${descMin} min descarga</div>
        </div>
        <button class="suc-quitar" data-idx="${i}" title="Quitar de la ruta">&times;</button>
      </div>`;
  }).join("");
  setupDragAndDrop(lista, ruta);
  lista.querySelectorAll(".suc-quitar").forEach(btn => {
    btn.addEventListener("click", (e) => { e.stopPropagation(); quitarSucursal(ruta, Number(btn.dataset.idx)); });
  });
}

function setupDragAndDrop(container, ruta) {
  let dragIdx = null;
  container.querySelectorAll(".suc-item").forEach(item => {
    item.addEventListener("dragstart", (e) => { dragIdx = Number(item.dataset.idx); item.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
    item.addEventListener("dragend",   () => { item.classList.remove("dragging"); container.querySelectorAll(".suc-item").forEach(el => el.classList.remove("drag-over")); });
    item.addEventListener("dragover",  (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; container.querySelectorAll(".suc-item").forEach(el => el.classList.remove("drag-over")); item.classList.add("drag-over"); });
    item.addEventListener("dragleave", () => item.classList.remove("drag-over"));
    item.addEventListener("drop", (e) => {
      e.preventDefault();
      const dropIdx = Number(item.dataset.idx);
      if (dragIdx === null || dragIdx === dropIdx) return;
      const arr = ruta.sucursales;
      const [moved] = arr.splice(dragIdx, 1);
      arr.splice(dropIdx, 0, moved);
      arr.forEach((s, i) => { s.orden = i + 1; });
      delete _tiempos[ruta.id];
      marcarNoConfirmada(ruta);
      renderListaSucursales(ruta);
      actualizarStatusOSRM();
      renderNavRutas();
      calcularOSRMParaRuta(ruta).then(() => {
        if (_rutasFiltradas[_indiceActivo]?.id === ruta.id) { renderContenidoRuta(ruta); renderNavRutas(); }
      });
      dragIdx = null;
    });
  });
}

function quitarSucursal(ruta, idx) {
  if (!confirm(`¿Quitar "${ruta.sucursales[idx].nombre}" de esta ruta?`)) return;
  ruta.sucursales.splice(idx, 1);
  ruta.sucursales.forEach((s, i) => { s.orden = i + 1; });
  ruta.num_sucursales = ruta.sucursales.length;
  delete _tiempos[ruta.id];
  marcarNoConfirmada(ruta);
  renderListaSucursales(ruta);
  actualizarStatusOSRM();
  renderNavRutas();
  calcularOSRMParaRuta(ruta).then(() => {
    if (_rutasFiltradas[_indiceActivo]?.id === ruta.id) { renderContenidoRuta(ruta); renderNavRutas(); }
  });
}

function marcarNoConfirmada(ruta) {
  if (_confirmadas[ruta.id]) { delete _confirmadas[ruta.id]; actualizarProgreso(); }
}

function abrirModalAgregar() {
  document.getElementById("modal-agregar").classList.remove("hidden");
  document.getElementById("buscar-sucursal").value = "";
  renderDisponibles("");
  setTimeout(() => document.getElementById("buscar-sucursal").focus(), 100);
}
function cerrarModalAgregar() { document.getElementById("modal-agregar").classList.add("hidden"); }
function filtrarDisponibles() { renderDisponibles(document.getElementById("buscar-sucursal").value); }

function renderDisponibles(query) {
  const ruta   = _rutasFiltradas[_indiceActivo];
  const enRuta = new Set((ruta.sucursales || []).map(s => String(s.num_tienda)));
  const q      = (query || "").toLowerCase().trim();
  const lista  = _sucDisponibles.filter(s =>
    !q || (s.nombre || "").toLowerCase().includes(q) || String(s.num_tienda).includes(q)
  ).slice(0, 50);

  document.getElementById("lista-disponibles").innerHTML = lista.map(s => {
    const ya = enRuta.has(String(s.num_tienda));
    return `
      <div class="disp-item" data-nt="${s.num_tienda}">
        <div><span class="nombre">${h(s.nombre)}</span><span class="num">#${s.num_tienda}</span></div>
        ${ya ? '<span class="ya-en-ruta">Ya en ruta</span>' : '<span style="color:#2563eb;font-size:0.75rem;font-weight:600">+ Agregar</span>'}
      </div>`;
  }).join("");

  document.getElementById("lista-disponibles").querySelectorAll(".disp-item").forEach(item => {
    item.addEventListener("click", () => {
      const nt  = Number(item.dataset.nt);
      const suc = _sucDisponibles.find(s => s.num_tienda === nt);
      if (!suc || enRuta.has(String(nt))) return;
      agregarSucursal(ruta, suc);
      cerrarModalAgregar();
    });
  });
}

function agregarSucursal(ruta, suc) {
  const peso = _pesos[String(suc.num_tienda)] || 0;
  ruta.sucursales.push({
    num_tienda: suc.num_tienda, nombre: suc.nombre,
    latitud: suc.latitud, longitud: suc.longitud,
    peso_kg: peso,
    descarga_min: Math.min(peso * MIN_DESCARGA_POR_KG, MAX_DESCARGA_MIN),
    orden: ruta.sucursales.length + 1,
  });
  ruta.num_sucursales = ruta.sucursales.length;
  delete _tiempos[ruta.id];
  marcarNoConfirmada(ruta);
  renderListaSucursales(ruta);
  actualizarStatusOSRM();
  renderNavRutas();
  calcularOSRMParaRuta(ruta).then(() => {
    if (_rutasFiltradas[_indiceActivo]?.id === ruta.id) { renderContenidoRuta(ruta); renderNavRutas(); }
  });
}

async function recalcularActiva() {
  const ruta = _rutasFiltradas[_indiceActivo];
  const btn  = document.getElementById("btn-recalcular");
  btn.disabled = true; btn.textContent = "⏳ Calculando…";
  Loader.show('Recalculando Tiempos', MSG_MOD.recalcular);
  try {
    delete _tiempos[ruta.id];
    await calcularOSRMParaRuta(ruta);
    renderContenidoRuta(ruta);
    renderNavRutas();
  } finally {
    Loader.hide();
    btn.disabled = false; btn.textContent = "🔄 Recalcular tiempos";
  }
}

function confirmarActiva() {
  const ruta = _rutasFiltradas[_indiceActivo];
  _confirmadas[ruta.id] = true;
  renderNavRutas();
  seleccionarRuta(_indiceActivo);
  const sig = _rutasFiltradas.findIndex((r, i) => i > _indiceActivo && !_confirmadas[r.id]);
  if (sig !== -1) setTimeout(() => seleccionarRuta(sig), 300);
}

function actualizarProgreso() {
  const total          = _rutas.length;
  const confirmadas    = Object.keys(_confirmadas).length;
  const todoConfirmado = confirmadas >= total && total > 0;

  const badge = document.getElementById("progreso-badge");
  badge.textContent = `${confirmadas} / ${total} confirmadas`;
  badge.classList.toggle("completo", todoConfirmado);

  // "Autorizar todas" activo mientras haya rutas sin confirmar
  const btnAutorizar = document.getElementById("btn-autorizar-todas");
  if (btnAutorizar) {
    btnAutorizar.disabled    = total === 0 || todoConfirmado;
    btnAutorizar.textContent = todoConfirmado ? "✓ Todas autorizadas" : "✓ Autorizar todas";
  }

  // Botones de guardado solo activos cuando todo está confirmado
  const btnSolo   = document.getElementById("btn-guardar-solo");
  const btnSeguir = document.getElementById("btn-guardar-seguir");
  if (btnSolo)   btnSolo.disabled   = !todoConfirmado;
  if (btnSeguir) btnSeguir.disabled = !todoConfirmado;
}

// ── Autorizar todas las rutas de una vez ────────────────────
function autorizarTodas() {
  if (_rutas.length === 0) return;
  const sinConfirmar = _rutas.filter(r => !_confirmadas[r.id]).length;
  if (sinConfirmar === 0) return;

  const plural = sinConfirmar !== 1;
  if (!confirm(
    `¿Confirmar y autorizar ${sinConfirmar} ruta${plural ? "s" : ""} pendiente${plural ? "s" : ""}?\n\n` +
    `Esta acción las marcará todas como revisadas sin necesidad de revisarlas individualmente.`
  )) return;

  _rutas.forEach(r => { _confirmadas[r.id] = true; });
  actualizarProgreso();
  renderNavRutas();

  // Refrescar el botón "Confirmar ruta" de la tarjeta activa
  const btnConf = document.getElementById("btn-confirmar");
  if (btnConf) { btnConf.textContent = "✓ Ruta confirmada"; btnConf.classList.add("confirmada"); btnConf.disabled = true; }

  mostrarToastMod(`✓ ${_rutas.length} ruta${_rutas.length !== 1 ? "s" : ""} autorizadas`, "ok");
}

// ── Guardar todo ────────────────────────────────────────────
async function guardarTodo(redirigir = false) {
  const btnSolo   = document.getElementById("btn-guardar-solo");
  const btnSeguir = document.getElementById("btn-guardar-seguir");
  const btnActivo = redirigir ? btnSeguir : btnSolo;

  // Deshabilitar ambos botones mientras dura el guardado
  if (btnSolo)   btnSolo.disabled   = true;
  if (btnSeguir) btnSeguir.disabled = true;
  if (btnActivo) btnActivo.textContent = "Guardando…";

  Loader.show(redirigir ? 'Guardando y Continuando' : 'Guardando Modificaciones', MSG_MOD.guardar);

  const payload = {
    fecha_modificacion: new Date().toISOString(),
    rutas_confirmadas: _rutas.map(ruta => {
      const t      = _tiempos[ruta.id] || {};
      const pesoKg = calcularPesoRuta(ruta);
      let capTon   = ruta.capacidad_ton;
      if (!capTon && ruta.pct_utilizacion > 0 && pesoKg > 0) {
        capTon = parseFloat(((pesoKg / 1000) / (ruta.pct_utilizacion / 100)).toFixed(2));
      }
      capTon = capTon || 2.5;
      return {
        id: ruta.id, nombre: ruta.nombre, tipo: ruta.tipo, dia: ruta.dia,
        vehiculo_abrev: ruta.vehiculo_abrev, vehiculo_placas: ruta.vehiculo_placas,
        capacidad_ton: capTon,
        peso_kg: pesoKg, peso_ton: parseFloat((pesoKg / 1000).toFixed(3)),
        pct_utilizacion: parseFloat(((pesoKg / 1000 / capTon) * 100).toFixed(1)),
        conduccion_min: t.traslado_min || 0, descarga_min: t.descarga_min || 0,
        extra_min: t.extra_min || HORAS_EXTRA_RUTA_MIN, total_min: t.total_min || 0,
        distancia_km: t.distancia_km || 0,
        hora_salida: ruta.hora_salida || "08:00",
        hora_regreso: t.hora_regreso || ruta.hora_regreso || "—",
        origen_tiempo: t.origen_tiempo || "desconocido",
        ruta_origen_id: ruta.ruta_origen_id || null,
        ruta_origen_nombre: ruta.ruta_origen_nombre || null,
        parte: ruta.parte || null, total_partes: ruta.total_partes || null,
        num_sucursales: (ruta.sucursales || []).length,
        sucursales: (ruta.sucursales || []).map((s, i) => ({
          num_tienda: s.num_tienda, nombre: s.nombre, orden: i + 1,
          peso_kg: _pesos[String(s.num_tienda)] || s.peso_kg || 0,
          descarga_min: parseFloat(Math.min((_pesos[String(s.num_tienda)] || s.peso_kg || 0) * MIN_DESCARGA_POR_KG, MAX_DESCARGA_MIN).toFixed(1)),
          latitud: s.latitud, longitud: s.longitud,
        })),
      };
    }),
  };

  try {
    const res = await fetch("/modificacion/guardar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 400) { Loader.hide(); redirigirAlMenu('Sin logística activa.'); return; }
    if (res.ok) {
      if (redirigir) {
        // Loader permanece visible durante la redirección
        window.location.href = "/pdf/";
        return;
      }
      Loader.hide();
      mostrarToastMod("✓ Rutas guardadas correctamente", "ok");
      if (btnSolo) { btnSolo.textContent = "✓ Guardado"; btnSolo.style.background = "#16a34a"; btnSolo.style.color = "#fff"; }
    } else throw new Error("Error");
  } catch (err) {
    console.error("[guardarTodo]", err);
    Loader.hide();
    mostrarToastMod("✗ Error al guardar", "error");
    if (btnActivo) { btnActivo.textContent = "✗ Error"; btnActivo.style.background = "#dc2626"; btnActivo.style.color = "#fff"; }
  } finally {
    setTimeout(() => {
      const todosOk = Object.keys(_confirmadas).length >= _rutas.length && _rutas.length > 0;
      if (btnSolo)   { btnSolo.disabled = !todosOk;   btnSolo.textContent   = "💾 Guardar";           btnSolo.style.background   = ""; btnSolo.style.color   = ""; }
      if (btnSeguir) { btnSeguir.disabled = !todosOk; btnSeguir.textContent = "💾 Guardar y seguir →"; btnSeguir.style.background = ""; btnSeguir.style.color = ""; }
    }, 2500);
  }
}

// ── Helpers ─────────────────────────────────────────────────
function calcularPesoRuta(ruta) {
  return (ruta.sucursales || []).reduce((sum, s) =>
    sum + (_pesos[String(s.num_tienda)] || s.peso_kg || 0), 0);
}
function formatMin(min) {
  if (min == null) return "…";
  if (min <= 0) return "—";
  if (min < 60) return `${Math.round(min)} min`;
  const hh = Math.floor(min / 60), mm = Math.round(min % 60);
  return mm > 0 ? `${hh}h ${mm}min` : `${hh}h`;
}
function capitalizar(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }
function h(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Toast de notificación ────────────────────────────────────
function mostrarToastMod(msg, tipo = "info") {
  let toast = document.getElementById("mod-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "mod-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = `mod-toast mod-toast--${tipo}`;
  requestAnimationFrame(() => {
    toast.classList.add("visible");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove("visible"), 3000);
  });
}