"""
logic/modificacion_logic.py
Lógica de negocio para la Sección 6 — Modificación manual de rutas.

Lee datos desde:
  - `validaciones`       → rutas autorizadas
  - `reordenamientos`    → subrutas generadas
  - `extraccion`         → pesos de sucursales
  - `cache_osrm`         → caché de geometría OSRM

Guarda en:
  - `modificaciones_rutas`  (con logistica_id)

No se usan archivos JSON.
"""
import math
import time
import urllib.request
import urllib.error
from datetime import datetime
from bson import ObjectId
from bson.errors import InvalidId

from db import get_db

# ── Constantes ────────────────────────────────────────────────
MIN_DESCARGA_POR_KG  = 0.1
MAX_DESCARGA_MIN     = 120
HORAS_EXTRA_RUTA_MIN = 0
MATRIZ_LAT_DEFAULT   = 18.87329315661368
MATRIZ_LON_DEFAULT   = -96.9491574270346

OSRM_BASE_URL    = "https://router.project-osrm.org/route/v1/driving"
OSRM_TIMEOUT     = 20
OSRM_MAX_RETRIES = 3
OSRM_RETRY_DELAY = 1.5


def _parse_oid(doc_id: str) -> ObjectId | None:
    try:
        return ObjectId(doc_id)
    except (InvalidId, TypeError):
        return None


def _serialize(doc: dict) -> dict:
    doc = dict(doc)
    if "_id" in doc and isinstance(doc["_id"], ObjectId):
        doc["_id"] = str(doc["_id"])
    return doc


def _obtener_config_general() -> dict:
    try:
        db = get_db()
        return db["configuracion"].find_one({"_tipo": {"$exists": False}}) or {}
    except Exception:
        return {}


# ── Caché OSRM en MongoDB ──────────────────────────────────────

def _cache_key(coords: list) -> str:
    return ";".join(f"{lat:.5f},{lon:.5f}" for lat, lon in coords)


def _cargar_cache_geo(clave: str) -> dict | None:
    """Lee caché de geometría desde MongoDB."""
    try:
        db  = get_db()
        doc = db["cache_osrm"].find_one({"clave": clave, "tipo": "geometria"})
        return doc["resultado"] if doc else None
    except Exception:
        return None


def _guardar_cache_geo(clave: str, resultado: dict) -> None:
    """Persiste caché de geometría en MongoDB."""
    try:
        db = get_db()
        db["cache_osrm"].update_one(
            {"clave": clave, "tipo": "geometria"},
            {"$set": {"resultado": resultado, "actualizado_en": datetime.now().isoformat()}},
            upsert=True,
        )
    except Exception as e:
        print(f"[OSRM cache geo] Error: {e}")


# ── OSRM con reintentos y geometría ───────────────────────────

def consultar_osrm_con_reintentos(coords: list) -> dict:
    if len(coords) < 2:
        return {"distancia_km": 0.0, "traslado_min": 0.0, "origen": "osrm", "geometry": []}

    waypoints = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in coords)
    url = f"{OSRM_BASE_URL}/{waypoints}?overview=full&geometries=geojson"
    ultimo_error = None

    for intento in range(OSRM_MAX_RETRIES):
        try:
            if intento > 0:
                time.sleep(OSRM_RETRY_DELAY)
            import json as _json
            req = urllib.request.Request(url, headers={
                "User-Agent": "ICG-RouteModification/1.0",
                "Accept": "application/json",
            })
            with urllib.request.urlopen(req, timeout=OSRM_TIMEOUT) as resp:
                data = _json.loads(resp.read().decode("utf-8"))

            if data.get("code") != "Ok" or not data.get("routes"):
                ultimo_error = f"OSRM: {data.get('code', '?')}"
                continue

            ruta     = data["routes"][0]
            geometry = ruta.get("geometry", {}).get("coordinates", [])
            return {
                "distancia_km": round(ruta.get("distance", 0) / 1000, 2),
                "traslado_min": round(ruta.get("duration", 0) / 60, 1),
                "origen":       "osrm",
                "geometry":     geometry,
            }
        except urllib.error.HTTPError as e:
            ultimo_error = f"HTTP {e.code}"
            if e.code == 429:
                time.sleep(OSRM_RETRY_DELAY * 2)
        except Exception as e:
            ultimo_error = str(e)

    return {"error": ultimo_error or "Agotados reintentos", "origen": "osrm_error"}


