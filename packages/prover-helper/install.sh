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
BIN="${INSTALL_DIR:-$HERE/bin}"

case "$(uname -s)" in
  Darwin) BASE="$HOME/Library/Application Support"; BROWSERS=("Google/Chrome" "Chromium" "BraveSoftware/Brave-Browser" "Microsoft Edge") ;;
  Linux) BASE="${XDG_CONFIG_HOME:-$HOME/.config}"; BROWSERS=("google-chrome" "chromium" "BraveSoftware/Brave-Browser" "microsoft-edge") ;;
  *) echo "only macOS and Linux are supported" >&2; exit 1 ;;
esac

if [[ "${1:-}" == "--uninstall" ]]; then
  shift
  for b in "${BROWSERS[@]}"; do rm -f "$BASE/$b/NativeMessagingHosts/$NAME.json"; done
  for d in "$@"; do rm -f "$d/NativeMessagingHosts/$NAME.json"; done
  rm -f "$BIN/blindfold-prover-helper" "$BIN/config.json"
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

mkdir -p "$BIN"
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
