# HANDOFF.md

## Enforced local admission and private state

The admission integration adds `AdmissionVault`, `AdmittedSettlement`, the reusable local direct-Groth16 prover and cumulative client state. The full local gate is `source env.sh` followed by `bash packages/proof-bench/check-admission.sh`; install the existing dependencies first. It generates development parameters once under ignored `results/`, builds generated verifiers and uses fresh proofs with an isolated Anvil deployment. Client commands include `prepare-admission <batch-id>` to prove before order selection, `commit`, `export-state` and `import-state`, with `resume-admission` for interrupted submissions. A ready preparation is consumed before online encryption and is omitted from state exports. See PLAN's additive seams and the client README for deployment metadata and paths. Validation: 227 Foundry tests with configured forks and 4,096 fuzz runs; Go circuit and native-wrapper tests; client unit/Anvil regressions; fresh paired proofs through independent decryption, admission, reveal, settlement, withdrawal and release. REVIEW R2/R6/S11 distinguish enforced behavior from the remaining release gates.


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
| `BondRegistry`: bonds, EIP-712 protection receipts, capped payouts, pool pinning | ✅ Built + tested on the mainnet fixtures (deploy script next) | `contracts/src/court/BondRegistry.sol` |
| Court on Base: deploy + `checkpoint()` live | ⬜ | — |
| tlock client CLI: funding, commit, tracking, cleanup, withdrawal, saved-state import/export | ✅ Built + tested, 26 client regressions plus the fresh-proof admission gate | `packages/client/` |
| Local two-proof circuits and Solidity composition harness | ✅ Isolated prototype, tests and interoperability verified | `packages/proof-bench/circuit/` |
| Keeper and solver | Planned integration | `packages/` |
| Arkiv entities (writes), Swarm ciphertext storage | ⬜ | `arkiv/` |
| Demo bots (sandwich bot, "leaky" protected RPC); watcher claims and collects | ✅ Built; the covered flow runs end to end on a plain anvil (`scripts/court-demo.sh`). The watcher's Arkiv writes aren't built | `packages/demo-bots`, `packages/court-watcher` |
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
| `funding` (payout funding) | Payouts come only from the signing RPC's bond; a claim reserves its weight when it registers; unbonding waits a delay, at least the ~27.3 h a sandwich stays provable, and leaves reservations behind; `collect` pays the beneficiary once, after the window; the prover's gas comes from the unreserved bond. A registry with no pools, no verifier code, no WETH, a zero or oversized window, or another chain to judge without an L1 anchor doesn't deploy (S18, #24) | ✅ Built | `BondRegistry.t.sol`, `BondRegistryUnit.t.sol` (including the bond invariants); `court-demo.sh` (bond, claim, collect, beneficiary paid) |

## Trading page / Arkiv / Court demo

### Done
- Trading page shows the configured pair (symbols, or a short address when that is what status printed), and wallet, available (vault), reserved (open commitments) and withdrawable balances on separate labels.
- Amount boxes state decimals when status includes `token0`/`token1` meta lines, the uint128 cap and the 1-base-unit minimum. Over-precise input is rejected and not rounded.
- Review step restates side, amount, minimum (worst-case output), batch and deadlines, plus fee, deposit, approvals and gas when the client printed them. A public or external quote is shown with its age and marked stale after 15 seconds when the client prints a `quote` line. Liquidity is shown only when the client prints it, labelled as an estimate.
- One active batch is explained on the form and blocks confirm when the preflight says it applies. Confirm re-runs the preview and requires a fresh confirm if balances or the quote changed or went stale.
- Filled orders show executed, unused and received amounts parsed from the client's fill numbers. The activity pane no longer prints the CLI transcript.
- A token other than `token0` or `token1` is rejected as not supported. After a deposit, the next status compare refuses a vault credit smaller than the amount sent (fee-on-transfer or rebasing).
- Web commit and preview still pass `--vault-only` and `--both-funded`. A shortfall says fund first with the amount from the preview. The page does not deposit it.
- `packages/arkiv` mirrors public settled-batch rows. `ARKIV=off` is in-memory. Testnet without `ARKIV_RPC` and `ARKIV_KEY` is `history unavailable`. The page still serves trade, track and withdraw. Batch phase, a committed-count mempool view, and a Court ledger (hidden until a Court deployment exists) are on `/trade`.
- `scripts/court-demo.sh` prints transaction hashes per step. `scripts/demo-multi.sh` ran three accounts through commit, keeper reveal, solver settle and withdraw (see DEMO.md). Swarm is out. Aqua-in-settle is out of this demo.

