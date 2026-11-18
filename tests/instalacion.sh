#!/usr/bin/env bash
set -euo pipefail
artefactos="${1:?Indica la URL de la release}"
temporal="$(mktemp -d)"
trap 'rm -rf -- "$temporal"' EXIT
export HARWIFF_DATA_DIR="$temporal/data" HARWIFF_BIN_DIR="$temporal/bin"
curl -fsSL "$artefactos/install.sh" | HARWIFF_RELEASE_BASE="$artefactos" bash
ejecutable="$HARWIFF_BIN_DIR/harwiff"
"$ejecutable" --version
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
printf '%s\n' '/alcance set --ssid LAB_TEST_AP --canales 6' '/agente Revisar el fixture' '/salir' \
  | env -u OPENAI_API_KEY -u DBUS_SESSION_BUS_ADDRESS -u FOUNDRY_API_KEY "$ejecutable" "$proyecto" > "$temporal/sin-conexion"
grep -q 'Conecta un proveedor con /connect' "$temporal/sin-conexion"
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
curl -fsSL "$artefactos/install.sh" -o "$temporal/installer"
printf 'archivo dañado\n' > "$temporal/danado/harwiff-linux-x86_64.tar.gz"
curl -fsSL "$artefactos/SHA256SUMS" -o "$temporal/danado/SHA256SUMS"
if HARWIFF_RELEASE_BASE="file://$temporal/danado" bash "$temporal/installer"; then
  echo "Un paquete dañado fue instalado." >&2
  exit 1
fi
test "$(readlink "$HARWIFF_DATA_DIR/actual")" = "$destino_previo"
