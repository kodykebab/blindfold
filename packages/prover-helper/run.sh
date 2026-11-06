#!/usr/bin/env bash
# Start the installed native host; Chrome normally launches the same binary directly.
set -euo pipefail
case "$(uname -s)" in
  Darwin) DEFAULT_BIN="$HOME/Library/Application Support/Blindfold/Prover" ;;
  Linux) DEFAULT_BIN="${XDG_DATA_HOME:-$HOME/.local/share}/blindfold/prover" ;;
  *) echo "only macOS and Linux are supported" >&2; exit 1 ;;
esac
exec "${INSTALL_DIR:-$DEFAULT_BIN}/blindfold-prover-helper" "$@"
