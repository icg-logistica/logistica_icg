"""
Lógica de negocio — Creación de Rutas Preconfiguradas
======================================================
Colecciones MongoDB utilizadas:
  · sucursales   → fuente de datos de tiendas (solo lectura aquí)
  · rutas_config → rutas preconfiguradas (CRUD completo)
  · osrm_cache   → caché de respuestas OSRM (nunca se guarda en disco)

Esquema de un documento en `rutas_config`:
{
    "_id":          ObjectId,
    "nombre":       str,
    "dia_sugerido": str | None,   # "Lunes" … "Viernes"
    "sucursales":   [             # lista ordenada
        {
            "_id":         str,   # ObjectId en string
            "num_tienda":  int,
            "nombre_base": str,
            "nombre_bimbo": str,
            "latitud":     float,
            "longitud":    float,
            "hora_inicio": str,
            "hora_fin":    str,
            "estado":      str,
            "orden":       int,   # posición en la ruta (1-based)
        },
        ...
    ],
    "creado_en":    datetime,
    "actualizado_en": datetime,
}

Esquema de un documento en `osrm_cache`:
{
    "_id":          ObjectId,
    "cache_key":    str,       # SHA-256 de waypoints (índice único)
    "ruta_id":      str,       # ruta_id para invalidación por ruta
    "data":         dict,      # respuesta completa normalizada
    "creado_en":    datetime,
    "accedido_en":  datetime,
}
"""

from __future__ import annotations

import hashlib
import json
import urllib.request
from datetime import datetime, timezone
from typing import Optional

from bson import ObjectId
from bson.errors import InvalidId
from flask import current_app

from db import get_db


def _obtener_config_general() -> dict:
    try:
        db = get_db()
        return db["configuracion"].find_one({"_tipo": {"$exists": False}}) or {}
    except Exception:
        return {}


# ── Colecciones ────────────────────────────────────────────────────────────────

COLECCION_RUTAS      = 'rutas_config'
COLECCION_SUCURSALES = 'sucursales'

DIAS_VALIDOS = {'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'}

# ── Caché OSRM en MongoDB (sin archivos locales) ───────────────────────────────

COLECCION_CACHE = 'osrm_cache'


def _cache_key(ruta_id: str, waypoints: list[dict]) -> str:
    """
    Genera una clave única basada en el ID de la ruta y los waypoints.
    SHA-256 de los waypoints invalida la caché automáticamente cuando
    cambian las coordenadas o el orden de las sucursales.
    """
    payload = json.dumps(waypoints, sort_keys=True)
    digest  = hashlib.sha256(payload.encode()).hexdigest()[:16]
    return f"{ruta_id}_{digest}"


def _leer_cache(key: str) -> Optional[dict]:
    """Consulta MongoDB; devuelve los datos cacheados o None si no existen."""
    try:
        db  = get_db()
        doc = db[COLECCION_CACHE].find_one_and_update(
            {'cache_key': key},
            {'$set': {'accedido_en': datetime.now(timezone.utc)}},
        )
        if doc:
            return doc['data']
    except Exception as exc:
        current_app.logger.warning("Error al leer caché OSRM en MongoDB: %s", exc)
    return None


def _escribir_cache(ruta_id: str, key: str, data: dict) -> None:
    """Guarda la respuesta OSRM en MongoDB. Nunca escribe en disco."""
    try:
        db  = get_db()
        ahora = datetime.now(timezone.utc)
        # Asegurar índice único en cache_key (silencia error si ya existe)
        try:
            db[COLECCION_CACHE].create_index('cache_key', unique=True, background=True)
        except Exception:
            pass
        db[COLECCION_CACHE].update_one(
            {'cache_key': key},
            {'$set': {
                'cache_key':   key,
                'ruta_id':     ruta_id,
                'data':        data,
                'creado_en':   ahora,
                'accedido_en': ahora,
            }},
            upsert=True,
        )
    except Exception as exc:
        current_app.logger.warning("Error al escribir caché OSRM en MongoDB: %s", exc)


