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

Terminal 1: the sniper, which also serves the mempool the victims send through (`http://127.0.0.1:8546`):
```bash
npm run sniper
```

Scene 1, unprotected swaps. Each victim loses about its whole slippage to a front/back pair in the same block:
```bash
npm run traffic -- swap
```

Scene 2, Blindfold. Start the keeper and solver against the testnet deployment first:
```bash
(cd ../keeper && RPC_URL=$RPC_URL DEPLOYMENTS=../../deployments/blindfold.testnet.json MNEMONIC="$DEMO_MNEMONIC" npm start)
(cd ../solver && RPC_URL=$RPC_URL DEPLOYMENTS=../../deployments/blindfold.testnet.json MNEMONIC="$DEMO_MNEMONIC" npm start)
npm run traffic -- blindfold
```
The victims deposit and commit at the same time, so every order lands in one batch. If the open batch closes within 15 s, they wait for the next one.
The sniper sees each commit and fails to decrypt it ("too early to decrypt"). It then tries to swap on the sealed pool and gets `OnlySettlement` from the pool's hook. About a minute later the keeper reveals the batch, and the solver settles every order at one price.

Each account can hold commitments in one open batch at a time. Wait for the batch to settle before you run scene 2 again.

## Env

| Var | Default |
|---|---|
| `RPC_URL` | `https://sepolia.unichain.org` |
| `POOL_MANAGER` | Uniswap's on Unichain Sepolia; elsewhere, or `new`, deploys one |
| `MEMPOOL_PORT` | `8546` |
| `FUND_ETH` / `POOL_ETH` / `BOT_ETH` | `0.01` / `0.02` / `0.02` ETH |
| `SWAP_ETH` / `SLIPPAGE_BPS` | `0.004` ETH / `300` |
| `BATCH_SECONDS` / `DEPOSIT` / `VICTIM_TOKENS` / `SEALED_LIQUIDITY` / `ORDER_SIZE` | `60` / `1` / `1000` / `10000` / `10` |
| `SANDWICH_DEPLOYMENTS` / `DEPLOYMENTS` | `deployments/demo.testnet.json` / `deployments/blindfold.testnet.json` |
