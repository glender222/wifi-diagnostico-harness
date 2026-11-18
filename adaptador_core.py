"""Inventario inalámbrico de Linux sin cambios de estado."""

import hashlib
import os
import re
import selectors
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

SYS = Path("/sys/class")
NOMBRE = re.compile(r"[A-Za-z0-9_.][A-Za-z0-9_.-]{0,14}")
PHY = re.compile(r"phy[0-9]+")
LIMITE_SALIDA = 256 * 1024


class FuenteError(Exception):
    def __init__(self, codigo):
        self.codigo = codigo


def aviso(codigo, fuente):
    mensajes = {
        "source_unavailable": "Fuente no disponible.",
        "permission_denied": "Permisos insuficientes para consultar la fuente.",
        "probe_timeout": "La consulta superó el tiempo disponible.",
        "parse_unsupported": "La salida de la fuente no pudo interpretarse.",
        "adapter_disconnected": "El dispositivo o la interfaz cambió durante la consulta.",
        "ambiguous_interface": "La interfaz no tiene una asociación inequívoca.",
    }
    return {"code": codigo, "source": fuente, "message": mensajes[codigo]}


def consultar(argumentos, limite):
    restante = min(limite - time.monotonic(), 2)
    if restante <= 0:
        raise FuenteError("probe_timeout")
    fin = time.monotonic() + restante
    try:
        proceso = subprocess.Popen(argumentos, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, env={**os.environ, "LC_ALL": "C"})
    except PermissionError as error:
        raise FuenteError("permission_denied") from error
    except OSError as error:
        raise FuenteError("source_unavailable") from error
    try:
        salida = bytearray()
        with selectors.DefaultSelector() as espera:
            espera.register(proceso.stdout, selectors.EVENT_READ)
            while True:
                if not espera.select(max(0, fin - time.monotonic())):
                    raise FuenteError("probe_timeout")
                bloque = os.read(proceso.stdout.fileno(), 8192)
                if not bloque:
                    break
                salida.extend(bloque)
                if len(salida) > LIMITE_SALIDA:
                    raise FuenteError("parse_unsupported")
        if proceso.wait(timeout=max(0, fin - time.monotonic())) != 0:
            raise FuenteError("source_unavailable")
        return salida.decode("utf-8", errors="replace")
    except subprocess.TimeoutExpired as error:
        raise FuenteError("probe_timeout") from error
    finally:
        proceso.stdout.close()
        if proceso.poll() is None:
            proceso.kill()
        proceso.wait()


def opcional(avisos, fuente, argumentos, limite):
    try:
        return consultar(argumentos, limite)
    except FuenteError as error:
        advertir(avisos, error.codigo, fuente)
        return None


def advertir(avisos, codigo, fuente):
    entrada = aviso(codigo, fuente)
    if entrada not in avisos:
        avisos.append(entrada)


def resolver(ruta):
    try:
        return ruta.resolve(strict=True)
    except (OSError, RuntimeError):
        return None


def texto(ruta):
    try:
        with ruta.open(encoding="utf-8") as archivo:
            return archivo.read(128).strip()
    except (OSError, ValueError):
        return None


def entradas(ruta, patron, advertencias, opcional=False):
    try:
        return sorted(x for x in ruta.iterdir() if patron.fullmatch(x.name))
    except OSError as error:
        if not opcional or not isinstance(error, FileNotFoundError):
            advertir(advertencias, "permission_denied" if isinstance(error, PermissionError)
                     else "source_unavailable", f"sysfs/{ruta.name}")
        return []


def identidad_heredada(interfaz):
    origen = resolver(interfaz / "device") or resolver(interfaz)
    return hashlib.sha256(str(origen).encode()).hexdigest()[:20] if origen else None


def id_observado(prefijo, ruta):
    info = ruta.stat()
    huella = f"{ruta}:{info.st_dev}:{info.st_ino}"
    return prefijo + "_" + hashlib.sha256(huella.encode()).hexdigest()[:24]


def bus_del(dispositivo):
    for ruta in (dispositivo, *dispositivo.parents):
        subsistema = resolver(ruta / "subsystem")
        if subsistema and subsistema.name in {"usb", "pci", "sdio", "platform"}:
            return subsistema.name
    return "virtual" if "virtual" in dispositivo.parts else "unknown"


