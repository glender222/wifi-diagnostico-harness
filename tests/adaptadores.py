import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from entorno import adaptadores


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


if __name__ == "__main__":
    unittest.main()
