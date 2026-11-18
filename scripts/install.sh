#!/usr/bin/env bash
set -euo pipefail

version=v0.2.5
base="${HARWIFF_RELEASE_BASE:-https://github.com/glender222/wifi-diagnostico-harness/releases/download/$version}"
bin="${HARWIFF_BIN_DIR:-$HOME/.local/bin}"
datos="${HARWIFF_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/harwiff}"
paquete=harwiff-linux-x86_64.tar.gz

if [[ "$(uname -s):$(uname -m)" != Linux:x86_64 ]] || ! getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
  echo "Esta release requiere Linux x86-64 con glibc." >&2
  exit 1
fi
if [[ -e "$bin/harwiff" && ! -L "$bin/harwiff" ]]; then
  echo "Ya existe $bin/harwiff y es un archivo. Elige otro destino con HARWIFF_BIN_DIR." >&2
  exit 1
fi

descarga="$(mktemp -d)"
trap 'rm -rf -- "$descarga"' EXIT
curl -fsSL --retry 3 "$base/$paquete" -o "$descarga/$paquete"
curl -fsSL --retry 3 "$base/SHA256SUMS" -o "$descarga/SHA256SUMS"
checksum="$(awk -v paquete="$paquete" '$2 == paquete { print $1 }' "$descarga/SHA256SUMS")"
[[ "$checksum" =~ ^[A-Fa-f0-9]{64}$ ]] || { echo "Checksum de Harwiff inválido." >&2; exit 1; }
(cd "$descarga" && printf '%s  %s\n' "$checksum" "$paquete" | sha256sum -c -)

mkdir -p -- "$datos/versiones" "$bin"
destino="$(mktemp -d "$datos/versiones/$version-XXXXXX")"
if ! tar -xzf "$descarga/$paquete" -C "$destino" --strip-components=1 ||
   ! "$destino/harwiff" --version; then
  rm -rf -- "$destino"
  echo "No se pudo iniciar la nueva instalación." >&2
  exit 1
fi
ln -s -- "$destino" "$destino/.activar"
mv -Tf -- "$destino/.activar" "$datos/actual"
ln -sfnT -- "$datos/actual/harwiff" "$bin/harwiff"

printf 'Harwiff instalado en %s/harwiff\n' "$bin"
case ":$PATH:" in
  *":$bin:"*) echo "Ejecuta harwiff para empezar." ;;
  *) printf 'Añade %s a tu PATH o ejecuta %s/harwiff.\n' "$bin" "$bin" ;;
esac
