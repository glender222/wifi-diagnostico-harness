import errno
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from adaptador_core import FuenteError, WIRELESS, consultar, identidad_heredada, inventario_perfil, topologia
import wireless_linux as nl
from entorno import (DiagnosticoBloqueado, adaptadores, diagnostico_fisico, informe_demo,
                     inventario, preflight, preflight_detalle, reserva_adaptador)
from wifi import asociacion_actual

FISICO = {"id": "a" * 20, "interfaz": "wlan1", "tipo": "usb", "activo": False}
EJECUCION = "1234567890123-00000000-0000-0000-0000-000000000001"
ALCANCE = {"allowedBssids": ["AA:BB:CC:11:22:33"], "allowedSsids": ["Área: pruebas"], "allowedChannels": [6]}
ASOCIACION = ("AA:BB:CC:11:22:33", "Área: pruebas".encode(), 6, "2437 MHz")


class InventarioTest(unittest.TestCase):
    def test_usb_integrado_renombre_desconexion(self):
        with tempfile.TemporaryDirectory() as dirname:
            raiz = Path(dirname)
            sysfs = raiz / "net"
            sysfs.mkdir()
            usb = raiz / "devices" / "usb" / "1-2"
            pci = raiz / "devices" / "pci" / "0000"
            for tipo, ruta in [("usb", usb), ("pci", pci)]:
                ruta.mkdir(parents=True)
                bus = raiz / "bus" / tipo
                bus.mkdir(parents=True)
                (ruta / "subsystem").symlink_to(bus)
            for interfaz, fisico in [("wlanusb", usb), ("wlan0", pci)]:
                (sysfs / interfaz).mkdir()
                (sysfs / interfaz / "device").symlink_to(fisico)
            with patch("entorno.nmcli", return_value="wlanusb:wifi:disconnected\nwlan0:wifi:connected"):
                inicial = adaptadores(sysfs)
            self.assertEqual([(x["tipo"], x["activo"]) for x in inicial], [("integrado", True), ("usb", False)])
            os.rename(sysfs / "wlanusb", sysfs / "wlanprimero")
            with patch("entorno.nmcli", return_value="wlanprimero:wifi:disconnected"):
                self.assertEqual(adaptadores(sysfs)[0]["id"], inicial[1]["id"])
            with patch("entorno.nmcli", return_value="wlan0:wifi:connected"):
                self.assertNotIn(inicial[1]["id"], [x["id"] for x in adaptadores(sysfs)])

    def test_asociacion_usa_cache_y_preserva_bytes_ssid(self):
        ssid_hex = ASOCIACION[1].hex()
        salida = f":426172:11:2462 MHz:00:00:00:00:00:00\n*:{ssid_hex}:6:2437 MHz:aa:bb:cc:11:22:33"
        with patch("wifi.nmcli", return_value=salida) as nmcli:
            self.assertEqual(asociacion_actual("wlan1"), ASOCIACION)
        nmcli.assert_called_once_with("IN-USE,SSID-HEX,CHAN,FREQ,BSSID", "device", "wifi", "list",
                                      "ifname", "wlan1", "--rescan", "no")
        with patch("wifi.nmcli", return_value=salida + "\n" + salida):
            self.assertIsNone(asociacion_actual("wlan1"))


def sys_fixture(raiz, radios):
    sysfs = raiz / "class"
    for clase in ("ieee80211", "net", "rfkill"):
        (sysfs / clase).mkdir(parents=True)
    for dispositivo, phy, interfaces in radios:
        fisico = raiz / "devices" / dispositivo
        radio = fisico / "ieee80211" / phy
        radio.mkdir(parents=True)
        (radio / "device").symlink_to(fisico)
        (radio / "index").write_text(phy.removeprefix("phy"))
        (sysfs / "ieee80211" / phy).symlink_to(radio)
        if not (fisico / "subsystem").exists():
            bus = raiz / ("usb" if dispositivo.startswith("usb") else "pci")
            bus.mkdir(exist_ok=True)
            (fisico / "subsystem").symlink_to(bus)
        for nombre, indice in interfaces:
            interfaz = sysfs / "net" / nombre
            interfaz.mkdir()
            (interfaz / "device").symlink_to(fisico)
            (interfaz / "phy80211").symlink_to(radio)
            (interfaz / "ifindex").write_text(str(indice))
            (interfaz / "iflink").write_text(str(indice))
            (interfaz / "operstate").write_text("up")
    return sysfs


