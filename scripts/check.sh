#!/usr/bin/env bash
# Every lane's offline checks in one go: forge test, `npm test` in every package that defines one,
# and the proof-bench Rust tests. Prints one PASS/FAIL/SKIP line per part; exits non-zero on any failure.
# New packages are picked up automatically, so nobody needs to edit this file.
#   scripts/check.sh [--fork] [--e2e] [--real-proof]
#   SKIP_RUST=1 scripts/check.sh   # skip the (slow) proof-bench cargo tests
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
# shellcheck disable=SC1091
source env.sh
log="$(mktemp -d)"
# Keep test artifacts separate from any running local stack.
export FOUNDRY_OUT="$log/contracts-out" FOUNDRY_CACHE_PATH="$log/contracts-cache" CONTRACTS_OUT="$log/contracts-out"
fail=0
results=()
fork=0
e2e=0
real_proof=0
for arg in "$@"; do
  case "$arg" in
    --fork) fork=1 ;;
    --e2e) e2e=1 ;;
    --real-proof) e2e=1; real_proof=1 ;;
    *) echo "usage: scripts/check.sh [--fork] [--e2e] [--real-proof]" >&2; exit 2 ;;
  esac
done

run() { # run <name> <command...>
  local name="$1"; shift
  if "$@" >"$log/$name.log" 2>&1; then results+=("PASS  $name"); else results+=("FAIL  $name   (log: $log/$name.log)"); fail=1; fi
}
skip() { results+=("SKIP  $1   ($2)"); }

if [ "$fork" = 1 ]; then
  run forge bash -c "cd contracts && forge test"
else
  run forge bash -c "cd contracts && forge test --no-match-contract Fork"
fi
run solver:fixture forge build --root "$root/contracts" --no-dynamic-test-linking "$root/packages/solver/test/fixtures/SolverHookFactory.sol" --remappings "blindfold/=$root/contracts/src/"

for pkg in packages/*/ app/*/; do
  name="npm:$(basename "$pkg")"
  if ! node -e "process.exit(require('./${pkg}package.json').scripts?.test ? 0 : 1)" 2>/dev/null; then
    skip "$name" "no test script"; continue
  fi
  if [ ! -d "${pkg}node_modules" ]; then
    (cd "$pkg" && npm ci --silent --ignore-scripts) >"$log/$name-install.log" 2>&1 \
      || { results+=("FAIL  $name   (npm ci failed, log: $log/$name-install.log)"); fail=1; continue; }
  fi
  run "$name" env -u ADMISSION_PARAMS -u CLIENT_E2E -u KEEPER_E2E -u SOLVER_E2E -u STACK_E2E -u STACK_REAL_PROOF -u WEB_E2E -u EXT_E2E bash -c "cd '$pkg' && npm test"
done

run scripts:tests env -u DEV_E2E -u ADMISSION_PARAMS node --test scripts/*.test.mjs

if command -v go >/dev/null; then
  run go:circuit bash -c "cd packages/proof-bench/circuit && GOPROXY=off go test -buildvcs=false ./..."
else
  skip go:circuit "go not installed"
fi

if [ "${SKIP_RUST:-0}" = 1 ]; then
  skip cargo:proof-bench "SKIP_RUST=1"
elif ! command -v cargo >/dev/null; then
  skip cargo:proof-bench "cargo not installed"
else
  if [ ! -d packages/proof-bench/.deps ]; then
    results+=("FAIL  cargo:proof-bench   (run packages/proof-bench/prepare.sh during setup)"); fail=1
  else
    run cargo:proof-bench cargo test --offline --manifest-path packages/proof-bench/Cargo.toml --locked --release
  fi
fi

if [ "$e2e" = 1 ]; then
  if [ "$real_proof" = 1 ]; then run e2e scripts/e2e.sh --real-proof
  else run e2e scripts/e2e.sh; fi
fi

printf '%s\n' "${results[@]}"
[ "$fail" = 0 ] && echo "check.sh: all green" || echo "check.sh: FAILED"
exit "$fail"
