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

## Try it locally
```bash
source env.sh
WEB_PORT=4400 ADMISSION_PARAMS=packages/proof-bench/results/admission-params scripts/dev.sh
```
`dev.sh` checks its tools (Node 22, Foundry, Go) and names any that are missing. It then starts a private Anvil with a v4 pool, hook, admission verifiers and settlement, plus the trading page, keeper and solver. It prints `LOCAL_WEB_URL` and reports each service's health; Ctrl-C stops everything. It uses Anvil test accounts and local test tokens only, never real keys or funds. Generate the development proving parameters first (`packages/proof-bench/README.md`).

On the page:
1. **Refresh** to load the account, pair and balances.
2. **Deposit** both tokens into the vault. The page never deposits a shortfall for you.
3. **Prepare** for the next batch if you can. This takes the slow proof (about 2 to 3 minutes on an M-series laptop) out of the order.
4. **Review**, then **Confirm**. The steps Encrypt → Prove → Submit → Included show progress.
5. **Export a backup.** Without it, the order can't be recovered if this machine is lost. The reminder stays until you confirm the backup is saved.
6. After the batch settles, **Your orders** shows filled, partly filled or unfilled, with unused input. Clean up anything blocking withdrawal, then **Withdraw all**.

Batches last 300 s. The keeper reveals once the drand round is out, and the solver settles after the reveal window.

## Tests
| Command | What it runs |
|---|---|
| `scripts/check.sh` | Offline: contracts, every package, scripts, Go circuit tests (`--fork` adds fork tests) |
| `scripts/e2e.sh` | Real web service, CLI, keeper and solver on a local v4 pool, admission off; outages, restarts and racing keepers included |
| `scripts/e2e.sh --real-proof` | Adds fresh Groth16 proofs end to end, and admission recovery |
| `ORDERS_E2E=1`, `PROVER_E2E=1`, `A11Y_E2E=1` `node --test app/haveibeensandwiched/<name>.e2e.test.mjs` | Browser acceptance: order outcomes, prover and backup screens, keyboard and 375 px |

`TRUST-BOUNDARIES.md` describes what each local component may see and do. `CHECKLIST.md` tracks release status, with the test that proves each item.
