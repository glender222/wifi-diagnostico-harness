"""Adaptador de texto para un deployment existente de Microsoft Foundry."""

import http.client
import json
import os
import re


def explicar(mensajes):
    host = os.environ.get("FOUNDRY_HOST", "")
    deployment = os.environ.get("FOUNDRY_DEPLOYMENT", "")
    clave = os.environ.get("FOUNDRY_API_KEY", "")
    if not deployment or not clave or not re.fullmatch(
        r"[a-zA-Z0-9][a-zA-Z0-9-]*\.(?:openai\.azure\.com|services\.ai\.azure\.com)", host
    ):
        raise RuntimeError(
            "Configura FOUNDRY_HOST (solo dominio), FOUNDRY_DEPLOYMENT y FOUNDRY_API_KEY."
        )

    conexion = http.client.HTTPSConnection(host, timeout=60)
    try:
        conexion.request(
            "POST",
            "/openai/v1/chat/completions",
            body=json.dumps({"model": deployment, "messages": mensajes}),
            headers={"api-key": clave, "Content-Type": "application/json"},
        )
        respuesta = conexion.getresponse()
        if respuesta.status != 200:
            raise RuntimeError(f"Foundry respondió HTTP {respuesta.status}.")
        datos = respuesta.read(1_000_001)
        if len(datos) > 1_000_000:
            raise RuntimeError("La respuesta de Foundry excedió el límite de lectura.")
        texto = json.loads(datos)["choices"][0]["message"]["content"]
        if not isinstance(texto, str) or not texto.strip():
            raise RuntimeError("Foundry respondió sin texto.")
        return texto
    except (OSError, http.client.HTTPException, ValueError, KeyError, IndexError, TypeError) as error:
        raise RuntimeError("No se obtuvo una respuesta de texto válida de Foundry.") from error
    finally:
        conexion.close()
