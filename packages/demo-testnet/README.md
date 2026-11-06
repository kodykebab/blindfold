# demo-testnet

Live demo on a public testnet: a sniper bot sandwiches ordinary Uniswap v3 swaps, then fails against Blindfold.

## Wallets (9, from one mnemonic in `.env`)

| Index | Role |
|---|---|
| 0 | deployer: deploys everything, funds the others |
| 1 | keeper (`packages/keeper`) |
| 2 | solver (`packages/solver`) |
| 5 | sniper bot owner |
| 10–14 | victims 1–5 (`VICTIMS` changes the count) |

Never use anvil's public test mnemonic on a real chain: on Unichain Sepolia its first account is EIP-7702-delegated to a sweeper that drains any ETH it receives.

## Setup

```bash
source env.sh
(cd contracts && forge build --no-dynamic-test-linking)   # required for real-chain deployment
forge build --root packages/demo-testnet/contracts
(cd packages/court-watcher && npm ci)
cd packages/demo-testnet && npm ci
npm run wallets -- new          # writes DEMO_MNEMONIC to .env (gitignored)
npm run wallets -- list         # fund the deployer (index 0) with 0.13 ETH from a faucet
npm run wallets -- fund         # deployer tops the others up to FUND_ETH; the sniper gets BOT_ETH extra
npm run deploy                  # both scenes; writes deployments/demo.testnet.json and blindfold.testnet.json
```

`RPC_URL` defaults to Unichain Sepolia (`https://sepolia.unichain.org`). Scene 1 creates a v3 pool using the factory in Uniswap's published deployment manifest; scene 2 uses the v4 PoolManager. Set `V3_FACTORY` to use a factory explicitly. Elsewhere, `deploy` creates its own v3 factory and v4 PoolManager unless configured otherwise. The v3 pool uses two freely minted demo tokens; the bot's profit and the victim's loss are in those tokens.

The deployer needs testnet ETH for wallet funding and gas. The pool, bot and victim swaps use demo tokens rather than ETH; `POOL_ETH`, `BOT_ETH` and `SWAP_ETH` specify their token amounts in 18-decimal units. The default wallet funding transfers 0.1 ETH in total. Keep additional ETH for deployment and transaction gas.

## Rehearse without a faucet

Plain anvil:
```bash
anvil --block-time 1
RPC_URL=http://127.0.0.1:8545 DEMO_MNEMONIC="test test test test test test test test test test test junk" npm run deploy
```

A fork of Unichain Sepolia, which runs against the real PoolManager. Use a fresh mnemonic, because the public one is swept there:
```bash
anvil --block-time 1 --fork-url https://sepolia.unichain.org --port 8545
npm run wallets -- new
cast rpc --rpc-url http://127.0.0.1:8545 anvil_setBalance <deployer address> 0x429d069189e0000   # 0.3 ETH
RPC_URL=http://127.0.0.1:8545 npm run wallets -- fund && RPC_URL=http://127.0.0.1:8545 npm run deploy
```
anvil tips 1 gwei per transaction, about 700 times Unichain Sepolia's tip. A fork deploy therefore costs more, and the sniper's "after gas" profit is negative locally.

## Run the demo

The order follows CONTEXT.md's demo script. Every command runs from `packages/demo-testnet` with `RPC_URL` and `DEMO_MNEMONIC` set (both are read from `.env`).

### 1. The problem: a normal swap gets sandwiched
Terminal 1: the sniper, which also serves the mempool the victims send through (`http://127.0.0.1:8546`):
```bash
npm run sniper
```
Terminal 2:
```bash
npm run traffic -- swap
```
Each victim is quoted an output and then swaps through the v3 pool. The sniper prints the three transaction positions and its demo-token profit. The traffic command verifies that the three swaps form a detectable sandwich in one block. The haveibeensandwiched page on Testnet can check the victim transaction hash.