def _invalidar_cache_ruta(ruta_id: str) -> None:
    """Elimina de MongoDB todos los documentos de caché asociados a una ruta."""
    try:
        db = get_db()
        db[COLECCION_CACHE].delete_many({'ruta_id': ruta_id})
    except Exception as exc:
        current_app.logger.warning("Error al invalidar caché OSRM en MongoDB: %s", exc)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _oid(raw: str) -> Optional[ObjectId]:
    """Convierte string a ObjectId; devuelve None si es inválido."""
    try:
        return ObjectId(raw)
    except (InvalidId, TypeError):
        return None


def _serializar_ruta(doc: dict) -> dict:
    """Convierte un documento MongoDB a dict JSON-serializable."""
    if doc is None:
        return {}
    doc['_id'] = str(doc['_id'])
    # Serializar fechas
    for campo in ('creado_en', 'actualizado_en'):
        if isinstance(doc.get(campo), datetime):
            doc[campo] = doc[campo].isoformat()
    # Serializar _id de sucursales anidadas (por si acaso)
    for suc in doc.get('sucursales', []):
        if isinstance(suc.get('_id'), ObjectId):
            suc['_id'] = str(suc['_id'])
    return doc


def _serializar_sucursal(doc: dict) -> dict:
    """Convierte un documento de sucursal a dict JSON-serializable."""
    if doc is None:
        return {}
    doc['_id'] = str(doc['_id'])
    # Normalizar coordenadas almacenadas como Decimal128 o dict BSON
    for campo in ('latitud', 'longitud'):
        val = doc.get(campo)
        if val is not None and not isinstance(val, (int, float)):
            try:
                doc[campo] = float(str(val))
            except (ValueError, TypeError):
                doc[campo] = None
    return doc


def _ids_sucursales_en_rutas(excluir_ruta_id: Optional[str] = None) -> set:
    """
    Devuelve el conjunto de num_tienda (int) de todas las sucursales
    ya asignadas a alguna ruta, opcionalmente excluyendo una ruta.
    """
    db = get_db()
    filtro = {}
    if excluir_ruta_id:
        oid = _oid(excluir_ruta_id)
        if oid:
            filtro['_id'] = {'$ne': oid}

    asignados = set()
    for ruta in db[COLECCION_RUTAS].find(filtro, {'sucursales.num_tienda': 1}):
        for suc in ruta.get('sucursales', []):
            asignados.add(suc.get('num_tienda'))
    return asignados


def _validar_payload(datos: dict) -> Optional[str]:
    """Valida los campos obligatorios del payload. Devuelve mensaje de error o None."""
    if not datos.get('nombre', '').strip():
        return 'El campo "nombre" es obligatorio y no puede estar vacío.'
    dia = datos.get('dia_sugerido')
    if dia and dia not in DIAS_VALIDOS:
        return f'"dia_sugerido" debe ser uno de: {", ".join(sorted(DIAS_VALIDOS))}.'
    sucursales = datos.get('sucursales', [])
    if not isinstance(sucursales, list) or len(sucursales) == 0:
        return 'Se requiere al menos una sucursal en "sucursales".'
    return None


# ── CRUD de Rutas ──────────────────────────────────────────────────────────────

def obtener_rutas() -> list[dict]:
    """Devuelve todas las rutas ordenadas por nombre."""
    db = get_db()
    docs = list(db[COLECCION_RUTAS].find({}).sort('nombre', 1))
    return [_serializar_ruta(d) for d in docs]


def obtener_ruta_por_id(ruta_id: str) -> Optional[dict]:
    """Devuelve una ruta por su _id, o None si no existe."""
    oid = _oid(ruta_id)
    if not oid:
        return None
    db  = get_db()
    doc = db[COLECCION_RUTAS].find_one({'_id': oid})
    return _serializar_ruta(doc) if doc else None


