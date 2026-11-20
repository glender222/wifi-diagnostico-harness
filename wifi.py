"""Recoge indicadores Wi-Fi en Linux y produce un informe portable."""

import argparse
import asyncio
import ipaddress
import json
import os
import re
import subprocess
import sys
from datetime import timedelta
from pathlib import Path

from diagnostico import analizar

CAMPOS = (
    "GENERAL.TYPE,GENERAL.STATE,IP4.ADDRESS,IP4.GATEWAY,IP4.DNS,"
    "IP6.ADDRESS,IP6.GATEWAY,IP6.DNS"
)
BSSID = re.compile(r"(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}")


def nmcli(*args):
    try:
        return subprocess.run(
            ["nmcli", "--terse", "--escape", "no", "--fields", *args],
            env={**os.environ, "LC_ALL": "C"},
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        ).stdout
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError("No se pudo consultar NetworkManager con nmcli.") from error


def asociacion_actual(interfaz, consultar=None):
    consultar = consultar or nmcli
    salida = consultar("IN-USE,SSID-HEX,CHAN,FREQ,BSSID", "device", "wifi", "list",
                   "ifname", interfaz, "--rescan", "no")
    activas = [linea.split(":", 4) for linea in salida.splitlines() if linea.startswith("*:")]
    if len(activas) != 1 or len(activas[0]) != 5:
        return None
    _, ssid_hex, canal, frecuencia, bssid = activas[0]
    if (not BSSID.fullmatch(bssid) or not re.fullmatch(r"[1-9][0-9]{0,2}", canal)
            or int(canal) > 233 or not re.fullmatch(r"[1-9][0-9]* MHz", frecuencia)):
        return None
    if ssid_hex in ("", "--"):
        ssid_hex = ""
    if not re.fullmatch(r"(?:[0-9a-fA-F]{2}){0,32}", ssid_hex):
        return None
    return bssid.upper(), bytes.fromhex(ssid_hex), int(canal), frecuencia


def senal_dbm(interfaz):
    try:
        lineas = Path("/proc/net/wireless").read_text().splitlines()[2:]
    except OSError:
        return None
    for linea in lineas:
        nombre, _, valores = linea.partition(":")
        if nombre.strip() == interfaz:
            campos = valores.split()
            if len(campos) >= 3 and re.fullmatch(r"-[0-9]{1,3}\.?", campos[2]):
                dbm = int(campos[2].rstrip("."))
                return dbm if -127 <= dbm < 0 else None
    return None


def tiene_ip(campos, familia):
    clave = f"IP{familia}.ADDRESS"
    for campo, valor in campos.items():
        if campo.split("[", 1)[0] != clave or not valor:
            continue
        try:
            ip = ipaddress.ip_interface(valor).ip
        except ValueError:
            continue
        if ip.version == familia and not (ip.is_link_local or ip.is_loopback or ip.is_unspecified):
            return True
    return False


def muestra_vacia(cantidad):
    return {
        "interfaces_wifi": cantidad,
        "conectada": False,
        "senal_dbm": None,
        "ipv4_no_link_local": False,
        "ipv6_no_link_local": False,
        "gateway_ipv4": False,
        "gateway_ipv6": False,
        "dns_wifi": False,
    }


def recolectar(interfaz):
    dispositivos = nmcli("DEVICE,TYPE", "device", "status").splitlines()
    wifi = [nombre for nombre, _, tipo in (linea.rpartition(":") for linea in dispositivos)
            if tipo == "wifi"]
    if interfaz is not None and interfaz not in wifi:
        raise RuntimeError("La interfaz solicitada no figura como Wi-Fi en NetworkManager.")

    muestra = muestra_vacia(len(wifi))
    candidatas = [interfaz] if interfaz is not None else wifi
    activas = []
    for dispositivo in candidatas:
        salida = nmcli(CAMPOS, "device", "show", dispositivo)
        campos = dict(linea.split(":", 1) for linea in salida.splitlines() if ":" in linea)
        estado = campos.get("GENERAL.STATE", "").split()
        if campos.get("GENERAL.TYPE") == "wifi" and estado[:1] == ["100"]:
            activas.append((dispositivo, campos))

    if len(activas) > 1:
        raise RuntimeError("Hay varias interfaces Wi-Fi activas. Selecciona una con --interfaz.")
    if activas:
        dispositivo, campos = activas[0]
        muestra.update(
            conectada=True,
            senal_dbm=senal_dbm(dispositivo),
            ipv4_no_link_local=tiene_ip(campos, 4),
            ipv6_no_link_local=tiene_ip(campos, 6),
            gateway_ipv4=campos.get("IP4.GATEWAY", "") not in {"", "--"},
            gateway_ipv6=campos.get("IP6.GATEWAY", "") not in {"", "--"},
            dns_wifi=any(valor not in {"", "--"} for campo, valor in campos.items()
                         if campo.split("[", 1)[0] in {"IP4.DNS", "IP6.DNS"}),
        )
    return muestra


