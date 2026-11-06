#!/usr/bin/env bash
# Every lane's offline checks in one go: forge test, `npm test` in every package that defines one,
# and the proof-bench Rust tests. Prints one PASS/FAIL/SKIP line per part; exits non-zero on any failure.
# New packages are picked up automatically, so nobody needs to edit this file.
#   SKIP_RUST=1 scripts/check.sh   # skip the (slow) proof-bench cargo tests
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
# shellcheck disable=SC1091
source env.sh
log="$(mktemp -d)"
fail=0
results=()

run() { # run <name> <command...>
  local name="$1"; shift
  if "$@" >"$log/$name.log" 2>&1; then results+=("PASS  $name"); else results+=("FAIL  $name   (log: $log/$name.log)"); fail=1; fi
}
skip() { results+=("SKIP  $1   ($2)"); }

run forge bash -c "cd contracts && forge test"

for pkg in packages/*/; do
  name="npm:$(basename "$pkg")"
  if ! node -e "process.exit(require('./${pkg}package.json').scripts?.test ? 0 : 1)" 2>/dev/null; then
    skip "$name" "no test script"; continue
  fi
  if [ ! -d "${pkg}node_modules" ]; then
    (cd "$pkg" && npm ci --silent --ignore-scripts) >"$log/$name-install.log" 2>&1 \
      || { results+=("FAIL  $name   (npm ci failed, log: $log/$name-install.log)"); fail=1; continue; }
  fi
  run "$name" bash -c "cd '$pkg' && npm test"
done

if [ "${SKIP_RUST:-0}" = 1 ]; then
  skip cargo:proof-bench "SKIP_RUST=1"
elif ! command -v cargo >/dev/null; then
  skip cargo:proof-bench "cargo not installed"
else
  [ -d packages/proof-bench/.deps ] || bash packages/proof-bench/prepare.sh >"$log/prepare.log" 2>&1 \
    || { results+=("FAIL  cargo:proof-bench   (prepare.sh failed, log: $log/prepare.log)"); fail=1; }
  [ -d packages/proof-bench/.deps ] && run cargo:proof-bench cargo test --manifest-path packages/proof-bench/Cargo.toml --locked --release
fi

printf '%s\n' "${results[@]}"
[ "$fail" = 0 ] && echo "check.sh: all green" || echo "check.sh: FAILED"
exit "$fail"