def _haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _fallback_haversine(coords: list, velocidad_kmh: float = 35.0) -> dict:
    dist = sum(
        _haversine_km(coords[i][0], coords[i][1], coords[i+1][0], coords[i+1][1])
        for i in range(len(coords) - 1)
    )
    dist_via = dist * 1.35
    return {
        "distancia_km": round(dist_via, 2),
        "traslado_min": round((dist_via / velocidad_kmh) * 60, 1),
        "origen": "haversine_fallback",
        "geometry": [],
    }


# ── Helpers de lectura MongoDB ─────────────────────────────────

def _obtener_rutas_db() -> dict:
    result = {}
    try:
        db = get_db()
        for ruta in db["rutas_config"].find({}):
            ruta_s = _serialize(ruta)
            result[ruta_s["_id"]] = ruta_s
    except Exception as e:
        print(f"[_obtener_rutas_db] Error: {e}")
    return result


def _obtener_coordenadas_sucursales() -> dict:
    coords = {}
    try:
        db = get_db()
        for ruta in db["rutas_config"].find({}):
            for suc in ruta.get("sucursales", []):
                nt  = str(suc.get("num_tienda", ""))
                lat = suc.get("latitud")
                lon = suc.get("longitud")
                if nt and lat is not None and lon is not None:
                    coords[nt] = {"latitud": float(lat), "longitud": float(lon)}
    except Exception as e:
        print(f"[_obtener_coordenadas_sucursales] Error: {e}")
    return coords


def obtener_sucursales_disponibles() -> list:
    sucursales = {}
    try:
        db = get_db()
        for ruta in db["rutas_config"].find({}):
            for suc in ruta.get("sucursales", []):
                nt = str(suc.get("num_tienda", ""))
                if nt and nt not in sucursales:
                    sucursales[nt] = {
                        "num_tienda": suc.get("num_tienda"),
                        "nombre": suc.get("nombre_tienda") or suc.get("nombre_pedido") or suc.get("nombre", ""),
                        "latitud":  suc.get("latitud"),
                        "longitud": suc.get("longitud"),
                    }
    except Exception as e:
        print(f"[obtener_sucursales_disponibles] Error: {e}")
    return list(sucursales.values())


def obtener_pesos(logistica_id: str) -> dict:
    """Lee los pesos desde la colección `extraccion` para la logística activa."""
    oid = _parse_oid(logistica_id)
    if not oid:
        return {}
    try:
        db  = get_db()
        doc = db["extraccion"].find_one({"logistica_id": oid})
        if not doc:
            return {}
        data  = doc.get("datos", {})
        pesos = {}
        for nombre, valores in data.items():
            id_suc = valores.get("id_sucursal")
            peso   = valores.get("total_kg", 0)
            if id_suc is not None:
                pesos[str(id_suc)] = float(peso)
        return pesos
    except Exception as e:
        print(f"[obtener_pesos modificacion] Error: {e}")
        return {}


# ═══════════════════════════════════════════════════════════════
# Carga y normalización de rutas
# ═══════════════════════════════════════════════════════════════

