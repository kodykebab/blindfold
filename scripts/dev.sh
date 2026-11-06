#!/usr/bin/env bash
# Start a separate proof-enforced Anvil, trading page, keeper and solver using public test accounts.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
source env.sh
for pkg in packages/client packages/court-watcher packages/keeper packages/solver; do
  if [ ! -d "$pkg/node_modules" ]; then npm ci --prefix "$pkg" --ignore-scripts; fi
done
export ADMISSION_PARAMS="${ADMISSION_PARAMS:-$root/packages/proof-bench/results/admission-params}"
if [ ! -f "$ADMISSION_PARAMS/manifest.json" ] || [ ! -f "$ADMISSION_PARAMS/foundry.toml" ] || [ ! -f "$ADMISSION_PARAMS/preparation.sol" ] || [ ! -f "$ADMISSION_PARAMS/online.sol" ]; then
  echo 'Generate development parameters and verifier artifacts first; see packages/proof-bench/README.md.' >&2
  exit 1
fi
task_artifacts="$(mktemp -d "${TMPDIR:-/tmp}/blindfold-dev-artifacts.XXXXXX")"
export ADMISSION_VERIFIER_OUT="$task_artifacts/verifiers" CONTRACTS_OUT="$task_artifacts/contracts-out"
FOUNDRY_OUT="$ADMISSION_VERIFIER_OUT" FOUNDRY_CACHE_PATH="$task_artifacts/verifier-cache" forge build --root "$ADMISSION_PARAMS" --force
FOUNDRY_OUT="$CONTRACTS_OUT" FOUNDRY_CACHE_PATH="$task_artifacts/contracts-cache" forge build --root "$root/contracts" --force --no-dynamic-test-linking
if [ -z "${ADMISSION_PROVER:-}" ]; then
  task_bin="$(mktemp -d "${TMPDIR:-/tmp}/blindfold-dev-prover.XXXXXX")/local-prover"
  (cd packages/proof-bench/circuit && go build -buildvcs=false -o "$task_bin" .)
  export ADMISSION_PROVER="$task_bin"
fi
exec node scripts/dev-stack.mjs
