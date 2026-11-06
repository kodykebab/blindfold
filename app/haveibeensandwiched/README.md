# haveibeensandwiched

Paste an Ethereum tx hash or wallet address and see how much sandwich MEV it lost. Plain `node:http` MVP; the logic lives in `check.mjs`.

## Setup
```bash
source env.sh                                  # Node 22 on PATH
(cd packages/court-watcher && npm install)     # check.mjs imports its lib.mjs
```

Address lookups need an API key. Put it in the repo-root `.env` (gitignored, never commit it). `npm start` loads that file:
```bash
ETHERSCAN_API_KEY=your-key   # https://etherscan.io/myapikey, free tier is enough (one call per lookup)
# DUNE_API_KEY=your-key      # optional fallback, used only when ETHERSCAN_API_KEY is unset
```

| Var | Default | Needed for |
|---|---|---|
| `ETHERSCAN_API_KEY` | none | Address lookups (last 40 sent txs via Etherscan V2) |
| `DUNE_API_KEY` | none | Address lookups through Dune's `dex.sandwiched`, if there's no Etherscan key |
| `ETH_RPC` | `https://ethereum-rpc.publicnode.com` | All lookups. Must support `eth_getBlockReceipts` |
| `PORT` | `3100` | Server port |
| `OFFLINE` | unset | `1` serves `fixtures.json` only, no network or keys |

Tx-hash lookups need no key: they use `ETH_RPC` and DefiLlama prices. With neither key set, address lookups return an error saying so.

## Run
```bash
cd app/haveibeensandwiched
npm start              # http://localhost:3100
OFFLINE=1 npm start    # fixtures only
npm test               # offline tests
```
To preview the full animation on a system with reduced motion enabled, open `/?motion=full`.
This page-specific setting enables the original story transitions, hero animation and result effects.

Demo address: `0xcf36363eea51f669c391eafc2ec2c3ff1b7a4be5`.
