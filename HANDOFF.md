# HANDOFF.md

Current status and what to pick up next. Product and design: [CONTEXT.md](CONTEXT.md). Repo rules, setup and gotchas: [AGENTS.md](AGENTS.md).

## Status
`forge test`: **152/152 passing** (19 local + 19 Unichain fork + 29 ReservationModel, which re-runs the 19 local + 4 SwapVM + 23 Court verifier + 53 BondRegistry + 3 self-sandwich model + 2 demo sandwich).

| Piece | State | Where |
|---|---|---|
| Vault, commit, anyone-reveal, slashing, padding orders | ✅ Built + tested | `contracts/src/BlindfoldVault.sol`, `BatchAuction.sol` |
| Verified uniform-price settle, residual swap, LP donation, expire | ✅ Built + tested (local and Unichain fork) | `contracts/src/BlindfoldSettlement.sol` |
| Sealed v4 pool hook | ✅ Built + tested | `contracts/src/SealedPoolHook.sol` |
| `SealedClearing` SwapVM instruction + router | ✅ Built + tested with swap-vm's Aqua helpers | `contracts/src/swapvm/` |
| Court verifier (BLOCKHASH / EIP-2935 / L1 anchor, v3 + v4, signer recovery) | ✅ Built + tested on live mainnet sandwiches | `contracts/src/court/` |
| Sandwich finder, proof + anchor builder | ✅ Working against mainnet | `packages/court-watcher/` |
| Aqua leg inside `settle` (split residual between v4 and Aqua) | ⬜ | — |
| `BondRegistry`: bonds, EIP-712 protection receipts, capped payouts, pool pinning | ✅ Built + tested on the mainnet fixtures (deploy script next) | `contracts/src/court/BondRegistry.sol` |
| Court on Base: deploy + `checkpoint()` live | ⬜ | — |
| tlock client (encrypt + commit), keeper (Arkiv → drand → reveal), solver | ⬜ | `packages/` |
| Arkiv entities (writes), Swarm ciphertext storage | ⬜ | `arkiv/` |
| Demo bots (sandwich bot, "leaky" protected RPC); watcher claims and collects | ✅ Built; the covered flow runs end to end on a plain anvil (`scripts/court-demo.sh`). The watcher's Arkiv writes aren't built | `packages/demo-bots`, `packages/court-watcher` |
| UI: batch view, mempool view, Court ledger (reads Arkiv) | ⬜ | `app/` |
| Submission docs: `FEEDBACK.md`, `arkiv/*.md`, README line pointers, video | ⬜ | — |

## Next steps
Who builds what, phase by phase, is in [PLAN.md](PLAN.md); known design flaws and their fixes are in [REVIEW.md](REVIEW.md).

