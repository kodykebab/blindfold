// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {PeerClearingTest} from "./PeerClearing.t.sol";
import {BatchAuction} from "../src/BatchAuction.sol";
import {BlindfoldSettlement} from "../src/BlindfoldSettlement.sol";

contract ExternalSettlementTest is PeerClearingTest {
    function test_external_oneSidedPublicLiquidityBothDirections() public {
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < 2; i++) {
            bool sell = i == 0;
            BatchAuction.Order[] memory os = new BatchAuction.Order[](1);
            os[0] = _o(alice, sell, 100e18, 98e18);
            (uint64 b,) = _ready(os, true);
            t0.mint(address(market), 200e18);
            t1.mint(address(market), 200e18);
            market.setOutputBps(9990);
            uint256 beforeOut = vault.balanceOf(alice, sell ? address(t1) : address(t0));
            s.settleExternal(b, sell ? (Q96 - Q96 / 100) : Q96 * 101 / 100);
            assertEq(vault.balanceOf(alice, sell ? address(t1) : address(t0)) - beforeOut, 99.9e18);
            assertEq(vault.balanceOf(address(s), address(t0)) + vault.balanceOf(address(s), address(t1)), 0);
            assertEq(vault.openCommitments(alice), 0);
            _assertSolvent();
            if (i == 0) vm.revertToState(snap);
        }
    }

    function test_external_shortOutputRollsBackAndExpiryWorks() public {
        BatchAuction.Order[] memory os = new BatchAuction.Order[](1);
        os[0] = _o(alice, true, 100e18, 98e18);
        (uint64 b,) = _ready(os, true);
        t1.mint(address(market), 100e18);
        market.setOutputBps(9800);
        vm.expectRevert("short output");
        s.settleExternal(b, (Q96 - Q96 / 100));
        assertFalse(s.finalized(b));
        assertEq(t0.balanceOf(address(market)), 0);
        assertEq(vault.lockedOf(alice, address(t0)), 100e18);
        vm.warp(s.settleCloses(b));
        s.expire(b);
        assertEq(vault.openCommitments(alice), 0);
        _assertSolvent();
    }

    function test_external_referenceControlsPeerNotStoredPrice() public {
        BatchAuction.Order[] memory os = _pair(true);
        os[0].minAmountOut = 0;
        os[1].minAmountOut = 0;
        (uint64 b, uint256[] memory ids) = _ready(os, true);
        market.setPrice(2 * Q96);
        s.settlePeer(b, ids[0], 25e18);
        assertEq(s.clearingPriceX96(b), 2 * Q96);
        assertEq(s.poolPriceX96(), Q96);
        _assertSolvent();
    }

    function test_external_badReferenceCannotFallBackToStoredPrice() public {
        (uint64 b, uint256[] memory ids) = _ready(_pair(true), true);
        market.setFail(true);
        vm.expectRevert("oracle unavailable");
        s.settlePeer(b, ids[0], 50e18);
        vm.expectRevert("oracle unavailable");
        s.settleExternal(b, Q96);
        vm.expectRevert(BlindfoldSettlement.MissingLiquidity.selector);
        s.settle(b, Q96);
        assertFalse(s.finalized(b));
    }

    function test_external_priceBandAndConfigurationAreEnforced() public {
        vm.expectRevert(BlindfoldSettlement.ExternalConfig.selector);
        s.configureExternal(market);
        vm.prank(alice);
        vm.expectRevert(BlindfoldSettlement.Unauthorized.selector);
        s.configureExternal(market);
        (uint64 b,) = _ready(_pair(true), true);
        vm.expectRevert(BlindfoldSettlement.ExternalPrice.selector);
        s.settleExternal(b, Q96 * 102 / 100);
        assertFalse(s.finalized(b));
    }

    function test_external_partialGroupSharesSurplus() public {
        BatchAuction.Order[] memory os = new BatchAuction.Order[](3);
        os[0] = _o(alice, true, 100e18, 90e18);
        os[1] = _o(bob, true, 50e18, 45e18);
        os[2] = _o(carol, false, 50e18, 40e18);
        (uint64 b, uint256[] memory ids) = _ready(os, true);
        t1.mint(address(market), 100e18);
        s.settleExternal(b, Q96, ids[0], 50e18);
        assertEq(vault.balanceOf(alice, address(t0)), 950e18);
        assertEq(vault.balanceOf(bob, address(t0)), 975e18);
        assertEq(vault.balanceOf(address(s), address(t0)) + vault.balanceOf(address(s), address(t1)), 0);
        _assertSolvent();
    }
}