class PerfilTest(unittest.TestCase):
    def test_agrupa_dispositivos_phys_e_interfaces_sin_nm(self):
        with tempfile.TemporaryDirectory() as directorio:
            sysfs = sys_fixture(Path(directorio), [
                ("pci0", "phy0", [("wlan0", 2), ("wlan1", 3)]),
                ("pci0", "phy1", []),
                ("pci1", "phy2", [("wlan2", 4)]),
            ])
            with patch("adaptador_core.consultar", side_effect=FuenteError("source_unavailable")):
                dto = inventario_perfil(sysfs)
                self.assertEqual(dto["schema"], "harwiff-adapter-inventory/v1")
                self.assertEqual(dto["status"], "partial")
                self.assertEqual(dto["mock"]["id"], "mock")
                uno, dos = dto["devices"]
                self.assertNotEqual(uno["deviceId"], dos["deviceId"])
                self.assertEqual(uno["bus"], "pci")
                self.assertEqual([len(phy["interfaces"]) for phy in uno["phys"]], [2, 0])
                interfaz = uno["phys"][0]["interfaces"][0]
                self.assertEqual((interfaz["ifname"], interfaz["ifindex"], interfaz["nmState"]),
                                 ("wlan0", 2, "unavailable"))
                self.assertEqual(interfaz["legacyAdapterId"], uno["legacyAdapterId"])
                self.assertNotEqual(interfaz["interfaceId"], uno["legacyAdapterId"])
                self.assertNotIn(directorio, json.dumps(dto))
                os.rename(sysfs / "net" / "wlan0", sysfs / "net" / "wlan3")
                os.rename(sysfs / "ieee80211" / "phy2", sysfs / "ieee80211" / "phy4")
                (sysfs / "ieee80211" / "phy4").unlink()
                (sysfs / "ieee80211" / "phy2").symlink_to(Path(directorio) / "desconectado")
                nuevo = inventario_perfil(sysfs)
                self.assertEqual(len(nuevo["devices"]), 1)
                self.assertEqual(nuevo["devices"][0]["legacyAdapterId"], uno["legacyAdapterId"])
                self.assertIn("adapter_disconnected", {aviso["code"] for aviso in nuevo["warnings"]})


    def test_fuentes_declaradas_regulacion_y_reserva_solo_lectura(self):
        radio = {"index": 0, "name": "phy0", "selfManaged": False, "modes": [2, 6], "softwareModes": [6],
                 "bands": {"0": [[2412, 0, [1, 3]]], "1": [[5260, 0, [1, 5]], [5270, 0, [1, 2]]]},
                 "combinations": [{"max": 2, "channels": 1, "matchBeacon": False, "unknown": False,
                                   "limits": [{"max": 1, "modes": [2], "unknown": False},
                                              {"max": 1, "modes": [3, 6], "unknown": False}]}]}
        nativo = {"data": {
            "nl80211_interface": [{"name": "wlan0", "index": 2, "phy": 0, "mode": 2}],
            "nl80211_wiphy": [radio], "nl80211_reg": [{"phy": None, "country": "PE"}],
        }, "errors": {}}
        comandos = (sys.executable, "-I", "-B", str(WIRELESS))
        with tempfile.TemporaryDirectory() as directorio:
            raiz = Path(directorio)
            sysfs = sys_fixture(raiz, [("pci0", "phy0", [("wlan0", 2), ("wlan1", 3)])])
            rfkill = sysfs / "rfkill" / "rfkill0"
            rfkill.mkdir()
            for campo, valor in {"type": "wlan", "name": "phy0", "soft": "0", "hard": "1"}.items():
                (rfkill / campo).write_text(valor)
            fuentes = {
                ("nmcli", "-t", "--escape", "no", "-f", "DEVICE,TYPE,STATE", "device", "status"):
                    "wlan0:wifi:connected\nwlan1:wifi:disconnected",
                (*comandos, "inventory"): json.dumps(nativo),
                ("ip", "-j", "-4", "route", "show", "table", "all", "default"): "[]",
                ("ip", "-j", "-6", "route", "show", "table", "all", "default"): '[{"nexthops":[{"dev":"wlan0"}]}]',
                (*comandos, "driver-info", "wlan0", "2"):
                    '{"data":{"driver":"ejemplo","firmware":"1.2.3","serial":"privado"}}',
            }
            reservas = raiz / "reservas"
            with patch("adaptador_core.consultar", side_effect=lambda args, _: fuentes[tuple(args)]) as leer:
                dto = inventario_perfil(sysfs, reservas)
                self.assertEqual(leer.call_count, len(fuentes))
                fisico = dto["devices"][0]
                perfil = fisico["phys"][0]
                cap = perfil["capabilities"]
                self.assertEqual(dto["status"], "complete")
                self.assertEqual(fisico["firmware"], "1.2.3")
                self.assertNotIn("privado", json.dumps(dto))
                self.assertEqual(perfil["connectivity"]["criticality"], "critical")
                self.assertEqual(perfil["regulatory"]["country"], "PE")
                self.assertTrue(perfil["rfkill"]["hardBlocked"])
                self.assertFalse(perfil["rfkill"]["softBlocked"])
                self.assertEqual(cap["monitor"]["declared"], "supported")
                self.assertEqual(cap["monitor"]["verified"], "not_tested")
                self.assertEqual(cap["injection"]["declared"], "unknown")
                self.assertEqual([canal["flags"][0] for canal in cap["channels"]], ["no-ir", "dfs", "disabled"])
                self.assertEqual(cap["interfaceCombinations"]["items"][0]["maxDifferentChannels"], 1)
                self.assertEqual(perfil["reservation"]["state"], "free")
                self.assertFalse(reservas.exists())
                reservas.mkdir(mode=0o700)
                dto = inventario_perfil(sysfs, reservas, raiz / "proc-no-disponible")
                self.assertEqual(dto["devices"][0]["phys"][0]["reservation"]["state"], "unknown")
                self.assertFalse(list(reservas.iterdir()))
                self.assertIn("ethtool_drvinfo", perfil["probe"]["sources"])
                self.assertEqual(cap["channels"][0]["source"], "nl80211_wiphy")
                self.assertEqual(perfil["regulatory"]["source"], "nl80211_reg")
                radio["combinations"][0]["unknown"] = True
                del radio["modes"]
                fuentes[(*comandos, "inventory")] = json.dumps(nativo)
                dto = inventario_perfil(sysfs, reservas)
                perfil = dto["devices"][0]["phys"][0]
                self.assertEqual(perfil["capabilities"]["monitor"]["declared"], "unknown")
                self.assertEqual(perfil["capabilities"]["interfaceCombinations"]["status"], "unknown")
                self.assertEqual(perfil["capabilities"]["bands"], ["2.4GHz", "5GHz"])
                self.assertIn("unsupported_attribute", [a["code"] for a in perfil["probe"]["warnings"]])

    def test_usb_conserva_perfil_con_nm_ausente_y_firmware_denegado(self):
        with tempfile.TemporaryDirectory() as directorio:
            raiz = Path(directorio)
            sysfs = sys_fixture(raiz, [("usb0", "phy1", [("wlan1", 5)])])

            def consultar_fixture(args, _limite):
                if args[-1] == "inventory":
                    return json.dumps({"data": {
                        "nl80211_interface": [{"name": "wlan1", "index": 5, "phy": 1, "mode": 2}],
                        "nl80211_wiphy": [{"index": 1, "name": "phy1", "selfManaged": True,
                                           "modes": [2], "bands": {"3": [[5955, 0, [1, 3]]]}}],
                        "nl80211_reg": [{"phy": None, "country": "00"}],
                    }, "errors": {}})
                if "driver-info" in args:
                    return '{"error":"permission_denied"}'
                if args[0] == "ip":
                    return "[]"
                if args[0] == "nmcli":
                    raise FuenteError("source_unavailable")
                self.fail(f"Consulta inesperada: {args}")

            with patch("adaptador_core.consultar", side_effect=consultar_fixture):
                dto = inventario_perfil(sysfs, raiz / "reservas")
                usb = dto["devices"][0]
                phy = usb["phys"][0]
                self.assertEqual(usb["bus"], "usb")
                self.assertEqual(phy["interfaces"][0]["type"], "managed")
                self.assertEqual(phy["interfaces"][0]["nmState"], "unavailable")
                self.assertEqual(phy["capabilities"]["channels"][0]["channel"], 1)
                self.assertIsNone(phy["regulatory"]["country"])
                self.assertIsNone(usb["firmware"])
                self.assertIn(("ethtool_drvinfo", "permission_denied"),
                              {(a["source"], a["code"]) for a in phy["probe"]["warnings"]})

    def test_hotplug_no_reutiliza_datos_nativos_del_radio_anterior(self):
        with tempfile.TemporaryDirectory() as directorio:
            raiz = Path(directorio)
            sysfs = sys_fixture(raiz, [("usb0", "phy1", [("wlan1", 5)])])
            radio = sysfs / "ieee80211" / "phy1"
            destino_original = radio.resolve()
            destino_nuevo = raiz / "nuevo" / "phy1"
            destino_nuevo.mkdir(parents=True)
            (destino_nuevo / "index").write_text("1")

            def consultar_fixture(args, _limite):
                if args[-1] == "inventory":
                    radio.unlink()
                    radio.symlink_to(destino_nuevo)
                    return json.dumps({"data": {
                        "nl80211_interface": [{"name": "wlan1", "index": 5, "phy": 1, "mode": 2}],
                        "nl80211_wiphy": [{"index": 1, "name": "phy1", "selfManaged": False,
                                           "modes": [6], "bands": {"0": [[2412, 0, [1]]]}}],
                        "nl80211_reg": [{"phy": None, "country": "PE"}],
                    }, "errors": {}})
                if args[0] == "ip":
                    return "[]"
                if args[0] == "nmcli":
                    return "wlan1:wifi:disconnected"
                self.fail(f"Consulta inesperada: {args}")

            with patch("adaptador_core.consultar", side_effect=consultar_fixture):
                dto = inventario_perfil(sysfs, raiz / "reservas")
            self.assertNotEqual(destino_original, radio.resolve())
            phy = dto["devices"][0]["phys"][0]
            self.assertFalse(phy["interfaces"])
            self.assertEqual(phy["capabilities"]["monitor"]["declared"], "unknown")
            self.assertEqual(dto["status"], "partial")
            self.assertIn("adapter_disconnected", {a["code"] for a in phy["probe"]["warnings"]})

    def test_consulta_limita_salida_tiempo_y_recolecta_hijos(self):
        with self.assertRaises(FuenteError) as error:
            consultar([sys.executable, "-c", "print('x' * 300_000)"], time.monotonic() + 2)
        self.assertEqual(error.exception.codigo, "parse_unsupported")
        with self.assertRaises(FuenteError) as error:
            consultar([sys.executable, "-c", "import time; time.sleep(30)"], time.monotonic() + 0.1)
        self.assertEqual(error.exception.codigo, "probe_timeout")
        real = subprocess.Popen
        hijos = []
        def capturar(*args, **opciones):
            hijos.append(real(*args, **opciones))
            return hijos[-1]
        with (patch("adaptador_core.subprocess.Popen", side_effect=capturar),
              patch("adaptador_core.selectors.DefaultSelector.select", side_effect=KeyboardInterrupt)):
            with self.assertRaises(KeyboardInterrupt):
                consultar([sys.executable, "-c", "import time; time.sleep(30)"], time.monotonic() + 2)
        self.assertIsNotNone(hijos[0].poll())


