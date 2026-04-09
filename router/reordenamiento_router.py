"""
router/reordenamiento_router.py
Blueprint Flask para la Sección 5 — Reordenamiento de Rutas.
Pasa logistica_id a todas las funciones de lógica.
"""
from flask import Blueprint, render_template, request, jsonify, session
from logic.reordenamiento_logic import (
    obtener_datos_reordenamiento,
    ejecutar_reorganizacion,
    guardar_reordenamiento,
    obtener_reordenamiento_previo,
)

reordenamiento_bp = Blueprint("reordenamiento", __name__)


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


@reordenamiento_bp.route("/", methods=["GET"])
def index():
    return render_template("reordenamiento/index.html")


@reordenamiento_bp.route("/datos", methods=["GET"])
def get_datos():
    lid, err = _requiere_logistica()
    if err:
        return err
    try:
        return jsonify(obtener_datos_reordenamiento(lid))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@reordenamiento_bp.route("/ejecutar", methods=["POST"])
def post_ejecutar():
    lid, err = _requiere_logistica()
    if err:
        return err
    try:
        return jsonify(ejecutar_reorganizacion(lid))
    except Exception as e:
        return jsonify({"status": "error", "mensaje": str(e)}), 500


@reordenamiento_bp.route("/previo", methods=["GET"])
def get_previo():
    lid, err = _requiere_logistica()
    if err:
        return err
    try:
        return jsonify(obtener_reordenamiento_previo(lid))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@reordenamiento_bp.route("/guardar", methods=["POST"])
def post_guardar():
    lid, err = _requiere_logistica()
    if err:
        return err
    datos, err2 = _json_o_400()
    if err2:
        return err2
    resultado = guardar_reordenamiento(datos, lid)
    code = 200 if resultado.get("status") == "ok" else 500
    return jsonify(resultado), code


# Compatibilidad con blueprint original
@reordenamiento_bp.route("/mover", methods=["POST"])
def mover():
    lid, err = _requiere_logistica()
    if err:
        return err
    try:
        return jsonify(ejecutar_reorganizacion(lid))
    except Exception as e:
        return jsonify({"status": "error", "mensaje": str(e)}), 500