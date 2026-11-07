#!/usr/bin/env bash
# Removes the xyz.blindfold.prover registrations and the built helper. Usage: uninstall.sh [chromium-user-data-dir ...]
exec "$(dirname "${BASH_SOURCE[0]}")/install.sh" --uninstall "$@"
