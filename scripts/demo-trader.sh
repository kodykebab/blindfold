#!/usr/bin/env bash
# A second trader for demos: runs the client CLI as another Anvil test account against a running dev stack.
#   scripts/demo-trader.sh <stack-dir> deposit token1 50
#   scripts/demo-trader.sh <stack-dir> commit buy 10 1 --vault-only --both-funded
#   TRADER=12 scripts/demo-trader.sh <stack-dir> track
#   scripts/demo-trader.sh <stack-dir> fund          (only needed for stacks started before traders were funded)
# <stack-dir> is the "Local deployment and private state" directory dev.sh prints.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="${1:?usage: scripts/demo-trader.sh <stack-dir> <client command…>}"; shift
[ -f "$dir/stack.env" ] || { echo "no stack.env in $dir: start the stack with scripts/dev.sh" >&2; exit 1; }
# shellcheck disable=SC1091
source "$root/env.sh"
set -a; source "$dir/stack.env"; set +a
export CLIENT_ACCOUNT_INDEX="${TRADER:-11}" CLIENT_STATE="$dir/state-trader${TRADER:-11}" PRIVATE_KEY=''
if [ "${1:-}" = fund ]; then # mint 100 of each local test token to this trader (stacks started before dev.sh funded traders)
  me="$(cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index "$CLIENT_ACCOUNT_INDEX")"
  for t in token0 token1; do
    token="$(node -p "require('$DEPLOYMENTS').$t")"
    cast send "$token" 'mint(address,uint256)' "$me" 100000000000000000000 --mnemonic "$MNEMONIC" --mnemonic-index "$CLIENT_ACCOUNT_INDEX" --rpc-url "$RPC_URL" >/dev/null
  done
  echo "funded $me with 100 of each test token"; exit 0
fi
exec node "$root/packages/client/cli.mjs" "$@"
