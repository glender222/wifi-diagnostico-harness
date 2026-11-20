"""Regresiones del arranque y la salida de Harwiff en una terminal real."""

import errno
import fcntl
import json
import os
import pty
import select
import signal
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
def terminal(carpeta, env=None, destino=None, filas=28, columnas=110, ejecutable=None):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", filas, columnas, 0, 0))
    comando = [str(ejecutable)] if ejecutable else ["node", str(FUENTE)]
    if destino is not None:
        comando.append(str(destino))
    proceso = subprocess.Popen(comando, cwd=carpeta, stdin=slave, stdout=slave, stderr=slave,
                               env=TerminalTest.entorno_local() if env is None else env)
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

    def redimensionar(filas, columnas):
        captura.clear()
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", filas, columnas, 0, 0))
        proceso.send_signal(signal.SIGWINCH)

    escribir.redimensionar = redimensionar
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
    @staticmethod
    def abrir_comandos(esperar, escribir):
        esperar("? ayuda")
        escribir(b"?")
        esperar("Consola de comandos")
        escribir(b"\x1b[B\r")
        esperar("harwiff >")

    @staticmethod
    def descartar_inicio(esperar, escribir):
        esperar("Abrir proyecto")
        TerminalTest.abrir_comandos(esperar, escribir)

    @staticmethod
    def abrir_agente_guardado(esperar, escribir, objetivo):
        escribir(b"\t")
        esperar("Abrir sesión guardada")
        escribir(b"\x1b[B" * 2 + b"\r")
        esperar("Sesiones de agente guardadas")
        esperar(objetivo)
        escribir(b"\r")

    def test_menus_alcance_preflight_diagnostico_y_auditoria(self):
        with tempfile.TemporaryDirectory() as raiz:
            base = Path(raiz)
            python = base / "python-fixture"
            python.write_text("""#!/bin/sh
case "$*" in
    *adaptadores-perfil) echo '{"status":"complete","devices":[],"warnings":[]}' ;;
    *) exec python3 "$@" ;;
esac
""")
            python.chmod(0o700)
            env = {**self.entorno_local(), "WIFI_PYTHON": str(python), "NO_COLOR": "1"}
            with terminal(base, env, filas=24, columnas=80) as (proceso, esperar, escribir):
                def paso(teclas, texto):
                    escribir(teclas)
                    return esperar(texto)

                inicial = esperar("> Abrir proyecto")
                self.assertNotIn(b"\x1b[96m", inicial)
                self.assertFalse((base / ".harwiff").exists())
                paso(b"\x1b[B" * 2 + b"\r", "> Agentes")
                datos = base / ".harwiff"
                control = datos / "control-wifi.json"
                paso(b"\x1b[B" * 2 + b"\r", "> Mock")
                paso(b"\r", "> Usar este adaptador")
                paso(b"\r", "Preflight bloqueado")
                self.assertFalse(control.exists())
                paso(b"\x1b", "> Usar este adaptador")
                paso(b"\x1b", "> Mock")
                paso(b"\x1b", "> Adaptadores")
                paso(b"\x1b[B\r", "> Editar alcance")
                paso(b"\r", "> SSID")
                paso(b"\r", "SSID autorizados")
                paso(b"LAB_TEST_AP\r", "LAB_TEST_AP")
                paso(b"\x1b[B" * 3 + b"\r", "Alcance guardado")
                paso(b"\x1b", "> Alcance")
                paso(b"\x1b[A\r", "> Mock")
                paso(b"\r", "> Usar este adaptador")
                paso(b"\r", "Adaptador seleccionado")
                self.assertEqual(json.loads(control.read_text())["adapter"]["id"], "mock")
                paso(b"\x1b[A\r", "Ejecutar en modo simulado")
                paso(b"\r", "Ver en Auditoría")
                paso(b"\r", "Ver registro JSON")
                paso(b"\r", "Evidencia")
                self.assertEqual(len(list((datos / "informes").glob("*.json"))), 1)
                paso(b"\x1b", "Ver registro JSON")
                paso(b"\x1b", "> Diagnóstico")

                id_pendiente = f"{int(time.time() * 1000) + 1000}-00000000-0000-0000-0000-000000000000"
                ruta_pendiente = datos / "auditoria" / id_pendiente
                ruta_pendiente.mkdir()
                (ruta_pendiente / "solicitud.json").write_text(json.dumps({
                    "operacion": "ejecución pendiente", "inicio": "2026-11-18T20:00:00.000Z",
                }))
                paso(b"\x1b[B" * 4 + b"\r", "pendiente de cierre")
                paso(b"\r", "Ver registro JSON")
                paso(b"\x1b", "pendiente de cierre")
                paso(b"\x1b", "> Auditoría")
                paso(b"\x03", "\x1b[?1049l")
                self.assertEqual(proceso.wait(timeout=5), 0)

    def test_menu_agente_credencial_borrador_y_tamanos(self):
        with tempfile.TemporaryDirectory() as raiz:
            base = Path(raiz)
            env = self.entorno_openai(pausa="5500")
            secreto = env.pop("OPENAI_API_KEY").encode()
            subprocess.run(["node", str(FUENTE)], cwd=base, env=env, check=True, capture_output=True,
                           input=b"/init\n/alcance set --ssid LAB_TEST_AP\n/adaptador usar mock\n/salir\n")
            with terminal(base, env, filas=24, columnas=120) as (proceso, esperar, escribir):
                def paso(teclas, texto):
                    escribir(teclas)
                    return esperar(texto)

                esperar("> Agentes")
                paso(b"\x1b[B" * 4 + b"\r", "Modelo para sesiones nuevas")
                paso(b"\x1b[B\r", "Conectar proveedor LLM")
                paso(b"\r", "entrada oculta")
                captura = paso(b"\x1b[200~" + secreto + b"\x1b[201~", "•")
                self.assertNotIn(secreto, captura)
                paso(b"\r", "Filtrar por ID")
                paso(b"gpt-4\r", "gpt-4.1-mini")
                esperar("> Conexiones de proveedor")
                paso(b"\x1b", "> Modelo y ajustes")
                paso(b"\x1b[A" * 4 + b"\r", "> Nueva conversación")
                paso(b"\r", "¿Qué quieres revisar")
                paso(b"Revisar fixture\r", "Texto parcial del proveedor")
                esperar("Actividad")
                paso(b"\x1b", "Abrir sesión guardada")
                paso(b"\x1b", "1 agente trabajando")
                paso(b"\x03", "Hay trabajo en curso")
                paso(b"\x1b", "> Agentes")
                paso(b"\r", "Nueva conversación")
                paso(b"\x1b[B" * 2 + b"\r", "> Revisar fixture")
                paso(b"\r", "Mensaje >")
                paso(b"Conservar borrador", "Conservar borrador")
                paso(b"\t", "Acciones del agente")
                paso(b"\r", "Detalles de operaciones")
                paso(b"\r", "Parámetros")
                paso(b"\x1b", "Detalles de operaciones")
                paso(b"\x1b", "Acciones del agente")
                paso(b"\x1b", "Conservar borrador")
                paso(b"\x1b", "Abrir sesión guardada")
                paso(b"\x1b[B" * 2 + b"\r", "> Revisar fixture")
                paso(b"\r", "Conservar borrador")

                escribir.redimensionar(15, 59)
                esperar("Se requieren 60×16")
                escribir.redimensionar(16, 60)
                captura = esperar("Conservar borrador")
                self.assertNotIn(b"Actividad", captura)
                esperar("Tab acciones")
                paso(b"\t", "Detener turno")
                paso(b"\x1b[B" * 2 + b"\r", "Solo consulta")
                paso(b"\x1b", "Abrir sesión guardada")
                paso(b"\x1b", "> Agentes")
                paso(b"\x03", "\x1b[?1049l")
                self.assertEqual(proceso.wait(timeout=8), 0)

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
            env = self.entorno_local()
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
                self.assertNotIn(secreto, esperar("OpenAI API conectado · Credencial: Secret Service"))
                self.assertEqual(almacen.read_text(), "presente")
                self.assertEqual(json.loads((proyecto / ".harwiff/harness.json").read_text())["llm"],
                                 {"proveedor": None})
                esperar("Modelo para sesiones nuevas")
                escribir(b"gpt-5")
                esperar("Filtrar por ID")
                escribir(b"\r")
                esperar("Modelo OpenAI guardado: gpt-5-mini")
                datos = (proyecto / ".harwiff/harness.json").read_bytes()
                self.assertNotIn(secreto, datos)
                self.assertEqual(json.loads(datos)["llm"], {"proveedor": "openai", "openaiModelId": "gpt-5-mini"})
                escribir(b"/connect test\r")
                esperar("OpenAI Responses y function calling verificados")
                esperar("Tokens de conectividad · entrada 8, salida 2, total 10")
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)

            with terminal(proyecto, env) as (proceso, esperar, escribir):
                self.abrir_comandos(esperar, escribir)
                escribir(b"/connect list\r")
                esperar("credencial en Secret Service · modelo gpt-5-mini · seleccionado")
                escribir(b"/model\r")
                self.assertNotIn(b"entrada oculta", esperar("Modelo para sesiones nuevas"))
                escribir(b"gpt-4")
                esperar("Filtrar por ID")
                escribir(b"\r")
                esperar("Modelo OpenAI guardado: gpt-4.1-mini")
                self.assertEqual(json.loads((proyecto / ".harwiff/harness.json").read_text())["llm"]["openaiModelId"], "gpt-4.1-mini")
                escribir(b"/connect\r")
                esperar("Conectar proveedor LLM")
                escribir(b"\r")
                esperar("modelo gpt-4.1-mini")
                escribir(b"\x1b")
                esperar("harwiff >")
                self.assertTrue(almacen.exists())
                escribir(b"/agente Revisar el fixture autorizado\r")
                esperar("Sesión iniciada")
                [agente] = (proyecto / ".harwiff/agentes").iterdir()
                self.abrir_agente_guardado(esperar, escribir, "Revisar el fixture autorizado")
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
                esperar("OpenAI API · sin credencial · modelo gpt-4.1-mini · seleccionado")
                escribir(b"/agente Revisar el fixture\r")
                esperar("Falta la credencial de OpenAI")
                self.assertEqual(list((proyecto / ".harwiff/agentes").iterdir()), [agente])
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)

            self.assertNotIn(secreto, log_terminal.read_bytes())

    def test_streaming_y_modelo_fijado_durante_cambio(self):
        preload = (Path(__file__).parent / "fixtures" / "connect-openai.mjs").resolve().as_uri()
        env = self.entorno_local()
        env.update(OPENAI_API_KEY="sk-fixture-harwiff-terminal", NODE_OPTIONS=f"--import={preload}",
                   HARWIFF_FIXTURE_STREAM_DELAY="1800")
        with tempfile.TemporaryDirectory() as raiz:
            proyecto = Path(raiz) / "prueba"
            with terminal(raiz, env) as (proceso, esperar, escribir):
                self.configurar_sesion_mock(esperar, escribir)
                escribir(b"/model gpt-4.1-mini\r")
                esperar("Modelo OpenAI guardado: gpt-4.1-mini")
                escribir(b"/agente Sesion original\r")
                esperar("Sesión iniciada")
                [original] = (proyecto / ".harwiff/agentes").iterdir()
                self.abrir_agente_guardado(esperar, escribir, "Sesion original")
                datos = esperar("Texto parcial del proveedor")
                self.assertNotIn(b"Cierre del proveedor", datos)
                escribir(b"Conserva los datos observados\rDistingue evidencia e hipotesis\r")
                esperar("Distingue evidencia e hipotesis")
                self.assertEqual(json.loads((original / "sesion.json").read_text())["status"], "running")
                escribir(b"/salir\r")
                esperar("harwiff >")
                self.assertIsNone(proceso.poll())
                escribir(b"/model\r")
                esperar("Modelo para sesiones nuevas")
                escribir(b"gpt-5")
                esperar("Filtrar por ID")
                escribir(b"\r")
                esperar("Modelo OpenAI guardado: gpt-5-mini")
                escribir(b"/agente Sesion con otro modelo\r")
                esperar("· OpenAI · gpt-5-mini")
                [nueva] = [carpeta for carpeta in (proyecto / ".harwiff/agentes").iterdir() if carpeta != original]
                self.assertEqual(json.loads((original / "sesion.json").read_text())["modelId"], "gpt-4.1-mini")
                self.assertEqual(json.loads((nueva / "sesion.json").read_text())["modelId"], "gpt-5-mini")
                limite = time.monotonic() + 8
                while any(json.loads((item / "sesion.json").read_text())["status"] != "completed"
                          for item in (original, nueva)):
                    self.assertLess(time.monotonic(), limite)
                    time.sleep(0.05)
                escribir(b"/diagnostico demo\r")
                esperar("Informe guardado")
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)
            [primer] = (original / "turnos").iterdir()
            eventos = json.loads((primer / "eventos.json").read_text())
            incorporados = {evento["messageId"] for evento in eventos
                            if evento["type"] == "user_state" and evento["status"] == "incorporated"}
            self.assertEqual([evento["text"] for evento in eventos if evento["type"] == "user" and evento["messageId"] in incorporados],
                             ["Sesion original", "Conserva los datos observados", "Distingue evidencia e hipotesis"])
            with terminal(proyecto, env) as (proceso, esperar, escribir):
                self.abrir_comandos(esperar, escribir)
                esperar("OpenAI / gpt-5-mini")
                esperar("Adaptador: mock | Alcance: 1 SSID, 1 canal(es) | Preflight: OK")
                esperar("Actividad reciente del proyecto")
                esperar("Configuración · modelo predeterminado")
                esperar("Diagnóstico")
                datos = esperar(f"{original.name} · completed")
                self.assertNotIn(b"Conserva los datos observados", datos)
                self.assertNotIn(b"sk-fixture-harwiff-terminal", datos)
                escribir(f"agent harwiff {original.name}\r".encode())
                esperar(f"agente/{original.name} >")
                escribir(b"/detalle\r")
                esperar("Detalles de operaciones")
                escribir(b"\r")
                esperar("Parámetros · {}")
                escribir(b"\x1b")
                esperar(f"agente/{original.name} >")
                escribir(b"Confirma lo que guardaste\r")
                esperar("Texto parcial del seguimiento")
                esperar("Cierre del seguimiento")
                esperar("Sesión completada.")
                escribir(b"/volver\r")
                esperar("harwiff >")
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)
            self.assertEqual(len(list((original / "turnos").iterdir())), 2)
            self.assertEqual(json.loads((original / "sesion.json").read_text())["modelId"], "gpt-4.1-mini")

    def test_connect_foundry_reutiliza_configuracion(self):
        env = self.entorno_local()
        env.update(FOUNDRY_HOST="fixture.openai.azure.com", FOUNDRY_DEPLOYMENT="modelo-fixture",
                   FOUNDRY_API_KEY="clave-foundry-fixture")
        with tempfile.TemporaryDirectory() as raiz, terminal(raiz, env) as (proceso, esperar, escribir):
            self.descartar_inicio(esperar, escribir)
            escribir(b"/proyecto prueba\r")
            esperar("Proyecto creado")
            escribir(b"/connect\r")
            esperar("Azure AI Foundry")
            escribir(b"\x1b[B\r")
            esperar("Editar conexión de Foundry")
            escribir(b"\x1b[B")
            esperar("→ Editar conexión de Foundry")
            escribir(b"\r")
            esperar("Dominio Azure")
            escribir(b"\r")
            esperar("Deployment [modelo-fixture]")
            escribir(b"\r")
            esperar("Azure AI Foundry configurado")
            escribir(b"/model azure-foundry/modelo-fixture\r")
            esperar("Modelo guardado: modelo-fixture")
            datos = (Path(raiz) / "prueba" / ".harwiff/harness.json").read_text()
            self.assertNotIn("clave-foundry-fixture", datos)
            self.assertEqual(json.loads(datos)["llm"], {"proveedor": "azure-foundry"})
            escribir(b"/salir\r")
            self.assertEqual(proceso.wait(timeout=5), 0)

    def configurar_sesion_mock(self, esperar, escribir):
        self.descartar_inicio(esperar, escribir)
        escribir(b"/proyecto prueba\r")
        esperar("Proyecto creado")
        escribir(b"/alcance set --ssid LAB_TEST_AP --canales 6\r")
        esperar("Alcance guardado")
        escribir(b"/adaptador usar mock\r")
        esperar("Adaptador: mock | Alcance: 1 SSID, 1 canal(es) | Preflight: OK")

    @staticmethod
    def entorno_local():
        return {clave: valor for clave, valor in os.environ.items()
                if clave not in {"FOUNDRY_HOST", "FOUNDRY_DEPLOYMENT", "FOUNDRY_API_KEY", "OPENAI_API_KEY", "DBUS_SESSION_BUS_ADDRESS"}}

    def test_panel_adaptadores_consulta_actualiza_y_selecciona_mock(self):
        with tempfile.TemporaryDirectory() as raiz:
            base = Path(raiz)
            python = base / "python-fixture"
            cuenta = base / "consultas"
            python.write_text("""#!/usr/bin/env python3
import os, sys
from pathlib import Path
if sys.argv[-1] == "adaptadores-perfil":
    with (Path.cwd() / "consultas").open("a") as archivo:
        archivo.write("consulta\\n")
    print('{"status":"partial","devices":[],"warnings":[]}')
else:
    os.execvp("python3", ["python3", *sys.argv[1:]])
""")
            python.chmod(0o700)
            env = {**self.entorno_local(), "WIFI_PYTHON": str(python)}
            with terminal(base, env, filas=16, columnas=88) as (proceso, esperar, escribir):
                self.descartar_inicio(esperar, escribir)
                escribir(b"/proyecto prueba\r")
                esperar("Proyecto creado")
                datos = base / "prueba/.harwiff"
                control = datos / "control-wifi.json"
                estado_inicial = control.read_bytes() if control.exists() else None
                escribir(b"/adaptador\r")
                esperar("Actualizar inventario")
                escribir(b"\x1b[B")
                esperar("→ Actualizar inventario")
                escribir(b"\r")
                esperar("→ Mock · Simulado")
                self.assertEqual(len(cuenta.read_text().splitlines()), 2)
                escribir(b"\r")
                esperar("Usar este adaptador")
                escribir(b"\r")
                esperar("Define al menos un BSSID o SSID")
                self.assertEqual(control.read_bytes() if control.exists() else None, estado_inicial)
                escribir(b"/adaptador\r")
                esperar("Harwiff / Adaptadores")
                escribir(b"\x1b")
                esperar("harwiff >")
                self.assertEqual(control.read_bytes() if control.exists() else None, estado_inicial)
                escribir(b"/alcance set --ssid LAB_TEST_AP\r")
                esperar("Alcance guardado")
                escribir(b"/adaptador\r")
                esperar("Harwiff / Adaptadores")
                escribir(b"\r")
                esperar("Usar este adaptador")
                escribir(b"\r")
                esperar("Adaptador seleccionado: mock")
                self.assertEqual(json.loads(control.read_text())["adapter"]["id"], "mock")
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)

    def test_panel_fisico_conserva_seleccion_si_dispositivo_desaparece(self):
        with tempfile.TemporaryDirectory() as raiz:
            base = Path(raiz)
            perfil = {
                "status": "partial", "warnings": [], "devices": [{
                    "bus": "usb", "phys": [{
                        "nameNow": "phy1", "phyId": "phy_fixture",
                        "interfaces": [{"ifname": "wlanlab", "ifindex": 4, "interfaceId": "net_fixture",
                                        "legacyAdapterId": "a" * 20}],
                        "connectivity": {"criticality": "critical", "reasons": ["default_route_interface"]},
                        "reservation": {"state": "free"}, "probe": {"warnings": []},
                        "rfkill": {"softBlocked": None, "hardBlocked": None},
                        "capabilities": {"monitor": {"declared": "unknown"}, "concurrency": {"declared": "unknown"}},
                    }],
                }],
            }
            (base / "wifi-fixture.json").write_text(json.dumps(perfil))
            python = base / "python-fixture"
            python.write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
