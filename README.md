# Blindfold + Court

*MEV protection without a middleman to trust: prevented by construction, punished by proof.*

- **Blindfold**: orders are timelock-encrypted to a future drand round, revealed by anyone once it passes, and settled at one price the contract verifies against a Uniswap v4 pool only batches can swap. Residuals can also fill against 1inch Aqua liquidity through a custom SwapVM instruction.
- **Court**: a sandwich is proven fully onchain (header, tx and receipt proofs, signers recovered), so the protected RPC that promised to shield the victim can be slashed. Runs on Base and judges Ethereum through an L1 anchor.

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

## Run
```bash
source env.sh
git submodule update --init --recursive
(cd contracts/lib/swap-vm && npm install --ignore-scripts)
cd contracts && forge test
```
Court tooling: `cd packages/court-watcher && npm install && N=300 node find.mjs`, then `prove.mjs` (see its header).

## Team
Bhoumik, Kritarth, Khush. Who builds what: [`PLAN.md`](PLAN.md). How we work: [`CONTRIBUTING.md`](CONTRIBUTING.md). Design: [`CONTEXT.md`](CONTEXT.md). Status: [`HANDOFF.md`](HANDOFF.md).
