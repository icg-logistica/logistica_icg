from pymongo import MongoClient
from flask import current_app, g


def get_db():
    """
    Devuelve la instancia de la base de datos MongoDB para el contexto
    actual de la request. Reutiliza el cliente si ya existe en `g`.
    """
    if "mongo_client" not in g:
        g.mongo_client = MongoClient(current_app.config["MONGO_URI"])
    return g.mongo_client[current_app.config["MONGO_DB_NAME"]]


def close_db(e=None):
    """
    Cierra el MongoClient al finalizar el contexto de la app.
    Registrar en app.py con: app.teardown_appcontext(close_db)
    """
    client = g.pop("mongo_client", None)
    if client is not None:
        client.close()