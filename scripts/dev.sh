#!/usr/bin/env bash
# Start a separate proof-enforced Anvil, trading page, keeper and solver using public test accounts.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
source env.sh
missing=0
need() { # need <command> <how to install>
  if ! command -v "$1" >/dev/null 2>&1; then echo "missing $1: $2" >&2; missing=1; fi
}
need node 'install Node 22 (nvm install 22) and check the PATH in env.sh'
need npm 'comes with Node 22'
need anvil 'install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup'
need forge 'install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup'
[ -n "${ADMISSION_PROVER:-}" ] || need go 'install Go 1.21+ (brew install go; the first build fetches the toolchain go.mod needs), or set ADMISSION_PROVER to a built local-prover'
[ "$missing" = 0 ] || exit 1
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] || { echo "Node $node_major found; the stack needs Node 22 or newer (nvm install 22)" >&2; exit 1; }
[ -n "${ADMISSION_PROVER:-}" ] && [ ! -x "$ADMISSION_PROVER" ] && { echo "ADMISSION_PROVER=$ADMISSION_PROVER is not an executable file; unset it to build one" >&2; exit 1; }
[ -f contracts/lib/v4-core/src/PoolManager.sol ] || { echo 'contracts/lib is empty: run git submodule update --init --recursive' >&2; exit 1; }
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
