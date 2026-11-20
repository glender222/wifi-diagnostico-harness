"""Consultas locales acotadas. Los identificadores del host no forman parte de la evidencia."""

import hashlib
import ipaddress
import json
import time
from functools import lru_cache
from pathlib import Path

import adaptador_core as core
from wifi import asociacion_actual, senal_dbm


@lru_cache(maxsize=None)
def validador(nombre):
    from jsonschema import Draft202012Validator

    ruta = Path(__file__).with_name("contratos") / "inspeccion.json"
    esquema = json.loads(ruta.read_text(encoding="utf-8"))
    esquema["$ref"] = f"#/$defs/{nombre}"
    return Draft202012Validator(esquema)


def resultado(estado, observaciones=(), motivos=()):
    return {
        "version": 1, "origin": "host_readonly", "status": estado,
        "observations": list(observaciones), "reasons": list(dict.fromkeys(motivos)),
    }


def observacion(sujeto, campo, fuente, valor, motivo="not_observed", alcance="host"):
    dato = {"subject": sujeto, "field": campo, "source": fuente, "scope": alcance, "value": valor}
    if valor is None:
        dato["reason"] = motivo
    return dato


def seleccionar(nombre):
    dispositivos = core.topologia(core.SYS, [])
    candidatos = [(d, p, i) for d in dispositivos for p in d["phys"] for i in p["interfaces"]
                  if i["ifname"] == nombre and i["ifindex"]]
    if len(candidatos) != 1:
        return None
    dispositivo, phy, interfaz = candidatos[0]
    ns = Path("/proc/self/ns/net").stat()
    arranque = Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()
    identidad = [arranque, ns.st_dev, ns.st_ino, dispositivo["deviceId"], phy["phyId"],
                 interfaz["interfaceId"], interfaz["ifindex"]]
    huella = hashlib.sha256(json.dumps(identidad).encode()).hexdigest()
    return huella, phy, interfaz


def vincular(entrada):
    nombre = entrada.get("name")
    if not isinstance(nombre, str) or not core.NOMBRE.fullmatch(nombre):
        return {"identity": None}
    seleccion = seleccionar(nombre)
    return {"identity": seleccion[0] if seleccion else None}


def inventario(broker_request, seleccionado, fin):
    perfil = core.inventario_perfil(limite=fin)
    if perfil["status"] == "unavailable":
        return resultado("unavailable", motivos=["source_unavailable"])
    radios = [(d, p) for d in perfil["devices"] for p in d["phys"]]
    phy_elegido = seleccionado[1]["phyId"] if seleccionado else None
    radios.sort(key=lambda par: (par[1]["phyId"] != phy_elegido, par[1]["phyId"]))
    cobertura = perfil["status"] == "complete"
    datos = [observacion("host", "radio_count", "sysfs", len(radios) if cobertura else None, "not_observed")]
    if seleccionado:
        datos.append(observacion("i1", "interface_phy", "sysfs", "p1"))
    for dispositivo, phy in radios[:3]:
        alias = "p1" if phy["phyId"] == phy_elegido else "p_" + hashlib.sha256(
            (broker_request["sessionId"] + phy["phyId"]).encode()).hexdigest()[:16]
        bus = dispositivo["bus"]
        datos.append(observacion(alias, "bus", "sysfs", None if bus == "unknown" else bus))
        for campo in ("monitor", "concurrency"):
            valor = phy["capabilities"][campo]["declared"]
            datos.append(observacion(alias, campo, "nl80211", None if valor == "unknown" else valor))
    if len(radios) > 3:
        return resultado("partial", datos, ["truncated"])
    return resultado("ok" if cobertura else "partial", datos)


def rutas(familia, interfaces, fin):
    try:
        salida = core.consultar(["ip", "-j", familia, "route", "show", "table", "all", "default"], fin)
        dependencias = core.rutas_por_defecto(salida)
        criticidad = core.conectividad(core.SYS, interfaces, dependencias)["criticality"]
        estado = {"critical": "direct", "noncritical": "none_observed"}.get(criticidad, "indeterminate")
        # El contador de expiración de una ruta RA puede variar sin cambiar su salida.
        firma = sorted(json.dumps({k: v for k, v in fila.items() if k != "expires"}, sort_keys=True)
                       for fila in json.loads(salida))
        return estado, None, firma
    except core.FuenteError as error:
        return None, error.codigo, None
    except (TypeError, ValueError, AttributeError):
        return None, "parse_unsupported", None


