#!/usr/bin/env bash
# The auction without Court (S21, #27). Copies contracts/ without src/court, test/court and DeployCourt, checks that
# nothing left mentions Court, then builds that copy and runs the auction's offline tests in it. Their setUp deploys
# a PoolManager, the vault, the settlement and the mined hook, and the tests commit, reveal, slash and settle, so a
# pass means the auction deploys and runs with no Court contract, env var or package.
#   scripts/auction-only.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$root/env.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

rsync -a --exclude /lib --exclude /out --exclude /cache --exclude /broadcast \
  --exclude /src/court --exclude /test/court --exclude /script/DeployCourt.s.sol "$root/contracts/" "$tmp/"
ln -s "$root/contracts/lib" "$tmp/lib"

if grep -rniE 'court|bondregistry' "$tmp/src" "$tmp/test" "$tmp/script" "$tmp/foundry.toml"; then
  echo "FAIL  the auction still references Court (above)"
  exit 1
fi
echo "ok    no Court reference in the auction's sources, tests, scripts or foundry.toml"
ls "$tmp/script"/*.s.sol >/dev/null 2>&1 || echo "note  no auction deploy script on this branch yet; the tests' setUp is the deploy path checked"

# the Unichain fork suite needs the network; everything else is offline
(cd "$tmp" && forge test --no-match-contract Fork)
echo "PASS  the auction builds and its offline tests pass without Court"
