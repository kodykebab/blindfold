# Blindfold + Court

*MEV protection without a middleman to trust: prevented by construction, punished by proof.*

- **Blindfold**: orders are timelock-encrypted to a future drand round, revealed by anyone once it passes, and settled at one price the contract verifies against a Uniswap v4 pool only batches can swap. Residuals can also fill against 1inch Aqua liquidity through a custom SwapVM instruction.
- **Court**: a sandwich is proven fully onchain (header, tx and receipt proofs, signers recovered), so the protected RPC that promised to shield the victim can be slashed. Runs on Base and judges Ethereum through an L1 anchor.

**License:** MIT ([LICENSE](LICENSE)); two files adapted from Uniswap v3-periphery are GPL-2.0-or-later. **Uniswap feedback:** [FEEDBACK.md](FEEDBACK.md). Jump to: [Uniswap integration](#uniswap-integration) · [Run it locally](#run-it-locally) · [CROPS](#crops).

## Contracts
| File | What |
|---|---|
| [`BlindfoldVault.sol`](contracts/src/BlindfoldVault.sol) | Internal balances; no withdrawals while a commitment is open |
| [`BatchAuction.sol`](contracts/src/BatchAuction.sol) | drand-quicknet schedule, `commit`, anyone-`reveal` with bounty, `slashUnrevealed` |
| [`BlindfoldSettlement.sol`](contracts/src/BlindfoldSettlement.sol) | `settle(batchId, p*)`: limit-determined fills, one residual swap, post-swap marginal price check, surplus donated to LPs |
| [`SealedPoolHook.sol`](contracts/src/SealedPoolHook.sol) | v4 `beforeSwap` hook: only the settlement may swap |
| [`swapvm/`](contracts/src/swapvm) | `SealedClearing` instruction + `BlindfoldAquaRouter` |
| [`court/SandwichCourtVerifier.sol`](contracts/src/court/SandwichCourtVerifier.sol) | Sandwich proof verifier with BLOCKHASH / EIP-2935 / L1-anchor block hashes |
| [`court/lib/`](contracts/src/court/lib) | RLPReader, MerkleTrie, Bytes from Optimism (MIT, see `LICENSE-optimism`) |

## Uniswap integration

Blindfold is a Uniswap v4 hook plus the only contract allowed through it. Where to look:

| What | Code |
|---|---|
| **The hook.** `beforeSwap` reverts `OnlySettlement` unless the swap comes from the settlement contract, so no searcher can trade the pool between batches. Liquidity adds and removes stay open. | [`SealedPoolHook.sol` L25–34](contracts/src/SealedPoolHook.sol#L25-L34) |
| **Hook address.** v4 reads permissions from the hook's address, so the hook is deployed with CREATE2 at a mined salt whose address carries only `BEFORE_SWAP_FLAG`. | [`SealedPoolHookFactory.sol`](contracts/src/SealedPoolHookFactory.sol), [`DeployBlindfold.s.sol` L153–177](contracts/script/DeployBlindfold.s.sol#L153-L177) (PoolManager, hook mining, `initialize`) |
| **Pool checks.** With admission on, the pool key must use exactly the sealed hook, the vault's pair and an initialized price. | [`AdmissionValidator.sol` L43–53](contracts/src/admission/AdmissionValidator.sol#L43-L53) |
| **Settlement swap.** Each batch's net imbalance (the residual) is swapped inside `PoolManager.unlock`: `swap` → sign-checked deltas → `sync`/`settle` → `take`, and any surplus beyond what orders are owed is `donate`d to in-range LPs. | [`BlindfoldSettlement.sol` L505–548](contracts/src/BlindfoldSettlement.sol#L505-L548) |
| **Price checks.** The pool price is read with `StateLibrary.getSlot0`; after the residual swap, the pool's marginal price must equal the batch's clearing price within `toleranceBps`. | [`poolPriceX96` L215](contracts/src/BlindfoldSettlement.sol#L215), [`_checkMarginal` L482–486](contracts/src/BlindfoldSettlement.sol#L482-L486), [`settle` L242–250](contracts/src/BlindfoldSettlement.sol#L242-L250) |
| **Uniswap v3 reference and route.** An authenticated v3 pool gives batch-timed reference prices (`observe`) and executes external residuals. | [`UniswapV3Market.sol` L79–156](contracts/src/market/UniswapV3Market.sol#L79-L156), [`UniswapV3Route.sol`](contracts/src/market/UniswapV3Route.sol) |
| **Court reads Uniswap swaps.** The verifier decodes v3 and v4 `Swap` logs from proven receipts to establish front, victim and back. | [`SandwichCourtVerifier.sol` L32–33, L221](contracts/src/court/SandwichCourtVerifier.sol#L32-L33), [`court-watcher/lib.mjs` L9–10, L120](packages/court-watcher/lib.mjs#L9-L10) |

**Tests:** [`test_hook_rejectsSwapsOutsideSettlement`](contracts/test/Blindfold.t.sol#L93) shows a router swap reverting with the hook's `OnlySettlement` (wrapped by v4 as `WrappedError`). [`test_batch_settlesAtOneVerifiedPrice`](contracts/test/Blindfold.t.sol) and the rest of `contracts/test/` cover settlement through the pool. `forge test` in `contracts/` runs them all.

## Run
```bash
source env.sh
git submodule update --init --recursive
(cd contracts/lib/swap-vm && npm install --ignore-scripts)
cd contracts && forge test
```
Court tooling: `cd packages/court-watcher && npm install && N=300 node find.mjs`, then `prove.mjs` (see its header).

## Run it locally

A full order on a local chain, with the client CLI, keeper and solver (admission off, so no proving setup is needed). Terminal 1: `anvil --block-time 1 --accounts 20` (the client trades as account 10). Terminal 2, from the repo root:
```bash
source env.sh && git submodule update --init --recursive && (cd contracts/lib/swap-vm && npm install --ignore-scripts)
(cd contracts && forge script script/DeployBlindfold.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil account 0 key>)
for p in client keeper solver; do (cd packages/$p && npm ci --ignore-scripts); done
# local test tokens for the trader (anvil account 10, the client's default) — mint both TKA and TKB from deployments/blindfold.local.json
cast send --rpc-url http://127.0.0.1:8545 --private-key <anvil account 0 key> <token0> "mint(address,uint256)" <account 10 address> 100000000000000000000
cd packages/client && npm start -- status && npm start -- commit sell 10 9      # encrypts to drand and commits
(cd packages/keeper && npm start) & (cd packages/solver && npm start) &           # reveal after the drand round, then settle
npm start -- track && npm start -- withdraw token0 all
```
A second account (`CLIENT_ACCOUNT_INDEX=11`, its own `CLIENT_STATE` directory, `commit buy 10 9`) gives the batch a counterparty. Everything else is in each package's README.

## CROPS

- **C:** We control only the website (the haveibeensandwiched sandwich checker) and its lookup API: no relayer, sequencer or hosted RPC. If it vanishes or refuses you, trading is unaffected: it runs from this repo against your own RPC, the keeper and solver are permissionless, you can reveal your own order, and anyone can expire an unsettled batch, so funds always unlock (contract admin is setup-only: no upgrade, pause or withdrawal power).
- **O:** MIT ([LICENSE](LICENSE); two files adapted from Uniswap v3-periphery are GPL-2.0-or-later). Yes, it builds and runs from the repo alone: Foundry and Node 22 run a local chain, the deployment, the client, keeper and solver ([Run it locally](#run-it-locally)); the admission prover in `packages/proof-bench` builds from source too.
- **P:** Your RPC provider sees your IP, address and every transaction; drand's endpoint sees your IP and the rounds you fetch; our website sees your IP and the address or hash you check and forwards it to Etherscan or Dune (no analytics or cookies). The chain sees deposits and commit timing, but an order's side, size and limit stay encrypted until its batch's drand round.
- **S:** Keys stay with the local CLI (a key you set, or an Anvil test account); order secrets and proof inputs never leave your machine (automatic backups are AES-256-GCM encrypted). We assume drand doesn't release rounds early, the development Groth16 setup is honest (production needs a ceremony) and Uniswap v4 is correct; a solver can delay but not misprice a batch, and the contracts are unaudited ([details](SECURITY.md)).
