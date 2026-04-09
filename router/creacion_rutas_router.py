from flask import Blueprint, render_template, request, jsonify
from logic.creacion_rutas_logic import (
    obtener_rutas,
    obtener_ruta_por_id,
    crear_ruta,
    actualizar_ruta,
    eliminar_ruta,
    obtener_sucursales_disponibles,
    calcular_ruta_real,
)

creacion_rutas_bp = Blueprint('creacion_rutas', __name__)


# ── Vista HTML ─────────────────────────────────────────────────────────────────

@creacion_rutas_bp.route('/', methods=['GET'])
def index():
    return render_template('creacion_rutas/index.html')


# ── API: Rutas ─────────────────────────────────────────────────────────────────

@creacion_rutas_bp.route('/rutas', methods=['GET'])
def listar_rutas():
    """Devuelve todas las rutas preconfiguradas."""
    rutas = obtener_rutas()
    return jsonify(rutas)


@creacion_rutas_bp.route('/rutas/<ruta_id>', methods=['GET'])
def detalle_ruta(ruta_id: str):
    """Devuelve una ruta por su _id."""
    ruta = obtener_ruta_por_id(ruta_id)
    if ruta is None:
        return jsonify({'error': 'Ruta no encontrada'}), 404
    return jsonify(ruta)


@creacion_rutas_bp.route('/rutas', methods=['POST'])
def nueva_ruta():
    """Crea una nueva ruta preconfigurada."""
    datos = request.get_json(force=True)
    if not datos:
        return jsonify({'error': 'Body JSON requerido'}), 400

    resultado = crear_ruta(datos)
    if 'error' in resultado:
        return jsonify(resultado), 422
    return jsonify(resultado), 201


@creacion_rutas_bp.route('/rutas/<ruta_id>', methods=['PUT'])
def modificar_ruta(ruta_id: str):
    """Actualiza nombre, día sugerido y/o sucursales de una ruta."""
    datos = request.get_json(force=True)
    if not datos:
        return jsonify({'error': 'Body JSON requerido'}), 400

    resultado = actualizar_ruta(ruta_id, datos)
    if 'error' in resultado:
        return jsonify(resultado), 422
    return jsonify(resultado)


@creacion_rutas_bp.route('/rutas/<ruta_id>', methods=['DELETE'])
def borrar_ruta(ruta_id: str):
    """Elimina una ruta preconfigurada."""
    resultado = eliminar_ruta(ruta_id)
    if 'error' in resultado:
        return jsonify(resultado), 404
    return jsonify(resultado)


# ── API: Ruta real calculada con OSRM ─────────────────────────────────────────

@creacion_rutas_bp.route('/rutas/<ruta_id>/calcular', methods=['GET'])
def calcular_ruta(ruta_id: str):
    """
    Calcula la ruta real usando OSRM y devuelve la geometría con caché.

    Respuesta exitosa:
    {
        "desde_cache":        bool,
        "total_distancia_m":  float,
        "total_duracion_s":   float,
        "waypoints":          [{"lat": float, "lng": float}, …],
        "segmentos": [
            {
                "origen_idx":  int,
                "destino_idx": int,
                "coordenadas": [[lat, lng], …],
                "distancia_m": float,
                "duracion_s":  float,
            },
            …
        ]
    }
    """
    resultado = calcular_ruta_real(ruta_id)
    if 'error' in resultado:
        status = 404 if 'no encontrada' in resultado['error'].lower() else 502
        return jsonify(resultado), status
    return jsonify(resultado)


# ── API: Sucursales disponibles ────────────────────────────────────────────────

@creacion_rutas_bp.route('/sucursales-disponibles', methods=['GET'])
def sucursales_disponibles():
    """
    Devuelve sucursales que aún no han sido asignadas a ninguna ruta.
    Parámetro opcional ?excluir_ruta=<id>: excluye esa ruta del cálculo
    (útil al editar una ruta para que sus propias sucursales aparezcan disponibles).
    """
    excluir_ruta_id = request.args.get('excluir_ruta')
    sucursales = obtener_sucursales_disponibles(excluir_ruta_id)
    return jsonify(sucursales)