#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Build a sideloadable .vsix for the KriyaDot VS Code extension.
# No marketplace publish — install with: code --install-extension kriyadot-vscode-0.1.0.vsix
set -euo pipefail
cd "$(dirname "$0")"
npm install --ignore-scripts
npm run compile
if command -v vsce >/dev/null 2>&1; then
  vsce package --allow-missing-repository
elif npx --yes @vscode/vsce --version >/dev/null 2>&1; then
  npx --yes @vscode/vsce package --allow-missing-repository
else
  echo "vsce not available: compiled output is in out/ — package it with '@vscode/vsce package' on a dev machine." >&2
  exit 2
fi
echo "Built kriyadot-vscode-0.1.0.vsix (sideload only)"
