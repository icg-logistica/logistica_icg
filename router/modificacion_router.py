"""
router/modificacion_router.py
Blueprint Flask para la Sección 6 — Modificación manual de rutas.
Pasa logistica_id a todas las funciones de lógica.
"""
from flask import Blueprint, render_template, request, jsonify, session
from logic.modificacion_logic import (
    obtener_rutas_para_modificar,
    obtener_sucursales_disponibles,
    obtener_pesos,
    calcular_tiempos_subruta,
    calcular_tiempos_lote,
    guardar_modificacion,
    obtener_modificacion_previa,
)

modificacion_bp = Blueprint("modificacion", __name__)


def _json_o_400():
    datos = request.get_json(silent=True)
    if datos is None:
        return None, (jsonify({"status": "error", "mensaje": "Cuerpo JSON inválido"}), 400)
    return datos, None


def _logistica_id() -> str | None:
    return session.get("logistica_id")


def _requiere_logistica():
    lid = _logistica_id()
    if not lid:
        return None, (
            jsonify({"status": "error", "mensaje": "No hay logística activa. Selecciona una desde el menú."}),
            400,
        )
    return lid, None


@modificacion_bp.route("/", methods=["GET"])
def index():
    return render_template("modificacion/index.html")


@modificacion_bp.route("/rutas", methods=["GET"])
def get_rutas():
    lid, err = _requiere_logistica()
    if err:
        return err
    try:
        return jsonify(obtener_rutas_para_modificar(lid))
    except Exception as e:
        return jsonify({"status": "error", "mensaje": str(e)}), 500


@modificacion_bp.route("/sucursales", methods=["GET"])
def get_sucursales():
    try:
        return jsonify(obtener_sucursales_disponibles())
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@modificacion_bp.route("/pesos", methods=["GET"])
def get_pesos():
    lid, err = _requiere_logistica()
    if err:
        return err
    try:
        return jsonify(obtener_pesos(lid))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@modificacion_bp.route("/recalcular-tiempos", methods=["POST"])
def post_recalcular():
    lid, err = _requiere_logistica()
    if err:
        return err
    datos, err2 = _json_o_400()
    if err2:
        return err2

    sucursales = datos.get("sucursales")
    if not isinstance(sucursales, list):
        return jsonify({"status": "error", "mensaje": "Se esperaba { sucursales: [...] }"}), 400

    pesos = obtener_pesos(lid)
    try:
        return jsonify(calcular_tiempos_subruta(sucursales, pesos))
    except Exception as e:
        return jsonify({"status": "error", "mensaje": str(e)}), 500


@modificacion_bp.route("/calcular-lote", methods=["POST"])
def post_calcular_lote():
    lid, err = _requiere_logistica()
    if err:
        return err
    datos, err2 = _json_o_400()
    if err2:
        return err2

    rutas = datos.get("rutas")
    if not isinstance(rutas, list):
        return jsonify({"status": "error", "mensaje": "Se esperaba { rutas: [...] }"}), 400

    pesos = obtener_pesos(lid)
    try:
        resultados = calcular_tiempos_lote(rutas, pesos)
        return jsonify({"status": "ok", "resultados": resultados})
    except Exception as e:
        return jsonify({"status": "error", "mensaje": str(e)}), 500


@modificacion_bp.route("/guardar", methods=["POST"])
def post_guardar():
    lid, err = _requiere_logistica()
    if err:
        return err
    datos, err2 = _json_o_400()
    if err2:
        return err2
    resultado = guardar_modificacion(datos, lid)
    code = 200 if resultado.get("status") == "ok" else 500
    return jsonify(resultado), code


@modificacion_bp.route("/previa", methods=["GET"])
def get_previa():
    lid, err = _requiere_logistica()
    if err:
        return err
    try:
        return jsonify(obtener_modificacion_previa(lid))
    except Exception as e:
        return jsonify({"error": str(e)}), 500