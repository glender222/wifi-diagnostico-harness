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
                esperar("wifi >")
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
            esperar("wifi >")
            escribir(b"/proyecto\r")
            esperar("Carpeta [")
            escribir(b"\x1b")
            esperar("wifi >")
            self.assertEqual(list(Path(raiz).iterdir()), [])
            escribir(b"/proyecto\r")
            esperar("Carpeta [")
            escribir(b"/salir\r")
            self.assertEqual(proceso.wait(timeout=5), 0)


if __name__ == "__main__":
    unittest.main()
