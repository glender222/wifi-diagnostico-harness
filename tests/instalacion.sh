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
printf '%s\n' '/diagnostico demo' 'agent harwiff' 'Consulta informes' '/volver' '/auditoria' '/salir' \
  | "$ejecutable" "$proyecto" > "$temporal/salida"
grep -q 'Demo · Leí los informes guardados' "$temporal/salida"
grep -q 'leer_informes · completo' "$temporal/salida"
printf '%s\n' 'agent harwiff' '/volver' '/salir' | "$ejecutable" "$proyecto" | grep 'Tú  Consulta informes'
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
