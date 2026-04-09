// ===== SECCIÓN 5 — Reordenamiento de Rutas =====
// v3: manejo de tres estrategias (directa, división, no_asignable)
//     y rango óptimo dinámico desde el backend.

let _rutasPendientes = [];
let _resultadoReorg  = null;
let _utilMin = 80;
let _utilMax = 120;

// ── Mensajes contextuales del loader ────────────────────────────────────────
const MSG_REORD = {
  reorganizar: [
    "Analizando rutas con exceso de peso…",
    "Buscando vehículos disponibles por día…",
    "Calculando divisiones óptimas de rutas…",
    "Consultando tiempos con OpenStreetMap…",
    "Verificando rangos de utilización…",
    "Aplicando estrategia de reorganización…",
  ],
  guardar: [
    "Guardando resultado del reordenamiento…",
    "Registrando sub-rutas generadas…",
    "Actualizando la base de datos…",
    "Finalizando guardado…",
  ],
};

const DIAS_LABELS = {
  lunes: "Lun", martes: "Mar", miercoles: "Mié",
  jueves: "Jue", viernes: "Vie", sabado: "Sáb", domingo: "Dom",
};

document.addEventListener("DOMContentLoaded", async () => {
  const activa = await verificarSesionLogistica();
  if (!activa) return;
  await cargarDatos();
  bindEventos();
  await cargarResultadoPrevio();
});

// ── Sesión ───────────────────────────────────────────────────
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
  document.getElementById("btn-reorganizar").addEventListener("click", ejecutarReorganizacion);
  // Guardar y continuar → guarda y redirige a modificación
  document.getElementById("btn-guardar-continuar-reord")?.addEventListener("click", () => guardarResultado(true));
  // Solo guardar → guarda y permanece en la sección
  document.getElementById("btn-guardar-reord")?.addEventListener("click", () => guardarResultado(false));
}

