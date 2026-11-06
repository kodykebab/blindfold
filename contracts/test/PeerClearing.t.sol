// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BatchAuction} from "../src/BatchAuction.sol";
import {BlindfoldSettlement} from "../src/BlindfoldSettlement.sol";
import {BlindfoldTest} from "./Blindfold.t.sol";

contract PeerClearingTest is BlindfoldTest {
    function _ready(BatchAuction.Order[] memory os, bool removeLiquidity)
        internal
        returns (uint64 b, uint256[] memory ids)
    {
        b = s.currentBatch();
        ids = new uint256[](os.length);
        for (uint256 i; i < os.length; i++) {
            ids[i] = _commit(os[i].owner, os[i], bytes32(i));
        }
        vm.warp(s.revealOpens(b));
        for (uint256 i; i < os.length; i++) {
            s.reveal(ids[i], os[i], bytes32(i));
        }
        if (removeLiquidity) {
            lp.modifyLiquidity(key, IPoolManager.ModifyLiquidityParams(-60_000, 60_000, -1e22, 0), "");
        }
        vm.warp(s.revealCloses(b));
    }

    function _pair(bool sell) internal view returns (BatchAuction.Order[] memory os) {
        os = new BatchAuction.Order[](2);
        os[0] = _o(alice, sell, 100e18, 90e18);
        os[1] = _o(bob, !sell, 50e18, 45e18);
    }

    function test_peer_crossesUnequalFlowWithoutLiquidity() public {
        (uint64 b, uint256[] memory ids) = _ready(_pair(true), true);
        uint256 a1 = vault.balanceOf(alice, address(t1));
        uint256 b0 = vault.balanceOf(bob, address(t0));
        uint256 p = s.poolPriceX96();
        s.settlePeer(b, ids[0], 50e18);
        assertEq(vault.balanceOf(alice, address(t0)), 950e18);
        assertEq(vault.balanceOf(alice, address(t1)) - a1, 50e18);
        assertEq(vault.balanceOf(bob, address(t0)) - b0, 50e18);
        assertEq(s.poolPriceX96(), p);
        assertEq(vault.openCommitments(alice) + vault.openCommitments(bob), 0);
        assertEq(vault.balanceOf(address(s), address(t0)) + vault.balanceOf(address(s), address(t1)), 0);
        _assertSolvent();
    }

    function test_peer_buyHeavyAndZeroMinimum() public {
        BatchAuction.Order[] memory os = _pair(false);
        os[0].minAmountOut = 0;
        (uint64 b, uint256[] memory ids) = _ready(os, true);
        uint256 a1 = vault.balanceOf(alice, address(t1));
        s.settlePeer(b, ids[0], 50e18);
        assertEq(a1 - vault.balanceOf(alice, address(t1)), 50e18);
        assertEq(vault.balanceOf(alice, address(t0)), 1050e18);
        assertEq(vault.balanceOf(bob, address(t0)), 950e18);
        _assertSolvent();
    }

    function test_peer_equalLimitsShareInputs() public {
        BatchAuction.Order[] memory os = new BatchAuction.Order[](3);
        os[0] = _o(alice, true, 100e18, 90e18);
        os[1] = _o(bob, true, 50e18, 45e18);
        os[2] = _o(carol, false, 75e18, 60e18);
        (uint64 b, uint256[] memory ids) = _ready(os, true);
        s.settlePeer(b, ids[0], 50e18);
        assertEq(vault.balanceOf(alice, address(t0)), 950e18);
        assertEq(vault.balanceOf(bob, address(t0)), 975e18);
        assertEq(vault.balanceOf(carol, address(t0)), 1075e18);
        _assertSolvent();
    }

    function test_peer_pricePriorityCanFinishBoundaryGroupAndExcludeWorse() public {
        BatchAuction.Order[] memory os = new BatchAuction.Order[](3);
        os[0] = _o(alice, true, 50e18, 40e18);
        os[1] = _o(bob, true, 50e18, 45e18);
        os[2] = _o(carol, false, 50e18, 40e18);
        (uint64 b, uint256[] memory ids) = _ready(os, true);
        s.settlePeer(b, ids[0], 50e18);
        assertEq(vault.balanceOf(alice, address(t0)), 950e18);
        assertEq(vault.balanceOf(bob, address(t0)), 1000e18);
        assertEq(vault.lockedOf(bob, address(t0)), 0);
        _assertSolvent();
    }

    function test_peer_rejectsLiquidityAndBothBudgetDeficitsAtomically() public {
        (uint64 b, uint256[] memory ids) = _ready(_pair(true), false);
        vm.expectRevert(BlindfoldSettlement.ActiveLiquidity.selector);
        s.settlePeer(b, ids[0], 50e18);
        lp.modifyLiquidity(key, IPoolManager.ModifyLiquidityParams(-60_000, 60_000, -1e22, 0), "");
        vm.expectPartialRevert(BlindfoldSettlement.PeerUnbalanced.selector);
        s.settlePeer(b, ids[0], 49e18);
        vm.expectPartialRevert(BlindfoldSettlement.PeerUnbalanced.selector);
        s.settlePeer(b, ids[0], 51e18);
        assertFalse(s.finalized(b));
        assertEq(vault.lockedOf(alice, address(t0)), 100e18);
        assertEq(vault.lockedOf(bob, address(t1)), 50e18);
        assertEq(s.clearingPriceX96(b), 0);
        _assertSolvent();
    }

    function test_peer_rejectsOneSidedBatchAndPreservesExpiry() public {
        BatchAuction.Order[] memory os = new BatchAuction.Order[](1);
        os[0] = _o(alice, true, 100e18, 90e18);
        (uint64 b, uint256[] memory ids) = _ready(os, true);
        vm.expectPartialRevert(BlindfoldSettlement.PeerUnbalanced.selector);
        s.settlePeer(b, ids[0], 50e18);
        vm.warp(s.settleCloses(b));
        s.expire(b);
        assertEq(vault.balanceOf(alice, address(t0)), 1000e18);
        assertEq(vault.openCommitments(alice), 0);
    }

    function test_peer_rejectsLimitViolationAndInvalidRepresentatives() public {
        BatchAuction.Order[] memory os = _pair(true);
        os[0].minAmountOut = 110e18;
        (uint64 b, uint256[] memory ids) = _ready(os, true);
        vm.expectPartialRevert(BlindfoldSettlement.PartialLimit.selector);
        s.settlePeer(b, ids[0], 50e18);
        vm.expectRevert(BlindfoldSettlement.InvalidMarginalOrder.selector);
        s.settlePeer(b + 1, ids[0], 50e18);
        vm.expectRevert(BlindfoldSettlement.InvalidMarginalOrder.selector);
        s.settlePeer(b, ids[0], 0);
        vm.expectRevert(BlindfoldSettlement.InvalidMarginalOrder.selector);
        s.settlePeer(b, ids[0], 101e18);
        assertFalse(s.finalized(b));
    }

    function _movePrice() internal {
        // Set a non-integral stored price through a real earlier auction.
        uint64 first = s.currentBatch();
        BatchAuction.Order memory move = _o(carol, true, 100e18, 0);
        uint256 moveId = _commit(carol, move, "move");
        vm.warp(s.revealOpens(first));
        s.reveal(moveId, move, "move");
        vm.warp(s.revealCloses(first));
        s.settle(first, Q96 * 985 / 1000);
    }

    function test_peer_roundingSurplusPaidAndRevealOrderDoesNotChooseRecipient() public {
        _movePrice();
        uint256 p = s.poolPriceX96();
        uint64 b = s.currentBatch();
        BatchAuction.Order memory a = _o(alice, true, 100, 0);
        BatchAuction.Order memory c = _o(bob, false, 2, 0);
        BatchAuction.Order memory d = _o(carol, false, 2, 0);
        uint256 aid = _commit(alice, a, "a");
        uint256 cid = _commit(bob, c, "c");
        uint256 did = _commit(carol, d, "d");
        vm.warp(s.revealOpens(b));
        uint256 snap = vm.snapshotState();
        uint256[2] memory result;
        for (uint256 pass; pass < 2; pass++) {
            s.reveal(aid, a, "a");
            if (pass == 0) {
                s.reveal(cid, c, "c");
                s.reveal(did, d, "d");
            } else {
                s.reveal(did, d, "d");
                s.reveal(cid, c, "c");
            }
            lp.modifyLiquidity(key, IPoolManager.ModifyLiquidityParams(-60_000, 60_000, -1e22, 0), "");
            vm.warp(s.revealCloses(b));
            uint256 beforeA = vault.balanceOf(alice, address(t1));
            uint256 beforeC = vault.balanceOf(bob, address(t0));
            uint256 beforeD = vault.balanceOf(carol, address(t0));
            // 5 input tokens quote to 4 output; each buyer quotes 2 token0.
            s.settlePeer(b, aid, 5);
            assertEq(vault.balanceOf(alice, address(t1)) - beforeA, 4);
            assertEq(vault.balanceOf(bob, address(t0)) - beforeC, 3);
            assertEq(vault.balanceOf(carol, address(t0)) - beforeD, 2);
            assertEq(vault.balanceOf(address(s), address(t0)) + vault.balanceOf(address(s), address(t1)), 0);
            assertEq(s.poolPriceX96(), p);
            result[pass] = vault.balanceOf(bob, address(t0));
            _assertSolvent();
            if (pass == 0) vm.revertToState(snap);
        }
        assertEq(result[0], result[1]);
    }

    function testFuzz_peer_conservesBothTokens(uint96 amountSeed, bool sell) public {
        uint256 amount = bound(uint256(amountSeed), 1, 400e18);
        BatchAuction.Order[] memory os = new BatchAuction.Order[](2);
        os[0] = _o(alice, sell, 2 * amount, 0);
        os[1] = _o(bob, !sell, amount, 0);
        (uint64 b, uint256[] memory ids) = _ready(os, true);
        s.settlePeer(b, ids[0], uint128(amount));
        assertEq(vault.openCommitments(alice) + vault.openCommitments(bob), 0);
        assertEq(vault.balanceOf(address(s), address(t0)) + vault.balanceOf(address(s), address(t1)), 0);
        _assertSolvent();
    }

    function test_peer_maxBatchDoesNotLeaveBalances() public {
        BatchAuction.Order[] memory os = new BatchAuction.Order[](64);
        for (uint256 i; i < 32; i++) {
            os[i] = _o(alice, true, 20e18, 0);
        }
        for (uint256 i = 32; i < 64; i++) {
            os[i] = _o(bob, false, 10e18, 0);
        }
        (uint64 b, uint256[] memory ids) = _ready(os, true);
        uint256 beforeGas = gasleft();
        s.settlePeer(b, ids[0], 10e18);
        emit log_named_uint("64-order peer settlement call gas (warm test state)", beforeGas - gasleft());
        assertEq(vault.balanceOf(alice, address(t0)), 680e18);
        assertEq(vault.balanceOf(bob, address(t0)), 1320e18);
        assertEq(vault.openCommitments(alice) + vault.openCommitments(bob), 0);
        assertEq(vault.balanceOf(address(s), address(t0)) + vault.balanceOf(address(s), address(t1)), 0);
        _assertSolvent();
    }

    function test_peer_obeysWindowAndFinalization() public {
        (uint64 b, uint256[] memory ids) = _ready(_pair(true), true);
        vm.warp(s.revealCloses(b) - 1);
        vm.expectPartialRevert(BlindfoldSettlement.OutsideSettleWindow.selector);
        s.settlePeer(b, ids[0], 50e18);
        vm.warp(s.revealCloses(b));
        s.settlePeer(b, ids[0], 50e18);
        vm.expectRevert(abi.encodeWithSelector(BlindfoldSettlement.Finalized.selector, b));
        s.settlePeer(b, ids[0], 50e18);
    }

    function test_peer_token1RoundingSurplusAlsoReturned() public {
        _movePrice();
        BatchAuction.Order[] memory os = new BatchAuction.Order[](2);
        os[0] = _o(alice, true, 100, 0);
        os[1] = _o(bob, false, 4, 0);
        (uint64 b, uint256[] memory ids) = _ready(os, true);
        uint256 aBefore = vault.balanceOf(alice, address(t1));
        uint256 bBefore = vault.balanceOf(bob, address(t0));
        s.settlePeer(b, ids[0], 4);
        assertEq(vault.balanceOf(alice, address(t1)) - aBefore, 4);
        assertEq(vault.balanceOf(bob, address(t0)) - bBefore, 4);
        assertEq(vault.balanceOf(address(s), address(t0)) + vault.balanceOf(address(s), address(t1)), 0);
        _assertSolvent();
    }
}
