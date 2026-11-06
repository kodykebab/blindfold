// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BlindfoldTest} from "./Blindfold.t.sol";
import {BatchAuction} from "../src/BatchAuction.sol";
import {BlindfoldSettlement} from "../src/BlindfoldSettlement.sol";

contract ProportionalClearingTest is BlindfoldTest {
    function _ready(BatchAuction.Order[] memory os) internal returns (uint64 b, uint256[] memory ids) {
        b = s.currentBatch();
        ids = new uint256[](os.length);
        for (uint256 i; i < os.length; i++) {
            ids[i] = _commit(os[i].owner, os[i], bytes32(i));
        }
        vm.warp(s.revealOpens(b));
        for (uint256 i; i < os.length; i++) {
            s.reveal(ids[i], os[i], bytes32(i));
        }
        vm.warp(s.revealCloses(b));
    }

    function _sellPrice() internal pure returns (uint256) {
        return (9 * Q96 + 9) / 10; // ceil(0.9 Q96)
    }

    function test_partial_singleSellUnlocksRemainder() public {
        BatchAuction.Order[] memory os = new BatchAuction.Order[](1);
        os[0] = _o(alice, true, 1000e18, 900e18);
        (uint64 b, uint256[] memory ids) = _ready(os);
        uint256 beforeOut = vault.balanceOf(alice, address(t1));
        vm.expectPartialRevert(BlindfoldSettlement.NotMarginalPrice.selector);
        s.settle(b, _sellPrice());
        s.settle(b, _sellPrice(), ids[0], 540e18);
        assertEq(vault.balanceOf(alice, address(t0)), 460e18);
        assertEq(vault.balanceOf(alice, address(t1)) - beforeOut, 486e18);
        assertEq(vault.lockedOf(alice, address(t0)), 0);
        assertEq(vault.openCommitments(alice), 0);
        _assertSolvent();
    }

    function test_partial_equalLimitsShareAndRepresentativeDoesNotPickWinner() public {
        BatchAuction.Order[] memory os = new BatchAuction.Order[](2);
        os[0] = _o(alice, true, 1000e18, 900e18);
        os[1] = _o(bob, true, 500e18, 450e18);
        (uint64 b, uint256[] memory ids) = _ready(os);
        uint256 snap = vm.snapshotState();
        s.settle(b, _sellPrice(), ids[0], 360e18);
        uint256 a0 = vault.balanceOf(alice, address(t0));
        uint256 a1 = vault.balanceOf(alice, address(t1));
        uint256 b0 = vault.balanceOf(bob, address(t0));
        uint256 b1 = vault.balanceOf(bob, address(t1));
        assertEq(a0, 640e18);
        assertEq(b0, 820e18);
        assertEq(vault.lockedOf(alice, address(t0)) + vault.lockedOf(bob, address(t0)), 0);
        _assertSolvent();
        vm.revertToState(snap);
        s.settle(b, _sellPrice(), ids[1], 180e18);
        assertEq(vault.balanceOf(alice, address(t0)), a0);
        assertEq(vault.balanceOf(alice, address(t1)), a1);
        assertEq(vault.balanceOf(bob, address(t0)), b0);
        assertEq(vault.balanceOf(bob, address(t1)), b1);
        _assertSolvent();
    }

    function test_partial_betterLimitsFillAndWorseLimitsRemainUntouched() public {
        BatchAuction.Order[] memory os = new BatchAuction.Order[](3);
        os[0] = _o(alice, true, 1000e18, 900e18);
        os[1] = _o(bob, true, 100e18, 80e18);
        os[2] = _o(carol, true, 100e18, 95e18);
        (uint64 b, uint256[] memory ids) = _ready(os);
        s.settle(b, _sellPrice(), ids[0], 440e18);
        assertEq(vault.balanceOf(alice, address(t0)), 560e18);
        assertEq(vault.balanceOf(bob, address(t0)), 900e18);
        assertEq(vault.balanceOf(carol, address(t0)), 1000e18);
        assertEq(vault.openCommitments(carol), 0);
        _assertSolvent();
    }

    function test_partial_opposingFlowNetsBeforeResidual() public {
        BatchAuction.Order[] memory os = new BatchAuction.Order[](2);
        os[0] = _o(alice, true, 1000e18, 900e18);
        os[1] = _o(bob, false, 90e18, 90e18);
        (uint64 b, uint256[] memory ids) = _ready(os);
        s.settle(b, _sellPrice(), ids[0], 640e18);
        assertEq(vault.balanceOf(alice, address(t0)), 360e18);
        // Uniform-price division rounds down at the Q96 representation of 0.9.
        assertEq(vault.balanceOf(bob, address(t0)), 1100e18 - 1);
        _assertSolvent();
    }

    function test_partial_buyGroup() public {
        BatchAuction.Order[] memory os = new BatchAuction.Order[](2);
        os[0] = _o(alice, false, 900e18, 810e18);
        os[1] = _o(bob, false, 450e18, 405e18);
        (uint64 b, uint256[] memory ids) = _ready(os);
        uint256 a1 = vault.balanceOf(alice, address(t1));
        uint256 b1 = vault.balanceOf(bob, address(t1));
        s.settle(b, 10 * Q96 / 9, ids[0], 360e18);
        assertEq(a1 - vault.balanceOf(alice, address(t1)), 360e18);
        assertEq(b1 - vault.balanceOf(bob, address(t1)), 180e18);
        assertEq(vault.balanceOf(alice, address(t0)), 1324e18);
        assertEq(vault.balanceOf(bob, address(t0)), 1162e18);
        _assertSolvent();
    }

    function test_partial_invalidRepresentativeAndFraction() public {
        BatchAuction.Order[] memory os = new BatchAuction.Order[](1);
        os[0] = _o(alice, true, 1000e18, 900e18);
        (uint64 b, uint256[] memory ids) = _ready(os);
        vm.expectRevert(BlindfoldSettlement.InvalidMarginalOrder.selector);
        s.settle(b, _sellPrice(), type(uint256).max, 1);
        vm.expectRevert(BlindfoldSettlement.InvalidMarginalOrder.selector);
        s.settle(b + 1, _sellPrice(), ids[0], 540e18);
        vm.expectRevert(BlindfoldSettlement.InvalidMarginalOrder.selector);
        s.settle(b, _sellPrice(), ids[0], 0);
        vm.expectRevert(BlindfoldSettlement.InvalidMarginalOrder.selector);
        s.settle(b, _sellPrice(), ids[0], 1000e18);
        vm.expectRevert(BlindfoldSettlement.InvalidMarginalOrder.selector);
        s.settle(b, Q96, ids[0], 540e18);
        assertFalse(s.finalized(b));
        assertEq(vault.lockedOf(alice, address(t0)), 1000e18);
    }

    function test_partial_dustUnfilledAndMarginalCheckStillAtomic() public {
        BatchAuction.Order[] memory os = new BatchAuction.Order[](1);
        os[0] = _o(alice, true, 3, 2);
        (uint64 b, uint256[] memory ids) = _ready(os);
        vm.expectPartialRevert(BlindfoldSettlement.NotMarginalPrice.selector);
        s.settle(b, (2 * Q96 + 2) / 3, ids[0], 2);
        assertFalse(s.finalized(b));
        assertEq(s.clearingPriceX96(b), 0);
        assertEq(vault.lockedOf(alice, address(t0)), 3);
        assertEq(vault.openCommitments(alice), 1);
        vm.warp(s.settleCloses(b));
        s.expire(b);
        assertEq(vault.lockedOf(alice, address(t0)), 0);
        assertEq(vault.openCommitments(alice), 0);
        _assertSolvent();
    }

    function test_partial_dustCompanionCannotBlockEitherDirection() public {
        uint256 snap = vm.snapshotState();
        for (uint256 side; side < 2; side++) {
            bool sell = side == 0;
            BatchAuction.Order[] memory os = new BatchAuction.Order[](2);
            os[0] = _o(alice, sell, sell ? 1000e18 : 900e18, sell ? 900e18 : 810e18);
            os[1] = _o(bob, sell, 10, 9);
            (uint64 b, uint256[] memory ids) = _ready(os);
            address input = sell ? address(t0) : address(t1);
            uint256 beforeDust = vault.balanceOf(bob, input);
            s.settle(b, sell ? _sellPrice() : 10 * Q96 / 9, ids[0], 540e18);
            assertEq(vault.balanceOf(bob, input), beforeDust);
            assertEq(vault.lockedOf(bob, input), 0);
            assertEq(vault.openCommitments(bob), 0);
            _assertSolvent();
            if (side == 0) vm.revertToState(snap);
        }
    }

    function test_partial_reviewFortyWeiCompanionRegression() public {
        BatchAuction.Order[] memory os = new BatchAuction.Order[](3);
        os[0] = _o(alice, true, 300e18, 292.5e18);
        os[1] = _o(bob, false, 10e18, 9e18);
        os[2] = _o(carol, true, 40, 39);
        (uint64 b, uint256[] memory ids) = _ready(os);
        lp.modifyLiquidity(key, IPoolManager.ModifyLiquidityParams(-60_000, 60_000, -9e21, 0), "");
        uint256 p = (975 * Q96 + 999) / 1000;
        p += p / 100;
        s.settle(b, p, ids[0], 13e18);
        assertEq(vault.balanceOf(alice, address(t0)), 987e18);
        assertEq(vault.balanceOf(carol, address(t0)), 1000e18);
        assertEq(vault.lockedOf(carol, address(t0)), 0);
        assertEq(vault.openCommitments(carol), 0);
        _assertSolvent();
    }

    function test_partial_smallMinimumDoesNotWidenMarginalBand() public {
        BatchAuction.Order[] memory os = new BatchAuction.Order[](1);
        os[0] = _o(alice, true, 1000, 1);
        (uint64 b, uint256[] memory ids) = _ready(os);
        vm.expectRevert(BlindfoldSettlement.InvalidMarginalOrder.selector);
        s.settle(b, Q96 * 19 / 10000, ids[0], 500);
    }

    function testFuzz_partial_groupFractionPreservesAccounting(uint16 seed) public {
        uint256 size = bound(uint256(seed), 1, 999) * 1e18;
        BatchAuction.Order[] memory os = new BatchAuction.Order[](2);
        os[0] = _o(alice, true, size, size * 9 / 10);
        os[1] = _o(bob, true, 1000e18 - size, (1000e18 - size) * 9 / 10);
        (uint64 b, uint256[] memory ids) = _ready(os);
        uint256 aOut = vault.balanceOf(alice, address(t1));
        uint256 bOut = vault.balanceOf(bob, address(t1));
        uint256 aFill = size * 54 / 100;
        uint256 bFill = (1000e18 - size) * 54 / 100;
        s.settle(b, _sellPrice(), ids[0], uint128(aFill));
        assertEq(vault.balanceOf(alice, address(t0)), 1000e18 - aFill);
        assertEq(vault.balanceOf(bob, address(t0)), 1000e18 - bFill);
        assertEq(vault.balanceOf(alice, address(t1)) - aOut, aFill * 9 / 10);
        assertEq(vault.balanceOf(bob, address(t1)) - bOut, bFill * 9 / 10);
        assertEq(vault.openCommitments(alice) + vault.openCommitments(bob), 0);
        _assertSolvent();
    }

    function test_partial_maxBatchAndSettlementGas() public {
        BatchAuction.Order[] memory os = new BatchAuction.Order[](64);
        for (uint256 i; i < os.length; i++) {
            os[i] = _o(alice, true, 10e18, 9e18);
        }
        (uint64 b, uint256[] memory ids) = _ready(os);
        uint256 beforeOut = vault.balanceOf(alice, address(t1));
        uint256 gasBefore = gasleft();
        s.settle(b, _sellPrice(), ids[0], 8_4375e14);
        uint256 settlementGas = gasBefore - gasleft();
        emit log_named_uint("64-order partial settlement call gas (warm test state)", settlementGas);
        assertEq(vault.balanceOf(alice, address(t0)), 460e18);
        assertEq(vault.balanceOf(alice, address(t1)) - beforeOut, 486e18);
        assertEq(vault.openCommitments(alice), 0);
        assertEq(vault.lockedOf(alice, address(t0)), 0);
        _assertSolvent();
    }

    function test_partial_revealOrderDoesNotChangeAllocation() public {
        BatchAuction.Order memory a = _o(alice, true, 1000e18, 900e18);
        BatchAuction.Order memory c = _o(bob, true, 500e18, 450e18);
        uint64 b = s.currentBatch();
        uint256 aid = _commit(alice, a, "a");
        uint256 bid = _commit(bob, c, "b");
        vm.warp(s.revealOpens(b));
        uint256 snap = vm.snapshotState();
        s.reveal(aid, a, "a");
        s.reveal(bid, c, "b");
        vm.warp(s.revealCloses(b));
        s.settle(b, _sellPrice(), aid, 360e18);
        uint256 aOut = vault.balanceOf(alice, address(t1));
        uint256 bOut = vault.balanceOf(bob, address(t1));
        vm.revertToState(snap);
        s.reveal(bid, c, "b");
        s.reveal(aid, a, "a");
        vm.warp(s.revealCloses(b));
        s.settle(b, _sellPrice(), aid, 360e18);
        assertEq(vault.balanceOf(alice, address(t0)), 640e18);
        assertEq(vault.balanceOf(bob, address(t0)), 820e18);
        assertEq(vault.balanceOf(alice, address(t1)), aOut);
        assertEq(vault.balanceOf(bob, address(t1)), bOut);
        _assertSolvent();
    }

    function test_partial_residualCrossesLiquidityBoundary() public {
        lp.modifyLiquidity(key, IPoolManager.ModifyLiquidityParams(-60_000, 60_000, -1e22, 0), "");
        lp.modifyLiquidity(key, IPoolManager.ModifyLiquidityParams(-600, 600, 1e22, 0), "");
        lp.modifyLiquidity(key, IPoolManager.ModifyLiquidityParams(-1200, -600, 2e22, 0), "");
        BatchAuction.Order[] memory os = new BatchAuction.Order[](1);
        os[0] = _o(alice, true, 1000e18, 900e18);
        (uint64 b, uint256[] memory ids) = _ready(os);
        s.settle(b, _sellPrice(), ids[0], 770e18);
        assertLt(s.poolPriceX96(), 94 * Q96 / 100);
        assertEq(vault.balanceOf(alice, address(t0)), 230e18);
        assertEq(vault.lockedOf(alice, address(t0)), 0);
        _assertSolvent();
    }

    function test_partial_removedLiquidityRollsBackAndExpires() public {
        BatchAuction.Order[] memory os = new BatchAuction.Order[](1);
        os[0] = _o(alice, true, 1000e18, 900e18);
        (uint64 b, uint256[] memory ids) = _ready(os);
        lp.modifyLiquidity(key, IPoolManager.ModifyLiquidityParams(-60_000, 60_000, -1e22, 0), "");
        vm.expectPartialRevert(BlindfoldSettlement.PartialResidual.selector);
        s.settle(b, _sellPrice(), ids[0], 540e18);
        assertFalse(s.finalized(b));
        assertEq(vault.lockedOf(alice, address(t0)), 1000e18);
        vm.warp(s.settleCloses(b));
        s.expire(b);
        assertEq(vault.balanceOf(alice, address(t0)), 1000e18);
        assertEq(vault.lockedOf(alice, address(t0)), 0);
        assertEq(vault.openCommitments(alice), 0);
        _assertSolvent();
    }
}
