import os
from flask import Flask, redirect, url_for
from config import Config
from db import close_db

from router.menu_router           import menu_bp
from router.configuracion_router  import configuracion_bp
from router.extraccion_router     import extraccion_bp
from router.creacion_rutas_router import creacion_rutas_bp
from router.asignacion_router     import asignacion_bp
from router.validacion_router     import validacion_bp
from router.reordenamiento_router import reordenamiento_bp
from router.modificacion_router   import modificacion_bp
from router.pdf_router            import pdf_bp


def create_app():
    app = Flask(__name__)
    app.config.from_object(Config)

    # Validar variables de entorno críticas al arrancar
    Config.validar()

    # ── Blueprints ─────────────────────────────────────────────────────────
    app.register_blueprint(menu_bp,           url_prefix="/")
    app.register_blueprint(configuracion_bp,  url_prefix="/configuracion")
    app.register_blueprint(extraccion_bp,     url_prefix="/extraccion")
    app.register_blueprint(creacion_rutas_bp, url_prefix="/creacion-rutas")
    app.register_blueprint(asignacion_bp,     url_prefix="/asignacion")
    app.register_blueprint(validacion_bp,     url_prefix="/validacion")
    app.register_blueprint(reordenamiento_bp, url_prefix="/reordenamiento")
    app.register_blueprint(modificacion_bp,   url_prefix="/modificacion")
    app.register_blueprint(pdf_bp,            url_prefix="/pdf")

    # ── Cierre de conexión MongoDB al final de cada contexto ───────────────
    app.teardown_appcontext(close_db)

    return app


# Expuesto a nivel de módulo para que gunicorn pueda encontrarlo:
#   gunicorn app:app
app = create_app()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=Config.DEBUG)
