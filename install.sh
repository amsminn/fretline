#!/usr/bin/env bash
# Installs the latest Fretline release for macOS on Apple Silicon:
#   curl -fsSL https://raw.githubusercontent.com/amsminn/fretline/main/install.sh | bash
# Set FRETLINE_INSTALL_DIR to install somewhere other than /Applications.
set -euo pipefail

main() {
  local repo="amsminn/fretline" asset="Fretline-mac-arm64.zip"
  local base="https://github.com/${repo}/releases/latest/download"
  fail() { printf 'Fretline install: %s\n' "$1" >&2; exit 1; }

  [ "$(uname -s)" = Darwin ] || fail "macOS only."
  [ "$(uname -m)" = arm64 ] || fail "Apple Silicon (arm64) Macs only; Intel Macs are not supported yet."
  local tool
  for tool in curl ditto shasum xattr; do command -v "$tool" >/dev/null || fail "missing $tool."; done

  local dest
  if [ -n "${FRETLINE_INSTALL_DIR:-}" ]; then dest="$FRETLINE_INSTALL_DIR"
  elif [ -w /Applications ]; then dest=/Applications
  else dest="$HOME/Applications"; fi
  mkdir -p "$dest"

  # Global so the EXIT trap still sees it after main returns.
  FRETLINE_TMP="$(mktemp -d)"
  trap 'rm -rf "$FRETLINE_TMP"' EXIT
  local tmp="$FRETLINE_TMP"
  printf 'Downloading Fretline...\n'
  curl -fL --progress-bar -o "$tmp/$asset" "$base/$asset"
  curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"
  (cd "$tmp" && grep "  $asset\$" SHA256SUMS | shasum -a 256 -c - >/dev/null) || fail "checksum mismatch; nothing was installed."

  ditto -x -k "$tmp/$asset" "$tmp/app"
  [ -d "$tmp/app/Fretline.app" ] || fail "the download does not contain Fretline.app."
  if pgrep -xq Fretline; then fail "Fretline is running. Quit it and run the installer again."; fi

  rm -rf "$dest/Fretline.app"
  ditto "$tmp/app/Fretline.app" "$dest/Fretline.app"
  xattr -dr com.apple.quarantine "$dest/Fretline.app" 2>/dev/null || true
  printf 'Installed %s/Fretline.app\nOpen it from Launchpad, or run: open "%s/Fretline.app"\n' "$dest" "$dest"
}

main "$@"