async def analizar_aislado(muestra, denegar_egreso, *, dominio=None, clave=None, imagen="python:3.12-alpine"):
    try:
        from opensandbox import Sandbox
        from opensandbox.config import ConnectionConfig
        from opensandbox.models import NetworkPolicy, WriteEntry
    except ImportError as error:
        raise RuntimeError("Instala primero requirements-opensandbox.txt en un entorno virtual.") from error

    conexion = ConnectionConfig(
        domain=dominio or os.environ.get("OPENSANDBOX_DOMAIN", "127.0.0.1:8090"),
        protocol="http" if dominio else os.environ.get("OPENSANDBOX_PROTOCOL", "http"),
        api_key=clave or os.environ.get("OPENSANDBOX_API_KEY"),
        disable_metrics=True,
        request_timeout=timedelta(seconds=60),
    )
    politica = NetworkPolicy(default_action="deny", egress=[]) if denegar_egreso else None
    sandbox = await Sandbox.create(
        imagen,
        resource={"cpu": "500m", "memory": "256Mi"},
        timeout=timedelta(minutes=3),
        ready_timeout=timedelta(seconds=60),
        connection_config=conexion,
        network_policy=politica,
        metadata={"app": "wifi-diagnostico"},
    )
    async with sandbox:
        try:
            await sandbox.files.write_files([
                WriteEntry(path="/tmp/diagnostico.py",
                           data=Path(__file__).with_name("diagnostico.py").read_text(),
                           mode=600),
                WriteEntry(path="/tmp/muestra.json", data=json.dumps(muestra), mode=600),
            ])
            ejecucion = await sandbox.commands.run("python /tmp/diagnostico.py /tmp/muestra.json")
            if ejecucion.error is not None:
                raise RuntimeError("El analizador falló dentro de OpenSandbox.")
            informe = json.loads("".join(log.text for log in ejecucion.logs.stdout))
            if informe != analizar(muestra):
                raise RuntimeError("OpenSandbox devolvió un informe incompleto o inesperado.")
            return informe
        finally:
            await sandbox.destroy()


def formato_json(datos):
    return json.dumps(datos, ensure_ascii=False, indent=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--motor", choices=("local", "opensandbox"), default="local")
    origen = parser.add_mutually_exclusive_group()
    origen.add_argument("--demo", action="store_true", help="Usa una muestra sintética.")
    origen.add_argument("--interfaz", help="Selecciona una interfaz Wi-Fi de NetworkManager.")
    parser.add_argument("--denegar-egreso", action="store_true",
                        help="Solicita una política deny al servidor OpenSandbox.")
    args = parser.parse_args()
    if args.denegar_egreso and args.motor != "opensandbox":
        parser.error("--denegar-egreso requiere --motor opensandbox")

    try:
        if args.demo:
            muestra = muestra_vacia(1)
            muestra.update(conectada=True, senal_dbm=-82)
        else:
            muestra = recolectar(args.interfaz)
        informe = (asyncio.run(analizar_aislado(muestra, args.denegar_egreso))
                   if args.motor == "opensandbox" else analizar(muestra))
        informe["origen"] = "demo" if args.demo else "networkmanager"
    except Exception as error:
        print(f"Error de diagnóstico ({type(error).__name__}).", file=sys.stderr)
        if type(error) is RuntimeError:
            print(str(error), file=sys.stderr)
        elif args.motor == "opensandbox":
            print("Revisa el servicio, la autenticación y los logs de OpenSandbox.", file=sys.stderr)
        return 1

    print(formato_json(informe))
    return 0


if __name__ == "__main__":
    sys.exit(main())
