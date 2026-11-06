# haveibeensandwiched

Paste an Ethereum tx hash or wallet address and see how much sandwich MEV it lost. Plain `node:http` MVP; the logic lives in `check.mjs`.

## Setup
```bash
source env.sh                                  # Node 22 on PATH
(cd packages/court-watcher && npm install)     # check.mjs imports its lib.mjs
```

Address lookups need an API key. Put it in the repo-root `.env` (gitignored, never commit it). `npm start` loads that file:
```bash
ETHERSCAN_API_KEY=your-key   # https://etherscan.io/myapikey, free tier is enough
```

| Var | Default | Needed for |
|---|---|---|
| `ETHERSCAN_API_KEY` | none | Address lookups (last 40 sent txs via Etherscan V2), and pricing Uniswap v4 sandwiches |
| `ETH_RPC` | `https://ethereum-rpc.publicnode.com` | All lookups. Must support `eth_getBlockReceipts` |
| `UNICHAIN_SEPOLIA_RPC` | `https://sepolia.unichain.org` | Unichain Sepolia lookups; must support `eth_getBlockReceipts` |
| `PORT` | `3100` | Server port |
| `OFFLINE` | unset | `1` serves `fixtures.json` only, no network or keys |

The network selector searches Ethereum mainnet (v3/v4) or Unichain Sepolia (v3 only). Testnet wallet lookups use Blockscout, and testnet profits are shown in raw token units.

Tx-hash lookups need no key: they use `ETH_RPC` and DefiLlama prices (v4 sandwiches stay in raw units without a key). Without the key, address lookups return an error saying so.

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

## Deploy on Vercel
`api/check.js` is the same lookup as a Vercel Function, and `index.html` is served as a static file. In the project settings:
- Root Directory: `app/haveibeensandwiched`, with "Include files outside the root directory in the Build Step" on (the lookup imports `packages/court-watcher`). `vercel.json` installs court-watcher's dependencies.
- Node.js 22, and `ETHERSCAN_API_KEY` as an environment variable (`ETH_RPC` is optional).

Complete answers are cached at Vercel's edge for 5 minutes.
