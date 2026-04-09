// ===== SECCIÓN 4 — Validación de Rutas =====
// Cambios: maneja 400 "sin logística activa" redirigiendo al menú.
// No hay otros cambios funcionales: los endpoints son los mismos.

let _rutasValidacion = [];
let _clasificacion   = {};
let _draggedId       = null;

// ── Mensajes contextuales del loader ────────────────────────────────────────
const MSG_VAL = {
  guardar: [
    "Guardando clasificación de rutas…",
    "Registrando rutas autorizadas…",
    "Registrando rutas a reorganizar…",
    "Finalizando guardado de validación…",
  ],
};

const DIAS_LABELS = {
  lunes: "Lun", martes: "Mar", miercoles: "Mié",
  jueves: "Jue", viernes: "Vie", sabado: "Sáb", domingo: "Dom",
};

document.addEventListener("DOMContentLoaded", async () => {
  lucide.createIcons();
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
  alert(`${msg}\n\nSerás redirigido al menú principal.`);
  window.location.href = '/';
}

function bindEventos() {
  document.getElementById("btn-auto-clasificar").addEventListener("click", autoClasificar);
  // Guardar y continuar → guarda y redirige a reordenamiento
  document.getElementById("btn-guardar-continuar-val").addEventListener("click", () => guardarValidacion(true));
  // Solo guardar → guarda y permanece en la sección
  document.getElementById("btn-solo-guardar-val").addEventListener("click", () => guardarValidacion(false));
  document.querySelectorAll(".dropzone").forEach(zone => {
    zone.addEventListener("dragover",  onDragOver);
    zone.addEventListener("dragenter", onDragEnter);
    zone.addEventListener("dragleave", onDragLeave);
    zone.addEventListener("drop",      onDrop);
  });
}

function formatMin(min) {
  if (!min || min <= 0) return "—";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function h(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

async function cargarDatos() {
  try {
    const res = await fetch("/validacion/rutas");
    if (res.status === 400) { redirigirAlMenu('Sin logística activa.'); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    _rutasValidacion = data.rutas || [];
    _rutasValidacion.forEach(r => { _clasificacion[r.id] = "pendientes"; });

    // Cargar validación previa
    try {
      const prevRes = await fetch("/validacion/previa");
      if (prevRes.ok) {
        const prev = await prevRes.json();
        if (prev.autorizadas && prev.reorganizar) {
          const autIds   = new Set((prev.autorizadas || []).map(r => r.id));
          const reorgIds = new Set((prev.reorganizar || []).map(r => r.id));
          _rutasValidacion.forEach(r => {
            if (autIds.has(r.id))        _clasificacion[r.id] = "autorizados";
            else if (reorgIds.has(r.id)) _clasificacion[r.id] = "reorganizar";
          });
        }
      }
    } catch (_) {}

    renderResumen(data.resumen);
    renderColumnas();
  } catch (err) {
    console.error("[cargarDatos]", err);
    document.getElementById("col-pendientes").innerHTML = `
      <div class="col-placeholder">
        <div class="ph-icono"><i data-lucide="triangle-alert"></i></div>
        <p>Error al cargar las rutas. Verifica que exista la asignación guardada.</p>
      </div>`;
    lucide.createIcons();
  }
}

function renderResumen(resumen) {
  if (!resumen) return;
  document.getElementById("res-total").textContent    = resumen.total;
  document.getElementById("res-verdes").textContent   = resumen.verdes;
  document.getElementById("res-naranjas").textContent = resumen.naranjas;
  document.getElementById("res-rojas").textContent    = resumen.rojas;
}

function renderColumnas() {
  const grupos = { pendientes: [], autorizados: [], reorganizar: [] };
  _rutasValidacion.forEach(r => { grupos[_clasificacion[r.id] || "pendientes"].push(r); });
  renderColumna("col-pendientes",  grupos.pendientes,  "pendientes");
  renderColumna("col-autorizados", grupos.autorizados,  "autorizados");
  renderColumna("col-reorganizar", grupos.reorganizar,  "reorganizar");
  document.getElementById("badge-pendientes").textContent  = grupos.pendientes.length;
  document.getElementById("badge-autorizados").textContent = grupos.autorizados.length;
  document.getElementById("badge-reorganizar").textContent = grupos.reorganizar.length;
}

function renderColumna(containerId, rutas, tipo) {
  const el = document.getElementById(containerId);
  if (rutas.length === 0) {
    const placeholders = {
      pendientes:  { icono: `<i data-lucide="clipboard-list"></i>`, texto: "Todas las rutas han sido clasificadas" },
      autorizados: { icono: `<i data-lucide="check-circle-2"></i>`, texto: "Arrastra rutas aquí para autorizarlas" },
      reorganizar: { icono: `<i data-lucide="refresh-cw"></i>`, texto: "Arrastra rutas que necesiten cambios" },
    };
    const ph = placeholders[tipo];
    el.innerHTML = `<div class="col-placeholder"><div class="ph-icono">${ph.icono}</div><p>${ph.texto}</p></div>`;
    lucide.createIcons();
    return;
  }
  el.innerHTML = rutas.map(r => renderChip(r)).join("");
  lucide.createIcons();
  el.querySelectorAll(".ruta-chip").forEach(chip => {
    chip.addEventListener("dragstart", onDragStart);
    chip.addEventListener("dragend",   onDragEnd);
  });
  el.querySelectorAll(".chip-sucursales-toggle").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const lista = btn.nextElementSibling;
      const abierta = lista.classList.toggle("abierta");
      btn.innerHTML = abierta
        ? `<i data-lucide="chevron-up"></i> Ocultar sucursales`
        : `<i data-lucide="chevron-down"></i> Ver ${lista.children.length} sucursales`;
      lucide.createIcons();
    });
  });
}

