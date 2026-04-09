"""
logic/pdf_logic.py
Reporte de pesos — paleta azul, diseño compacto a dos columnas.

Fuente de datos: colección `modificaciones_rutas` (MongoDB),
filtrada por logistica_id proveniente de la sesión Flask.

No se leen archivos JSON.
"""
import os
from datetime import datetime
from bson import ObjectId
from bson.errors import InvalidId

from reportlab.lib.pagesizes import LETTER, portrait
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame,
    Table, TableStyle, Paragraph, Spacer, KeepTogether,
)

from db import get_db

# ── Directorio temporal para el PDF generado ─────────────────
# Se usa /tmp para compatibilidad con entornos de producción (Render, etc.)
# donde el sistema de archivos del proyecto puede ser de solo lectura.
# /tmp siempre es escribible y no necesita crearse.
TEMP_DIR = "/tmp/icg_pdf"

# ── Medidas de página ─────────────────────────────────────────
PW, PH             = portrait(LETTER)
MARGEN             = 15
ESPACIO_ENTRE_COLS = 10
ANCHO_COL          = (PW - MARGEN * 2 - ESPACIO_ENTRE_COLS) / 2

# ── Anchos de columna (suman ANCHO_COL) ──────────────────────
CW = [38, 28, 20, 147, 26, 27]
iDIA, iAPOYO, iSEC, iSUC, iPESO, iPCT_R = range(6)
NCOLS = 6

# ── Fuentes ───────────────────────────────────────────────────
SZ_ENC = 8.0
SZ_HDR = 6.5
SZ_DAT = 5.5
SZ_TOT = 5.5

# ── Paleta ────────────────────────────────────────────────────
C_ENC_VEH = colors.HexColor("#1565C0")
C_HDR_COL = colors.HexColor("#E3F2FD")
C_DIA_BG  = colors.HexColor("#F5F9FF")
C_SUBRUTA = colors.HexColor("#DCEEFB")
C_SUBTOT  = colors.HexColor("#BBDEFB")
C_NAVY    = colors.HexColor("#1565C0")
C_BORDE   = colors.HexColor("#B0BEC5")
C_ALERTA  = colors.HexColor("#C0392B")
C_BLANCO  = colors.white

ORDEN_DIA = {"lunes": 1, "martes": 2, "miercoles": 3, "jueves": 4, "viernes": 5}
ABREV_DIA = {
    "lunes":     "LUNES",
    "martes":    "MARTES",
    "miercoles": "MIÉRCOLES",
    "jueves":    "JUEVES",
    "viernes":   "VIERNES",
}


def _parse_oid(doc_id: str) -> ObjectId | None:
    try:
        return ObjectId(doc_id)
    except (InvalidId, TypeError):
        return None


# ── Helpers de párrafo ────────────────────────────────────────
def _p(txt, sz=SZ_DAT, bold=False, color=colors.black, align=TA_LEFT, italic=False):
    fn = ("Helvetica-Bold" if bold else
          "Helvetica-Oblique" if italic else "Helvetica")
    return Paragraph(
        str(txt),
        ParagraphStyle("_",
                       fontName=fn, fontSize=sz, leading=sz + 2,
                       textColor=color, alignment=align,
                       spaceBefore=0, spaceAfter=0),
    )

def _pc(t, **kw): return _p(t, align=TA_CENTER, **kw)
def _pr(t, **kw): return _p(t, align=TA_RIGHT, **kw)
def _hdr(label):  return _pc(label, sz=SZ_HDR, bold=True, color=C_NAVY)


# ── Encabezado fijo en canvas ─────────────────────────────────
def _draw_header(nombre_log, expedido):
    def draw(canvas, doc):
        canvas.saveState()
        canvas.setFont("Helvetica-Bold", 12)
        canvas.drawCentredString(PW / 2, PH - 25, "INTEGRADORA COMERCIAL DEL GOLFO")
        canvas.setFont("Helvetica", 9)
        canvas.drawCentredString(PW / 2, PH - 40, f"Logística del {nombre_log}")
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(colors.grey)
        canvas.drawCentredString(PW / 2, PH - 52, f"Expedido: {expedido}")
        canvas.setFillColor(colors.black)
        canvas.setLineWidth(1)
        canvas.line(MARGEN, PH - 58, PW - MARGEN, PH - 58)
        canvas.restoreState()
    return draw


