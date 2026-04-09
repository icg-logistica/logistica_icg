"""
logic/reordenamiento_logic.py
Lógica de negocio para la Sección 5 — Reordenamiento de Rutas.

Cambios v3:
  - util_min / util_max se leen desde la colección 'configuracion' (igual que
    en asignacion_logic). Ya no se usan 80/120 hardcodeados en ningún lugar.
  - _obtener_config_dias() usa la config global como base y aplica el override
    por logística encima, igual que en asignacion_logic.
  - ejecutar_reorganizacion() ahora sigue tres fases por cada ruta:
      Fase 1 — Asignación directa sin dividir: evalúa TODOS los días
               habilitados buscando un vehículo libre cuyo pct esté dentro del
               rango óptimo. Elige la mejor combinación (día, vehículo) por
               proximidad al 100 %. Si tiene éxito, la ruta no se divide.
      Fase 2 — División inteligente: si no hay solución directa, divide la ruta
               y asigna sub-rutas usando vehículos libres de cualquier día.
      Fase 3 — No asignable: si tampoco hay vehículos suficientes para la
               división, la ruta se marca con no_asignable = True y se devuelve
               un mensaje claro al frontend.
  - El frontend (reordenamiento.js) muestra tarjetas diferenciadas para rutas
    no asignables.
"""
import math
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

OSRM_BASE_URL = "https://router.project-osrm.org/route/v1/driving"
OSRM_TIMEOUT  = 15
MATRIZ_LAT    = 18.87329315661368
MATRIZ_LON    = -96.9491574270346

DIAS_ORDEN = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"]

# Rango óptimo por defecto (se sobreescribe con config de MongoDB)
UTIL_MIN_DEFAULT = 80
UTIL_MAX_DEFAULT = 120


# ── Helpers ────────────────────────────────────────────────────

def _parse_oid(doc_id: str) -> "ObjectId | None":
    try:
        return ObjectId(doc_id)
    except (InvalidId, TypeError):
        return None


def _parse_hhmm(s: str):
    if not s:
        return None
    try:
        h, m = s.split(":")
        return int(h) * 60 + int(m)
    except Exception:
        return None