function renderChip(r) {
  const colorClass    = `color-${r.color}`;
  const diaLabel      = DIAS_LABELS[r.dia] || r.dia;
  const pesoBadgeClass = r.cumple_peso ? "ok" : "fail";
  const pesoIcon       = r.cumple_peso ? `<i data-lucide="check"></i>` : `<i data-lucide="x"></i>`;
  const pesoBadgeText  = `${pesoIcon} ${r.pct_utilizacion.toFixed(0)}%`;
  const horaBadgeClass = r.cumple_horario ? "ok" : "fail";
  const horaIcon       = r.cumple_horario ? `<i data-lucide="check"></i>` : `<i data-lucide="x"></i>`;
  const horaBadgeText  = `${horaIcon} ${r.hora_regreso || "—"}`;

  const sucHTML = (r.sucursales || []).map(s => `
    <div class="chip-suc-item">
      <div class="chip-suc-orden">${s.orden ?? "?"}</div>
      <div class="chip-suc-nombre">${h(s.nombre || "")}</div>
      <div class="chip-suc-peso">${(s.peso_kg || 0).toLocaleString("es-MX")} kg</div>
    </div>`).join("");

  return `
    <div class="ruta-chip ${colorClass}" draggable="true" data-rutaid="${h(r.id)}">
      <div class="chip-header">
        <span class="chip-nombre"><i data-lucide="map-pin"></i> ${h(r.nombre_ruta)}</span>
        <span class="chip-dia ${h(r.dia)}">${diaLabel}</span>
      </div>
      <div class="chip-indicadores">
        <span class="chip-badge ${pesoBadgeClass}" title="Capacidad: ${r.pct_utilizacion.toFixed(1)}% de ${r.capacidad_ton} ton"><i data-lucide="scale"></i> ${pesoBadgeText}</span>
        <span class="chip-badge ${horaBadgeClass}" title="Regreso estimado: ${r.hora_regreso}"><i data-lucide="alarm-clock"></i> ${horaBadgeText}</span>
        <span class="chip-badge info"><i data-lucide="timer"></i> ${formatMin(r.total_min)}</span>
        <span class="chip-badge neutral"><i data-lucide="package"></i> ${r.num_sucursales} parada${r.num_sucursales !== 1 ? "s" : ""}</span>
      </div>
      <div class="chip-tiempos">
        <div class="chip-t"><div class="t-label">Conducción</div><div class="t-valor">${formatMin(r.conduccion_min)}</div></div>
        <div class="chip-t"><div class="t-label">Descarga</div><div class="t-valor">${formatMin(r.descarga_min)}</div></div>
        <div class="chip-t"><div class="t-label">Extra</div><div class="t-valor">${formatMin(r.extra_min)}</div></div>
        <div class="chip-t"><div class="t-label">Distancia</div><div class="t-valor">${r.distancia_km} km</div></div>
      </div>
      <div class="chip-vehiculo">
        <i data-lucide="truck"></i> <strong>${h(r.vehiculo)}</strong> — ${h(r.vehiculo_abrev)}
        &middot; ${r.capacidad_ton} ton &middot; ${(r.peso_kg / 1000).toFixed(3)} ton
      </div>
      ${r.num_sucursales > 0 ? `
        <button class="chip-sucursales-toggle"><i data-lucide="chevron-down"></i> Ver ${r.num_sucursales} sucursales</button>
        <div class="chip-sucursales-list">${sucHTML}</div>
      ` : ""}
    </div>`;
}