if sys.argv[-1] == "adaptadores-perfil":
    print(Path("wifi-fixture.json").read_text())
elif sys.argv[-1] == "preflight":
    entrada = json.load(sys.stdin)
    if entrada["name"] == "wlanlab":
        assert entrada["observed"]["ifindex"] == 4
        print(json.dumps({
            "code": "adapter_disconnected",
            "preflight": {"ok": False, "errors": ["La interfaz cambió."], "capabilities": []}
        }))
    else:
        lectura, escritura = os.pipe()
        os.write(escritura, json.dumps(entrada).encode())
        os.close(escritura)
        os.dup2(lectura, 0)
        os.close(lectura)
        os.execvp("python3", ["python3", *sys.argv[1:]])
elif sys.argv[-1] == "vincular-inspeccion":
    assert json.load(sys.stdin) == {"name": "wlanlab"}
    adapter_id = "c" * 20 if Path("adaptador-sustituido").exists() else "a" * 20
    identity = "d" * 64 if Path("interfaz-recreada").exists() else "b" * 64
    print(json.dumps({"identity": identity, "adapterId": adapter_id}))
elif sys.argv[-1] == "broker-lectura":
    entrada = json.load(sys.stdin)
    assert entrada["network"] is None
    assert entrada["binding"]["identity"] == ("d" if Path("interfaz-recreada").exists() else "b") * 64
    assert entrada["operation"] == "inspeccionar_enlace"
    print(json.dumps({"version": 1, "origin": "host_readonly", "status": "ok", "reasons": [],
                      "observations": [{"subject": "p1", "field": "ipv4_route", "source": "ip",
                                        "scope": "host", "value": "direct"}]}))