def _minutos_a_hhmm(min_total: float) -> str:
    h = int(min_total // 60)
    m = int(round(min_total % 60))
    return f"{h:02d}:{m:02d}"


# ── Configuración ──────────────────────────────────────────────

def _obtener_config_general() -> dict:
    try:
        db = get_db()
        return db["configuracion"].find_one({"_tipo": {"$exists": False}}) or {}
    except Exception:
        return {}


def _leer_rango_utilizacion() -> tuple:
    """
    Lee util_min y util_max desde la configuración general de MongoDB.
    Devuelve (util_min_pct, util_max_pct) como floats.
    """
    try:
        cfg      = _obtener_config_general()
        util_min = float(cfg.get("utilizacion_min") or UTIL_MIN_DEFAULT)
        util_max = float(cfg.get("utilizacion_max") or UTIL_MAX_DEFAULT)
        return util_min, util_max
    except Exception:
        return float(UTIL_MIN_DEFAULT), float(UTIL_MAX_DEFAULT)


def _obtener_config_dias(logistica_id_oid: "ObjectId | None") -> dict:
    """
    Devuelve la configuración de días con dos capas:
      1. BASE: config_dias de la colección 'configuracion' (global del sistema).
      2. OVERRIDE: config_dias de la colección 'config_dias' vinculada a la
         logística activa (ajustes hechos desde el modal ⚙ Días en Asignación).
    Si no hay override, se devuelve solo la base global.
    """
    # Capa 1: config global
    base: dict = {}
    try:
        cfg_global = _obtener_config_general()
        base = dict(cfg_global.get("config_dias") or {})
    except Exception:
        pass

    # Capa 2: override por logística
    if logistica_id_oid:
        try:
            db  = get_db()
            doc = db["config_dias"].find_one({"logistica_id": logistica_id_oid})
            config_logistica = (doc.get("config_dias") or {}) if doc else {}
            if config_logistica:
                base = {**base, **config_logistica}
        except Exception:
            pass

    return base


# ── Vehículos ──────────────────────────────────────────────────

def _obtener_vehiculos() -> list:
    try:
        db = get_db()
        vehiculos = []
        for v in db["vehiculos"].find({}):
            v = dict(v)
            if "_id" in v:
                v["_id"] = str(v["_id"])
            vehiculos.append(v)
        return vehiculos
    except Exception as e:
        print(f"[reordenamiento] Error al obtener vehículos: {e}")
        return []


def _vehiculos_ocupados_en_dia(asignaciones: dict, dia: str,
                                excluir_ruta_ids: "set | None" = None) -> set:
    if excluir_ruta_ids is None:
        excluir_ruta_ids = set()
    return {
        placas
        for ruta_id, placas in asignaciones.get(dia, {}).items()
        if placas and ruta_id not in excluir_ruta_ids
    }


def _vehiculos_libres_en_dia(vehiculos: list, asignaciones: dict,
                               dia: str,
                               excluir_ruta_ids: "set | None" = None,
                               excluir_placas_global: "set | None" = None) -> list:
    """
    Devuelve vehículos disponibles (sin asignar) en el día dado.

    excluir_ruta_ids       — rutas a ignorar al calcular vehículos ocupados
                             (p. ej. la ruta que se está reasignando).
    excluir_placas_global  — placas ya utilizadas durante la reorganización
                             actual, independientemente del día. Garantiza
                             que un vehículo no se asigne a dos rutas dentro
                             de la misma ejecución de ejecutar_reorganizacion().
    """
    ocupadas = _vehiculos_ocupados_en_dia(asignaciones, dia, excluir_ruta_ids)
    if excluir_placas_global:
        ocupadas = ocupadas | excluir_placas_global
    return [
        v for v in vehiculos
        if (v.get("capacidad_toneladas") or 0) > 0
        and v.get("placas") not in ocupadas
    ]


# ── Coordenadas ────────────────────────────────────────────────

def _obtener_coordenadas_sucursales() -> dict:
    try:
        db = get_db()
        coords = {}
        for ruta in db["rutas_config"].find({}):
            for s in ruta.get("sucursales", []):
                nt  = str(s.get("num_tienda", ""))
                lat = s.get("latitud")
                lon = s.get("longitud")
                if nt and lat is not None and lon is not None:
                    coords[nt] = {
                        "lat": float(lat),
                        "lon": float(lon),
                        "nombre": s.get("nombre_tienda", s.get("nombre_pedido", "")),
                    }
        return coords
    except Exception as e:
        print(f"[reordenamiento] Error al obtener coordenadas: {e}")
        return {}


# ── OSRM ──────────────────────────────────────────────────────

def _consultar_osrm(coords: list) -> dict:
    if len(coords) < 2:
        return {"distancia_km": 0.0, "traslado_min": 0.0, "origen": "osrm"}
    waypoints = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in coords)
    url = f"{OSRM_BASE_URL}/{waypoints}?overview=false"
    try:
        import json as _json
        req = urllib.request.Request(
            url, headers={"User-Agent": "ICG-RouteReorg/1.0", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=OSRM_TIMEOUT) as resp:
            data = _json.loads(resp.read().decode("utf-8"))
        if data.get("code") != "Ok" or not data.get("routes"):
            return {"error": data.get("code", "error"), "origen": "osrm_error"}
        ruta = data["routes"][0]
        return {
            "distancia_km": round(ruta.get("distance", 0) / 1000, 2),
            "traslado_min": round(ruta.get("duration", 0) / 60, 1),
            "origen": "osrm",
        }
    except Exception as e:
        return {"error": str(e), "origen": "osrm_error"}


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
    }


def _calcular_tiempos_subruta(sucursales: list, coords_db: dict) -> dict:
    cfg          = _obtener_config_general()
    mat_lat      = float(cfg.get("matriz_lat")          or MATRIZ_LAT)
    mat_lon      = float(cfg.get("matriz_lon")          or MATRIZ_LON)
    min_descarga = float(cfg.get("min_descarga_por_kg") or MIN_DESCARGA_POR_KG)
    velocidad    = float(cfg.get("velocidad_kmh")       or 35.0)

    coords = [(mat_lat, mat_lon)]
    for s in sucursales:
        nt = str(s.get("num_tienda", ""))
        c  = coords_db.get(nt)
        if c:
            coords.append((c["lat"], c["lon"]))
    if len(coords) < 2:
        return {
            "traslado_min": 0, "descarga_min": 0, "extra_min": HORAS_EXTRA_RUTA_MIN,
            "total_min": HORAS_EXTRA_RUTA_MIN, "distancia_km": 0,
            "origen_tiempo": "sin_coordenadas",
        }
    coords.append((mat_lat, mat_lon))
    resultado = _consultar_osrm(coords)
    if "error" in resultado:
        resultado = _fallback_haversine(coords, velocidad)

    peso_total   = sum(s.get("peso_kg", 0) for s in sucursales)
    descarga_raw = peso_total * min_descarga
    descarga     = min(descarga_raw, MAX_DESCARGA_MIN)
    traslado     = resultado.get("traslado_min", 0)
    total        = traslado + descarga + HORAS_EXTRA_RUTA_MIN
    return {
        "traslado_min":  round(traslado, 1),
        "descarga_min":  round(descarga, 1),
        "extra_min":     HORAS_EXTRA_RUTA_MIN,
        "total_min":     round(total, 1),
        "distancia_km":  resultado.get("distancia_km", 0),
        "origen_tiempo": resultado.get("origen", "desconocido"),
    }