# ── Tabla de un vehículo ──────────────────────────────────────
def _tabla_vehiculo(veh_abrev: str, veh_placas: str, rutas: list) -> list:
    rutas_ord = sorted(rutas, key=lambda r: ORDEN_DIA.get(r.get("dia", "").lower(), 99))

    fila_enc = [_pc(f"{veh_abrev}   ( {veh_placas} )", sz=SZ_ENC, bold=True, color=C_BLANCO)] + [""] * (NCOLS - 1)
    fila_hdr = [
        _hdr("DIA"), _hdr("APOYO"), _hdr("SEC."), _hdr("SUCURSAL"),
        _pc("PESO\n(KG)", sz=SZ_HDR, bold=True, color=C_NAVY),
        _pc("%\nRUTA",   sz=SZ_HDR, bold=True, color=C_NAVY),
    ]

    data_rows   = []
    span_cmds   = []
    style_extra = []

    for ruta in rutas_ord:
        dia         = ruta.get("dia", "").lower()
        dia_lbl     = ABREV_DIA.get(dia, dia.upper())
        cap_ton     = float(ruta.get("capacidad_ton", 0))
        cap_kg      = cap_ton * 1000
        peso_ruta   = float(ruta.get("peso_kg", 0))
        pct_util    = float(ruta.get("pct_utilizacion", 0))
        es_sub      = ruta.get("tipo", "") == "subruta"
        suc_list    = ruta.get("sucursales", [])
        row_start   = 2 + len(data_rows)

        for i, s in enumerate(suc_list):
            s_kg  = float(s.get("peso_kg", 0))
            pct_r = (s_kg / peso_ruta * 100) if peso_ruta else 0
            data_rows.append([
                _pc(dia_lbl, sz=SZ_DAT, bold=True) if i == 0 else "",
                _pc("—",     sz=SZ_DAT)             if i == 0 else "",
                _pc(str(s.get("orden", i + 1)), sz=SZ_DAT),
                _p(str(s.get("nombre", "—")), sz=SZ_DAT),
                _pr(f"{s_kg:,.1f}", sz=SZ_DAT),
                _pc(f"{pct_r:.0f}%", sz=SZ_DAT),
            ])
            if es_sub:
                ridx = 2 + len(data_rows) - 1
                style_extra.append(("BACKGROUND", (iSUC, ridx), (iPCT_R, ridx), C_SUBRUTA))

        row_end = 2 + len(data_rows) - 1
        if row_end > row_start:
            span_cmds += [
                ("SPAN", (iDIA,   row_start), (iDIA,   row_end)),
                ("SPAN", (iAPOYO, row_start), (iAPOYO, row_end)),
            ]

        sob   = pct_util > 100
        n_suc = len(suc_list)
        data_rows.append([
            "", "", "",
            _p(f"TOTAL {dia_lbl}  ·  {n_suc} suc.", sz=SZ_TOT, bold=True),
            _pr(f"{peso_ruta:,.1f}", sz=SZ_TOT, bold=True),
            _pc(f"{pct_util:.1f}%", sz=SZ_TOT, bold=True,
                color=C_ALERTA if sob else C_NAVY),
        ])
        sub_idx = 2 + len(data_rows) - 1
        style_extra += [
            ("BACKGROUND", (0, sub_idx), (-1, sub_idx), C_SUBTOT),
            ("FONTNAME",   (0, sub_idx), (-1, sub_idx), "Helvetica-Bold"),
        ]

    all_rows = [fila_enc, fila_hdr] + data_rows
    n        = len(all_rows)

    base_style = [
        ("SPAN",          (0, 0),   (-1, 0)),
        ("BACKGROUND",    (0, 0),   (-1, 0),  C_ENC_VEH),
        ("TEXTCOLOR",     (0, 0),   (-1, 0),  C_BLANCO),
        ("FONTNAME",      (0, 0),   (-1, 0),  "Helvetica-Bold"),
        ("FONTSIZE",      (0, 0),   (-1, 0),  SZ_ENC),
        ("ALIGN",         (0, 0),   (-1, 0),  "CENTER"),
        ("VALIGN",        (0, 0),   (-1, 0),  "MIDDLE"),
        ("TOPPADDING",    (0, 0),   (-1, 0),  5),
        ("BOTTOMPADDING", (0, 0),   (-1, 0),  5),
        ("BACKGROUND",    (0, 1),   (-1, 1),  C_HDR_COL),
        ("FONTNAME",      (0, 1),   (-1, 1),  "Helvetica-Bold"),
        ("TEXTCOLOR",     (0, 1),   (-1, 1),  C_NAVY),
        ("BACKGROUND",    (iDIA,   2), (iDIA,   -1), C_DIA_BG),
        ("BACKGROUND",    (iAPOYO, 2), (iAPOYO, -1), C_DIA_BG),
        ("GRID",          (0, 0),   (-1, -1), 0.4, C_BORDE),
        ("FONTSIZE",      (0, 1),   (-1, -1), SZ_HDR),
        ("ALIGN",         (0, 1),   (-1, -1), "CENTER"),
        ("ALIGN",         (iSUC, 2), (iSUC, -1), "LEFT"),
        ("ALIGN",         (iPESO, 2),(iPESO,-1), "RIGHT"),
        ("VALIGN",        (0, 0),   (-1, -1), "MIDDLE"),
        ("TOPPADDING",    (0, 1),   (-1, -1), 3),
        ("BOTTOMPADDING", (0, 1),   (-1, -1), 3),
        ("LEFTPADDING",   (0, 0),   (-1, -1), 2),
        ("RIGHTPADDING",  (0, 0),   (-1, -1), 2),
    ]

    t = Table(all_rows, colWidths=CW,
              rowHeights=[None, 28] + [None] * (n - 2),
              repeatRows=2)
    t.setStyle(TableStyle(base_style + span_cmds + style_extra))
    return [KeepTogether([t, Spacer(1, 8)])]


