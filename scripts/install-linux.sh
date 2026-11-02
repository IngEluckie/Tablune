#!/usr/bin/env bash
# Build and install for the current user, without sudo or a running dev server.
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

if [[ "$(uname -s)" != Linux ]]; then
  echo 'Este instalador requiere Linux.' >&2
  exit 1
fi
if [[ "$(id -u)" == 0 ]]; then
  echo 'Ejecuta este instalador como tu usuario habitual, sin sudo.' >&2
  exit 1
fi

for tool in cargo rustc node npm python3 pkg-config ar bsdtar; do
  command -v "$tool" >/dev/null || { echo "Falta la herramienta: $tool" >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || {
  echo 'Se requiere Node.js 22 o posterior.' >&2
  exit 1
}
python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' || {
  echo 'Se requiere Python 3.10 o posterior.' >&2
  exit 1
}
pkg-config --exists gtk+-3.0 webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0 || {
  echo 'Faltan bibliotecas de desarrollo GTK/WebKitGTK.' >&2
  echo 'En CachyOS/Arch instala: base-devel webkit2gtk-4.1.' >&2
  exit 1
}

# npm exposes the pinned pnpm binary to Tauri's beforeBuildCommand as well.
pnpm_version="$(node -p 'require("./package.json").packageManager')"
pnpm_run() { npm exec --yes --package "$pnpm_version" -- pnpm "$@"; }

echo 'Descargando dependencias de Tablune...'
pnpm_run install --frozen-lockfile
echo 'Compilando Tablune Sheets para Linux...'
pnpm_run --dir apps/desktop tauri build --bundles deb -- --locked

# Let Tauri package its Python resources in the correct lib directory. Extract
# that package locally; this does not install a Debian package through pacman.
target_dir="$(cargo metadata --no-deps --format-version 1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"
package_version="$(node -p 'require("./apps/desktop/package.json").version')"
shopt -s nullglob
packages=("$target_dir/release/bundle/deb/"*"_${package_version}_"*.deb)
if [[ ${#packages[@]} -ne 1 ]]; then
  echo "Se esperaba un paquete de la versión $package_version en $target_dir/release/bundle/deb." >&2
  exit 1
fi
data_member="$(ar t "${packages[0]}" | awk '/^data\.tar(\..*)?$/ {print}')"
[[ -n "$data_member" ]] || { echo 'El paquete no contiene data.tar.' >&2; exit 1; }
stage="$(mktemp -d)"
trap 'rm -rf -- "$stage"' EXIT
ar p "${packages[0]}" "$data_member" | bsdtar -xf - -C "$stage"
[[ -x "$stage/usr/bin/tablune" ]] || { echo 'Falta el ejecutable compilado.' >&2; exit 1; }
for resource in tablune_runner.py tablune_calculator.py; do
  [[ -n "$(find "$stage/usr/lib" -name "$resource" -print -quit)" ]] || {
    echo "Falta el recurso Python: $resource" >&2
    exit 1
  }
done

prefix="${TABLUNE_INSTALL_PREFIX:-$HOME/.local}"
[[ "$prefix" == /* && "$prefix" != *$'\n'* ]] || { echo 'La ruta de instalación debe ser absoluta.' >&2; exit 1; }
data_dir="${XDG_DATA_HOME:-$HOME/.local/share}"
mkdir -p "$prefix" "$data_dir/applications" "$data_dir/icons/hicolor/256x256/apps"
rm -f -- "$stage/usr/share/applications/"*.desktop
cp -a "$stage/usr/." "$prefix/"
install -m 644 apps/desktop/src-tauri/icons/128x128@2x.png \
  "$data_dir/icons/hicolor/256x256/apps/com.tablune.sheets.png"

# Escape desktop-entry reserved characters in the absolute executable path.
python3 - "$prefix/bin/tablune" "$stage/com.tablune.sheets.desktop" <<'PY'
import pathlib
import sys

executable = sys.argv[1]
executable = executable.replace('\\', '\\\\\\\\').replace('"', '\\\\"').replace('`', '\\\\`').replace('$', '\\\\$').replace('%', '%%')
pathlib.Path(sys.argv[2]).write_text(
    '[Desktop Entry]\nType=Application\nName=Tablune Sheets\n'
    'Comment=Editor de CSV y hojas de cálculo con Python\n'
    f'Exec="{executable}"\nIcon=com.tablune.sheets\n'
    'Terminal=false\nCategories=Office;Spreadsheet;\nStartupNotify=true\n',
    encoding='utf-8',
)
PY
if command -v desktop-file-validate >/dev/null; then
  desktop-file-validate "$stage/com.tablune.sheets.desktop"
fi
install -m 644 "$stage/com.tablune.sheets.desktop" "$data_dir/applications/com.tablune.sheets.desktop"
if command -v update-desktop-database >/dev/null; then
  update-desktop-database "$data_dir/applications" || true
fi
if command -v kbuildsycoca6 >/dev/null; then
  kbuildsycoca6 --noincremental || true
fi
printf '\nTablune Sheets instalado. Búscalo en el menú de aplicaciones.\nEjecutable: %s/bin/tablune\n' "$prefix"
