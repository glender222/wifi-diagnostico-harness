"""Inicializa y reanuda un proyecto local de diagnóstico Wi-Fi."""

import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

import fcntl

FUENTE = Path(__file__).resolve().parent
RAIZ = FUENTE
CLIENTES = ("chatgpt", "opencode", "azure-foundry", "demo")
ESQUEMA = "wifi-proyecto/v1"


def escribir(ruta, contenido):
    ruta.write_text(contenido, encoding="utf-8")


def leer(ruta):
    return ruta.read_text(encoding="utf-8")


def iniciar(destino, cliente):
    destino = destino.expanduser().absolute()
    if destino.is_symlink() or (destino.exists() and
                               (not destino.is_dir() or any(destino.iterdir()))):
        raise ValueError("Elige una carpeta nueva o vacía.")
    destino.parent.mkdir(parents=True, exist_ok=True)
    reglas = FUENTE / "AGENTS.proyecto.md"
    if not reglas.is_file():
        raise ValueError("Usa el app.py del harness original para iniciar otro proyecto.")

    with TemporaryDirectory(prefix=".wifi-init-", dir=destino.parent) as temporal:
        nuevo = Path(temporal) / "proyecto"
        codigo = nuevo / "harness"
        codigo.mkdir(parents=True)
        (nuevo / "sesiones").mkdir()
        shutil.copyfile(__file__, nuevo / "app.py")
        shutil.copyfile(reglas, nuevo / "AGENTS.md")
        archivos = ["wifi.py", "diagnostico.py", "requirements-opensandbox.txt"]
        if cliente == "azure-foundry":
            archivos.append("foundry.py")
        for archivo in archivos:
            shutil.copyfile(FUENTE / archivo, codigo / archivo)
        escribir(nuevo / "harness.json", json.dumps(
            {"esquema": ESQUEMA, "cliente": cliente}, indent=2
        ) + "\n")
        escribir(nuevo / ".gitignore", "__pycache__/\n.venv/\n.env\n")
        nuevo.rename(destino)

    print(f"Proyecto creado en {destino}")
    print(f"Cliente del proyecto: {cliente}")
    print("Dentro de la carpeta: python3 app.py nueva mi-sesion --objetivo 'Revisar conectividad'.")


def leer_config():
    archivo = RAIZ / "harness.json"
    if not archivo.is_file():
        raise ValueError("Inicializa una carpeta con app.py iniciar y usa su copia de app.py.")
    config = json.loads(leer(archivo))
    if (not isinstance(config, dict) or config.get("esquema") != ESQUEMA
            or config.get("cliente") not in CLIENTES):
        raise ValueError("harness.json no contiene una configuración válida.")
    return config


def carpeta_sesion(identificador):
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", identificador):
        raise ValueError("Usa un ID con letras minúsculas, números, guiones o guiones bajos.")
    return RAIZ / "sesiones" / identificador


def crear_sesion(carpeta, objetivo):
    objetivo = objetivo.strip()
    if not objetivo:
        raise ValueError("Escribe el objetivo de la sesión.")
    if carpeta.exists() or carpeta.is_symlink():
        raise ValueError(f"La sesión {carpeta.name} ya existe.")
    with TemporaryDirectory(prefix=".nueva-", dir=carpeta.parent) as temporal:
        nueva = Path(temporal) / "sesion"
        (nueva / "informes").mkdir(parents=True)
        escribir(nueva / "OBJETIVO.md", f"# {carpeta.name}\n\n{objetivo}\n")
        escribir(nueva / "REGISTRO.md", "# Registro de la sesión\n")
        nueva.rename(carpeta)
    print(f"Sesión creada. Para retomarla: python3 app.py abrir {carpeta.name}")


def agregar_nota(carpeta, nota):
    nota = nota.strip()
    if not nota:
        raise ValueError("La nota está vacía.")
    marca = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with (carpeta / "REGISTRO.md").open("a", encoding="utf-8") as archivo:
        fcntl.flock(archivo, fcntl.LOCK_EX)
        archivo.write(f"\n## {marca}\n\n{nota}\n")
        archivo.flush()


def contexto(carpeta, cliente):
    registro = carpeta / "REGISTRO.md"
    with registro.open(encoding="utf-8") as archivo:
        fcntl.flock(archivo, fcntl.LOCK_SH)
        notas = archivo.read()
    informes = sorted(carpeta.joinpath("informes").glob("*.json"))
    partes = [
        f"# Contexto de la sesión {carpeta.name}\n\nCliente del proyecto: {cliente}",
        leer(RAIZ / "AGENTS.md"),
        leer(carpeta / "OBJETIVO.md"),
        notas,
    ]
    for informe in informes:
        partes.append(f"## Informe {informe.name}\n\n```json\n{leer(informe).strip()}\n```")
    return "\n\n".join(parte.strip() for parte in partes)


