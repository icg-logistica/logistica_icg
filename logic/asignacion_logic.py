"""
logic/asignacion_logic.py
Lógica de negocio para la Sección 3 — Asignación de Rutas.

Cambios v4:
  - _normalizar_dia(): normaliza nombres de día (minúsculas + sin tildes) para
    comparar correctamente valores del módulo creacion_rutas ("Miércoles") con
    las claves internas ("miercoles"). Corrige el bug donde ese emparejamiento
    fallaba silenciosamente.
  - _dias_candidatos(): si la ruta tiene dia_sugerido configurado y ese día
    está habilitado, retorna SOLO ese día. El sistema ya no mueve rutas a otros
    días para balancear carga. Respeta la configuración original de cada ruta.
  - Fallback sin vehículo: también usa el día configurado en lugar del menos
    cargado, para mantener la coherencia con la ruta original.
  - Toda la lógica v3 (score, rango dinámico, config global, OSRM) se conserva.
"""
import math
import unicodedata
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

OSRM_BASE_URL = "https://router.project-osrm.org/route/v1/driving"
OSRM_TIMEOUT  = 15

DIAS_ORDEN = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"]

# Rango óptimo por defecto (se sobreescribe con la config de MongoDB)
UTIL_MIN_DEFAULT = 80   # %
UTIL_MAX_DEFAULT = 120  # %


# ── Helpers genéricos ──────────────────────────────────────────

def _normalizar_dia(s: str) -> str:
    """
    Normaliza el nombre de un día a minúsculas sin tildes.

    Necesario porque creacion_rutas almacena dia_sugerido con mayúscula inicial
    y tildes ('Miércoles', 'Jueves'…), mientras que asignacion_logic trabaja con
    claves sin tildes ('miercoles', 'jueves'…).

    Sin esta normalización, 'miercoles' in 'miércoles' es False en Python,
    provocando que las rutas de esos días nunca se emparejaran.
    """
    s = (s or "").lower().strip()
    return "".join(
        c for c in unicodedata.normalize("NFD", s)
        if unicodedata.category(c) != "Mn"
    )


def _serialize(doc: dict) -> dict:
    doc = dict(doc)
    if "_id" in doc and isinstance(doc["_id"], ObjectId):
        doc["_id"] = str(doc["_id"])
    return doc


def _parse_oid(doc_id: str) -> "ObjectId | None":
    try:
        return ObjectId(doc_id)
    except (InvalidId, TypeError):
        return None


def _parse_hhmm(s: str) -> "int | None":
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


def _obtener_config_general() -> dict:
    try:
        db  = get_db()
        cfg = db["configuracion"].find_one({"_tipo": {"$exists": False}}) or {}
        return cfg
    except Exception:
        return {}


def _leer_rango_utilizacion() -> tuple:
    """
    Lee util_min y util_max desde la configuración general.
    Retorna (util_min_pct, util_max_pct) como floats (ej. 80.0, 120.0).
    """
    try:
        cfg      = _obtener_config_general()
        util_min = float(cfg.get("utilizacion_min") or UTIL_MIN_DEFAULT)
        util_max = float(cfg.get("utilizacion_max") or UTIL_MAX_DEFAULT)
        return util_min, util_max
    except Exception:
        return float(UTIL_MIN_DEFAULT), float(UTIL_MAX_DEFAULT)


# ═══════════════════════════════════════════════════════════════
# OSRM — Caché en MongoDB
# ═══════════════════════════════════════════════════════════════

def _cache_key(coords: list) -> str:
    return ";".join(f"{lat:.5f},{lon:.5f}" for lat, lon in coords)


def _cargar_cache(clave: str) -> "dict | None":
    try:
        db  = get_db()
        doc = db["cache_osrm"].find_one({"clave": clave, "tipo": "tiempos"})
        return doc["resultado"] if doc else None
    except Exception:
        return None


