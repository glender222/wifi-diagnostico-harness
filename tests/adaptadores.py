import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from adaptador_core import FuenteError, consultar, identidad_heredada, inventario_perfil
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
        (sysfs / "ieee80211" / phy).symlink_to(radio)
        if not (fisico / "subsystem").exists():
            (raiz / "pci").mkdir(exist_ok=True)
            (fisico / "subsystem").symlink_to(raiz / "pci")
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
        iw = """Wiphy phy0
	Supported interface modes:
		 * managed
		 * monitor
	Band 1:
		Frequencies:
			* 2412 MHz [1] (20.0 dBm) (no IR)
			* 5260 MHz [52] (radar detection)
			* 5270 MHz [54] (disabled)
	valid interface combinations:
		 * #{ managed } <= 1, #{ AP, monitor } <= 1,
		   total <= 2, #channels <= 1
"""
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
                ("iw", "dev"): "phy#0\n\tInterface wlan0\n\t\ttype managed",
                ("iw", "phy", "phy0", "info"): iw,
                ("iw", "reg", "get"): "global\ncountry PE: DFS-UNSET",
                ("ip", "-j", "-4", "route", "show", "table", "all", "default"): "[]",
                ("ip", "-j", "-6", "route", "show", "table", "all", "default"): '[{"nexthops":[{"dev":"wlan0"}]}]',
                ("ethtool", "-i", "wlan0"): "driver: ejemplo\nfirmware-version: 1.2.3\nserial: privado",
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
                fuentes[("iw", "phy", "phy0", "info")] = "Formato desconocido"
                dto = inventario_perfil(sysfs, reservas)
                perfil = dto["devices"][0]["phys"][0]
                self.assertEqual(perfil["capabilities"]["monitor"]["declared"], "unknown")
                self.assertEqual(perfil["capabilities"]["interfaceCombinations"]["status"], "unknown")
                self.assertIn("parse_unsupported", [a["code"] for a in perfil["probe"]["warnings"]])

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