# ── Función principal ─────────────────────────────────────────
def _rutas_desde_asignaciones(db, oid) -> list:
    """
    Construye la lista de rutas para el PDF a partir de la colección
    `asignaciones` (guardada en el Paso 3 — Asignación).

    Se usa como fallback cuando `modificaciones_rutas` no existe, permitiendo
    generar el PDF sin haber pasado por la etapa de Modificación.
    """
    doc = db["asignaciones"].find_one({"logistica_id": oid})
    if not doc:
        return []

    rutas = []
    detalle = doc.get("detalle_por_dia", {})
    for dia, rutas_dia in detalle.items():
        if not isinstance(rutas_dia, dict):
            continue
        for ruta_id, info in rutas_dia.items():
            if not isinstance(info, dict):
                continue
            suc_list = [
                {
                    "orden":    s.get("orden", i + 1),
                    "nombre":   s.get("nombre") or s.get("nombre_tienda") or s.get("nombre_pedido") or "—",
                    "peso_kg":  float(s.get("peso_kg", 0) or 0),
                }
                for i, s in enumerate(info.get("sucursales", []))
            ]
            rutas.append({
                "id":               ruta_id,
                "nombre":           info.get("nombre_ruta", ""),
                "tipo":             "autorizada",
                "dia":              dia,
                "vehiculo_abrev":   info.get("vehiculo_abreviatura") or "S/N",
                "vehiculo_placas":  info.get("vehiculo_placas") or "—",
                "capacidad_ton":    float(info.get("capacidad_ton") or 0),
                "peso_kg":          float(info.get("peso_total_kg") or 0),
                "pct_utilizacion":  float(info.get("porcentaje_utilizacion") or 0),
                "sucursales":       suc_list,
            })
    return rutas


def generar_pdf(datos_sesion: dict) -> str:
    """
    Genera el reporte PDF de pesos.

    Fuente de datos (en orden de preferencia):
      1. `modificaciones_rutas` — datos confirmados tras la etapa de Modificación.
      2. `asignaciones`         — fallback si Modificación no fue guardada.
         Permite generar el PDF directamente después de la etapa de Asignación.

    Devuelve la ruta absoluta al PDF generado en static/temp/.
    """
    os.makedirs(TEMP_DIR, exist_ok=True)

    logistica_id = datos_sesion.get("id")
    oid = _parse_oid(logistica_id) if logistica_id else None
    if not oid:
        raise ValueError("No hay logística activa o su ID es inválido.")

    db  = get_db()

    # ── 1. Intentar leer desde modificaciones_rutas ───────────────
    doc  = db["modificaciones_rutas"].find_one({"logistica_id": oid})
    rutas: list = doc.get("rutas_confirmadas", []) if doc else []

    # ── 2. Fallback a asignaciones si no hay modificaciones ───────
    if not rutas:
        rutas = _rutas_desde_asignaciones(db, oid)

    if not rutas:
        raise FileNotFoundError(
            "No se encontraron datos para generar el reporte. "
            "Completa al menos la etapa de Asignación (Paso 3) y guarda antes de generar el PDF."
        )

    nombre_log = datos_sesion.get("nombre", "Logística")
    f_ini      = datos_sesion.get("fecha_inicio", "")
    f_fin      = datos_sesion.get("fecha_fin", "")
    expedido   = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    rango_log  = (f"{nombre_log}  {f_ini} — {f_fin}"
                  if f_ini and f_fin else nombre_log)

    ts       = datetime.now().strftime("%Y%m%d_%H%M%S")
    filepath = os.path.join(TEMP_DIR, f"{ts}.pdf")

    doc_pdf = BaseDocTemplate(
        filepath,
        pagesize=portrait(LETTER),
        rightMargin=MARGEN, leftMargin=MARGEN,
        topMargin=65, bottomMargin=MARGEN,
        title=f"Reporte — {nombre_log}",
        author="Sistema ICG",
    )

    frame_izq = Frame(
        MARGEN, MARGEN, ANCHO_COL, PH - 75,
        leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
        id="col_izq", showBoundary=0,
    )
    frame_der = Frame(
        MARGEN + ANCHO_COL + ESPACIO_ENTRE_COLS, MARGEN, ANCHO_COL, PH - 75,
        leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
        id="col_der", showBoundary=0,
    )

    doc_pdf.addPageTemplates([
        PageTemplate(
            id="DosColumnas",
            frames=[frame_izq, frame_der],
            onPage=_draw_header(rango_log, expedido),
        )
    ])

    grupos: dict = {}
    for r in rutas:
        veh  = r.get("vehiculo_abrev") or "S/N"
        plac = r.get("vehiculo_placas") or "—"
        if veh not in grupos:
            grupos[veh] = {"placas": plac, "rutas": []}
        grupos[veh]["rutas"].append(r)

    elements = []
    for veh in sorted(grupos, key=lambda v: v or ""):
        info = grupos[veh]
        elements.extend(_tabla_vehiculo(veh, info["placas"], info["rutas"]))

    doc_pdf.build(elements)
    return filepath