### 2. Blindfold: the same bot finds nothing
```bash
npm run traffic -- blindfold --settle
```
- The victims deposit and commit at once, so every order lands in one batch. If the open batch closes within 15 s, they wait for the next one.
- The sniper sees each commit and can't decrypt it ("too early to decrypt"). Its front-run on the sealed pool reverts with `OnlySettlement` from the pool's hook. Once per batch it lands that attempt onchain, so the revert has a Uniscan link (`SNIPER_ONCHAIN=0` only simulates it).
- `--settle` then runs the keeper (account 1) and the solver (account 2) once each. The keeper reveals after the drand round, and the solver settles every order at one price. Each victim's fill is printed.
- Without `--settle`, run them as services in their own terminals:
```bash
(cd ../keeper && DEPLOYMENTS=../../deployments/blindfold.testnet.json MNEMONIC="$DEMO_MNEMONIC" npm start)
(cd ../solver && DEPLOYMENTS=../../deployments/blindfold.testnet.json MNEMONIC="$DEMO_MNEMONIC" npm start)
```

### 3. The user stories, scenario by scenario
`scenarios.mjs` plays STORIES.md's acceptance scenarios on the testnet deployment. Each prints the story IDs it covers and the evidence the story asks for. Stop any keeper or solver service first: the scenarios run them once each when work is due, and the outage scenario needs them absent.

| Command | Stories | What happens |
|---|---|---|
| `npm run scenario -- first-trade` | T01–T05, T10, T11, T14 | victim1 reviews balances and a dry run (limit, fee, deposit, funding, deadlines). It commits and goes offline. The keeper reveals, the solver settles, and victim1 withdraws. |
| `npm run scenario -- repeat` | T08, T14 | victim2 places two orders in one batch, then a third paid from the vault proceeds with no tokens leaving the wallet. |
| `npm run scenario -- restore` | T15 | victim3's private state is deleted after it commits. `restore-backup` brings it back from the encrypted backup, and victim3 reveals its own order. |
| `npm run scenario -- no-fill` | T03, T11–T14 | victim4's limit can't be met, so its order stays unfilled while another order in the batch fills. `resubmit --dry-run` shows the replacement, then everything withdraws. |
| `npm run scenario -- outage` | T10, T12, O01, O03 | The solver is down, and after the 15 s grace period the keeper settles with the solver's own search. Then the keeper and solver are both down: victim5 reveals its own order, and the batch expires and unlocks. |
| `npm run scenario -- griefers` | O01, O02 | A commitment of random bytes is slashed after the reveal window. A clearing price 50% off the pool reverts onchain (Uniscan link), and the honest solver settles the same batch. |
| `npm run scenario -- all` | all of the above | About 20 minutes with 60 s batches. |

Each account can hold commitments in only one open batch at a time. Scenarios use different victims; rerun one only after its last batch has settled or expired.

### Not on the testnet
- **Proof-backed admission (T06, T07, T09):** the testnet deployment uses `admission: off`, because a real proof takes minutes per order. `scripts/e2e.sh --real-proof` covers these locally.
- **Court (C01–C04):** `scripts/court-demo.sh` runs the covered sandwich, claim and collection on a local chain.
- **Multi-token batches (G01):** `packages/global-auction`.

## Env

| Var | Default |
|---|---|
| `RPC_URL` | `https://sepolia.unichain.org` |
| `POOL_MANAGER` | Uniswap's v4 PoolManager on Unichain Sepolia; elsewhere, or `new`, deploys one |
| `V3_FACTORY` | Factory from Uniswap's published Unichain Sepolia manifest; elsewhere deploys one |
| `MEMPOOL_PORT` | `8546` |
| `SNIPER_ONCHAIN` | `1`: land one reverted front-run per batch; `0` simulates only |
| `FUND_ETH` | `0.01` ETH per wallet; sniper receives an additional `BOT_ETH` |
| `POOL_ETH` / `BOT_ETH` | `0.02` / `0.02` demo tokens for pool liquidity and bot inventory |
| `SWAP_ETH` / `SLIPPAGE_BPS` | `0.004` demo input tokens / `300` |
| `BATCH_SECONDS` / `DEPOSIT` / `VICTIM_TOKENS` / `SEALED_LIQUIDITY` / `ORDER_SIZE` | `60` / `1` / `1000` / `10000` / `10` |
| `SANDWICH_DEPLOYMENTS` / `DEPLOYMENTS` | `deployments/demo.testnet.json` / `deployments/blindfold.testnet.json` |