def crear_ruta(datos: dict) -> dict:
    """
    Crea una nueva ruta preconfigurada.

    Payload esperado:
    {
        "nombre":       str,
        "dia_sugerido": str | null,
        "sucursales":   [ { num_tienda, nombre_base, latitud, longitud, orden, … } ]
    }
    """
    error = _validar_payload(datos)
    if error:
        return {'error': error}

    ahora = datetime.now(timezone.utc)
    doc = {
        'nombre':          datos['nombre'].strip(),
        'dia_sugerido':    datos.get('dia_sugerido') or None,
        'sucursales':      _normalizar_sucursales(datos['sucursales']),
        'creado_en':       ahora,
        'actualizado_en':  ahora,
    }

    db     = get_db()
    result = db[COLECCION_RUTAS].insert_one(doc)
    return {'status': 'ok', 'id': str(result.inserted_id)}


def actualizar_ruta(ruta_id: str, datos: dict) -> dict:
    """
    Actualiza nombre, día sugerido y/o sucursales de una ruta existente.
    Solo se modifican los campos presentes en el payload.
    Invalida la caché de routing al actualizar sucursales.
    """
    oid = _oid(ruta_id)
    if not oid:
        return {'error': 'ID de ruta inválido.'}

    db  = get_db()
    doc = db[COLECCION_RUTAS].find_one({'_id': oid}, {'_id': 1})
    if not doc:
        return {'error': 'Ruta no encontrada.'}

    campos: dict = {'actualizado_en': datetime.now(timezone.utc)}
    invalida_cache = False

    if 'nombre' in datos:
        nombre = datos['nombre'].strip()
        if not nombre:
            return {'error': 'El campo "nombre" no puede estar vacío.'}
        campos['nombre'] = nombre

    if 'dia_sugerido' in datos:
        dia = datos['dia_sugerido']
        if dia and dia not in DIAS_VALIDOS:
            return {'error': f'"dia_sugerido" debe ser uno de: {", ".join(sorted(DIAS_VALIDOS))}.'}
        campos['dia_sugerido'] = dia or None

    if 'sucursales' in datos:
        sucursales = datos['sucursales']
        if not isinstance(sucursales, list) or len(sucursales) == 0:
            return {'error': 'Se requiere al menos una sucursal.'}
        campos['sucursales'] = _normalizar_sucursales(sucursales)
        invalida_cache = True

    db[COLECCION_RUTAS].update_one({'_id': oid}, {'$set': campos})

    if invalida_cache:
        _invalidar_cache_ruta(ruta_id)

    return {'status': 'ok'}


def eliminar_ruta(ruta_id: str) -> dict:
    """Elimina una ruta preconfigurada por su _id e invalida su caché."""
    oid = _oid(ruta_id)
    if not oid:
        return {'error': 'ID de ruta inválido.'}

    db     = get_db()
    result = db[COLECCION_RUTAS].delete_one({'_id': oid})
    if result.deleted_count == 0:
        return {'error': 'Ruta no encontrada.'}

    _invalidar_cache_ruta(ruta_id)
    return {'status': 'ok'}


# ── Sucursales disponibles ─────────────────────────────────────────────────────

def obtener_sucursales_disponibles(excluir_ruta_id: Optional[str] = None) -> list[dict]:
    """
    Devuelve las sucursales que no están asignadas a ninguna ruta activa.
    Si `excluir_ruta_id` se indica, las sucursales de esa ruta se consideran
    disponibles (útil al editar dicha ruta).
    """
    asignados = _ids_sucursales_en_rutas(excluir_ruta_id)
    db = get_db()

    filtro = {}
    if asignados:
        filtro['num_tienda'] = {'$nin': list(asignados)}

    docs = list(db[COLECCION_SUCURSALES].find(filtro).sort('nombre_base', 1))
    return [_serializar_sucursal(d) for d in docs]


# ── Cálculo de ruta real con OSRM ─────────────────────────────────────────────

OSRM_BASE_URL = 'https://router.project-osrm.org/route/v1/driving'
# Límite de waypoints por petición (OSRM público tiene restricciones)
OSRM_MAX_WAYPOINTS = 25


