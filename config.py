import os


class Config:
    SECRET_KEY    = os.environ.get("SECRET_KEY", "clave-secreta-dev")
    DEBUG         = True

    # ── MongoDB ────────────────────────────────────────────────
    # Carga desde variables de entorno. Si no están definidas,
    # lanza un error claro al iniciar la app (no un fallo críptico
    # cuando ya hay requests en vuelo).
    MONGO_URI     = os.getenv("MONGO_URI",     "mongodb://localhost:27017/")
    MONGO_DB_NAME = os.getenv("MONGO_DB_NAME", "icg")

    @classmethod
    def validar(cls):
        """Llama a esto en create_app() para detectar config faltante temprano."""
        faltantes = []
        if not cls.MONGO_URI:
            faltantes.append("MONGO_URI")
        if not cls.MONGO_DB_NAME:
            faltantes.append("MONGO_DB_NAME")
        if faltantes:
            raise RuntimeError(
                f"Variables de entorno faltantes: {', '.join(faltantes)}. "
                "Revisa tu archivo .env o entorno del servidor."
            )