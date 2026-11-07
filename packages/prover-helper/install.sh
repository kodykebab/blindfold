#!/usr/bin/env bash
# Dev install (D4) of the native messaging host xyz.blindfold.prover for Chromium browsers (D7), per user, macOS and Linux.
# Usage: install.sh [extension-id] [chromium-user-data-dir ...]
#        install.sh --uninstall [chromium-user-data-dir ...]
# Extra user-data-dirs (e.g. a Playwright profile) get <dir>/NativeMessagingHosts/, where Chromium looks for user hosts.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
source "$ROOT/env.sh"
NAME=xyz.blindfold.prover

case "$(uname -s)" in
  Darwin) BASE="$HOME/Library/Application Support"; BROWSERS=("Google/Chrome" "Chromium" "BraveSoftware/Brave-Browser" "Microsoft Edge"); DEFAULT_BIN="$BASE/Blindfold/Prover" ;;
  Linux) BASE="${XDG_CONFIG_HOME:-$HOME/.config}"; BROWSERS=("google-chrome" "chromium" "BraveSoftware/Brave-Browser" "microsoft-edge"); DEFAULT_BIN="${XDG_DATA_HOME:-$HOME/.local/share}/blindfold/prover" ;;
  *) echo "only macOS and Linux are supported" >&2; exit 1 ;;
esac
BIN="${INSTALL_DIR:-$DEFAULT_BIN}"

if [[ "${1:-}" == "--uninstall" ]]; then
  shift
  for b in "${BROWSERS[@]}"; do rm -f "$BASE/$b/NativeMessagingHosts/$NAME.json"; done
  for d in "$@"; do rm -f "$d/NativeMessagingHosts/$NAME.json"; done
  rm -f "$BIN/blindfold-prover-helper" "$BIN/config.json"
  rm -rf "$BIN/runtime"
  rmdir "$BIN" 2>/dev/null || true
  echo "removed $NAME"
  exit 0
fi

ID="${1:-eaoidifkamkmkbcomcbpldjlhipogdgo}"
shift || true
[[ "$ID" =~ ^[a-p]{32}$ ]] || { echo "extension ID must be 32 letters a-p" >&2; exit 1; }
PROVER="${ADMISSION_PROVER:-$ROOT/packages/proof-bench/results/local-prover}"
PARAMS="${ADMISSION_PARAMS:-$ROOT/packages/proof-bench/results/admission-params}"
if [[ ! -x "$PROVER" || ! -f "$PARAMS/manifest.json" ]]; then
  echo "local-prover or its parameters are missing; run: bash packages/proof-bench/check-admission.sh" >&2
  exit 1
fi
PROVER="$(cd "$(dirname "$PROVER")" && pwd)/$(basename "$PROVER")"
PARAMS="$(cd "$PARAMS" && pwd)"
for p in "$PROVER" "$PARAMS" "$BIN"; do
  [[ "$p" != *[\"\\]* ]] || { echo "paths with quotes or backslashes are not supported: $p" >&2; exit 1; }
done
PIN="$(shasum -a 256 "$PARAMS/manifest.json" | cut -d ' ' -f 1)"

# Install self-contained runtime assets: the browser host must not read the source checkout (e.g. Desktop).
# APFS clones and Linux reflinks keep large proving-key copies cheap when supported.
copy_asset() {
  if [[ "$(uname -s)" == Darwin ]]; then cp -c "$1" "$2" 2>/dev/null || cp "$1" "$2"
  else cp --reflink=auto "$1" "$2" 2>/dev/null || cp "$1" "$2"; fi
}
umask 077
mkdir -p "$BIN/runtime/params"
copy_asset "$PROVER" "$BIN/runtime/local-prover"
chmod 700 "$BIN/runtime/local-prover"
for f in manifest.json preparation.r1cs preparation.pk preparation.vk preparation.sol online.r1cs online.pk online.vk online.sol; do
  if [[ -f "$PARAMS/$f" ]]; then copy_asset "$PARAMS/$f" "$BIN/runtime/params/$f"; fi
done
PROVER="$BIN/runtime/local-prover"
PARAMS="$BIN/runtime/params"
(cd "$HERE" && go build -o "$BIN/blindfold-prover-helper" .)
(umask 077 && printf '{"extensionId":"%s","prover":"%s","params":"%s","manifestSha256":"%s"}\n' \
  "$ID" "$PROVER" "$PARAMS" "$PIN" > "$BIN/config.json")
MANIFEST="$(printf '{\n  "name": "%s",\n  "description": "Blindfold local ZK prover (development parameters)",\n  "path": "%s",\n  "type": "stdio",\n  "allowed_origins": ["chrome-extension://%s/"]\n}\n' \
  "$NAME" "$BIN/blindfold-prover-helper" "$ID")"

install_into() { mkdir -p "$1" && printf '%s\n' "$MANIFEST" > "$1/$NAME.json" && echo "registered: $1/$NAME.json"; }
for b in "${BROWSERS[@]}"; do
  # Only browsers that exist; re-run after installing another browser.
  if [[ -d "$BASE/$b" ]]; then install_into "$BASE/$b/NativeMessagingHosts"; else echo "skipped (not installed): $b"; fi
done
for d in "$@"; do install_into "$d/NativeMessagingHosts"; done
echo "extension $ID, parameters $PIN"