def calcular_ruta_real(ruta_id: str) -> dict:
    """
    Calcula la ruta real usando la API OSRM y la guarda en caché.

    Devuelve:
    {
        "desde_cache": bool,
        "segmentos":   [                        # Lista de polilíneas por tramo
            {
                "origen_idx": int,              # Índice del waypoint de origen (0 = Matriz)
                "destino_idx": int,
                "coordenadas": [[lat, lng], …], # Geometría decodificada
                "distancia_m": float,
                "duracion_s":  float,
            },
            …
        ],
        "total_distancia_m": float,
        "total_duracion_s":  float,
        "waypoints": [                          # Coordenadas snap de OSRM
            {"lat": float, "lng": float},
            …
        ],
    }
    """
    ruta = obtener_ruta_por_id(ruta_id)
    if not ruta:
        return {'error': 'Ruta no encontrada.'}
    if not ruta.get('sucursales'):
        return {'error': 'La ruta no tiene sucursales.'}

    # Construir lista de waypoints: Matriz → sucursales → Matriz
    cfg        = _obtener_config_general()
    MATRIZ_LAT = float(cfg.get("matriz_lat") or 18.87319171873997)
    MATRIZ_LNG = float(cfg.get("matriz_lon") or -96.94921750442464)

    wps = [{'lat': MATRIZ_LAT, 'lng': MATRIZ_LNG}]
    for suc in sorted(ruta['sucursales'], key=lambda s: s.get('orden', 0)):
        wps.append({'lat': suc['latitud'], 'lng': suc['longitud']})
    wps.append({'lat': MATRIZ_LAT, 'lng': MATRIZ_LNG})

    # Verificar caché
    key       = _cache_key(ruta_id, wps)
    cached    = _leer_cache(key)
    if cached:
        cached['desde_cache'] = True
        return cached

    # Llamar a OSRM — si hay muchos waypoints, dividir en bloques solapados
    try:
        resultado = _osrm_trip(wps)
    except Exception as exc:
        current_app.logger.error("Error OSRM: %s", exc)
        return {'error': f'Error al calcular la ruta: {exc}'}

    resultado['desde_cache'] = False
    _escribir_cache(ruta_id, key, resultado)
    return resultado


def _osrm_trip(waypoints: list[dict]) -> dict:
    """
    Llama a OSRM /route/v1/driving con los waypoints dados.
    Si supera OSRM_MAX_WAYPOINTS, divide en segmentos solapados y los une.
    Devuelve el dict con segmentos, totales y waypoints snapeados.
    """
    if len(waypoints) <= OSRM_MAX_WAYPOINTS:
        return _osrm_route_single(waypoints)

    # Dividir respetando inicio y fin compartidos
    chunks     = []
    step       = OSRM_MAX_WAYPOINTS - 1   # solapamiento de 1 punto
    i          = 0
    while i < len(waypoints) - 1:
        chunk = waypoints[i: i + OSRM_MAX_WAYPOINTS]
        chunks.append(chunk)
        i += step

    segmentos         = []
    total_dist        = 0.0
    total_dur         = 0.0
    snapped_waypoints = []
    offset            = 0

    for chunk in chunks:
        parcial = _osrm_route_single(chunk)
        for seg in parcial['segmentos']:
            seg['origen_idx']  += offset
            seg['destino_idx'] += offset
            segmentos.append(seg)
        total_dist += parcial['total_distancia_m']
        total_dur  += parcial['total_duracion_s']
        # Evitar duplicar el punto de unión entre chunks
        if not snapped_waypoints:
            snapped_waypoints.extend(parcial['waypoints'])
        else:
            snapped_waypoints.extend(parcial['waypoints'][1:])
        offset += len(chunk) - 1

    return {
        'segmentos':          segmentos,
        'total_distancia_m':  total_dist,
        'total_duracion_s':   total_dur,
        'waypoints':          snapped_waypoints,
    }


