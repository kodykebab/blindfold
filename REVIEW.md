# REVIEW.md

Design review of Blindfold and Court as of `main` @ `424642c` (2026-11-06). Each item has an ID (R1–R11), a status, where it lives in the code, the fix, and an owner. The fixes are scheduled in [PLAN.md](PLAN.md). Design reference: [ARCHITECTURE.MD](ARCHITECTURE.MD).

**Proven** means a Foundry test reproduces it against the cited baseline contracts (code in the [appendix](#appendix-reproduction-tests)). **From code** means it follows from reading the code and has no test yet.

| ID | Problem | Severity | Status | Owner |
|---|---|---|---|---|
| R1 | One poison order can make a batch impossible to settle | High | Proven | Kritarth |
| R2 | The commit-reveal free option is still open | High | Proven | Kritarth (contract, prover), Khush (client) |
| R3 | Anyone can fill every batch for the cost of gas | High | Proven | Kritarth |
| R4 | The solver picks the price inside a ~1.2% band | Medium | Proven | Bhoumik (measure, solver), Kritarth (contract) |
| R5 | Just-in-time liquidity takes the LP surplus; removing liquidity blocks settlement | Medium | From code | Kritarth |
| R6 | Admission proofs limit an account to every other batch; proving time is unmeasured | Medium | From code | Kritarth |
| R7 | Remaining trust in the sequencer and timestamps; the safety margin is 4–6 s, not ≥6 s | Medium | From code | Kritarth |
| R8 | Court bonds can be drained by sandwiching yourself | High | Fixed in `BondRegistry` | Bhoumik |
| R9 | Real sandwichers can easily slip past the Court predicate | Medium | From code | Bhoumik |
| R10 | A commit into the next batch can unfund the account's own open order | Medium | Proven | Unassigned |
| R11 | One order larger than the pool's depth makes every price revert | Medium | Proven | Unassigned |

---

## Current merged update (2026-11-06)

The tables and reproduction snippets below retain their historical baselines. On main through `09bc540`, R1's reproduced marginal-order case and dust companion have regression coverage through proportional allocation (#6); R3 now charges a nonrefundable fee on every commit (#50/#53); settlement windows cannot overlap (#34); R7's schedule alignment is enforced. The fee/configuration integration passes 215 contract tests with 4,096 fuzz runs and Unichain forks. Alignment does not remove sequencer timing assumptions; #31 remains open. Clearing feasibility and solver integration remain tracked in #7/#12.

The client (#42/#54) now handles Released as terminal and reports cleanup policy accurately. Isolated local circuits (#5) and their real-proof harness are merged; the original off-mode settlement accepts unchecked ciphertext; the enforced integration is described under R2. The release-policy subclass in FeesAndTiming tests is not an admission verifier. Cumulative private-state implementation and its remaining release decisions are described under S11.

## R1. One poison order can make a batch impossible to settle
**Where:** `BlindfoldSettlement.quote` ([`:132`](contracts/src/BlindfoldSettlement.sol#L132)), `settle` ([`:139`](contracts/src/BlindfoldSettlement.sol#L139)), `_checkMarginal` ([`:206`](contracts/src/BlindfoldSettlement.sol#L206)).

**Problem:** three rules together have no guaranteed solution:
- orders fill all-or-nothing;
- whether an order fills depends only on the price (`quote`);
- the price must match the pool's marginal price after the residual swap, within `toleranceBps`.

Take a large sell whose limit sits between the post-swap price *with* it and the post-swap price *without* it:
- **Included:** the price drops below its limit, so it must not fill.
- **Excluded:** the price stays above its limit, so it must fill.

No price is consistent with both, every `settle` reverts, and the batch expires. All the attacker needs is enough capital to move the pool more than about 2 × `toleranceBps`. The capital is only locked, never spent, and comes back at `expire`. If the attacker reveals their own order, they keep the bounty too. So repeating it every batch costs only gas. A large honest order near its limit triggers the same thing by accident.

**Proof:**
- **Setup:** the `BlindfoldTest` setup (fee 0.3%, tolerance 100 bps).
- **The batch:** Mallory sells 300 token0 with limit 0.975, and Bob buys with 10 token1.
- **Result:** every price from 90% to 110% of the pool price, in 5 bp steps, reverts.
- **Control:** Bob's order alone settles at 1.0041.
- **Cost:** after `expire`, Mallory's balances are exactly what they were before.

**Fix:** proportional partial fills for the marginal limit group (selected in the design discussion).
- **Additive signature:** `settle(b, p, marginalId, marginalAmountIn)`; `settle(b, p)` remains the all-or-none path.
- **Representative:** `marginalId` identifies a funded order from this batch, not a privileged recipient. Its strictly positive partial input divided by its original input defines the common fraction.
- **Allocation:** every same-side order with the same exact `minAmountOut / amountIn` ratio receives its input multiplied by that fraction, rounded down. Eligible better same-side limits fill fully, worse limits do not fill; opposing orders keep the existing quote rule.
- **Limits:** output rounds down at the uniform price; the proportional minimum rounds up. An invalid nonzero partial fill reverts the whole settlement. The representative's limit price must be within the configured tolerance on the executable side of the clearing price.
- **Remainder:** unfilled input stays in the owner's vault balance and unlocks. Events report actual input and output.
- **Verification:** see the S1 implementation notes below. This resolves the reproduced case without claiming universal feasibility or a unique solver price.

**How common:** in the solver's randomized model test (`packages/solver/test/price.test.mjs`: up to 12 random orders against a pool with linear price impact), 49 of 300 batches had no price at which every order fills fully. With a marginal partial fill, all 49 settled.

## R2. The commit-reveal free option is still open

**Enforced integration:** `AdmittedSettlement` requires both direct Groth16 proofs and disables the inherited unchecked `commit`. It binds canonical journals to caller/deployment/batch/round/ciphertext and cumulative funding after fees and deposits; `AdmissionVault` restricts the pair and checks exact transfer receipts. The original `BlindfoldSettlement` remains unchecked off mode. The integration tests cover real generated proofs and private-state resume/restore. Production use still requires reviewed ceremony parameters and authenticated distribution; single-party local setup is restricted to test deployment.

**Where:** `BatchAuction.reveal` funding check ([`:183`](contracts/src/BatchAuction.sol#L183)), `BlindfoldVault.deposit` ([`:55`](contracts/src/BlindfoldVault.sol#L55)), `BatchAuction.commit` ([`:153`](contracts/src/BatchAuction.sol#L153)), which never checks the ciphertext.

**Problem:** CONTEXT.md says the design kills the free option, but in today's contract there are three ways to decide after commits close:
1. **Fund late.** Funding is checked at reveal, not at commit, and deposits are never blocked. Commit an order bigger than your balance. Once commits close, deposit if you like the market, or don't and lose one fixed deposit.
2. **Junk ciphertext.** The contract checks only the hash, so only the owner can reveal a junk-ciphertext commitment. Reveal it if it suits you, or take the slash.
3. **Choose which order goes live.** With two same-token orders that can't both be funded, reveal your preferred one first, before keepers do. The other closes as unfunded.

In every case the cost is one fixed deposit, whatever the order size, so the option is cheap exactly when it matters most.

**Proof:**
- **Setup:** Dave deposits only the commit deposit and commits a 500-token0 sell.
- **The late decision:** after `commitsClose`, Dave deposits 500 token0.
- **Result:** the reveal locks the 500 and the order goes live.

**Fix:** wire in the admission proof from [ARCHITECTURE.MD §5–7](ARCHITECTURE.MD).
- **What gets proven:** at commit, the ciphertext decrypts to the hashed order for `targetRound(b)`, and the account's cumulative inputs fit its budget.
- **What changes onchain:** a proof-checked `admit(...)` entry point replaces `commit` when enforcement is on. The two must not coexist.
- **Client privacy:** the client sets the public budget bounds to the account's full free balances, so the bounds reveal nothing new.
- **Fallback if not ready:** check funding at commit for the deposit token only. This doesn't hide size, so it is a fallback, not the fix.

## R3. Anyone can fill every batch for the cost of gas
**Where:** `MAX_COMMITS = 64` ([`BatchAuction.sol:18`](contracts/src/BatchAuction.sol#L18)); the padding reveal pays the bounty to the revealer and the remainder to the owner ([`:179–192`](contracts/src/BatchAuction.sol#L179-L192)).

**Problem:** an attacker fills all 64 slots with padding orders (`amountIn = 0`) and reveals them themselves. They get the bounty as revealer and the remainder as owner, which is 100% of every deposit. Honest users get `BatchFull`. Using more addresses changes nothing.

**Proof:** Mallory makes 64 padding commits and Alice's commit reverts with `BatchFull`. After Mallory self-reveals all 64, Mallory's balance is still exactly 64 deposits.

**Fix:**
- **A per-commit fee that is never refunded** (`commitFee` to the treasury or LPs), separate from the deposit and charged to padding too. Stuffing then costs 64 × `commitFee` per batch.
- **Raise `MAX_COMMITS`** as far as settle gas allows.

**Trade-off:** padding orders exist for privacy, and now they cost `commitFee`. Size the fee for that.

## R4. The solver picks the price inside a ~1.2% band
**Where:** `settle` accepts the first valid price ([`:139–157`](contracts/src/BlindfoldSettlement.sol#L139-L157)); `_checkMarginal` allows ±`toleranceBps`; the settler gets no reward.

**Problem:** any price whose post-swap pool price lands within tolerance is accepted, and the first one to land wins.
- **Who decides:** whoever lands first picks the price inside the band and so decides the marginal fills. On Unichain that is often the sequencer.
- **Who loses:** a lower price for a net sell, for example, means less for the sellers and more surplus donated to in-range LPs. Combined with R5, that surplus goes to the settler.
- **The incentive problem:** `settle` pays nothing, so this extraction is the only income a solver has.

CONTEXT.md's claim that "the solver chooses nothing else" does not hold.

**Proof:**
- **The batch:** the standard two-sided one (Alice sells 100 token0, Bob buys with 50 token1).
- **The band:** every price from 98.05% to 99.20% of the pool price settles.
- **The swing:** Alice's proceeds range from 98.05 to 99.20 token1, 1.17% of the trade.

**Fix:**
1. Tighten `toleranceBps` to the smallest value that still settles realistic batches (pool fee plus a few bps). Bhoumik measures the band across batch shapes and reports it here.
2. Pay the settler an explicit, small reward from the surplus, so honest settling pays and extraction isn't the business model.
3. Our solver settles at the feasible price closest to the post-swap marginal price, not the first one it finds.

**Status:** fix 3 is done. `packages/solver` finds the accepted band and settles at its midpoint; on a local deployment of the standard two-sided batch it settled at 0.9862, mid-band. Fixes 1 and 2 (tolerance, settler reward) are still open.

## R5. Just-in-time liquidity takes the LP surplus; removing liquidity blocks settlement
**Where:** `SealedPoolHook` blocks only swaps ([`:12`](contracts/src/SealedPoolHook.sol#L12), [`:25`](contracts/src/SealedPoolHook.sol#L25)); the surplus goes through `manager.donate` to whoever is in range at that moment ([`BlindfoldSettlement.sol:260`](contracts/src/BlindfoldSettlement.sol#L260)).

**Problem:** every revealed order is public before `settle`, and adding or removing liquidity is open. So:
- **Grabbing the surplus:** a settler can add a narrow position, settle at the R4 band edge that maximizes surplus, collect fees plus the donation, and remove the position, all in one transaction. "Arbitrage value goes to LPs" really means "goes to the settler".
- **Blocking settlement:** any LP can pull liquidity after reveal and force the batch to expire. The existing `test_liquidityRemovedAfterReveal_canExpire` shows the expiry path.

**Fix:** add `beforeAddLiquidity` and `beforeRemoveLiquidity` to the hook, and refuse `settle` in any block that saw a liquidity change. That stops same-block JIT; the hook address has to be re-mined with the new flag bits. Removal griefing stays bounded by `expire`, plus keepers re-solving. Acceptance: a contract that adds liquidity, settles and removes it in one transaction reverts.

## R6. Admission proofs limit an account to every other batch; proving time is unmeasured

**Advance preparation (#60):** the native desktop helper now supports `prepare-admission <batch-id>` before order selection. It binds the ready key to the account, chain, settlement, batch, round and parameter manifest, consumes it durably before online encryption, and keeps completed submissions in the existing resume path. Ready keys are excluded from exports. The final fresh-proof gate passed in about 216 seconds with 300-second development batches, advance preparation through the real CLI, independent decryption, pending resume, repeated submission checks, failed preparation, network mismatch, deadline refusal, settlement, withdrawal and release. Two intermediate runs were cancelled after system sleep; the final run used a temporary idle-sleep assertion. The earlier 217-second two-order run measured the previous inline path as a whole, not per-proof latency. Desktop local helper is the selected first delivery target; browser/mobile proving is outside this increment. Production timing, representative device coverage, truly cold-disk loading and network inclusion tails remain separate evidence gates; these local samples do not demonstrate a 30-second flow.

**Desktop samples (2026-11-06):** Apple M5, 10 logical CPUs, 16 GiB RAM, Darwin 25.4.0 arm64, Node 22.23.2, Go 1.27.1. Three fresh-process samples using the unchanged circuits and existing development parameters:

| Phase | Total wall time | Parameter hashing/loading | Proof generation | Maximum process RSS |
|---|---|---|---|---|
| Advance preparation | 52.62–55.23 s | 43.17–45.50 s | 9.27–9.76 s | 4.52 GB |
| Online order | 46.30–47.95 s | 40.77–42.19 s | 5.44–5.65 s | 4.20 GB |

Native verification took 1.4–1.9 ms. Total times include process/fixture overhead. Each prover starts cold, while OS file-cache state is uncontrolled; these are not guaranteed cold-disk samples, a warm resident-worker benchmark or p95 estimates. No concurrent full-suite or other real-proof workload ran during the three samples. The raw ignored artifact is `packages/proof-bench/results/advance-preparation-measurements.json`; regenerate with `node packages/proof-bench/measure-admission.mjs 3` after building the local prover. The JSON records circuit/key hashes, executable SHA-256, source revision/diff identity and device metadata. Manifest SHA-256: `30086f2d95054c64aaeeee08ddff7bc91eda4ebbff6f2583303b637cebeaf688`; prover SHA-256: `0e068868c8558f58eb26837eb05b8b27347df7b6000c4284f00ca9188fd18ead`.

The desktop development policy uses 300-second batches with preflight lead times of 120 seconds for prepared orders and 180 seconds for inline pairs. `ADMISSION_MIN_LEAD_SECONDS` allows a measured desktop to choose a different margin. The client still refuses submission after its deadline. Real-network inclusion tails, sequencer/wall-clock behavior under #31 and additional desktop measurements are required before a production timing claim. Browser/mobile proving and persistent parameter workers are separate scope decisions.

**Where:** [`ReservationModel.t.sol`](contracts/test/ReservationModel.t.sol): `activeBatch` and `step == openCommitments`; [ARCHITECTURE.MD §5](ARCHITECTURE.MD).

**Problem:**
- **Throughput:** an account can't admit into a new batch until all its earlier commitments close. Batch b's orders close at the earliest when its settle window opens (`revealCloses(b)`), which is the moment batch b+1's commit window ends. So an account trades every other batch at best, and every fourth if settlement is late or the batch expires. The pricing design relies on arbitrageurs, who would need many accounts.
- **Proving time:** the native helper samples above exceed a 30-second commit window even after advance preparation. Preparation avoids fixing the order early, but online parameter loading, proving and transaction inclusion still need a measured window.

**Historical split prototype:** `main` @ `6b58167` split the proof in two:
- a **preparation** proof of the tlock key wrapper, which needs only the round and context, so it can run before the order is chosen;
- an **online** proof of the payload and funding, per order.

Both are bound together (see the [proof-bench README](packages/proof-bench/README.md#prepared-keys-and-online-admission)), so only the online path has to fit the commit window. The selected direct-Groth16 implementation is now measured above; the historical zkVM path is a separate prototype.

**Remaining gates:**
- Measure loading, proving, peak memory and submission/inclusion across the supported desktop configurations, explicitly separating process-cold, filesystem-cache and any resident-worker conditions.
- Validate production batch timing with #31's sequencer/drand assumptions and representative inclusion tails; development margins are not production guarantees.
- Keep any change to the one-active-batch throughput rule separate from this advance-preparation implementation.

## R7. Remaining trust in the sequencer and timestamps
**Where:** `targetRound` ([`BatchAuction.sol:111`](contracts/src/BatchAuction.sol#L111)); the use of `block.timestamp` throughout.

**Problem:**
- **The margin:** `targetRound(b) = roundAt(commitsClose(b)) + 2`, so the key is published `6 − ((commitsClose − genesis) mod 3)` seconds after commits close. That's 4–6 s, not the "≥6 s" CONTEXT.md states. The tests always get 6 s only because `T0` and `batchLength = 30` are multiples of 3.
- **Timestamp lag:** on OP-stack chains, block timestamps can fall behind real time while a stalled sequencer catches up. Commits can then land after round R is public, when anyone can already read the batch.
- **What the sequencer controls:**
  - commit inclusion;
  - censoring reveals until they are slashed, then taking the slash bounty;
  - winning every R4 settle race.

**Fix:**
- **Alignment:** have the constructor require `(start − DRAND_GENESIS) % 3 == 0` and `batchLength % 3 == 0`, then fix the CONTEXT.md wording.
- **More margin:** consider `DRAND_MARGIN = 3`.
- **In the docs:** list the sequencer as a remaining trust assumption next to drand.

## R8. Court bonds can be drained by sandwiching yourself
**Where:** `SandwichCourtVerifier.verify` requires only that the victim and attacker addresses differ ([`:129`](contracts/src/court/SandwichCourtVerifier.sol#L129)); the planned payout `max(profit, minPenalty) + gas` (CONTEXT.md "Court design").

**Problem:** Court proves that a sandwich happened, not that the RPC leaked it.
1. Someone with two wallets gets a `Protected` receipt for their own transaction.
2. They send the same transaction to their own bot, sandwich it, and claim from the RPC's bond.
3. Their wallets' gains and losses cancel except for pool fees, so the payout is profit. They pick the "profit" themselves by giving the victim transaction wide slippage.
4. The `minPenalty` floor makes even tiny self-sandwiches pay.

**Status:** fixed in [`BondRegistry.sol`](contracts/src/court/BondRegistry.sol): the cap, no floor, once per tx, the unbond delay and chain binding are all tested against the mainnet fixtures. While building it, a related gap turned up: `verify` accepts Swap-shaped logs from whatever `c.pool` the claim names, so a contract emitting fake Swap events could fake a sandwich. BondRegistry pins the pool to the canonical v3 factory (CREATE2) or the v4 PoolManager. **Self-sandwich economics (#32):** the receipt cap alone didn't stop it, because the coalition picks the victim's slippage and so the "profit". An incident's budget is now `min(profit, front leg's swap fee)`: reaching the same holdings through front, victim and back costs at least the extra legs' fees more than one direct trade (pool state is path-independent and fees leave the curve), so the payout never covers the cost. That needs the fees to go to someone else, so only deployer-listed pools with a static fee are covered (anyone can create a pool and be its only LP), zero-fee pools pay nothing, and each front and back swap belongs to one incident (otherwise three small fronts closed by one back would be paid three fees for one round trip; the fuzzer found exactly that). `test/court/SelfSandwich.t.sol` runs it on a real v4 PoolManager: across fee tiers, one to three fronts and backs, and victim sizes up to the pool's depth, the extra cost always exceeds the payout (at least 1.3× in a 300-run sample). On the 36 sandwiches found in 800 Ethereum blocks up to 26353989, the fee cap binds in most, so coverage is a fraction of the attacker's profit. **Still open:** a coalition that supplies most of a listed pool's in-range liquidity just for the sandwich (JIT) recovers most of the fees, and then the payout does exceed its cost (`test_jitLiquidity_breaksTheBound`); `maxPayout` and the bond are the only limits there. **Remaining limit:** profit is valued only in ETH/WETH. The v3 fixture's attacker profits in USDT, so that claim reverts unpaid; paying it needs a price, for example the front leg's own execution price, which `Verdict` doesn't expose yet.

**Fix:** design `BondRegistry` so that sandwiching yourself never pays.
- **Cap from the receipt:** the RPC writes `maxPayout` into the receipt, derived from the transaction's own slippage when it accepted it (quoted output minus `minAmountOut`). Pay `min(valued profit, maxPayout)`.
- **No floor:** drop the `minPenalty`.
- **Once per transaction:** pay each `txHash` at most once.
- **Withdrawal delay:** add a delay on unbonding, so an RPC can't pull its bond ahead of a claim.
- **Bind the chain:** a `Verdict` doesn't say which chain or path it came from, so BondRegistry must check it against the receipt's `chainId`.
- **Valuation:** decide how pool-token profit converts to the bond asset, and write it in CONTEXT.md.
- **Docs:** ARCHITECTURE.MD §10 already says "payout caps"; update CONTEXT.md, which still has the old formula.

## R9. Real sandwichers can easily slip past the Court predicate
**Where:** same signer for front and back ([`:129`](contracts/src/court/SandwichCourtVerifier.sol#L129)), same pool caller for both legs ([`:263`](contracts/src/court/SandwichCourtVerifier.sol#L263); since S5 it's the contract that made the swap, not the v3 recipient), back leg within 1% of the front ([`:269`](contracts/src/court/SandwichCourtVerifier.sol#L269)).

**Problem:** any of these escapes Court:
- signing front and back with two wallets;
- making the two legs from two different contracts;
- leaving 2% of the position open.

As written, Court catches only naive bots. Loosening the predicate invites false claims, and those feed straight into R8.

**Fix:**
- **Payouts stay strict:** keep the strict predicate for anything that pays out.
- **Track near-misses publicly:** the watcher records near-misses (different signers in the same block around a receipted transaction, partial closes) as public, non-paying `court.suspect` entries on Arkiv. That shows recall without opening the bond to false claims.
- **Document the trade-off:** write it in ARCHITECTURE.MD §10.

## R10. A commit into the next batch can unfund the account's own open order
**Where:** `BatchAuction.commit` takes the deposit from free balance ([`:158`](contracts/src/BatchAuction.sol#L158)) without looking at the account's open orders; funding is checked only at reveal ([`:183`](contracts/src/BatchAuction.sol#L183)).

**Problem:** between `commitsClose(b)` and `revealOpens(b)` (4–6 s, R7), batch b+1 accepts commits while batch b's orders are still unrevealed. Any commit into b+1, padding included, takes another deposit in the deposit token. If an order in b pays in the deposit token and the account's free balance is close to its `amountIn`, that order closes unfunded at reveal: it never trades, and `depositAmount − bounty` goes to the treasury.
- **Honest users:** a client that commits every batch loses orders and deposits with no warning.
- **Strategic users:** it's a fourth way to cancel after commits close (R2), limited to orders paid in the deposit token and to the 4–6 s gap.

**Proof:**
- **Setup:** Alice has 1,000 token1 and commits a buy of 995 token1, which leaves 995 free after the deposit.
- **The trigger:** at `commitsClose(b)` she commits a padding order into b+1, leaving 990 free.
- **Result:** the keeper's reveal closes her order as unfunded, and the treasury receives 4 token1.

**Fix:**
- **With admission proofs:** the one-active-batch rule (ARCHITECTURE.MD §5, `ReservationModel.t.sol`) prevents it, at R6's throughput cost. S11's client check alone is not enough, because the contract still accepts the commit.
- **Until then:** `commit` reverts while the sender has open commitments from an earlier batch. That needs a per-account active batch in `BatchAuction`, like the reservation model's `activeBatch`.
- **Acceptance:** the R10 test's second commit reverts.

## R11. One order larger than the pool's depth makes every price revert
**Where:** `quote` fills any order whose limit holds ([`BlindfoldSettlement.sol:132`](contracts/src/BlindfoldSettlement.sol#L132)); the residual swap must use its whole input ([`:250`](contracts/src/BlindfoldSettlement.sol#L250)).

**Problem:** a sell with `minAmountOut = 1` fills at every plausible price. If it is larger than what the pool can absorb before the swap reaches its price limit, the residual swap fills only partly and every `settle` reverts with `PartialResidual`. As with R1, the capital is only locked: it comes back at `expire`, and a self-reveal returns the deposit.
- **R1's fix doesn't cover it:** the order's limit is nowhere near `p`, so it can't be the marginal order.
- **Precondition:** no liquidity reaches the swap's price limit. A full-range position removes the depth limit, but then the batch clears at a crashed price instead.

**Proof:**
- **Setup:** the `BlindfoldTest` pool, whose one position needs about 191k token0 to reach its lower tick.
- **The batch:** Mallory sells 250k token0 with `minAmountOut = 1`, and Bob buys with 10 token1.
- **Result:** all 838 prices tried, from 2^-20 to 2^20 times the pool price, revert.
- **Cost:** after `expire`, Mallory holds exactly her 250k token0 and her deposit.

**Fix:**
- **Partial fills sized to depth:** add this case to S1's executable model, so the allocation fills only what the pool can absorb.
- **Or bound order size:** a per-order `maxAmountIn` set at deployment from the expected pool depth.
- **Acceptance:** the R11 test settles, or its order is rejected before it can lock the batch.

---

## Smaller items
- **Rounding dust:** it stays in the settlement contract's own vault balance, with no sweep.
- **`test_liquidityRemovedAfterReveal_canExpire` doesn't test liquidity removal:** its `settle(b, Q96)` reverts with `ResidualShort` even with liquidity untouched (the same call `test_settle_rejectsBadPrices` rejects as too generous), so it passes whether or not removal matters. R5 cites it. Replace the revert with a price that settles before the removal and reverts after it: `test_poc_liquidityRemovalRevertsSolvedPrice` below, which also proves R5's removal half.
- **CONTEXT.md is out of date:**
  - "Team of 4";
  - "≥6 s margin" (R7);
  - "the solver chooses nothing else" (R4);
  - the free option is killed (R2);

## Appendix: reproduction tests
Save as `contracts/test/ReviewPoC.t.sol` and run `forge test --match-contract ReviewPoC -vv`. Each test passes while its flaw exists. Once a fix lands, flip its assertions into a regression test. Don't commit this file as-is: it asserts the bugs.

<details>
<summary>ReviewPoC.t.sol (R1–R4)</summary>

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Reproduces REVIEW.md R1-R4 against main @ 424642c. Each test passes while its flaw exists.
import {BlindfoldTest} from "./Blindfold.t.sol";
import {BatchAuction} from "../src/BatchAuction.sol";

contract ReviewPoC is BlindfoldTest {
    address mallory = makeAddr("mallory");
    address dave = makeAddr("dave");

    // 1. Free option: commit an unfunded order, then decide after commits close whether to fund it.
    function test_poc_freeOptionByLateDeposit() public {
        t1.mint(dave, DEPOSIT);
        vm.startPrank(dave);
        t1.approve(address(vault), DEPOSIT);
        vault.deposit(address(t1), DEPOSIT); // only the commit fee, zero token0
        vm.stopPrank();

        uint64 b = s.currentBatch();
        BatchAuction.Order memory o = _o(dave, true, 500e18, 1);
        uint256 id = _commit(dave, o, "d");

        vm.warp(s.commitsClose(b) + 1); // commits closed, market moved, dave likes the trade now
        t0.mint(dave, 500e18);
        vm.startPrank(dave);
        t0.approve(address(vault), 500e18);
        vault.deposit(address(t0), 500e18); // deposits are never blocked
        vm.stopPrank();

        vm.warp(s.revealOpens(b));
        vm.recordLogs();
        s.reveal(id, o, "d");
        assertEq(vault.lockedOf(dave, address(t0)), 500e18, "order went live after a post-close decision");
    }

    // 2. Fill all 64 slots with padding and self-reveal: the attacker gets every deposit back.
    function test_poc_batchStuffingCostsOnlyGas() public {
        t1.mint(mallory, 64 * DEPOSIT);
        vm.startPrank(mallory);
        t1.approve(address(vault), 64 * DEPOSIT);
        vault.deposit(address(t1), 64 * DEPOSIT);
        vm.stopPrank();

        uint64 b = s.currentBatch();
        uint256[] memory ids = new uint256[](64);
        for (uint256 i; i < 64; i++) ids[i] = _commit(mallory, _o(mallory, true, 0, 0), bytes32(i));

        bytes32 h = s.orderHash(b, _o(alice, true, 1e18, 0), "a");
        vm.prank(alice);
        vm.expectRevert(BatchAuction.BatchFull.selector);
        s.commit(b, h, "x"); // honest user locked out

        vm.warp(s.revealOpens(b));
        vm.startPrank(mallory);
        for (uint256 i; i < 64; i++) s.reveal(ids[i], _o(mallory, true, 0, 0), bytes32(i));
        vm.stopPrank();
        assertEq(vault.balanceOf(mallory, address(t1)), 64 * DEPOSIT, "attack cost: zero tokens");
    }

    // 3. Poison order: all-or-nothing fills + "fills follow from price" + marginal check => no valid price exists.
    function test_poc_poisonOrderMakesBatchUnsettleable() public {
        _fund(mallory);
        uint64 b = s.currentBatch();
        BatchAuction.Order memory honest = _o(bob, false, 10e18, 9e18);
        BatchAuction.Order memory poison = _o(mallory, true, 300e18, 292.5e18); // limit 0.975
        uint256 c1 = _commit(bob, honest, "b");
        uint256 c2 = _commit(mallory, poison, "m");
        vm.warp(s.revealOpens(b));
        s.reveal(c1, honest, "b");
        vm.prank(mallory);
        s.reveal(c2, poison, "m"); // self-reveal: mallory keeps the bounty too
        vm.warp(s.revealCloses(b));

        uint256 pool = s.poolPriceX96();
        uint256 ok;
        for (uint256 k = 9_000; k <= 11_000; k += 5) {
            try s.settle(b, pool * k / 10_000) {
                ok++;
                break;
            } catch {}
        }
        assertEq(ok, 0, "some price settled");

        vm.warp(s.settleCloses(b));
        s.expire(b);
        assertEq(vault.balanceOf(mallory, address(t0)), 1_000e18, "poison capital returned");
        assertEq(vault.balanceOf(mallory, address(t1)), 1_000e18, "poison deposit returned");
    }

    // 4. The solver picks any price in a ~2% band; it moves value between users and in-range LPs.
    function test_poc_solverPriceBand() public {
        uint64 b = _twoSided();
        uint256 pool = s.poolPriceX96();
        uint256 lo;
        uint256 hi;
        uint256 aliceLo;
        uint256 aliceHi;
        uint256 a1 = vault.balanceOf(alice, address(t1));
        for (uint256 k = 9_800; k <= 10_200; k += 1) {
            uint256 snap = vm.snapshotState();
            uint256 p = pool * k / 10_000;
            try s.settle(b, p) {
                uint256 got = vault.balanceOf(alice, address(t1)) - a1;
                if (lo == 0) (lo, aliceLo) = (k, got);
                (hi, aliceHi) = (k, got);
            } catch {}
            vm.revertToState(snap);
        }
        emit log_named_uint("lowest feasible price, bps of pool", lo);
        emit log_named_uint("highest feasible price, bps of pool", hi);
        emit log_named_decimal_uint("alice proceeds at lowest", aliceLo, 18);
        emit log_named_decimal_uint("alice proceeds at highest", aliceHi, 18);
        assertGt(hi, lo);
    }
}

contract ReviewPoCControl is BlindfoldTest {
    function test_control_honestOrderAloneSettles() public {
        uint64 b = s.currentBatch();
        BatchAuction.Order memory honest = _o(bob, false, 10e18, 9e18);
        uint256 c1 = _commit(bob, honest, "b");
        vm.warp(s.revealOpens(b));
        s.reveal(c1, honest, "b");
        vm.warp(s.revealCloses(b));
        uint256 p = _solve(b);
        emit log_named_decimal_uint("settled at", p * 1e18 / Q96, 18);
    }
}
```

</details>

R10, R11 and the liquidity-test item have their own file: save it as `contracts/test/ReviewPoCMore.t.sol` and run `forge test --match-contract ReviewPoCMore --match-test poc -vv`. The same rule applies: don't commit it as-is.

<details>
<summary>ReviewPoCMore.t.sol (R10, R11, liquidity test)</summary>

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Reproduces REVIEW.md R10, R11 and the liquidity-test item against main @ d75c699. Each test passes while its flaw exists.
import {BlindfoldTest} from "./Blindfold.t.sol";
import {BatchAuction} from "../src/BatchAuction.sol";
import {BlindfoldSettlement} from "../src/BlindfoldSettlement.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

contract ReviewPoCMore is BlindfoldTest {
    address mallory = makeAddr("mallory");

    // R10. A commit into the next batch takes another deposit and unfunds the account's own open order.
    function test_poc_nextBatchCommitUnfundsOwnOrder() public {
        uint64 b = s.currentBatch();
        uint256 free1 = vault.freeBalance(alice, address(t1));
        BatchAuction.Order memory buy = _o(alice, false, free1 - DEPOSIT, 1); // all token1 left after the deposit
        uint256 c = _commit(alice, buy, "a");

        vm.warp(s.commitsClose(b)); // batch b+1 is open, b is not revealable yet
        assertEq(s.currentBatch(), b + 1);
        assertLt(block.timestamp, s.revealOpens(b));
        _commit(alice, _o(alice, true, 0, 0), "pad"); // an ordinary padding commit charges another deposit

        uint256 t = vault.balanceOf(treasury, address(t1));
        vm.warp(s.revealOpens(b));
        vm.prank(keeper);
        s.reveal(c, buy, "a");
        assertEq(s.orderIdsOf(b).length, 0, "order closed as unfunded");
        assertEq(vault.balanceOf(treasury, address(t1)) - t, DEPOSIT - DEPOSIT * BOUNTY_BPS / 10_000, "deposit forfeited");
    }

    // R11. One order larger than the pool's depth makes every price revert; its limit is far from any price.
    function test_poc_orderBeyondPoolDepthBlocksEveryPrice() public {
        t0.mint(mallory, 250_000e18); // depth to the position's lower tick is ~191k token0
        t1.mint(mallory, DEPOSIT);
        vm.startPrank(mallory);
        t0.approve(address(vault), 250_000e18);
        t1.approve(address(vault), DEPOSIT);
        vault.deposit(address(t0), 250_000e18);
        vault.deposit(address(t1), DEPOSIT);
        vm.stopPrank();

        uint64 b = s.currentBatch();
        BatchAuction.Order memory whale = _o(mallory, true, 250_000e18, 1);
        BatchAuction.Order memory honest = _o(bob, false, 10e18, 9e18);
        uint256 cw = _commit(mallory, whale, "w");
        uint256 ch = _commit(bob, honest, "h");
        vm.warp(s.revealOpens(b));
        vm.prank(mallory);
        s.reveal(cw, whale, "w");
        s.reveal(ch, honest, "h");
        vm.warp(s.revealCloses(b));

        uint256 pool = s.poolPriceX96();
        uint256 ok;
        for (uint256 e; e <= 40; e++) {
            uint256 p = e >= 20 ? pool << (e - 20) : pool >> (20 - e); // 2^-20 .. 2^20 of the pool price
            try s.settle(b, p) {
                ok++;
            } catch {}
        }
        for (uint256 k = 100; k <= 20_000; k += 25) {
            try s.settle(b, pool * k / 10_000) {
                ok++;
            } catch {}
        }
        assertEq(ok, 0, "some price settled");

        vm.warp(s.settleCloses(b));
        s.expire(b);
        assertEq(vault.balanceOf(mallory, address(t0)), 250_000e18, "capital returned");
        assertEq(vault.balanceOf(mallory, address(t1)), DEPOSIT, "deposit returned");
    }

    // test_liquidityRemovedAfterReveal_canExpire: settle(b, Q96) reverts on price with liquidity untouched.
    function test_poc_liquidityTestRevertsWithoutRemoval() public {
        uint64 b = _twoSided();
        try s.settle(b, Q96) {
            revert("settled");
        } catch (bytes memory err) {
            assertEq(bytes4(err), BlindfoldSettlement.ResidualShort.selector, "price, not liquidity");
        }
    }

    // What that test should check: a price that settles before the removal reverts after it.
    function test_poc_liquidityRemovalRevertsSolvedPrice() public {
        uint64 b = _twoSided();
        uint256 snap = vm.snapshotState();
        uint256 p = _solve(b);
        vm.revertToState(snap);
        lp.modifyLiquidity(key, IPoolManager.ModifyLiquidityParams(-60_000, 60_000, -2.5e21, 0), ""); // 25% removed
        try s.settle(b, p) {
            revert("solver's price still settled");
        } catch {}
        assertFalse(s.finalized(b));
    }
}
```

</details>


## Proposed solutions from the broader design review

Status: proposals for team review, not implemented fixes or approved changes to the frozen seams in PLAN.md. The S1–S22 identifiers below follow the broader review discussion; they do not replace R1–R9 above. Where recommendations differ from the existing plan, the team must reconcile them before implementation. In particular, proportional marginal allocation, execution scheduling, unrevealed refunds, and Court claim allocation can change interfaces or policy.

Recommended initial scope: one supported pair, one v4 settlement path, partial fills, predictable execution windows, and an explicitly operated keeper. Court and additional integrations should have independent release gates. Admission-proof work proceeds independently.

### S1. Clearing feasibility

Allow partial fills, interpreting minAmountOut proportionally to the amount actually filled, and return unused input. An order selling 1,000 tokens for at least 900 would accept a 500-token fill only if it receives at least 450.

Specify price priority, proportional allocation among orders at the marginal limit, integer rounding, and the outcome when no economically meaningful fill exists. The solver must not arbitrarily choose winners. Proportional allocation among multiple marginal orders may require a different interface from the single-marginal-order overload currently in PLAN.md.

Gate: demonstrate feasibility across fees, opposing orders, liquidity boundaries, and integer rounding in an executable model before changing contracts. Partial fills are a candidate solution, not a proof that every batch has useful execution. Widening tolerance alone is insufficient.

### S2. Batch execution order

Prefer nonoverlapping settlement windows initially. Enforce the actual schedule invariant `settleCloses(b) <= revealCloses(b + 1)`. Commit and reveal phases can still overlap across batches.

This removes execution-order discretion without a global cursor and predecessor-cleanup machinery, but constrains cadence. If benchmarks make that unacceptable, evaluate chronological settlement with explicit expired-predecessor handling. Test the schedule across drand round boundaries.

### S3. Capacity economics

Charge a nonrefundable admission fee for every commitment, including padding, separately from refundable collateral and the reveal reward. Self-revelation must not recover this fee. Per-address limits are not a substitute because addresses are cheap to create.

Measure the cost of occupying the entire batch before selecting the fee. This prices congestion; it does not guarantee access against a well-funded attacker. Raise capacity only after measuring worst-case settlement gas.

### S4. Cleanup and withdrawals

Make cleanup part of the exit flow. Identify unresolved commitments, execute applicable expiration or unrevealed cleanup, then withdraw. Show which commitments prevent withdrawal.

Preserve the funding lock until its invariant is replaced. Start with a guided transaction sequence; add atomic batching only where wallet or contract authorization supports it safely. Test mixed revealed, unrevealed, padding, and expired commitments, including withdrawals of unrelated assets.

### S5. Court router attribution

Do not treat a swap event's router address as the economic trader. Simply deleting the trader check would weaken attribution: supported transaction paths need a verifiable binding between the selected swap and the attacker or covered user.

Start with a narrow set of supported transaction formats. Identify unsupported routes before coverage is purchased. Test both legitimate shared-router activity and adversarial combinations of unrelated swaps.

### S6. Solver search

Replace fixed percentage search bounds with a solver based on the finalized clearing rule: order limits, pool liquidity and tick boundaries, residual direction, executable amounts, and exact contract rounding. Simulate the complete candidate settlement before submission.

Implement this after S1. A wider search cannot repair an infeasible clearing rule. Compare solver results against a small reference model, including cases outside the existing search band.

### S7. Execution responsibility

Run an operated keeper initially with an explicit budget and monitoring. Retain permissionless execution as a fallback. State who operates the service, what happens if it stops, and how users recover funds.

A competitive solver market is separate scope. Permissionless access alone does not supply economic incentives. Test keeper outage and permissionless expiration paths.

### S8. Reveal rewards

Treat the reward as payment for successful on-chain revelation, not reimbursement for first discovering or decrypting an order. The keeper should simulate immediately before submitting and tolerate duplicate attempts. Private submission may reduce copying where available but must not be required for correctness.

Avoid another commit–reveal protocol solely to protect the bounty. Measure competing submissions and gas costs before relying on public reveal competition for liveness.

### S9. Availability and unrevealed penalties

Once admission enforces valid ciphertext, the intended decryption round, and adequate funding, consider this target policy: retain the admission fee, reward successful revelation, and release unexecuted input after a hard deadline without an additional penalty merely because nobody revealed a valid order.

This avoids an on-chain beacon-availability clock and unbounded waiting. It is conditional on enforced admission guarantees: applying the refund policy to unchecked ciphertext would reopen deliberate non-revelation. Evaluate beacon delay, keeper outage, censorship, and owner withholding separately before adopting the policy.

### S10. User transaction flow

Provide one coherent CLI workflow: check balances, approvals, fees, and eligibility; show completion and recovery deadlines; prepare and submit; track revelation and execution; offer cleanup and withdrawal.

Display available, reserved, and withdrawable balances separately, and include every required asset in funding preflight. Keep proceeds in the vault by default for repeat traders with an explicit withdrawal option. Automatic withdrawal on every fill adds cost and settlement failure dependencies.

### S11. Account cadence and private state

**Integration:** one active batch is enforced onchain and checked before client proving. The client persists cumulative totals/blinding, validates openings during import, serializes mutations, and reconciles a saved pending transition before appending. Unknown inclusion is retained, not silently reset. Forced termination may leave a local lock requiring explicit removal after verifying its process has exited. Chain reorganization/finality policy and replacement of dropped transactions remain release decisions; this local gate does not establish production recovery guarantees.


Initially expose the one-active-batch restriction and reject incompatible submissions before proving or paying gas. Supporting overlapping private reservations needs a rule preventing the same balance from backing multiple batches; do not add it without settling that invariant.

Provide reliable private-state export and restoration so state loss does not silently prevent appends. Decide whether overlapping batches are needed from actual usage and the admission design. Test stale and restored client state without changing the proof architecture in this proposal.

### S12. Liquidity availability

Initially accept liquidity removal as an execution risk, with expiry and recovery of unused funds. Show current liquidity and estimated execution before submission without presenting them as guarantees.

Mandatory LP lockups require separate economics and lifecycle rules. Guaranteed liquidity would need an explicitly paid committed-liquidity arrangement. The existing same-block liquidity-change guard proposal addresses a narrower JIT behavior and should not be represented as an availability guarantee.

### S13. Execution quality

Compare fresh external quotes in the client and derive a user-approved limit and expiry. Keep the user's limit as the enforceable protection; an external quote is guidance rather than an execution oracle.

Show results after fees and expected partial execution. Internal price consistency is not a best-execution claim. Test stale quote handling and unfavorable isolated-pool prices.

### S14. Incident-level Court accounting

Define an incident identifier covering chain, block, pool, and attacker front/back transactions. Enforce one incident-level payout budget alongside receipt-level caps; per-victim transaction replay protection alone does not cap repeated use of the same attacker profit.

Two policy choices remain: first valid claims consume the budget, which is simple but rewards speed; or claims register during a window and share the budget, which delays payment and adds state. For a compensation product, prefer the claim-window approach with explicitly defined eligible weights, proportional allocation, and individual caps. State how unclaimed coverage is treated. This does not automatically compensate every affected trader.

Gate: test several covered victims sharing attacker legs, duplicate claims, claim ordering, and aggregate conservation. Reconcile this policy with PLAN.md before implementing payout storage or interfaces.

### S15. Coverage beneficiaries and claims

Bind the beneficiary in a signed coverage receipt issued before the covered activity. Do not infer the payment recipient solely from the transaction signer.

Define the insured event separately from attribution: a sandwich-shaped sequence does not establish provider leakage or quantify victim loss. Offer capped, profit-based coverage for a defined observable event rather than claiming proof of causation. This policy does not by itself solve the self-sandwich incentive described in R8; payout economics still need that adversarial check.

### S16. Watcher operations

Build a minimal service around existing scripts: persist the processed block, rescan a bounded overlap, deduplicate, apply an explicit confirmation policy, bound concurrency, enforce request timeouts, read anchor values against one consistent block, and track submission outcomes.

Separate discovery from expensive proof construction. Test restart, duplicate discovery, RPC failure, anchor consistency, and reorg handling. Add more recovery orchestration only for demonstrated failure boundaries.

### S17. Token and arithmetic domains

**Integration (auction side):** the admitted deployment accepts only its fixed pair and checks exact received and sent amounts (`AdmissionVault`). The base `BlindfoldVault` accepts any token; once #58 lands it also checks exact transfers. Bounds: order amounts are `uint128`, a batch holds at most 64 orders, deposits and fees are at most `uint128`, and `toleranceBps <= BPS` keeps the marginal-price products within 256 bits for every v4 price. The residual swap checks the signs of v4's deltas before casting them. `SealedClearing` (Aqua) quotes with 512-bit intermediates; it previously truncated high bits in `amountOut << 96`. `ConfigValidation.t.sol` and `swapvm/SealedClearingMath.t.sol` test these bounds and the unsupported-asset rejection. Fee-on-transfer and rebasing tokens remain unsupported. Court's part is tracked separately.

Restrict the initial deployment to a supported token pair and transfer behavior. Reject unsupported deposits. For ordinary supported ERC-20s, verify received amounts match credited amounts; fee-on-transfer and rebasing support are separate scope.

Define shared bounds for individual inputs, aggregate residuals, v4 signed deltas, prices, and quotes. Use full-precision arithmetic wherever that domain requires it, including Aqua if retained. Test boundary values and token behavior rather than assuming every ERC-20 acts identically.

### S18. Configuration validation

**Integration (auction side):** constructors reject misaligned or overlapping schedules (R7/S2), an empty reveal window, a vault or deposit token without code, a zero treasury, a zero or oversized deposit, an oversized fee and a tolerance above 100% (`InvalidAuctionConfig(field)`). `initialize` requires two ERC-20 currencies in order, one of them the deposit token, and runs once, for the admin only. The admitted deployment also requires verifier and PoolManager code, a nonzero fee, the vault's pair, this settlement as vault operator, the sealed hook bound to this settlement and manager, and an initialized pool. Before `start`, commits revert and no batch window is open. No deployment script exists on `main` yet, so script-level checks wait for it. Court's part is tracked separately.

Validate meaningful phase durations, admission economics, bounded price tolerance, supported tokens, the expected pool/hook relationship, initialization state, and pre-start behavior.

Write negative tests for invalid configurations and deployment checks for relationships that cannot be established in a constructor. An unusable schedule should fail before accepting orders.

### S19. Arkiv and Swarm scope

Keep contract state and events authoritative. Additional services should serve a specific need such as searchable history, convenient payload retrieval, or a required integration. Settlement and fund recovery should not depend on them unnecessarily.

For each integration, identify what user capability is lost without it. Defer integrations without a concrete purpose, subject to explicit release or prize requirements. Test the supported offline or unavailable-service path.

### S20. Aqua scope

Finish and verify the v4 path first. If Aqua is required for the release, define its narrow role and demonstrate actual end-to-end execution. An isolated opcode test does not demonstrate participation in auction settlement.

Do not support interchangeable residual routes before settling their pricing and accounting rules. This recommendation requires reconciliation with the existing 1inch release lane; it does not silently cancel that work.

### S21. Court release boundary

Give Court independent gates for coverage issuance, attribution, cross-chain evidence, valuation, incident accounting, and payout funding. The auction should remain deployable and usable without Court.

Treat Court as a separate product boundary rather than incidental settlement logic. Demonstrate both the auction-only flow and the complete covered-transaction flow before claiming either is ready.

### S22. Documentation consistency

Maintain one authoritative architecture document, a concise status handoff, and verified test instructions. Distinguish implemented behavior from proposals. Keep unresolved review material here under the REVIEW.md exception, and other local concerns in the ignored .workspace.md.

Reconcile architecture and plan documents after decisions are accepted, without overwriting concurrent admission-proof documentation.

### Implementation order and verification status

First settle partial-fill allocation and build an executable reference model. Then address execution-window ordering, admission economics, keeper responsibility, and cleanup UX. Court and optional integrations can progress independently within their existing team lanes.

These recommendations are not implemented by this document. Earlier isolated tests reproduced six existing behaviors: an executable limit order with no admissible clearing price, reversible batch execution order, padding capacity with no protocol fee, a valid price outside the test solver search range, withdrawal blocking until unrevealed cleanup, and shared-router rejection by the Court predicate. Those reproductions are not validation of the proposed solutions, and this documentation update does not claim a fresh full-suite run or production readiness.


### S1 implementation notes: proportional clearing branch

Implemented in `kritarth/proportional-clearing`, pending shared-seam review and merge. The user selected proportional allocation across equal-limit orders. The planned four-argument ABI is retained, but the representative now defines the whole group's fraction; consumers must not assume it is the only partial order. PLAN.md records that semantic change.

The implementation reuses the existing settlement lifecycle, vault accounting, residual route, marginal-price check, and expiry. Fill amounts are calculated once and held in memory through collection and payout, preventing those phases from disagreeing. It adds no persisted allocation records, background worker, or recovery lifecycle.

Regression tests in `contracts/test/ProportionalClearing.t.sol` cover the previously infeasible sell, buys, multiple equal-limit orders, representative and reveal-order independence, better/worse price priority, opposing flow, invalid representatives and fractions, strict proportional minimums, atomic rollback and expiration, small-minimum price-band validation, the 64-order limit, crossing into a second liquidity range, and liquidity removal followed by rollback and expiration. `ProportionalClearingFork.t.sol` runs the same suite against the deployed Unichain PoolManager.

The independent exact-rational oracle in `contracts/test/clearing_model` has 13 tests, including 2,000 seeded allocation cases and 1,000 seeded feasibility/accounting cases. Run it with `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s contracts/test/clearing_model -v`. It assumes constant active liquidity and no tick crossings; it is not a bit-exact v4 simulator or production solver.

Remaining S1 gates: a production solver must construct group fractions and handle discrete minimum-output failures. No universal-feasibility or maximum-volume theorem is established. The existing tolerance still permits solver price/quantity discretion; equal-limit allocation removes recipient selection within the chosen group, not all economic discretion. Tiny orders can have no admissible nonzero partial amount because their minimum rounds up. Existing expiry remains the recovery path. Tests cover one liquidity-range crossing and total liquidity removal; arbitrary multi-range capacity is not exhaustively covered.

Validation on 2026-11-06:
- `forge test --fuzz-runs 1024 -vv`: 153 passing tests across seven suites, including both Unichain fork suites. Inherited mechanism tests run in multiple suites; this is an execution count, not 153 distinct scenarios. The new accounting fuzz test runs 1,024 cases locally and 1,024 on the fork.
- Independent Python model: 13 passing tests, including the seeded cases described above.
- `forge build --sizes --skip test --skip script`: settlement runtime 16,963 bytes with the selected compiler, below the 24,576-byte limit.
- The 64-order partial-settlement call used 1,765,996 gas in the local warm-state test. This excludes setup and is not a cold transaction gas estimate or a network fee quote.
- Touched Solidity files pass `forge fmt --check`; the patch passes `git diff --check`.

 Other S-items remain proposals and are not fixed by this patch.


### S2 implementation notes: batch execution order

Implemented on `kritarth/batch-ordering`, pending shared timing review and merge; tracks GitHub issue #8. Constructor validation requires a positive settlement window no longer than `floor(batchLength / DRAND_PERIOD) * DRAND_PERIOD`. Because adjacent reveal deadlines differ by at least that amount, a later batch cannot execute while an earlier batch remains executable. This holds for unaligned start times and cadences, not only multiples of three.

The fix adds no persisted cursor or predecessor walk. Empty and expired predecessors do not block subsequent batches; owners can still expire their earlier orders to release funds. Existing 30/60 cadence/window configuration is rejected explicitly, and the mechanism fixture now uses 30/30. Operators must select a longer cadence if they need a longer execution window.

Validation: 198 passing test executions across ten suites with `forge test --fuzz-runs 4096 -vv`, including local and Unichain ordering regressions, 4,096 schedule fuzz cases, every drand alignment/cadence remainder, invalid and zero windows, and unfinalized/empty predecessors. Inherited mechanism tests are repeated across suites; this count is not 198 distinct scenarios. The case that previously allowed a later batch to change the pool before an earlier settlement now rejects the earlier settlement once the later window opens.


### Peer-only matching follow-up to S12 (issue #18)

The user selected peer-only matching first, without mandatory LP lockups. Implemented on `kritarth/peer-clearing`, with consumer integration on `kritarth/peer-solver`, pending shared-seam review. This permits an uneven opposing batch (for example, 100 selling against 50 buying at p=1) to cross 50/50 even when the AMM has no active liquidity.

The initial peer implementation used the stored pool price. The external-market follow-up below replaces it with a validated historical v3 reference; user limits still apply. The mode requires zero active liquidity and conserved budgets for both tokens, and never routes an AMM residual. Zero active liquidity does not establish that all other tick ranges are empty. A one-sided batch still needs an external counterparty; expiration remains available. This implements a liquidity-independent crossing option, not a universal execution guarantee or a committed-capital backstop.

The shared settlement lifecycle and allocation machinery are reused. No persistent queue, liquidity lock, extra collateral, oracle service, or proof input was added. An additive liquidity view and settlement entry point are the only new calls. Rounding is accounted for entirely: surplus goes to output recipients proportionally, with a commitment-ID tie-break for indivisible remainder, and no batch-created balance remains in settlement. Solver selection still has the previously tracked price/quantity-policy limitations; this feature does not claim maximum-volume completeness for all integer cases.


Peer-only validation (2026-11-06):
- `forge test --fuzz-runs 4096 -vv`: 260 passing test executions across twelve suites, including Unichain forks. Inherited suites repeat baseline scenarios; the count is not 260 distinct behaviors.
- `npm test` in the peer solver: 23 offline tests pass; the opt-in integration test is skipped there and was run separately successfully.
- The actual CLI runs normal AMM sells/buys, zero-active-liquidity peer crossings in both directions, and one-sided expiry/recovery on a fresh local anvil. Peer executions emit no pool Swap event and leave no new token balances in settlement.
- Both token rounding-surplus paths, commitment-ID tie-breaking independent of reveal order, bad representatives, both budget deficits, user minimums, active-liquidity rejection, finalization, and window checks pass. Peer accounting fuzz tests run 4,096 cases locally and again on the fork. A 64-order peer batch is included.
- Local peer candidate search: one simulation, approximately 2 ms in each direction. This excludes setup, state reads, the CLI's fresh pre-send check, submission, and confirmation, and is not a live-network latency claim.
- The local 64-order settlement call consumed 1,577,677 gas in warm test state. This excludes setup and is not a cold transaction gas estimate. The size check reported 18,513 runtime bytes for the selected build.
- Touched Solidity files pass formatting checks; both patches pass `git diff --check`.


#### External market review gate (S12/S13/S18)
The Ethereum WETH/USDC implementation adds a fixed-window v3 reference and a
public-pool residual route; peer execution no longer uses the stored sealed price.
Production window, liquidity and deviation thresholds still need calibration
across volatile and quiet periods. Latest observation age is an activity check,
not proof of an economically fresh or manipulation-resistant price. The 24 h
order-flow replay (`packages/solver/replay.mjs`, 2026-11-06) found that a 120 s
limit expired 0.5–1.7% of orders on USDC/WETH 0.05%, 15–24% on WBTC/WETH 0.05%
and 29–52% on UNI/WETH 0.3%, and that removing it expired none. The limit is now
optional per pool (0 = off, the default); deviation, harmonic-liquidity, history
and reference-age checks still apply. A single
pool TWAP can be manipulated; user limits and liquidity checks bound some effects
but do not establish oracle security.

Public liquidity remains withdrawable and changes before inclusion. Full fills
are conditional on executable liquidity and user limits, not guaranteed. The
solver now tries full fills, exact limit-price edges and proportional external
boundary groups, with simulation and deadline bounds. Its halving/bisection search
is a heuristic, not an infeasibility or maximum-volume proof. It must be
benchmarked against a production RPC and the chosen batch deadline. Aqua routing is still a separate integration.
These changes are unmerged seams pending teammate review and do not integrate
the parallel admission-proof work.


External-market follow-up validation: the solver's capacity-limited Anvil cases
filled the equal-limit group at 540/270 inputs in both directions. Full-fill
search took 20/23 simulations (82/62 ms); partial search took 341/411 simulations
(838/977 ms). These are local timings, not production latency.

The read-only sampler collected 13 Ethereum observations across blocks
26,353,849–26,353,945: latest observation age 0–84 s, harmonic liquidity
1.663–1.687 × 10^18, approximate spot/TWAP deviation 4.34–12.52 bps and aggregate
read latency 545–760 ms. The public endpoint rejected older archive requests with
HTTP 403 requiring a personal token. Production calibration therefore remains
open: collect quiet/volatile historical regimes using an archive endpoint and
measure solver simulations against the actual deployed contract. A 120 s activity
limit and 100 bps band passed the sampled regime, but this does not justify them
as production settings. A consistent manipulation of spot and TWAP can pass
these checks; economic attack cost has not been established. No production
launch should be inferred from passing these implementation tests.

Executable-lot fallback for the PR #6 dust-companion review: ordinary proportional
input flooring stays when its output covers the ceil-rounded minimum. Otherwise
input rounds down to amountIn/gcd(amountIn,minAmountOut); if that is zero the order
stays unfilled. The fallback never rounds down the user's output minimum. Zero-
minimum orders with zero output also stay unfilled. Solidity regressions include
the review's 300-token/40-wei pair and both trade directions. The user selected
this refinement after strict lot rounding reduced the fixed model corpus's
rescued count from 49 to 38. Allocation is consequently price-dependent at these
integer boundaries; solver discretion is not eliminated. The solver and model
must use the same fallback, and complete clearing remains conditional.

Fork reproducibility: the public Ethereum RPC prunes historical state, including
previously untouched deployment addresses needed by Foundry. The external-market
fork now defaults to the latest block, with ETH_FORK_BLOCK selecting a fixed
block on an archive endpoint or complete cache. Its historical 26,353,874 results
remain recorded above; a cached successful run is not proof a fresh machine can
retrieve that old state from the public endpoint.


#### General routing scope and validation (issue #43)
The new adapter supports fixed one-to-three-hop v3 paths for pair-specific
markets, including reverse execution, composite historical pricing and exact
balance-delta accounting. This does not deploy a global multi-token auction,
shared vault, pair registry or automatic route-discovery service. Operators must
configure and validate each supported pair; users still select its deployment.
Fee-on-transfer and rebasing token behavior is not supported by the exact-transfer
checks. Native ETH must be wrapped. Numerical underflow/overflow in a composite
reference fails closed rather than broadening the supported price domain.

The first Ethereum fixture rejected inactive DAI/WETH and WBTC/WETH 0.3% pools.
Measured WBTC/WETH observation ages at block 26,354,673 were 12 s (0.01%), 72 s
(0.05%), 8,664 s (0.3%) and 10,284 s (1%). The 0.05% path passed WBTC/WETH/USDC
settlement in both directions at block 26,354,676 with mixed 8/18/6 decimals;
warm settlement calls used 776,676 and 775,620 gas. Fixture thresholds are not
production calibration. Single-pool oracle manipulation concerns apply to each
hop as well as the composed price; route availability is not a fill guarantee.

Each hop deploys an instance of the existing market adapter, reusing its callback
budget and oracle checks. This increases deployment cost versus a shared-library
implementation, but avoids adding a second callback/payment implementation in
this change. Route state is immutable after construction. No arbitrary external
call targets, approvals to aggregators or new recovery lifecycle were introduced.


Final routing verification: 372 contract test executions pass with 4,096 runs per
fuzz test (inherited and compiler-profile duplicates are included), using
ETH_FORK_BLOCK=26354750 and ROUTING_FORK_BLOCK=26354750 for reproducible success
cases. The full suite also covers one/two/three hops, reversed internal pairs,
composite deviation, invalid paths, callback permissions, missing/stale/thin
history, zero output, rollback, dust conservation and short prefunding masked by
a donated adapter balance. Latest-state runs separately hit the intended
freshness rejection; fixed functional fixtures are not an availability promise.
Final warm two-hop settlement calls at that block used 819,645/819,712 gas.
Settlement runtime is 22,578 bytes; route runtime is 3,745 bytes (Solc 0.8.26).
The final solver stack restores all 49 stuck cases in the fixed 300-batch model
corpus while preserving ceil-rounded user minimums and passing dust/coprime
regressions. This corpus is not a universal-clearing proof.

### Global auctions and shared custody (issue #57)

Implemented on `kritarth/global-auction` as a versioned extension to #51 and the proof work in #5. Existing pair ABIs remain unchanged. The global deployment has one shared vault operator, a fixed registry of 2–8 tokens, cumulative private per-token funding, mandatory paired admission proofs, atomic cross-pair cycles, proportional equal-limit allocation, and authenticated residual execution. Global fractions use a uint128 denominator to retain unit resolution across the full order-input range. Only allocations failing their rounded minimum fall back to exact lots.

Review must cover the whole custody/clearing/proof boundary together:

- Token configuration is frozen before admission. This is not an unbounded permissionless token registry; adding capacity or changing order encoding requires a versioned circuit/deployment. Fee-on-transfer and rebasing assets are unsupported. Exact transfer checks reject short transfers at entry/exit, but cannot make an externally rebasing asset suitable collateral.
- A price vector is consistent across pairs but may vary within per-token oracle bands. Relative prices between two non-base tokens can move by the ratio of those bands, not merely one band's percentage. User minima, price priority and token conservation remain enforced. A zero proposed price explicitly excludes all orders involving that token, allowing unrelated healthy markets to settle when an oracle is unavailable.
- The solver is bounded and does not prove maximum volume or global infeasibility. It enumerates configured routes, constructs price-priority cycle circulations in common value units, and searches individual marginal groups and bounded price adjustments. Circulation supports unequal cross-pair cycles with several partial groups; integer rounding, exact-lot fallbacks and greedy cycle choice can still leave feasible combinations undiscovered. Full simulation is the acceptance boundary. General path discovery uses a supplied pool graph; it is not permissionless onchain pool discovery or a route-splitting optimizer.
- One owner may have open commitments in only one global batch. Withdrawals are blocked while those commitments remain unresolved. This preserves funding integrity without per-pair public capacity collateral, at the cost of account-level withdrawal friction. New deposits are allowed. Cleanup is permissionless and bounded; settled batches still permit individual unrevealed slashing.
- Auction deposits, prior balances and adapter donations cannot subsidize a batch deficit. Every external leg spends only measured surplus; all per-token obligations must be covered. Residual rebates are separately observable and can change effective realized prices relative to the nominal uniform-price fill.
- Generated verifiers must correspond to the reviewed global/preparation circuits and reviewed setup parameters. The included setup command creates development parameters, not a production ceremony. Deployment trusts the chosen immutable verifier/adapter configuration. Independent cryptographic review, production oracle manipulation/liquidity calibration, and consumer review remain deployment gates.

Measured global online relation: 3,723,873 constraints. One saved-key run compiled in 8.92 s, loaded keys in 58.21 s, proved in 7.59 s and verified natively in 0.0021 s. Its verifier source was byte-identical to the preceding proof's verifier. The cold CLI therefore took about 75 s before transaction submission; reporting only the proving time would hide the practical cost. A deployment must select cadence from full-path measurements or separately implement and benchmark a prover that retains keys in memory. Preparation was independently measured at 9.72 s proving, excluding local setup. These are individual local samples, not latency percentiles or a production cadence guarantee.

The real-proof harness accepts a valid global ciphertext/funding proof, reveals the order, executes settlement through the actual shared vault, and withdraws output. It rejects ciphertext/root/budget mutations, proof replay, wrong owner, chain replay and malformed proof encoding. Independent tlock-js decryption verifies the recorded quicknet signature and recomputes the global order/registry/root encodings. Synthetic fixture context is explicit; the fresh preparation CLI generates real random key material and private files instead of using those fixtures for users.

Final implementation verification at `213a4f2` (documentation follows separately): 400 contract test executions across 23 suites, including inherited/profile repetitions and Ethereum/Unichain forks, pass with 4,096 runs per fuzz test. The global CLI passes 23 tests, including eight actual CLI scenarios covering equal/unequal cycles, both routing directions, venue fees, expiry, slashing and deployment. Six Go test groups (including mutation subtests), 14 native Rust tests, 14 clearing-model tests and nine real-proof integration tests pass. Both legacy and global independent decryption checks pass. The new CLI's pinned dependency tree reports zero npm audit findings at verification time.

The final 64-order settlement call uses 7,046,581 gas in the local fixture; full test gas also includes committing/revealing all 64 orders. A real-proof admission call uses 1,136,001 gas in the fixture. GlobalAuction runtime is 23,154 bytes with the tested Solc 0.8.30 artifact; the separate proof integration compiles with 0.8.26. These are fixture/code measurements, not production transaction estimates. Review artifacts under ignored `packages/proof-bench/results/global-review-summary.json` record tool versions, circuit identity and verifier hash. No production deployment or independent security audit is claimed.

## Proportional solver integration (issues #7 and #12)

The `kritarth/solver-proportional` branch extends the solver from Bhoumik's PR #4 and targets that branch for review. It consumes the proportional group semantics introduced by PR #6, without changing the four-argument settlement signature. Exact equal-limit groups share one fraction; the solver respects price priority and rounded-up partial minimums. It probes known limit discontinuities before raw-price bisection and validates returned candidates against the contract.

Search reads and simulations use one block, followed by a fresh simulation before submission. RPC failures propagate, a 4,096-call budget fails explicitly, and an unsuccessful search reports no candidate found rather than asserting mathematical infeasibility. This is not a proof of universal execution: absent liquidity and integer constraints still require expiry, and the existing tolerance leaves price/quantity discretion tracked in issue #30.

Validation on 2026-11-06: 15 offline Node tests pass; the separate integration test passes against a real local PoolManager with the actual CLI. The fixed 300-batch model corpus contains 49 all-or-none gaps and the proportional solver rescues all 49. Integration covers sell and buy groups, then liquidity removal, a nonzero CLI exit, and expiration returning the locked input. The local searches used 13 simulations in 44 ms for sells, 13 in 43 ms for buys, and 139 in 375 ms for the no-liquidity case; these are local search measurements, not live-network or proving latency claims.

The integration uses generated contract artifacts and a test-only CREATE2 factory. Artifact resolution supports fresh Foundry builds with compiler-suffixed filenames. The complete batching/order contract branch passed 198 contract test executions including Unichain forks with 4,096 fuzz runs, separately from the Node checks. Merge requires the solver owner and shared-interface review; the ongoing proof work is unchanged.


## Peer-only solver integration (issue #18)

The user selected peer-only matching with no mandatory LP locks. On `kritarth/peer-solver`, the CLI detects the additive `settlePeer` API and reads active liquidity at the same pinned block as its other search inputs. With zero active liquidity it first computes a price-priority crossing locally at the stored pool price, verifies both token budgets and partial minimums, simulates the candidate, and simulates again before submission. It still tries the ordinary AMM search if no peer candidate succeeds, because liquidity can exist beyond the current tick. Deploying this behavior requires the contract on `kritarth/peer-clearing`.

This matches available opposing flow, not absent counterparties. The stored price can be stale; user limits remain enforced. Local integer search is not a proof of maximum-volume completeness. The chosen rounding-surplus policy and additive API are specified in the contract branch's PLAN.md and ARCHITECTURE.MD. No proof inputs, LP lockups, external feeds, or collateral requirements were added.


Peer-only validation (2026-11-06):
- `forge test --fuzz-runs 4096 -vv`: 260 passing test executions across twelve suites, including Unichain forks. Inherited suites repeat baseline scenarios; the count is not 260 distinct behaviors.
- `npm test` in the peer solver: 23 offline tests pass; the opt-in integration test is skipped there and was run separately successfully.
- The actual CLI runs normal AMM sells/buys, zero-active-liquidity peer crossings in both directions, and one-sided expiry/recovery on a fresh local anvil. Peer executions emit no pool Swap event and leave no new token balances in settlement.
- Both token rounding-surplus paths, commitment-ID tie-breaking independent of reveal order, bad representatives, both budget deficits, user minimums, active-liquidity rejection, finalization, and window checks pass. Peer accounting fuzz tests run 4,096 cases locally and again on the fork. A 64-order peer batch is included.
- Local peer candidate search: one simulation, approximately 2 ms in each direction. This excludes setup, state reads, the CLI's fresh pre-send check, submission, and confirmation, and is not a live-network latency claim.
- The local 64-order settlement call consumed 1,577,677 gas in warm test state. This excludes setup and is not a cold transaction gas estimate. The size check reported 18,513 runtime bytes for the selected build.
- Touched Solidity files pass formatting checks; both patches pass `git diff --check`.
