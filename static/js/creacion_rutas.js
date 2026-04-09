// ===== SECCIÓN 2 — Creación de Rutas =====
// Dependencias CDN: Leaflet 1.9.4 + Leaflet Routing Machine 3.2.12

'use strict';

/* ─────────────────────────────────────────
   CONSTANTES
──────────────────────────────────────────*/
const MATRIZ = { lat: 18.87319171873997, lng: -96.94921750442464, nombre: 'Matriz ICG' };
const ROUTE_COLORS = [
  '#2563eb','#16a34a','#d97706','#9333ea',
  '#db2777','#0891b2','#65a30d','#ea580c',
  '#7c3aed','#0f766e',
];
// ── Mensajes contextuales del loader ─────────────────────────────────────────
const MSG_CR = {
  guardar: [
    "Guardando ruta en la base de datos…",
    "Registrando sucursales asignadas…",
    "Actualizando índice de rutas…",
  ],
  eliminar: [
    "Eliminando ruta…",
    "Actualizando base de datos…",
  ],
  calcular: [
    "Consultando servicio OSRM…",
    "Calculando trayecto real por carretera…",
    "Procesando segmentos de ruta…",
    "Actualizando mapa…",
  ],
};

const DIAS_COLORS = {
  'Lunes':     { bg:'#eff6ff', text:'#1d4ed8' },
  'Martes':    { bg:'#f0fdf4', text:'#15803d' },
  'Miércoles': { bg:'#fefce8', text:'#b45309' },
  'Jueves':    { bg:'#fdf4ff', text:'#7e22ce' },
  'Viernes':   { bg:'#fff1f2', text:'#be123c' },
};
const API = {
  rutas:          '/creacion-rutas/rutas',
  rutaDetalle:    (id) => `/creacion-rutas/rutas/${id}`,
  rutaCalcular:   (id) => `/creacion-rutas/rutas/${id}/calcular`,
  sucDisponibles: '/creacion-rutas/sucursales-disponibles',
  sucTodasLibres: (excluirId) => `/creacion-rutas/sucursales-disponibles${excluirId ? '?excluir_ruta='+excluirId : ''}`,
};

/* ─────────────────────────────────────────
   ESTADO GLOBAL
──────────────────────────────────────────*/
let mapa       = null;
let rutaActual = null;       // id de ruta seleccionada en sidebar
let todasLasRutas  = [];     // cache de rutas
let capasRutas     = {};     // { id: { polylines[], markers[], tipo: 'simple'|'real' } }
let modoVerTodas   = false;
let ordenActual    = 'nombre-asc';  // Opciones: nombre-asc, nombre-desc, fecha-desc, fecha-asc, paradas-desc

// Estado del modal
let modalMode          = null;  // 'crear' | 'editar'
let editandoRutaId     = null;
let sucursalesDisponibles = [];
let sucursalesEnRuta      = [];
let selDisponibles  = new Set();
let selAsignadas    = new Set();

// Estado del botón calcular ruta real
let calculandoRutaReal = false;

// Estado del cálculo masivo OSRM
let calculandoTodas     = false;
let cancelarBatchOSRM   = false;

/* ─────────────────────────────────────────
   INIT
──────────────────────────────────────────*/
document.addEventListener('DOMContentLoaded', () => {
  initMapa();
  bindUI();
  cargarRutas();
});