## Interfaces to build against
- `BlindfoldSettlement.commit(uint64 batchId, bytes32 hash, bytes ciphertext)`, `reveal(uint256 id, Order, bytes32 salt)`, `slashUnrevealed(id)`, `settle(uint64 batchId, uint256 priceX96)`, `expire(batchId)`.
- Client hash: `orderHash(batchId, order, salt)` (view). Encrypt `abi.encode(order, salt)` to `targetRound(batchId)`.
- Schedule views: `currentBatch()`, `commitsClose(b)`, `revealOpens(b)`, `revealCloses(b)`, `settleCloses(b)`.
- Events for keepers/indexers: `Committed(id, batchId, committer, hash, round, ciphertext)`, `Revealed`, `RevealedUnfunded`, `Slashed`, `Filled`, `Unfilled`, `Settled`, `Expired`.
- Solver: `poolPriceX96()`, `quote(order, p)`; search `p*` down from the pool price until `settle` succeeds (see `_solve` in `test/Blindfold.t.sol`).
- Court: `SandwichCourtVerifier.verify(Claim) → Verdict{blockNumber, blockHash, victimTxHash, attacker, victim, profitInToken0, profit, frontIn}` (`frontIn`: what the front leg paid into the pool, in the profit token, fee included); `checkpoint()` on Base. A sandwich needs one signer for front and back and one contract making both swaps (the pool's caller, `sender` in v3 and v4 Swap events); the victim may use any route, including the attacker's router (S5).

## Court fixture workflow
```bash
cd packages/court-watcher
N=300 node find.mjs                     # prints candidate sandwiches as JSON lines
ANCHOR=1 BLOCK=<n> FRONT=<tx>:<log> VICTIM=<tx>:<log> BACK=<tx>:<log> POOL=<v3 pool> \
  OUT=../../contracts/test/court/fixtures/<name>.json node prove.mjs
# v4: add V4=1 POOLID=<id> and drop POOL
```
Run `prove.mjs` with `ANCHOR=1` within ~25 minutes of the sandwich: public RPCs stop serving `eth_getProof` for older state.

## Court release boundary (S21, #27)
Court is a separate product from the auction. No auction contract imports Court, and Court runs on any v4 PoolManager with no auction deployed.

- **Auction only:** `scripts/auction-only.sh` copies `contracts/` without `src/court`, `test/court` and `DeployCourt`, checks that nothing left mentions Court, then builds that copy and runs the auction's offline tests in it (the Unichain fork suite needs the network). There's no auction deploy script yet (`DeployBlindfold` is Kritarth's Phase 1 item), so the deploy path it checks is the tests' `setUp`: PoolManager, vault, settlement and mined hook.
- **Covered transaction:** `scripts/court-demo.sh` runs on a plain anvil it starts on `:8555`, with no auction contracts:
  1. `demo-bots` `setup` deploys a plain ETH/DEMO 0.3% v4 pool on its own PoolManager, a shared router, and the sandwich bot's contract;
  2. `DeployCourt` lists that pool in `COURT_POOLS` and bonds the RPC signer;
  3. `demo-bots` `leak-and-sandwich`: the victim swaps through the "protected" RPC on `:8546`, which signs a `Protected` receipt (`maxPayout` from the tx's slippage, the sender as beneficiary, `acceptedAt` before inclusion) and leaks the tx. The bot's front and back legs come from one EOA and call the bot's own contract; the three land in one block;
  4. the watcher proves the sandwich (BLOCKHASH path), claims it from the RPC's bond, and collects after the claim window. The script checks the beneficiary's balance rose by the payout.

### Gates
A claim pays only if it passes every gate. Each gate has its own offline tests: `scripts/court-gates.sh <gate>` runs one gate, and with no argument, all of them.

| Gate | What a claim must pass | Status | Checked by |
|---|---|---|---|
| `issuance` (coverage issuance) | A `Protected` receipt for the victim tx, EIP-712-signed by an RPC with unreserved bond; it names a beneficiary and the chain this registry judges (through the matching block-hash path); the tx landed by `maxBlock`; `acceptedAt` is no later than the sandwich block; one claim per tx | ✅ Built | `BondRegistry.t.sol`, `BondRegistryUnit.t.sol`. Receipts from an RPC: `packages/demo-bots` `test/rpc.test.mjs`, and `court-demo.sh` (the registry accepts what the demo RPC signed) |
| `attribution` | Front and back signed by one EOA and swapped by one contract (the pool's caller: `sender` in v3 and v4 Swap events); the victim signed by another EOA, through any route (S5, #11) | ✅ Built | `SandwichCourt.t.sol` (`test_predicate*`, `test_recover_allTxTypes`, the shared-router fixtures); the demo's shape (bot legs through the bot's own contract, the victim through a shared router): `DemoSandwich.t.sol`, `court-demo.sh` |
| `evidence` (cross-chain evidence) | The header hashes to a known block: BLOCKHASH, EIP-2935, or a checkpointed L1 anchor plus account and storage proofs of L1's EIP-2935 contract; front, victim and back proven into the tx and receipt tries in order; one Swap log each for the claimed pool | ✅ Built, tested on recorded mainnet sandwiches. Not yet run against a live Base deployment | `SandwichCourt.t.sol`, `BondRegistry.t.sol` (anchored claim, wrong path); `court-demo.sh` (BLOCKHASH on anvil) |
| `valuation` | Profit counts 1:1 only in ETH or WETH (other tokens revert `UnvaluedProfit` and stay claimable); the budget is `min(profit, front leg's fee)`, capped at 2^128 − 1 wei and computed without overflow for any amounts (S17, #23); only listed, static-fee pools from the canonical v3 factory or v4 PoolManager | ✅ Built for ETH/WETH profit; no oracle. The fee cap doesn't hold against a coalition that supplies most of the in-range liquidity (JIT) | `BondRegistry.t.sol`, `BondRegistryUnit.t.sol`, `SelfSandwich.t.sol` (including `test_jitLiquidity_breaksTheBound`) |
| `incidents` (incident accounting) | Claims on one front swap share one budget; each back swap closes one incident; claims register inside the claim window; each weighs `min(maxPayout, budget)` and collects its share | ✅ Built | `BondRegistryUnit.t.sol` (unit, fuzz and the `incidentNeverOverpays` invariant) |
| `funding` (payout funding) | Payouts come only from the signing RPC's bond; a claim reserves its weight when it registers; unbonding waits a delay and leaves reservations behind; `collect` pays the beneficiary once, after the window; the prover's gas comes from the unreserved bond | ✅ Built | `BondRegistry.t.sol`, `BondRegistryUnit.t.sol` (including the bond invariants); `court-demo.sh` (bond, claim, collect, beneficiary paid) |

## Needs a person
- An **Arkiv access key** (hub.arkiv.network/access-keys) and faucet **tGLM** for a team wallet.
- A **Swarm postage batch** (Arkiv/Swarm booth, or a funded Bee light node).
- **Booth questions:** 1inch: is the re-composed router (official SwapVM + AquaOpcodes + one appended opcode) eligible? Uniswap: are the sealed hook and Court both in scope? Arkiv: sanity-check the entity and expiry design.
