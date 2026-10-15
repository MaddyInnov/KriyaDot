#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Build the KriyaDot DESKTOP app (Tauri shell + bun-compiled API sidecar + bundled web UI).
#
# PREREQUISITES (one machine with the toolchain — NOT required for dev):
#   - Rust toolchain: https://rustup.rs
#   - Linux build deps (Debian/Ubuntu):
#       sudo apt update && sudo apt install -y \
#         build-essential curl wget file libssl-dev \
#         libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
#         libwebkit2gtk-4.1-dev
#   - Bun: https://bun.sh (already used by this repo)
#   - Node 20+ (for the Next.js static export)
#
# WHAT IT PRODUCES:
#   - Windows: apps/desktop/src-tauri/target/release/bundle/nsis/*.exe (installer)
#     plus a portable single-file exe at .../target/release/kriyadot.exe
#   - Linux:   .../target/release/bundle/appimage/*.AppImage
#
# Double-click the installer/binary: the app window opens with the full UI.
# No browser, no Node, no Docker needed. The API runs as a Tauri sidecar
# inside the app on 127.0.0.1:4567; data lives in the OS app-data directory.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/apps/desktop/src-tauri/binaries"
API_ENTRY="$ROOT/apps/api/src/index.ts"

echo "==> 1/4 building all packages + web static export"
npm run build --prefix "$ROOT"

echo "==> 2/4 compiling API sidecar for Linux (x86_64)"
mkdir -p "$BIN"
bun build --compile --target=bun-linux-x64 "$API_ENTRY" \
  --outfile "$BIN/mvp-api-x86_64-unknown-linux-gnu"

echo "==> 3/4 compiling API sidecar for Windows (x86_64)"
bun build --compile --target=bun-windows-x64 "$API_ENTRY" \
  --outfile "$BIN/mvp-api-x86_64-pc-windows-msvc.exe"

echo "==> 4/4 building Tauri desktop app (requires Rust toolchain)"
echo "    On this machine that means: rustup + system webkit deps (see header)."
if ! command -v cargo >/dev/null 2>&1; then
  echo "ERROR: cargo not found. Install the Rust toolchain, then re-run step 4:"
  echo "  cd $ROOT/apps/desktop && npx tauri build"
  exit 1
fi
cd "$ROOT/apps/desktop" && npx tauri build

echo "DONE. Bundles are under apps/desktop/src-tauri/target/release/bundle/"
