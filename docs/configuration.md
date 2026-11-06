# Configuration

Everything is configured through environment variables. `scripts/dev.sh` sets all of them for the local stack, so you only need this page to run the pieces yourself or point them elsewhere.

**Secrets** (`PRIVATE_KEY`, `KEEPER_KEY`, `SOLVER_KEY`, `ARKIV_KEY`, `ETHERSCAN_API_KEY`, `DUNE_API_KEY`) belong in the repo-root `.env`, which is gitignored. Never commit them. The services never print them, and an RPC URL is shown only by its origin.

## Shared

| Variable | Used by | Default | Meaning |
|---|---|---|---|
| `RPC_URL` | client, keeper, solver, page, demo bots | `http://127.0.0.1:8545` | The chain's JSON-RPC endpoint |
| `DEPLOYMENTS` | client, keeper, solver | `deployments/blindfold.local.json` | Deployment manifest: chain id, vault, settlement, tokens, deposit token, and admission (verifiers plus parameter manifest hash, or `off`) |
| `CONTRACTS_OUT` | client, solver, scripts | `contracts/out` | Where `forge build` wrote the contract artifacts |
| `MNEMONIC` | client, keeper, solver | Anvil's test mnemonic | Used to derive accounts when no private key is set |
| `DRAND` | client, keeper | live drand quicknet | Path to a recorded-rounds fixture (offline tests) instead of the live beacon |
| `POLL_MS` | keeper, solver | `3000` | How often the service checks for work |

## Client

| Variable | Default | Meaning |
|---|---|---|
| `PRIVATE_KEY` | none | The account's key; if unset, the account is derived from `MNEMONIC` |
| `CLIENT_ACCOUNT_INDEX` | `10` | Mnemonic index when `PRIVATE_KEY` is unset |
| `CLIENT_STATE` | `packages/client/.state/` | Directory for private state (orders, salts, funding) |
| `CLIENT_CONFIRMATIONS` | `1` on chain 31337, otherwise `3` | Confirmations before a transaction counts as final (1 to 64) |
| `ADMISSION_PROVER` | none | Path to the built `local-prover` (admission on) |
| `ADMISSION_PARAMS` | none | Directory of the Groth16 parameters; its `manifest.json` hash must match the deployment |
| `ADMISSION_MIN_LEAD_SECONDS` | `120` with a preparation, `180` without | Refuse to start proving if the batch's commit window closes sooner than this |

## Keeper

| Variable | Default | Meaning |
|---|---|---|
| `KEEPER_KEY` | none | The keeper's key; otherwise mnemonic index `KEEPER_INDEX` |
| `KEEPER_INDEX` | `1` | |
| `KEEPER_BUDGET_WEI` | unlimited | Total gas the keeper may spend |
| `KEEPER_MIN_BALANCE_WEI` | `10^15` | Stop sending below this ETH balance |
| `KEEPER_STATUS` | none | File for the last cycle's status; it also carries the spend across restarts |

## Solver

| Variable | Default | Meaning |
|---|---|---|
| `SOLVER_KEY` | none | The solver's key; otherwise mnemonic index 2 |
| `SETTLEMENT_ARTIFACT` | from `contracts/out` | The settlement ABI to use (`AdmittedSettlement` when admission is on) |
| `ETH_RPC`, `BLOCKS`, `BLOCK_STEP` | | External-reference and routing reads; see [the solver README](../packages/solver/README.md) |

## Trading page

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3100` | Port on `127.0.0.1` |
| `OFFLINE` | unset | `1`: the landing page's sandwich lookup serves fixtures only |
| `ETHERSCAN_API_KEY` / `DUNE_API_KEY` | none | Address lookups on the landing page |
| `STACK_HEALTH` | set by `dev.sh` | Path to the stack's `health.json` |
| `COURT_DEPLOYMENT` | `deployments/court.local.json` | Shows the Court ledger when present |

The page server passes its environment to the CLI it runs, so the client variables above apply too.

## Arkiv (optional history)

| Variable | Default | Meaning |
|---|---|---|
| `ARKIV` | `off` | `off`: a local file store; `testnet`: the Arkiv network |
| `ARKIV_FILE` | `<CLIENT_STATE>/arkiv-local.json`, or `./.blindfold/arkiv-local.json` without `CLIENT_STATE` | The local store, shared by the page and solver |
| `ARKIV_RPC`, `ARKIV_KEY` | none | Both are required for `testnet`; without them history shows as unavailable and trading continues |

## Local stack (`scripts/dev.sh`)

| Variable | Default | Meaning |
|---|---|---|
| `WEB_PORT` | any free port | Pin the page's port, for example for a browser preview |
| `ADMISSION_PARAMS` | `packages/proof-bench/results/admission-params` | Development parameters |
| `ADMISSION_PROVER` | built on start | Reuse an existing `local-prover` |

## Court

The Court watcher and demo bots have their own settings (`ETH_RPC`, `BASE_RPC`, `COURT_RPC`, `WATCHER_KEY`, `RECEIPTS`, `WATCH_DIR`, `CLAIM_WINDOW`, …). See [`packages/court-watcher`](../packages/court-watcher) and [`DEMO.md`](../DEMO.md).