# ═══════════════════════════════════════════════════════════════
# Scoring y selección de vehículos (usa rango dinámico)
# ═══════════════════════════════════════════════════════════════

def _score_vehiculo(peso_ton: float, cap_ton: float,
                    util_min: float, util_max: float) -> float:
    """
    Puntaje de idoneidad. Menor = mejor.
    Dentro del rango → |pct - 100|
    Fuera del rango  → 100 + distancia al borde (siempre peor que cualquier
                       candidato dentro del rango, pero comparable entre sí)
    """
    if cap_ton <= 0:
        return float("inf")
    pct = (peso_ton / cap_ton) * 100
    if util_min <= pct <= util_max:
        return abs(pct - 100)
    if pct < util_min:
        return 100 + (util_min - pct)
    return 100 + (pct - util_max)


def _calcular_partes_necesarias(peso_total_kg: float, vehiculos: list,
                                 util_min: float, util_max: float) -> int:
    if not vehiculos:
        return 2
    capacidades = sorted(set(
        v.get("capacidad_toneladas", 0) for v in vehiculos
        if (v.get("capacidad_toneladas") or 0) > 0
    ))
    if not capacidades:
        return 2
    for n_partes in range(2, 10):
        peso_por_parte_ton = (peso_total_kg / n_partes) / 1000
        for cap in capacidades:
            pct = (peso_por_parte_ton / cap) * 100
            if util_min <= pct <= util_max:
                return n_partes
    menor_cap = capacidades[0]
    return max(2, math.ceil(peso_total_kg / (menor_cap * 1000)))


def _elegir_mejor_vehiculo(peso_kg: float, vehiculos: list,
                            util_min: float, util_max: float) -> "dict | None":
    """
    Devuelve el vehículo con menor score (más cercano al 100 % dentro del rango).
    Primero prioriza candidatos dentro del rango, luego los de fuera como fallback.
    """
    candidatos = [v for v in vehiculos if (v.get("capacidad_toneladas") or 0) > 0]
    if not candidatos:
        return None
    peso_ton = peso_kg / 1000
    return min(candidatos, key=lambda v: _score_vehiculo(peso_ton, v["capacidad_toneladas"],
                                                          util_min, util_max))


# ═══════════════════════════════════════════════════════════════
# FASE 1 — Búsqueda de asignación directa (sin dividir)
# ═══════════════════════════════════════════════════════════════

def _buscar_asignacion_directa(
    peso_kg: float,
    vehiculos: list,
    asignaciones: dict,
    dias_hab: list,
    dia_original: str,
    excluir_ruta_id: str,
    util_min: float,
    util_max: float,
    excluir_placas_global: "set | None" = None,
) -> "dict | None":
    """
    Evalúa todos los días habilitados buscando un vehículo libre cuyo porcentaje
    de ocupación caiga dentro del rango óptimo [util_min, util_max].

    excluir_placas_global — placas ya asignadas durante esta reorganización;
    garantiza que ningún vehículo se reutilice en otra ruta del mismo proceso.
    """
    excluir_ids = {excluir_ruta_id}
    peso_ton    = peso_kg / 1000

    dias_evaluar = [dia_original] + [d for d in dias_hab if d != dia_original]

    mejor_score    = float("inf")
    mejor_resultado = None

    for dia in dias_evaluar:
        libres = _vehiculos_libres_en_dia(
            vehiculos, asignaciones, dia, excluir_ids, excluir_placas_global)
        for v in libres:
            cap = v.get("capacidad_toneladas", 0)
            if cap <= 0:
                continue
            pct = (peso_ton / cap) * 100
            if util_min <= pct <= util_max:
                score = abs(pct - 100)
                if score < mejor_score:
                    mejor_score    = score
                    mejor_resultado = {"vehiculo": v, "dia": dia}

    return mejor_resultado


