"""
logic/validacion_logic.py
Lógica de negocio para la Sección 4 — Validación de Rutas.

Lee la asignación desde la colección `asignaciones` (MongoDB)
y persiste el resultado en la colección `validaciones`.
No se usan archivos JSON.
"""
from datetime import datetime
from bson import ObjectId
from bson.errors import InvalidId

from db import get_db

DIAS_ORDEN = {
    "lunes": 1, "martes": 2, "miercoles": 3,
    "jueves": 4, "viernes": 5, "sabado": 6, "domingo": 7,
}


def _parse_oid(doc_id: str) -> ObjectId | None:
    try:
        return ObjectId(doc_id)
    except (InvalidId, TypeError):
        return None


# ─────────────────────────────────────────────────────────────────────────────

def obtener_rutas_para_validacion(logistica_id: str) -> dict:
    """
    Lee asignacion desde MongoDB y evalúa cada ruta según criterios
    de peso (80-120% capacidad) y horario (regreso antes del límite).

    Retorna:
        {
          "rutas": [ {...}, ... ],
          "resumen": { total, verdes, naranjas, rojas }
        }
    """
    oid = _parse_oid(logistica_id)
    if not oid:
        return {"rutas": [], "resumen": {"total": 0, "verdes": 0, "naranjas": 0, "rojas": 0}}

    db  = get_db()
    doc = db["asignaciones"].find_one({"logistica_id": oid})
    if not doc:
        return {"rutas": [], "resumen": {"total": 0, "verdes": 0, "naranjas": 0, "rojas": 0}}

    detalle = doc.get("detalle_por_dia", {})
    rutas   = []

    for dia, rutas_dia in detalle.items():
        for ruta_id, info in rutas_dia.items():
            cumple_peso    = bool(info.get("cumple_rango_capacidad", False))
            cumple_horario = bool(info.get("cumple_horario", False))

            if cumple_peso and cumple_horario:
                color = "verde"
            elif not cumple_peso and not cumple_horario:
                color = "rojo"
            else:
                color = "naranja"

            rutas.append({
                "id":              ruta_id,
                "nombre_ruta":     info.get("nombre_ruta", "Sin nombre"),
                "dia":             dia,
                "dia_orden":       DIAS_ORDEN.get(dia, 99),
                "vehiculo":        info.get("vehiculo_placas", ""),
                "vehiculo_abrev":  info.get("vehiculo_abreviatura", ""),
                "capacidad_ton":   info.get("capacidad_ton", 0),
                "peso_kg":         info.get("peso_total_kg", 0),
                "peso_ton":        info.get("peso_total_ton", 0),
                "pct_utilizacion": info.get("porcentaje_utilizacion", 0),
                "cumple_peso":     cumple_peso,
                "distancia_km":    info.get("distancia_km", 0),
                "conduccion_min":  info.get("tiempo_conduccion_min", 0),
                "descarga_min":    info.get("tiempo_descarga_min", 0),
                "extra_min":       info.get("tiempo_extra_min", 0),
                "total_min":       info.get("tiempo_total_min", 0),
                "hora_salida":     info.get("hora_salida", ""),
                "hora_regreso":    info.get("hora_regreso_estimada", ""),
                "cumple_horario":  cumple_horario,
                "color":           color,
                "num_sucursales":  len(info.get("sucursales", [])),
                "sucursales":      info.get("sucursales", []),
            })

    rutas.sort(key=lambda r: (r["dia_orden"], r["nombre_ruta"]))

    verdes   = sum(1 for r in rutas if r["color"] == "verde")
    naranjas = sum(1 for r in rutas if r["color"] == "naranja")
    rojas    = sum(1 for r in rutas if r["color"] == "rojo")

    return {
        "rutas": rutas,
        "resumen": {
            "total":    len(rutas),
            "verdes":   verdes,
            "naranjas": naranjas,
            "rojas":    rojas,
        }
    }


def guardar_validacion(payload: dict, logistica_id: str) -> dict:
    """
    Persiste el resultado de la validación en la colección `validaciones`.

    Payload esperado:
        {
          "autorizadas":  [ { id, nombre_ruta, dia, ... } ],
          "reorganizar":  [ { id, nombre_ruta, dia, ... } ],
        }
    """
    oid = _parse_oid(logistica_id)
    if not oid:
        return {"status": "error", "mensaje": "logistica_id inválido."}

    payload["guardado_en"]   = datetime.now().isoformat()
    payload["logistica_id"]  = oid

    try:
        db = get_db()
        db["validaciones"].update_one(
            {"logistica_id": oid},
            {"$set": payload},
            upsert=True,
        )
        return {"status": "ok"}
    except Exception as e:
        return {"status": "error", "mensaje": str(e)}


def obtener_validacion_previa(logistica_id: str) -> dict:
    """Devuelve la última validación guardada para la logística activa."""
    oid = _parse_oid(logistica_id)
    if not oid:
        return {}
    try:
        db  = get_db()
        doc = db["validaciones"].find_one({"logistica_id": oid})
        if not doc:
            return {}
        doc.pop("_id", None)
        doc["logistica_id"] = str(doc["logistica_id"])
        return doc
    except Exception:
        return {}