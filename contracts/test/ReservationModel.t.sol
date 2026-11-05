// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BlindfoldTest} from "./Blindfold.t.sol";
import {Test} from "forge-std/Test.sol";
import {BatchAuction} from "../src/BatchAuction.sol";
import {BlindfoldSettlement} from "../src/BlindfoldSettlement.sol";
import {BlindfoldVault} from "../src/BlindfoldVault.sol";

/// @dev TEST MODEL ONLY. Witnesses are plaintext and vm.prank forwards the owner.
/// Models the funding relation, not encryption, ZK soundness, or production access control.
/// Accepted admissions exercise the unchanged auction's actual commit/reveal/cleanup.
contract ReservationAdmissionModel is Test {
    struct Witness {
        uint256 old0;
        uint256 old1;
        bytes32 oldBlind;
        bytes32 newBlind;
        uint256 budget0;
        uint256 budget1;
        uint256 step;
    }

    BlindfoldSettlement immutable settlement;
    BlindfoldVault immutable vault;
    mapping(address => uint64) public activeBatch;
    mapping(address => bytes32) public root;

    constructor(BlindfoldSettlement s) {
        settlement = s;
        vault = s.vault();
    }

    function digest(address owner, uint64 batch, uint256 total0, uint256 total1, bytes32 blind, uint256 step)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(settlement), owner, batch, total0, total1, blind, step));
    }

    function admit(uint64 batch, BatchAuction.Order calldata o, bytes32 salt, Witness calldata w)
        external
        returns (uint256 id)
    {
        require(batch == settlement.currentBatch(), "batch");
        uint256 step = vault.openCommitments(o.owner);
        require(w.step == step, "stale step");
        if (step == 0) {
            require(w.old0 == 0 && w.old1 == 0 && w.oldBlind == 0, "initial totals");
        } else {
            require(activeBatch[o.owner] == batch, "active batch");
            require(root[o.owner] == digest(o.owner, batch, w.old0, w.old1, w.oldBlind, step), "stale root");
        }
        // Canonical unsigned integer arithmetic, not unchecked field arithmetic.
        uint256 next0 = w.old0 + (o.zeroForOne ? o.amountIn : 0);
        uint256 next1 = w.old1 + (o.zeroForOne ? 0 : o.amountIn);
        require(next0 <= w.budget0 && next1 <= w.budget1, "funding");
        address t0 = settlement.token0();
        address t1 = settlement.token1();
        uint256 free0 = vault.freeBalance(o.owner, t0);
        uint256 free1 = vault.freeBalance(o.owner, t1);
        // Conservative: never count future deposit refunds or swap outputs.
        if (settlement.depositToken() == t0) free0 -= settlement.depositAmount();
        if (settlement.depositToken() == t1) free1 -= settlement.depositAmount();
        require(w.budget0 <= free0 && w.budget1 <= free1, "budget");
        activeBatch[o.owner] = batch;
        root[o.owner] = digest(o.owner, batch, next0, next1, w.newBlind, step + 1);
        bytes32 hash = settlement.orderHash(batch, o, salt);
        vm.prank(o.owner);
        id = settlement.commit(batch, hash, "MODEL: no encryption proof");
    }
}

