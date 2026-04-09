"""
router/validacion_router.py
Blueprint Flask para la Sección 4 — Validación de Rutas.
Pasa logistica_id a todas las funciones de lógica.
"""
from flask import Blueprint, render_template, request, jsonify, session
from logic.validacion_logic import (
    obtener_rutas_para_validacion,
    guardar_validacion,
    obtener_validacion_previa,
)

validacion_bp = Blueprint("validacion", __name__)


def _json_o_400():
    datos = request.get_json(silent=True)
    if datos is None:
        return None, (jsonify({"status": "error", "mensaje": "Cuerpo JSON inválido o Content-Type incorrecto"}), 400)
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


@validacion_bp.route("/", methods=["GET"])
def index():
    return render_template("validacion/index.html")


@validacion_bp.route("/rutas", methods=["GET"])
def get_rutas():
    lid, err = _requiere_logistica()
    if err:
        return err
    try:
        return jsonify(obtener_rutas_para_validacion(lid))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@validacion_bp.route("/previa", methods=["GET"])
def get_previa():
    lid, err = _requiere_logistica()
    if err:
        return err
    try:
        return jsonify(obtener_validacion_previa(lid))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@validacion_bp.route("/guardar", methods=["POST"])
def post_guardar():
    lid, err = _requiere_logistica()
    if err:
        return err
    datos, err2 = _json_o_400()
    if err2:
        return err2
    resultado = guardar_validacion(datos, lid)
    code = 200 if resultado.get("status") == "ok" else 500
    return jsonify(resultado), code