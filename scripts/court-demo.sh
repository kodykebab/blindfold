#!/usr/bin/env bash
# Court's covered-transaction flow, end to end on a plain anvil (S21, #27):
#   demo pool + shared router + sandwich bot → DeployCourt (that pool listed, the RPC signer bonded) → a victim swaps
#   through the leaky "protected" RPC, which signs a receipt and leaks the tx → the bot sandwiches it in one block →
#   the watcher proves it (BLOCKHASH path) and claims from the RPC's bond → after the claim window it collects →
#   the receipt's beneficiary is paid.
# Starts its own anvil on PORT (8555) and the leaky RPC on LEAKY_PORT (8546), and stops both on exit.
# Writes deployments/{demo,court}.local.json (gitignored), like any local deploy.
#   scripts/court-demo.sh            # CLAIM_WINDOW=5 (seconds) by default
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
# shellcheck disable=SC1091
source env.sh
PORT="${PORT:-8555}"
WINDOW="${CLAIM_WINDOW:-5}"
export RPC_URL="http://127.0.0.1:$PORT" ETH_RPC="http://127.0.0.1:$PORT"
work="$(mktemp -d)"
export RECEIPTS="$work/receipts.jsonl" WATCH_DIR="$work/watcher"

step() { printf '\n== %s\n' "$*"; }
json() { node -p "require('$root/deployments/$1.local.json').$2"; }

anvil --port "$PORT" --accounts 20 --silent &
anvil_pid=$!
trap 'kill "$anvil_pid" 2>/dev/null; rm -rf "$work"' EXIT
until cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1; do sleep 0.2; done

step "build"
(cd contracts && forge build --silent)
for p in demo-bots court-watcher; do
  [ -d "packages/$p/node_modules" ] || (cd "packages/$p" && npm ci --silent --ignore-scripts)
done

step "demo pool, shared router and sandwich bot"
(cd packages/demo-bots && npm start --silent -- setup)
export V4_POOL_MANAGER="$(json demo poolManager)"

step "Court: verifier + BondRegistry with the demo pool listed, RPC signer (account 4) bonded"
(cd contracts && COURT_POOLS="$(json demo poolId)" CLAIM_WINDOW="$WINDOW" \
  forge script script/DeployCourt.s.sol --rpc-url "$RPC_URL" --broadcast --silent)
echo "BondRegistry $(json court bondRegistry), bond $(cast call "$(json court bondRegistry)" 'bondOf(address)(uint256)' "$(json court rpcSigner)" --rpc-url "$RPC_URL")"

step "leak and sandwich"
(cd packages/demo-bots && npm start --silent -- leak-and-sandwich)
cast rpc anvil_mine 3 --rpc-url "$RPC_URL" >/dev/null # the watcher only reads blocks with 3 confirmations

beneficiary="$(node -p "JSON.parse(require('fs').readFileSync('$RECEIPTS', 'utf8').split('\n')[0]).receipt.beneficiary")"
before="$(cast balance "$beneficiary" --rpc-url "$RPC_URL")"
export WATCH_START="$(json demo deployBlock)"

step "watcher: discover, prove, claim"
(cd packages/court-watcher && npm start --silent -- --once)

step "watcher: collect once the ${WINDOW}s claim window has closed"
# anvil mines on demand: mine a block a second, as a live chain would, until the chain's clock passes the window
closes="$(node -p "Object.values(require('$WATCH_DIR/state.json').items)[0].submission.closesAt")"
until [ "$(cast block latest -f timestamp --rpc-url "$RPC_URL")" -ge "$closes" ]; do
  sleep 1
  cast rpc anvil_mine 1 --rpc-url "$RPC_URL" >/dev/null
done
(cd packages/court-watcher && npm start --silent -- --once)

after="$(cast balance "$beneficiary" --rpc-url "$RPC_URL")"
node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1] + "/state.json", "utf8"))
  const items = Object.values(s.items)
  const [item] = items
  const paid = BigInt(process.argv[3]) - BigInt(process.argv[2])
  const ok = items.length === 1 && item.status === "collected" && BigInt(item.collection.payout) === paid && paid > 0n
  console.log(ok ? `PASS  beneficiary ${item.collection.beneficiary} paid ${Number(paid) / 1e18} ETH (incident ${item.submission.incident})`
    : `FAIL  ${JSON.stringify(items, null, 1)}`)
  process.exit(ok ? 0 : 1)
' "$WATCH_DIR" "$before" "$after"
