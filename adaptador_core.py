"""Inventario inalámbrico de Linux sin cambios de estado."""

import hashlib
import json
import os
import re
import selectors
import stat
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SYS = Path("/sys/class")
NOMBRE = re.compile(r"[A-Za-z0-9_.][A-Za-z0-9_.-]{0,14}")
PHY = re.compile(r"phy[0-9]+")
WIRELESS = Path(__file__).with_name("wireless_linux.py").resolve()
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
        "snapshot_incomplete": "La consulta terminó con datos incompletos o inconsistentes.",
        "attribute_missing": "El kernel o el driver no informó este dato.",
        "unsupported_attribute": "El perfil no puede representar este dato del kernel.",
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


def indice_sysfs(ruta):
    valor = texto(ruta)
    return int(valor) if valor and re.fullmatch(r"[0-9]{1,10}", valor) else None


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
    por_indice = {}
    if tipos:
        for phy in phys.values():
            indice = indice_sysfs(sysfs / "ieee80211" / phy["nameNow"] / "index")
            if indice is not None:
                por_indice[indice] = None if indice in por_indice else phy
    for entrada in entradas(sysfs / "net", NOMBRE, advertencias):
        enlace = resolver(entrada / "phy80211")
        nombre = entrada.name
        indice = indice_sysfs(entrada / "ifindex")
        phy = phys.get(enlace)
        tipo = tipos.get(nombre)
        if tipo:
            candidato = por_indice.get(tipo["phy"])
            if not candidato or tipo["index"] != indice or (enlace and candidato is not phy):
                advertir(advertencias, "ambiguous_interface", "nl80211_interface")
                tipo = None
            else:
                phy = candidato
        if phy is None:
            if enlace or nombre in nm:
                advertir(advertencias, "ambiguous_interface", "sysfs")
            continue
        try:
            observado = id_observado("net", entrada.resolve(strict=True))
        except (OSError, RuntimeError):
            advertir(advertencias, "adapter_disconnected", "sysfs")
            continue
        estado = texto(entrada / "operstate")
        nm_estado = nm.get(nombre)
        phy["interfaces"].append({
            "interfaceId": observado, "ifname": nombre, "ifindex": indice,
            "type": MODOS.get(tipo["mode"]) if tipo else None, "linkState": estado if estado in {"up", "down"} else "unknown",
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


MODOS = {
    1: "IBSS", 2: "managed", 3: "AP", 4: "AP/VLAN", 5: "WDS", 6: "monitor",
    7: "mesh point", 8: "P2P-client", 9: "P2P-GO", 10: "P2P-device",
    11: "outside context of a BSS", 12: "NAN",
}
BANDAS = {"0": "2.4GHz", "1": "5GHz", "2": "60GHz", "3": "6GHz", "4": "S1G"}
RESTRICCIONES = {
    2: "disabled", 3: "no-ir", 4: "no-ibss", 5: "dfs", 9: "no-ht40-minus",
    10: "no-ht40-plus", 11: "no-80mhz", 12: "no-160mhz", 14: "indoor-only",
    15: "ir-concurrent", 16: "no-20mhz", 17: "no-10mhz", 19: "no-he",
    26: "no-320mhz", 27: "no-eht", 29: "dfs-concurrent", 30: "no-6ghz-vlp-client",
    31: "no-6ghz-afc-client", 32: "can-monitor", 33: "allow-6ghz-vlp-ap",
    34: "allow-20mhz-activity",
}
FUENTES_NL = ("nl80211_interface", "nl80211_wiphy", "nl80211_reg")
ERRORES_NATIVOS = {
    "source_unavailable", "permission_denied", "probe_timeout", "parse_unsupported",
    "snapshot_incomplete", "adapter_disconnected",
}


def consultar_nativo(argumentos, limite):
    try:
        resultado = json.loads(consultar([sys.executable, "-I", "-B", str(WIRELESS), *argumentos], limite))
    except ValueError as error:
        raise FuenteError("parse_unsupported") from error
    if not isinstance(resultado, dict):
        raise FuenteError("parse_unsupported")
    return resultado


def leer_nl80211(avisos, limite):
    try:
        resultado = consultar_nativo(["inventory"], limite)
        datos, errores = resultado["data"], resultado["errors"]
        if not isinstance(datos, dict) or not isinstance(errores, dict):
            raise FuenteError("parse_unsupported")
    except (FuenteError, KeyError) as error:
        datos = {}
        errores = dict.fromkeys(FUENTES_NL, getattr(error, "codigo", "parse_unsupported"))
    for fuente in FUENTES_NL:
        if not isinstance(datos.get(fuente), list):
            codigo = errores.get(fuente)
            advertir(avisos, codigo if codigo in ERRORES_NATIVOS else "parse_unsupported", fuente)
            datos.pop(fuente, None)
    return datos


def tipos_interfaces(filas, avisos):
    candidatos = {}
    ambiguas = set()
    for fila in filas:
        nombre = fila["name"]
        if nombre in candidatos and candidatos[nombre] != fila:
            ambiguas.add(nombre)
        if fila["mode"] not in MODOS:
            advertir(avisos, "unsupported_attribute" if fila["mode"] is not None else "attribute_missing",
                     "nl80211_interface")
        candidatos[nombre] = fila
    if ambiguas:
        advertir(avisos, "ambiguous_interface", "nl80211_interface")
    return {nombre: fila for nombre, fila in candidatos.items() if nombre not in ambiguas}


def modos_nl(valores, avisos):
    if valores is None:
        advertir(avisos, "attribute_missing", "nl80211_wiphy")
        return None
    if any(modo not in MODOS for modo in valores):
        advertir(avisos, "unsupported_attribute", "nl80211_wiphy")
        return None
    return [MODOS[modo] for modo in sorted(set(valores))]


def numero_canal(banda, frecuencia, offset):
    if offset:
        return None
    if banda == "0":
        if frecuencia == 2484:
            return 14
        base, paso, minimo, maximo = 2407, 5, 2412, 2472
    elif banda == "1":
        base, paso, minimo, maximo = ((4000, 5, 4910, 4980) if frecuencia < 5000
                                      else (5000, 5, 5005, 5920))
    elif banda == "3":
        if frecuencia == 5935:
            return 2
        base, paso, minimo, maximo = 5950, 5, 5955, 7115
    elif banda == "2":
        base, paso, minimo, maximo = 56160, 2160, 58320, 69120
    else:
        return None
    return (frecuencia - base) // paso if minimo <= frecuencia <= maximo and (frecuencia - base) % paso == 0 else None


def canales_nl(bandas, avisos):
    canales = []
    for banda, frecuencias in bandas.items():
        for frecuencia, offset, atributos in frecuencias:
            canal = numero_canal(banda, frecuencia, offset)
            desconocida = any(atributo not in range(1, 35) for atributo in atributos)
            if canal is None or desconocida:
                advertir(avisos, "unsupported_attribute", "nl80211_wiphy")
            if offset or desconocida:
                # Este DTO no representa frecuencias fraccionarias ni restricciones futuras.
                continue
            canales.append({"frequencyMHz": frecuencia, "channel": canal,
                            "flags": [RESTRICCIONES[i] for i in sorted(set(atributos)) if i in RESTRICCIONES],
                            "source": "nl80211_wiphy"})
    return canales or None


def combinaciones_nl(items, avisos):
    if not items:
        advertir(avisos, "attribute_missing", "nl80211_wiphy")
        return None
    combinaciones = []
    for combo in items:
        if combo["unknown"] or not combo["max"] or not combo["channels"] or not combo["limits"]:
            advertir(avisos, "unsupported_attribute", "nl80211_wiphy")
            return None
        limites = []
        for limite in combo["limits"]:
            modos = modos_nl(limite["modes"], avisos)
            if not modos or not limite["max"] or limite["unknown"]:
                advertir(avisos, "unsupported_attribute", "nl80211_wiphy")
                return None
            limites.append({"modes": modos, "max": limite["max"]})
        combinaciones.append({"maxInterfaces": combo["max"], "maxDifferentChannels": combo["channels"],
                              "limits": limites, "requiresMatchingBeaconIntervals": combo["matchBeacon"]})
    return combinaciones


def capacidades_nl(radio, avisos):
    modos = software = bandas = canales = combinaciones = None
    if radio is not None:
        modos = modos_nl(radio.get("modes"), avisos)
        software = modos_nl(radio.get("softwareModes"), avisos)
        bandas = sorted({BANDAS[banda] for banda in radio["bands"] if banda in BANDAS}) or None
        if radio["bands"].keys() - BANDAS.keys():
            advertir(avisos, "unsupported_attribute", "nl80211_wiphy")
        if not radio["bands"] or any(not frecuencias for frecuencias in radio["bands"].values()):
            advertir(avisos, "attribute_missing", "nl80211_wiphy")
        canales = canales_nl(radio["bands"], avisos)
        combinaciones = combinaciones_nl(radio.get("combinations"), avisos)
    monitor = "unknown" if modos is None else "supported" if "monitor" in modos else "unsupported"
    return {
        "interfaceModes": modos or None, "softwareInterfaceModes": software or None,
        "bands": bandas, "channels": canales,
        "monitor": {"declared": monitor, "verified": "not_tested", "source": "nl80211_wiphy" if modos is not None else None},
        "injection": {"declared": "unknown", "verified": "not_tested", "source": None},
        "concurrency": {"declared": "supported" if combinaciones else "unknown", "verified": "not_tested",
                        "source": "nl80211_wiphy" if combinaciones else None},
        "interfaceCombinations": {"status": "known" if combinaciones else "unknown", "items": combinaciones},
    }


def paises_nl(registros, avisos):
    paises = {}
    ambiguos = set()
    for registro in registros:
        pais, indice = registro["country"], registro["phy"]
        if not pais or not re.fullmatch(r"[A-Z0-9]{2}", pais):
            advertir(avisos, "unsupported_attribute", "nl80211_reg")
            continue
        if paises.setdefault(indice, pais) != pais:
            ambiguos.add(indice)
    if ambiguos:
        advertir(avisos, "snapshot_incomplete", "nl80211_reg")
    return {indice: None if indice in ambiguos else pais for indice, pais in paises.items()}


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


def observar_identidad(prefijo, ruta):
    try:
        return id_observado(prefijo, ruta.resolve(strict=True))
    except (OSError, RuntimeError):
        return None


def enriquecer_firmware(sysfs, dispositivo, limite):
    phy, interfaz = next(((phy, interfaz) for phy in dispositivo["phys"] for interfaz in phy["interfaces"]
                          if interfaz["ifindex"]), (dispositivo["phys"][0], None))
    probe = phy["probe"]
    avisos = probe["warnings"]
    fuente = "ethtool_drvinfo"
    if interfaz is None:
        advertir(avisos, "attribute_missing", fuente)
    else:
        nombre, indice = interfaz["ifname"], interfaz["ifindex"]
        entrada = sysfs / "net" / nombre
        try:
            resultado = consultar_nativo(["driver-info", nombre, str(indice)], limite)
            if observar_identidad("net", entrada) != interfaz["interfaceId"] or indice_sysfs(entrada / "ifindex") != indice:
                raise FuenteError("adapter_disconnected")
            if "error" in resultado:
                codigo = resultado["error"]
                raise FuenteError(codigo if codigo in ERRORES_NATIVOS else "parse_unsupported")
            datos = resultado.get("data")
            if not isinstance(datos, dict):
                raise FuenteError("parse_unsupported")
            probe["sources"].append(fuente)
            for campo in ("driver", "firmware"):
                valor = datos.get(campo)
                if not valor or valor in {"N/A", "none"}:
                    if dispositivo[campo] is None:
                        advertir(avisos, "attribute_missing", fuente)
                elif not re.fullmatch(r"[0-9A-Za-z_.:+ -]{1,32}", valor):
                    advertir(avisos, "unsupported_attribute", fuente)
                elif dispositivo[campo] is None:
                    dispositivo[campo] = valor
        except FuenteError as error:
            advertir(avisos, error.codigo, fuente)
    if avisos:
        probe["status"] = "partial"


def perfil_dispositivo(sysfs, dispositivo, rutas, incompletas, nativo, ids_previos, reservas, locks, limite):
    radios = nativo.get("nl80211_wiphy", [])
    for phy in dispositivo["phys"]:
        avisos = []
        nombre = phy["nameNow"]
        entrada = sysfs / "ieee80211" / nombre
        indice = indice_sysfs(entrada / "index")
        interfaces = {interfaz["ifname"] for interfaz in phy["interfaces"]}
        conexion = conectividad(sysfs, interfaces, rutas, incompletas)
        phy["connectivity"] = conexion
        phy["rfkill"] = rfkill_del(sysfs, nombre, avisos)
        ides = {x["legacyAdapterId"] for x in phy["interfaces"] if x["legacyAdapterId"]}
        phy["reservation"] = {
            "state": reserva_observada(reservas, ides | {clave_phy(phy)}, locks),
            "source": "harwiff_local",
        }
        radio = None
        if ids_previos.get(nombre) != (phy["phyId"], indice) or observar_identidad("phy", entrada) != phy["phyId"]:
            advertir(avisos, "adapter_disconnected", "sysfs")
        elif "nl80211_wiphy" in nativo:
            candidatos = [dato for dato in radios if dato["index"] == indice and dato["name"] == nombre]
            if len(candidatos) == 1:
                radio = candidatos[0]
            else:
                advertir(avisos, "snapshot_incomplete", "nl80211_wiphy")
        phy["capabilities"] = capacidades_nl(radio, avisos)
        paises = nativo.get("paises", {})
        pais = None
        if radio is not None:
            pais = paises.get(indice, None if radio["selfManaged"] else paises.get(None))
        if pais is None and "nl80211_reg" in nativo:
            advertir(avisos, "attribute_missing", "nl80211_reg")
        phy["regulatory"] = {"country": pais, "source": "nl80211_reg" if pais else None}
        phy["operations"] = {
            "inspectCapabilities": {"implemented": True, "authorized": True, "availableNow": "yes", "reasons": []},
            "createMonitorInterface": {"implemented": False, "authorized": False, "availableNow": "no",
                                       "reasons": ["out_of_mvp_scope", *conexion["reasons"]]},
        }
        fuentes = ["sysfs"]
        if radio is not None:
            fuentes.append("nl80211_wiphy")
        if any(i["type"] is not None for i in phy["interfaces"]):
            fuentes.append("nl80211_interface")
        if pais:
            fuentes.append("nl80211_reg")
        if any(i["nmState"] in {"managed", "unmanaged"} for i in phy["interfaces"]):
            fuentes.append("nmcli")
        phy["probe"] = {"status": "partial" if avisos else "complete", "sources": fuentes, "warnings": avisos}
    enriquecer_firmware(sysfs, dispositivo, limite)


def inventario_perfil(sysfs=SYS, reservas=None, proc=Path("/proc/locks"), limite=None):
    avisos = []
    if limite is None:
        limite = time.monotonic() + 12
    if reservas is None:
        reservas = Path("/tmp") / f"harwiff-wifi-{os.getuid()}"
    nm = nm_estados(opcional(avisos, "nmcli", ["nmcli", "-t", "--escape", "no", "-f", "DEVICE,TYPE,STATE",
                                              "device", "status"], limite), avisos)
    ids_previos = {ruta.name: (observar_identidad("phy", ruta), indice_sysfs(ruta / "index"))
                   for ruta in entradas(sysfs / "ieee80211", PHY, avisos, opcional=True)}
    ids_net = ({ruta.name: observar_identidad("net", ruta)
                for ruta in entradas(sysfs / "net", NOMBRE, avisos)} if ids_previos else {})
    nativo = leer_nl80211(avisos, limite) if ids_previos else {}
    nativo["paises"] = paises_nl(nativo.get("nl80211_reg", []), avisos)
    indices_vigentes = {
        indice for nombre, (identidad, indice) in ids_previos.items()
        if identidad and observar_identidad("phy", sysfs / "ieee80211" / nombre) == identidad
        and indice_sysfs(sysfs / "ieee80211" / nombre / "index") == indice
    }
    tipos = tipos_interfaces(nativo.get("nl80211_interface", []), avisos)
    for nombre, datos in list(tipos.items()):
        if (datos["phy"] not in indices_vigentes or not ids_net.get(nombre)
                or ids_net[nombre] != observar_identidad("net", sysfs / "net" / nombre)):
            advertir(avisos, "adapter_disconnected", "nl80211_interface")
            del tipos[nombre]
    dispositivos = topologia(sysfs, avisos, nm, tipos)
    if dispositivos:
        rutas, incompletas = consultar_rutas(avisos, limite)
        locks = observar_reservas(reservas, proc)
        for dispositivo in dispositivos:
            perfil_dispositivo(sysfs, dispositivo, rutas, incompletas, nativo, ids_previos, reservas, locks, limite)
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