else:
    os.execvp("python3", ["python3", *sys.argv[1:]])
""")
            python.chmod(0o700)
            env = {**self.entorno_openai(), "WIFI_PYTHON": str(python),
                   "HARWIFF_LLM_PROVIDER": "openai", "HARWIFF_LLM_MODEL": "gpt-4.1-mini"}
            with terminal(base, env, filas=18, columnas=105) as (proceso, esperar, escribir):
                self.configurar_sesion_mock(esperar, escribir)
                control = base / "prueba/.harwiff/control-wifi.json"
                previo = control.read_bytes()
                escribir(b"/adaptador\r")
                esperar("Conexión principal")
                escribir(b"\r")
                esperar("→ Seleccionar para Agentes")
                escribir(b"\x1b[B")
                esperar("→ Inspeccionar en solo lectura")
                escribir(b"\r")
                esperar("Solo datos del host")
                escribir(b"\r")
                salida = esperar("Ruta por defecto IPv4 observada")
                self.assertNotIn("¿Qué quieres revisar?".encode(), salida)
                escribir(b"\x1b")
                esperar("Hacer otra pregunta")
                escribir(b"\x1b")
                esperar("Harwiff / Adaptadores")
                self.assertEqual(control.read_bytes(), previo)
                escribir(b"\r")
                esperar("Ver restricciones y motivos")
                escribir(b"\x1b[B" * 3)
                esperar("→ Ver capacidades completas")
                escribir(b"\x1b[B")
                esperar("→ Ver restricciones y motivos")
                escribir(b"\r")
                esperar("Una interfaz del radio sostiene una ruta")
                escribir(b"\x1b")
                esperar("Harwiff / Adaptadores")
                escribir(b"\r")
                esperar("Restringido por la ruta principal")
                escribir(b"\x1b[B" * 2)
                esperar("→ Usar para diagnóstico físico")
                escribir(b"\r")
                esperar("La interfaz cambió.")
                self.assertEqual(control.read_bytes(), previo)
                escribir(b"/adaptador\r")
                esperar("Harwiff / Adaptadores")
                escribir(b"\r")
                esperar("→ Seleccionar para Agentes")
                escribir(b"\r")
                esperar("Adaptador de Agentes guardado · wlanlab")
                original = json.loads(previo)
                con_preferencia = json.loads(control.read_text())
                self.assertEqual(con_preferencia.pop("inspectionAdapter"), {"id": "a" * 20, "name": "wlanlab"})
                original.pop("inspectionAdapter", None)
                self.assertEqual(con_preferencia, original)
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)

            (base / "interfaz-recreada").touch()
            for i in range(12):
                sesion = control.parent / "agentes" / f"fixture-{i:02}"
                sesion.mkdir(parents=True)
                (sesion / "sesion.json").write_text(json.dumps({
                    "modo": "demo", "iniciado": True, "objetivo": f"Sesión anterior {i}",
                }))
            with terminal(base, env, destino="prueba", filas=16, columnas=60) as (_, esperar, escribir):
                esperar("> Agentes")
                escribir(b"\r")
                esperar("> Nueva inspección con wlanlab")
                esperar("Abrir sesión guardada")
                escribir(b"\x1b")
                esperar("> Agentes")
                escribir(b"/")
                esperar("Tab Agentes")
                escribir(b"\x7f\t")
                esperar("→ Nueva inspección con wlanlab")
                esperar("Abrir sesión guardada")
                escribir(b"\r")
                esperar("¿Qué quieres revisar con el agente?")
                escribir(b"Resume las rutas locales\r")
                esperar("Solo datos del host")
                escribir(b"\r")
                esperar("Ruta por defecto IPv4 observada")
                escribir(b"\x1b")
                esperar("Hacer otra pregunta")
                escribir(b"\x1b")
                esperar("→ Nueva inspección con wlanlab")
                escribir(b"\x1b")
                esperar("harwiff >")
                escribir(b"/agente\r")
                esperar("→ Nueva inspección con wlanlab")

            def ejecutar_objetivo():
                return subprocess.run(["node", str(FUENTE), str(base / "prueba")], cwd=base, env=env,
                                      input="/agente Resume las rutas locales\n/salir\n", text=True,
                                      capture_output=True, timeout=15)

            resultado = ejecutar_objetivo()
            self.assertEqual(resultado.returncode, 0, resultado.stderr)
            self.assertIn("Ruta por defecto IPv4 observada", resultado.stdout)
            (base / "adaptador-sustituido").touch()
            resultado = ejecutar_objetivo()
            self.assertEqual(resultado.returncode, 1)
            self.assertIn("La interfaz guardada para Agentes cambió", resultado.stderr)

    def entorno_openai(self, pausa="0"):
        preload = (Path(__file__).parent / "fixtures" / "connect-openai.mjs").resolve().as_uri()
        return {**self.entorno_local(), "OPENAI_API_KEY": "sk-fixture-harwiff-terminal",
                "NODE_OPTIONS": "--import=" + preload, "HARWIFF_FIXTURE_STREAM_DELAY": pausa}

    def test_sesion_mock_detach_continua_y_reabre(self):
        with tempfile.TemporaryDirectory() as raiz:
            proyecto = Path(raiz) / "prueba"
            with terminal(raiz, self.entorno_openai(pausa="1600")) as (proceso, esperar, escribir):
                self.configurar_sesion_mock(esperar, escribir)
                escribir(b"/model gpt-4.1-mini\r")
                esperar("Modelo OpenAI guardado")
                escribir(b"/agente Revisar fixture\r")
                esperar("Sesión iniciada")
                [sesion] = (proyecto / ".harwiff/agentes").iterdir()
                self.abrir_agente_guardado(esperar, escribir, "Revisar fixture")
                esperar(f"agente/{sesion.name} >")
                escribir(b"\x1b")
                esperar("harwiff >")
                esperar("objetivo finalizado")
                datos = json.loads((sesion / "sesion.json").read_text())
                self.assertEqual(datos["status"], "completed")
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)
            with terminal(proyecto, self.entorno_openai(pausa="1600")) as (proceso, esperar, escribir):
                self.abrir_comandos(esperar, escribir)
                esperar(f"{sesion.name} · completed")
                self.abrir_agente_guardado(esperar, escribir, "Revisar fixture")
                esperar("Sesión completada.")
                escribir(b"/salir\r")
                esperar("harwiff >")
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)

    def test_detener_sesion_mock_seleccionada(self):
        with tempfile.TemporaryDirectory() as raiz, terminal(raiz, self.entorno_openai(pausa="1600")) as (proceso, esperar, escribir):
            self.configurar_sesion_mock(esperar, escribir)
            escribir(b"/model gpt-4.1-mini\r")
            esperar("Modelo OpenAI guardado")
            escribir(b"/agente Revisar fixture\r")
            esperar("Sesión iniciada")
            [sesion] = (Path(raiz) / "prueba" / ".harwiff/agentes").iterdir()
            self.abrir_agente_guardado(esperar, escribir, "Revisar fixture")
            esperar(f"agente/{sesion.name} >")
            escribir(b"/detener\r")
            esperar("Sesión cancelada.")
            datos = json.loads((sesion / "sesion.json").read_text())
            self.assertEqual(datos["status"], "cancelled")
            escribir(b"/salir\r")
            esperar("harwiff >")
            escribir(b"/salir\r")
            self.assertEqual(proceso.wait(timeout=5), 0)

    def test_cabecera_del_plano_de_control(self):
        with tempfile.TemporaryDirectory() as raiz, terminal(raiz) as (proceso, esperar, escribir):
            self.descartar_inicio(esperar, escribir)
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
            proyecto.mkdir()
            with terminal(raiz, destino=proyecto) as (proceso, esperar, escribir):
                esperar(f"Inicializar proyecto en {proyecto}")
                self.assertEqual(list(proyecto.iterdir()), [])
                escribir(b"\x1b[A\r")
                esperar("Proyecto creado")
                datos = proyecto / ".harwiff"
                self.assertTrue((datos / "harness.json").is_file())
                self.assertTrue((datos / "AGENTS.md").is_file())
                self.assertTrue((datos / "sesiones").is_dir())
                self.assertFalse((datos / "app.py").exists())
                self.assertFalse((datos / "harness").exists())
                self.assertFalse((proyecto / "harness.json").exists())
                escribir(b"\x04")
                self.assertEqual(proceso.wait(timeout=5), 0)

            with terminal(proyecto) as (proceso, esperar, escribir):
                self.abrir_comandos(esperar, escribir)
                salida = esperar("harwiff >")
                self.assertNotIn(b"Inicializar proyecto en", salida)
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)

    def test_ahora_no_y_reintento_con_init(self):
        with tempfile.TemporaryDirectory() as raiz, terminal(raiz) as (proceso, esperar, escribir):
            self.descartar_inicio(esperar, escribir)
            self.assertEqual(list(Path(raiz).iterdir()), [])
            escribir(b"/init\r")
            esperar("Proyecto creado")
            archivo = Path(raiz) / ".harwiff/harness.json"
            datos = archivo.read_bytes()
            self.assertEqual(json.loads(datos)["llm"], {"proveedor": None})
            escribir(b"/init\r")
            esperar("Proyecto ya inicializado")
            self.assertEqual(archivo.read_bytes(), datos)
            escribir(b"/salir\r")
            self.assertEqual(proceso.wait(timeout=5), 0)

    def test_subcarpeta_es_proyecto_independiente(self):
        with tempfile.TemporaryDirectory() as raiz:
            padre = Path(raiz)
            hijo = padre / "subcarpeta"
            hijo.mkdir()
            heredado = padre / "harness.json"
            contenido = '{"esquema":"wifi-proyecto/v1","cliente":"demo"}'
            heredado.write_text(contenido)
            with terminal(hijo) as (proceso, esperar, escribir):
                esperar("Inicializar esta carpeta")
                escribir(b"\x1b[B\x1b[B\r")
                esperar("Proyecto creado")
                self.assertTrue((hijo / ".harwiff/harness.json").is_file())
                self.assertFalse((padre / ".harwiff").exists())
                self.assertEqual(heredado.read_text(), contenido)
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)
            with terminal(hijo, destino=padre) as (proceso, esperar, escribir):
                self.abrir_comandos(esperar, escribir)
                salida = esperar("harwiff >")
                self.assertNotIn(b"Inicializar proyecto en", salida)
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)

    def test_escape_cancela_y_salir_cierra_desde_pregunta(self):
        with tempfile.TemporaryDirectory() as raiz, terminal(raiz) as (proceso, esperar, escribir):
            self.descartar_inicio(esperar, escribir)
            escribir(b"/proyecto\r")
            esperar("Carpeta [")
            escribir(b"\x1b")
            esperar("harwiff >")
            self.assertEqual(list(Path(raiz).iterdir()), [])
            escribir(b"/proyecto\r")
            esperar("Carpeta [")
            escribir(b"/salir\r")
            self.assertEqual(proceso.wait(timeout=5), 0)


    def test_agente_requiere_proveedor_y_conserva_sesiones_demo_en_consulta(self):
        with tempfile.TemporaryDirectory() as raiz, terminal(raiz, self.entorno_local()) as (proceso, esperar, escribir):
            self.configurar_sesion_mock(esperar, escribir)
            agentes = Path(raiz) / "prueba/.harwiff/agentes"
            escribir(b"/agente Revisar fixture\r")
            esperar("Conecta un proveedor con /connect")
            escribir(b"Consulta directa\r")
            esperar("Conecta un proveedor con /connect")
            self.assertFalse(agentes.exists())
            anterior = agentes / "demo-anterior"
            anterior.mkdir(parents=True)
            (anterior / "sesion.json").write_text(json.dumps({"modo": "demo", "iniciado": True}))
            escribir(b"/salir\r")
            self.assertEqual(proceso.wait(timeout=5), 0)
            with terminal(Path(raiz) / "prueba", self.entorno_local()) as (reabierto, esperar, escribir):
                self.abrir_comandos(esperar, escribir)
                escribir(b"agent harwiff demo-anterior\r")
                esperar("Solo consulta")
                escribir(b"Consulta a una demo anterior\r")
                esperar("Esta sesión está disponible para consulta")
                self.assertFalse((anterior / "turnos").exists())
                escribir(b"/volver\r")
                esperar("harwiff >")
                escribir(b"/salir\r")
                self.assertEqual(reabierto.wait(timeout=5), 0)

    def test_consulta_directa_elige_modelo_y_recibe_respuesta(self):
        with tempfile.TemporaryDirectory() as raiz, terminal(raiz, self.entorno_openai()) as (proceso, esperar, escribir):
            self.configurar_sesion_mock(esperar, escribir)
            agentes = Path(raiz) / "prueba/.harwiff/agentes"
            escribir(b"/agente Probar selector\r")
            datos = esperar("Modelo para sesiones nuevas")
            self.assertNotIn(b"harwiff-demo", datos)
            escribir(b"\x1b")
            esperar("harwiff >")
            self.assertFalse(agentes.exists())
            escribir(b"Consulta directa\r")
            esperar("Modelo para sesiones nuevas")
            escribir(b"\r")
            esperar("Conclusión basada en el fixture simulado.")
            [sesion] = list(agentes.iterdir())
            datos = json.loads((sesion / "sesion.json").read_text())
            self.assertEqual(datos["provider"], "openai")
            self.assertEqual(datos["goal"], "Consulta directa")
            escribir(b"/salir\r")
            esperar("harwiff >")
            escribir(b"/salir\r")
            self.assertEqual(proceso.wait(timeout=5), 0)

    def test_comandos_rapidos_no_usan_el_prefijo_del_menu_anterior(self):
        with tempfile.TemporaryDirectory() as raiz, terminal(raiz, self.entorno_openai()) as (proceso, esperar, escribir):
            self.descartar_inicio(esperar, escribir)
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
            escribir(b"/alcance set --ssid LAB_TEST_AP\r")
            esperar("Alcance guardado")
            escribir(b"/adaptador usar mock\r")
            esperar("Adaptador seleccionado: mock")
            escribir(b"/model gpt-4.1-mini\r")
            esperar("Modelo OpenAI guardado")
            escribir(b"Consulta\r")
            esperar("Esc vuelve a harwiff >")
            [sesion] = (Path(raiz) / "prueba/.harwiff/agentes").iterdir()
            escribir(b"/")
            agente = esperar("Cancelar el turno")
            self.assertNotIn(b"Crear o abrir un proyecto", agente)
            escribir(b"config\r")
            esperar(f"Agente: {sesion.name}")
            escribir(b"/")
            esperar("Cancelar el turno")
            escribir(b"ayuda\r")
            esperar("/volver  Volver del agente al entorno")
            escribir(b"\x1b")
            esperar("harwiff >")
            escribir(b"\t")
            esperar("Abrir sesión guardada")
            escribir(b"\x1b")
            esperar("harwiff >")
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
                self.descartar_inicio(esperar, escribir)
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
                self.abrir_comandos(esperar, escribir)
                escribir(b"/diagnostico demo\r")
                esperar("Informe guardado")
                self.assertTrue(list((carpeta / ".harwiff/informes").glob("*.json")))
                escribir(b"/salir\r")
                self.assertEqual(proceso.wait(timeout=5), 0)

    def test_proyecto_desde_raiz_pide_una_carpeta(self):
        with terminal("/") as (proceso, esperar, escribir):
            self.abrir_comandos(esperar, escribir)
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
                self.descartar_inicio(esperar, escribir)
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
            with terminal(primera, self.entorno_openai(pausa="2800")) as (proceso, esperar, escribir):
                self.abrir_comandos(esperar, escribir)
                escribir(b"/alcance set --ssid LAB_TEST_AP\r")
                esperar("Alcance guardado")
                escribir(b"/adaptador usar mock\r")
                esperar("Adaptador seleccionado: mock")
                escribir(b"/model gpt-4.1-mini\r")
                esperar("Modelo OpenAI guardado")
                escribir(b"Consulta de prueba\r")
                esperar("Texto parcial del proveedor")
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