def _buscar_mejor_vehiculo_disponible(
    peso_kg: float,
    vehiculos: list,
    asignaciones: dict,
    dias_hab: list,
    dia_original: str,
    excluir_ruta_id: str,
    util_min: float,
    util_max: float,
    excluir_placas_global: "set | None" = None,
) -> "dict | None":
    """
    Fallback para rutas que NO exceden util_max: busca el mejor vehículo
    libre en cualquier día habilitado sin restricción de rango.

    excluir_placas_global — placas ya asignadas durante esta reorganización.
    """
    excluir_ids = {excluir_ruta_id}
    peso_ton    = peso_kg / 1000

    mejor_score     = float("inf")
    mejor_resultado = None

    dias_evaluar = [dia_original] + [d for d in dias_hab if d != dia_original]

    for dia in dias_evaluar:
        libres = _vehiculos_libres_en_dia(
            vehiculos, asignaciones, dia, excluir_ids, excluir_placas_global)
        for v in libres:
            cap = v.get("capacidad_toneladas", 0)
            if cap <= 0:
                continue
            score = _score_vehiculo(peso_ton, cap, util_min, util_max)
            if score < mejor_score:
                mejor_score     = score
                mejor_resultado = {"vehiculo": v, "dia": dia}

    return mejor_resultado


# ═══════════════════════════════════════════════════════════════
# FASE 2 — División inteligente entre días
# ═══════════════════════════════════════════════════════════════

def _dividir_sucursales_equitativo(sucursales: list, n_partes: int) -> list:
    if not sucursales or n_partes <= 0:
        return [sucursales] if sucursales else []
    if n_partes == 1 or len(sucursales) <= n_partes:
        if len(sucursales) <= n_partes and len(sucursales) > 1:
            return [[s] for s in sucursales]
        return [sucursales]

    peso_total    = sum(s.get("peso_kg", 0) for s in sucursales)
    peso_objetivo = peso_total / n_partes
    grupos = []
    grupo_actual = []
    peso_actual  = 0
    partes_restantes = n_partes

    for i, s in enumerate(sucursales):
        peso_s = s.get("peso_kg", 0)
        sucs_restantes = len(sucursales) - i

        if sucs_restantes <= partes_restantes - 1 and len(grupo_actual) > 0:
            grupos.append(grupo_actual)
            grupo_actual = [s]
            peso_actual  = peso_s
            partes_restantes -= 1
            continue

        grupo_actual.append(s)
        peso_actual += peso_s

        if partes_restantes > 1 and len(grupo_actual) > 0:
            peso_con_sig = peso_actual
            if i + 1 < len(sucursales):
                peso_con_sig += sucursales[i + 1].get("peso_kg", 0)
            if (abs(peso_actual - peso_objetivo) <= abs(peso_con_sig - peso_objetivo)
                    or peso_actual >= peso_objetivo):
                grupos.append(grupo_actual)
                grupo_actual = []
                peso_actual  = 0
                partes_restantes -= 1
                peso_restante = sum(
                    sucursales[j].get("peso_kg", 0) for j in range(i + 1, len(sucursales)))
                if partes_restantes > 0:
                    peso_objetivo = peso_restante / partes_restantes

    if grupo_actual:
        grupos.append(grupo_actual)
    return [g for g in grupos if g]


def _recolectar_slots_para_division(
    vehiculos: list,
    asignaciones: dict,
    dias_hab: list,
    dia_original: str,
    excluir_ruta_id: str,
    n_necesarios: int,
    util_min: float,
    util_max: float,
    pesos_grupos: list,
    excluir_placas_global: "set | None" = None,
) -> list:
    """
    Recopila hasta `n_necesarios` slots (vehiculo, dia) para las sub-rutas.

    excluir_placas_global — placas ya asignadas durante esta reorganización.
    Dentro de esta función también se acumula `placas_usadas` para que cada
    sub-ruta del mismo grupo no comparta vehículo con otra del mismo grupo.
    """
    excluir_ids  = {excluir_ruta_id}
    # Unir ocupación global previa con las placas que vayamos usando aquí
    placas_usadas: set = set(excluir_placas_global) if excluir_placas_global else set()
    resultado    = []

    for idx in range(n_necesarios):
        peso_grupo = pesos_grupos[idx] if idx < len(pesos_grupos) else 0
        peso_ton   = peso_grupo / 1000
        mejor_score    = float("inf")
        mejor_candidato = None

        dias_evaluar = [dia_original] + [d for d in dias_hab if d != dia_original]

        for dia in dias_evaluar:
            libres = _vehiculos_libres_en_dia(
                vehiculos, asignaciones, dia, excluir_ids, placas_usadas)
            for v in libres:
                cap = v.get("capacidad_toneladas", 0)
                if cap <= 0:
                    continue
                score = _score_vehiculo(peso_ton, cap, util_min, util_max)
                if score < mejor_score:
                    mejor_score     = score
                    mejor_candidato = {"vehiculo": v, "dia": dia}

        if mejor_candidato:
            resultado.append(mejor_candidato)
            placas_usadas.add(mejor_candidato["vehiculo"]["placas"])

    return resultado


