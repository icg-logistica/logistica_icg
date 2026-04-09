// ===== Configuración — Productos, Sucursales, Vehículos y General =====

const DIAS_SEMANA = [
  { key: "lunes",     label: "Lunes"     },
  { key: "martes",    label: "Martes"    },
  { key: "miercoles", label: "Miércoles" },
  { key: "jueves",    label: "Jueves"    },
  { key: "viernes",   label: "Viernes"   },
  { key: "sabado",    label: "Sábado"    },
  { key: "domingo",   label: "Domingo"   },
];

function getEndpoint(tipo) {
  if (tipo === "sucursal")          return "sucursales";
  if (tipo === "cliente_mayorista") return "clientes-mayoristas";
  return tipo + "s";
}

// Esquemas alineados con MongoDB (¡AQUÍ SE AGREGAN LOS CAMPOS PARA EL MODAL!)
const CAMPOS_PRODUCTO = [
  { key: "marca",       label: "Marca",        type: "text"   },
  { key: "clave_sae",   label: "Clave SAE",    type: "number" },
  { key: "descripcion", label: "Descripción",  type: "text"   },
  { key: "costo",       label: "Costo",        type: "number" },
  { key: "peso",        label: "Peso (kg)",    type: "number" },
  { key: "largo",       label: "Largo (cm)",   type: "number" },
  { key: "ancho",       label: "Ancho (cm)",   type: "number" },
  { key: "alto",        label: "Alto (cm)",    type: "number" },
  { key: "volumen",     label: "Volumen (m³)", type: "number", readonly: true },
];

const CAMPOS_SUCURSAL = [
  { key: "num_tienda",         label: "Núm. Tienda",      type: "number" },
  { key: "estado",             label: "Estado",           type: "text"   },
  { key: "nombre_base",        label: "Nombre Base",      type: "text"   },
  { key: "nombre_icg-proalmex",label: "Nombre ICG-Proalmex", type: "text" },
  { key: "nombre_bimbo",       label: "Nombre Bimbo",     type: "text"   },
  { key: "latitud",            label: "Latitud",          type: "number" },
  { key: "longitud",           label: "Longitud",         type: "number" },
  { key: "hora_inicio",        label: "Hora Inicio",      type: "text"   },
  { key: "hora_fin",           label: "Hora Fin",         type: "text"   },
];

const CAMPOS_VEHICULO = [
  { key: "descripcion",         label: "Descripción",          type: "text"   },
  { key: "abreviatura",         label: "Abreviatura",          type: "text"   },
  { key: "placas",              label: "Placas",               type: "text"   },
  { key: "chofer",              label: "Chofer",               type: "text"   },
  { key: "largo_volumetria",    label: "Largo Volumetría (m)", type: "number" },
  { key: "ancho_volumetria",    label: "Ancho Volumetría (m)", type: "number" },
  { key: "alto_volumetria",     label: "Alto Volumetría (m)",  type: "number" },
  { key: "capacidad_toneladas", label: "Capacidad (ton)",      type: "number" },
  { key: "categoria",           label: "Categoría",            type: "text"   },
  { key: "volumen_m3",          label: "Volumen (m³)",         type: "number", readonly: true },
];

const CAMPOS_CLIENTE_MAYORISTA = [
  { key: "id_cliente", label: "ID Cliente", type: "number" },
  { key: "nombre",     label: "Nombre",     type: "text"   },
  { key: "poblacion",  label: "Población",  type: "text"   },
  { key: "latitud",    label: "Latitud",    type: "number" },
  { key: "longitud",   label: "Longitud",   type: "number" },
];