def obtener_rutas_para_modificar(logistica_id: str) -> dict:
    """
    Lee validacion y reordenamiento desde MongoDB.
    Normaliza todo en una lista unificada con coordenadas.
    """
    oid = _parse_oid(logistica_id)
    if not oid:
        return {"status": "error", "mensaje": "logistica_id inválido."}

    cfg          = _obtener_config_general()
    min_descarga = float(cfg.get("min_descarga_por_kg") or MIN_DESCARGA_POR_KG)

    db = get_db()

    # ── 1. Leer validación ─────────────────────────────────────
    doc_val = db["validaciones"].find_one({"logistica_id": oid})
    if not doc_val:
        return {"status": "error", "mensaje": "No se encontró validación para esta logística."}

    # ── 2. Leer reordenamiento ─────────────────────────────────
    subrutas_reord = []
    doc_reord = db["reordenamientos"].find_one({"logistica_id": oid})
    if doc_reord:
        for ruta_reorg in doc_reord.get("rutas_reorganizadas", []):
            for sub in ruta_reorg.get("subrutas", []):
                subrutas_reord.append(sub)

    # ── 3. Datos de MongoDB ────────────────────────────────────
    coords_map = _obtener_coordenadas_sucursales()
    rutas_db   = _obtener_rutas_db()

    # ── 4. Normalizar rutas autorizadas ────────────────────────
    rutas_normalizadas = []

    for autorizada in doc_val.get("autorizadas", []):
        ruta_id       = autorizada.get("id", "")
        ruta_db       = rutas_db.get(ruta_id, {})
        sucursales_db = ruta_db.get("sucursales", [])

        sucursales_norm = []
        for i, suc in enumerate(sucursales_db):
            nt  = str(suc.get("num_tienda", ""))
            lat = suc.get("latitud")
            lon = suc.get("longitud")
            if (lat is None or lon is None) and nt in coords_map:
                lat = coords_map[nt]["latitud"]
                lon = coords_map[nt]["longitud"]

            peso   = suc.get("peso_kg", 0)
            nombre = suc.get("nombre_tienda") or suc.get("nombre_pedido") or suc.get("nombre", "")
            sucursales_norm.append({
                "num_tienda":   suc.get("num_tienda"),
                "nombre":       nombre,
                "orden":        suc.get("orden", i + 1),
                "peso_kg":      peso,
                "descarga_min": round(min(peso * min_descarga, MAX_DESCARGA_MIN), 1),
                "latitud":      float(lat) if lat is not None else None,
                "longitud":     float(lon) if lon is not None else None,
            })

        con_coords = sum(1 for s in sucursales_norm if s["latitud"] is not None)
        rutas_normalizadas.append({
            "id":                   ruta_id,
            "nombre":               autorizada.get("nombre_ruta", ""),
            "tipo":                 "autorizada",
            "dia":                  autorizada.get("dia", ""),
            "vehiculo_placas":      autorizada.get("vehiculo", ""),
            "vehiculo_abrev":       autorizada.get("vehiculo_abrev", ""),
            "capacidad_ton":        None,
            "peso_kg":              autorizada.get("peso_kg", 0),
            "pct_utilizacion":      autorizada.get("pct_utilizacion", 0),
            "cumple_peso":          autorizada.get("cumple_peso", True),
            "color":                autorizada.get("color", "verde"),
            "hora_salida":          autorizada.get("hora_salida", "08:00"),
            "hora_regreso":         autorizada.get("hora_regreso", ""),
            "cumple_horario":       autorizada.get("cumple_horario", True),
            "conduccion_min":       0,
            "descarga_min":         0,
            "extra_min":            HORAS_EXTRA_RUTA_MIN,
            "total_min":            autorizada.get("total_min", 0),
            "distancia_km":         0,
            "origen_tiempo":        "pendiente",
            "ruta_origen_id":       None,
            "ruta_origen_nombre":   None,
            "parte":                None,
            "total_partes":         None,
            "num_sucursales":       autorizada.get("num_sucursales", len(sucursales_norm)),
            "sucursales_con_coords": con_coords,
            "sucursales":           sucursales_norm,
        })

    # ── 5. Normalizar subrutas ─────────────────────────────────
    for sub in subrutas_reord:
        sucursales_norm = []
        for suc in sub.get("sucursales", []):
            nt  = str(suc.get("num_tienda", ""))
            lat = suc.get("latitud")
            lon = suc.get("longitud")
            if (lat is None or lon is None) and nt in coords_map:
                lat = coords_map[nt]["latitud"]
                lon = coords_map[nt]["longitud"]
            sucursales_norm.append({
                "num_tienda":   suc.get("num_tienda"),
                "nombre":       suc.get("nombre", ""),
                "orden":        suc.get("orden"),
                "peso_kg":      suc.get("peso_kg", 0),
                "descarga_min": suc.get("descarga_min", 0),
                "latitud":      float(lat) if lat is not None else None,
                "longitud":     float(lon) if lon is not None else None,
            })

        con_coords = sum(1 for s in sucursales_norm if s["latitud"] is not None)
        rutas_normalizadas.append({
            "id":                   sub.get("id", ""),
            "nombre":               sub.get("nombre_subruta", ""),
            "tipo":                 "subruta",
            "dia":                  sub.get("dia", ""),
            "vehiculo_placas":      sub.get("vehiculo_placas", ""),
            "vehiculo_abrev":       sub.get("vehiculo_abrev", ""),
            "capacidad_ton":        sub.get("capacidad_ton"),
            "peso_kg":              sub.get("peso_kg", 0),
            "pct_utilizacion":      sub.get("pct_utilizacion", 0),
            "cumple_peso":          sub.get("cumple_peso", True),
            "color":                sub.get("color", "verde"),
            "hora_salida":          sub.get("hora_salida", "08:00"),
            "hora_regreso":         sub.get("hora_regreso", ""),
            "cumple_horario":       sub.get("cumple_horario", True),
            "conduccion_min":       sub.get("conduccion_min", 0),
            "descarga_min":         sub.get("descarga_min", 0),
            "extra_min":            sub.get("extra_min", HORAS_EXTRA_RUTA_MIN),
            "total_min":            sub.get("total_min", 0),
            "distancia_km":         sub.get("distancia_km", 0),
            "origen_tiempo":        "pendiente",
            "ruta_origen_id":       sub.get("ruta_origen_id"),
            "ruta_origen_nombre":   sub.get("ruta_origen_nombre"),
            "parte":                sub.get("parte"),
            "total_partes":         sub.get("total_partes"),
            "num_sucursales":       sub.get("num_sucursales", len(sucursales_norm)),
            "sucursales_con_coords": con_coords,
            "sucursales":           sucursales_norm,
        })

    ORDEN_DIAS = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"]
    rutas_normalizadas.sort(key=lambda r: (
        ORDEN_DIAS.index(r["dia"].lower()) if r["dia"].lower() in ORDEN_DIAS else 99,
        r["nombre"]
    ))

    return {
        "status":            "ok",
        "fecha_validacion":  doc_val.get("guardado_en"),
        "total_autorizadas": len(doc_val.get("autorizadas", [])),
        "total_subrutas":    len(subrutas_reord),
        "rutas":             rutas_normalizadas,
    }


