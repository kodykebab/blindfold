# HANDOFF.md

Current status and what to pick up next. Product and design: [CONTEXT.md](CONTEXT.md). Repo rules, setup and gotchas: [AGENTS.md](AGENTS.md).

## Status
`forge test --fuzz-runs 4096`: **215/215 passing** across 11 suites, including the Unichain fork suites, proportional-clearing regressions, settlement ordering and FeesAndTiming.

| Piece | State | Where |
|---|---|---|
| Vault, commit, anyone-reveal, slashing, padding orders | ✅ Built + tested | `contracts/src/BlindfoldVault.sol`, `BatchAuction.sol` |
| Verified uniform-price settle, residual swap, LP donation, expire | ✅ Built + tested (local and Unichain fork) | `contracts/src/BlindfoldSettlement.sol` |
| Sealed v4 pool hook | ✅ Built + tested | `contracts/src/SealedPoolHook.sol` |
| `SealedClearing` SwapVM instruction + router | ✅ Built + tested with swap-vm's Aqua helpers | `contracts/src/swapvm/` |
| Court verifier (BLOCKHASH / EIP-2935 / L1 anchor, v3 + v4, signer recovery) | ✅ Built + tested on live mainnet sandwiches | `contracts/src/court/` |
| Sandwich finder, proof + anchor builder | ✅ Working against mainnet | `packages/court-watcher/` |
| Aqua leg inside `settle` (split residual between v4 and Aqua) | ⬜ | — |
| `BondRegistry`: bonds, EIP-712 protection receipts, payout + slashing | ⬜ **next Must** | — |
| Court on Base: deploy + `checkpoint()` live | ⬜ | — |
| tlock client CLI: funding, commit, tracking, cleanup, withdrawal, saved-state import/export | ✅ Built + tested, 21 integrated client tests | `packages/client/` |
| Local two-proof circuits and Solidity composition harness | ✅ Isolated prototype, tests and interoperability verified | `packages/proof-bench/circuit/` |
| Keeper and solver | Planned integration | `packages/` |
| Arkiv entities (writes), Swarm ciphertext storage | ⬜ | `arkiv/` |
| Demo bots (sandwich bot, "leaky" protected RPC), Court watcher service | ⬜ | `packages/demo-bots` |
| UI: batch view, mempool view, Court ledger (reads Arkiv) | ⬜ | `app/` |
| Submission docs: `FEEDBACK.md`, `arkiv/*.md`, README line pointers, video | ⬜ | — |

## Next steps
The current merge results and remaining sequence are in [PLAN.md](PLAN.md#review-and-release-sequence-2026-11-06). Production admission is issue #29; use the selected local two-proof design in ARCHITECTURE.MD. Current validation commands: `source env.sh`, `cd contracts && forge test --fuzz-runs 4096`, then from `packages/client`, `CLIENT_E2E=1 CLIENT_RELEASE_E2E=1 npm test` using the generated artifacts. The release-policy fixture tests cleanup only. See REVIEW.md for implementation boundaries and tracked findings.

## Interfaces to build against
- `BlindfoldSettlement.commit(uint64 batchId, bytes32 hash, bytes ciphertext)`, `reveal(uint256 id, Order, bytes32 salt)`, `slashUnrevealed(id)`, `settle(uint64 batchId, uint256 priceX96)`, `expire(batchId)`.
- Client hash: `orderHash(batchId, order, salt)` (view). Encrypt `abi.encode(order, salt)` to `targetRound(batchId)`.
- Costs and policy views: `commitFee()` (non-refundable, charged in `depositToken` on every commit), `depositAmount()`, `bountyBps()`, `admissionRequired()` (false until R2's admission entry point; when true, `slashUnrevealed` releases the deposit and emits `Released` instead of `Slashed`).
- Schedule views: `currentBatch()`, `commitsClose(b)`, `revealOpens(b)`, `revealCloses(b)`, `settleCloses(b)`.
- Events for keepers/indexers: `Committed(id, batchId, committer, hash, round, ciphertext)`, `Revealed`, `RevealedUnfunded`, `Slashed`, `Released`, `Filled`, `Unfilled`, `Settled`, `Expired`.
- Solver: `poolPriceX96()`, `quote(order, p)`, and the proportional `settle(batchId, priceX96, marginalId, marginalAmountIn)` overload. The representative defines the equal-limit fraction; follow PLAN.md’s exact integer allocation seam and simulate the complete candidate. Tests search both price directions.
- Client: `CLIENT_ACCOUNT_INDEX` defaults to local account 10; numeric legacy `USER` remains supported and `PRIVATE_KEY` takes precedence.
- Court: `SandwichCourtVerifier.verify(Claim) → Verdict{blockNumber, blockHash, victimTxHash, attacker, victim, profitInToken0, profit}`; `checkpoint()` on Base.

## Court fixture workflow
```bash
cd packages/court-watcher
N=300 node find.mjs                     # prints candidate sandwiches as JSON lines
ANCHOR=1 BLOCK=<n> FRONT=<tx>:<log> VICTIM=<tx>:<log> BACK=<tx>:<log> POOL=<v3 pool> \
  OUT=../../contracts/test/court/fixtures/<name>.json node prove.mjs
# v4: add V4=1 POOLID=<id> and drop POOL
```
Run `prove.mjs` with `ANCHOR=1` within ~25 minutes of the sandwich: public RPCs stop serving `eth_getProof` for older state.

## Needs a person
- An **Arkiv access key** (hub.arkiv.network/access-keys) and faucet **tGLM** for a team wallet.
- A **Swarm postage batch** (Arkiv/Swarm booth, or a funded Bee light node).
- **Booth questions:** 1inch: is the re-composed router (official SwapVM + AquaOpcodes + one appended opcode) eligible? Uniswap: are the sealed hook and Court both in scope? Arkiv: sanity-check the entity and expiry design.