// ── Mensajes contextuales del loader ────────────────────────────
const MSG_CFG = {
  guardar_general: [
    "Actualizando parámetros de operación…",
    "Guardando configuración de días y horarios…",
    "Sincronizando con los módulos del sistema…",
    "Aplicando cambios…",
  ],
  crear: [
    "Registrando en la base de datos…",
    "Validando datos del nuevo registro…",
    "Aplicando configuraciones…",
  ],
  editar: [
    "Actualizando registro…",
    "Guardando cambios en la base de datos…",
    "Aplicando modificaciones…",
  ],
  eliminar: [
    "Eliminando registro…",
    "Borrando de la base de datos…",
    "Limpiando datos asociados…",
  ],
};

const _TIPO_LABEL = {
  producto:          "Producto",
  sucursal:          "Sucursal",
  vehiculo:          "Vehículo",
  cliente_mayorista: "Cliente Mayorista",
};

let modalMode  = null;
let modalTipo  = null;
let modalDocId = null;

// ── Confirmación de estado de vehículo ──────────────────────────
let _confirmResolve = null;

function mostrarConfirmEstado(descripcion, abreviatura, placas, activo) {
  const esActivar = !activo;
  document.getElementById("confirm-icon").className   = `confirm-icon ${esActivar ? "activar" : "desactivar"}`;
  document.getElementById("confirm-icon").textContent = esActivar ? "▶" : "⏸";
  document.getElementById("confirm-title").textContent = esActivar ? "Activar vehículo" : "Desactivar vehículo";
  document.getElementById("confirm-msg").textContent   = esActivar
    ? "El vehículo quedará disponible para ser asignado a rutas de reparto."
    : "El vehículo quedará inactivo y no podrá ser asignado a ninguna ruta.";

  const meta = document.getElementById("confirm-meta");
  meta.innerHTML = `<span>Vehículo</span>${h(descripcion)}&nbsp;&nbsp;·&nbsp;&nbsp;${h(abreviatura)}&nbsp;&nbsp;·&nbsp;&nbsp;${h(placas)}`;

  const okBtn = document.getElementById("confirm-ok");
  okBtn.className = `btn btn-confirm-ok ${esActivar ? "btn-success" : "btn-secondary"}`;
  okBtn.textContent = esActivar ? "Activar" : "Desactivar";

  document.getElementById("confirm-overlay").classList.remove("hidden");
  return new Promise(resolve => { _confirmResolve = resolve; });
}

document.addEventListener("DOMContentLoaded", async () => {
  initTabs();
  initSortableTables();
  await cargarConfigGeneral();
  cargarDatos("producto");
  cargarDatos("sucursal");
  cargarDatos("vehiculo");
  cargarDatos("cliente_mayorista");

  // Confirmación de estado vehículo
  document.getElementById("confirm-cancel").addEventListener("click", () => {
    document.getElementById("confirm-overlay").classList.add("hidden");
    if (_confirmResolve) { _confirmResolve(false); _confirmResolve = null; }
  });
  document.getElementById("confirm-ok").addEventListener("click", () => {
    document.getElementById("confirm-overlay").classList.add("hidden");
    if (_confirmResolve) { _confirmResolve(true); _confirmResolve = null; }
  });

  document.getElementById("btn-nuevo-producto").addEventListener("click", () => abrirModal("create", "producto"));
  document.getElementById("btn-nueva-sucursal").addEventListener("click", () => abrirModal("create", "sucursal"));
  document.getElementById("btn-nuevo-vehiculo").addEventListener("click", () => abrirModal("create", "vehiculo"));
  document.getElementById("btn-nuevo-cliente-mayorista").addEventListener("click", () => abrirModal("create", "cliente_mayorista"));
  document.getElementById("modal-cancel").addEventListener("click", cerrarModal);
  document.getElementById("modal-save").addEventListener("click", guardarModal);

  ["producto", "sucursal", "vehiculo", "cliente_mayorista"].forEach(tipo => {
    const tableEl = document.querySelector(`#tabla-${getEndpoint(tipo)} tbody`);
    if (tableEl) {
      tableEl.addEventListener("click", e => {
        const btn = e.target.closest("button[data-id]");
        if (!btn) return;
        const { id, accion } = btn.dataset;
        if (accion === "editar")        abrirModal("edit", tipo, id);
        if (accion === "eliminar")      eliminar(tipo, id);
        if (accion === "toggle-activo") toggleActivo(
          id,
          btn.dataset.descripcion || "",
          btn.dataset.abreviatura || "",
          btn.dataset.placas      || "",
          btn.dataset.activo === "true"
        );
      });
    }
    document.getElementById(`buscar-${tipo}-nombre`).addEventListener("input", () => debounceCarga(tipo));
    document.getElementById(`buscar-${tipo}-fecha`).addEventListener("change", () => cargarDatos(tipo));
  });

  // Formulario general
  document.getElementById("form-general").addEventListener("submit", guardarConfigGeneral);
});

