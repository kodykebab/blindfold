# REVIEW.md

Design review of Blindfold and Court as of `main` @ `424642c` (2026-11-06). Each item has an ID (R1–R9), a status, where it lives in the code, the fix, and an owner. The fixes are scheduled in [PLAN.md](PLAN.md). Design reference: [ARCHITECTURE.MD](ARCHITECTURE.MD).

**Proven** means a Foundry test reproduces it against the current contracts (code in the [appendix](#appendix-reproduction-tests)). **From code** means it follows from reading the code and has no test yet.

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

---

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

**Fix:** allow a partial fill for the one marginal order, as standard batch auctions do.
- **New signature:** `settle(b, p, marginalId, marginalAmountIn)`.
- **Fills:** every other order fills iff its limit holds at `p`. The marginal order fills `marginalAmountIn ≤ amountIn`, and only if its limit price is within `toleranceBps` of `p`.
- **Remainder:** the unfilled part is unlocked.
- **Compatibility:** keep `settle(b, p)` as the case with no marginal order, so the change is additive.
- **Acceptance:** the R1 test settles.

## R2. The commit-reveal free option is still open
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
**Where:** [`ReservationModel.t.sol`](contracts/test/ReservationModel.t.sol): `activeBatch` and `step == openCommitments`; [ARCHITECTURE.MD §5](ARCHITECTURE.MD).

**Problem:**
- **Throughput:** an account can't admit into a new batch until all its earlier commitments close. Batch b's orders close at the earliest when its settle window opens (`revealCloses(b)`), which is the moment batch b+1's commit window ends. So an account trades every other batch at best, and every fourth if settlement is late or the batch expires. The pricing design relies on arbitrageurs, who would need many accounts.
- **Proving time:** the [proof-bench README](packages/proof-bench/README.md) has no completed end-to-end proving time yet. If proving takes longer than the 30-second commit window, users must fix their order before the batch opens, which ages it.

**In progress:** `main` @ `6b58167` splits the proof in two:
- a **preparation** proof of the tlock key wrapper, which needs only the round and context, so it can run before the order is chosen;
- an **online** proof of the payload and funding, per order.

Both are bound together (see the [proof-bench README](packages/proof-bench/README.md#prepared-keys-and-online-admission)), so only the online proof has to fit the commit window. Its end-to-end time is still unmeasured.

**Fix:**
- **Measure first:** execute, prove, wrap with Groth16, and verify onchain, end to end on a laptop, for both guest variants, timing the preparation and online proofs separately.
- **Then pick a mode and write it in ARCHITECTURE.MD:**
  - prove inside the window, if fast enough;
  - precompute for batch b+2, accepting an older order;
  - or batch-length guidance.
- **Optional:** let a new admission chain from a root that already reflects the previous batch's settled totals, so an account can enter consecutive batches.

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
**Where:** `SandwichCourtVerifier.verify` requires only that the victim and attacker addresses differ ([`:128`](contracts/src/court/SandwichCourtVerifier.sol#L128)); the planned payout `max(profit, minPenalty) + gas` (CONTEXT.md "Court design").

**Problem:** Court proves that a sandwich happened, not that the RPC leaked it.
1. Someone with two wallets gets a `Protected` receipt for their own transaction.
2. They send the same transaction to their own bot, sandwich it, and claim from the RPC's bond.
3. Their wallets' gains and losses cancel except for pool fees, so the payout is profit. They pick the "profit" themselves by giving the victim transaction wide slippage.
4. The `minPenalty` floor makes even tiny self-sandwiches pay.

**Status:** fixed in [`BondRegistry.sol`](contracts/src/court/BondRegistry.sol): the cap, no floor, once per tx, the unbond delay and chain binding are all tested against the mainnet fixtures. While building it, a related gap turned up: `verify` accepts Swap-shaped logs from whatever `c.pool` the claim names, so a contract emitting fake Swap events could fake a sandwich. BondRegistry pins the pool to the canonical v3 factory (CREATE2) or the v4 PoolManager. **Remaining limit:** profit is valued only in ETH/WETH. The v3 fixture's attacker profits in USDT, so that claim reverts unpaid; paying it needs a price, for example the front leg's own execution price, which `Verdict` doesn't expose yet.

**Fix:** design `BondRegistry` so that sandwiching yourself never pays.
- **Cap from the receipt:** the RPC writes `maxPayout` into the receipt, derived from the transaction's own slippage when it accepted it (quoted output minus `minAmountOut`). Pay `min(valued profit, maxPayout)`.
- **No floor:** drop the `minPenalty`.
- **Once per transaction:** pay each `txHash` at most once.
- **Withdrawal delay:** add a delay on unbonding, so an RPC can't pull its bond ahead of a claim.
- **Bind the chain:** a `Verdict` doesn't say which chain or path it came from, so BondRegistry must check it against the receipt's `chainId`.
- **Valuation:** decide how pool-token profit converts to the bond asset, and write it in CONTEXT.md.
- **Docs:** ARCHITECTURE.MD §10 already says "payout caps"; update CONTEXT.md, which still has the old formula.

## R9. Real sandwichers can easily slip past the Court predicate
**Where:** same signer for front and back ([`:127`](contracts/src/court/SandwichCourtVerifier.sol#L127)), same `trader` field ([`:253`](contracts/src/court/SandwichCourtVerifier.sol#L253)), back leg within 1% of the front ([`:259`](contracts/src/court/SandwichCourtVerifier.sol#L259)).

**Problem:** any of these escapes Court:
- signing front and back with two wallets;
- using two recipient contracts;
- leaving 2% of the position open.

As written, Court catches only naive bots. Loosening the predicate invites false claims, and those feed straight into R8.

**Fix:**
- **Payouts stay strict:** keep the strict predicate for anything that pays out.
- **Track near-misses publicly:** the watcher records near-misses (different signers in the same block around a receipted transaction, partial closes) as public, non-paying `court.suspect` entries on Arkiv. That shows recall without opening the bond to false claims.
- **Document the trade-off:** write it in ARCHITECTURE.MD §10.

---

## Smaller items
- **Rounding dust:** it stays in the settlement contract's own vault balance, with no sweep.
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