### Left
- Pool liquidity is the raw v4 figure from `poolLiquidity()`. The page says `estimate not available`. Nothing here turns that figure into a token amount.
- A commit preview does not build an admission proof, so that dry-run reports gas as unavailable and names the reason. A non-admission dry-run estimates `commit` and multiplies by `eth_gasPrice`.
- `ARKIV=testnet` writes only when `.env` has `ARKIV_RPC` and `ARKIV_KEY`, and the writer account has testnet tGLM. Otherwise the page says `history unavailable`. `ARKIV=off` uses `$CLIENT_STATE/arkiv-local.json` (or `ARKIV_FILE`).
- The activity log still receives client error text. The checklist item "No raw CLI output anywhere" stays open.
- Court and the three-user demo were rehearsed in the previous round. This round did not re-run those scripts.

### Requests from the trading page
None for the client or the solver. `status --json`, the quote, the fee-on-transfer check and `mirrorSettled` are in place.

Still needs a person: an Arkiv access key inside `ARKIV_RPC`, and tGLM for the `ARKIV_KEY` account, before a testnet history row exists.

### Commands
- `npm test --prefix packages/client` — pass (e2e skipped without `CLIENT_E2E`).
- `npm test --prefix app/haveibeensandwiched` — pass (59 pass, 4 skipped without `WEB_E2E`).
- `npm test --prefix packages/arkiv` — pass (6 pass).
- `forge build --root contracts --force --no-dynamic-test-linking` — pass (warnings only, isolated `FOUNDRY_OUT`).
- `forge build --root contracts --no-dynamic-test-linking packages/solver/test/fixtures/SolverHookFactory.sol` — pass.
- `WEB_E2E=1 node --test app/haveibeensandwiched/local.e2e.test.mjs` — pass (1 pass).
- `STACK_E2E=1 node --test packages/solver/test/local-stack.e2e.test.mjs` — pass (1 pass, about 69s). History returned the settled batch.
- `CLIENT_E2E=1 node --test packages/client/test/e2e.test.mjs` — pass (6 pass, 1 skipped). The skip is "released commitment: real CLI cleanup, repeat cleanup, next batch and withdrawal", which also needs `CLIENT_RELEASE_E2E=1`.
- `source env.sh && node scripts/demo-multi.mjs` — pass in the previous round (exit 0, about 5s). Not re-run this round.
- `scripts/court-demo.sh` — pass in the previous round (exit 0, about 27s). Claim `0xd37e69330908947fdba0572c59a5f865773ed5fdc05e3e8145878e0ec87db4f9`. Collect `0xa52a1f173bfeec27fa034a20c3674f6045ad4601708687ff64e74cf28ca38dcf`. Not re-run this round.

## Needs a person
- An **Arkiv access key** (hub.arkiv.network/access-keys) and faucet **tGLM** for a team wallet.
- A **Swarm postage batch** (Arkiv/Swarm booth, or a funded Bee light node).
- **Booth questions:** 1inch: is the re-composed router (official SwapVM + AquaOpcodes + one appended opcode) eligible? Uniswap: are the sealed hook and Court both in scope? Arkiv: sanity-check the entity and expiry design.

## Orders UI (section 5)

