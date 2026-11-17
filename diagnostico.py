"""Reglas de diagnóstico compartidas entre el host y OpenSandbox."""

import json
import sys


def analizar(muestra):
    hallazgos = []
    if not muestra["interfaces_wifi"]:
        hallazgos.append("sin_interfaz_wifi")
    elif not muestra["conectada"]:
        hallazgos.append("sin_conexion_wifi_activa")
    else:
        if not (muestra["ipv4_no_link_local"] or muestra["ipv6_no_link_local"]):
            hallazgos.append("sin_ip_distinta_de_link_local")
        if not (muestra["gateway_ipv4"] or muestra["gateway_ipv6"]):
            hallazgos.append("sin_gateway_configurado_en_wifi")
        if not muestra["dns_wifi"]:
            hallazgos.append("sin_dns_configurado_en_wifi")
        if muestra["senal_dbm"] is None:
            hallazgos.append("senal_no_disponible")
        elif muestra["senal_dbm"] <= -75:
            hallazgos.append("senal_debil_segun_umbral_orientativo")

    return {
        "esquema": "wifi-diagnostico/v1",
        "observaciones": muestra,
        "hallazgos": hallazgos,
        "alcance": "Estado local de la interfaz. Alcance a Internet y resolución DNS sin medir.",
    }


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as archivo:
        print(json.dumps(analizar(json.load(archivo)), ensure_ascii=False))