def _guardar_cache(clave: str, resultado: dict) -> None:
    try:
        db = get_db()
        db["cache_osrm"].update_one(
            {"clave": clave, "tipo": "tiempos"},
            {"$set": {"resultado": resultado, "actualizado_en": datetime.now().isoformat()}},
            upsert=True,
        )
    except Exception as e:
        print(f"[OSRM cache] Error al guardar: {e}")


def consultar_osrm(coords: list) -> dict:
    if len(coords) < 2:
        return {"distancia_km": 0.0, "traslado_min": 0.0, "origen": "osrm"}

    waypoints = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in coords)
    url = f"{OSRM_BASE_URL}/{waypoints}?overview=false"

    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "ICG-RouteAssignment/1.0", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=OSRM_TIMEOUT) as resp:
            import json
            data = json.loads(resp.read().decode("utf-8"))

        if data.get("code") != "Ok" or not data.get("routes"):
            return {"error": f"OSRM: {data.get('code', '?')}", "origen": "osrm_error"}

        ruta = data["routes"][0]
        return {
            "distancia_km": round(ruta.get("distance", 0.0) / 1000, 2),
            "traslado_min": round(ruta.get("duration", 0.0) / 60, 1),
            "origen": "osrm",
        }
    except urllib.error.URLError as e:
        return {"error": str(e), "origen": "osrm_error"}
    except Exception as e:
        return {"error": str(e), "origen": "osrm_error"}