// ── Drag & Drop ─────────────────────────────────────────────
function onDragStart(e) {
  _draggedId = e.currentTarget.dataset.rutaid;
  e.currentTarget.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", _draggedId);
}
function onDragEnd(e) {
  e.currentTarget.classList.remove("dragging");
  _draggedId = null;
  document.querySelectorAll(".dropzone").forEach(z => z.classList.remove("dragover"));
}
function onDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }
function onDragEnter(e) { e.preventDefault(); e.currentTarget.classList.add("dragover"); }
function onDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove("dragover");
}
function onDrop(e) {
  e.preventDefault();
  const zone   = e.currentTarget;
  zone.classList.remove("dragover");
  const rutaId = e.dataTransfer.getData("text/plain");
  const destino = zone.dataset.columna;
  if (rutaId && destino && _clasificacion[rutaId] !== destino) {
    _clasificacion[rutaId] = destino;
    renderColumnas();
  }
}

// ── Auto-clasificar ─────────────────────────────────────────
function autoClasificar() {
  _rutasValidacion.forEach(r => {
    _clasificacion[r.id] = r.color === "verde" ? "autorizados" : "reorganizar";
  });
  renderColumnas();
  mostrarToast("Rutas clasificadas automáticamente", "ok");
}

// ── Guardar validación ──────────────────────────────────────
async function guardarValidacion(redirigir = false) {
  const btnCont  = document.getElementById("btn-guardar-continuar-val");
  const btnSolo  = document.getElementById("btn-solo-guardar-val");
  const btnActivo = redirigir ? btnCont : btnSolo;

  // Deshabilitar ambos mientras se guarda
  if (btnCont) btnCont.disabled = true;
  if (btnSolo) btnSolo.disabled = true;
  if (btnActivo) btnActivo.textContent = "Guardando…";

  Loader.show(
    redirigir ? 'Guardando y Continuando' : 'Guardando Validación',
    MSG_VAL.guardar
  );

  const autorizadas = _rutasValidacion.filter(r => _clasificacion[r.id] === "autorizados");
  const reorganizar = _rutasValidacion.filter(r => _clasificacion[r.id] === "reorganizar");
  const pendientes  = _rutasValidacion.filter(r => _clasificacion[r.id] === "pendientes");

  const payload = {
    fecha_validacion: new Date().toISOString(),
    autorizadas:      autorizadas.map(simplificar),
    reorganizar:      reorganizar.map(simplificar),
    pendientes:       pendientes.map(simplificar),
    resumen: {
      total_autorizadas: autorizadas.length,
      total_reorganizar: reorganizar.length,
      total_pendientes:  pendientes.length,
    },
  };

  try {
    const res = await fetch("/validacion/guardar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 400) { redirigirAlMenu('Sin logística activa.'); return; }
    if (res.ok) {
      if (redirigir) {
        // Loader permanece visible durante la redirección
        window.location.href = "/reordenamiento/";
        return;
      }
      // Solo guardar: ocultar loader y mostrar feedback visual
      Loader.hide();
      mostrarToast(`Validación guardada — ${autorizadas.length} autorizadas, ${reorganizar.length} a reorganizar`, "ok");
      if (btnSolo) { btnSolo.innerHTML = '<i data-lucide="check"></i> Guardado'; btnSolo.style.background = "#16a34a"; btnSolo.style.color = "#fff"; lucide.createIcons(); }
    } else { throw new Error("Respuesta no OK"); }
  } catch (err) {
    console.error("[guardarValidacion]", err);
    Loader.hide();
    mostrarToast("Error al guardar la validación", "error");
    if (btnActivo) { btnActivo.textContent = "Error"; btnActivo.style.background = "#dc2626"; btnActivo.style.color = "#fff"; }
  } finally {
    setTimeout(() => {
      if (btnCont) { btnCont.disabled = false; btnCont.innerHTML = '<i data-lucide="save"></i> Guardar y continuar <i data-lucide="arrow-right"></i>'; btnCont.style.background = ""; btnCont.style.color = ""; }
      if (btnSolo) { btnSolo.disabled = false; btnSolo.innerHTML = '<i data-lucide="save"></i> Solo guardar'; btnSolo.style.background = ""; btnSolo.style.color = ""; }
      lucide.createIcons();
    }, 2500);
  }
}

function simplificar(r) {
  return {
    id: r.id, nombre_ruta: r.nombre_ruta, dia: r.dia,
    vehiculo: r.vehiculo, vehiculo_abrev: r.vehiculo_abrev,
    peso_kg: r.peso_kg, peso_ton: r.peso_ton,
    pct_utilizacion: r.pct_utilizacion, cumple_peso: r.cumple_peso,
    total_min: r.total_min, hora_salida: r.hora_salida,
    hora_regreso: r.hora_regreso, cumple_horario: r.cumple_horario,
    color: r.color, num_sucursales: r.num_sucursales,
  };
}

function mostrarToast(msg, tipo) {
  let toast = document.querySelector(".val-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "val-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = `val-toast ${tipo || ""}`;
  requestAnimationFrame(() => {
    toast.classList.add("visible");
    setTimeout(() => toast.classList.remove("visible"), 3000);
  });
}