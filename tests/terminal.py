"""Regresiones del arranque y la salida de Harwiff en una terminal real."""

import errno
import fcntl
import json
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
def terminal(carpeta, env=None):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 28, 110, 0, 0))
    proceso = subprocess.Popen(["node", str(FUENTE)], cwd=carpeta, stdin=slave, stdout=slave, stderr=slave, env=env)
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
    def test_connect_openai_oculta_clave_recupera_y_desvincula(self):
        with tempfile.TemporaryDirectory() as raiz:
            base = Path(raiz)
            proyecto = base / "prueba"
            almacen = base / "vault-fixture"
            log_terminal = base / "terminal.log"
            secreto = b"sk-fixture-harwiff-terminal"
            herramienta = base / "secret-tool"
            herramienta.write_text("""#!/usr/bin/env node
const fs = require("node:fs");
const archivo = process.env.HARWIFF_VAULT_FIXTURE;
const clave = "sk-fixture-harwiff-terminal";
const [operacion, ...argumentos] = process.argv.slice(2);
if (process.env.OPENAI_API_KEY || argumentos.includes(clave)) process.exit(9);
if (operacion === "lookup" && fs.existsSync(archivo)) console.log(clave);
else if (operacion === "store" && fs.readFileSync(0, "utf8") === clave) fs.writeFileSync(archivo, "presente");
else if (operacion === "clear" && fs.existsSync(archivo)) fs.unlinkSync(archivo);
else process.exit(1);
""")
            herramienta.chmod(0o700)
            preload = (Path(__file__).parent / "fixtures" / "connect-openai.mjs").resolve().as_uri()
            env = self.entorno_demo()
            env.pop("OPENAI_API_KEY", None)
            env.update(PATH=f"{base}:{os.environ['PATH']}", NODE_OPTIONS=f"--import={preload}", PI_TUI_WRITE_LOG=str(log_terminal),
                       DBUS_SESSION_BUS_ADDRESS="unix:path=/fixture", HARWIFF_VAULT_FIXTURE=str(almacen))
            with terminal(base, env) as (proceso, esperar, escribir):
                self.configurar_sesion_mock(esperar, escribir)
                escribir(b"/connect\r")
                esperar("Conectar proveedor LLM")
                escribir(b"\r")
                esperar("entrada oculta")
                escribir(b"\x1b[200~" + secreto + b"\x1b[201~")
                self.assertNotIn(secreto, esperar("•"))
                escribir(b"\x1b")
                esperar("harwiff >")
                self.assertFalse(almacen.exists())
                escribir(b"/connect\r")
                esperar("Conectar proveedor LLM")
                escribir(b"\r")
                esperar("entrada oculta")
                escribir(b"\x1b[200~" + secreto + b"\x1b[201~")
                self.assertNotIn(secreto, esperar("•"))
                escribir(b"\r")
                self.assertNotIn(secreto, esperar("Modelos compatibles de OpenAI"))
                escribir(b"\x1b[B\r")
                self.assertNotIn(secreto, esperar("OpenAI API conectado · Modelo: gpt-5-mini · Credencial: Secret Service"))
                self.assertEqual(almacen.read_text(), "presente")
                datos = (proyecto / "harness.json").read_bytes()
                self.assertNotIn(secreto, datos)
                self.assertEqual(json.loads(datos)["llm"], {"proveedor": "openai", "openaiModelId": "gpt-5-mini"})
                escribir(b"/connect test\r")
                esperar("OpenAI Responses y function calling verificados")
                esperar("Tokens de conectividad · entrada 8, salida 2, total 10")
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)

            with terminal(proyecto, env) as (proceso, esperar, escribir):
                esperar("Proyecto abierto")
                escribir(b"/connect list\r")
                esperar("credencial en Secret Service · modelo gpt-5-mini · seleccionado")
                escribir(b"/agente Revisar el fixture autorizado\r")
                esperar("Sesión iniciada")
                [agente] = (proyecto / "agentes").iterdir()
                escribir(b"\t")
                esperar(f"[{agente.name}")
                escribir(b"\r")
                esperar("ALLOWED")
                esperar("Iteración 2")
                esperar("Tokens OpenAI · entrada 16, salida 4, total 20")
                self.assertNotIn(secreto, esperar("Sesión completada."))
                escribir(b"\x1b")
                esperar("harwiff >")
                escribir(b"/disconnect openai\r")
                esperar("Credencial de OpenAI desvinculada")
                self.assertFalse(almacen.exists())
                escribir(b"/connect list\r")
                esperar("OpenAI API · sin credencial · modelo gpt-5-mini · seleccionado")
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)

            self.assertNotIn(secreto, log_terminal.read_bytes())

    def test_connect_foundry_reutiliza_configuracion(self):
        env = self.entorno_demo()
        env.update(FOUNDRY_HOST="fixture.openai.azure.com", FOUNDRY_DEPLOYMENT="modelo-fixture",
                   FOUNDRY_API_KEY="clave-foundry-fixture")
        with tempfile.TemporaryDirectory() as raiz, terminal(raiz, env) as (proceso, esperar, escribir):
            esperar("harwiff >")
            escribir(b"/proyecto prueba\r")
            esperar("Proyecto creado")
            escribir(b"/connect\r")
            esperar("Azure AI Foundry")
            escribir(b"\r")
            esperar("Dominio Azure")
            escribir(b"\r")
            esperar("Deployment [modelo-fixture]")
            escribir(b"\r")
            esperar("Azure AI Foundry configurado")
            datos = (Path(raiz) / "prueba" / "harness.json").read_text()
            self.assertNotIn("clave-foundry-fixture", datos)
            self.assertEqual(json.loads(datos)["llm"], {"proveedor": "azure-foundry"})
            escribir(b"/salir\r")
            self.assertEqual(proceso.wait(timeout=5), 0)

    def configurar_sesion_mock(self, esperar, escribir):
        esperar("harwiff >")
        escribir(b"/proyecto prueba\r")
        esperar("Proyecto creado")
        escribir(b"/agente Revisar fixture\r")
        esperar("Selecciona un adaptador")
        escribir(b"/alcance set --ssid LAB_TEST_AP --canales 6\r")
        esperar("Alcance guardado")
        escribir(b"/adaptador usar mock\r")
        esperar("Adaptador: mock | Alcance: 1 SSID, 1 canal(es) | Preflight: OK")

    @staticmethod
    def entorno_demo():
        return {clave: valor for clave, valor in os.environ.items()
                if clave not in {"FOUNDRY_HOST", "FOUNDRY_DEPLOYMENT", "FOUNDRY_API_KEY"}}

    def test_sesion_mock_detach_continua_y_reabre(self):
        with tempfile.TemporaryDirectory() as raiz:
            proyecto = Path(raiz) / "prueba"
            with terminal(raiz, self.entorno_demo()) as (proceso, esperar, escribir):
                self.configurar_sesion_mock(esperar, escribir)
                escribir(b"/agente Revisar fixture\r")
                esperar("Sesión iniciada")
                [sesion] = (proyecto / "agentes").iterdir()
                escribir(b"\t")
                esperar(f"[{sesion.name}")
                escribir(b"\r")
                esperar(f"agente/{sesion.name} >")
                escribir(b"\x1b")
                esperar("harwiff >")
                esperar("objetivo finalizado")
                datos = json.loads((sesion / "sesion.json").read_text())
                self.assertEqual(datos["status"], "completed")
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)
            with terminal(proyecto, self.entorno_demo()) as (proceso, esperar, escribir):
                esperar(f"{sesion.name} · completed")
                escribir(b"\t")
                esperar(f"[{sesion.name}")
                escribir(b"\r")
                esperar("Sesión completada.")
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)

    def test_detener_sesion_mock_seleccionada(self):
        with tempfile.TemporaryDirectory() as raiz, terminal(raiz, self.entorno_demo()) as (proceso, esperar, escribir):
            self.configurar_sesion_mock(esperar, escribir)
            escribir(b"/agente Revisar fixture\r")
            esperar("Sesión iniciada")
            [sesion] = (Path(raiz) / "prueba" / "agentes").iterdir()
            escribir(b"\t")
            esperar(f"[{sesion.name}")
            escribir(b"\r")
            esperar(f"agente/{sesion.name} >")
            escribir(b"/detener\r")
            esperar("Sesión cancelada.")
            datos = json.loads((sesion / "sesion.json").read_text())
            self.assertEqual(datos["status"], "cancelled")
            escribir(b"/salir\r")
            self.assertEqual(proceso.wait(timeout=5), 0)

    def test_cabecera_del_plano_de_control(self):
        with tempfile.TemporaryDirectory() as raiz, terminal(raiz) as (proceso, esperar, escribir):
            esperar("Adaptador: ninguno | Alcance: pendiente | Preflight: Pendiente")
            escribir(b"/proyecto prueba\r")
            esperar("Proyecto creado")
            escribir(b'/alcance set --ssid "Red de laboratorio"\r')
            esperar("Alcance guardado")
            escribir(b"/adaptador usar mock\r")
            esperar("Adaptador: mock | Alcance: 1 SSID | Preflight: OK")
            escribir(b"/salir\r")
            self.assertEqual(proceso.wait(timeout=5), 0)

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


    def test_selector_desde_entorno_y_cancelacion(self):
        with tempfile.TemporaryDirectory() as raiz:
            base = Path(raiz)
            for nombre in ("a uno", "b dos"):
                carpeta = base / nombre / ".harwiff"
                carpeta.mkdir(parents=True)
                (carpeta / "harness.json").write_text('{"esquema":"wifi-proyecto/v1","cliente":"demo"}')
            with terminal(raiz) as (proceso, esperar, escribir):
                esperar("Sin proyecto")
                escribir(b"/proyectos\r")
                esperar("Proyectos en")
                esperar("b dos")
                escribir(b"\x1b[B\r")
                esperar("Proyecto abierto")
                esperar("b dos")
                escribir(b"/proyectos\r")
                esperar("b dos (activo)")
                escribir(b"\x1b")
                esperar("harwiff >")
                escribir(b"/proyectos\r")
                esperar("b dos (activo)")
                escribir(b"\x1b[A")
                esperar("a uno")
                (base / "a uno/.harwiff/harness.json").unlink()
                escribir(b"\r")
                esperar("El proyecto ya no está disponible")
                self.assertFalse((base / "a uno/.harwiff/harness.json").exists())
                escribir(b"/proyectos\r")
                esperar("b dos (activo)")
                escribir(b"\x1b")
                esperar("harwiff >")
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)

    def test_selector_protege_cambio_con_agente_activo(self):
        with tempfile.TemporaryDirectory() as raiz:
            base = Path(raiz)
            primera = base / "a"
            for carpeta in (primera, base / "b"):
                carpeta.mkdir()
                (carpeta / "harness.json").write_text('{"esquema":"wifi-proyecto/v1","cliente":"demo"}')
            with terminal(primera) as (proceso, esperar, escribir):
                esperar("Proyecto abierto")
                escribir(b"Consulta de prueba\r")
                esperar("trabajando")
                escribir(b"\x1b")
                esperar("harwiff >")
                escribir(b"/proyectos ..\r")
                esperar("a (activo)")
                escribir(b"\x1b[B\r")
                esperar("Espera a que termine el agente")
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)


if __name__ == "__main__":
    unittest.main()
