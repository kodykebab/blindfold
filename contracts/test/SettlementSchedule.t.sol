// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BatchAuction} from "../src/BatchAuction.sol";
import {BlindfoldVault} from "../src/BlindfoldVault.sol";
import {BlindfoldSettlement} from "../src/BlindfoldSettlement.sol";
import {BlindfoldTest} from "./Blindfold.t.sol";

contract ScheduleHarness is BatchAuction {
    constructor(Schedule memory schedule)
        BatchAuction(BlindfoldVault(address(0)), address(1), 0, 0, address(2), schedule)
    {}

    function _inputToken(bool) internal pure override returns (address) {
        return address(1);
    }
}

contract SettlementScheduleTest is Test {
    function test_rejectOverlappingAndEmptyWindows() public {
        vm.expectRevert(abi.encodeWithSelector(BatchAuction.InvalidSettlementWindow.selector, 60, 30));
        new ScheduleHarness(BatchAuction.Schedule(1_800_000_000, 30, 24, 60));
        vm.expectRevert(abi.encodeWithSelector(BatchAuction.InvalidSettlementWindow.selector, 0, 30));
        new ScheduleHarness(BatchAuction.Schedule(1_800_000_000, 30, 24, 0));
        vm.expectRevert(abi.encodeWithSelector(BatchAuction.InvalidSettlementWindow.selector, 10, 9));
        new ScheduleHarness(BatchAuction.Schedule(1_800_000_000, 10, 24, 10));
        vm.expectRevert(abi.encodeWithSelector(BatchAuction.InvalidSettlementWindow.selector, 1, 0));
        new ScheduleHarness(BatchAuction.Schedule(1_800_000_000, 2, 24, 1));
    }

    function testFuzz_windowsNeverOverlap(uint32 lengthSeed, uint32 startOffset, uint32 batchSeed, uint32 reveal)
        public
    {
        uint32 length = uint32(bound(uint256(lengthSeed), 3, 100_000));
        uint32 maximum = length / 3 * 3;
        uint64 start = 1_692_803_367 + uint64(startOffset);
        uint64 b = uint64(bound(uint256(batchSeed), 0, 100_000));
        ScheduleHarness h = new ScheduleHarness(BatchAuction.Schedule(start, length, reveal, maximum));
        assertLe(h.settleCloses(b), h.revealCloses(b + 1));
        assertGt(h.settleCloses(b), h.revealCloses(b));
    }

    function test_allDrandAlignmentsAndCadenceRemainders() public {
        for (uint64 offset; offset < 3; offset++) {
            for (uint32 cadence = 30; cadence <= 32; cadence++) {
                ScheduleHarness h = new ScheduleHarness(BatchAuction.Schedule(1_692_803_367 + offset, cadence, 24, 30));
                for (uint64 b; b < 6; b++) {
                    assertLe(h.settleCloses(b), h.revealCloses(b + 1));
                }
            }
        }
    }
}

contract BatchOrderingTest is BlindfoldTest {
    function test_ordering_laterSettlementClosesEarlierExecution() public {
        uint64 first = s.currentBatch();
        BatchAuction.Order memory a = _o(alice, true, 20e18, 0);
        BatchAuction.Order memory b = _o(bob, true, 20e18, 0);
        uint256 aid = _commit(alice, a, "a");
        vm.warp(s.commitsClose(first));
        uint64 later = s.currentBatch();
        uint256 bid = _commit(bob, b, "b");
        vm.warp(s.revealOpens(first));
        s.reveal(aid, a, "a");
        vm.warp(s.revealOpens(later));
        s.reveal(bid, b, "b");
        vm.expectPartialRevert(BlindfoldSettlement.OutsideSettleWindow.selector);
        s.settle(later, Q96);
        vm.warp(s.revealCloses(later));
        vm.expectPartialRevert(BlindfoldSettlement.OutsideSettleWindow.selector);
        s.settle(first, Q96);
        _solve(later);
        assertFalse(s.finalized(first));
        s.expire(first);
        assertEq(vault.balanceOf(alice, address(t0)), 1000e18);
        assertEq(vault.openCommitments(alice), 0);
        _assertSolvent();
    }

    function test_ordering_emptyAndUnfinalizedPredecessorsDoNotBlock() public {
        vm.warp(s.revealOpens(20));
        // No queue/cursor: empty old batches need not each be finalized first.
        uint64 b = s.currentBatch();
        BatchAuction.Order memory o = _o(alice, true, 20e18, 0);
        uint256 id = _commit(alice, o, "a");
        vm.warp(s.revealOpens(b));
        s.reveal(id, o, "a");
        vm.warp(s.revealCloses(b));
        _solve(b);
        assertTrue(s.finalized(b));
        assertFalse(s.finalized(0));
        _assertSolvent();
    }
}
