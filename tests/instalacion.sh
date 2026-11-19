#!/usr/bin/env bash
set -euo pipefail
artefactos="${1:?Indica la URL de la release}"
temporal="$(mktemp -d)"
trap 'rm -rf -- "$temporal"' EXIT
export HARWIFF_DATA_DIR="$temporal/data" HARWIFF_BIN_DIR="$temporal/bin"
curl -fsSL "$artefactos/install.sh" -o "$temporal/installer"
HARWIFF_RELEASE_BASE="$artefactos" bash "$temporal/installer"
ejecutable="$HARWIFF_BIN_DIR/harwiff"
instalado="$(readlink -f "$HARWIFF_DATA_DIR/actual")"
python="$instalado/python/bin/python3"
version="$("$ejecutable" --version)"
"$python" -B - "$instalado/app" "$version" "$temporal/installer" <<'VERSION_TEST'
import json
import re
import sys
from pathlib import Path
app = Path(sys.argv[1])
info = json.loads((app / "build-info.json").read_text())
assert info["version"] == json.loads((app / "package.json").read_text())["version"]
assert re.fullmatch(r"[a-f0-9]{40}", info["commit"])
assert f'version="v{info["version"]}"' in Path(sys.argv[3]).read_text()
assert info["canal"] in ("desarrollo", "estable")
esperada = f'Harwiff {info["version"]} · {info["canal"]} · {info["commit"][:12]}'
if info["cambiosLocales"]:
    esperada += " · cambios locales"
assert sys.argv[2] == esperada
print(esperada)
VERSION_TEST
mkdir -- "$temporal/tui"
"$python" -B - "$ejecutable" "$(dirname -- "$0")/terminal.py" "$temporal/tui" <<'TUI_TEST'
from pathlib import Path
from runpy import run_path
import sys

ejecutable, pruebas, carpeta = map(Path, sys.argv[1:])
terminal = run_path(str(pruebas))["terminal"]

with terminal(carpeta, ejecutable=ejecutable, filas=24, columnas=80) as (proceso, esperar, escribir):
    esperar("> Abrir proyecto")
    escribir(b"\x1b[B\x1b[B\r")
    esperar("> Agentes")
    escribir(b"\x1b[B\r")
    esperar("Generar muestra sintética")
    escribir(b"\x1b[B\r")
    esperar("Ver en Auditoría")
    assert len(list((carpeta / ".harwiff" / "informes").glob("*.json"))) == 1
    escribir(b"\x1b")
    esperar("> Diagnóstico")
    escribir(b"\x03")
    esperar("\x1b[?1049l")
    assert proceso.wait(timeout=5) == 0

print("Menú y diagnóstico sintético verificados desde el comando instalado.")
TUI_TEST
mkdir "$temporal/path-reducido"
# Ejecuta el lector incluido y el DTO incluso con PATH sin utilidades de red.
PATH="$temporal/path-reducido" "$python" -I -B "$instalado/app/wireless_linux.py" inventory \
  | "$python" -B -c 'import json,sys; r=json.load(sys.stdin); assert r["data"].keys() | r["errors"].keys() == {"nl80211_interface","nl80211_wiphy","nl80211_reg"}'
leer_perfil() {
  PATH="$temporal/path-reducido" "$python" -B "$instalado/app/entorno.py" adaptadores-perfil
}
leer_perfil > "$temporal/perfil-sin-utilidades.json"
for nombre in iw ethtool; do
  cat > "$temporal/path-reducido/$nombre" <<'SH'
#!/bin/sh
printf '%s\n' "$0" >> "$HARWIFF_PRUEBA_UTILIDADES"
exit 1
SH
  chmod +x "$temporal/path-reducido/$nombre"
done
HARWIFF_PRUEBA_UTILIDADES="$temporal/llamadas" leer_perfil > "$temporal/perfil-con-utilidades.json"
test ! -e "$temporal/llamadas"
"$python" -B - "$temporal/perfil-sin-utilidades.json" "$temporal/perfil-con-utilidades.json" <<'PYTEST'
import json
import sys
perfiles = [json.load(open(ruta)) for ruta in sys.argv[1:]]
for perfil in perfiles:
    assert perfil.pop("observedAt")
    assert perfil["schema"] == "harwiff-adapter-inventory/v1"
    assert perfil["mock"]["id"] == "mock"
