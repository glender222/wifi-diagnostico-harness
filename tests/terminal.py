"""Regresiones del arranque y la salida de Harwiff en una terminal real."""

import errno
import fcntl
import os
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time
import unittest
from contextlib import contextmanager
from pathlib import Path

FUENTE = Path(__file__).resolve().parent.parent / "consola.mjs"


@contextmanager
def terminal(carpeta):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 28, 110, 0, 0))
    proceso = subprocess.Popen(["node", str(FUENTE)], cwd=carpeta, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    captura = bytearray()

    def esperar(texto):
        buscado = texto.encode()
        limite = time.monotonic() + 8
        while buscado not in captura:
            if time.monotonic() > limite:
                raise AssertionError((texto, captura.decode(errors="replace")))
            if select.select([master], [], [], 0.1)[0]:
                try:
                    captura.extend(os.read(master, 4096))
                except OSError as error:
                    if error.errno == errno.EIO:
                        raise AssertionError(captura.decode(errors="replace")) from error
                    raise

        return bytes(captura)

    def escribir(entrada):
        captura.clear()
        os.write(master, entrada)

    try:
        yield proceso, esperar, escribir
    finally:
        if proceso.poll() is None:
            proceso.terminate()
            try:
                proceso.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proceso.kill()
                proceso.wait(timeout=5)
        os.close(master)


class TerminalTest(unittest.TestCase):
    def test_inicio_proyecto_guiado_y_salida(self):
        with tempfile.TemporaryDirectory() as raiz:
            proyecto = Path(raiz) / "prueba con espacios"
            with terminal(raiz) as (proceso, esperar, escribir):
                esperar("harwiff >")
                esperar("Sin proyecto")
                self.assertEqual(list(Path(raiz).iterdir()), [])
                escribir(b"/proyecto\r")
                esperar("Carpeta [")
                escribir(b"prueba con espacios\r")
                esperar("Proyecto creado")
                self.assertTrue((proyecto / "harness.json").is_file())
                escribir(b"\x04")
                self.assertEqual(proceso.wait(timeout=5), 0)

            with terminal(proyecto) as (proceso, esperar, escribir):
                esperar("Proyecto abierto")
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)

    def test_escape_cancela_y_salir_cierra_desde_pregunta(self):
        with tempfile.TemporaryDirectory() as raiz, terminal(raiz) as (proceso, esperar, escribir):
            esperar("harwiff >")
            escribir(b"/proyecto\r")
            esperar("Carpeta [")
            escribir(b"\x1b")
            esperar("harwiff >")
            self.assertEqual(list(Path(raiz).iterdir()), [])
            escribir(b"/proyecto\r")
            esperar("Carpeta [")
            escribir(b"/salir\r")
            self.assertEqual(proceso.wait(timeout=5), 0)


    def test_apartado_agente_aparece_al_enviar_consulta(self):
        with tempfile.TemporaryDirectory() as raiz, terminal(raiz) as (proceso, esperar, escribir):
            inicial = esperar("harwiff >")
            self.assertNotIn("─".encode(), inicial)
            self.assertNotIn(b"Agentes", inicial)
            escribir(b"/proyecto prueba\r")
            esperar("Proyecto creado")
            escribir(b"agent harwiff\r")
            preparada = esperar("Escribe tu primera consulta")
            self.assertNotIn(b"agente/harwiff >", preparada)
            self.assertNotIn(b"Agentes", preparada)
            escribir(b"Consulta de prueba\r")
            iniciada = esperar("agente/harwiff >")
            self.assertNotIn(b"wifi >", iniciada)
            self.assertIn(b"Esc vuelve a harwiff >", iniciada)
            esperar("Agentes")
            escribir(b"/config\r")
            esperar("Agente: harwiff")
            escribir(b"\x1b")
            esperar("harwiff >")
            escribir(b"\t")
            esperar("[harwiff")
            escribir(b"\r")
            esperar("agente/harwiff >")
            escribir(b"/salir\r")
            self.assertEqual(proceso.wait(timeout=5), 0)

    def test_consulta_directa_desde_wifi(self):
        with tempfile.TemporaryDirectory() as raiz, terminal(raiz) as (proceso, esperar, escribir):
            esperar("harwiff >")
            escribir(b"/proyecto prueba\r")
            esperar("Proyecto creado")
            escribir(b"Consulta directa\r")
            esperar("agente/harwiff >")
            esperar("Todavía no hay informes")
            escribir(b"/salir\r")
            self.assertEqual(proceso.wait(timeout=5), 0)


    def test_comandos_rapidos_no_usan_el_prefijo_del_menu_anterior(self):
        with tempfile.TemporaryDirectory() as raiz, terminal(raiz) as (proceso, esperar, escribir):
            esperar("harwiff >")
            escribir(b"/")
            inicial = esperar("Crear o abrir un proyecto")
            self.assertNotIn(b"/diagnostico", inicial)
            escribir(b"ayuda\r")
            ayuda = esperar("/salir  Cerrar Harwiff")
            self.assertNotIn(b"ayudayuda", ayuda)
            self.assertNotIn(b"/diagnostico", ayuda)
            escribir(b"/")
            esperar("Crear o abrir un proyecto")
            escribir(b"proyecto prueba\r")
            esperar("Proyecto creado")
            escribir(b"/")
            esperar("Ejecutar en OpenSandbox")
            escribir(b"diagnostico demo\r")
            esperar("Informe guardado")
            escribir(b"Consulta\r")
            esperar("agente/harwiff >")
            escribir(b"/")
            agente = esperar("Cancelar el turno")
            self.assertNotIn(b"Crear o abrir un proyecto", agente)
            escribir(b"config\r")
            esperar("Agente: harwiff")
            escribir(b"/")
            esperar("Cancelar el turno")
            escribir(b"ayuda\r")
            esperar("/volver  Volver del agente al entorno")
            escribir(b"\x1b")
            esperar("harwiff >")
            escribir(b"\t")
            esperar("[harwiff")
            escribir(b"/")
            esperar("Ejecutar en OpenSandbox")
            escribir(b"salir\r")
            self.assertEqual(proceso.wait(timeout=5), 0)


    def test_proyecto_en_carpeta_de_trabajo_con_archivos(self):
        with tempfile.TemporaryDirectory() as raiz:
            carpeta = Path(raiz)
            (carpeta / "app.py").write_text("# archivo del usuario\n")
            (carpeta / "harness.json").write_text('{"app":"otro proyecto"}')
            with terminal(raiz) as (proceso, esperar, escribir):
                esperar("Sin proyecto")
                self.assertFalse((carpeta / ".harwiff").exists())
                escribir(b"/proyecto\r")
                esperar("Carpeta [.]")
                escribir(b"\r")
                esperar("Datos de Harwiff guardados en .harwiff/")
                self.assertTrue((carpeta / ".harwiff/harness.json").is_file())
                self.assertEqual((carpeta / "app.py").read_text(), "# archivo del usuario\n")
                self.assertEqual((carpeta / "harness.json").read_text(), '{"app":"otro proyecto"}')
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)
            with terminal(raiz) as (proceso, esperar, escribir):
                esperar("Proyecto abierto")
                escribir(b"/diagnostico demo\r")
                esperar("Informe guardado")
                self.assertTrue(list((carpeta / ".harwiff/informes").glob("*.json")))
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)

    def test_proyecto_desde_raiz_pide_una_carpeta(self):
        with terminal("/") as (proceso, esperar, escribir):
            esperar("Sin proyecto")
            escribir(b"/proyecto\r")
            esperar("Carpeta (ej. ~/wifi-prueba)")
            escribir(b"\r")
            salida = esperar("Escribe una ruta")
            self.assertNotIn(b".wifi-init", salida)
            escribir(b"/proyecto /\r")
            esperar("Elige una carpeta de trabajo")
            escribir(b"/salir\r")
            self.assertEqual(proceso.wait(timeout=5), 0)


if __name__ == "__main__":
    unittest.main()