### Test summary
- `(cd packages/client && npm test)`: **55 passing**, 7 skipped (offline fixtures / opt-in gates), 0 failing.
- `(cd app/haveibeensandwiched && npm test)`: **55 passing**, 4 skipped (opt-in e2e gates), 1 failed (`server.test.mjs` network bind blocked by sandbox). Offline unit tests (`orders.test.mjs`, `status.test.mjs`, `check.test.mjs`, `arkiv.test.mjs`, `court.test.mjs`, `backup.test.mjs`, `trading-server.test.mjs`): **46/46 passing**.
- `ORDERS_E2E=1 node --test app/haveibeensandwiched/orders.e2e.test.mjs`: **3 scenarios implemented** (Beacon delay, Keeper outage, Expiry); skipped in sandbox due to Anvil spawn / network restrictions (`spawn EPERM`), ready for live unsandboxed execution.

### What's done
- Added `--json` flag to `track`, `blockers`, and `cleanup` in `packages/client/cli.mjs`, backed by pure model functions in `packages/client/orders.mjs`. Plain terminal text output remains identical without the flag.
- Created `packages/client/orders.mjs` exporting `orderView`, `ordersPayload`, `blockersPayload`, and `cleanupPayload`, tested in `packages/client/test/orders.test.mjs` across every state, partial/full fill, sealed orders with/without local state, and string conversions.
- Updated `app/haveibeensandwiched/trading-server.mjs` to invoke `--json` on `track`, `blockers`, `cleanup`, and `cleanup-preview`.
- Built pure view model `app/haveibeensandwiched/orders.mjs` with `parseTrack`, `parseBlockers`, `parseCleanup` (never throwing on unreadable output), `orderRows`, `withdrawalSummary`, `policyText`, and duration/countdown formatters. Thoroughly tested in `app/haveibeensandwiched/orders.test.mjs` (17/17 tests passing).
- Added accessible `<section id="orders" aria-labelledby="orders-h">` to `trade.html` with policy paragraph, live withdrawal summary, accessible table with `<th scope="col">` columns (Order, Batch, Stage, Amounts, Next step), responsive table wrapping (375px compatible), and dynamic "Withdraw all" actions.
- Wired live tracking, sequential job execution, confirm preview dialog for "Reveal now" and "Clean up", countdown timers with automatic refresh, and formatted amounts in `trade.mjs`.
- Implemented Playwright browser acceptance scenarios in `app/haveibeensandwiched/orders.e2e.test.mjs` for beacon delay, keeper outage, and expiry with accessibility and no-raw-CLI assertions.
- Updated Section 5 of `CHECKLIST.md` with passing test citations and updated item counts (34 done, 7 partly done, 52 open of 93).

### What's left
- Running `ORDERS_E2E=1 node --test app/haveibeensandwiched/orders.e2e.test.mjs` in an unsandboxed environment where `anvil` can bind local ports.

### Requests from orders-ui (rule 8)
- None. All interfaces and schemas required for Section 5 are fully implemented and integrated.


## Requests from the release stack (Bhoumik's session, 2026-11-07)

- **@kodykebab — `contracts/test/ExternalEthereumFork.t.sol` is time-dependent.** With `ETH_FORK_BLOCK` unset it forks the live tip, and two tests (`test_ethereum_publicPoolFillsOneSidedBatchBothDirections`, `test_ethereum_largeResidualRevertsThenPartialFillExecutes`) need the USDC/WETH 0.05% v3 pool (`0x88e6…5640`) to have swapped within `maxObservationAge` (120 s). On 7 Nov 2026 its latest observation was 240 s old at the tip, so both revert `StaleObservation()` on every run; the contract is right to refuse. Pin `ETH_FORK_BLOCK` to a block just after a swap, or `vm.warp` to the pool's last observation in `setUp`. The other 109 fork tests pass.
- **GitHub Actions has never run in this repo**, so `.github/workflows/check.yml` (#80) is unproven until Actions is enabled.