def _dividir_y_asignar_multi_dia(
    sucursales: list,
    peso_total_kg: float,
    vehiculos: list,
    asignaciones: dict,
    dias_hab: list,
    dia_original: str,
    excluir_ruta_id: str,
    util_min: float,
    util_max: float,
    excluir_placas_global: "set | None" = None,
) -> "list | None":
    """
    Divide la ruta e intenta asignar sub-rutas usando vehículos de cualquier
    día habilitado.

    excluir_placas_global — placas ya asignadas durante esta reorganización.
    Devuelve lista de { sucursales, vehiculo, peso_kg, dia } o None.
    """
    todos_libres = []
    for dia in dias_hab:
        todos_libres += _vehiculos_libres_en_dia(
            vehiculos, asignaciones, dia, {excluir_ruta_id}, excluir_placas_global)

    if not todos_libres:
        return None

    n_partes   = _calcular_partes_necesarias(peso_total_kg, todos_libres, util_min, util_max)
    grupos_suc = _dividir_sucursales_equitativo(sucursales, n_partes)
    pesos_grupos = [sum(s.get("peso_kg", 0) for s in g) for g in grupos_suc]

    slots = _recolectar_slots_para_division(
        vehiculos, asignaciones, dias_hab, dia_original,
        excluir_ruta_id, len(grupos_suc), util_min, util_max,
        pesos_grupos, excluir_placas_global)

    if not slots:
        return None

    resultado = []
    for i, grupo in enumerate(grupos_suc):
        slot    = slots[i] if i < len(slots) else None
        peso_kg = pesos_grupos[i]
        resultado.append({
            "sucursales": grupo,
            "vehiculo":   slot["vehiculo"] if slot else None,
            "dia":        slot["dia"] if slot else dia_original,
            "peso_kg":    peso_kg,
        })

    return resultado


# ═══════════════════════════════════════════════════════════════
# Endpoints principales
# ═══════════════════════════════════════════════════════════════

def obtener_datos_reordenamiento(logistica_id: str) -> dict:
    oid = _parse_oid(logistica_id)
    if not oid:
        return {"rutas_a_reorganizar": [], "vehiculos": [], "asignaciones_por_dia": {}}

    db = get_db()
    doc_val = db["validaciones"].find_one({"logistica_id": oid})
    if not doc_val:
        return {"rutas_a_reorganizar": [], "vehiculos": [], "asignaciones_por_dia": {}}

    reorganizar_ids = {r["id"] for r in doc_val.get("reorganizar", [])}
    doc_asig = db["asignaciones"].find_one({"logistica_id": oid})
    detalle  = doc_asig.get("detalle_por_dia", {}) if doc_asig else {}

    rutas_completas = []
    for dia, rutas_dia in detalle.items():
        for ruta_id, info in rutas_dia.items():
            if ruta_id in reorganizar_ids:
                rutas_completas.append({"id": ruta_id, "dia_original": dia, **info})

    vehiculos    = _obtener_vehiculos()
    asig_por_dia = doc_asig.get("asignaciones_por_dia", {}) if doc_asig else {}

    return {
        "rutas_a_reorganizar":  rutas_completas,
        "vehiculos":            vehiculos,
        "asignaciones_por_dia": asig_por_dia,
    }