contract ReservationModelTest is BlindfoldTest {
    ReservationAdmissionModel model;

    function setUp() public override {
        super.setUp();
        model = new ReservationAdmissionModel(s);
    }

    function _w(uint256 a, uint256 b, bytes32 oldBlind, bytes32 nextBlind, uint256 x, uint256 y)
        internal
        view
        returns (ReservationAdmissionModel.Witness memory)
    {
        return ReservationAdmissionModel.Witness(a, b, oldBlind, nextBlind, x, y, vault.openCommitments(alice));
    }

    function test_model_rejectsAggregateOverspending() public {
        uint64 batch = s.currentBatch();
        model.admit(batch, _o(alice, true, 600e18, 1), "a", _w(0, 0, 0, "r1", 1000e18, 0));
        bytes32 root = model.root(alice);
        uint256 balance = vault.balanceOf(alice, address(t1));
        ReservationAdmissionModel.Witness memory rejected = _w(600e18, 0, "r1", "r2", 1000e18, 0);
        vm.expectRevert("funding");
        model.admit(batch, _o(alice, true, 401e18, 1), "b", rejected);
        assertEq(model.root(alice), root);
        assertEq(s.commitCount(), 1);
        assertEq(vault.balanceOf(alice, address(t1)), balance);
    }

    function test_model_firstCommitCannotInventPriorTotals() public {
        uint64 batch = s.currentBatch();
        ReservationAdmissionModel.Witness memory rejected = _w(1, 0, 0, "r1", 2, 0);
        vm.expectRevert("initial totals");
        model.admit(batch, _o(alice, true, 1, 0), "a", rejected);
        assertEq(s.commitCount(), 0);
    }

    function test_model_paddingStillAdvancesStateVersion() public {
        uint64 batch = s.currentBatch();
        BatchAuction.Order memory o = _o(alice, true, 0, 0);
        model.admit(batch, o, "a", _w(0, 0, 0, "same", 0, 0));
        bytes32 first = model.root(alice);
        ReservationAdmissionModel.Witness memory prepared = _w(0, 0, "same", "same", 0, 0);
        model.admit(batch, o, "a", prepared);
        assertNotEq(first, model.root(alice));
        assertEq(vault.openCommitments(alice), 2);
        vm.expectRevert("stale step");
        model.admit(batch, o, "a", prepared);
    }

    function test_model_failedAuctionAdmissionRollsBackPrivateState() public {
        uint64 batch = s.currentBatch();
        for (uint256 i; i < 64; i++) {
            _commit(bob, _o(bob, true, 0, 0), bytes32(i));
        }
        uint256 beforeBalance = vault.balanceOf(alice, address(t1));
        ReservationAdmissionModel.Witness memory rejected = _w(0, 0, 0, "r1", 1, 0);
        vm.expectRevert(BatchAuction.BatchFull.selector);
        model.admit(batch, _o(alice, true, 1, 0), "a", rejected);
        assertEq(model.root(alice), 0);
        assertEq(vault.openCommitments(alice), 0);
        assertEq(vault.balanceOf(alice, address(t1)), beforeBalance);
    }

    function test_model_newDepositCannotSpendPreviouslyReservedFunds() public {
        uint64 batch = s.currentBatch();
        // One USDC-input order reserves all funds left after the first deposit.
        model.admit(batch, _o(alice, false, 995e18, 1), "a", _w(0, 0, 0, "r1", 0, 995e18));
        ReservationAdmissionModel.Witness memory rejected = _w(0, 995e18, "r1", "r2", 0, 995e18);
        vm.expectRevert("budget");
        model.admit(batch, _o(alice, true, 0, 0), "b", rejected);
        assertEq(s.commitCount(), 1);
    }

    function test_model_competingProofStaleButTopupAllowed() public {
        uint64 batch = s.currentBatch();
        model.admit(batch, _o(alice, true, 100e18, 1), "a", _w(0, 0, 0, "r1", 100e18, 0));
        ReservationAdmissionModel.Witness memory rejected = _w(0, 0, 0, "other", 100e18, 0);
        vm.expectRevert("stale root");
        model.admit(batch, _o(alice, true, 100e18, 1), "b", rejected);
        t0.mint(alice, 1e18);
        vm.startPrank(alice);
        t0.approve(address(vault), 1e18);
        vault.deposit(address(t0), 1e18);
        vm.stopPrank();
        model.admit(batch, _o(alice, true, 100e18, 1), "b", _w(100e18, 0, "r1", "r2", 200e18, 0));
        assertEq(vault.openCommitments(alice), 2);
    }

    function test_model_blocksOverlappingBatchUntilCleanup() public {
        uint64 batch = s.currentBatch();
        model.admit(batch, _o(alice, true, 10e18, 1), "a", _w(0, 0, 0, "r1", 10e18, 0));
        vm.warp(s.commitsClose(batch));
        uint64 overlapping = s.currentBatch();
        ReservationAdmissionModel.Witness memory rejected = _w(10e18, 0, "r1", "r2", 11e18, 0);
        vm.expectRevert("active batch");
        model.admit(overlapping, _o(alice, true, 1e18, 1), "b", rejected);
        vm.warp(s.revealCloses(batch));
        s.slashUnrevealed(0);
        uint64 nextBatch = s.currentBatch();
        model.admit(nextBatch, _o(alice, true, 1e18, 1), "c", _w(0, 0, 0, "new", 1e18, 0));
        assertEq(model.activeBatch(alice), nextBatch);
        assertEq(vault.openCommitments(alice), 1);
    }

    function test_model_mixedCleanupDoesNotReleaseAccountEarly() public {
        uint64 batch = s.currentBatch();
        BatchAuction.Order memory o = _o(alice, true, 10e18, 1);
        model.admit(batch, o, "a", _w(0, 0, 0, "r1", 10e18, 0));
        model.admit(batch, o, "b", _w(10e18, 0, "r1", "r2", 20e18, 0));
        vm.warp(s.revealOpens(batch));
        s.reveal(0, o, "a");
        vm.warp(s.revealCloses(batch));
        s.slashUnrevealed(1);
        uint64 overlapping = s.currentBatch();
        ReservationAdmissionModel.Witness memory rejected = _w(20e18, 0, "r2", "r3", 30e18, 0);
        vm.expectRevert("active batch");
        model.admit(overlapping, o, "c", rejected);
        vm.warp(s.settleCloses(batch));
        s.expire(batch);
        model.admit(s.currentBatch(), o, "c", _w(0, 0, 0, "new", 10e18, 0));
    }

    function test_model_oneSidedFundingSettlesAndStartsNextBatch() public {
        vm.prank(alice);
        vault.withdraw(address(t0), 1000e18);
        uint64 batch = s.currentBatch();
        BatchAuction.Order memory a = _o(alice, false, 10e18, 1);
        BatchAuction.Order memory b = _o(alice, false, 20e18, 1);
        model.admit(batch, a, "a", _w(0, 0, 0, "r1", 0, 995e18));
        model.admit(batch, b, "b", _w(0, 10e18, "r1", "r2", 0, 990e18));
        assertEq(vault.balanceOf(alice, address(t0)), 0);
        vm.warp(s.revealOpens(batch));
        s.reveal(1, b, "b");
        s.reveal(0, a, "a");
        vm.warp(s.revealCloses(batch));
        _solve(batch);
        assertEq(vault.openCommitments(alice), 0);
        assertGt(vault.balanceOf(alice, address(t0)), 0);
        uint64 next = s.currentBatch();
        assertGt(next, batch);
        model.admit(next, a, "next", _w(0, 0, 0, "new", 0, 10e18));
        assertEq(model.activeBatch(alice), next);
        _assertSolvent();
    }

    function testFuzz_model_allRevealsFundedRegardlessOfOrder(uint128 x, uint128 y, uint128 z, uint8 permutation)
        public
    {
        uint64 batch = s.currentBatch();
        uint128 a = uint128(bound(x, 1, 500e18));
        uint128 b = uint128(bound(y, 1, 500e18));
        uint128 c = uint128(bound(z, 1, 985e18));
        BatchAuction.Order[3] memory os = [_o(alice, true, a, 1), _o(alice, true, b, 1), _o(alice, false, c, 1)];
        model.admit(batch, os[0], bytes32(uint256(0)), _w(0, 0, 0, "r1", a, 0));
        model.admit(batch, os[1], bytes32(uint256(1)), _w(a, 0, "r1", "r2", uint256(a) + b, 0));
        model.admit(batch, os[2], bytes32(uint256(2)), _w(uint256(a) + b, 0, "r2", "r3", uint256(a) + b, c));
        vm.warp(s.revealOpens(batch));
        for (uint256 i; i < 3; i++) {
            uint256 id = permutation % 2 == 0 ? (i + permutation / 2) % 3 : (2 - i + permutation / 2) % 3;
            vm.prank(keeper);
            s.reveal(id, os[id], bytes32(id));
        }
        assertEq(s.orderIdsOf(batch).length, 3);
        assertEq(vault.lockedOf(alice, address(t0)), uint256(a) + b);
        assertEq(vault.lockedOf(alice, address(t1)), c);
        vm.warp(s.settleCloses(batch));
        s.expire(batch);
        assertEq(vault.openCommitments(alice), 0);
        _assertSolvent();
    }
}
