#!/usr/bin/env bash
# Reproducible local admission gate: generated development keys, real proofs, isolated Anvil and recorded drand.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source env.sh
mkdir -p packages/proof-bench/results
export ADMISSION_PROVER="${ADMISSION_PROVER:-$ROOT/packages/proof-bench/results/local-prover}"
export ADMISSION_PARAMS="${ADMISSION_PARAMS:-$ROOT/packages/proof-bench/results/admission-params}"
(cd packages/proof-bench/circuit && go build -o "$ADMISSION_PROVER" .)
if [[ ! -d "$ADMISSION_PARAMS" ]]; then
  "$ADMISSION_PROVER" setup-local "$ADMISSION_PARAMS"
fi
# setup-local refuses overwrite; a failed partial setup must be removed explicitly before trying again.
export ADMISSION_MANIFEST_SHA256
ADMISSION_MANIFEST_SHA256="$(shasum -a 256 "$ADMISSION_PARAMS/manifest.json" | cut -d ' ' -f 1)"
cat > "$ADMISSION_PARAMS/foundry.toml" <<'CONFIG'
[profile.default]
src = "."
out = "out"
libs = []
solc = "0.8.26"
optimizer = true
optimizer_runs = 200
CONFIG
forge build --root "$ADMISSION_PARAMS"
# Test deployment helpers must contain ordinary EVM creation bytecode, not Foundry cheatcodes.
forge build --root "$ROOT/contracts" --no-dynamic-test-linking
node --test packages/client/test/admission-e2e.test.mjs