// ── Config General ──────────────────────────────────────────────
async function cargarConfigGeneral() {
  try {
    const res = await fetch("/configuracion/");
    // La ruta GET / renderiza HTML, así que buscamos el endpoint de config
    const res2 = await fetch("/configuracion/config-general");
    if (res2.ok) {
      const cfg = await res2.json();
      poblarFormularioGeneral(cfg);
    }
  } catch (err) {
    // Sin configuración previa — usar defaults
    poblarFormularioGeneral({});
  }
}

function poblarFormularioGeneral(cfg) {
  const form = document.getElementById("form-general");
  if (!form) return;

  // Campos simples
  const setVal = (name, val) => {
    const el = form.querySelector(`[name="${name}"]`);
    if (el && val != null) el.value = val;
  };
  setVal("matriz_lat",         cfg.matriz_lat         ?? 19.1738);
  setVal("matriz_lon",         cfg.matriz_lon         ?? -96.1342);
  setVal("velocidad_kmh",      cfg.velocidad_kmh      ?? 24);
  setVal("min_descarga_por_kg",cfg.min_descarga_por_kg ?? 0.20);
  setVal("utilizacion_min",    cfg.utilizacion_min    ?? 80);
  setVal("utilizacion_max",    cfg.utilizacion_max    ?? 120);

  // Días
  renderDiasConfig(cfg.config_dias || {});
}

function renderDiasConfig(configDias) {
  const cont = document.getElementById("dias-rows");
  if (!cont) return;

  cont.innerHTML = DIAS_SEMANA.map(({ key, label }) => {
    const d = configDias[key] || { habilitado: key !== "domingo", hora_salida: "07:00", hora_limite: "18:00" };
    return `
      <div class="dia-row" id="dia-row-${key}">
        <label class="switch">
          <input type="checkbox" id="dia-chk-${key}" ${d.habilitado ? "checked" : ""}
            onchange="toggleDiaRow('${key}', this.checked)">
          <span class="slider"></span>
        </label>
        <span class="dia-row-label">${label}</span>
        <input type="time" id="dia-salida-${key}" value="${d.hora_salida || "07:00"}" ${!d.habilitado ? "disabled" : ""}>
        <input type="time" id="dia-limite-${key}" value="${d.hora_limite || "18:00"}" ${!d.habilitado ? "disabled" : ""}>
      </div>`;
  }).join("");
}

function toggleDiaRow(key, habilitado) {
  document.getElementById(`dia-salida-${key}`).disabled = !habilitado;
  document.getElementById(`dia-limite-${key}`).disabled = !habilitado;
}