def nm_estados(salida, advertencias):
    estados = {}
    if salida is None:
        return estados
    for linea in salida.splitlines():
        campos = linea.split(":", 2)
        if len(campos) != 3:
            advertir(advertencias, "parse_unsupported", "nmcli")
            continue
        nombre, tipo, estado = campos
        if tipo == "wifi" and NOMBRE.fullmatch(nombre):
            estados[nombre] = estado
    return estados


def topologia(sysfs, advertencias, nm=None, tipos=None):
    nm = nm or {}
    tipos = tipos or {}
    dispositivos = {}
    phys = {}
    for entrada in entradas(sysfs / "ieee80211", PHY, advertencias, opcional=True):
        try:
            ruta = entrada.resolve(strict=True)
            dispositivo = resolver(entrada / "device") or ruta
            driver = resolver(dispositivo / "driver")
            device_id = id_observado("dev", dispositivo)
            phy = {"phyId": id_observado("phy", ruta), "nameNow": entrada.name, "interfaces": []}
            entidad = dispositivos.setdefault(device_id, {
                "deviceId": device_id, "bus": bus_del(dispositivo),
                "driver": driver.name if driver and NOMBRE.fullmatch(driver.name) else None,
                "firmware": None, "chipset": None, "phys": [],
            })
            entidad["phys"].append(phy)
            phys[ruta] = phy
        except (OSError, RuntimeError):
            advertir(advertencias, "adapter_disconnected", "sysfs")
    por_nombre = {phy["nameNow"]: phy for phy in phys.values()}
    for entrada in entradas(sysfs / "net", NOMBRE, advertencias):
        enlace = resolver(entrada / "phy80211")
        nombre = entrada.name
        tipo_iw, nombre_phy = tipos.get(nombre, (None, None))
        phy = phys.get(enlace) if enlace else por_nombre.get(nombre_phy)
        if enlace and nombre_phy and (not phy or phy["nameNow"] != nombre_phy):
            advertir(advertencias, "ambiguous_interface", "sysfs")
            continue
        if phy is None:
            if enlace or nombre_phy or nombre in nm:
                advertir(advertencias, "ambiguous_interface", "sysfs")
            continue
        try:
            observado = id_observado("net", entrada.resolve(strict=True))
        except (OSError, RuntimeError):
            advertir(advertencias, "adapter_disconnected", "sysfs")
            continue
        indice = texto(entrada / "ifindex")
        estado = texto(entrada / "operstate")
        nm_estado = nm.get(nombre)
        phy["interfaces"].append({
            "interfaceId": observado, "ifname": nombre, "ifindex": int(indice) if indice and indice.isascii() and indice.isdigit() else None,
            "type": tipo_iw, "linkState": estado if estado in {"up", "down"} else "unknown",
            "nmState": ("unmanaged" if nm_estado == "unmanaged" else
                        "managed" if nm_estado in {"connected", "disconnected", "connecting"} else
                        "unavailable" if nm_estado in {None, "unavailable"} else "unknown"),
            "connected": True if nm_estado == "connected" else False if nm_estado == "disconnected" else None,
            "legacyAdapterId": identidad_heredada(entrada),
        })
    for entidad in dispositivos.values():
        ids = {interfaz["legacyAdapterId"] for phy in entidad["phys"] for interfaz in phy["interfaces"]}
        entidad["legacyAdapterId"] = next(iter(ids)) if len(ids) == 1 else None
    return list(dispositivos.values())


def inventario_perfil(sysfs=SYS):
    avisos = []
    limite = time.monotonic() + 12
    nm = nm_estados(opcional(avisos, "nmcli", ["nmcli", "-t", "--escape", "no", "-f", "DEVICE,TYPE,STATE",
                                              "device", "status"], limite), avisos)
    dispositivos = topologia(sysfs, avisos, nm)
    no_disponible = any(x["source"] == "sysfs/ieee80211" for x in avisos)
    return {
        "schema": "harwiff-adapter-inventory/v1",
        "observedAt": datetime.now(timezone.utc).isoformat(),
        "status": "unavailable" if no_disponible and not dispositivos else "partial" if avisos else "complete",
        "warnings": avisos,
        "devices": dispositivos,
        "mock": {"id": "mock", "mode": "mock", "label": "Simulado"},
    }
