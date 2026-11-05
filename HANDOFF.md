# HANDOFF.md

Current status and what to pick up next. Product and design: [CONTEXT.md](CONTEXT.md). Phases, checklist and who owns what: [PLAN.md](PLAN.md). Repo rules, setup and gotchas: [AGENTS.md](AGENTS.md); team workflow: [CONTRIBUTING.md](CONTRIBUTING.md).

## Status
`forge test`: **48/48 passing** (13 local + 13 Unichain fork + 4 SwapVM + 18 Court).

| Piece | State | Where | Owner |
|---|---|---|---|
| Vault, commit, anyone-reveal, slashing, padding orders | ✅ Built + tested | `contracts/src/BlindfoldVault.sol`, `BatchAuction.sol` | Kritarth |
| Verified uniform-price settle, residual swap, LP donation, expire | ✅ Built + tested (local and Unichain fork) | `contracts/src/BlindfoldSettlement.sol` | Kritarth |
| Sealed v4 pool hook | ✅ Built + tested | `contracts/src/SealedPoolHook.sol` | Kritarth |
| `SealedClearing` SwapVM instruction + router | ✅ Built + tested with swap-vm's Aqua helpers | `contracts/src/swapvm/` | Kritarth |
| Court verifier (BLOCKHASH / EIP-2935 / L1 anchor, v3 + v4, signer recovery) | ✅ Built + tested on live mainnet sandwiches | `contracts/src/court/` | Bhoumik (Kritarth reviews verifier changes) |
| Sandwich finder, proof + anchor builder | ✅ Working against mainnet | `packages/court-watcher/` | Bhoumik |
| Deploy script + local deployments file | ⬜ | `contracts/script/DeployBlindfold.s.sol` | Kritarth |
| Aqua strategy with real token transfers; Aqua leg inside `settle` | ⬜ | `contracts/src/swapvm/`, `BlindfoldSettlement.sol` | Kritarth |
| Solver | ⬜ | `packages/solver` | Kritarth |
| `BondRegistry`: bonds, EIP-712 protection receipts, payout + slashing | ⬜ **next Must** | `contracts/src/court/BondRegistry.sol` | Bhoumik |
| Court deploy (local fork, then Base + `checkpoint()` live) | ⬜ | `contracts/script/DeployCourt.s.sol` | Bhoumik |
| Demo bots (sandwich bot, "leaky" protected RPC), Court watcher service | ⬜ | `packages/demo-bots`, `packages/court-watcher` | Bhoumik |
| Arkiv wrapper + entities, Swarm ciphertext storage | ⬜ | `packages/arkiv`, `arkiv/` | Khush |
| tlock client (encrypt + commit), keeper (Arkiv → drand → reveal) | ⬜ | `packages/client`, `packages/keeper` | Khush |
| UI: batch view, mempool view, Court ledger (reads Arkiv) | ⬜ | `app/` | Khush |
| Submission docs: `FEEDBACK.md`, `arkiv/*.md`, README line pointers, video | ⬜ | — | per prize owner, see PLAN.md Phase 3 |

## Next steps
Phase 1 of [PLAN.md](PLAN.md). Each person starts with their ⚑ item, because a teammate consumes it in Phase 2:
- **Kritarth:** `DeployBlindfold.s.sol` → `deployments/blindfold.local.json`.
- **Bhoumik:** `BondRegistry` against the existing v3/v4 fixtures, then `DeployCourt.s.sol`.
- **Khush:** `packages/arkiv` with its offline (`ARKIV=off`) backend, plus `arkiv/schema.md`.

Integration target (end of Phase 2): one full batch end to end on the Unichain fork, and one Court refund on the same fork, both visible in the UI through Arkiv.

## Interfaces to build against
- `BlindfoldSettlement.commit(uint64 batchId, bytes32 hash, bytes ciphertext)`, `reveal(uint256 id, Order, bytes32 salt)`, `slashUnrevealed(id)`, `settle(uint64 batchId, uint256 priceX96)`, `expire(batchId)`.
- Client hash: `orderHash(batchId, order, salt)` (view). Encrypt `abi.encode(order, salt)` to `targetRound(batchId)`.
- Schedule views: `currentBatch()`, `commitsClose(b)`, `revealOpens(b)`, `revealCloses(b)`, `settleCloses(b)`.
- Events for keepers/indexers: `Committed(id, batchId, committer, hash, round, ciphertext)`, `Revealed`, `RevealedUnfunded`, `Slashed`, `Filled`, `Unfilled`, `Settled`, `Expired`.
- Solver: `poolPriceX96()`, `quote(order, p)`; search `p*` down from the pool price until `settle` succeeds (see `_solve` in `test/Blindfold.t.sol`).
- Court: `SandwichCourtVerifier.verify(Claim) → Verdict{blockNumber, blockHash, victimTxHash, attacker, victim, profitInToken0, profit}`; `checkpoint()` on Base.
- Cross-lane seams (deployments files, `packages/arkiv` API, ports, anvil accounts, env vars): [PLAN.md](PLAN.md#seams).

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
- **Khush:** an **Arkiv access key** (hub.arkiv.network/access-keys) and faucet **tGLM** for a team wallet; a **Swarm postage batch** (Arkiv/Swarm booth, or a funded Bee light node).
- **Booth questions:** Kritarth → 1inch: is the re-composed router (official SwapVM + AquaOpcodes + one appended opcode) eligible? Bhoumik → Uniswap: are the sealed hook and Court both in scope? Khush → Arkiv: sanity-check the entity and expiry design.