async function guardarConfigGeneral(e) {
  if (e) e.preventDefault();
  const form = document.getElementById("form-general");
  const datos = {
    matriz_lat:          parseFloat(form.querySelector('[name="matriz_lat"]')?.value) || 19.1738,
    matriz_lon:          parseFloat(form.querySelector('[name="matriz_lon"]')?.value) || -96.1342,
    velocidad_kmh:       parseFloat(form.querySelector('[name="velocidad_kmh"]')?.value) || 24,
    min_descarga_por_kg: parseFloat(form.querySelector('[name="min_descarga_por_kg"]')?.value) || 0.20,
    utilizacion_min:     parseInt(form.querySelector('[name="utilizacion_min"]')?.value)  || 80,
    utilizacion_max:     parseInt(form.querySelector('[name="utilizacion_max"]')?.value)  || 120,
    config_dias: {},
  };

  DIAS_SEMANA.forEach(({ key }) => {
    datos.config_dias[key] = {
      habilitado:  document.getElementById(`dia-chk-${key}`)?.checked ?? true,
      hora_salida: document.getElementById(`dia-salida-${key}`)?.value || "07:00",
      hora_limite: document.getElementById(`dia-limite-${key}`)?.value || "18:00",
    };
  });

  Loader.show("Guardando Configuración", MSG_CFG.guardar_general);
  try {
    const [r1, r2] = await Promise.all([
      fetch("/configuracion/guardar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(datos),
      }),
      // Sincronizar config_dias con la logística activa (si hay una).
      // Esto es opcional: si no hay logística activa (r2 → 400), la config
      // global en 'configuracion' sigue siendo la fuente de verdad y será
      // leída correctamente por el módulo de Asignación al cargar.
      fetch("/asignacion/config-dias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(datos.config_dias),
      }).catch(() => null),  // nunca propaga error de red
    ]);

    if (r1.ok) {
      const btn = form.querySelector('button[type="submit"]');
      const orig = btn.textContent;
      btn.textContent = "✓ Guardado";
      btn.style.background = "#16a34a";
      setTimeout(() => { btn.textContent = orig; btn.style.background = ""; }, 2000);
    } else {
      alert("Error al guardar la configuración.");
    }
  } catch (err) {
    console.error(err);
  } finally {
    Loader.hide();
  }
}

// ── Tabs ─────────────────────────────────────────────────────
const timers = {};
function debounceCarga(tipo) {
  clearTimeout(timers[tipo]);
  timers[tipo] = setTimeout(() => cargarDatos(tipo), 350);
}