/* ─────────────────────────────────────────
   MAPA
──────────────────────────────────────────*/
function initMapa() {
  mapa = L.map('mapa-rutas', { zoomControl: false }).setView([MATRIZ.lat, MATRIZ.lng], 12);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(mapa);

  L.control.zoom({ position: 'bottomright' }).addTo(mapa);

  // Marcador de la Matriz
  const iconMatriz = L.divIcon({
    html: `<div style="
      background:#1a1d23;color:#fff;border-radius:50%;
      width:32px;height:32px;display:flex;align-items:center;justify-content:center;
      font-size:11px;font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,.4);
      font-family:'DM Sans',sans-serif;
    ">M</div>`,
    className: '',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
  L.marker([MATRIZ.lat, MATRIZ.lng], { icon: iconMatriz, zIndexOffset: 1000 })
   .bindTooltip(`<strong>${MATRIZ.nombre}</strong><br><small>Punto de inicio y fin</small>`, { permanent: false })
   .addTo(mapa);
}

function mostrarLoader(visible, mensaje) {
  const loader = document.getElementById('mapa-loader');
  loader.style.display = visible ? 'flex' : 'none';
  if (mensaje) {
    const span = loader.querySelector('span');
    if (span) span.textContent = mensaje;
  }
}

/* ─────────────────────────────────────────
   RUTA SIMPLIFICADA (inmediata)
   Dibuja líneas rectas entre waypoints.
──────────────────────────────────────────*/
function dibujarRutaSimple(ruta, colorOverride) {
  const color = colorOverride || colorPorRuta(ruta._id);
  limpiarCapaRuta(ruta._id);

  if (!ruta.sucursales || ruta.sucursales.length === 0) return;

  const coords = [
    [MATRIZ.lat, MATRIZ.lng],
    ...ruta.sucursales.map(s => [s.latitud, s.longitud]),
    [MATRIZ.lat, MATRIZ.lng],
  ];

  // Polilínea punteada para indicar que es simplificada
  const polyline = L.polyline(coords, {
    color,
    weight: 3,
    opacity: 0.65,
    dashArray: '8 6',
  }).addTo(mapa);

  const markers = _crearMarcadoresSucursales(ruta, color);

  capasRutas[ruta._id] = { polylines: [polyline], markers, tipo: 'simple' };

  // Ajustar vista al conjunto de puntos
  const bounds = L.latLngBounds(coords);
  mapa.fitBounds(bounds, { padding: [40, 40] });

  // Actualizar panel info lateral (sin tiempo real, sin km exactos)
  _actualizarPanelInfo(ruta, color, {
    tiempo: '— (simplificada)',
    esPrecisa: false,
  });
}

/* ─────────────────────────────────────────
   RUTA REAL (calculada con OSRM vía backend)
──────────────────────────────────────────*/
async function calcularYDibujarRutaReal(ruta) {
  if (calculandoRutaReal) return;
  calculandoRutaReal = true;

  const color = colorPorRuta(ruta._id);
  _setBtnCalcularEstado('cargando');
  Loader.show('Calculando Ruta Real', MSG_CR.calcular);

  try {
    const res  = await fetch(API.rutaCalcular(ruta._id));
    const data = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    // Limpiar capa simplificada (mantenemos marcadores)
    const capaAnterior = capasRutas[ruta._id];
    if (capaAnterior) {
      capaAnterior.polylines?.forEach(p => mapa.removeLayer(p));
    }

    // Dibujar cada segmento con la geometría real
    const polylines = [];
    data.segmentos.forEach(seg => {
      if (!seg.coordenadas || seg.coordenadas.length < 2) return;
      const pl = L.polyline(seg.coordenadas, {
        color,
        weight: 4,
        opacity: 0.9,
        dashArray: null,
      }).addTo(mapa);
      polylines.push(pl);
    });

    // Refrescar marcadores por si no existían aún
    const markers = capaAnterior?.markers?.length
      ? capaAnterior.markers
      : _crearMarcadoresSucursales(ruta, color);

    capasRutas[ruta._id] = { polylines, markers, tipo: 'real' };

    // Ajustar bounds
    const todasCoords = data.segmentos.flatMap(s => s.coordenadas || []);
    if (todasCoords.length) {
      mapa.fitBounds(L.latLngBounds(todasCoords), { padding: [40, 40] });
    }

    // Actualizar panel info con datos reales
    const minutos  = Math.round(data.total_duracion_s / 60);
    const km       = (data.total_distancia_m / 1000).toFixed(1);
    _actualizarPanelInfo(ruta, color, {
      tiempo: `${minutos} min · ${km} km`,
      esPrecisa: true,
      desdeCache: data.desde_cache,
    });

    _setBtnCalcularEstado('completado');

  } catch (err) {
    console.error('Error calculando ruta real:', err);
    _setBtnCalcularEstado('error', err.message);
    Loader.hide();
  } finally {
    calculandoRutaReal = false;
    Loader.hide();
  }
}

/* ─────────────────────────────────────────
   HELPERS DE MAPA
──────────────────────────────────────────*/
function colorPorRuta(id) {
  const idx = todasLasRutas.findIndex(r => r._id === id);
  return ROUTE_COLORS[(idx >= 0 ? idx : 0) % ROUTE_COLORS.length];
}

function _crearMarcadoresSucursales(ruta, color) {
  return ruta.sucursales.map((suc, i) => {
    const icon = L.divIcon({
      html: `<div style="
        background:${color};color:#fff;border-radius:50% 50% 50% 0;
        transform:rotate(-45deg);width:28px;height:28px;
        display:flex;align-items:center;justify-content:center;
        box-shadow:0 2px 6px rgba(0,0,0,.35);
        font-family:'DM Sans',sans-serif;
      ">
        <span style="transform:rotate(45deg);font-weight:700;font-size:11px;">${i + 1}</span>
      </div>`,
      className: '',
      iconSize: [28, 28],
      iconAnchor: [14, 28],
      popupAnchor: [0, -30],
    });

    const popup = `
      <div class="cr-popup">
        <div class="cr-popup__title">
          <span class="cr-popup__order" style="background:${color}">${i + 1}</span>
          ${suc.nombre_base || ''}
        </div>
        <div class="cr-popup__sub">Tienda #${suc.num_tienda}</div>
        <div class="cr-popup__sub">${h(suc.estado || '')}</div>
        <div class="cr-popup__sub">
          <strong>Horario:</strong> ${suc.hora_inicio || '?'} – ${suc.hora_fin || '?'}
        </div>
        <div class="cr-popup__sub">
          <strong>Ruta:</strong> ${ruta.nombre} · ${ruta.dia_sugerido || 'Sin día'}
        </div>
      </div>`;

    return L.marker([suc.latitud, suc.longitud], { icon })
            .bindPopup(popup, { maxWidth: 220 })
            .addTo(mapa);
  });
}

function _actualizarPanelInfo(ruta, color, { tiempo, esPrecisa, desdeCache }) {
  document.getElementById('info-tiempo').innerHTML = esPrecisa
    ? `${tiempo}${desdeCache ? ' <span class="cr-badge-cache" title="Resultado desde caché">⚡ caché</span>' : ''}`
    : `<em style="color:var(--cr-muted)">${tiempo}</em>`;
  document.getElementById('info-paradas').textContent  = `${ruta.sucursales.length} paradas`;
  document.getElementById('info-dia').textContent      = ruta.dia_sugerido || 'Sin día asignado';
  document.getElementById('info-nombre').textContent   = ruta.nombre;
  document.getElementById('info-dot').style.background = color;
  document.getElementById('mapa-info').style.display   = 'block';

  // Mostrar / ocultar botón calcular ruta real
  const btnCalc = document.getElementById('btn-calcular-ruta-real');
  if (btnCalc) {
    btnCalc.style.display = 'inline-flex';
    btnCalc.dataset.rutaId = ruta._id;
    // Si ya es real, cambiar aspecto
    if (esPrecisa) {
      _setBtnCalcularEstado('completado');
    } else {
      _setBtnCalcularEstado('listo');
    }
  }
}

function _setBtnCalcularEstado(estado, errorMsg) {
  const btn = document.getElementById('btn-calcular-ruta-real');
  if (!btn) return;

  btn.disabled = false;
  btn.classList.remove('cr-btn--primary', 'cr-btn--ghost', 'cr-btn--danger', 'cr-btn--success');

  const iconos = {
    listo:      `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>`,
    cargando:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cr-spin-icon"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
    completado: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`,
    error:      `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  };

  const textos = {
    listo:      'Calcular ruta real',
    cargando:   'Calculando…',
    completado: 'Ruta real activa',
    error:      'Reintentar',
  };

  switch (estado) {
    case 'listo':
      btn.classList.add('cr-btn--primary');
      break;
    case 'cargando':
      btn.classList.add('cr-btn--ghost');
      btn.disabled = true;
      break;
    case 'completado':
      btn.classList.add('cr-btn--success');
      break;
    case 'error':
      btn.classList.add('cr-btn--danger');
      if (errorMsg) btn.title = errorMsg;
      break;
  }

  btn.innerHTML = `${iconos[estado] || ''} ${textos[estado] || estado}`;
}

function limpiarCapaRuta(rutaId) {
  const capa = capasRutas[rutaId];
  if (!capa) return;
  capa.polylines?.forEach(p => mapa.removeLayer(p));
  capa.markers?.forEach(m => mapa.removeLayer(m));
  delete capasRutas[rutaId];
}

function limpiarTodasLasCapas() {
  Object.keys(capasRutas).forEach(limpiarCapaRuta);
  document.getElementById('mapa-info').style.display = 'none';
  const btnCalc = document.getElementById('btn-calcular-ruta-real');
  if (btnCalc) btnCalc.style.display = 'none';
}

/* ─────────────────────────────────────────
   RUTAS — CRUD
──────────────────────────────────────────*/
async function cargarRutas() {
  try {
    const res = await fetch(API.rutas);
    if (!res.ok) throw new Error('Error al cargar rutas');
    todasLasRutas = await res.json();
    aplicarFiltros();
  } catch (err) {
    console.error(err);
  }
}

async function guardarRuta() {
  const nombre = document.getElementById('input-nombre-ruta').value.trim();
  const dia    = document.getElementById('select-dia').value;

  if (!nombre) { alertar('Ingresa un nombre para la ruta.'); return; }
  if (sucursalesEnRuta.length === 0) { alertar('Agrega al menos una sucursal.'); return; }

  const payload = {
    nombre,
    dia_sugerido: dia,
    sucursales: sucursalesEnRuta.map((s, i) => ({ ...s, orden: i + 1 })),
  };

  Loader.show(
    modalMode === 'crear' ? 'Creando Ruta' : 'Guardando Cambios',
    MSG_CR.guardar
  );

  try {
    let res, data;
    if (modalMode === 'crear') {
      res  = await fetch(API.rutas, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      data = await res.json();
      if (data.id) {
        todasLasRutas.push({ ...payload, _id: data.id });
      }
    } else {
      res  = await fetch(API.rutaDetalle(editandoRutaId), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      data = await res.json();
      const idx = todasLasRutas.findIndex(r => r._id === editandoRutaId);
      if (idx !== -1) todasLasRutas[idx] = { ...payload, _id: editandoRutaId };
      limpiarCapaRuta(editandoRutaId);
    }
    cerrarModal();
    aplicarFiltros();
    await cargarRutas();
  } catch (err) {
    console.error(err);
    alertar('Error al guardar la ruta.');
  } finally {
    Loader.hide();
  }
}

async function eliminarRuta(id) {
  Loader.show('Eliminando Ruta', MSG_CR.eliminar);
  try {
    await fetch(API.rutaDetalle(id), { method: 'DELETE' });
    limpiarCapaRuta(id);
    todasLasRutas = todasLasRutas.filter(r => r._id !== id);
    aplicarFiltros();
    document.getElementById('mapa-info').style.display = 'none';
    const btnCalc = document.getElementById('btn-calcular-ruta-real');
    if (btnCalc) btnCalc.style.display = 'none';
    cerrarConfirmar();
  } catch (err) {
    console.error(err);
    alertar('Error al eliminar la ruta.');
  } finally {
    Loader.hide();
  }
}

/* ─────────────────────────────────────────
   RENDER LISTA DE RUTAS
──────────────────────────────────────────*/
function renderizarListaRutas(rutas) {
  const contenedor = document.getElementById('lista-rutas');
  const empty      = document.getElementById('empty-rutas');

  contenedor.querySelectorAll('.cr-route-card').forEach(el => el.remove());

  if (rutas.length === 0) {
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';

  rutas.forEach((ruta, i) => {
    const color   = ROUTE_COLORS[i % ROUTE_COLORS.length];
    const diaInfo = DIAS_COLORS[ruta.dia_sugerido] || { bg:'#f3f4f6', text:'#6b7280' };

    const card = document.createElement('div');
    card.className = 'cr-route-card';
    card.dataset.id = ruta._id;
    if (ruta._id === rutaActual) card.classList.add('selected');

    card.innerHTML = `
      <div class="cr-route-card__stripe" style="background:${color}"></div>
      <div class="cr-route-card__body">
        <div class="cr-route-card__top">
          <span class="cr-route-card__name">${ruta.nombre}</span>
          <div class="cr-route-card__actions">
            <button class="cr-icon-btn btn-editar-ruta" data-id="${ruta._id}" title="Editar">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
            <button class="cr-icon-btn cr-icon-btn--danger btn-del-ruta" data-id="${ruta._id}" data-nombre="${ruta.nombre}" title="Eliminar">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="cr-route-card__meta">
          <span class="cr-meta-chip">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            ${ruta.sucursales?.length ?? 0} paradas
          </span>
          ${ruta.creado_en ? `
          <span class="cr-meta-chip cr-meta-chip--time">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            ${_formatearFechaCorta(ruta.creado_en)}
          </span>` : ''}
        </div>
        ${ruta.dia_sugerido ? `
          <span class="cr-day-badge" style="background:${diaInfo.bg};color:${diaInfo.text}">
            ${ruta.dia_sugerido}
          </span>` : ''}
      </div>`;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.cr-icon-btn')) return;
      seleccionarRuta(ruta._id);
    });

    card.querySelector('.btn-editar-ruta').addEventListener('click', (e) => {
      e.stopPropagation();
      abrirModalEditar(ruta._id);
    });

    card.querySelector('.btn-del-ruta').addEventListener('click', (e) => {
      e.stopPropagation();
      mostrarConfirmarEliminar(ruta._id, ruta.nombre);
    });

    contenedor.appendChild(card);
  });
}

function seleccionarRuta(id) {
  if (!modoVerTodas) limpiarTodasLasCapas();

  rutaActual   = id;
  modoVerTodas = false;
  calculandoRutaReal = false;

  document.querySelectorAll('.cr-route-card').forEach(c => {
    c.classList.toggle('selected', c.dataset.id === id);
  });

  const ruta = todasLasRutas.find(r => r._id === id);
  if (ruta) dibujarRutaSimple(ruta);
}

/* ─────────────────────────────────────────
   FILTROS
──────────────────────────────────────────*/
function aplicarFiltros() {
  const busqueda  = document.getElementById('input-buscar-ruta').value.toLowerCase();
  const diaActivo = document.querySelector('.cr-day-btn.active')?.dataset.day || 'todos';

  let filtradas = todasLasRutas.filter(r => {
    const matchNombre = r.nombre.toLowerCase().includes(busqueda);
    const matchDia    = diaActivo === 'todos' || r.dia_sugerido === diaActivo;
    return matchNombre && matchDia;
  });

  // Aplicar ordenamiento
  filtradas = ordenarRutas(filtradas, ordenActual);

  renderizarListaRutas(filtradas);
  actualizarToolbar(filtradas.length);
}

/* ─────────────────────────────────────────
   ORDENAMIENTO
──────────────────────────────────────────*/
function ordenarRutas(rutas, criterio) {
  const copia = [...rutas];
  switch (criterio) {
    case 'nombre-asc':
      copia.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '', 'es'));
      break;
    case 'nombre-desc':
      copia.sort((a, b) => (b.nombre || '').localeCompare(a.nombre || '', 'es'));
      break;
    case 'fecha-desc':
      copia.sort((a, b) => {
        const fa = a.creado_en ? new Date(a.creado_en).getTime() : 0;
        const fb = b.creado_en ? new Date(b.creado_en).getTime() : 0;
        return fb - fa;
      });
      break;
    case 'fecha-asc':
      copia.sort((a, b) => {
        const fa = a.creado_en ? new Date(a.creado_en).getTime() : 0;
        const fb = b.creado_en ? new Date(b.creado_en).getTime() : 0;
        return fa - fb;
      });
      break;
    case 'paradas-desc':
      copia.sort((a, b) => (b.sucursales?.length || 0) - (a.sucursales?.length || 0));
      break;
    default:
      break;
  }
  return copia;
}

const SORT_LABELS = {
  'nombre-asc':   'Nombre A–Z',
  'nombre-desc':  'Nombre Z–A',
  'fecha-desc':   'Más recientes',
  'fecha-asc':    'Más antiguas',
  'paradas-desc': 'Más paradas',
};

function actualizarToolbar(count) {
  const countEl = document.getElementById('results-count');
  const labelEl = document.getElementById('sort-active-label');
  if (countEl) countEl.textContent = `${count} ruta${count !== 1 ? 's' : ''}`;
  if (labelEl) labelEl.textContent = SORT_LABELS[ordenActual] || ordenActual;
}

/* ─────────────────────────────────────────
   VER TODAS EN MAPA (modo simplificado)
──────────────────────────────────────────*/
function verTodasEnMapa() {
  limpiarTodasLasCapas();
  modoVerTodas = true;
  rutaActual   = null;
  document.querySelectorAll('.cr-route-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('mapa-info').style.display = 'none';

  todasLasRutas.forEach((ruta, i) => {
    const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
    dibujarRutaSimple(ruta, color);
  });
}

/* ─────────────────────────────────────────
   CALCULAR TODAS LAS RUTAS REALES (OSRM)
   Secuencial, con progreso y cancelación.
──────────────────────────────────────────*/
async function calcularTodasLasRutasReales() {
  if (calculandoTodas) return;
  if (todasLasRutas.length === 0) {
    alertar('No hay rutas para calcular.');
    return;
  }

  // Primero dibujar todas en modo simple para tener los marcadores
  limpiarTodasLasCapas();
  modoVerTodas       = true;
  rutaActual         = null;
  calculandoTodas    = true;
  cancelarBatchOSRM  = false;
  document.querySelectorAll('.cr-route-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('mapa-info').style.display = 'none';

  // Dibujar simplificadas primero (se reemplazarán una a una)
  todasLasRutas.forEach((ruta, i) => {
    const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
    dibujarRutaSimple(ruta, color);
  });

  // Mostrar panel de progreso
  _batchUI_show(todasLasRutas.length);

  const total    = todasLasRutas.length;
  let exitos     = 0;
  let errores    = 0;
  let totalDist  = 0;
  let totalDur   = 0;

  // Desactivar botón mientras se ejecuta
  const btnCalcTodas = document.getElementById('btn-calcular-todas');
  if (btnCalcTodas) btnCalcTodas.disabled = true;

  for (let i = 0; i < total; i++) {
    if (cancelarBatchOSRM) {
      _batchUI_detail(`<span class="cr-err">Cancelado por el usuario</span>`);
      break;
    }

    const ruta  = todasLasRutas[i];
    const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
    const nombre = ruta.nombre.length > 28 ? ruta.nombre.slice(0, 26) + '…' : ruta.nombre;

    _batchUI_update(i, total, `Calculando: ${nombre}…`);

    // Si no tiene sucursales, saltar
    if (!ruta.sucursales || ruta.sucursales.length === 0) {
      _batchUI_detail(`<span class="cr-err">✗</span> ${nombre} — sin sucursales`);
      errores++;
      continue;
    }

    try {
      const res  = await fetch(API.rutaCalcular(ruta._id));
      const data = await res.json();

      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      // Limpiar polilínea simplificada, mantener marcadores
      const capaAnterior = capasRutas[ruta._id];
      if (capaAnterior) {
        capaAnterior.polylines?.forEach(p => mapa.removeLayer(p));
      }

      // Dibujar segmentos reales
      const polylines = [];
      data.segmentos.forEach(seg => {
        if (!seg.coordenadas || seg.coordenadas.length < 2) return;
        const pl = L.polyline(seg.coordenadas, {
          color,
          weight: 4,
          opacity: 0.85,
          dashArray: null,
        }).addTo(mapa);
        polylines.push(pl);
      });

      // Mantener marcadores existentes
      const markers = capaAnterior?.markers?.length
        ? capaAnterior.markers
        : _crearMarcadoresSucursales(ruta, color);

      capasRutas[ruta._id] = { polylines, markers, tipo: 'real' };

      totalDist += data.total_distancia_m || 0;
      totalDur  += data.total_duracion_s  || 0;
      exitos++;

      const km  = (data.total_distancia_m / 1000).toFixed(1);
      const min = Math.round(data.total_duracion_s / 60);
      const cache = data.desde_cache ? ' ⚡caché' : '';
      _batchUI_detail(`<span class="cr-ok">✓</span> ${nombre} — ${min}min · ${km}km${cache}`);

    } catch (err) {
      console.error(`Error OSRM ruta "${ruta.nombre}":`, err);
      errores++;
      _batchUI_detail(`<span class="cr-err">✗</span> ${nombre} — ${err.message}`);
    }

    // Pequeña pausa entre peticiones para no saturar OSRM público
    if (i < total - 1 && !cancelarBatchOSRM) {
      await new Promise(r => setTimeout(r, 400));
    }
  }

  // Ajustar bounds a todas las capas
  const allBounds = [];
  Object.values(capasRutas).forEach(capa => {
    capa.polylines?.forEach(pl => {
      const b = pl.getBounds();
      if (b.isValid()) allBounds.push(b);
    });
  });
  if (allBounds.length > 0) {
    let combinado = allBounds[0];
    allBounds.slice(1).forEach(b => combinado.extend(b));
    mapa.fitBounds(combinado, { padding: [40, 40] });
  }

  // Mostrar resumen
  _batchUI_complete(exitos, errores, totalDist, totalDur);

  calculandoTodas = false;
  if (btnCalcTodas) btnCalcTodas.disabled = false;
}

/* ── Helpers UI del panel de progreso batch ── */

function _batchUI_show(total) {
  const panel   = document.getElementById('batch-progress');
  const fill    = document.getElementById('batch-bar-fill');
  const text    = document.getElementById('batch-text');
  const detail  = document.getElementById('batch-detail');
  const summary = document.getElementById('batch-summary');

  panel.style.display   = 'block';
  summary.style.display = 'none';
  fill.style.width      = '0%';
  fill.classList.remove('done', 'error');
  text.textContent      = `0 / ${total}`;
  detail.innerHTML      = '';
}

function _batchUI_update(current, total, msg) {
  const pct  = Math.round(((current) / total) * 100);
  const fill = document.getElementById('batch-bar-fill');
  const text = document.getElementById('batch-text');
  fill.style.width = `${pct}%`;
  text.textContent = `${current} / ${total} — ${msg}`;
}

function _batchUI_detail(html) {
  const detail = document.getElementById('batch-detail');
  detail.innerHTML = html;
}

function _batchUI_complete(exitos, errores, totalDist, totalDur) {
  const fill    = document.getElementById('batch-bar-fill');
  const text    = document.getElementById('batch-text');
  const summary = document.getElementById('batch-summary');
  const stats   = document.getElementById('batch-stats');

  fill.style.width = '100%';
  fill.classList.add(errores > 0 && exitos === 0 ? 'error' : 'done');
  text.textContent = cancelarBatchOSRM
    ? 'Cálculo cancelado'
    : `${exitos + errores} rutas procesadas`;

  const km  = (totalDist / 1000).toFixed(1);
  const hrs = Math.floor(totalDur / 3600);
  const min = Math.round((totalDur % 3600) / 60);
  const durTxt = hrs > 0 ? `${hrs}h ${min}min` : `${min} min`;

  stats.innerHTML = `
    <div class="cr-stat-row"><strong>Exitosas</strong><span class="cr-val cr-val--ok">${exitos}</span></div>
    ${errores > 0 ? `<div class="cr-stat-row"><strong>Con error</strong><span class="cr-val cr-val--err">${errores}</span></div>` : ''}
    <div class="cr-stat-row"><strong>Distancia total</strong><span class="cr-val">${km} km</span></div>
    <div class="cr-stat-row"><strong>Tiempo total</strong><span class="cr-val">${durTxt}</span></div>
  `;
  summary.style.display = 'block';
}

function _batchUI_hide() {
  document.getElementById('batch-progress').style.display = 'none';
}

/* ─────────────────────────────────────────
   MODAL — ABRIR / CERRAR
──────────────────────────────────────────*/
async function abrirModalCrear() {
  modalMode      = 'crear';
  editandoRutaId = null;
  document.getElementById('modal-titulo').textContent  = 'Nueva Ruta';
  document.getElementById('input-nombre-ruta').value  = '';
  document.getElementById('select-dia').value         = '';
  document.getElementById('btn-eliminar-ruta').style.display = 'none';
  sucursalesEnRuta = [];
  selDisponibles.clear();
  selAsignadas.clear();

  mostrarModal(true);
  await cargarSucursalesDisponiblesEnModal(null);
}

async function abrirModalEditar(id) {
  const ruta = todasLasRutas.find(r => r._id === id);
  if (!ruta) return;
  modalMode      = 'editar';
  editandoRutaId = id;
  document.getElementById('modal-titulo').textContent  = 'Editar Ruta';
  document.getElementById('input-nombre-ruta').value  = ruta.nombre;
  document.getElementById('select-dia').value         = ruta.dia_sugerido || '';
  document.getElementById('btn-eliminar-ruta').style.display = 'inline-flex';
  sucursalesEnRuta = ruta.sucursales ? [...ruta.sucursales].sort((a,b) => (a.orden||0)-(b.orden||0)) : [];
  selDisponibles.clear();
  selAsignadas.clear();

  mostrarModal(true);
  await cargarSucursalesDisponiblesEnModal(id);
}

function mostrarModal(visible) {
  document.getElementById('modal-backdrop').style.display = visible ? 'flex' : 'none';
  if (visible) {
    document.getElementById('input-nombre-ruta').focus();
    renderListaModal();
  }
}

function cerrarModal() {
  mostrarModal(false);
  sucursalesDisponibles = [];
  sucursalesEnRuta      = [];
  selDisponibles.clear();
  selAsignadas.clear();
}

/* ─────────────────────────────────────────
   MODAL — SUCURSALES
──────────────────────────────────────────*/
async function cargarSucursalesDisponiblesEnModal(excluirRutaId) {
  document.getElementById('lista-disponibles').innerHTML = '<li class="cr-suc-list__loading">Cargando…</li>';
  try {
    const url  = API.sucTodasLibres(excluirRutaId);
    const res  = await fetch(url);
    const data = await res.json();
    const idsEnRuta = new Set(sucursalesEnRuta.map(s => s._id || s.num_tienda));
    sucursalesDisponibles = data.filter(s => !idsEnRuta.has(s._id || s.num_tienda));
    renderListaModal();
  } catch {
    document.getElementById('lista-disponibles').innerHTML = '<li class="cr-suc-list__loading">Error al cargar.</li>';
  }
}

function renderListaModal() {
  renderListaDisponibles();
  renderListaAsignadas();
}

function renderListaDisponibles() {
  const busqueda = document.getElementById('input-buscar-suc').value.toLowerCase();
  const filtradas = sucursalesDisponibles.filter(s =>
    (s.nombre_base || '').toLowerCase().includes(busqueda) ||
    String(s.num_tienda).includes(busqueda)
  );

  const ul = document.getElementById('lista-disponibles');
  ul.innerHTML = '';
  document.getElementById('badge-disponibles').textContent = filtradas.length;

  if (filtradas.length === 0) {
    ul.innerHTML = '<li class="cr-suc-list__empty">Sin sucursales disponibles</li>';
    return;
  }

  filtradas.forEach(suc => {
    const id = suc._id || suc.num_tienda;
    const li = document.createElement('li');
    li.className = 'cr-suc-item' + (selDisponibles.has(id) ? ' selected' : '');
    li.innerHTML = `
      <span class="cr-suc-item__name">${suc.nombre_base || ''}</span>
      <span class="cr-suc-item__num">#${suc.num_tienda}</span>`;
    li.addEventListener('click', () => {
      selDisponibles.has(id) ? selDisponibles.delete(id) : selDisponibles.add(id);
      li.classList.toggle('selected');
    });
    ul.appendChild(li);
  });
}

function renderListaAsignadas() {
  const ul = document.getElementById('lista-asignadas');
  ul.innerHTML = '';
  document.getElementById('badge-asignadas').textContent = sucursalesEnRuta.length;

  if (sucursalesEnRuta.length === 0) {
    ul.innerHTML = '<li class="cr-suc-list__empty">Sin sucursales asignadas</li>';
    return;
  }

  sucursalesEnRuta.forEach((suc, i) => {
    const id = suc._id || suc.num_tienda;
    const li = document.createElement('li');
    li.className = 'cr-suc-item' + (selAsignadas.has(id) ? ' selected' : '');
    li.draggable = true;
    li.dataset.idx = i;
    li.innerHTML = `
      <span class="cr-suc-item__drag">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
          <line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/>
          <line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
        </svg>
      </span>
      <span class="cr-suc-item__order">${i + 1}</span>
      <span class="cr-suc-item__name">${suc.nombre_base || ''}</span>
      <span class="cr-suc-item__num">#${suc.num_tienda}</span>`;

    li.addEventListener('click', (e) => {
      if (e.target.closest('.cr-suc-item__drag')) return;
      selAsignadas.has(id) ? selAsignadas.delete(id) : selAsignadas.add(id);
      li.classList.toggle('selected');
    });

    let dragSrc = null;
    li.addEventListener('dragstart', () => { dragSrc = i; li.classList.add('dragging'); });
    li.addEventListener('dragend',   () => li.classList.remove('dragging'));
    li.addEventListener('dragover',  (e) => { e.preventDefault(); });
    li.addEventListener('drop', () => {
      if (dragSrc === null || dragSrc === i) return;
      const moved = sucursalesEnRuta.splice(dragSrc, 1)[0];
      sucursalesEnRuta.splice(i, 0, moved);
      renderListaAsignadas();
    });

    ul.appendChild(li);
  });
}

function agregarSeleccionadas() {
  const nuevas = sucursalesDisponibles.filter(s => selDisponibles.has(s._id || s.num_tienda));
  nuevas.forEach(s => sucursalesEnRuta.push(s));
  sucursalesDisponibles = sucursalesDisponibles.filter(s => !selDisponibles.has(s._id || s.num_tienda));
  selDisponibles.clear();
  renderListaModal();
}

function quitarSeleccionadas() {
  const quitadas = sucursalesEnRuta.filter(s => selAsignadas.has(s._id || s.num_tienda));
  quitadas.forEach(s => sucursalesDisponibles.push(s));
  sucursalesEnRuta = sucursalesEnRuta.filter(s => !selAsignadas.has(s._id || s.num_tienda));
  selAsignadas.clear();
  renderListaModal();
}

/* ─────────────────────────────────────────
   CONFIRMAR ELIMINACIÓN
──────────────────────────────────────────*/
let pendienteEliminarId = null;

function mostrarConfirmarEliminar(id, nombre) {
  pendienteEliminarId = id;
  document.getElementById('confirmar-nombre-ruta').textContent = nombre;
  document.getElementById('modal-confirmar-backdrop').style.display = 'flex';
}

function cerrarConfirmar() {
  pendienteEliminarId = null;
  document.getElementById('modal-confirmar-backdrop').style.display = 'none';
}

/* ─────────────────────────────────────────
   BIND UI
──────────────────────────────────────────*/
function bindUI() {
  // Cabecera
  document.getElementById('btn-nueva-ruta').addEventListener('click', abrirModalCrear);
  document.getElementById('btn-ver-todas').addEventListener('click', verTodasEnMapa);
  document.getElementById('btn-calcular-todas').addEventListener('click', calcularTodasLasRutasReales);

  // Cancelar cálculo masivo
  document.getElementById('btn-cancelar-batch').addEventListener('click', () => {
    if (calculandoTodas) {
      cancelarBatchOSRM = true;
    } else {
      _batchUI_hide();
    }
  });

  // Filtros sidebar
  document.getElementById('input-buscar-ruta').addEventListener('input', aplicarFiltros);
  document.getElementById('days-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('.cr-day-btn');
    if (!btn) return;
    document.querySelectorAll('.cr-day-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    aplicarFiltros();
  });

  // Sort dropdown toggle
  const sortBtn      = document.getElementById('btn-sort-toggle');
  const sortDropdown = document.getElementById('sort-dropdown');
  sortBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    sortDropdown.classList.toggle('open');
    sortBtn.classList.toggle('active', sortDropdown.classList.contains('open'));
  });

  // Sort option selection
  sortDropdown.addEventListener('click', (e) => {
    const option = e.target.closest('.cr-sort-option');
    if (!option) return;
    e.stopPropagation();
    ordenActual = option.dataset.sort;
    sortDropdown.querySelectorAll('.cr-sort-option').forEach(o => o.classList.remove('active'));
    option.classList.add('active');
    sortDropdown.classList.remove('open');
    sortBtn.classList.remove('active');
    aplicarFiltros();
  });

  // Close sort dropdown when clicking outside
  document.addEventListener('click', () => {
    sortDropdown.classList.remove('open');
    sortBtn.classList.remove('active');
  });

  // Modal principal
  document.getElementById('btn-cerrar-modal').addEventListener('click', cerrarModal);
  document.getElementById('btn-cancelar-modal').addEventListener('click', cerrarModal);
  document.getElementById('btn-guardar-ruta').addEventListener('click', guardarRuta);
  document.getElementById('btn-eliminar-ruta').addEventListener('click', () => {
    cerrarModal();
    mostrarConfirmarEliminar(editandoRutaId, document.getElementById('input-nombre-ruta').value);
  });
  document.getElementById('modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) cerrarModal();
  });

  // Transfer
  document.getElementById('btn-agregar-suc').addEventListener('click', agregarSeleccionadas);
  document.getElementById('btn-quitar-suc').addEventListener('click', quitarSeleccionadas);
  document.getElementById('input-buscar-suc').addEventListener('input', renderListaDisponibles);

  // Modal confirmar
  document.getElementById('btn-cerrar-confirmar').addEventListener('click', cerrarConfirmar);
  document.getElementById('btn-cancelar-confirmar').addEventListener('click', cerrarConfirmar);
  document.getElementById('btn-confirmar-eliminar').addEventListener('click', () => {
    if (pendienteEliminarId) eliminarRuta(pendienteEliminarId);
  });
  document.getElementById('modal-confirmar-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) cerrarConfirmar();
  });

  // Cerrar info del mapa
  document.getElementById('btn-cerrar-info').addEventListener('click', () => {
    document.getElementById('mapa-info').style.display = 'none';
    const btnCalc = document.getElementById('btn-calcular-ruta-real');
    if (btnCalc) btnCalc.style.display = 'none';
  });

  // Botón calcular ruta real (delegado en el panel info)
  document.getElementById('btn-calcular-ruta-real')?.addEventListener('click', async () => {
    const id   = document.getElementById('btn-calcular-ruta-real').dataset.rutaId;
    const ruta = todasLasRutas.find(r => r._id === id);
    if (ruta) await calcularYDibujarRutaReal(ruta);
  });
}

/* ─────────────────────────────────────────
   UTILIDADES
──────────────────────────────────────────*/
function alertar(msg) {
  alert(msg);
}

function _formatearFechaCorta(isoStr) {
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '';
    const dia  = d.getDate().toString().padStart(2, '0');
    const mes  = (d.getMonth() + 1).toString().padStart(2, '0');
    const anio = d.getFullYear().toString().slice(-2);
    return `${dia}/${mes}/${anio}`;
  } catch {
    return '';
  }
}