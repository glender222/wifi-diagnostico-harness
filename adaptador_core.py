"""Inventario inalámbrico de Linux sin cambios de estado."""

import hashlib
import json
import os
import re
import selectors
import stat
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
                restante = fin - time.monotonic()
                if restante <= 0 or not espera.select(restante):
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


MODOS = {"AP", "AP/VLAN", "managed", "monitor", "IBSS", "WDS", "mesh point", "P2P-client",
         "P2P-GO", "P2P-device", "outside context of a BSS", "NAN"}
LIMITE_MODO = r"#\{\s*([^}]+)\s*\}\s*<=\s*(\d+)"
LIMITE_PHY = re.compile(r"total\s*<=\s*(\d+),\s*#channels\s*<=\s*(\d+)(?:,\s*(STA/AP BI must match))?")


def iw_interfaces(salida, avisos):
    tipos = {}
    radio = nombre = None
    for linea in (salida or "").splitlines():
        linea = linea.strip()
        if coincidencia := re.fullmatch(r"phy#(\d+)", linea):
            radio, nombre = "phy" + coincidencia[1], None
        elif linea.startswith("Interface "):
            candidato = linea.removeprefix("Interface ")
            nombre = candidato if NOMBRE.fullmatch(candidato) else None
        elif nombre and radio and linea.startswith("type "):
            modo = linea.removeprefix("type ")
            if nombre in tipos and tipos[nombre][1] != radio:
                advertir(avisos, "ambiguous_interface", "iw_dev")
                tipos[nombre] = (None, "")
            else:
                tipos[nombre] = (modo if modo in MODOS else None, radio)
    if salida and not tipos and not re.search(r"(?m)^phy#\d+\s*$", salida):
        advertir(avisos, "parse_unsupported", "iw_dev")
    return tipos


def combinacion(linea):
    partes = re.split(r",\s*(?=#\{|total\s*<=)", linea.lstrip("* "))
    total = LIMITE_PHY.fullmatch(partes[-1])
    if not total or len(partes) < 2:
        return None
    limites = []
    for grupo in partes[:-1]:
        limite = re.fullmatch(LIMITE_MODO, grupo)
        if not limite:
            return None
        modos = [modo.strip() for modo in limite[1].split(",")]
        if not set(modos) <= MODOS:
            return None
        limites.append({"modes": modos, "max": int(limite[2])})
    return {"maxInterfaces": int(total[1]), "maxDifferentChannels": int(total[2]),
            "limits": limites, "requiresMatchingBeaconIntervals": bool(total[3])}


def bloque_iw(salida, titulo):
    lineas = []
    sangria = None
    for linea in salida.splitlines():
        ancho = len(linea.expandtabs()) - len(linea.lstrip().expandtabs())
        if linea.strip() == titulo:
            sangria = ancho
        elif sangria is not None and linea.strip():
            if ancho <= sangria:
                break
            lineas.append(linea.strip())
    return lineas


def capacidades_iw(salida, avisos):
    salida = salida or ""
    modos = bloque_iw(salida, "Supported interface modes:")
    software = bloque_iw(salida, "software interface modes (can always be added):")
    declarados = [modo[2:] for modo in modos if modo.startswith("* ") and modo[2:] in MODOS]
    software = [modo[2:] for modo in software if modo.startswith("* ") and modo[2:] in MODOS]
    canales = []
    for linea in salida.splitlines():
        if coincidencia := re.fullmatch(r"\s*\* (\d{4,5}) MHz \[(\d{1,4})\](.*)", linea):
            mhz, numero, restricciones = coincidencia.groups()
            flags = [flag for flag, patron in (("disabled", r"\bdisabled\b"), ("no-ir", r"\bno IR\b"),
                                                ("dfs", r"radar detection"))
                     if re.search(patron, restricciones, re.IGNORECASE)]
            canales.append({"frequencyMHz": int(mhz), "channel": int(numero), "flags": flags, "source": "iw_phy"})
    bandas = set()
    for canal in canales:
        mhz = canal["frequencyMHz"]
        for nombre, minimo, maximo in (("2.4GHz", 2400, 2500), ("5GHz", 4900, 5925),
                                       ("6GHz", 5925, 7126), ("60GHz", 57000, 71000)):
            if minimo <= mhz < maximo:
                bandas.add(nombre)
    combinaciones = []
    for linea in bloque_iw(salida, "valid interface combinations:"):
        if linea.startswith("* "):
            combinaciones.append(linea)
        elif combinaciones:
            combinaciones[-1] += " " + linea
    items = [combinacion(linea) for linea in combinaciones]
    conocidas = bool(items) and all(items)
    modos_completos = bool(modos) and len(modos) == len(declarados)
    if salida and (not declarados or not modos_completos or (items and not conocidas)):
        advertir(avisos, "parse_unsupported", "iw_phy")
    monitor = "supported" if "monitor" in declarados else "unsupported" if modos_completos else "unknown"
    return {
        "interfaceModes": declarados or None, "softwareInterfaceModes": software or None,
        "bands": sorted(bandas) or None, "channels": canales or None,
        "monitor": {"declared": monitor, "verified": "not_tested", "source": "iw_phy" if modos else None},
        "injection": {"declared": "unknown", "verified": "not_tested", "source": None},
        "concurrency": {"declared": "supported" if conocidas else "unknown", "verified": "not_tested",
                        "source": "iw_phy" if conocidas else None},
        "interfaceCombinations": {"status": "known" if conocidas else "unknown", "items": items if conocidas else None},
    }