function formatMin(min) {
  if (!min || min <= 0) return "—";
  if (min < 60) return `${Math.round(min)} min`;
  const hh = Math.floor(min / 60), mm = Math.round(min % 60);
  return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`;
}
function h(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Carga de datos ────────────────────────────────────────────
async function cargarDatos() {
  try {
    const res = await fetch("/reordenamiento/datos");
    if (res.status === 400) { redirigirAlMenu('Sin logística activa.'); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _rutasPendientes = data.rutas_a_reorganizar || [];
    renderResumen();
    renderPendientes();
  } catch (err) {
    console.error("[cargarDatos]", err);
    document.getElementById("grid-pendientes").innerHTML = `
      <div class="sin-rutas"><div class="icon">⚠️</div>
      <p>Error al cargar. Verifica que existan los datos de asignación y validación.</p></div>`;
  }
}

async function cargarResultadoPrevio() {
  try {
    const res = await fetch("/reordenamiento/previo");
    if (!res.ok) return;
    const prev = await res.json();
    if (prev.util_min != null) _utilMin = prev.util_min;
    if (prev.util_max != null) _utilMax = prev.util_max;
    if (prev.rutas_reorganizadas && prev.rutas_reorganizadas.length > 0) {
      _resultadoReorg = prev;
      mostrarResultado();
    }
  } catch (_) {}
}

// ── Resumen ───────────────────────────────────────────────────
function renderResumen() {
  document.getElementById("res-pendientes").textContent = _rutasPendientes.length;
  if (_rutasPendientes.length > 0) {
    const maxExceso = Math.max(..._rutasPendientes.map(r => r.porcentaje_utilizacion || 0));
    document.getElementById("res-problema").textContent = `Peso excedido (hasta ${maxExceso.toFixed(0)}%)`;
  } else {
    document.getElementById("res-problema").textContent = "Ninguno";
  }
}

// ── Tarjetas de rutas pendientes (antes) ─────────────────────
function renderPendientes() {
  const grid = document.getElementById("grid-pendientes");
  if (_rutasPendientes.length === 0) {
    grid.innerHTML = `<div class="sin-rutas"><div class="icon">✅</div><p>No hay rutas pendientes de reorganizar. ¡Todas cumplen!</p></div>`;
    document.getElementById("btn-reorganizar").style.display = "none";
    return;
  }
  grid.innerHTML = _rutasPendientes.map(r => renderTarjetaOriginal(r)).join("");
  bindSucursalesToggle(grid);
}

function renderTarjetaOriginal(r) {
  const pct      = r.porcentaje_utilizacion || 0;
  const capTon   = r.capacidad_ton || 0;
  const pesoKg   = r.peso_total_kg || 0;
  const sucursales = r.sucursales || [];
  const sucHTML = sucursales.map(s => `
    <div class="suc-item">
      <div class="suc-orden">${s.orden ?? "?"}</div>
      <div class="suc-nombre">${h(s.nombre || "")}</div>
      <div class="suc-peso">${(s.peso_kg || 0).toLocaleString("es-MX")} kg</div>
    </div>`).join("");

  return `
    <div class="ruta-orig-card">
      <div class="orig-header">
        <span class="orig-nombre">⚠ ${h(r.nombre_ruta)}</span>
        <span class="orig-dia">${DIAS_LABELS[r.dia_original] || r.dia_original}</span>
      </div>
      <div class="orig-body">
        <div class="orig-indicadores">
          <span class="badge badge-fail">✗ ${pct.toFixed(0)}% capacidad</span>
          <span class="badge badge-fail">⚖ ${(pesoKg / 1000).toFixed(3)} ton / ${capTon} ton</span>
          <span class="badge ${r.cumple_horario ? "badge-ok" : "badge-fail"}">⏰ ${r.hora_regreso_estimada || "—"}</span>
          <span class="badge badge-info">⏱ ${formatMin(r.tiempo_total_min)}</span>
          <span class="badge badge-neutral">📦 ${sucursales.length} paradas</span>
        </div>
        <div class="tiempos-grid">
          <div class="tiempo-item"><div class="ti-label">Conducción</div><div class="ti-valor">${formatMin(r.tiempo_conduccion_min)}</div></div>
          <div class="tiempo-item"><div class="ti-label">Descarga</div><div class="ti-valor">${formatMin(r.tiempo_descarga_min)}</div></div>
          <div class="tiempo-item"><div class="ti-label">Extra</div><div class="ti-valor">${formatMin(r.tiempo_extra_min || 0)}</div></div>
          <div class="tiempo-item"><div class="ti-label">Distancia</div><div class="ti-valor">${r.distancia_km || 0} km</div></div>
        </div>
        <div style="font-size:0.75rem;color:var(--r-texto-sub);margin-bottom:6px;">
          🚚 <strong style="color:var(--r-texto)">${h(r.vehiculo_placas)}</strong>
          — ${h(r.vehiculo_abreviatura)} · ${capTon} ton
        </div>
        ${sucursales.length > 0 ? `
          <button class="suc-toggle">▼ Ver ${sucursales.length} sucursales</button>
          <div class="suc-list">${sucHTML}</div>
        ` : ""}
      </div>
    </div>`;
}

// ── Ejecutar reorganización ────────────────────────────────────
async function ejecutarReorganizacion() {
  const btn = document.getElementById("btn-reorganizar");
  btn.disabled  = true;
  btn.innerHTML = `<div class="spinner-sm"></div> Reorganizando…`;

  Loader.show('Reorganizando Rutas', MSG_REORD.reorganizar);

  try {
    const res = await fetch("/reordenamiento/ejecutar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.status === 400) { Loader.hide(); redirigirAlMenu('Sin logística activa.'); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _resultadoReorg = await res.json();
    if (_resultadoReorg.status !== "ok") throw new Error(_resultadoReorg.mensaje || "Error en reorganización");

    if (_resultadoReorg.util_min != null) _utilMin = _resultadoReorg.util_min;
    if (_resultadoReorg.util_max != null) _utilMax = _resultadoReorg.util_max;

    Loader.hide();
    mostrarResultado();
    const noAsig = _resultadoReorg.resumen?.no_asignables || 0;
    const noOpt  = (_resultadoReorg.resumen?.fallback || 0);
    if (noAsig > 0) {
      mostrarToast(`⚠ ${noAsig} ruta${noAsig > 1 ? "s" : ""} sin solución óptima`, "warn");
    } else if (noOpt > 0) {
      mostrarToast(`↻ ${noOpt} ruta${noOpt > 1 ? "s" : ""} reasignada${noOpt > 1 ? "s" : ""} sin vehículo óptimo`, "warn");
    } else {
      mostrarToast("✓ Rutas reorganizadas exitosamente", "ok");
    }
  } catch (err) {
    console.error("[ejecutarReorganizacion]", err);
    Loader.hide();
    mostrarToast("✗ Error al reorganizar: " + err.message, "error");
  } finally {
    btn.disabled  = false;
    btn.innerHTML = `<span class="btn-icono">⚡</span> Reorganizar rutas`;
  }
}

// ── Mostrar resultado ─────────────────────────────────────────
function mostrarResultado() {
  if (!_resultadoReorg || !_resultadoReorg.rutas_reorganizadas) return;

  const seccion        = document.getElementById("seccion-resultado");
  const grid           = document.getElementById("grid-resultado");
  const btnSolo        = document.getElementById("btn-guardar-reord");
  const btnContinuar   = document.getElementById("btn-guardar-continuar-reord");

  seccion.style.display = "block";
  if (btnSolo)      btnSolo.style.display      = "inline-flex";
  if (btnContinuar) btnContinuar.style.display  = "inline-flex";

  const grupos   = _resultadoReorg.rutas_reorganizadas;
  const totalSub = grupos.reduce((acc, g) => acc + (g.subrutas?.length || 0), 0);
  const noAsig   = grupos.filter(g => g.no_asignable).length;
  const resumen  = _resultadoReorg.resumen || {};

  // Tarjeta de resultado
  const resCard = document.getElementById("res-resultado-card");
  resCard.style.display = "block";
  document.getElementById("res-generadas").textContent = totalSub;

  // Banner de resumen de estrategias
  const bannerResumen = _construirBannerResumen(resumen, noAsig);
  const existingBanner = document.getElementById("banner-estrategias");
  if (existingBanner) existingBanner.remove();
  grid.parentElement.insertBefore(bannerResumen, grid);

  grid.innerHTML = grupos.map(g => renderGrupo(g)).join("");
  bindSucursalesToggle(grid);
  seccion.scrollIntoView({ behavior: "smooth", block: "start" });
}

function _construirBannerResumen(resumen, noAsig) {
  const el = document.createElement("div");
  el.id = "banner-estrategias";
  el.style.cssText = `
    display:flex; gap:8px; flex-wrap:wrap; align-items:center;
    background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px;
    padding:10px 16px; margin-bottom:14px; font-size:0.82rem;`;

  const partes = [];
  if (resumen.directas)   partes.push(`<span style="color:#16a34a;font-weight:600">✓ ${resumen.directas} asignada${resumen.directas > 1 ? "s" : ""} directamente</span>`);
  if (resumen.fallback)   partes.push(`<span style="color:#7c3aed;font-weight:600">↻ ${resumen.fallback} reasignada${resumen.fallback > 1 ? "s" : ""} sin dividir</span>`);
  if (resumen.divisiones) partes.push(`<span style="color:#2563eb;font-weight:600">⚡ ${resumen.divisiones} dividida${resumen.divisiones > 1 ? "s" : ""}</span>`);
  if (noAsig > 0)         partes.push(`<span style="color:#dc2626;font-weight:600">✗ ${noAsig} sin solución óptima</span>`);

  el.innerHTML = `<span style="color:#64748b">Resultado:</span> ${partes.join('<span style="color:#cbd5e1"> · </span>')}
    <span style="color:#64748b;margin-left:auto">Rango óptimo: ${_utilMin}–${_utilMax}%</span>`;
  return el;
}

// ── Render de grupo (resultado) ───────────────────────────────
function renderGrupo(grupo) {
  if (grupo.no_asignable) {
    return renderGrupoNoAsignable(grupo);
  }
  if (grupo.estrategia === "directa") {
    return renderGrupoDirecto(grupo);
  }
  if (grupo.estrategia === "reasignada_fallback") {
    return renderGrupoFallback(grupo);
  }
  return renderGrupoDivision(grupo);
}

/** Grupo: asignación directa sin dividir (puede incluir cambio de día) */
function renderGrupoDirecto(grupo) {
  const orig = grupo.ruta_original;
  const sr   = grupo.subrutas[0];
  if (!sr) return "";

  const cambioHTML = grupo.cambio_dia
    ? `<div class="grupo-arrow">
        <span class="arrow-icon">📅</span>
        <span style="color:#64748b">Reasignada de</span>
        <span class="arrow-before" style="text-decoration:none;color:#d97706">${DIAS_LABELS[orig.dia] || orig.dia}</span>
        <span style="color:#64748b">→</span>
        <span class="arrow-after">🗓 ${DIAS_LABELS[sr.dia] || sr.dia} (vehículo disponible)</span>
       </div>`
    : `<div class="grupo-arrow">
        <span class="arrow-icon" style="color:#16a34a">✓</span>
        <span style="color:#64748b">Sin división — asignada directamente en su día habitual</span>
       </div>`;

  return `
    <div class="resultado-grupo" style="border-color:#16a34a22;">
      <div class="grupo-header">
        <div class="grupo-titulo" style="color:#16a34a">
          ✓ ${h(orig.nombre)} — Asignada sin dividir
        </div>
        <div class="grupo-info">
          ${(orig.peso_kg / 1000).toFixed(3)} ton · ${orig.pct_original.toFixed(0)}% original · ${orig.num_sucursales} paradas
        </div>
      </div>
      ${cambioHTML}
      <div class="grupo-subrutas">${renderSubruta(sr)}</div>
    </div>`;
}

/**
 * Grupo: ruta subutilizada que no pudo resolverse con un vehículo óptimo
 * pero tampoco se dividió porque su peso no excede el límite máximo.
 * Se asignó el mejor vehículo disponible en otro día como fallback.
 */
function renderGrupoFallback(grupo) {
  const orig = grupo.ruta_original;
  const sr   = grupo.subrutas[0];
  if (!sr) return "";

  const diaLabel = DIAS_LABELS[sr.dia] || sr.dia;
  const cambioHTML = grupo.cambio_dia
    ? `<div class="grupo-arrow">
        <span class="arrow-icon">📅</span>
        <span style="color:#64748b">Reasignada de</span>
        <span class="arrow-before" style="text-decoration:none;color:#d97706">${DIAS_LABELS[orig.dia] || orig.dia}</span>
        <span style="color:#64748b">→</span>
        <span style="color:#7c3aed;font-weight:700">🗓 ${diaLabel} (mejor disponible)</span>
       </div>`
    : `<div class="grupo-arrow">
        <span class="arrow-icon" style="color:#7c3aed">↻</span>
        <span style="color:#64748b">Vehículo reasignado en el mismo día — sin división</span>
       </div>`;

  const avisoHTML = grupo.motivo_fallback
    ? `<div style="
          display:flex; gap:10px; align-items:flex-start;
          background:#f5f3ff; border:1px solid #c4b5fd; border-radius:6px;
          padding:10px 14px; font-size:0.78rem; color:#5b21b6;
          margin:0 14px 12px; line-height:1.5;">
        <span style="font-size:1.1rem;flex-shrink:0;">⚠️</span>
        <span>${h(grupo.motivo_fallback)}</span>
       </div>`
    : "";

  return `
    <div class="resultado-grupo" style="border-color:#7c3aed33;background:#fafaff;">
      <div class="grupo-header" style="background:linear-gradient(135deg,#f5f3ff,#ede9fe);border-bottom-color:#7c3aed;">
        <div class="grupo-titulo" style="color:#7c3aed">
          ↻ ${h(orig.nombre)} — Reasignada sin dividir
        </div>
        <div class="grupo-info">
          ${(orig.peso_kg / 1000).toFixed(3)} ton · ${orig.pct_original.toFixed(0)}% original · ${orig.num_sucursales} paradas
          <span style="color:#7c3aed;font-size:0.7rem;font-weight:600;margin-left:4px;">
            · No excede el máximo — sin división
          </span>
        </div>
      </div>
      ${cambioHTML}
      ${avisoHTML}
      <div class="grupo-subrutas">${renderSubruta(sr)}</div>
    </div>`;
}

/** Grupo: ruta dividida en sub-rutas (posiblemente en distintos días) */
function renderGrupoDivision(grupo) {
  const orig = grupo.ruta_original;
  const subs = grupo.subrutas || [];
  const diasUsados = [...new Set(subs.map(s => s.dia))];
  const infoExtra  = diasUsados.length > 1
    ? `<span style="color:#2563eb;font-size:0.72rem;font-weight:600">
        📅 Distribuida en ${diasUsados.map(d => DIAS_LABELS[d] || d).join(", ")}
       </span>`
    : "";

  return `
    <div class="resultado-grupo">
      <div class="grupo-header">
        <div class="grupo-titulo">🗺 ${h(orig.nombre)} — Reorganizada en ${subs.length} sub-rutas</div>
        <div class="grupo-info">
          Original: ${(orig.peso_kg / 1000).toFixed(3)} ton · ${orig.pct_original.toFixed(0)}% · ${orig.num_sucursales} paradas
          ${infoExtra}
        </div>
      </div>
      <div class="grupo-arrow">
        <span class="arrow-before">✗ ${orig.vehiculo} · ${(orig.peso_kg / 1000).toFixed(2)} ton · ${orig.pct_original.toFixed(0)}%</span>
        <span class="arrow-icon">→</span>
        <span class="arrow-after">✓ Dividida en ${subs.length} ruta${subs.length > 1 ? "s" : ""} dentro del rango</span>
      </div>
      <div class="grupo-subrutas">${subs.map(sr => renderSubruta(sr)).join("")}</div>
    </div>`;
}

/** Grupo: no se pudo asignar ni dividir de forma óptima */
function renderGrupoNoAsignable(grupo) {
  const orig = grupo.ruta_original;
  return `
    <div class="resultado-grupo" style="border-color:#dc2626;background:#fff5f5;">
      <div class="grupo-header" style="background:linear-gradient(135deg,#fee2e2,#fef2f2);border-bottom-color:#dc2626;">
        <div class="grupo-titulo" style="color:#dc2626">
          ✗ ${h(orig.nombre)} — Sin solución óptima
        </div>
        <div class="grupo-info">
          ${(orig.peso_kg / 1000).toFixed(3)} ton · ${orig.pct_original.toFixed(0)}% original · ${orig.num_sucursales} paradas
        </div>
      </div>
      <div style="padding:16px 18px;">
        <div style="
          display:flex; gap:12px; align-items:flex-start;
          background:#fee2e2; border:1px solid #fca5a5; border-radius:8px;
          padding:14px 16px; font-size:0.83rem; color:#7f1d1d; line-height:1.5;">
          <span style="font-size:1.4rem;flex-shrink:0;">⚠️</span>
          <div>
            <div style="font-weight:700;margin-bottom:4px;color:#dc2626;">
              No fue posible encontrar un vehículo o reordenamiento adecuado
            </div>
            <div>${h(grupo.motivo || "Sin información adicional.")}</div>
          </div>
        </div>
        <div style="margin-top:12px;font-size:0.78rem;color:#64748b;">
          <strong>Posibles soluciones:</strong>
          <ul style="margin:6px 0 0 16px;padding:0;line-height:1.8;">
            <li>Agrega más vehículos a la flota en la sección <strong>Configuración</strong>.</li>
            <li>Ajusta el rango de utilización (actual: ${_utilMin}–${_utilMax}%) para permitir más flexibilidad.</li>
            <li>Habilita días adicionales de operación en <strong>Configuración → Días de operación</strong>.</li>
            <li>Redistribuye manualmente algunas paradas en la <strong>Sección 6 — Modificación</strong>.</li>
          </ul>
        </div>
      </div>
    </div>`;
}

// ── Sub-ruta individual ───────────────────────────────────────
function renderSubruta(sr) {
  const colorClass  = `color-${sr.color}`;
  const enRango     = sr.pct_utilizacion >= _utilMin && sr.pct_utilizacion <= _utilMax;
  const pesoBadge   = enRango          ? "badge-ok"   : "badge-fail";
  const horaBadge   = sr.cumple_horario ? "badge-ok"   : "badge-fail";
  const cambioHTML  = sr.cambio_dia
    ? `<span class="badge badge-warn" style="font-size:0.68rem">📅 Movida al ${DIAS_LABELS[sr.dia] || sr.dia}</span>`
    : "";
  const sucursales = sr.sucursales || [];
  const sucHTML = sucursales.map(s => `
    <div class="suc-item">
      <div class="suc-orden">${s.orden ?? "?"}</div>
      <div class="suc-nombre">${h(s.nombre || "")}</div>
      <div class="suc-peso">${(s.peso_kg || 0).toLocaleString("es-MX")} kg</div>
    </div>`).join("");

  return `
    <div class="subruta-card ${colorClass}">
      <div class="sub-header">
        <span class="sub-nombre">${h(sr.nombre_subruta)}</span>
        <div style="display:flex;gap:4px;align-items:center;">
          ${sr.total_partes > 1 ? `<span class="sub-parte">Parte ${sr.parte}/${sr.total_partes}</span>` : ""}
          <span class="sub-dia ${h(sr.dia)}">${DIAS_LABELS[sr.dia] || sr.dia}</span>
        </div>
      </div>
      <div class="sub-body">
        <div class="orig-indicadores">
          <span class="badge ${pesoBadge}">
            ${enRango ? "✓" : "✗"} ${sr.pct_utilizacion.toFixed(0)}%
            ${enRango ? `(rango ${_utilMin}–${_utilMax}%)` : `(fuera del rango ${_utilMin}–${_utilMax}%)`}
          </span>
          <span class="badge ${horaBadge}">⏰ ${sr.hora_regreso || "—"}</span>
          <span class="badge badge-info">⏱ ${formatMin(sr.total_min)}</span>
          <span class="badge badge-neutral">📦 ${sr.num_sucursales} paradas</span>
          <span class="badge badge-neutral">⚖ ${sr.peso_ton.toFixed(3)} ton</span>
          ${cambioHTML}
        </div>
        <div class="tiempos-grid">
          <div class="tiempo-item"><div class="ti-label">Conducción</div><div class="ti-valor">${formatMin(sr.conduccion_min)}</div></div>
          <div class="tiempo-item"><div class="ti-label">Descarga</div><div class="ti-valor">${formatMin(sr.descarga_min)}</div></div>
          <div class="tiempo-item"><div class="ti-label">Extra</div><div class="ti-valor">${formatMin(sr.extra_min)}</div></div>
          <div class="tiempo-item"><div class="ti-label">Distancia</div><div class="ti-valor">${sr.distancia_km} km</div></div>
        </div>
        <div class="sub-vehiculo">🚚 <strong>${h(sr.vehiculo_placas)}</strong> ${sr.vehiculo_abrev ? `— ${h(sr.vehiculo_abrev)}` : ""} · ${sr.capacidad_ton} ton</div>
        ${sucursales.length > 0 ? `<button class="suc-toggle">▼ Ver ${sucursales.length} sucursales</button><div class="suc-list">${sucHTML}</div>` : ""}
      </div>
    </div>`;
}

// ── Guardar ───────────────────────────────────────────────────
async function guardarResultado(redirigir = false) {
  if (!_resultadoReorg) return;
  const btnCont  = document.getElementById("btn-guardar-continuar-reord");
  const btnSolo  = document.getElementById("btn-guardar-reord");
  const btnActivo = redirigir ? btnCont : btnSolo;

  if (btnCont) btnCont.disabled = true;
  if (btnSolo) btnSolo.disabled = true;
  if (btnActivo) btnActivo.textContent = "Guardando…";

  Loader.show(
    redirigir ? 'Guardando y Continuando' : 'Guardando Reordenamiento',
    MSG_REORD.guardar
  );

  try {
    const res = await fetch("/reordenamiento/guardar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(_resultadoReorg),
    });
    if (res.status === 400) { Loader.hide(); redirigirAlMenu('Sin logística activa.'); return; }
    if (res.ok) {
      if (redirigir) {
        // Loader permanece visible durante la redirección
        window.location.href = "/modificacion/";
        return;
      }
      Loader.hide();
      mostrarToast("✓ Reordenamiento guardado correctamente", "ok");
      if (btnSolo) { btnSolo.textContent = "✓ Guardado"; btnSolo.style.background = "#16a34a"; btnSolo.style.color = "#fff"; }
    } else { throw new Error("Error al guardar"); }
  } catch (err) {
    console.error("[guardarResultado]", err);
    Loader.hide();
    mostrarToast("✗ Error al guardar", "error");
    if (btnActivo) { btnActivo.textContent = "✗ Error"; btnActivo.style.background = "#dc2626"; btnActivo.style.color = "#fff"; }
  } finally {
    setTimeout(() => {
      if (btnCont) { btnCont.disabled = false; btnCont.textContent = "💾 Guardar y continuar →"; btnCont.style.background = ""; btnCont.style.color = ""; }
      if (btnSolo) { btnSolo.disabled = false; btnSolo.textContent = "💾 Solo guardar"; btnSolo.style.background = ""; btnSolo.style.color = ""; }
    }, 2500);
  }
}

// ── Utilidades ────────────────────────────────────────────────
function bindSucursalesToggle(container) {
  container.querySelectorAll(".suc-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const lista   = btn.nextElementSibling;
      const abierta = lista.classList.toggle("abierta");
      btn.textContent = abierta ? "▲ Ocultar sucursales" : `▼ Ver ${lista.children.length} sucursales`;
    });
  });
}

function mostrarToast(msg, tipo) {
  let toast = document.querySelector(".reord-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "reord-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = `reord-toast ${tipo || ""}`;
  requestAnimationFrame(() => {
    toast.classList.add("visible");
    setTimeout(() => toast.classList.remove("visible"), 3500);
  });
}