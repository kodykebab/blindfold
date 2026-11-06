// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PeerClearingTest} from "./PeerClearing.t.sol";
import {BatchAuction} from "../src/BatchAuction.sol";
import {BlindfoldSettlement} from "../src/BlindfoldSettlement.sol";

/// @notice SEC-02/SEC-06 evidence: what a permissionless settler's in-band price choice can and cannot change on the
///         external route. Characterises current behaviour; these are not protection claims. Inherits PeerClearingTest,
///         so its tests (and BlindfoldTest's) re-run here: count them separately.
contract ExternalDiscretionTest is PeerClearingTest {
    uint256 constant LOW = uint256(1 << 96) - uint256(1 << 96) / 100; // 1% band edge below reference (reference = Q96)
    uint256 constant NEAR = uint256(1 << 96) * 999 / 1000;

    function _one(uint128 minimum) internal returns (uint64 b) {
        BatchAuction.Order[] memory os = new BatchAuction.Order[](1);
        os[0] = _o(alice, true, 100e18, minimum);
        (b,) = _ready(os, true);
        t1.mint(address(market), 200e18);
        market.setOutputBps(9990);
    }

    /// One-sided batch: the user receives the whole route output (surplus returned), so any accepted price yields the
    /// same payout. Price only decides acceptance (route output must cover the quote at that price).
    function test_discretion_oneSidedPriceOnlyGatesAcceptance() public {
        uint64 b = _one(98e18);
        uint256 before = vault.balanceOf(alice, address(t1));
        uint256 snap = vm.snapshotState();
        vm.expectRevert("short output"); // quote 100 at the reference exceeds the 99.9 route output
        s.settleExternal(b, Q96);
        uint256[3] memory prices = [LOW, Q96 * 995 / 1000, Q96 * 999 / 1000];
        for (uint256 i; i < prices.length; i++) {
            s.settleExternal(b, prices[i]);
            assertEq(vault.balanceOf(alice, address(t1)) - before, 99.9e18, "payout independent of accepted price");
            _assertSolvent();
            vm.revertToState(snap);
            snap = vm.snapshotState();
        }
    }

    /// Mixed batch: peer-crossed volume clears at the chosen price, so the settler moves value between the two sides
    /// within the band. A floor on route output alone does not bound the peer side's payout.
    function test_discretion_mixedBatchPriceShiftsValueBetweenSides() public {
        BatchAuction.Order[] memory os = _pair(true); // alice sells 100 t0 (min 90 t1); bob sells 50 t1 (min 45 t0)
        (uint64 b,) = _ready(os, true);
        t1.mint(address(market), 200e18);
        market.setOutputBps(9990);
        uint256 a1 = vault.balanceOf(alice, address(t1));
        uint256 b0 = vault.balanceOf(bob, address(t0));
        uint256 snap = vm.snapshotState();
        s.settleExternal(b, LOW);
        uint256 aliceLow = vault.balanceOf(alice, address(t1)) - a1;
        uint256 bobLow = vault.balanceOf(bob, address(t0)) - b0;
        _assertSolvent();
        vm.revertToState(snap);
        s.settleExternal(b, NEAR); // highest executable price here: route output just covers alice's quote
        uint256 aliceHigh = vault.balanceOf(alice, address(t1)) - a1;
        uint256 bobHigh = vault.balanceOf(bob, address(t0)) - b0;
        _assertSolvent();
        // bob (peer side) is paid the quote: 50 / p
        assertEq(bobLow, uint256(50e18) * Q96 / LOW);
        assertEq(bobHigh, uint256(50e18) * Q96 / NEAR);
        assertGt(bobLow, bobHigh);
        assertGt(aliceHigh, aliceLow);
        // ~0.45 token (~0.9% of the 50 crossed) moves between users depending only on the settler's choice
        assertGt(bobLow - bobHigh, 0.45e18);
        emit log_named_uint("alice t1 at low edge", aliceLow);
        emit log_named_uint("alice t1 at 0.999", aliceHigh);
        emit log_named_uint("bob t0 at low edge", bobLow);
        emit log_named_uint("bob t0 at 0.999", bobHigh);
    }

    /// A settler may pick an in-band price below a user's limit: the batch finalizes with no fill and cannot be settled
    /// again, although a fill was available. Funds are released (availability loss, not custody loss).
    function test_discretion_settlerCanFinalizeWithoutFills() public {
        uint64 b = _one(99.5e18);
        uint256 snap = vm.snapshotState();
        s.settleExternal(b, Q96 * 999 / 1000); // honest control: quote 99.9 >= limit, route covers it
        assertEq(vault.lockedOf(alice, address(t0)), 0);
        assertEq(vault.balanceOf(alice, address(t0)), 900e18, "honest price fills");
        vm.revertToState(snap);
        s.settleExternal(b, LOW); // quote 99 < limit 99.5: alice is skipped, nothing routes
        assertTrue(s.finalized(b));
        assertEq(vault.balanceOf(alice, address(t0)), 1_000e18, "unfilled: input released");
        assertEq(vault.lockedOf(alice, address(t0)), 0);
        assertEq(vault.openCommitments(alice), 0);
        assertEq(t0.balanceOf(address(market)), 0);
        vm.expectRevert(abi.encodeWithSelector(BlindfoldSettlement.Finalized.selector, b));
        s.settleExternal(b, Q96 * 999 / 1000);
        _assertSolvent();
    }

    /// With two same-side orders, the price can be chosen to fill one and exclude the other even though one price
    /// fills both: inclusion is a settler choice within the band, bounded only by each user's own limit.
    function test_discretion_settlerCanExcludeOneOrder() public {
        BatchAuction.Order[] memory os = new BatchAuction.Order[](2);
        os[0] = _o(alice, true, 100e18, 99.5e18);
        os[1] = _o(bob, true, 100e18, 99e18);
        (uint64 b,) = _ready(os, true);
        t1.mint(address(market), 400e18);
        market.setOutputBps(9990);
        uint256 bob1 = vault.balanceOf(bob, address(t1));
        uint256 snap = vm.snapshotState();
        s.settleExternal(b, Q96 * 999 / 1000);
        assertEq(vault.balanceOf(alice, address(t0)), 900e18, "both fill at 0.999");
        assertEq(vault.balanceOf(bob, address(t0)), 900e18);
        vm.revertToState(snap);
        s.settleExternal(b, Q96 * 992 / 1000);
        assertEq(vault.balanceOf(alice, address(t0)), 1_000e18, "alice excluded at 0.992");
        assertEq(vault.balanceOf(bob, address(t0)), 900e18, "bob filled");
        assertEq(vault.balanceOf(bob, address(t1)) - bob1, 99.9e18, "bob still receives full route output");
        _assertSolvent();
    }

    /// Even with a loose (band-edge) limit, the partial entry point lets a settler choose a negligible fill fraction:
    /// the batch finalizes and the rest of the order is released unexecuted. Fill quantity is settler discretion.
    function test_discretion_settlerCanChooseNegligibleFill() public {
        uint64 b = _one(98e18);
        uint256 id = s.orderIdsOf(b)[0];
        s.settleExternal(b, LOW, id, 0.001e18);
        assertTrue(s.finalized(b));
        assertEq(vault.balanceOf(alice, address(t0)), 1_000e18 - 0.001e18, "0.001 of 100 executed");
        assertEq(vault.lockedOf(alice, address(t0)), 0);
        assertEq(vault.openCommitments(alice), 0);
        vm.expectRevert(abi.encodeWithSelector(BlindfoldSettlement.Finalized.selector, b));
        s.settleExternal(b, Q96 * 999 / 1000);
        _assertSolvent();
    }
}