def diagnosticar(carpeta, args):
    comando = [sys.executable, "-B", str(RAIZ / "harness" / "wifi.py"), "--motor", args.motor]
    if args.demo:
        comando.append("--demo")
    if args.interfaz:
        comando.extend(["--interfaz", args.interfaz])
    if args.denegar_egreso:
        comando.append("--denegar-egreso")
    resultado = subprocess.run(comando, stdout=subprocess.PIPE, text=True, check=True)
    informe = json.loads(resultado.stdout)
    nombre = f"{datetime.now(timezone.utc):%Y%m%dT%H%M%S}-{uuid4().hex[:12]}.json"
    informes = carpeta / "informes"
    with TemporaryDirectory(prefix=".informe-", dir=informes) as temporal:
        archivo = Path(temporal) / nombre
        escribir(archivo, resultado.stdout)
        archivo.rename(informes / nombre)
    agregar_nota(carpeta, f"Informe `informes/{nombre}` guardado. Origen: {informe['origen']}.")
    print(f"Informe guardado en {informes / nombre}")


def explicar_con_foundry(carpeta, cliente):
    if cliente != "azure-foundry":
        raise ValueError("Este comando requiere un proyecto iniciado con azure-foundry.")
    from harness.foundry import explicar

    mensajes = [
        {"role": "system", "content": (
            "Ayuda con un diagnóstico Wi-Fi de solo lectura. Distingue observaciones, "
            "datos simulados y pendientes. Da una nota con Qué hice, Evidencia y Próximo paso."
        )},
        {"role": "user", "content": contexto(carpeta, cliente)},
    ]
    print(explicar(mensajes))


def main():
    global RAIZ
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--proyecto", type=Path, default=FUENTE)
    comandos = parser.add_subparsers(dest="accion", required=True)
    inicio = comandos.add_parser("iniciar", help="Crea una carpeta de proyecto.")
    inicio.add_argument("carpeta", type=Path)
    inicio.add_argument("--cliente", choices=CLIENTES, default="chatgpt")
    comandos.add_parser("sesiones", help="Lista las sesiones del proyecto.")
    nueva = comandos.add_parser("nueva", help="Crea una sesión con su propio registro.")
    nueva.add_argument("id")
    nueva.add_argument("--objetivo", required=True)
    comandos.add_parser("abrir", help="Muestra reglas, notas e informes de la sesión.").add_argument("id")
    guardar = comandos.add_parser("guardar", help="Agrega una nota a la sesión.")
    guardar.add_argument("id")
    entrada = guardar.add_mutually_exclusive_group()
    entrada.add_argument("--nota")
    entrada.add_argument("--archivo", type=Path)
    diagnostico = comandos.add_parser("diagnosticar", help="Guarda un informe Wi-Fi depurado.")
    diagnostico.add_argument("id")
    origen = diagnostico.add_mutually_exclusive_group()
    origen.add_argument("--demo", action="store_true")
    origen.add_argument("--interfaz")
    diagnostico.add_argument("--denegar-egreso", action="store_true")
    diagnostico.add_argument("--motor", choices=("local", "opensandbox"), default="local")
    comandos.add_parser("explicar", help="Consulta el deployment de un proyecto Azure Foundry.").add_argument("id")
    args = parser.parse_args()
    RAIZ = args.proyecto.resolve()

    try:
        if args.accion == "iniciar":
            iniciar(args.carpeta, args.cliente)
            return 0
        cliente = leer_config()["cliente"]
        if args.accion == "sesiones":
            for sesion in sorted((RAIZ / "sesiones").iterdir()):
                if not sesion.is_symlink() and (sesion / "REGISTRO.md").is_file():
                    print(sesion.name)
            return 0

        carpeta = carpeta_sesion(args.id)
        if args.accion == "nueva":
            crear_sesion(carpeta, args.objetivo)
            return 0
        if carpeta.is_symlink() or not (carpeta / "REGISTRO.md").is_file():
            raise ValueError(f"No existe la sesión {args.id}.")

        if args.accion == "abrir":
            print(contexto(carpeta, cliente))
        elif args.accion == "guardar":
            if args.archivo is not None:
                nota = leer(args.archivo)
            elif args.nota is not None:
                nota = args.nota
            elif sys.stdin.isatty():
                raise ValueError("Usa --nota, --archivo o pasa la nota por stdin.")
            else:
                nota = sys.stdin.read()
            agregar_nota(carpeta, nota)
            print(f"Registro actualizado en {carpeta / 'REGISTRO.md'}")
        elif args.accion == "diagnosticar":
            diagnosticar(carpeta, args)
        elif args.accion == "explicar":
            explicar_con_foundry(carpeta, cliente)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