def _haversine_km(lat1, lon1, lat2, lon2) -> float:
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a    = (math.sin(dlat / 2) ** 2
            + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
            * math.sin(dlon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _fallback_haversine(coords: list, velocidad_kmh: float = 35.0) -> dict:
    FACTOR_VIA = 1.35
    distancia_recta = sum(
        _haversine_km(coords[i][0], coords[i][1], coords[i+1][0], coords[i+1][1])
        for i in range(len(coords) - 1)
    )
    distancia_vial = distancia_recta * FACTOR_VIA
    return {
        "distancia_km": round(distancia_vial, 2),
        "traslado_min": round((distancia_vial / velocidad_kmh) * 60, 1),
        "origen": "haversine_fallback",
    }


# ── Cálculo de tiempos ─────────────────────────────────────────

def calcular_tiempos_ruta(ruta: dict, pesos: dict, usar_cache: bool = True) -> dict:
    sucursales = ruta.get("sucursales", [])
    VACIO = {
        "traslado_min": 0.0, "descarga_min": 0.0, "extra_min": HORAS_EXTRA_RUTA_MIN,
        "total_min": 0.0, "distancia_km": 0.0, "origen_tiempo": "sin_coordenadas",
    }
    if not sucursales:
        return VACIO

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
        return VACIO

    coords.append((matriz_lat, matriz_lon))
    clave = _cache_key(coords)
    resultado_traslado = _cargar_cache(clave) if usar_cache else None

    if resultado_traslado is None:
        resultado_traslado = consultar_osrm(coords)
        if "error" in resultado_traslado:
            resultado_traslado = _fallback_haversine(coords, velocidad)
        if resultado_traslado.get("origen") in ("osrm", "haversine_fallback"):
            _guardar_cache(clave, resultado_traslado)

    descarga_raw    = sum(
        pesos.get(str(s.get("num_tienda", "")), 0.0) * min_descarga
        for s in sucursales
    )
    tiempo_descarga = min(descarga_raw, MAX_DESCARGA_MIN)
    traslado_min    = resultado_traslado.get("traslado_min", 0.0)
    distancia_km    = resultado_traslado.get("distancia_km", 0.0)
    total           = traslado_min + tiempo_descarga + HORAS_EXTRA_RUTA_MIN

    return {
        "traslado_min":  round(traslado_min, 1),
        "descarga_min":  round(tiempo_descarga, 1),
        "extra_min":     HORAS_EXTRA_RUTA_MIN,
        "total_min":     round(total, 1),
        "distancia_km":  round(distancia_km, 2),
        "origen_tiempo": resultado_traslado.get("origen", "desconocido"),
    }


def calcular_tiempos_multiples_rutas(rutas: list, pesos: dict) -> dict:
    resultados = {}
    for ruta in rutas:
        ruta_id = str(ruta.get("_id", ""))
        try:
            resultados[ruta_id] = calcular_tiempos_ruta(ruta, pesos)
        except Exception:
            resultados[ruta_id] = {
                "traslado_min": 0.0, "descarga_min": 0.0, "extra_min": HORAS_EXTRA_RUTA_MIN,
                "total_min": 0.0, "distancia_km": 0.0, "origen_tiempo": "error",
            }
    return resultados


# ═══════════════════════════════════════════════════════════════
# Funciones de dominio
# ═══════════════════════════════════════════════════════════════

def obtener_rutas() -> list:
    db = get_db()
    return [_serialize(r) for r in db["rutas_config"].find({})]


def obtener_vehiculos() -> list:
    """Devuelve únicamente los vehículos activos."""
    try:
        db = get_db()
        return [_serialize(v) for v in db["vehiculos"].find({"activo": True})]
    except Exception:
        return []


def obtener_pesos(logistica_id: str) -> dict:
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
        for nombre_sucursal, valores in data.items():
            id_suc  = valores.get("id_sucursal")
            peso_kg = valores.get("total_kg", 0)
            if id_suc is not None:
                pesos[str(id_suc)] = float(peso_kg)
        return pesos
    except Exception as e:
        print(f"[obtener_pesos] Error: {e}")
        return {}


def obtener_volumenes(logistica_id: str) -> dict:
    """Devuelve { id_sucursal: total_m3 } desde la extracción activa."""
    oid = _parse_oid(logistica_id)
    if not oid:
        return {}
    try:
        db  = get_db()
        doc = db["extraccion"].find_one({"logistica_id": oid})
        if not doc:
            return {}
        datos_vol = doc.get("datos_volumen", {})
        volumenes = {}
        for _, valores in datos_vol.items():
            id_suc = valores.get("id_sucursal")
            vol_m3 = valores.get("total_m3", 0)
            if id_suc is not None:
                volumenes[str(id_suc)] = float(vol_m3)
        return volumenes
    except Exception as e:
        print(f"[obtener_volumenes] Error: {e}")
        return {}


def calcular_peso_ruta(ruta: dict, pesos: dict) -> float:
    return sum(
        pesos.get(str(s.get("num_tienda", "")), 0.0)
        for s in ruta.get("sucursales", [])
    )


def calcular_volumen_ruta(ruta: dict, volumenes: dict) -> float:
    return sum(
        volumenes.get(str(s.get("num_tienda", "")), 0.0)
        for s in ruta.get("sucursales", [])
    )


def _score_vehiculo(peso_ton: float, vehiculo: dict,
                    util_min: float = UTIL_MIN_DEFAULT,
                    util_max: float = UTIL_MAX_DEFAULT) -> float:
    """
    Puntaje de idoneidad del vehículo para una carga dada.
    Menor puntaje = mejor vehículo.

    • Dentro del rango [util_min, util_max] → penalización = |pct - 100|
      (se prefiere el que se acerque más al 100 %).
    • Fuera del rango → penalización alta: 100 + distancia al borde del rango.
      Esto garantiza que siempre se prefiera cualquier vehículo dentro del rango
      antes que uno fuera, pero aún permite comparar los candidatos fuera del
      rango entre sí (fallback).
    """
    cap = vehiculo.get("capacidad_toneladas", 0)
    if cap <= 0:
        return float("inf")
    pct = (peso_ton / cap) * 100
    if util_min <= pct <= util_max:
        return abs(pct - 100)
    if pct < util_min:
        return 100 + (util_min - pct)
    return 100 + (pct - util_max)


def sugerir_vehiculo(peso_kg: float, vehiculos: list,
                     placas_ocupadas: "set | None" = None) -> "dict | None":
    if placas_ocupadas is None:
        placas_ocupadas = set()
    util_min, util_max = _leer_rango_utilizacion()
    peso_ton   = peso_kg / 1000
    candidatos = [
        v for v in vehiculos
        if v.get("placas") not in placas_ocupadas
        and (v.get("capacidad_toneladas") or 0) > 0
    ]
    if not candidatos:
        return None
    return min(candidatos, key=lambda v: _score_vehiculo(peso_ton, v, util_min, util_max))


def calcular_porcentaje_capacidad(peso_kg: float, vehiculo: "dict | None") -> float:
    if not vehiculo:
        return 0.0
    cap = vehiculo.get("capacidad_toneladas", 0)
    return round((peso_kg / 1000 / cap) * 100, 1) if cap > 0 else 0.0


# ═══════════════════════════════════════════════════════════════
# ASIGNACIÓN OPTIMIZADA — MÁXIMA PROXIMIDAD AL 100 %
# ═══════════════════════════════════════════════════════════════

def generar_asignacion_optimizada(payload: dict, logistica_id: str) -> dict:
    """
    Asigna vehículos a las rutas seleccionadas con la siguiente lógica:

      1. Lee util_min / util_max desde la configuración general de MongoDB
         (por defecto 80 % / 120 %).
      2. Filtra solo las rutas seleccionadas (no entregadas / no excluidas).
      3. Ordena las rutas de menor a mayor peso (kg).
      4. Ordena los vehículos de menor a mayor capacidad (ton).
      5. Para cada ruta (de la más liviana a la más pesada):
           a. Obtiene los vehículos libres en el día candidato.
           b. Prioriza los que caen dentro del rango [util_min, util_max] y
              selecciona el que quede más próximo al 100 % de ocupación.
           c. Si ninguno cabe dentro del rango, selecciona el mejor candidato
              fuera del rango (también por proximidad al 100 %) como fallback,
              para no dejar la ruta sin vehículo.
           d. Si el día preferido no tiene vehículos disponibles, prueba con el
              siguiente día habilitado menos cargado.
      6. Retorna el mapa { ruta_id → { dia, placas, pct, peso_kg, en_rango } }.
    """
    rutas_input   = payload.get("rutas", [])
    vehiculos_in  = payload.get("vehiculos", [])
    pesos         = payload.get("pesos", {})
    volumenes     = payload.get("volumenes", {})
    config_dias   = payload.get("config_dias", {})
    ids_excluidos = set(payload.get("ids_excluidos", []))

    # ── Rango óptimo desde configuración ────────────────────────
    util_min, util_max = _leer_rango_utilizacion()

    # ── Días habilitados (orden canónico) ────────────────────────
    dias_hab = [d for d in DIAS_ORDEN if config_dias.get(d, {}).get("habilitado")]
    if not dias_hab:
        dias_hab = ["lunes", "martes", "miercoles", "jueves", "viernes"]

    # ── Filtrar rutas seleccionadas ──────────────────────────────
    rutas = [r for r in rutas_input if str(r.get("_id", "")) not in ids_excluidos]

    # ── Vehículos disponibles ordenados de menor a mayor capacidad
    # Solo vehículos activos (activo=True o sin campo, por compatibilidad)
    vehiculos = sorted(
        [v for v in vehiculos_in
         if (v.get("capacidad_toneladas") or 0) > 0
         and v.get("activo", True)],
        key=lambda v: v.get("capacidad_toneladas", 0),
    )

    if not vehiculos:
        return {"status": "error", "mensaje": "No hay vehículos configurados."}

    # ── Calcular peso de cada ruta y ordenar de menor a mayor ───
    rutas_con_peso = []
    for ruta in rutas:
        peso_kg = calcular_peso_ruta(ruta, pesos)
        rutas_con_peso.append({**ruta, "_peso_kg": peso_kg})
    rutas_con_peso.sort(key=lambda r: r["_peso_kg"])

    # ── Estado por día: vehículos usados ────────────────────────
    estado_dias: dict = {
        d: {"vehiculos_usados": set(), "rutas": []} for d in dias_hab
    }

    asignaciones: dict = {}   # ruta_id → {dia, placas, pct, peso_kg, en_rango}

    def _dias_candidatos(ruta: dict) -> list:
        """
        Respeta el día configurado en la ruta (dia_sugerido de creacion_rutas).

        Cómo funciona creacion_rutas_logic:
          DIAS_VALIDOS = {'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'}
          El campo dia_sugerido se almacena con mayúscula inicial y tildes.

        Por eso se usa _normalizar_dia() antes de comparar contra las claves
        internas ('lunes', 'miercoles', …), que están en minúsculas sin tildes.

        Regla:
          - Si la ruta tiene un día configurado (dia_sugerido) y ese día está
            habilitado → retorna SOLO ese día. El sistema no mueve la ruta a
            otro día para optimizar carga ni por ningún otro motivo.
          - Si el día configurado no está habilitado, o la ruta no tiene día
            configurado → retorna todos los días habilitados por carga mínima
            (este caso es raro y solo ocurre en rutas sin dia_sugerido).
        """
        # Prioridad 1: dia_sugerido (configurado en Creación de Rutas)
        dia_sug_norm  = _normalizar_dia(ruta.get("dia_sugerido") or "")
        # Prioridad 2: dia_programado (puede venir de una asignación previa)
        dia_prog_norm = _normalizar_dia(ruta.get("dia_programado") or "")

        dia_configurado = None
        for candidato_norm in [dia_sug_norm, dia_prog_norm]:
            if not candidato_norm:
                continue
            for d in dias_hab:
                if _normalizar_dia(d) == candidato_norm:
                    dia_configurado = d
                    break
            if dia_configurado:
                break

        if dia_configurado:
            # El día configurado está habilitado → respetar sin excepciones
            return [dia_configurado]

        # Sin día configurado o día no habilitado → todos los habilitados por carga
        return sorted(dias_hab, key=lambda d: len(estado_dias[d]["rutas"]))

    def _asignar_vehiculo(peso_ton: float, dia: str, volumen_m3_ruta: float = 0.0) -> "dict | None":
        """
        Selecciona el mejor vehículo libre para el día dado.

        Criterio principal: el que deje el porcentaje de ocupación más cercano
        al 100 % DENTRO del rango [util_min, util_max].

        Restricción volumétrica: solo se consideran vehículos cuya capacidad
        volumétrica (volumen_m3) sea estrictamente mayor al volumen total de la
        ruta. Si el vehículo no tiene volumen_m3 definido (o es 0), no se aplica
        restricción volumétrica para ese vehículo.

        Fallback: si ningún vehículo libre queda dentro del rango, se elige el
        de menor score fuera del rango (siempre preferible a dejar la ruta
        sin vehículo). Se excluyen vehículos que físicamente no pueden cargar
        la carga (pct > util_max + 30 %).
        """
        usados = estado_dias[dia]["vehiculos_usados"]
        libres = [
            v for v in vehiculos
            if v.get("placas") not in usados
            and (v.get("capacidad_toneladas") or 0) > 0
            and (
                not (v.get("volumen_m3") or 0)           # sin restricción volumétrica
                or volumen_m3_ruta < v["volumen_m3"]      # volumen estrictamente menor
            )
        ]

        if not libres:
            return None

        # Candidatos dentro del rango óptimo
        en_rango = [
            v for v in libres
            if util_min <= (peso_ton / v["capacidad_toneladas"] * 100) <= util_max
        ]

        if en_rango:
            # El que quede más próximo al 100 %
            return min(en_rango, key=lambda v: abs((peso_ton / v["capacidad_toneladas"] * 100) - 100))

        # Fallback: candidatos que físicamente pueden cargar la ruta
        # (excluimos los que se sobrecargarían más de util_max + 30 %)
        pueden_cargar = [
            v for v in libres
            if (peso_ton / v["capacidad_toneladas"] * 100) <= util_max + 30
        ]

        if puede_cargar := pueden_cargar:
            return min(
                puede_cargar,
                key=lambda v: _score_vehiculo(peso_ton, v, util_min, util_max),
            )

        return None

    # ── Proceso de asignación ────────────────────────────────────
    for ruta in rutas_con_peso:
        ruta_id    = str(ruta.get("_id", ""))
        peso_kg    = ruta["_peso_kg"]
        peso_ton   = peso_kg / 1000
        volumen_m3 = calcular_volumen_ruta(ruta, volumenes)

        asignado = None
        for dia in _dias_candidatos(ruta):
            vehiculo = _asignar_vehiculo(peso_ton, dia, volumen_m3)
            if vehiculo:
                asignado = {"dia": dia, "vehiculo": vehiculo}
                break

        if asignado:
            dia     = asignado["dia"]
            veh     = asignado["vehiculo"]
            placas  = veh.get("placas")
            cap     = veh.get("capacidad_toneladas", 1)
            pct     = round((peso_ton / cap) * 100, 1)
            cap_vol = veh.get("volumen_m3") or 0
            pct_vol = round((volumen_m3 / cap_vol) * 100, 1) if cap_vol > 0 else None

            asignaciones[ruta_id] = {
                "dia":        dia,
                "placas":     placas,
                "pct":        pct,
                "peso_kg":    peso_kg,
                "en_rango":   util_min <= pct <= util_max,
                "volumen_m3": round(volumen_m3, 6),
                "pct_vol":    pct_vol,
                "cumple_vol": True,  # garantizado por el filtro de _asignar_vehiculo
            }
            estado_dias[dia]["vehiculos_usados"].add(placas)
            estado_dias[dia]["rutas"].append(ruta_id)
        else:
            # Sin vehículo disponible: conservar el día configurado de la ruta
            # en lugar de moverla al día menos cargado.
            candidatos = _dias_candidatos(ruta)
            dia = candidatos[0] if candidatos else min(
                dias_hab, key=lambda d: len(estado_dias[d]["rutas"]))
            asignaciones[ruta_id] = {
                "dia":        dia,
                "placas":     None,
                "pct":        0.0,
                "peso_kg":    peso_kg,
                "en_rango":   False,
                "volumen_m3": round(volumen_m3, 6),
                "pct_vol":    None,
                "cumple_vol": False,
            }
            estado_dias[dia]["rutas"].append(ruta_id)

    # ── Resumen por día ──────────────────────────────────────────
    resumen = {
        d: {
            "num_rutas":        len(e["rutas"]),
            "vehiculos_usados": list(e["vehiculos_usados"]),
        }
        for d, e in estado_dias.items()
    }

    # Conteo de rutas fuera del rango óptimo (asignadas pero con pct incorrecto)
    fuera_rango = sum(
        1 for v in asignaciones.values()
        if v["placas"] and not v.get("en_rango", True)
    )

    return {
        "status":       "ok",
        "asignaciones": asignaciones,
        "resumen_dias": resumen,
        "total_rutas":  len(asignaciones),
        "sin_vehiculo": sum(1 for v in asignaciones.values() if not v["placas"]),
        "fuera_rango":  fuera_rango,
        "util_min":     util_min,
        "util_max":     util_max,
    }


# ── Config de días (por logística) ────────────────────────────

def obtener_config_dias(logistica_id: str = None) -> dict:
    """
    Devuelve la configuración de días de operación con dos capas:

      1. BASE: la config global guardada en la colección 'configuracion'
         (sección "Configuración de días de operación" del menú Configuración).
      2. OVERRIDE: si existe una config específica para la logística activa
         (guardada con el modal ⚙ Días dentro de Asignación), sus valores
         sobreescriben los de la base día a día.

    Así la asignación siempre respeta lo que el usuario definió en Configuración,
    y solo se desvía si el usuario lo ajustó manualmente dentro de la logística.
    """
    # ── 1. Cargar config global como base ────────────────────────
    base: dict = {}
    try:
        cfg_global = _obtener_config_general()
        base = dict(cfg_global.get("config_dias") or {})
    except Exception:
        pass

    # ── 2. Cargar config por logística y aplicar como override ──
    if logistica_id:
        oid = _parse_oid(logistica_id)
        if oid:
            try:
                db  = get_db()
                doc = db["config_dias"].find_one({"logistica_id": oid})
                config_logistica = (doc.get("config_dias") or {}) if doc else {}
                if config_logistica:
                    base = {**base, **config_logistica}
            except Exception:
                pass

    return base


def guardar_config_dias(datos: dict, logistica_id: str = None) -> dict:
    if not logistica_id:
        return {"status": "error", "mensaje": "Se requiere logistica_id."}
    oid = _parse_oid(logistica_id)
    if not oid:
        return {"status": "error", "mensaje": "logistica_id inválido."}
    try:
        db = get_db()
        db["config_dias"].update_one(
            {"logistica_id": oid},
            {"$set": {
                "logistica_id":  oid,
                "config_dias":   datos,
                "actualizado_en": datetime.now().isoformat(),
            }},
            upsert=True,
        )
        return {"status": "ok"}
    except Exception as e:
        return {"status": "error", "mensaje": str(e)}


# ── Guardar / recuperar asignación ────────────────────────────

def asignar_rutas(datos: dict, logistica_id: str = None) -> dict:
    """Punto de entrada legacy — delega en guardar_asignacion."""
    return guardar_asignacion(datos, logistica_id)


def guardar_asignacion(payload: dict, logistica_id: str = None) -> dict:
    if not logistica_id:
        return {"status": "error", "mensaje": "Se requiere logistica_id activo."}
    oid = _parse_oid(logistica_id)
    if not oid:
        return {"status": "error", "mensaje": "logistica_id inválido."}

    payload["guardado_en"] = datetime.now().isoformat()

    try:
        config_dias      = obtener_config_dias(logistica_id)
        dias_habilitados = [d for d, cfg in config_dias.items() if cfg.get("habilitado")]
    except Exception:
        dias_habilitados = []

    asig_por_dia = payload.get("asignaciones_por_dia", {})
    dias_prog    = payload.get("dias_programados", {})

    def siguiente_dia_habilitado(dia_actual: str) -> str:
        idx = DIAS_ORDEN.index(dia_actual) if dia_actual in DIAS_ORDEN else 0
        for i in range(1, 8):
            candidato = DIAS_ORDEN[(idx + i) % 7]
            if candidato in dias_habilitados:
                return candidato
        return dia_actual

    reprogramadas = {}
    for ruta_id, dia_actual in dias_prog.items():
        placas = asig_por_dia.get(dia_actual, {}).get(ruta_id, "")
        if not placas:
            sig_dia = siguiente_dia_habilitado(dia_actual)
            if sig_dia != dia_actual:
                reprogramadas[ruta_id] = {"de": dia_actual, "a": sig_dia}

    payload["reprogramadas"] = reprogramadas

    try:
        db = get_db()
        db["asignaciones"].update_one(
            {"logistica_id": oid},
            {"$set": {"logistica_id": oid, **payload}},
            upsert=True,
        )
        return {"status": "ok", "reprogramadas": reprogramadas}
    except Exception as e:
        return {"status": "error", "mensaje": str(e)}


def obtener_asignaciones_previas(logistica_id: str = None) -> dict:
    if not logistica_id:
        return {}
    oid = _parse_oid(logistica_id)
    if not oid:
        return {}
    try:
        db  = get_db()
        doc = db["asignaciones"].find_one({"logistica_id": oid})
        if not doc:
            return {}
        doc.pop("_id", None)
        doc.pop("logistica_id", None)
        return {k: str(v) if isinstance(v, ObjectId) else v for k, v in doc.items()}
    except Exception:
        return {}