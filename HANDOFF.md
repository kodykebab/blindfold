# HANDOFF.md

## Enforced local admission and private state

The admission integration adds `AdmissionVault`, `AdmittedSettlement`, the reusable local direct-Groth16 prover and cumulative client state. The full local gate is `source env.sh` followed by `bash packages/proof-bench/check-admission.sh`; install the existing dependencies first. It generates development parameters once under ignored `results/`, builds generated verifiers and uses fresh proofs with an isolated Anvil deployment. Client commands remain `commit`, `export-state` and `import-state`, with `resume-admission` for interrupted submissions. See PLAN's additive seams and the client README for deployment metadata and paths. Validation: 227 Foundry tests with configured forks and 4,096 fuzz runs; Go circuit and native-wrapper tests; client unit/Anvil regressions; fresh paired proofs through independent decryption, admission, reveal, settlement, withdrawal and release. REVIEW R2/R6/S11 distinguish enforced behavior from the remaining release gates.


Current status and what to pick up next. Product and design: [CONTEXT.md](CONTEXT.md). Repo rules, setup and gotchas: [AGENTS.md](AGENTS.md).

## Status
`forge test --fuzz-runs 4096`: **227/227 passing** across 13 suites, including the Unichain fork suites, proportional-clearing regressions, settlement ordering and FeesAndTiming.

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
| tlock client CLI: funding, commit, tracking, cleanup, withdrawal, saved-state import/export | ✅ Built + tested, 26 client regressions plus the fresh-proof admission gate | `packages/client/` |
| Local two-proof circuits and Solidity composition harness | ✅ Isolated prototype, tests and interoperability verified | `packages/proof-bench/circuit/` |
| Keeper and solver | Planned integration | `packages/` |
| Arkiv entities (writes), Swarm ciphertext storage | ⬜ | `arkiv/` |
| Demo bots (sandwich bot, "leaky" protected RPC), Court watcher service | ⬜ | `packages/demo-bots` |
| UI: batch view, mempool view, Court ledger (reads Arkiv) | ⬜ | `app/` |
| Submission docs: `FEEDBACK.md`, `arkiv/*.md`, README line pointers, video | ⬜ | — |

## Next steps
The complete delivery backlog is [tracker #67](https://github.com/kodykebab/blindfold/issues/67), with new implementation/release issues #60–#66 and the retained solver, keeper, Court and integration issues. Follow [PLAN delivery issues](PLAN.md#product-delivery-issues) for ownership and ordering. The next proof task is #60; production parameter work is #61, while #62/#63 cover browser delivery and transaction/state recovery.

The current merge results and remaining sequence are in [PLAN.md](PLAN.md#review-and-release-sequence-2026-11-06). The enforced local admission integration addresses #29/#17 using the selected two-proof design; advance preparation and production release requirements remain in REVIEW R6 and PLAN. Current validation commands: `source env.sh`, `cd contracts && forge test --fuzz-runs 4096`, then build deployable test helpers with `forge build --no-dynamic-test-linking` and run `CLIENT_E2E=1 CLIENT_RELEASE_E2E=1 npm test` from `packages/client`. The release-policy fixture tests cleanup only. See REVIEW.md for implementation boundaries and tracked findings.

## Interfaces to build against
- `BlindfoldSettlement.commit(uint64 batchId, bytes32 hash, bytes ciphertext)`, `reveal(uint256 id, Order, bytes32 salt)`, `slashUnrevealed(id)`, `settle(uint64 batchId, uint256 priceX96)`, `expire(batchId)`.
- Client hash: `orderHash(batchId, order, salt)` (view). Encrypt `abi.encode(order, salt)` to `targetRound(batchId)`.
- Costs and policy views: `commitFee()` (non-refundable, charged in `depositToken` on every commit), `depositAmount()`, `bountyBps()`, `admissionRequired()` (false on the original settlement and true on `AdmittedSettlement`; when true, `slashUnrevealed` releases the deposit and emits `Released` instead of `Slashed`).
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
