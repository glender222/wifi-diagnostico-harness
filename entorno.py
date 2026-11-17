"""Detección local y ejecución del diagnóstico en el OpenSandbox de Harwiff."""

import argparse
import asyncio
import hashlib
import json
import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

from diagnostico import analizar
from wifi import analizar_aislado, muestra_vacia, nmcli, recolectar

IMAGEN = "python@sha256:c5ba3deef00c7758561a0f03c26f44f10589263d40e732b8748e0d1f38f6dd89"
EXECD = "opensandbox/execd@sha256:6cf7dba2f21f0b536e100563d841ac58a9f31c2b0a081b7ac76796a24d6f47e2"


def adaptadores(sysfs=Path("/sys/class/net")):
    estados = {}
    for linea in nmcli("DEVICE,TYPE,STATE", "device", "status").splitlines():
        partes = linea.split(":", 2)
        if len(partes) == 3 and partes[1] == "wifi":
            estados[partes[0]] = partes[2] == "connected"
    retorno = []
    for nombre, activo in sorted(estados.items()):
        interfaz = sysfs / nombre
        dispositivo = interfaz / "device"
        fisico = dispositivo.resolve() if dispositivo.exists() else None
        buses = ({(ruta / "subsystem").resolve().name for ruta in (fisico, *fisico.parents)}
                 if fisico else set())
        tipo = "usb" if "usb" in buses else "integrado" if buses & {"pci", "sdio", "platform"} else "desconocido"
        identidad = str(fisico) if fisico else str(interfaz.resolve())
        id_local = hashlib.sha256(identidad.encode()).hexdigest()[:20]
        retorno.append({"id": id_local, "interfaz": nombre, "tipo": tipo, "activo": activo})
    return retorno


def docker(*argumentos, timeout=180):
    try:
        return subprocess.run(["docker", *argumentos], timeout=timeout,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


@contextmanager
def sandbox_administrado(puerto_pedido=0):
    if not docker("info", timeout=10):
        raise RuntimeError("Docker no está accesible para Harwiff. Prueba /diagnostico demo.")
    for imagen in (EXECD, IMAGEN):
        if not docker("image", "inspect", imagen, timeout=10) and not docker("pull", imagen):
            raise RuntimeError("No se pudo descargar una imagen fijada de OpenSandbox.")

    with TemporaryDirectory(prefix="harwiff-sandbox-") as temporal:
        directorio = Path(temporal)
        clave = secrets.token_urlsafe(32)
        with socket.socket() as reserva:
            try:
                reserva.bind(("127.0.0.1", puerto_pedido))
            except OSError as error:
                raise RuntimeError("Puerto local ocupado. Usa /config sandbox auto.") from error
            puerto = reserva.getsockname()[1]
        config = directorio / "sandbox.toml"
        config.write_text(
            f'[server]\nhost = "127.0.0.1"\nport = {puerto}\napi_key = "{clave}"\n'
            f'[runtime]\ntype = "docker"\nexecd_image = "{EXECD}"\n'
            '[docker]\nnetwork_mode = "bridge"\npublish_host = "127.0.0.1"\npids_limit = 128\n'
            f'[store]\npath = {json.dumps(str(directorio / "sandbox.db"))}\n',
            encoding="utf-8",
        )
        with (directorio / "servidor.log").open("wb") as registro:
            proceso = subprocess.Popen(
                [sys.executable, "-c", "from opensandbox_server.cli import main; main()",
                 "--config", str(config)], stdin=subprocess.DEVNULL, stdout=registro, stderr=registro,
            )
            try:
                direccion = f"127.0.0.1:{puerto}"
                cliente = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                limite = time.monotonic() + 20
                while time.monotonic() < limite and proceso.poll() is None:
                    solicitud = urllib.request.Request(
                        f"http://{direccion}/v1/sandboxes", headers={"OPEN-SANDBOX-API-KEY": clave},
                    )
                    try:
                        with cliente.open(solicitud, timeout=1):
                            break
                    except OSError:
                        time.sleep(0.15)
                else:
                    raise RuntimeError("El OpenSandbox incluido no pudo iniciar en loopback.")
                yield direccion, clave
            finally:
                if proceso.poll() is None:
                    proceso.terminate()
                    try:
                        proceso.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        proceso.kill()
                        proceso.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operacion", choices=("adaptadores", "diagnostico", "demo", "estado"))
    parser.add_argument("--adaptador")
    parser.add_argument("--puerto", type=int, choices=range(0, 65536), metavar="0..65535", default=0)
    args = parser.parse_args()
    def interrumpir(_senal, _marco):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrumpir)
    try:
        if args.operacion == "adaptadores":
            resultado = adaptadores()
        elif args.operacion == "estado":
            resultado = {"docker": docker("info", timeout=4)}
        elif args.operacion == "demo":
            muestra = muestra_vacia(1)
            muestra.update(conectada=True, senal_dbm=-82)
            resultado = {**analizar(muestra), "origen": "demo"}
        else:
            seleccion = [item for item in adaptadores() if item["id"] == args.adaptador]
            if len(seleccion) != 1:
                raise RuntimeError("El adaptador seleccionado no está disponible o es ambiguo. Usa /adaptador.")
            muestra = recolectar(seleccion[0]["interfaz"])
            with sandbox_administrado(args.puerto) as (dominio, clave):
                resultado = asyncio.run(analizar_aislado(
                    muestra, False, dominio=dominio, clave=clave, imagen=IMAGEN,
                ))
            resultado["origen"] = "networkmanager"
        print(json.dumps(resultado, ensure_ascii=False, indent=2))
    except KeyboardInterrupt:
        return 130
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 1
    except Exception:
        print("No se pudo completar el diagnóstico en OpenSandbox.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