def regulacion_iw(salida, avisos):
    paises = {}
    seccion = None
    for linea in (salida or "").splitlines():
        if linea == "global":
            seccion = "global"
        elif radio := re.fullmatch(r"phy#(\d+)(?: \(self-managed\))?", linea):
            seccion = "phy" + radio[1]
        elif seccion and (pais := re.fullmatch(r"country ([A-Z0-9]{2}):.*", linea)):
            paises[seccion] = pais[1]
    if salida and not paises:
        advertir(avisos, "parse_unsupported", "iw_reg")
    return paises


def rutas_por_defecto(salida):
    rutas = json.loads(salida)
    if not isinstance(rutas, list):
        raise ValueError
    interfaces = set()
    for ruta in rutas:
        if ruta.get("type", "unicast") in {"blackhole", "unreachable", "prohibit", "throw"}:
            continue
        saltos = ruta.get("nexthops", [ruta])
        if not saltos or ruta.get("encap") or any(
            salto.get("encap") or not isinstance(salto.get("dev"), str) or not NOMBRE.fullmatch(salto["dev"])
            for salto in saltos
        ):
            raise ValueError
        interfaces.update(salto["dev"] for salto in saltos)
    return interfaces


def consultar_rutas(avisos, limite):
    rutas = set()
    incompletas = False
    for familia in ("-4", "-6"):
        fuente = "ip" + familia
        salida = opcional(avisos, fuente, ["ip", "-j", familia, "route", "show", "table", "all", "default"], limite)
        try:
            if salida is not None:
                rutas.update(rutas_por_defecto(salida))
            else:
                incompletas = True
        except (ValueError, TypeError, AttributeError):
            incompletas = True
            advertir(avisos, "parse_unsupported", fuente)
    return rutas, incompletas


def conectividad(sysfs, interfaces, rutas, incompletas=False):
    if interfaces & rutas:
        return {"criticality": "critical", "reasons": ["default_route_interface"], "source": "ip"}
    if incompletas:
        return {"criticality": "unknown", "reasons": ["default_routes_indeterminate"], "source": "ip"}
    for nombre in rutas:
        enlace = sysfs / "net" / nombre
        indice = texto(enlace / "ifindex")
        clase = texto(enlace / "type")
        if (not indice or indice != texto(enlace / "iflink") or clase != "1"
                or not resolver(enlace / "device") or (enlace / "master").is_symlink()
                or any(enlace.glob("lower_*"))):
            return {"criticality": "potentially_critical", "reasons": ["unresolved_default_route_dependency"],
                    "source": "ip+sysfs"}
        if ((enlace / "wireless").is_dir() or "DEVTYPE=wlan" in (texto(enlace / "uevent") or "").splitlines()
                or (enlace / "phy80211").is_symlink()) and not resolver(enlace / "phy80211"):
            return {"criticality": "potentially_critical", "reasons": ["unresolved_default_route_dependency"],
                    "source": "ip+sysfs"}
    return {"criticality": "noncritical", "reasons": [], "source": "ip+sysfs"}


def rfkill_del(sysfs, phy, avisos):
    observados = []
    for entrada in entradas(sysfs / "rfkill", re.compile(r"rfkill[0-9]+"), avisos):
        if texto(entrada / "type") == "wlan" and texto(entrada / "name") == phy:
            observados.append([texto(entrada / estado) for estado in ("soft", "hard")])
    bloqueos = {}
    for indice, campo in enumerate(("softBlocked", "hardBlocked")):
        valores = [estados[indice] for estados in observados]
        bloqueos[campo] = True if "1" in valores else False if valores and set(valores) == {"0"} else None
    return {**bloqueos, "source": "sysfs/rfkill" if observados else None}


def clave_phy(phy):
    return phy["phyId"].removeprefix("phy_")[:20]


def observar_reservas(directorio, proc=Path("/proc/locks")):
    """Observar la coordinación de Harwiff sin probar flock ni escribir archivos."""
    try:
        info = directorio.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            return None
    except FileNotFoundError:
        return set()
    except OSError:
        return None
    try:
        with proc.open(encoding="ascii") as archivo:
            contenido = archivo.read(LIMITE_SALIDA + 1)
        if len(contenido) > LIMITE_SALIDA:
            return None
        locks = set()
        for linea in contenido.splitlines():
            if " FLOCK " not in linea:
                continue
            # Las reservas en espera se indican con "->".
            partes = linea.split()
            if partes[1] == "->":
                continue
            mayor, menor, nodo = partes[5].split(":")
            locks.add((int(mayor, 16), int(menor, 16), int(nodo)))
        return locks
    except (OSError, ValueError, IndexError):
        return None