function initTabs() {
  document.querySelectorAll(".nav-tabs a").forEach(a => {
    a.addEventListener("click", e => {
      e.preventDefault();
      document.querySelectorAll(".nav-tabs li").forEach(li => li.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(s => s.classList.add("hidden"));
      a.parentElement.classList.add("active");
      const target = document.getElementById("tab-" + a.dataset.tab);
      if (target) target.classList.remove("hidden");
    });
  });
}

// ── CRUD ─────────────────────────────────────────────────────
async function cargarDatos(tipo) {
  const nombre = document.getElementById(`buscar-${tipo}-nombre`).value;
  const fecha  = document.getElementById(`buscar-${tipo}-fecha`).value;
  const tbody  = document.querySelector(`#tabla-${getEndpoint(tipo)} tbody`);

  try {
    // Se agregó { cache: "no-store" } para evitar que el navegador muestre datos desactualizados
    const res = await fetch(`/configuracion/${getEndpoint(tipo)}?nombre=${encodeURIComponent(nombre)}&fecha=${encodeURIComponent(fecha)}`, { cache: "no-store" });
    const data = await res.json();

    if (!Array.isArray(data) || data.length === 0) {
      // AQUÍ SUMAMOS +1 A LAS COLUMNAS PARA QUE LA TABLA VACÍA NO SE DESCUADRE
      const cols = { producto: 11, sucursal: 11, vehiculo: 13, cliente_mayorista: 7 };
      tbody.innerHTML = `<tr><td colspan="${cols[tipo]}" style="text-align:center;color:#999">Sin registros</td></tr>`;
      return;
    }

    if (tipo === "producto") {
      tbody.innerHTML = data.map(p => `
        <tr>
          <td>${h(p.marca)}</td>
          <td>${p.clave_sae ?? ""}</td>
          <td>${h(p.descripcion)}</td>
          <td>$${Number(p.costo || 0).toFixed(2)}</td>
          <td>${p.peso ?? ""} kg</td>
          <td>${p.largo ?? ""}</td>
          <td>${p.ancho ?? ""}</td>
          <td>${p.alto ?? ""}</td>
          <td>${p.volumen != null && p.volumen !== 0 ? Number(p.volumen).toFixed(6) : "—"}</td>
          <td>${p.ultima_modificacion ?? "-"}</td>
          <td>
            <button class="btn btn-sm btn-warning" data-id="${p._id}" data-accion="editar">Editar</button>
            <button class="btn btn-sm btn-danger"  data-id="${p._id}" data-accion="eliminar">Eliminar</button>
          </td>
        </tr>`).join("");
    } else if (tipo === "sucursal") {
      tbody.innerHTML = data.map(s => `
        <tr>
          <td>${s.num_tienda ?? ""}</td>
          <td>${h(s.estado)}</td>
          <td>${h(s.nombre_base)}</td>
          <td>${h(s["nombre_icg-proalmex"])}</td>
          <td>${h(s.nombre_bimbo)}</td>
          <td>${s.latitud ?? ""}</td>
          <td>${s.longitud ?? ""}</td>
          <td>${h(s.hora_inicio)}</td>
          <td>${h(s.hora_fin)}</td>
          <td>${s.ultima_modificacion ?? "-"}</td>
          <td>
            <button class="btn btn-sm btn-warning" data-id="${s._id}" data-accion="editar">Editar</button>
            <button class="btn btn-sm btn-danger"  data-id="${s._id}" data-accion="eliminar">Eliminar</button>
          </td>
        </tr>`).join("");
    } else if (tipo === "vehiculo") {
      tbody.innerHTML = data.map(v => {
        const activo = v.activo !== false;
        return `
        <tr>
          <td>${h(v.descripcion)}</td>
          <td>${h(v.abreviatura)}</td>
          <td>${h(v.placas)}</td>
          <td>${h(v.chofer)}</td>
          <td>${v.largo_volumetria ?? ""}</td>
          <td>${v.ancho_volumetria ?? ""}</td>
          <td>${v.alto_volumetria ?? ""}</td>
          <td>${v.capacidad_toneladas ?? ""} ton</td>
          <td>${h(v.categoria)}</td>
          <td>${v.volumen_m3 != null && v.volumen_m3 !== 0 ? Number(v.volumen_m3).toFixed(4) : "—"}</td>
          <td>${v.ultima_modificacion ?? "-"}</td>
          <td>
            <button class="btn btn-sm ${activo ? "btn-success" : "btn-secondary"}"
                    data-id="${v._id}"
                    data-accion="toggle-activo"
                    data-descripcion="${ha(v.descripcion ?? "")}"
                    data-abreviatura="${ha(v.abreviatura ?? "")}"
                    data-placas="${ha(v.placas ?? "")}"
                    data-activo="${activo}">
              ${activo ? "Activo" : "Inactivo"}
            </button>
          </td>
          <td>
            <button class="btn btn-sm btn-warning" data-id="${v._id}" data-accion="editar">Editar</button>
            <button class="btn btn-sm btn-danger"  data-id="${v._id}" data-accion="eliminar">Eliminar</button>
          </td>
        </tr>`}).join("");
    } else if (tipo === "cliente_mayorista") {
      tbody.innerHTML = data.map(c => `
        <tr>
          <td>${c.id_cliente ?? ""}</td>
          <td>${h(c.nombre)}</td>
          <td>${h(c.poblacion)}</td>
          <td>${c.latitud  ?? "—"}</td>
          <td>${c.longitud ?? "—"}</td>
          <td>${c.ultima_modificacion ?? "-"}</td>
          <td>
            <button class="btn btn-sm btn-warning" data-id="${c._id}" data-accion="editar">Editar</button>
            <button class="btn btn-sm btn-danger"  data-id="${c._id}" data-accion="eliminar">Eliminar</button>
          </td>
        </tr>`).join("");
    }
  } catch (err) {
    console.error(`[cargarDatos:${tipo}]`, err);
    // Asegúrate de cambiar el colspan aquí también si ajustas las columnas
    tbody.innerHTML = `<tr><td colspan="16" style="text-align:center;color:#ef4444">Error de conexión.</td></tr>`;
  }
}

async function abrirModal(mode, tipo, docId = null) {
  modalMode = mode; modalTipo = tipo; modalDocId = docId;
  const campos = tipo === "producto"          ? CAMPOS_PRODUCTO
               : tipo === "sucursal"          ? CAMPOS_SUCURSAL
               : tipo === "cliente_mayorista" ? CAMPOS_CLIENTE_MAYORISTA
               : CAMPOS_VEHICULO;
  document.getElementById("modal-title").textContent = (mode === "create" ? "Nuevo " : "Editar ") + tipo;

  let existente = {};
  if (mode === "edit" && docId) {
    const res = await fetch(`/configuracion/${getEndpoint(tipo)}/${docId}`);
    existente = await res.json();
  }

  document.getElementById("modal-form").innerHTML = campos.map(c => `
    <div class="form-group">
      <label>${h(c.label)}${c.readonly ? ' <span class="config-computed-badge">auto</span>' : ''}</label>
      <input name="${c.key}" type="${c.type}" value="${existente[c.key] != null ? ha(String(existente[c.key])) : ""}" class="form-control${c.readonly ? ' config-field-readonly' : ''}" id="modal-field-${c.key}"${c.readonly ? ' readonly tabindex="-1"' : ''}>
    </div>`).join("");

  if (tipo === "producto") {
    ['largo', 'ancho', 'alto'].forEach(k => {
      const el = document.getElementById(`modal-field-${k}`);
      if (el) el.addEventListener('input', _actualizarVolumenModal);
    });
    _actualizarVolumenModal();
  }

  if (tipo === "vehiculo") {
    ['largo_volumetria', 'ancho_volumetria', 'alto_volumetria'].forEach(k => {
      const el = document.getElementById(`modal-field-${k}`);
      if (el) el.addEventListener('input', _actualizarVolumenVehiculoModal);
    });
    _actualizarVolumenVehiculoModal();
  }

  document.getElementById("modal-overlay").classList.remove("hidden");
}

function _actualizarVolumenModal() {
  const largo = parseFloat(document.getElementById('modal-field-largo')?.value) || 0;
  const ancho = parseFloat(document.getElementById('modal-field-ancho')?.value) || 0;
  const alto  = parseFloat(document.getElementById('modal-field-alto')?.value)  || 0;
  const volEl = document.getElementById('modal-field-volumen');
  if (volEl) volEl.value = ((largo * ancho * alto) / 1_000_000).toFixed(6);
}

function _actualizarVolumenVehiculoModal() {
  const largo = parseFloat(document.getElementById('modal-field-largo_volumetria')?.value) || 0;
  const ancho = parseFloat(document.getElementById('modal-field-ancho_volumetria')?.value) || 0;
  const alto  = parseFloat(document.getElementById('modal-field-alto_volumetria')?.value)  || 0;
  const volEl = document.getElementById('modal-field-volumen_m3');
  if (volEl) volEl.value = (largo * ancho * alto).toFixed(6);
}

function cerrarModal() { document.getElementById("modal-overlay").classList.add("hidden"); }

async function guardarModal(e) {
    // 1. Evitamos que el botón recargue la vista y aborte el fetch
    if (e) e.preventDefault(); 

    const campos = modalTipo === "producto"          ? CAMPOS_PRODUCTO
                 : modalTipo === "sucursal"          ? CAMPOS_SUCURSAL
                 : modalTipo === "cliente_mayorista" ? CAMPOS_CLIENTE_MAYORISTA
                 : CAMPOS_VEHICULO;

    const payload = {};
    campos.forEach(({ key, type }) => {
        const el = document.getElementById(`modal-field-${key}`);
        if (!el) return;
        const raw = el.value.trim();

        if (raw === "") {
            // Campo vacío → null (permite múltiples nulos en MongoDB)
            payload[key] = null;
        } else if (type === "number") {
            const num = Number(raw);
            payload[key] = isNaN(num) ? null : num;
        } else {
            payload[key] = raw;
        }
    });

    const endpoint = getEndpoint(modalTipo);
    const url = modalMode === "create"
        ? `/configuracion/${endpoint}`
        : `/configuracion/${endpoint}/${modalDocId}`;
    const method = modalMode === "create" ? "POST" : "PUT";

    const label  = _TIPO_LABEL[modalTipo] || modalTipo;
    const titulo = modalMode === "create" ? `Creando ${label}` : `Guardando ${label}`;
    const msgs   = modalMode === "create" ? MSG_CFG.crear : MSG_CFG.editar;
    Loader.show(titulo, msgs);

    try {
        const res = await fetch(url, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        // Si Python devuelve un error 500 (ej. error de base de datos), evitamos que .json() rompa el código
        if (!res.ok) {
            alert(`Error del servidor: ${res.statusText}`);
            return;
        }

        const data = await res.json();

        if (data.status === "error") {
            alert(`Error: ${data.mensaje}`);
            return;
        }

        cerrarModal();
        cargarDatos(modalTipo);
    } catch (error) {
        console.error("Error al guardar:", error);
        alert("Ocurrió un error de red o de servidor al guardar.");
    } finally {
        Loader.hide();
    }
}


async function toggleActivo(docId, descripcion, abreviatura, placas, activo) {
  const confirmed = await mostrarConfirmEstado(descripcion, abreviatura, placas, activo);
  if (!confirmed) return;
  try {
    const res = await fetch(`/configuracion/vehiculos/${docId}/activo`, { method: "PUT" });
    if (res.ok) cargarDatos("vehiculo");
  } catch (err) {
    console.error("[toggleActivo]", err);
  }
}

async function eliminar(tipo, docId) {
  if (!confirm("¿Deseas eliminar este registro de forma permanente?")) return;
  const label = _TIPO_LABEL[tipo] || tipo;
  Loader.show(`Eliminando ${label}`, MSG_CFG.eliminar);
  try {
    const res = await fetch(`/configuracion/${getEndpoint(tipo)}/${docId}`, { method: "DELETE" });
    if (res.ok) cargarDatos(tipo);
  } finally {
    Loader.hide();
  }
}

function initSortableTables() {
  document.querySelectorAll("th.sortable").forEach(th => {
    th.addEventListener("click", () => {
      const table = th.closest("table");
      const tbody = table.querySelector("tbody");
      const rows  = Array.from(tbody.rows);
      const colIndex = Array.from(th.parentNode.children).indexOf(th);
      const isNum  = th.classList.contains("col-num");
      const wasAsc = th.classList.contains("asc");

      table.querySelectorAll("th").forEach(t => t.classList.remove("asc", "desc"));
      th.classList.add(wasAsc ? "desc" : "asc");
      const mult = wasAsc ? -1 : 1;

      rows.sort((a, b) => {
        let va = a.cells[colIndex]?.innerText.trim() || "";
        let vb = b.cells[colIndex]?.innerText.trim() || "";
        if (isNum) {
          va = parseFloat(va.replace(/[^0-9.-]+/g, "")) || 0;
          vb = parseFloat(vb.replace(/[^0-9.-]+/g, "")) || 0;
        } else { va = va.toLowerCase(); vb = vb.toLowerCase(); }
        return va < vb ? -mult : va > vb ? mult : 0;
      });
      tbody.append(...rows);
    });
  });
}

function h(s)  { return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function ha(s) { return String(s ?? "").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }