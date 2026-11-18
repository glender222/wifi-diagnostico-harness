"""Detección local y ejecución del diagnóstico en el OpenSandbox de Harwiff."""

import argparse
import asyncio
import fcntl
import hashlib
import json
import os
import re
import secrets
import signal
import socket
import stat
import subprocess
import sys
import time
import urllib.request
from contextlib import ExitStack, contextmanager, suppress
from pathlib import Path
from tempfile import TemporaryDirectory

from wifi import BSSID, analizar_aislado, asociacion_actual, nmcli, recolectar
from broker_mock import ejecutar_mock

IMAGEN = "python@sha256:c5ba3deef00c7758561a0f03c26f44f10589263d40e732b8748e0d1f38f6dd89"
EXECD = "opensandbox/execd@sha256:6cf7dba2f21f0b536e100563d841ac58a9f31c2b0a081b7ac76796a24d6f47e2"
MOCK = {"id": "mock", "name": "mock", "mode": "mock", "tipo": "simulado", "activo": False}
ID_ADAPTADOR = re.compile(r"[0-9a-f]{20}")
ID_EJECUCION = re.compile(r"[0-9]{13}-[0-9a-f-]{36}")
DEMO = Path(__file__).resolve().parent / "ejemplos" / "informe-demo.json"
RESERVAS = Path("/tmp") / f"harwiff-wifi-{os.getuid()}"


class DiagnosticoBloqueado(RuntimeError):
    pass


def adaptadores(sysfs=Path("/sys/class/net")):
    estados = {}
    for linea in nmcli("DEVICE,TYPE,STATE", "device", "status").splitlines():
        partes = linea.split(":", 2)
        if len(partes) == 3 and partes[1] == "wifi":
            estados[partes[0]] = partes[2] == "connected"
    retorno = []
    for nombre, activo in sorted(estados.items()):
        interfaz = sysfs / nombre
        if not interfaz.is_dir():
            continue
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


def normalizar_alcance(scope):
    if not isinstance(scope, dict) or any(
        not isinstance(scope.get(campo), list)
        for campo in ("allowedBssids", "allowedSsids", "allowedChannels")
    ):
        raise ValueError("El alcance tiene un formato inválido.")
    bssids, ssids, canales = (scope[campo] for campo in ("allowedBssids", "allowedSsids", "allowedChannels"))
    if not bssids and not ssids:
        raise ValueError("Define al menos un BSSID o SSID con /alcance set.")
    if any(not isinstance(bssid, str) or not BSSID.fullmatch(bssid) for bssid in bssids):
        raise ValueError("BSSID inválido. Usa seis pares hexadecimales separados por dos puntos.")
    if any(not isinstance(ssid, str) or not 1 <= len(ssid.encode("utf-8")) <= 32
           or re.search(r"[\x00-\x1f\x7f-\x9f]", ssid) for ssid in ssids):
        raise ValueError("Cada SSID debe ocupar entre 1 y 32 bytes, sin caracteres de control.")
    if any(type(canal) is not int or not 1 <= canal <= 233 for canal in canales):
        raise ValueError("Los canales deben ser enteros entre 1 y 233.")
    return {
        "allowedBssids": list(dict.fromkeys(bssid.upper() for bssid in bssids)),
        "allowedSsids": list(dict.fromkeys(ssids)),
        "allowedChannels": list(dict.fromkeys(canales)),
        "maxIterations": 8,
    }


def interfaces_salida():
    interfaces = set()
    try:
        for familia in ("-4", "-6"):
            salida = subprocess.run(["ip", "-j", familia, "route", "show", "table", "all", "default"],
                                    check=True, capture_output=True, text=True, timeout=3)
            rutas = json.loads(salida.stdout)
            if not isinstance(rutas, list):
                raise ValueError
            for ruta in rutas:
                if ruta.get("type", "unicast") in {"blackhole", "unreachable", "prohibit", "throw"}:
                    continue
                saltos = ruta.get("nexthops", [ruta])
                if not saltos or any(not isinstance(salto.get("dev"), str) or not salto["dev"] for salto in saltos):
                    raise ValueError
                interfaces.update(salto["dev"] for salto in saltos)
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, AttributeError) as error:
        raise RuntimeError("No se pudieron verificar las rutas por defecto IPv4 e IPv6.") from error
    return interfaces


