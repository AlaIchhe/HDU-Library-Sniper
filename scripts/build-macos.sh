#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$ROOT/pyproject.toml" | head -n 1)"
BROWSER_DIR="$ROOT/packaging/.cache/playwright-browsers"
DESKTOP_DIR="$ROOT/build/desktop"
DIST_DIR="$ROOT/dist"
ICONSET="$ROOT/packaging/.cache/AppIcon.iconset"
ICON="$ROOT/packaging/.cache/AppIcon.icns"

cd "$ROOT"
mkdir -p "$DIST_DIR"
uv sync --group package

if [[ ! -f "$ROOT/assets/app-icon.png" ]]; then
  echo "assets/app-icon.png is missing. Generate and commit application icons on Windows first." >&2
  exit 1
fi

rm -rf "$BROWSER_DIR" "$DESKTOP_DIR" "$ICONSET"
mkdir -p "$ICONSET"
export PLAYWRIGHT_BROWSERS_PATH="$BROWSER_DIR"
uv run playwright install chromium --only-shell

for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ROOT/assets/app-icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$ROOT/assets/app-icon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$ICON"

args=(
  run flet pack src/desktop.py
  --distpath "$DESKTOP_DIR"
  --name "HDU Library Sniper"
  --icon "$ICON"
  --product-name "HDU Library Sniper"
  --product-version "$VERSION"
  --company-name "HDU Library Sniper Contributors"
  --copyright "Copyright (C) 2026 HDU Library Sniper Contributors"
  --bundle-id "io.github.alaichhe.hdu-library-sniper"
  --add-data "$BROWSER_DIR:playwright-browsers"
  --hidden-import playwright.sync_api
  --yes
)
if [[ -n "${MACOS_CODESIGN_IDENTITY:-}" ]]; then
  args+=(--codesign-identity "$MACOS_CODESIGN_IDENTITY")
fi
uv "${args[@]}"

APP="$DESKTOP_DIR/HDU Library Sniper.app"
DMG="$DIST_DIR/HDU-Library-Sniper-$VERSION-macos.dmg"
rm -f "$DMG"
hdiutil create -volname "HDU Library Sniper" -srcfolder "$APP" -ov -format UDZO "$DMG"
echo "Application: $APP"
echo "Disk image: $DMG"
