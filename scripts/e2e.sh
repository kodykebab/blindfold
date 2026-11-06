#!/usr/bin/env bash
# Isolated local acceptance: actual web/CLI, keeper and solver; recorded drand and local test assets.
# --real-proof additionally generates fresh local proofs using prepared development parameters.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
source env.sh
# The fixtures use only Anvil's public test accounts, regardless of the caller's shell.
export PRIVATE_KEY='' KEEPER_KEY='' SOLVER_KEY=''
export MNEMONIC='test test test test test test test test test test test junk'
task_artifacts="$(mktemp -d "${TMPDIR:-/tmp}/blindfold-e2e-artifacts.XXXXXX")"
export CONTRACTS_DIR="$root/contracts" CONTRACTS_OUT="$task_artifacts/out"
export FOUNDRY_OUT="$CONTRACTS_OUT" FOUNDRY_CACHE_PATH="$task_artifacts/cache"
real_proof=0
for arg in "$@"; do
  case "$arg" in
    --real-proof) real_proof=1 ;;
    *) echo "usage: scripts/e2e.sh [--real-proof]" >&2; exit 2 ;;
  esac
done
for pkg in packages/client packages/court-watcher packages/keeper packages/solver; do
  if [ ! -d "$pkg/node_modules" ]; then npm ci --prefix "$pkg" --ignore-scripts; fi
done
# forge test may have left dynamically linked test artifacts unsuitable for direct Anvil deployment.
forge build --root "$root/contracts" --force --no-dynamic-test-linking
forge build --root "$root/contracts" --no-dynamic-test-linking "$root/packages/solver/test/fixtures/SolverHookFactory.sol" \
  --remappings "blindfold/=$root/contracts/src/"
echo 'Local tier (admission off): real client, web service, keeper, solver and v4 pool; recorded drand and local test tokens.'
WEB_E2E=1 node --test app/haveibeensandwiched/local.e2e.test.mjs
STACK_E2E=1 node --test packages/solver/test/local-stack.e2e.test.mjs
CLIENT_E2E=1 node --test packages/client/test/e2e.test.mjs
KEEPER_E2E=1 node --test packages/keeper/test/e2e.test.mjs
SOLVER_E2E=1 node --test packages/solver/test/integration.test.mjs
if [ "$real_proof" = 1 ]; then
  export ADMISSION_PARAMS="${ADMISSION_PARAMS:-$root/packages/proof-bench/results/admission-params}"
  if [ ! -f "$ADMISSION_PARAMS/manifest.json" ] || [ ! -f "$ADMISSION_PARAMS/out/preparation.sol/Verifier.json" ] || [ ! -f "$ADMISSION_PARAMS/out/online.sol/Verifier.json" ]; then
    echo "Fresh-proof tier needs generated development parameters and verifier artifacts in ADMISSION_PARAMS; see packages/proof-bench/README.md." >&2
    exit 1
  fi
  if [ -z "${ADMISSION_PROVER:-}" ]; then
    task_bin="$(mktemp -d "${TMPDIR:-/tmp}/blindfold-e2e-prover.XXXXXX")/local-prover"
    (cd packages/proof-bench/circuit && go build -buildvcs=false -o "$task_bin" .)
    export ADMISSION_PROVER="$task_bin"
  fi
  export ADMISSION_MANIFEST_SHA256
  ADMISSION_MANIFEST_SHA256="$(shasum -a 256 "$ADMISSION_PARAMS/manifest.json" | cut -d ' ' -f 1)"
  echo 'Checking proof-enforced developer stack startup.'
  DEV_E2E=1 node --test scripts/dev-stack.test.mjs
  echo 'Fresh-proof tier: real proofs, verifiers, web, keeper and solver; recorded drand and local test tokens.'
  STACK_E2E=1 STACK_REAL_PROOF=1 node --test packages/solver/test/local-stack.e2e.test.mjs
  echo 'Fresh-proof recovery: isolated client admission lifecycle.'
  node --test packages/client/test/admission-e2e.test.mjs
fi
echo 'e2e.sh: all selected tiers passed'