def _osrm_route_single(waypoints: list[dict]) -> dict:
    """
    Realiza una única llamada OSRM /route para la lista de waypoints dada.
    Devuelve segmentos con geometría decodificada (polyline6 → coordenadas).
    """
    coords_str = ';'.join(f"{wp['lng']},{wp['lat']}" for wp in waypoints)
    url = (
        f"{OSRM_BASE_URL}/{coords_str}"
        f"?overview=full&geometries=geojson&steps=false&annotations=false"
    )

    req = urllib.request.Request(
        url,
        headers={'User-Agent': 'ICG-RouteApp/1.0 (contact@empresa.com)'},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode('utf-8'))

    if data.get('code') != 'Ok':
        raise RuntimeError(f"OSRM devolvió código: {data.get('code')} — {data.get('message','')}")

    ruta_osrm = data['routes'][0]
    legs       = ruta_osrm['legs']          # N-1 tramos para N waypoints

    # Geometría completa de cada tramo (GeoJSON LineString)
    # OSRM devuelve las coordenadas en [lng, lat]; invertimos a [lat, lng]
    segmentos = []
    for i, leg in enumerate(legs):
        # La geometría está en el nivel de ruta cuando overview=full,
        # por lo que extraemos los puntos proporcionales al tramo
        segmentos.append({
            'origen_idx':  i,
            'destino_idx': i + 1,
            'distancia_m': leg['distance'],
            'duracion_s':  leg['duration'],
        })

    # Geometría completa de la ruta (todos los tramos juntos)
    geom_coords = ruta_osrm['geometry']['coordinates']  # [[lng, lat], …]
    coords_latlon = [[c[1], c[0]] for c in geom_coords]

    # Distribuir coordenadas de la polilínea por tramo usando distancias relativas
    total_dist_ruta = ruta_osrm['distance'] or 1
    acum = 0.0
    puntos_por_tramo = [[] for _ in legs]
    n_puntos = len(coords_latlon)

    if n_puntos > 0:
        # Asignación proporcional: cada tramo toma la porción de la geometría
        # proporcional a su distancia.
        idx_punto = 0
        for t_idx, seg in enumerate(segmentos):
            fraccion = seg['distancia_m'] / total_dist_ruta
            n_pts    = max(2, round(fraccion * n_puntos))
            fin      = min(idx_punto + n_pts, n_puntos)
            puntos_por_tramo[t_idx] = coords_latlon[idx_punto:fin]
            idx_punto = fin - 1  # solapar el último punto con el siguiente tramo

        # Garantizar que el último tramo llega al último punto
        if puntos_por_tramo and coords_latlon:
            puntos_por_tramo[-1].append(coords_latlon[-1])

    for i, seg in enumerate(segmentos):
        seg['coordenadas'] = puntos_por_tramo[i]

    # Waypoints snapeados devueltos por OSRM
    snapped = []
    for wp in data.get('waypoints', []):
        loc = wp.get('location', [0, 0])
        snapped.append({'lat': loc[1], 'lng': loc[0]})

    return {
        'segmentos':         segmentos,
        'total_distancia_m': ruta_osrm['distance'],
        'total_duracion_s':  ruta_osrm['duration'],
        'waypoints':         snapped,
    }


# ── Helper interno ─────────────────────────────────────────────────────────────

def _normalizar_sucursales(raw: list) -> list:
    """
    Normaliza la lista de sucursales garantizando que tengan los campos
    mínimos necesarios y el campo `orden` correcto (1-based).
    Usa `nombre_base` como campo canónico de nombre de sucursal.
    """
    resultado = []
    for i, suc in enumerate(raw):
        resultado.append({
            '_id':          suc.get('_id', ''),
            'num_tienda':   int(suc.get('num_tienda', 0)),
            'nombre_base':  suc.get('nombre_base', ''),
            'nombre_bimbo': suc.get('nombre_bimbo', ''),
            'estado':       suc.get('estado', ''),
            'latitud':      float(suc.get('latitud', 0) or 0),
            'longitud':     float(suc.get('longitud', 0) or 0),
            'hora_inicio':  suc.get('hora_inicio', ''),
            'hora_fin':     suc.get('hora_fin', ''),
            'orden':        i + 1,
        })
    return resultado