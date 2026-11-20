#!/usr/bin/env bash
set -euo pipefail

raiz="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
salida="$(realpath -m -- "${1:-$raiz/dist}")"
version_node=22.23.5
archivo_node="node-v$version_node-linux-x64.tar.xz"
sha_node=cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8
version_python=3.12.14
paquete=harwiff-linux-x86_64.tar.gz

if [[ "$(uname -s):$(uname -m)" != Linux:x86_64 ]]; then
  echo "La compilación de esta release requiere Linux x86-64." >&2
  exit 1
fi
mkdir -p -- "$salida"
temporal="$(mktemp -d)"
trap 'rm -rf -- "$temporal"' EXIT
stage="$temporal/harwiff"
mkdir -p -- "$stage/node" "$stage/app" "$stage/licenses"
version="$(node -p 'require(process.argv[1]).version' "$raiz/package.json")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
commit="$(git -C "$raiz" rev-parse HEAD)"
canal=desarrollo
cambios=false
if [[ -n "$(git -C "$raiz" status --porcelain)" ]]; then
  cambios=true
elif [[ "$(git -C "$raiz" tag --points-at "$commit" --list "v$version")" == "v$version" ]]; then
  canal=estable
fi
printf '{"version":"%s","commit":"%s","canal":"%s","cambiosLocales":%s}\n' \
  "$version" "$commit" "$canal" "$cambios" > "$stage/app/build-info.json"
curl -fsSL --retry 3 "https://nodejs.org/dist/v$version_node/$archivo_node" -o "$temporal/$archivo_node"
(cd "$temporal" && printf '%s  %s\n' "$sha_node" "$archivo_node" | sha256sum -c -)
tar -xJf "$temporal/$archivo_node" -C "$stage/node" --strip-components=1
uv python install "$version_python"
interprete="$(uv python find --managed-python "$version_python")"
cp -a -- "$(dirname -- "$(dirname -- "$interprete")")" "$stage/python"
uv pip install --no-deps --python "$stage/python/bin/python3" \
  --target "$stage/python/lib/python3.12/site-packages" -r "$raiz/requirements-runtime.txt"

for archivo in consola.mjs pantalla.mjs proyecto.mjs bucle.mjs entorno.mjs sesion-agente.mjs historial-agente.mjs policy.mjs proveedor-openai.mjs panel-adaptadores.mjs \
  credenciales-openai.mjs modelo-inspeccion.mjs inspeccion.mjs \
  app.py entorno.py adaptador_core.py wireless_linux.py wifi.py diagnostico.py foundry.py broker_mock.py broker_lectura.py \
  AGENTS.proyecto.md package.json package-lock.json requirements-opensandbox.txt; do
  cp -- "$raiz/$archivo" "$stage/app/"
done
mkdir -- "$stage/app/ejemplos"
cp -- "$raiz/ejemplos/"{informe-demo,escenario-wifi-mock}.json "$stage/app/ejemplos/"
cp -a -- "$raiz/vendor" "$raiz/contratos" "$stage/app/"
(cd "$stage/app" && npm ci --omit=dev --ignore-scripts)
cp -- "$raiz/scripts/harwiff" "$stage/harwiff"
cp -- "$raiz/THIRD_PARTY.md" "$stage/licenses/THIRD_PARTY.md"
sed "s/@HARWIFF_VERSION@/v$version/" "$raiz/scripts/install.sh" > "$salida/install.sh"
chmod +x "$salida/install.sh"
"$stage/harwiff" --version
tar -czf "$salida/$paquete" -C "$temporal" harwiff
(cd "$salida" && sha256sum "$paquete" > SHA256SUMS)
