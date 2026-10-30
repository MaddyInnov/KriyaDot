#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# KriyaDot curl installer (#116).
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/scripts/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --version v0.1.0-alpha
#
# Detects OS/arch, downloads the matching release artifact plus the
# release SHA256SUMS, VERIFIES the checksum before installing anything,
# and installs into ~/.local/bin (override with KRIYADOT_INSTALL_DIR).
# Defensive by design: set -euo pipefail, every download checked, the
# checksum comparison is exact, and nothing is installed on any failure.
#
# The repo slug defaults below are placeholders for the public repo —
# override with KRIYADOT_REPO=owner/repo.
set -euo pipefail

KRIYADOT_REPO="${KRIYADOT_REPO:-kriyadot/kriyadot}"
KRIYADOT_VERSION="${KRIYADOT_VERSION:-latest}"
INSTALL_DIR="${KRIYADOT_INSTALL_DIR:-$HOME/.local/bin}"

log() { printf '[kriyadot-install] %s\n' "$*" >&2; }
die() { printf '[kriyadot-install] error: %s\n' "$*" >&2; exit 1; }

# verify_checksum <file> <sums-file>
# Succeeds only when <sums-file> contains a line "<sha256>  <basename>"
# (or "<sha256> *<basename>") whose hash matches <file> exactly.
verify_checksum() {
  local file="$1" sums="$2"
  local base expected actual
  base="$(basename "$file")"
  [ -f "$file" ] || { log "verify: no such file: $file"; return 1; }
  [ -f "$sums" ] || { log "verify: no such sums file: $sums"; return 1; }
  expected="$(awk -v b="$base" '{ name=$2; sub(/^\*/, "", name); if (name == b) { print $1; exit } }' "$sums")"
  [ -n "$expected" ] || { log "verify: no checksum entry for $base in $sums"; return 1; }
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    log "verify: neither sha256sum nor shasum is available"
    return 1
  fi
  if [ "$actual" = "$expected" ]; then
    log "verify: sha256 OK for $base"
    return 0
  fi
  log "verify: sha256 MISMATCH for $base (expected $expected, got $actual)"
  return 1
}

detect_os() {
  case "$(uname -s)" in
    Linux) echo "linux" ;;
    Darwin) echo "darwin" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) die "unsupported OS: $(uname -s) (use the release page for a manual download)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    arm64|aarch64) echo "arm64" ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
}

# artifact_name <os> <arch> — the release asset this installer knows how
# to install. The standalone server binary is published per the release
# workflow (dist/mvp-server, currently bun-linux-x64); other platforms
# fail loudly instead of downloading the wrong binary.
artifact_name() {
  local os="$1" arch="$2"
  case "$os-$arch" in
    linux-x64) echo "mvp-server" ;;
    *) die "no prebuilt standalone binary for $os-$arch yet — use the desktop installer or build from source (see the repo README)" ;;
  esac
}

download() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$dest"
  else
    die "curl or wget is required"
  fi
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) KRIYADOT_VERSION="${2:?--version needs a tag}"; shift 2 ;;
      --dir) INSTALL_DIR="${2:?--dir needs a path}"; shift 2 ;;
      *) die "unknown argument: $1" ;;
    esac
  done

  local os arch artifact base_url tmp
  os="$(detect_os)"
  arch="$(detect_arch)"
  artifact="$(artifact_name "$os" "$arch")"
  if [ "$KRIYADOT_VERSION" = "latest" ]; then
    base_url="https://github.com/$KRIYADOT_REPO/releases/latest/download"
  else
    base_url="https://github.com/$KRIYADOT_REPO/releases/download/$KRIYADOT_VERSION"
  fi

  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf \"$tmp\"" EXIT

  log "downloading $artifact ($os-$arch, $KRIYADOT_VERSION)"
  download "$base_url/$artifact" "$tmp/$artifact"
  log "downloading SHA256SUMS"
  download "$base_url/SHA256SUMS" "$tmp/SHA256SUMS"

  verify_checksum "$tmp/$artifact" "$tmp/SHA256SUMS" || die "checksum verification failed — refusing to install"

  mkdir -p "$INSTALL_DIR"
  install -m 0755 "$tmp/$artifact" "$INSTALL_DIR/kriyadot-server"
  log "installed kriyadot-server to $INSTALL_DIR/kriyadot-server"
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) : ;;
    *) log "note: $INSTALL_DIR is not on your PATH — add it to use kriyadot-server directly" ;;
  esac
}

# Run only when executed, not when sourced (the checksum test sources us).
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  main "$@"
fi