# ── Cálculo de tiempos con caché MongoDB ──────────────────────

def calcular_tiempos_subruta(sucursales: list, pesos: dict) -> dict:
    """Calcula tiempos OSRM reales. Usa caché en MongoDB."""
    cfg          = _obtener_config_general()
    matriz_lat   = float(cfg.get("matriz_lat")          or MATRIZ_LAT_DEFAULT)
    matriz_lon   = float(cfg.get("matriz_lon")          or MATRIZ_LON_DEFAULT)
    min_descarga = float(cfg.get("min_descarga_por_kg") or MIN_DESCARGA_POR_KG)
    velocidad    = float(cfg.get("velocidad_kmh")       or 35.0)

    coords = [(matriz_lat, matriz_lon)]
    for s in sucursales:
        lat = s.get("latitud")
        lon = s.get("longitud")
        if lat is not None and lon is not None:
            coords.append((float(lat), float(lon)))

    if len(coords) < 2:
        return {
            "traslado_min": 0, "descarga_min": 0, "extra_min": HORAS_EXTRA_RUTA_MIN,
            "total_min": 0, "distancia_km": 0,
            "origen_tiempo": "sin_coordenadas", "geometry": [],
            "matriz": [matriz_lat, matriz_lon], "hora_regreso": "—",
        }

    coords.append((matriz_lat, matriz_lon))
    clave   = _cache_key(coords)
    resultado = _cargar_cache_geo(clave)

    if resultado is None:
        resultado = consultar_osrm_con_reintentos(coords)
        if "error" in resultado:
            resultado = _fallback_haversine(coords, velocidad)
        if resultado.get("origen") in ("osrm", "haversine_fallback"):
            _guardar_cache_geo(clave, resultado)

    descarga_raw = sum(
        pesos.get(str(s.get("num_tienda", "")), 0.0) * min_descarga
        for s in sucursales
    )
    descarga = min(descarga_raw, MAX_DESCARGA_MIN)
    traslado = resultado.get("traslado_min", 0)
    total    = traslado + descarga + HORAS_EXTRA_RUTA_MIN

    hora_salida_min = 8 * 60
    regreso_min     = hora_salida_min + total
    h_reg = int(regreso_min // 60)
    m_reg = int(round(regreso_min % 60))
    if m_reg >= 60:
        h_reg += 1
        m_reg -= 60
    hora_regreso = f"{h_reg:02d}:{m_reg:02d}"

    return {
        "traslado_min":  round(traslado, 1),
        "descarga_min":  round(descarga, 1),
        "extra_min":     HORAS_EXTRA_RUTA_MIN,
        "total_min":     round(total, 1),
        "distancia_km":  resultado.get("distancia_km", 0),
        "origen_tiempo": resultado.get("origen", "desconocido"),
        "geometry":      resultado.get("geometry", []),
        "hora_regreso":  hora_regreso,
        "matriz":        [matriz_lat, matriz_lon],
    }


def calcular_tiempos_lote(rutas: list, pesos: dict, delay: float = 1.2) -> dict:
    """Calcula tiempos OSRM para múltiples rutas con delay entre llamadas."""
    resultados = {}
    cfg        = _obtener_config_general()
    matriz_lat = float(cfg.get("matriz_lat") or MATRIZ_LAT_DEFAULT)
    matriz_lon = float(cfg.get("matriz_lon") or MATRIZ_LON_DEFAULT)

    for ruta in rutas:
        ruta_id    = ruta.get("id", "")
        sucursales = ruta.get("sucursales", [])

        if not sucursales:
            resultados[ruta_id] = {
                "traslado_min": 0, "descarga_min": 0, "extra_min": HORAS_EXTRA_RUTA_MIN,
                "total_min": 0, "distancia_km": 0,
                "origen_tiempo": "sin_sucursales", "geometry": [],
                "hora_regreso": "—", "matriz": [matriz_lat, matriz_lon],
            }
            continue

        coords = [(matriz_lat, matriz_lon)]
        for s in sucursales:
            lat = s.get("latitud")
            lon = s.get("longitud")
            if lat is not None and lon is not None:
                coords.append((float(lat), float(lon)))
        coords.append((matriz_lat, matriz_lon))

        clave    = _cache_key(coords)
        en_cache = _cargar_cache_geo(clave) is not None

        if not en_cache and resultados:
            time.sleep(delay)

        resultados[ruta_id] = calcular_tiempos_subruta(sucursales, pesos)

    return resultados


# ── Guardar / recuperar modificación ──────────────────────────

def guardar_modificacion(payload: dict, logistica_id: str) -> dict:
    """Persiste la modificación en la colección `modificaciones_rutas`."""
    oid = _parse_oid(logistica_id)
    if not oid:
        return {"status": "error", "mensaje": "logistica_id inválido."}

    payload["guardado_en"]  = datetime.now().isoformat()
    payload["logistica_id"] = oid

    try:
        db = get_db()
        db["modificaciones_rutas"].update_one(
            {"logistica_id": oid},
            {"$set": payload},
            upsert=True,
        )
        return {"status": "ok"}
    except Exception as e:
        return {"status": "error", "mensaje": str(e)}


def obtener_modificacion_previa(logistica_id: str) -> dict:
    """Devuelve la modificación guardada para la logística activa."""
    oid = _parse_oid(logistica_id)
    if not oid:
        return {}
    try:
        db  = get_db()
        doc = db["modificaciones_rutas"].find_one({"logistica_id": oid})
        if not doc:
            return {}
        doc.pop("_id", None)
        doc["logistica_id"] = str(doc["logistica_id"])
        return doc
    except Exception:
        return {}