def direcciones(nombre, fin):
    try:
        salida = json.loads(core.consultar(["ip", "-j", "address", "show", "dev", nombre], fin))
        if len(salida) != 1 or salida[0]["ifname"] != nombre:
            return None, "identity_changed"
        configuradas = {4: False, 6: False}
        for fila in salida[0]["addr_info"]:
            ip = ipaddress.ip_address(fila["local"])
            if not (ip.is_link_local or ip.is_loopback or ip.is_unspecified):
                configuradas[ip.version] = True
        return configuradas, None
    except core.FuenteError as error:
        return None, error.codigo
    except (ValueError, KeyError, TypeError, IndexError):
        return None, "parse_unsupported"


def enlace(nombre, seleccionado, red, coincide, fin):
    _, phy, interfaz = seleccionado
    hermanas = {item["ifname"] for item in phy["interfaces"]}
    tomadas = {familia: rutas(familia, hermanas, fin) for familia in ("-4", "-6")}
    ips, motivo_ip = direcciones(nombre, fin)
    estado = interfaz["linkState"]
    datos = [
        observacion("i1", "interface_phy", "sysfs", "p1"),
        observacion("i1", "link_state", "sysfs", None if estado == "unknown" else estado),
    ]
    for version in (4, 6):
        datos.append(observacion("i1", f"ipv{version}_configured", "ip", ips[version] if ips else None, motivo_ip))
    if red:
        try:
            consulta = lambda *args: core.consultar(["nmcli", "--terse", "--escape", "no", "--fields", *args], fin)
            actual = asociacion_actual(nombre, consulta)
            if actual is None:
                motivo = "association_unknown"
            elif not coincide(actual, red):
                motivo = "network_scope_denied"
            else:
                senal = senal_dbm(nombre)
                posterior = asociacion_actual(nombre, consulta)
                motivo = None if actual == posterior else "unstable_snapshot"
        except core.FuenteError as error:
            motivo = error.codigo
        if motivo:
            datos.append(observacion("i1", "association", "nm_cache", None, motivo, "network"))
        else:
            datos.extend([
                observacion("i1", "association", "nm_cache", "associated", alcance="network"),
                observacion("i1", "frequency_mhz", "nm_cache", int(actual[3].split()[0]), alcance="network"),
                observacion("i1", "signal_dbm", "proc_wireless", senal, alcance="network"),
            ])
    for version in (4, 6):
        familia = f"-{version}"
        previo = tomadas[familia]
        posterior = rutas(familia, hermanas, fin)
        estable = previo == posterior
        datos.append(observacion("p1", f"ipv{version}_route", "ip",
                                 posterior[0] if estable else None,
                                 posterior[1] or ("unstable_snapshot" if not estable else "not_observed")))
    motivos = [dato["reason"] for dato in datos if dato["value"] is None]
    if not red:
        motivos.append("network_scope_required")
    return resultado("partial" if any(dato["value"] is None or dato["value"] == "indeterminate"
                                      for dato in datos) else "ok", datos, motivos)


def ejecutar_lectura(entrada, normalizar, coincide):
    if not validador("request").is_valid(entrada):
        return resultado("denied", motivos=["invalid_request"])
    fin = time.monotonic() + entrada["timeoutMs"] / 1000
    vinculo = entrada["binding"]
    red = entrada["network"]
    if red:
        try:
            normalizado = normalizar(red)
            if any(normalizado[campo] != valores for campo, valores in red.items()):
                return resultado("denied", motivos=["invalid_request"])
        except ValueError:
            return resultado("denied", motivos=["invalid_request"])

    seleccionado = seleccionar(vinculo["name"]) if vinculo else None
    if vinculo and (not seleccionado or seleccionado[0] != vinculo["identity"]):
        return resultado("denied", motivos=["identity_changed"])
    if entrada["operation"] == "consultar_adaptadores":
        salida = inventario(entrada, seleccionado, fin)
    else:
        salida = enlace(vinculo["name"], seleccionado, red, coincide, fin)
    if vinculo:
        actual = seleccionar(vinculo["name"])
        if not actual or actual[0] != vinculo["identity"]:
            return resultado("denied", motivos=["identity_changed"])
        if {i["ifname"] for i in seleccionado[1]["interfaces"]} != {i["ifname"] for i in actual[1]["interfaces"]}:
            return resultado("unavailable", motivos=["unstable_snapshot"])
    if time.monotonic() >= fin:
        return resultado("unavailable", motivos=["probe_timeout"])
    if not validador("result").is_valid(salida):
        return resultado("unavailable", motivos=["parse_unsupported"])
    return salida