@contextmanager
def reserva_adaptador(identificador, propietario=None):
    if not ID_ADAPTADOR.fullmatch(identificador):
        raise RuntimeError("Identidad de adaptador inválida.")
    try:
        RESERVAS.mkdir(mode=0o700, exist_ok=True)
        info = RESERVAS.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise OSError
        fd = os.open(RESERVAS / identificador, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise OSError
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                lectura = os.read(fd, 64).decode("ascii", errors="replace")
                ocupado = lectura if ID_EJECUCION.fullmatch(lectura) else "desconocido"
            else:
                ocupado = None
                os.ftruncate(fd, 0)
                if propietario:
                    os.write(fd, propietario.encode("ascii"))
        except BaseException:
            os.close(fd)
            raise
    except OSError as error:
        raise RuntimeError("No se pudo comprobar la reserva local del adaptador.") from error
    try:
        yield ocupado
    finally:
        if ocupado is None and propietario:
            with suppress(OSError):
                os.ftruncate(fd, 0)
        os.close(fd)


def fisicos():
    return [{"id": item["id"], "name": item["interfaz"], "mode": "sandbox",
             "tipo": item["tipo"], "activo": item["activo"]} for item in adaptadores()]


def buscar_adaptador(nombre, identificador):
    if (identificador == "mock") or (identificador is None and nombre == "mock"):
        return MOCK
    candidatos = [item for item in fisicos()
                  if (item["id"] == identificador if identificador is not None else item["name"] == nombre)]
    if len(candidatos) != 1:
        raise RuntimeError("El adaptador elegido no está disponible o es ambiguo. Usa /adaptador listar.")
    return candidatos[0]


def comprobar_fisico(adaptador, capacidades):
    interfaz = adaptador["name"]
    if interfaz in interfaces_salida():
        raise RuntimeError("El adaptador forma parte de una ruta por defecto del host.")
    capacidades.append("fuera-de-rutas-por-defecto")
    campos = dict(linea.split(":", 1) for linea in
                  nmcli("GENERAL.TYPE,GENERAL.STATE", "device", "show", interfaz).splitlines() if ":" in linea)
    estado = campos.get("GENERAL.STATE", "").split()
    if campos.get("GENERAL.TYPE") != "wifi" or not estado or not estado[0].isdigit() or int(estado[0]) < 30:
        raise RuntimeError("NetworkManager no puede leer el estado de un adaptador Wi-Fi disponible.")
    capacidades.append("lectura-networkmanager")
    if not docker("info", timeout=5):
        raise RuntimeError("Docker no está accesible para Harwiff.")
    capacidades.append("docker-disponible")


def informe_demo():
    try:
        informe = json.loads(DEMO.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RuntimeError("No se pudo leer el informe sintético incluido.") from error
    if not isinstance(informe, dict) or informe.get("esquema") != "wifi-diagnostico/v1" or informe.get("origen") != "demo":
        raise RuntimeError("El informe sintético incluido tiene un formato inválido.")
    return informe


def preflight_detalle(adapter_name, scope, adapter_id=None):
    capacidades = []
    adaptador = None
    normalizado = None
    errores = []
    try:
        normalizado = normalizar_alcance(scope)
        adaptador = {**buscar_adaptador(adapter_name, adapter_id), "lockedBySession": None}
        if adaptador["mode"] == "mock":
            informe_demo()
            capacidades.append("informe-sintetico")
        else:
            with reserva_adaptador(adaptador["id"]) as ocupado:
                adaptador["lockedBySession"] = ocupado
                if ocupado:
                    raise RuntimeError("El adaptador está ocupado por otra operación de Harwiff.")
                comprobar_fisico(adaptador, capacidades)
    except (RuntimeError, ValueError) as error:
        errores.append(str(error))
    return {"preflight": {"ok": not errores, "errors": errores, "capabilities": capacidades},
            "adapter": adaptador, "scope": normalizado}


def preflight(adapter_name, scope):
    return preflight_detalle(adapter_name, scope)["preflight"]


def inventario():
    dispositivos = [{**MOCK, "lockedBySession": None, "estado": "disponible"}]
    try:
        detectados = fisicos()
    except RuntimeError as error:
        return {"adaptadores": dispositivos, "aviso": str(error)}
    try:
        salidas = interfaces_salida() if detectados else set()
    except RuntimeError:
        salidas = None
    for adaptador in detectados:
        ocupado = None
        estado = "sin verificar"
        try:
            with reserva_adaptador(adaptador["id"]) as ocupado:
                if ocupado:
                    estado = "ocupado"
                elif salidas is not None:
                    estado = "ruta por defecto" if adaptador["name"] in salidas else "disponible"
        except RuntimeError:
            pass
        dispositivos.append({**adaptador, "lockedBySession": ocupado, "estado": estado})
    return {"adaptadores": dispositivos}


def asociacion_autorizada(interfaz, scope):
    try:
        asociacion = asociacion_actual(interfaz)
    except RuntimeError as error:
        raise DiagnosticoBloqueado("No se pudo verificar la asociación Wi-Fi actual.") from error
    if asociacion is None:
        raise DiagnosticoBloqueado("El adaptador no tiene una asociación Wi-Fi verificable.")
    bssid, ssid, canal, _ = asociacion
    if ((scope["allowedBssids"] and bssid not in scope["allowedBssids"])
            or (scope["allowedSsids"] and ssid not in [nombre.encode("utf-8") for nombre in scope["allowedSsids"]])
            or (scope["allowedChannels"] and canal not in scope["allowedChannels"])):
        raise DiagnosticoBloqueado("La asociación Wi-Fi actual está fuera del alcance autorizado.")
    return asociacion


def diagnostico_fisico(identificador, alcance, ejecucion, puerto):
    if not isinstance(ejecucion, str) or not ID_EJECUCION.fullmatch(ejecucion):
        raise DiagnosticoBloqueado("La ejecución no tiene un ID de auditoría válido.")
    with ExitStack() as recursos:
        try:
            scope = normalizar_alcance(alcance)
            adaptador = buscar_adaptador(None, identificador)
            if adaptador["mode"] != "sandbox":
                raise RuntimeError("Selecciona un adaptador físico para el diagnóstico real.")
            ocupado = recursos.enter_context(reserva_adaptador(adaptador["id"], ejecucion))
            if ocupado:
                raise RuntimeError("El adaptador está ocupado por otra operación de Harwiff.")
            comprobar_fisico(adaptador, [])
            interfaz = adaptador["name"]
            asociacion = asociacion_autorizada(interfaz, scope)
            muestra = recolectar(interfaz)
            if (not muestra["conectada"] or asociacion != asociacion_autorizada(interfaz, scope)
                    or buscar_adaptador(interfaz, identificador)["name"] != interfaz):
                raise DiagnosticoBloqueado("La asociación o el adaptador cambió durante la recolección.")
            if interfaz in interfaces_salida():
                raise DiagnosticoBloqueado("El adaptador pasó a formar parte de una ruta por defecto del host.")
        except (RuntimeError, ValueError) as error:
            raise DiagnosticoBloqueado(str(error)) from error
        with sandbox_administrado(puerto) as (dominio, clave):
            resultado = asyncio.run(analizar_aislado(
                muestra, False, dominio=dominio, clave=clave, imagen=IMAGEN,
            ))
        return {**resultado, "origen": "networkmanager"}
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
    parser.add_argument("operacion", choices=("adaptadores", "alcance", "preflight", "diagnostico", "demo",
                                              "estado", "bloquear-config", "broker-mock"))
    args = parser.parse_args()
    def interrumpir(_senal, _marco):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrumpir)
    try:
        if args.operacion == "adaptadores":
            resultado = inventario()
        elif args.operacion == "estado":
            resultado = {"docker": docker("info", timeout=4)}
        elif args.operacion == "demo":
            resultado = informe_demo()
        elif args.operacion == "bloquear-config":
            # Node conserva abierto el mismo descriptor hasta terminar la escritura.
            try:
                fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return 2
            resultado = {"ok": True}
        else:
            entrada = json.load(sys.stdin)
            if args.operacion == "alcance":
                resultado = normalizar_alcance(entrada)
            elif not isinstance(entrada, dict):
                raise ValueError("La operación requiere una solicitud JSON.")
            elif args.operacion == "preflight":
                resultado = preflight_detalle(entrada.get("name"), entrada.get("scope"), entrada.get("id"))
            elif args.operacion == "broker-mock":
                resultado = ejecutar_mock(entrada, normalizar_alcance)
            else:
                puerto = entrada.get("port", 0)
                if type(puerto) is not int or not 0 <= puerto <= 65535:
                    raise ValueError("Puerto inválido para OpenSandbox.")
                try:
                    informe = diagnostico_fisico(entrada.get("id"), entrada.get("scope"), entrada.get("runId"), puerto)
                    resultado = {"informe": informe}
                except DiagnosticoBloqueado as error:
                    resultado = {"bloqueado": str(error)}
        print(json.dumps(resultado, ensure_ascii=False, indent=2))
    except KeyboardInterrupt:
        return 130
    except (RuntimeError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1
    except Exception:
        print("No se pudo completar el diagnóstico en OpenSandbox.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