def ejecutar_reorganizacion(logistica_id: str) -> dict:
    """
    Ejecuta el proceso de reorganización.  La división SOLO se usa cuando
    la ruta excede el límite máximo de peso (pct_actual > util_max).

    Árbol de decisión por ruta
    ──────────────────────────
    ¿La ruta excede util_max con su vehículo actual?

    SÍ (sobrecargada):
        Fase 1 — Buscar vehículo dentro del rango en cualquier día (sin dividir).
        Si encuentra → reasignar directamente (posible cambio de día).
        Si no encuentra →
            Fase 2 — Dividir la ruta y asignar sub-rutas en cualquier día.
            Si no hay vehículos suficientes → Fase 3: no asignable.

    NO (subutilizada o ya dentro del rango pero con vehículo no óptimo):
        Fase 1 — Buscar vehículo dentro del rango en cualquier día (sin dividir).
        Si encuentra → reasignar directamente (posible cambio de día).
        Si no encuentra →
            Fase B — Asignar el mejor vehículo disponible en cualquier día
                     aunque quede fuera del rango (nunca se divide).
            Si no hay ningún vehículo → Fase 3: no asignable.
    """
    oid = _parse_oid(logistica_id)
    if not oid:
        return {"status": "error", "mensaje": "logistica_id inválido."}

    datos        = obtener_datos_reordenamiento(logistica_id)
    rutas        = datos["rutas_a_reorganizar"]
    vehiculos    = datos["vehiculos"]
    asig_por_dia = datos["asignaciones_por_dia"]

    if not rutas:
        return {"status": "ok", "rutas_reorganizadas": [], "mensaje": "No hay rutas para reorganizar"}

    coords_db   = _obtener_coordenadas_sucursales()
    config_dias = _obtener_config_dias(oid)
    util_min, util_max = _leer_rango_utilizacion()

    # Días habilitados en orden canónico
    dias_hab = [d for d in DIAS_ORDEN if config_dias.get(d, {}).get("habilitado", True)]
    if not dias_hab:
        dias_hab = ["lunes", "martes", "miercoles", "jueves", "viernes"]

    resultado_global = []

    # ── Registro global de vehículos usados durante esta reorganización ──
    # Garantiza que ningún vehículo se asigne a más de una ruta en el
    # mismo proceso, incluso si las rutas pertenecen a días distintos.
    vehiculos_usados_reord: set = set()

    for ruta in rutas:
        ruta_id      = ruta["id"]
        dia_original = ruta["dia_original"]
        nombre_orig  = ruta.get("nombre_ruta", "?")
        sucursales   = ruta.get("sucursales", [])
        peso_total   = ruta.get("peso_total_kg", 0)
        veh_original = ruta.get("vehiculo_placas", "")
        pct_actual   = ruta.get("porcentaje_utilizacion", 0)

        # ¿La ruta excede el límite máximo con su vehículo actual?
        excede_max = pct_actual > util_max

        # ── Helper: construir subruta "directa" desde un slot ────────
        def _construir_resultado_directo(slot, estrategia_label):
            veh = slot["vehiculo"]
            dia = slot["dia"]
            cap = veh.get("capacidad_toneladas", 1)
            pct = round((peso_total / 1000 / cap) * 100, 1)

            for idx, s in enumerate(sucursales):
                s["orden"] = idx + 1

            tiempos      = _calcular_tiempos_subruta(sucursales, coords_db)
            cfg_dia      = config_dias.get(dia, {})
            hora_salida  = cfg_dia.get("hora_salida", "08:00")
            hora_limite  = cfg_dia.get("hora_limite", "20:00")
            salida_min   = _parse_hhmm(hora_salida)
            hora_regreso = _minutos_a_hhmm(salida_min + tiempos["total_min"]) if salida_min else None
            limite_min   = _parse_hhmm(hora_limite)
            cumple_horario = (_parse_hhmm(hora_regreso) <= limite_min) if hora_regreso and limite_min else True
            cumple_peso  = util_min <= pct <= util_max
            cambio_dia   = dia != dia_original

            color = ("verde" if cumple_peso and cumple_horario
                     else "rojo" if not cumple_peso and not cumple_horario
                     else "naranja")

            subruta = {
                "id":                 f"{ruta_id}_sub1",
                "ruta_origen_id":     ruta_id,
                "ruta_origen_nombre": nombre_orig,
                "nombre_subruta":     nombre_orig,
                "parte":              1,
                "total_partes":       1,
                "dia":                dia,
                "vehiculo_placas":    veh.get("placas", ""),
                "vehiculo_abrev":     veh.get("abreviatura", ""),
                "capacidad_ton":      cap,
                "peso_kg":            peso_total,
                "peso_ton":           round(peso_total / 1000, 3),
                "pct_utilizacion":    pct,
                "cumple_peso":        cumple_peso,
                "distancia_km":       tiempos["distancia_km"],
                "conduccion_min":     tiempos["traslado_min"],
                "descarga_min":       tiempos["descarga_min"],
                "extra_min":          tiempos["extra_min"],
                "total_min":          tiempos["total_min"],
                "hora_salida":        hora_salida,
                "hora_regreso":       hora_regreso,
                "cumple_horario":     cumple_horario,
                "color":              color,
                "origen_tiempo":      tiempos["origen_tiempo"],
                "sucursales":         sucursales,
                "num_sucursales":     len(sucursales),
                "sin_dividir":        True,
                "cambio_dia":         cambio_dia,
            }

            return {
                "ruta_original": {
                    "id":             ruta_id,
                    "nombre":         nombre_orig,
                    "dia":            dia_original,
                    "peso_kg":        peso_total,
                    "vehiculo":       veh_original,
                    "pct_original":   pct_actual,
                    "num_sucursales": len(sucursales),
                },
                "subrutas":   [subruta],
                "estrategia": estrategia_label,
                "cambio_dia": cambio_dia,
                "dia_nuevo":  dia if cambio_dia else None,
            }

        # ── FASE 1 (común): vehículo dentro del rango en cualquier día ──
        slot_directo = _buscar_asignacion_directa(
            peso_total, vehiculos, asig_por_dia,
            dias_hab, dia_original, ruta_id,
            util_min, util_max,
            vehiculos_usados_reord,
        )
        if slot_directo:
            resultado_global.append(
                _construir_resultado_directo(slot_directo, "directa"))
            # Registrar el vehículo como usado en esta reorganización
            vehiculos_usados_reord.add(slot_directo["vehiculo"]["placas"])
            continue

        # ── RAMA según si excede o no el límite máximo ───────────────
        if excede_max:
            # FASE 2: la ruta está sobrecargada → dividir
            grupos_asignados = _dividir_y_asignar_multi_dia(
                sucursales, peso_total, vehiculos, asig_por_dia,
                dias_hab, dia_original, ruta_id, util_min, util_max,
                vehiculos_usados_reord,
            )

            if grupos_asignados:
                subrutas = []
                for i, grupo in enumerate(grupos_asignados):
                    veh = grupo["vehiculo"]
                    dia = grupo["dia"]
                    cap = veh.get("capacidad_toneladas", 0) if veh else 0
                    peso_kg = grupo["peso_kg"]
                    pct = round((peso_kg / 1000 / cap) * 100, 1) if cap > 0 else 0
                    cumple_peso = util_min <= pct <= util_max

                    for idx, s in enumerate(grupo["sucursales"]):
                        s["orden"] = idx + 1

                    tiempos      = _calcular_tiempos_subruta(grupo["sucursales"], coords_db)
                    cfg_dia      = config_dias.get(dia, {})
                    hora_salida  = cfg_dia.get("hora_salida", "08:00")
                    hora_limite  = cfg_dia.get("hora_limite", "20:00")
                    salida_min   = _parse_hhmm(hora_salida)
                    hora_regreso = _minutos_a_hhmm(salida_min + tiempos["total_min"]) if salida_min else None
                    limite_min   = _parse_hhmm(hora_limite)
                    cumple_horario = (_parse_hhmm(hora_regreso) <= limite_min) if hora_regreso and limite_min else True

                    color = ("verde" if cumple_peso and cumple_horario
                             else "rojo" if not cumple_peso and not cumple_horario
                             else "naranja")

                    subrutas.append({
                        "id":                 f"{ruta_id}_sub{i+1}",
                        "ruta_origen_id":     ruta_id,
                        "ruta_origen_nombre": nombre_orig,
                        "nombre_subruta":     f"{nombre_orig} ({chr(65 + i)})",
                        "parte":              i + 1,
                        "total_partes":       len(grupos_asignados),
                        "dia":                dia,
                        "vehiculo_placas":    veh.get("placas", "") if veh else "",
                        "vehiculo_abrev":     veh.get("abreviatura", "") if veh else "",
                        "capacidad_ton":      cap,
                        "peso_kg":            peso_kg,
                        "peso_ton":           round(peso_kg / 1000, 3),
                        "pct_utilizacion":    pct,
                        "cumple_peso":        cumple_peso,
                        "distancia_km":       tiempos["distancia_km"],
                        "conduccion_min":     tiempos["traslado_min"],
                        "descarga_min":       tiempos["descarga_min"],
                        "extra_min":          tiempos["extra_min"],
                        "total_min":          tiempos["total_min"],
                        "hora_salida":        hora_salida,
                        "hora_regreso":       hora_regreso,
                        "cumple_horario":     cumple_horario,
                        "color":              color,
                        "origen_tiempo":      tiempos["origen_tiempo"],
                        "sucursales":         grupo["sucursales"],
                        "num_sucursales":     len(grupo["sucursales"]),
                        "sin_dividir":        False,
                        "cambio_dia":         dia != dia_original,
                    })

                resultado_global.append({
                    "ruta_original": {
                        "id":             ruta_id,
                        "nombre":         nombre_orig,
                        "dia":            dia_original,
                        "peso_kg":        peso_total,
                        "vehiculo":       veh_original,
                        "pct_original":   pct_actual,
                        "num_sucursales": len(sucursales),
                    },
                    "subrutas":   subrutas,
                    "estrategia": "division",
                })
                # Registrar todos los vehículos usados en las sub-rutas
                for sr in subrutas:
                    if sr.get("vehiculo_placas"):
                        vehiculos_usados_reord.add(sr["vehiculo_placas"])
                continue

            # Fase 3: no asignable (sobrecargada sin vehículos)
            resultado_global.append({
                "ruta_original": {
                    "id":             ruta_id,
                    "nombre":         nombre_orig,
                    "dia":            dia_original,
                    "peso_kg":        peso_total,
                    "vehiculo":       veh_original,
                    "pct_original":   pct_actual,
                    "num_sucursales": len(sucursales),
                },
                "subrutas":     [],
                "estrategia":   "no_asignable",
                "no_asignable": True,
                "excede_max":   True,
                "motivo": (
                    f"La ruta está sobrecargada al {pct_actual:.0f}% "
                    f"(límite máximo: {util_max:.0f}%) y no se encontró "
                    f"ningún vehículo libre ni combinación de días que permita "
                    f"asignarla o dividirla dentro del rango {util_min:.0f}–{util_max:.0f}%. "
                    f"Agrega vehículos a la flota o habilita más días en Configuración."
                ),
            })

        else:
            # La ruta NO excede util_max → nunca dividir.
            # FASE B: mejor vehículo disponible en cualquier día (sin restricción de rango)
            slot_fallback = _buscar_mejor_vehiculo_disponible(
                peso_total, vehiculos, asig_por_dia,
                dias_hab, dia_original, ruta_id,
                util_min, util_max,
                vehiculos_usados_reord,
            )
            if slot_fallback:
                grupo = _construir_resultado_directo(slot_fallback, "reasignada_fallback")
                veh_fb = slot_fallback["vehiculo"]
                cap_fb = veh_fb.get("capacidad_toneladas", 1)
                pct_fb = round((peso_total / 1000 / cap_fb) * 100, 1)
                grupo["motivo_fallback"] = (
                    f"No se encontró un vehículo dentro del rango óptimo "
                    f"{util_min:.0f}–{util_max:.0f}% en ningún día habilitado. "
                    f"La ruta fue asignada al mejor vehículo disponible "
                    f"({veh_fb.get('placas', '')} · {pct_fb:.0f}%). "
                    f"No se dividió porque el peso ({peso_total/1000:.2f} t) "
                    f"no excede el límite máximo."
                )
                resultado_global.append(grupo)
                # Registrar el vehículo como usado en esta reorganización
                vehiculos_usados_reord.add(veh_fb["placas"])
                continue

            # Fase 3: no asignable (sin ningún vehículo disponible)
            resultado_global.append({
                "ruta_original": {
                    "id":             ruta_id,
                    "nombre":         nombre_orig,
                    "dia":            dia_original,
                    "peso_kg":        peso_total,
                    "vehiculo":       veh_original,
                    "pct_original":   pct_actual,
                    "num_sucursales": len(sucursales),
                },
                "subrutas":     [],
                "estrategia":   "no_asignable",
                "no_asignable": True,
                "excede_max":   False,
                "motivo": (
                    f"No se encontró ningún vehículo libre en ningún día habilitado "
                    f"({', '.join(dias_hab)}). La ruta no se dividió porque su peso "
                    f"({peso_total/1000:.2f} t, {pct_actual:.0f}%) no excede el "
                    f"límite máximo de {util_max:.0f}%. "
                    f"Verifica que existan vehículos disponibles en la flota."
                ),
            })

    total_sin_asignar = sum(1 for g in resultado_global if g.get("no_asignable"))
    total_directas    = sum(1 for g in resultado_global if g.get("estrategia") == "directa")
    total_fallback    = sum(1 for g in resultado_global if g.get("estrategia") == "reasignada_fallback")
    total_division    = sum(1 for g in resultado_global if g.get("estrategia") == "division")

    return {
        "status":               "ok",
        "rutas_reorganizadas":  resultado_global,
        "fecha_reorganizacion": datetime.now().isoformat(),
        "util_min":             util_min,
        "util_max":             util_max,
        "resumen": {
            "directas":          total_directas,
            "fallback":          total_fallback,
            "divisiones":        total_division,
            "no_asignables":     total_sin_asignar,
            "vehiculos_usados":  len(vehiculos_usados_reord),
        },
    }


def guardar_reordenamiento(payload: dict, logistica_id: str) -> dict:
    oid = _parse_oid(logistica_id)
    if not oid:
        return {"status": "error", "mensaje": "logistica_id inválido."}
    payload["guardado_en"]  = datetime.now().isoformat()
    payload["logistica_id"] = oid
    try:
        db = get_db()
        db["reordenamientos"].update_one(
            {"logistica_id": oid},
            {"$set": payload},
            upsert=True,
        )
        return {"status": "ok"}
    except Exception as e:
        return {"status": "error", "mensaje": str(e)}


def obtener_reordenamiento_previo(logistica_id: str) -> dict:
    oid = _parse_oid(logistica_id)
    if not oid:
        return {}
    try:
        db  = get_db()
        doc = db["reordenamientos"].find_one({"logistica_id": oid})
        if not doc:
            return {}
        doc.pop("_id", None)
        doc["logistica_id"] = str(doc["logistica_id"])
        return doc
    except Exception:
        return {}


# Compatibilidad con import original
def reordenar_rutas(datos: dict, logistica_id: str = None) -> dict:
    return ejecutar_reorganizacion(logistica_id or "")