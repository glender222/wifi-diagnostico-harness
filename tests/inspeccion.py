"""Oráculos de permisos y lecturas para el broker de inspección."""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import broker_lectura as broker
from entorno import coincide_alcance, normalizar_alcance


class BrokerTest(unittest.TestCase):
    def setUp(self):
        self.filtros = {"allowedBssids": [], "allowedSsids": ["lab"], "allowedChannels": [6]}
        self.id = "1" * 13 + "-01234567-0123-0123-0123-0123456789ab"
        self.solicitud = {
            "version": 1, "requestId": self.id, "sessionId": self.id, "turnId": self.id, "scopeId": "a" * 64,
            "networkRevision": None, "operation": "inspeccionar_enlace", "params": {"interfaz": "i1"},
            "binding": {"name": "wlan1", "identity": "a" * 64}, "network": None, "timeoutMs": 5000,
        }
        interfaz = {"ifname": "wlan1", "linkState": "up"}
        self.seleccion = ("a" * 64, {"phyId": "phy_private", "interfaces": [interfaz]}, interfaz)

    def ejecutar(self):
        return broker.ejecutar_lectura(self.solicitud, normalizar_alcance, coincide_alcance)

    def test_host_only_no_consulta_asociacion(self):
        with (patch.object(broker, "seleccionar", return_value=self.seleccion),
              patch.object(broker, "rutas", side_effect=lambda familia, *_: (
                  ("direct", None, ["privado"]) if familia == "-4" else (None, "permission_denied", None))),
              patch.object(broker, "direcciones", return_value=({4: True, 6: False}, None)),
              patch.object(broker, "asociacion_actual") as asociacion):
            salida = self.ejecutar()
        asociacion.assert_not_called()
        self.assertEqual(salida["status"], "partial")
        self.assertIn("network_scope_required", salida["reasons"])
        self.assertIn("permission_denied", salida["reasons"])
        self.assertNotIn("privado", str(salida))
        self.assertTrue(all(x["scope"] == "host" for x in salida["observations"]))

    def test_roaming_y_alcance(self):
        self.solicitud.update(network=self.filtros, networkRevision=1)
        permitida = ("AA:BB:11:22:33:44", b"lab", 6, "2437 MHz")
        ajena = ("AA:BB:22:33:44:55", b"ajena", 6, "2437 MHz")
        with (patch.object(broker, "seleccionar", return_value=self.seleccion),
              patch.object(broker, "rutas", return_value=("direct", None, [])),
              patch.object(broker, "direcciones", return_value=({4: True, 6: True}, None)),
              patch.object(broker, "senal_dbm", return_value=-80),
              patch.object(broker, "asociacion_actual", side_effect=[ajena, permitida, ajena, permitida, permitida])):
            for motivo in ("network_scope_denied", "unstable_snapshot"):
                salida = self.ejecutar()
                datos_red = [x for x in salida["observations"] if x["scope"] == "network"]
                self.assertEqual([(x["value"], x["reason"]) for x in datos_red], [(None, motivo)])
            salida = self.ejecutar()
            self.assertIn(-80, [x["value"] for x in salida["observations"]])
            self.assertNotIn("AA:BB", str(salida))
            self.assertNotIn("lab", str(salida))

    def test_identidad_y_contrato_sin_coercion(self):
        self.solicitud["params"]["interfaz"] = 1
        self.assertEqual(self.ejecutar()["reasons"], ["invalid_request"])
        self.solicitud["params"]["interfaz"] = "i1"
        with patch.object(broker, "seleccionar", return_value=None), patch.object(broker, "enlace") as enlace:
            self.assertEqual(self.ejecutar()["reasons"], ["identity_changed"])
            enlace.assert_not_called()

    def test_ruta_ipv6_conserva_identidad_al_bajar_expiracion(self):
        muestras = ['[{"dev":"wlan1","expires":1024}]', '[{"dev":"wlan1","expires":1023}]',
                    '[{"dev":"wlan1","expires":1023,"metric":900}]']
        with patch.object(broker.core, "consultar", side_effect=muestras):
            antes, despues, cambio = (broker.rutas("-6", {"wlan1"}, 0) for _ in muestras)
        self.assertEqual(antes[0], "direct")
        self.assertEqual(antes, despues)
        self.assertNotEqual(antes, cambio)

    def test_inventario_pcie_y_usb_con_identidad_opaca(self):
        self.solicitud.update(operation="consultar_adaptadores", params={})
        capacidades = {"monitor": {"declared": "supported"}, "concurrency": {"declared": "unknown"}}
        perfil = {"status": "complete", "devices": [
            {"bus": "pci", "phys": [{"phyId": "phy_private", "capabilities": capacidades}]},
            {"bus": "usb", "phys": [{"phyId": "usb_private", "capabilities": capacidades}]},
        ]}
        with (patch.object(broker, "seleccionar", return_value=self.seleccion),
              patch.object(broker.core, "inventario_perfil", return_value=perfil)):
            salida = self.ejecutar()
        self.assertEqual(salida["status"], "ok")
        buses = {x["value"]: x["subject"] for x in salida["observations"] if x["field"] == "bus"}
        self.assertEqual(buses["pci"], "p1")
        self.assertRegex(buses["usb"], "^p_[0-9a-f]{16}$")
        self.assertNotIn("_private", str(salida))

    def test_comando_de_asociacion_en_cache(self):
        consulta = unittest.mock.Mock(return_value="*:6c6162:6:2437 MHz:AA:BB:11:22:33:44\n")
        self.assertEqual(broker.asociacion_actual("wlan1", consulta)[1], b"lab")
        self.assertEqual(consulta.call_args.args[-2:], ("--rescan", "no"))


if __name__ == "__main__":
    unittest.main()