def atributo_entero(tipo, numero, formato="=I"):
    return nl.attribute(tipo, struct.pack(formato, numero))


def mensaje_nl(codigo, contenido, flags=0, secuencia=1):
    largo = nl.NL_HEADER.size + len(contenido)
    return nl.NL_HEADER.pack(largo, codigo, flags, secuencia, 10) + contenido + bytes(nl.aligned(largo) - largo)


def datos_nl(familia, comando, atributos):
    return mensaje_nl(familia, nl.GENL_HEADER.pack(comando, 1, 0) + atributos)


class NetlinkTest(unittest.TestCase):
    def canal_fixture(self, respuestas):
        canal = Mock()
        canal.getsockname.return_value = (10, 0)
        canal.recvmsg.side_effect = [
            (respuesta, [], 0, (0, 0)) if isinstance(respuesta, bytes) else respuesta for respuesta in respuestas
        ]
        canal.__enter__ = Mock(return_value=canal)
        canal.__exit__ = Mock(return_value=False)
        return canal

    def test_consulta_solo_get_y_combina_un_dump_split_multipart(self):
        familia = 42
        controlador = self.canal_fixture([datos_nl(nl.GENL_ID_CTRL, nl.CTRL_CMD_NEWFAMILY,
                                    atributo_entero(nl.CTRL_ATTR_FAMILY_ID, familia, "=H"))])
        fin = mensaje_nl(nl.NLMSG_DONE, bytes(4))
        interfaz = self.canal_fixture([datos_nl(familia, nl.NEW_INTERFACE,
            atributo_entero(nl.Attr.WIPHY, 7) + atributo_entero(nl.Attr.IFINDEX, 4) +
            nl.attribute(nl.Attr.IFNAME, b"wlan0\0") + atributo_entero(nl.Attr.IFTYPE, 2)) + fin])
        def fragmento(indice, nombre, mhz, flags, modos=b""):
            frecuencias = nl.attribute(1, nl.attribute(1, atributo_entero(1, mhz) + flags))
            return datos_nl(familia, nl.NEW_WIPHY, atributo_entero(nl.Attr.WIPHY, indice) +
                nl.attribute(nl.Attr.WIPHY_NAME, nombre) +
                nl.attribute(nl.Attr.WIPHY_BANDS, nl.attribute(0, frecuencias)) + modos)
        radio = self.canal_fixture([
            fragmento(7, b"phy3\0", 2412, nl.attribute(3),
                      nl.attribute(nl.Attr.SUPPORTED_IFTYPES, nl.attribute(2))),
            fragmento(8, b"phy4\0", 2432, nl.attribute(2)),
            fragmento(7, b"phy3\0", 2437, nl.attribute(5)) + fin,
        ])
        regulacion = self.canal_fixture([datos_nl(familia, nl.GET_REG,
                                              nl.attribute(nl.Attr.REG_ALPHA2, b"PE\0")) + fin])
        canales = [controlador, interfaz, radio, regulacion]
        with patch("wireless_linux.socket.socket", side_effect=canales) as abrir:
            reporte = nl.inventory()
        self.assertEqual(reporte["errors"], {})
        self.assertEqual(abrir.call_count, 4)
        for llamada in abrir.call_args_list:
            self.assertEqual(llamada.args, (socket.AF_NETLINK, socket.SOCK_RAW, nl.NETLINK_GENERIC))
        comandos = []
        for canal in canales:
            canal.bind.assert_called_once_with((0, 0))
            peticion, destino = canal.sendto.call_args.args
            self.assertEqual(destino, (0, 0))
            comandos.append(peticion[nl.NL_HEADER.size])
        self.assertEqual(comandos, [nl.CTRL_CMD_GETFAMILY, nl.GET_INTERFACE, nl.GET_WIPHY, nl.GET_REG])
        wiphy = radio.sendto.call_args.args[0]
        self.assertEqual(dict(nl.attributes(wiphy[nl.NL_HEADER.size + nl.GENL_HEADER.size:])),
                         {nl.Attr.SPLIT_WIPHY_DUMP: b""})
        datos = reporte["data"]
        self.assertEqual(datos["nl80211_interface"], [{"name": "wlan0", "phy": 7, "index": 4, "mode": 2}])
        primero, segundo = datos["nl80211_wiphy"]
        self.assertEqual((primero["index"], primero["name"], primero["modes"]), (7, "phy3", [2]))
        self.assertEqual(primero["bands"][0], [[2412, 0, [1, 3]], [2437, 0, [1, 5]]])
        self.assertEqual(segundo["bands"][0], [[2432, 0, [1, 2]]])
        self.assertEqual(datos["nl80211_reg"], [{"phy": None, "country": "PE"}])

    def test_normaliza_errores_por_fuente_y_conserva_otra_consulta(self):
        familia = 42
        controlador = self.canal_fixture([datos_nl(nl.GENL_ID_CTRL, nl.CTRL_CMD_NEWFAMILY,
                                                  atributo_entero(nl.CTRL_ATTR_FAMILY_ID, familia, "=H"))])
        denegado = self.canal_fixture([mensaje_nl(nl.NLMSG_ERROR, struct.pack("=i", -errno.EPERM))])
        interrumpido = self.canal_fixture([mensaje_nl(nl.NLMSG_DONE, bytes(4), flags=nl.NLM_F_DUMP_INTR)])
        regulacion = self.canal_fixture([datos_nl(familia, nl.GET_REG, nl.attribute(nl.Attr.REG_ALPHA2, b"00\0"))
                                        + mensaje_nl(nl.NLMSG_DONE, bytes(4))])
        with patch("wireless_linux.socket.socket", side_effect=[controlador, denegado, interrumpido, regulacion]):
            reporte = nl.inventory()
        self.assertEqual(reporte["errors"], {"nl80211_interface": "permission_denied",
                                              "nl80211_wiphy": "snapshot_incomplete"})
        self.assertEqual(reporte["data"]["nl80211_reg"], [{"phy": None, "country": "00"}])

    def test_rechaza_truncamiento_emisor_secuencia_y_timeout(self):
        fin = mensaje_nl(nl.NLMSG_DONE, bytes(4))
        for evento, error in (
            ((fin, [], socket.MSG_TRUNC, (0, 0)), "snapshot_incomplete"),
            (fin[:-1], "snapshot_incomplete"),
            ((fin, [], 0, (22, 0)), "parse_unsupported"),
            (mensaje_nl(nl.NLMSG_DONE, bytes(4), secuencia=2), "parse_unsupported"),
        ):
            with self.subTest(error=error), patch("wireless_linux.socket.socket", return_value=self.canal_fixture([evento])):
                with self.assertRaises(nl.ProbeError) as fallo:
                    nl.request(42, nl.GET_INTERFACE, nl.NEW_INTERFACE, time.monotonic() + 1, dump=True)
                self.assertEqual(fallo.exception.code, error)
        canal = self.canal_fixture([])
        canal.recvmsg.side_effect = TimeoutError
        with patch("wireless_linux.socket.socket", return_value=canal):
            with self.assertRaises(TimeoutError) as fallo:
                nl.request(42, nl.GET_INTERFACE, nl.NEW_INTERFACE, time.monotonic() + 1, dump=True)
        self.assertEqual(nl.error_code(fallo.exception), "probe_timeout")

    def test_firmware_usa_solo_gdrvinfo_y_rechaza_indice_inconsistente(self):
        canal = self.canal_fixture([])
        canal.fileno.return_value = 123
        def leer(descriptor, codigo, peticion, mutar):
            self.assertEqual((descriptor, codigo, mutar), (123, 0x8946, True))
            self.assertEqual(peticion[:16].strip(b"\0"), b"wlan1")
            direccion = struct.unpack_from("@P", peticion, 16)[0]
            info = (nl.ctypes.c_char * 196).from_address(direccion)
            self.assertEqual(struct.unpack_from("=I", info, 0)[0], 3)
            info[4:8] = b"test"
            info[68:71] = b"1.0"
        with (patch("wireless_linux.socket.if_nametoindex", side_effect=[4, 4, 9]),
              patch("wireless_linux.socket.socket", return_value=canal),
              patch("wireless_linux.fcntl.ioctl", side_effect=leer) as ioctl):
            self.assertEqual(nl.driver_info("wlan1", 4), {"driver": "test", "firmware": "1.0"})
            with self.assertRaises(nl.ProbeError) as error:
                nl.driver_info("wlan1", 4)
        self.assertEqual(error.exception.code, "adapter_disconnected")
        ioctl.assert_called_once()


