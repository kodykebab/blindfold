#!/usr/bin/env bash
# Three anvil users, one batch: commit, keeper reveal, solver settle, withdraw.
# Starts its own anvil on 8547. Recorded drand only. See DEMO.md.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
# shellcheck disable=SC1091
source env.sh
exec node scripts/demo-multi.mjs
