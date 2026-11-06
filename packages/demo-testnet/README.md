# demo-testnet

Live demo on a public testnet: a sniper bot sandwiches ordinary swaps, then fails against Blindfold.

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
(cd contracts && forge build --no-dynamic-test-linking)   # without the flag, test helpers call a cheatcode and revert on a real chain
cd packages/demo-testnet && npm ci
npm run wallets -- new          # writes DEMO_MNEMONIC to .env (gitignored)
npm run wallets -- list         # fund the deployer (index 0) with 0.13 ETH from a faucet
npm run wallets -- fund         # deployer tops the others up to FUND_ETH; the sniper gets BOT_ETH extra
npm run deploy                  # both scenes; writes deployments/demo.testnet.json and blindfold.testnet.json
```

`RPC_URL` defaults to Unichain Sepolia (`https://sepolia.unichain.org`), where both scenes use Uniswap's own v4 PoolManager (`0x00B036B58a818B1BC34d502D3fE730Db729e62AC`). On any other chain, `deploy` deploys a PoolManager.

The deployer needs 0.12 ETH at the defaults: 0.01 for each of 8 wallets, 0.02 for the bot's capital and 0.02 for the pool. Gas on Unichain Sepolia costs almost nothing (about 0.0015 gwei). Scale everything down together with `FUND_ETH`, `BOT_ETH`, `POOL_ETH` and `SWAP_ETH`.

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
Each victim loses about its whole slippage to a front-run and back-run in the same block. The sniper prints its profit, and every transaction gets a Uniscan link.

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
| `POOL_MANAGER` | Uniswap's on Unichain Sepolia; elsewhere, or `new`, deploys one |
| `MEMPOOL_PORT` | `8546` |
| `SNIPER_ONCHAIN` | `1`: land one reverted front-run per batch; `0` simulates only |
| `FUND_ETH` / `POOL_ETH` / `BOT_ETH` | `0.01` / `0.02` / `0.02` ETH |
| `SWAP_ETH` / `SLIPPAGE_BPS` | `0.004` ETH / `300` |
| `BATCH_SECONDS` / `DEPOSIT` / `VICTIM_TOKENS` / `SEALED_LIQUIDITY` / `ORDER_SIZE` | `60` / `1` / `1000` / `10000` / `10` |
| `SANDWICH_DEPLOYMENTS` / `DEPLOYMENTS` | `deployments/demo.testnet.json` / `deployments/blindfold.testnet.json` |