class PreflightTest(unittest.TestCase):
    def setUp(self):
        temporal = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch("entorno.RESERVAS", Path(temporal) / "reservas"))
        self.sysfs = sys_fixture(Path(temporal), [("pci0", "phy0", [("wlan1", 4), ("wlanhermana", 5)])])
        self.enterContext(patch("adaptador_core.SYS", self.sysfs))
        self.fisico = {**FISICO, "id": identidad_heredada(self.sysfs / "net" / "wlan1")}
        self.detectados = self.enterContext(patch("entorno.adaptadores", return_value=[self.fisico]))
        self.docker = self.enterContext(patch("entorno.docker", return_value=True))
        self.enterContext(patch("entorno.nmcli", return_value="GENERAL.TYPE:wifi\nGENERAL.STATE:30 (disconnected)"))
        self.ip = self.enterContext(patch("entorno.subprocess.run", return_value=Mock(stdout="[]")))

    def test_mock_disponible_sin_hardware(self):
        self.detectados.side_effect = RuntimeError("NetworkManager no disponible.")
        self.assertEqual([item["name"] for item in inventario()["adaptadores"]], ["mock"])
        self.assertEqual(preflight("mock", ALCANCE),
                         {"ok": True, "errors": [], "capabilities": ["informe-sintetico"]})
        self.assertEqual(informe_demo()["origen"], "demo")
        alcance_vacio = {**ALCANCE, "allowedBssids": [], "allowedSsids": []}
        self.assertFalse(preflight("mock", alcance_vacio)["ok"])
        self.docker.assert_not_called()
        self.ip.assert_not_called()

    def test_las_capacidades_declaradas_no_sustituyen_networkmanager(self):
        with patch("entorno.nmcli", side_effect=RuntimeError("NetworkManager no disponible.")):
            reporte = preflight("wlan1", ALCANCE)
        self.assertFalse(reporte["ok"])
        self.assertIn("NetworkManager no disponible.", reporte["errors"])
        self.docker.assert_not_called()

    def test_rechaza_rutas_por_defecto_ipv4_ipv6_y_multipath(self):
        for rutas in ([{"dev": "wlan1"}], [{"nexthops": [{"dev": "wlan0"}, {"dev": "wlan1"}]}]):
            for ipv4 in (True, False):
                with self.subTest(rutas=rutas, ipv4=ipv4):
                    salidas = [Mock(stdout=json.dumps(rutas)), Mock(stdout="[]")]
                    self.ip.side_effect = salidas if ipv4 else list(reversed(salidas))
                    reporte = preflight("wlan1", ALCANCE)
                    self.assertFalse(reporte["ok"])
                    self.assertIn("ruta por defecto", reporte["errors"][0])
                    self.assertEqual([llamada.args[0][2] for llamada in self.ip.call_args_list[-2:]], ["-4", "-6"])
        self.ip.side_effect = subprocess.TimeoutExpired("ip", 3)
        self.assertIn("verificar las rutas", preflight("wlan1", ALCANCE)["errors"][0])

    def test_ruta_en_interfaz_hermana_y_tunel_bloquean_preflight(self):
        for nombre in ("wlanhermana", "tun0"):
            with self.subTest(nombre=nombre):
                self.ip.side_effect = [Mock(stdout="[]"), Mock(stdout=json.dumps([{"dev": nombre}]))]
                self.assertIn("ruta por defecto", preflight("wlan1", ALCANCE)["errors"][0])
        self.docker.assert_not_called()

    def test_ruta_critica_aparece_durante_recoleccion(self):
        def recolectar(_):
            self.ip.return_value = Mock(stdout='[{"dev":"wlanhermana"}]')
            return {"conectada": True}
        with (patch("entorno.asociacion_actual", return_value=ASOCIACION),
              patch("entorno.recolectar", side_effect=recolectar),
              patch("entorno.sandbox_administrado") as sandbox):
            with self.assertRaisesRegex(DiagnosticoBloqueado, "ruta por defecto"):
                diagnostico_fisico(self.fisico["id"], ALCANCE, EJECUCION, 0)
            sandbox.assert_not_called()

    def test_revalida_perfil_ante_renombre_y_rechaza_legacy_ambiguo(self):
        phy = topologia(self.sysfs, [])[0]["phys"][0]
        interfaz = phy["interfaces"][0]
        esperado = {"phyId": phy["phyId"], **{k: interfaz[k] for k in ("ifindex", "ifname", "interfaceId")}}
        self.assertTrue(preflight_detalle("wlan1", ALCANCE, self.fisico["id"], esperado)["preflight"]["ok"])
        os.rename(self.sysfs / "net/wlan1", self.sysfs / "net/wlan2")
        self.detectados.return_value = [{**self.fisico, "interfaz": "wlan2"}]
        resultado = preflight_detalle("wlan1", ALCANCE, self.fisico["id"], esperado)
        self.assertEqual(resultado["code"], "adapter_disconnected")
        self.detectados.return_value += [{**self.fisico, "interfaz": "wlanhermana"}]
        self.assertEqual(preflight_detalle("wlan2", ALCANCE)["code"], "ambiguous_interface")

    def test_fisico_desconectado_desaparecido_o_sin_docker(self):
        self.assertTrue(preflight("wlan1", ALCANCE)["ok"])
        self.docker.return_value = False
        self.assertIn("Docker", preflight("wlan1", ALCANCE)["errors"][0])
        self.detectados.return_value = []
        self.assertIn("no está disponible", preflight("wlan1", ALCANCE)["errors"][0])

    def test_inventario_y_preflight_muestran_reserva_activa(self):
        with reserva_adaptador(self.fisico["id"], EJECUCION) as ocupado:
            self.assertIsNone(ocupado)
            estado = inventario()["adaptadores"][1]
            self.assertEqual((estado["estado"], estado["lockedBySession"]), ("ocupado", EJECUCION))
            resultado = preflight_detalle("wlan1", ALCANCE)
            self.assertFalse(resultado["preflight"]["ok"])
            self.assertEqual(resultado["adapter"]["lockedBySession"], EJECUCION)
        self.assertTrue(preflight("wlan1", ALCANCE)["ok"])

    def test_rechaza_asociacion_ausente_o_fuera_de_cualquier_lista(self):
        asociaciones = (None, ("AA:BB:CC:11:22:44", *ASOCIACION[1:]),
                        (ASOCIACION[0], b"otra red", 6, "2437 MHz"), (*ASOCIACION[:2], 11, "2462 MHz"))
        with patch("entorno.recolectar") as recolectar, patch("entorno.sandbox_administrado") as sandbox:
            for asociacion in asociaciones:
                with self.subTest(asociacion=asociacion), patch("entorno.asociacion_actual", return_value=asociacion):
                    with self.assertRaises(DiagnosticoBloqueado):
                        diagnostico_fisico(self.fisico["id"], ALCANCE, EJECUCION, 0)
            recolectar.assert_not_called()
            sandbox.assert_not_called()
        self.assertTrue(preflight("wlan1", ALCANCE)["ok"])

    def test_bloquea_cambio_a_otra_asociacion_permitida(self):
        segundo = ("AA:BB:CC:11:22:44", *ASOCIACION[1:])
        alcance = {**ALCANCE, "allowedBssids": [ASOCIACION[0], segundo[0]]}
        with (patch("entorno.asociacion_actual", side_effect=[ASOCIACION, segundo]),
              patch("entorno.recolectar", return_value={"conectada": True}),
              patch("entorno.sandbox_administrado") as sandbox):
            with self.assertRaisesRegex(DiagnosticoBloqueado, "cambió durante la recolección"):
                diagnostico_fisico(self.fisico["id"], alcance, EJECUCION, 0)
            sandbox.assert_not_called()

    def test_reserva_durante_el_analisis_y_libera_tras_error(self):
        muestra = {"conectada": True, "senal_dbm": -55}

        async def analizar(muestra_recibida, *_args, **_kwargs):
            self.assertEqual(muestra_recibida, muestra)
            with reserva_adaptador(self.fisico["id"]) as ocupado:
                self.assertEqual(ocupado, EJECUCION)
            raise RuntimeError("Error del sandbox")

        with (patch("entorno.asociacion_actual", return_value=ASOCIACION),
              patch("entorno.recolectar", return_value=muestra),
              patch("entorno.sandbox_administrado", return_value=nullcontext(("loopback", "fixture"))),
              patch("entorno.analizar_aislado", side_effect=analizar)):
            with self.assertRaisesRegex(RuntimeError, "Error del sandbox") as error:
                diagnostico_fisico(self.fisico["id"], ALCANCE, EJECUCION, 0)
            self.assertNotIsInstance(error.exception, DiagnosticoBloqueado)
        self.assertTrue(preflight("wlan1", ALCANCE)["ok"])


if __name__ == "__main__":
    unittest.main()
