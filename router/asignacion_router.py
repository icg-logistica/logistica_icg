"""
router/asignacion_router.py
Blueprint Flask para la Sección 3 — Asignación de Rutas.
"""
from flask import Blueprint, render_template, request, jsonify, session
from logic.asignacion_logic import (
    asignar_rutas,
    obtener_rutas,
    obtener_vehiculos,
    obtener_pesos,
    obtener_volumenes,
    obtener_config_dias,
    guardar_config_dias,
    guardar_asignacion,
    obtener_asignaciones_previas,
    calcular_tiempos_ruta,
    calcular_tiempos_multiples_rutas,
    consultar_osrm,
    generar_asignacion_optimizada,
)

asignacion_bp = Blueprint("asignacion", __name__)


def _json_o_400():
    datos = request.get_json(silent=True)
    if datos is None:
        return None, (jsonify({"status": "error", "mensaje": "Cuerpo JSON inválido o Content-Type incorrecto"}), 400)
    return datos, None


def _logistica_id() -> "str | None":
    return session.get("logistica_id")


def _requiere_logistica():
    lid = _logistica_id()
    if not lid:
        return None, (
            jsonify({"status": "error", "mensaje": "No hay logística activa. Selecciona una desde el menú."}),
            400,
        )
    return lid, None


# ── Página principal ───────────────────────────────────────────
@asignacion_bp.route("/", methods=["GET"])
def index():
    return render_template("asignacion/index.html")


# ── Rutas de MongoDB ───────────────────────────────────────────
@asignacion_bp.route("/rutas", methods=["GET"])
def get_rutas():
    try:
        return jsonify(obtener_rutas())
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Vehículos ──────────────────────────────────────────────────
@asignacion_bp.route("/vehiculos", methods=["GET"])
def get_vehiculos():
    try:
        return jsonify(obtener_vehiculos())
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Pesos del consolidado ──────────────────────────────────────
@asignacion_bp.route("/pesos", methods=["GET"])
def get_pesos():
    lid, err = _requiere_logistica()
    if err:
        return err
    try:
        return jsonify(obtener_pesos(lid))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Volúmenes del consolidado ──────────────────────────────────
@asignacion_bp.route("/volumenes", methods=["GET"])
def get_volumenes():
    lid, err = _requiere_logistica()
    if err:
        return err
    try:
        return jsonify(obtener_volumenes(lid))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Cálculo de tiempos ─────────────────────────────────────────
@asignacion_bp.route("/calcular-tiempos", methods=["POST"])
def post_calcular_tiempos():
    lid, err = _requiere_logistica()
    if err:
        return err

    datos, err2 = _json_o_400()
    if err2:
        return err2

    rutas = datos.get("rutas")
    if not isinstance(rutas, list):
        return jsonify({"status": "error", "mensaje": "Se esperaba { rutas: [...] }"}), 400

    pesos = datos.get("pesos") or obtener_pesos(lid)
    try:
        return jsonify(calcular_tiempos_multiples_rutas(rutas, pesos))
    except Exception as e:
        return jsonify({"status": "error", "mensaje": str(e)}), 500


@asignacion_bp.route("/calcular-tiempos/<ruta_id>", methods=["GET"])
def get_calcular_tiempos_ruta(ruta_id: str):
    lid, err = _requiere_logistica()
    if err:
        return err
    try:
        rutas = obtener_rutas()
        ruta  = next((r for r in rutas if str(r.get("_id")) == ruta_id), None)
        if not ruta:
            return jsonify({"error": "Ruta no encontrada"}), 404
        pesos     = obtener_pesos(lid)
        resultado = calcular_tiempos_ruta(ruta, pesos)
        return jsonify(resultado)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Configuración de días ──────────────────────────────────────
@asignacion_bp.route("/config-dias", methods=["GET"])
def get_config_dias():
    lid = _logistica_id()
    return jsonify(obtener_config_dias(lid))


@asignacion_bp.route("/config-dias", methods=["POST"])
def post_config_dias():
    lid, err = _requiere_logistica()
    if err:
        return err
    datos, err2 = _json_o_400()
    if err2:
        return err2
    return jsonify(guardar_config_dias(datos, lid))


# ── Asignaciones previas ───────────────────────────────────────
@asignacion_bp.route("/asignaciones", methods=["GET"])
def get_asignaciones():
    lid = _logistica_id()
    return jsonify(obtener_asignaciones_previas(lid))


# ── Guardar asignación ─────────────────────────────────────────
@asignacion_bp.route("/guardar", methods=["POST"])
def post_guardar():
    lid, err = _requiere_logistica()
    if err:
        return err
    datos, err2 = _json_o_400()
    if err2:
        return err2
    resultado = guardar_asignacion(datos, lid)
    code = 200 if resultado.get("status") == "ok" else 500
    return jsonify(resultado), code


# ── NUEVA: Generar asignación optimizada ──────────────────────
@asignacion_bp.route("/generar-asignacion", methods=["POST"])
def post_generar_asignacion():
    """
    Recibe:
      {
        rutas:         [...],          // rutas seleccionadas
        vehiculos:     [...],          // flota disponible
        pesos:         { id: kg },     // pesos de la extracción
        config_dias:   { lunes: {...}, ... },
        ids_excluidos: ["id1", ...],   // entregadas / deseleccionadas
      }
    Retorna:
      {
        status: "ok",
        asignaciones: { ruta_id: { dia, placas, pct, peso_kg } },
        resumen_dias: { ... },
        total_rutas:  N,
        sin_vehiculo: M,
      }
    """
    lid, err = _requiere_logistica()
    if err:
        return err

    datos, err2 = _json_o_400()
    if err2:
        return err2

    try:
        resultado = generar_asignacion_optimizada(datos, lid)
        code = 200 if resultado.get("status") == "ok" else 422
        return jsonify(resultado), code
    except Exception as e:
        return jsonify({"status": "error", "mensaje": str(e)}), 500


# ── Endpoint legacy ────────────────────────────────────────────
@asignacion_bp.route("/asignar", methods=["POST"])
def asignar():
    lid, err = _requiere_logistica()
    if err:
        return err
    datos, err2 = _json_o_400()
    if err2:
        return err2
    return jsonify(asignar_rutas(datos, lid))