def reserva_observada(directorio, claves, locks):
    if locks is None:
        return "unknown"
    try:
        for clave in claves:
            try:
                info = (directorio / clave).lstat()
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                return "unknown"
            if (os.major(info.st_dev), os.minor(info.st_dev), info.st_ino) in locks:
                return "leased"
    except OSError:
        return "unknown"
    return "free"


def perfil_dispositivo(sysfs, dispositivo, rutas, incompletas, paises, reservas, locks, limite):
    for phy in dispositivo["phys"]:
        avisos = []
        nombre = phy["nameNow"]
        interfaces = {interfaz["ifname"] for interfaz in phy["interfaces"]}
        conexion = conectividad(sysfs, interfaces, rutas, incompletas)
        phy["connectivity"] = conexion
        rfkill = rfkill_del(sysfs, nombre, avisos)
        phy["rfkill"] = rfkill
        ides = {x["legacyAdapterId"] for x in phy["interfaces"] if x["legacyAdapterId"]}
        phy["reservation"] = {
            "state": reserva_observada(reservas, ides | {clave_phy(phy)}, locks),
            "source": "harwiff_local",
        }
        iw = opcional(avisos, "iw_phy", ["iw", "phy", nombre, "info"], limite)
        phy["capabilities"] = capacidades_iw(iw, avisos)
        phy["regulatory"] = {"country": paises.get(nombre, paises.get("global")),
                             "source": "iw_reg" if nombre in paises or "global" in paises else None}
        phy["operations"] = {
            "inspectCapabilities": {"implemented": True, "authorized": True, "availableNow": "yes", "reasons": []},
            "createMonitorInterface": {"implemented": False, "authorized": False, "availableNow": "no",
                                       "reasons": ["out_of_mvp_scope", *conexion["reasons"]]},
        }
        fuentes = ["sysfs"]
        if iw is not None:
            fuentes.append("iw_phy")
        if any(i["nmState"] in {"managed", "unmanaged"} for i in phy["interfaces"]):
            fuentes.append("nmcli")
        if not resolver(sysfs / "ieee80211" / nombre):
            advertir(avisos, "adapter_disconnected", "sysfs")
        phy["probe"] = {"status": "partial" if avisos else "complete", "sources": fuentes, "warnings": avisos}
    if interfaz := next((i for phy in dispositivo["phys"] for i in phy["interfaces"]), None):
        avisos = dispositivo["phys"][0]["probe"]["warnings"]
        salida = opcional(avisos, "ethtool", ["ethtool", "-i", interfaz["ifname"]], limite)
        if salida:
            for campo, etiqueta in (("driver", "driver"), ("firmware", "firmware-version")):
                valor = re.search(rf"(?m)^{etiqueta}: ([0-9A-Za-z_.:+ -]{{1,100}})$", salida)
                if valor and valor[1] not in {"N/A", "none"} and dispositivo[campo] is None:
                    dispositivo[campo] = valor[1]
        if avisos:
            dispositivo["phys"][0]["probe"]["status"] = "partial"


def inventario_perfil(sysfs=SYS, reservas=None, proc=Path("/proc/locks")):
    avisos = []
    limite = time.monotonic() + 12
    if reservas is None:
        reservas = Path("/tmp") / f"harwiff-wifi-{os.getuid()}"
    nm = nm_estados(opcional(avisos, "nmcli", ["nmcli", "-t", "--escape", "no", "-f", "DEVICE,TYPE,STATE",
                                              "device", "status"], limite), avisos)
    tipos = iw_interfaces(opcional(avisos, "iw_dev", ["iw", "dev"], limite), avisos)
    dispositivos = topologia(sysfs, avisos, nm, tipos)
    if dispositivos:
        rutas, incompletas = consultar_rutas(avisos, limite)
        paises = regulacion_iw(opcional(avisos, "iw_reg", ["iw", "reg", "get"], limite), avisos)
        locks = observar_reservas(reservas, proc)
        for dispositivo in dispositivos:
            perfil_dispositivo(sysfs, dispositivo, rutas, incompletas, paises, reservas, locks, limite)
    no_disponible = any(x["source"] == "sysfs/ieee80211" for x in avisos)
    parcial = avisos or any(phy["probe"]["warnings"] for d in dispositivos for phy in d["phys"])
    return {
        "schema": "harwiff-adapter-inventory/v1",
        "observedAt": datetime.now(timezone.utc).isoformat(),
        "status": "unavailable" if no_disponible and not dispositivos else "partial" if parcial else "complete",
        "warnings": avisos,
        "devices": dispositivos,
        "mock": {"id": "mock", "mode": "mock", "label": "Simulado"},
    }
