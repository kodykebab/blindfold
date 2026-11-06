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
Demo address: `0xcf36363eea51f669c391eafc2ec2c3ff1b7a4be5`.

## Local trading page

The landing page links to `/trade`. Start the page server on the same machine as the client:

```bash
source env.sh
npm ci --prefix packages/court-watcher --ignore-scripts
npm ci --prefix packages/client --ignore-scripts
OFFLINE=1 npm start --prefix app/haveibeensandwiched
```

Open `http://127.0.0.1:3100/`. Configure the client through the variables in `packages/client/README.md`, including `RPC_URL`, `DEPLOYMENTS`, and, when using admission proofs, `ADMISSION_PROVER` and `ADMISSION_PARAMS`. The page runs the existing CLI with the server's environment; `CLIENT_ACCOUNT_INDEX` selects a local Anvil account and `PRIVATE_KEY` selects the configured key. The CLI signs transactions. No private key is entered into the page.

The local server binds to `127.0.0.1`, accepts a fixed list of CLI actions, and runs one command at a time. Preview uses `commit --dry-run`. Tracking, cleanup and withdrawal use the corresponding client commands.

The solver is a separate service. Configure it with the same RPC and deployment, then run `npm start --prefix packages/solver -- --once` to process eligible batches once, or omit `-- --once` to poll. It uses its own configured account to submit settlement transactions; it does not need the trader's signing key. See `packages/solver/README.md` for routing and local setup.

The trading page can run `prepare-admission` for an explicit current or future batch. A running CLI command remains in the local server when the page reloads; the same tab reconnects to its job. The backup controls invoke the CLI's `export-state` and `import-state` commands. Exported JSON includes sensitive order and funding state and is not encrypted by the CLI. Import is validated against the configured account, deployment and onchain commitments.

The real CLI/Anvil backup test is opt-in: `WEB_E2E=1 node --test app/haveibeensandwiched/local.e2e.test.mjs`. It starts its own Anvil and does not use an existing chain.
