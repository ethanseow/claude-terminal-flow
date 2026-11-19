#!/usr/bin/env bash
# Builds the release binary and links it as `dashboard` so you can run:  dashboard ~/some/folder
set -euo pipefail

cd "$(dirname "$0")/.."

npm install --no-audit --no-fund
npm run tauri build -- --no-bundle

BIN="$PWD/src-tauri/target/release/dashboard"
DEST="${DASHBOARD_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$DEST"
ln -sf "$BIN" "$DEST/dashboard"

echo
echo "Installed: $DEST/dashboard -> $BIN"
case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "Note: $DEST is not on your PATH. Add it, e.g.:  export PATH=\"$DEST:\$PATH\"" ;;
esac
echo "Try:  dashboard --help"