assert perfiles[0] == perfiles[1]
PYTEST
proyecto="$temporal/proyecto nuevo"
printf '%s\n' '/salir' | "$ejecutable" "$proyecto" > "$temporal/arranque"
grep -q 'Sin proyecto' "$temporal/arranque"
test ! -e "$proyecto"
mkdir -- "$proyecto"
(cd "$proyecto" && printf '%s\n' '/salir' | "$ejecutable" > "$temporal/sin-proyecto")
test ! -e "$proyecto/.harwiff"
printf '%s\n' '/init' '/nueva registro Prueba de notas' '/guardar Nota de instalación' '/contexto' \
  '/diagnostico demo' '/alcance set --ssid "Red de laboratorio"' \
  '/adaptador detalle mock' '/adaptador usar mock' '/alcance ver' '/auditoria' '/salir' \
  | "$ejecutable" "$proyecto" > "$temporal/salida"
test -f "$proyecto/.harwiff/harness.json"
test ! -e "$proyecto/.harwiff/app.py"
test ! -e "$proyecto/.harwiff/harness"
test ! -e "$proyecto/harness.json"
grep -q 'Nota de instalación' "$proyecto/.harwiff/sesiones/registro/REGISTRO.md"
grep -q 'Contexto de la sesión registro' "$temporal/salida"
grep -q 'Mock · Simulado' "$temporal/salida"
grep -q 'Adaptador seleccionado: mock' "$temporal/salida"
grep -q '"preflightPassed": true' "$temporal/salida"
estado=0
printf '%s\n' '/alcance set --ssid LAB_TEST_AP --canales 6' '/agente Revisar el fixture' '/config' '/salir' \
  | env -u OPENAI_API_KEY -u DBUS_SESSION_BUS_ADDRESS -u FOUNDRY_API_KEY "$ejecutable" "$proyecto" \
    > "$temporal/sin-conexion" 2> "$temporal/error-conexion" || estado=$?
test "$estado" -eq 1
grep -qx 'Proveedor LLM · Sin modelo configurado' "$temporal/sin-conexion"
grep -q 'Proveedor de /agente: sin configurar' "$temporal/sin-conexion"
grep -q 'Conecta un proveedor con /connect' "$temporal/error-conexion"
! grep -q '^Error:' "$temporal/sin-conexion"
test ! -e "$proyecto/.harwiff/agentes"
cp -- "$(dirname -- "$0")/fixtures/connect-openai.mjs" "$temporal/openai-fixture.mjs"
printf '%s\n' '/model gpt-4.1-mini' '/agente Revisar el fixture' '/salir' \
  | env OPENAI_API_KEY=sk-fixture-harwiff-terminal NODE_OPTIONS="--import=$temporal/openai-fixture.mjs" \
    "$ejecutable" "$proyecto" > "$temporal/agente"
grep -q 'OpenAI · gpt-4.1-mini' "$temporal/agente"
grep -q 'observar_entorno · .*ALLOWED' "$temporal/agente"
grep -q 'Conclusión basada en el fixture simulado.' "$temporal/agente"
grep -q 'Sesión completada.' "$temporal/agente"
"$ejecutable" proyectos --json "$temporal" | grep -q '"nombre": "proyecto nuevo"'
printf '%s\n' "/proyectos $temporal" '/salir' | "$ejecutable" | grep 'proyecto nuevo · demo'
printf '%s\n' 'agent harwiff' '/volver' '/salir' | "$ejecutable" "$proyecto" | grep 'Conclusión basada en el fixture simulado.'
(cd "$proyecto" && printf '%s\n' '/salir' | "$ejecutable" > "$temporal/reapertura")
grep -q 'Actividad reciente del proyecto' "$temporal/reapertura"
grep -q 'Adaptador: mock' "$temporal/reapertura"
grep -Eq 'Agente agente-.* · completed' "$temporal/reapertura"
destino_previo="$(readlink "$HARWIFF_DATA_DIR/actual")"
mkdir "$temporal/danado"
printf 'archivo dañado\n' > "$temporal/danado/harwiff-linux-x86_64.tar.gz"
curl -fsSL "$artefactos/SHA256SUMS" -o "$temporal/danado/SHA256SUMS"
if HARWIFF_RELEASE_BASE="file://$temporal/danado" bash "$temporal/installer"; then
  echo "Un paquete dañado fue instalado." >&2
  exit 1
fi
test "$(readlink "$HARWIFF_DATA_DIR/actual")" = "$destino_previo"
