"""Operaciones sobre el escenario sintético de Harwiff."""

import hashlib
import json
import re
from pathlib import Path

from wifi import BSSID

ESCENARIO = Path(__file__).resolve().parent / "ejemplos" / "escenario-wifi-mock.json"
UUID = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
SESION = re.compile(rf"agente-{UUID}")
EVIDENCIA = re.compile(rf"[0-9]{{13}}-{UUID}")


def denegar(codigo):
    return {"ok": False, "code": codigo}


def ejecutar_mock(entrada, normalizar_alcance):
    if set(entrada) != {"sessionId", "scopeId", "action", "params", "snapshot", "evidence"}:
        return denegar("invalid_request")
    session_id, scope_id, action = (entrada[clave] for clave in ("sessionId", "scopeId", "action"))
    if (not isinstance(session_id, str) or not SESION.fullmatch(session_id)
            or not isinstance(scope_id, str) or not re.fullmatch(r"[0-9a-f]{64}", scope_id)):
        return denegar("invalid_request")
    snapshot = entrada["snapshot"]
    adaptador = {"id": "mock", "name": "mock", "mode": "mock"}
    if not isinstance(snapshot, dict) or snapshot.get("adapter") != adaptador:
        return denegar("adapter_denied")
    project_id = snapshot.get("projectId")
    if snapshot.get("preflightPassed") is not True or not isinstance(project_id, str) or not re.fullmatch(UUID, project_id):
        return denegar("invalid_scope")
    try:
        scope = normalizar_alcance(snapshot.get("scope"))
    except ValueError:
        return denegar("invalid_scope")
    if scope != snapshot["scope"]:
        return denegar("invalid_scope")

    datos = [project_id, "mock", "mock", sorted(scope["allowedBssids"]),
             sorted(scope["allowedSsids"], key=lambda ssid: ssid.encode("utf-16-be")),
             sorted(scope["allowedChannels"], key=str), scope["maxIterations"]]
    huella = hashlib.sha256(json.dumps(datos, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    if huella != scope_id:
        return denegar("invalid_scope")

    parametros = {
        "observar_entorno": set(),
        "inspeccionar_postura": {"bssid"},
        "registrar_hallazgo": {"bssid", "categoria", "detalle", "evidenceId"},
    }
    if not isinstance(action, str) or action not in parametros:
        return denegar("unknown_tool")
    params = entrada["params"]
    if not isinstance(params, dict) or set(params) != parametros[action] or not all(isinstance(v, str) for v in params.values()):
        return denegar("invalid_arguments")

    try:
        fixture = json.loads(ESCENARIO.read_text(encoding="utf-8"))
        permitidos = {ap["bssid"]: ap for ap in fixture["aps"]
                      if (not scope["allowedBssids"] or ap["bssid"] in scope["allowedBssids"])
                      and (not scope["allowedSsids"] or ap["ssid"] in scope["allowedSsids"])
                      and (not scope["allowedChannels"] or ap["canal"] in scope["allowedChannels"])}
    except (OSError, ValueError, TypeError, KeyError):
        return denegar("broker_error")

    if action == "observar_entorno":
        observaciones = [{clave: ap[clave] for clave in ("bssid", "ssid", "canal", "senalDbm")}
                         for ap in permitidos.values()]
        return {"ok": True, "origen": "mock", "observaciones": observaciones}

    bssid = params["bssid"]
    if not BSSID.fullmatch(bssid):
        return denegar("invalid_arguments")
    bssid = bssid.upper()
    if bssid not in permitidos:
        return denegar("target_denied")
    if action == "inspeccionar_postura":
        return {"ok": True, "origen": "mock", "bssid": bssid, "postura": permitidos[bssid]["postura"]}

    categoria, detalle, evidence_id = (params[clave] for clave in ("categoria", "detalle", "evidenceId"))
    for texto, limite in ((categoria, 64), (detalle, 1000)):
        if not texto.strip() or len(texto) > limite or re.search(r"[\x00-\x1f\x7f-\x9f]", texto):
            return denegar("invalid_arguments")
    if not EVIDENCIA.fullmatch(evidence_id):
        return denegar("invalid_arguments")
    evidencia = entrada["evidence"]
    if (not isinstance(evidencia, dict) or evidencia.get("id") != evidence_id
            or evidencia.get("sessionId") != session_id or evidencia.get("scopeId") != scope_id
            or not isinstance(evidencia.get("bssids"), list) or bssid not in evidencia["bssids"]):
        return denegar("evidence_denied")
    return {"ok": True, "origen": "mock", "bssid": bssid, "evidenceId": evidence_id,
            "categoria": categoria.strip(), "detalle": detalle.strip(), "estado": "hipotesis"}
