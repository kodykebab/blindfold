// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {BlindfoldVault} from "../src/BlindfoldVault.sol";
import {BatchAuction} from "../src/BatchAuction.sol";
import {BlindfoldSettlement} from "../src/BlindfoldSettlement.sol";

/// Stands in for the admission entry point (REVIEW R2) only to select the unrevealed-commitment policy.
contract AdmittedSettlement is BlindfoldSettlement {
    constructor(Config memory c) BlindfoldSettlement(c) {}

    function admissionRequired() public pure override returns (bool) {
        return true;
    }
}

/// REVIEW S3 (commit fee), R7 (schedule alignment, sequencer timestamps) and S9 (unrevealed commitments).
/// No pool is needed: commit, reveal, slash/release and expire never touch the PoolManager.
contract FeesAndTimingTest is Test {
    uint256 constant G = 1692803367; // drand quicknet genesis
    uint64 constant T0 = 1_800_000_000; // T0 - G = 107,196,633 = 3 * 35,732,211
    uint256 constant DEPOSIT = 5e18;
    uint256 constant FEE = 1e17; // PLAN.md COMMIT_FEE default
    uint256 constant BOUNTY_BPS = 2_000;
    uint256 constant BOUNTY = DEPOSIT * BOUNTY_BPS / 10_000;

    BlindfoldVault vault;
    MockERC20 t0;
    MockERC20 t1;
    address alice = makeAddr("alice");
    address mallory = makeAddr("mallory");
    address keeper = makeAddr("keeper");
    address treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(T0);
        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        (t0, t1) = address(a) < address(b) ? (a, b) : (b, a);
    }

    function _config(uint64 start, uint32 batchLength) internal returns (BlindfoldSettlement.Config memory) {
        vault = new BlindfoldVault();
        return BlindfoldSettlement.Config({
            manager: IPoolManager(address(0xdead)),
            vault: vault,
            depositToken: address(t1),
            depositAmount: DEPOSIT,
            bountyBps: BOUNTY_BPS,
            treasury: treasury,
            commitFee: FEE,
            schedule: BatchAuction.Schedule({
                start: start, batchLength: batchLength, revealLength: 24, settleLength: 60
            }),
            toleranceBps: 100
        });
    }

    function _fund(address who, uint256 amount) internal {
        t0.mint(who, amount);
        t1.mint(who, amount);
        vm.startPrank(who);
        t0.approve(address(vault), type(uint256).max);
        t1.approve(address(vault), type(uint256).max);
        vault.deposit(address(t0), amount);
        vault.deposit(address(t1), amount);
        vm.stopPrank();
    }

    function _settlement(bool admitted) internal returns (BlindfoldSettlement s) {
        BlindfoldSettlement.Config memory c = _config(T0, 30);
        s = admitted ? new AdmittedSettlement(c) : new BlindfoldSettlement(c);
        vault.setOperator(address(s));
        s.initialize(PoolKey(Currency.wrap(address(t0)), Currency.wrap(address(t1)), 3000, 60, IHooks(address(0))));
        _fund(alice, 100e18);
    }

    function _status(BlindfoldSettlement s, uint256 id) internal view returns (BatchAuction.Status st) {
        (,, st,) = s.commitments(id);
    }

    function _commit(BlindfoldSettlement s, address who, BatchAuction.Order memory o, bytes32 salt)
        internal
        returns (uint256 id)
    {
        uint64 b = s.currentBatch();
        bytes32 h = s.orderHash(b, o, salt); // outside the prank, which the next external call takes
        vm.prank(who);
        id = s.commit(b, h, hex"00");
    }

    // ---- S3: commit fee

    /// Padding pays the fee too, and revealing your own commitment returns the deposit but never the fee.
    function test_S3_feeOnEveryCommit_selfRevealKeepsIt() public {
        BlindfoldSettlement s = _settlement(false);
        assertEq(s.commitFee(), FEE);
        BatchAuction.Order memory pad = BatchAuction.Order(alice, true, 0, 0);
        uint256 id = _commit(s, alice, pad, "p");
        assertEq(vault.balanceOf(treasury, address(t1)), FEE, "fee at commit");
        assertEq(vault.balanceOf(alice, address(t1)), 100e18 - FEE - DEPOSIT);

        vm.warp(s.revealOpens(s.currentBatch()));
        vm.prank(alice);
        s.reveal(id, pad, "p");
        assertEq(vault.balanceOf(alice, address(t1)), 100e18 - FEE, "deposit and bounty back, fee not");
        assertEq(vault.balanceOf(treasury, address(t1)), FEE);
        assertEq(vault.openCommitments(alice), 0);
    }

    /// The fee leaves the reveal bounty and the deposit refund unchanged.
    function test_S3_feeLeavesBountyAndRefundIntact() public {
        BlindfoldSettlement s = _settlement(false);
        BatchAuction.Order memory o = BatchAuction.Order(alice, true, 10e18, 1);
        uint256 id = _commit(s, alice, o, "o");
        vm.warp(s.revealOpens(s.currentBatch()));
        vm.prank(keeper);
        s.reveal(id, o, "o");
        assertEq(vault.balanceOf(keeper, address(t1)), BOUNTY);
        assertEq(vault.balanceOf(alice, address(t1)), 100e18 - FEE - BOUNTY);
        assertEq(vault.balanceOf(treasury, address(t1)), FEE);
    }

    function test_S3_cannotCommitWithoutTheFee() public {
        BlindfoldSettlement s = _settlement(false);
        address poor = makeAddr("poor");
        _fund(poor, DEPOSIT); // the deposit but not the fee
        uint64 b = s.currentBatch();
        vm.prank(poor);
        // the fee goes first, then the deposit no longer fits; the whole commit reverts
        vm.expectRevert(
            abi.encodeWithSelector(BlindfoldVault.Insufficient.selector, poor, address(t1), DEPOSIT - FEE, DEPOSIT)
        );
        s.commit(b, keccak256("x"), hex"00");
    }

    /// REVIEW R3 flipped: filling all 64 slots and self-revealing every padding order used to cost nothing but gas.
    /// It now costs exactly 64 * commitFee, and honest users are locked out only for that price.
    function test_S3_stuffingTheBatchCosts64Fees() public {
        BlindfoldSettlement s = _settlement(false);
        _fund(mallory, 1_000e18);
        uint256 n = s.MAX_COMMITS();
        BatchAuction.Order memory pad = BatchAuction.Order(mallory, true, 0, 0);
        uint256[] memory ids = new uint256[](n);
        uint256 gasBefore = gasleft();
        for (uint256 i; i < n; i++) {
            ids[i] = _commit(s, mallory, pad, bytes32(i));
        }
        uint256 commitGas = gasBefore - gasleft();

        uint64 b = s.currentBatch();
        vm.prank(alice);
        vm.expectRevert(BatchAuction.BatchFull.selector);
        s.commit(b, keccak256("honest"), hex"00");

        vm.warp(s.revealOpens(b));
        vm.startPrank(mallory);
        for (uint256 i; i < n; i++) {
            s.reveal(ids[i], pad, bytes32(i));
        }
        vm.stopPrank();

        assertEq(vault.balanceOf(mallory, address(t1)), 1_000e18 - n * FEE, "attacker's only loss is 64 fees");
        assertEq(vault.balanceOf(treasury, address(t1)), n * FEE);
        assertEq(vault.openCommitments(mallory), 0);
        emit log_named_decimal_uint("cost to fill a batch, in deposit token", n * FEE, 18);
        emit log_named_uint("gas for 64 padding commits (test harness)", commitGas);
    }

    // ---- R7: alignment

    function test_R7_misalignedStartReverts() public {
        for (uint64 off = 1; off < 3; off++) {
            BlindfoldSettlement.Config memory c = _config(T0 + off, 30);
            vm.expectRevert(abi.encodeWithSelector(BatchAuction.MisalignedSchedule.selector, T0 + off, uint32(30)));
            new BlindfoldSettlement(c);
        }
    }

    function test_R7_misalignedBatchLengthReverts() public {
        for (uint32 len = 31; len < 33; len++) {
            BlindfoldSettlement.Config memory c = _config(T0, len);
            vm.expectRevert(abi.encodeWithSelector(BatchAuction.MisalignedSchedule.selector, T0, len));
            new BlindfoldSettlement(c);
        }
    }

    /// Every aligned schedule publishes every batch's key exactly 6 s after its commits close (was 4-6 s).
    function testFuzz_R7_marginIsAlwaysSixSeconds(uint32 k, uint16 lenRounds, uint32 batch) public {
        uint64 start = uint64(G + 3 * uint256(bound(k, 0, 1e8)));
        uint32 len = uint32(3 * bound(lenRounds, 1, 1000));
        BlindfoldSettlement s = new BlindfoldSettlement(_config(start, len));
        uint64 b = uint64(bound(batch, 0, 1e6));
        assertEq(s.revealOpens(b) - s.commitsClose(b), 6);
        assertEq(s.roundTime(s.targetRound(b)), s.commitsClose(b) + 6);
    }

    /// The trust R7 leaves: the contract sees only block.timestamp. A commit in the last second of the window is
    /// accepted although the key is out 6 s later in real time, so sequencer timestamps lagging real time by 6 s or
    /// more let a commit land after the batch's key is public.
    function test_R7_sequencerStall_commitJudgedOnChainTimeOnly() public {
        BlindfoldSettlement s = _settlement(false);
        uint64 b = s.currentBatch();
        vm.warp(s.commitsClose(b) - 1);
        vm.prank(alice);
        s.commit(b, keccak256("late"), hex"00");
        assertEq(s.revealOpens(b) - block.timestamp, 7);
        vm.warp(s.commitsClose(b));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BatchAuction.NotCurrentBatch.selector, b, b + 1));
        s.commit(b, keccak256("too late"), hex"00");
    }

    // ---- S9: unrevealed commitments

    function test_S9_admissionOff_unrevealedIsSlashed() public {
        BlindfoldSettlement s = _settlement(false);
        assertFalse(s.admissionRequired());
        uint64 b = s.currentBatch();
        vm.prank(alice);
        uint256 id = s.commit(b, keccak256("x"), hex"00");
        vm.warp(s.revealCloses(b));
        vm.prank(keeper);
        s.slashUnrevealed(id);
        assertEq(uint8(_status(s, id)), uint8(BatchAuction.Status.Slashed));
        assertEq(vault.balanceOf(alice, address(t1)), 100e18 - FEE - DEPOSIT);
        assertEq(vault.balanceOf(keeper, address(t1)), BOUNTY);
        assertEq(vault.balanceOf(treasury, address(t1)), FEE + DEPOSIT - BOUNTY);
    }

    /// Late drand round, late reveal transaction or no keeper: with admission enforced none of them costs the owner
    /// more than the fee already paid.
    function test_S9_admitted_unrevealedIsReleased() public {
        BlindfoldSettlement s = _settlement(true);
        uint64 b = s.currentBatch();
        vm.prank(alice);
        uint256 id = s.commit(b, keccak256("valid, funded, never revealed"), hex"00");

        vm.warp(s.revealCloses(b) - 1);
        vm.expectRevert(abi.encodeWithSelector(BatchAuction.RevealWindowOpen.selector, s.revealCloses(b)));
        s.slashUnrevealed(id);

        // a reveal arriving after the window (inclusion delay) still reverts; release is the way out
        vm.warp(s.revealCloses(b));
        vm.expectRevert();
        s.reveal(id, BatchAuction.Order(alice, true, 1e18, 1), bytes32(0));

        vm.expectEmit(true, true, true, true, address(s));
        emit BatchAuction.Released(id, b, keeper);
        vm.prank(keeper);
        s.slashUnrevealed(id);
        assertEq(uint8(_status(s, id)), uint8(BatchAuction.Status.Released));
        assertEq(vault.balanceOf(alice, address(t1)), 100e18 - FEE, "deposit back, fee kept");
        assertEq(vault.balanceOf(keeper, address(t1)), 0, "no bounty without a reveal");
        assertEq(vault.balanceOf(treasury, address(t1)), FEE);
        assertEq(vault.openCommitments(alice), 0);

        vm.expectRevert(abi.encodeWithSelector(BatchAuction.BadStatus.selector, id));
        s.slashUnrevealed(id);
        vm.prank(alice);
        vault.withdraw(address(t0), 100e18);
    }

    /// Hard-deadline recovery under the admitted policy: a revealed order nobody settles unlocks through expire.
    function test_S9_admitted_revealedUnsettledExpiresAtHardDeadline() public {
        BlindfoldSettlement s = _settlement(true);
        BatchAuction.Order memory o = BatchAuction.Order(alice, true, 10e18, 1);
        uint256 id = _commit(s, alice, o, "s");
        uint64 b = s.currentBatch();
        vm.warp(s.revealOpens(b));
        vm.prank(keeper);
        s.reveal(id, o, "s");
        assertEq(vault.lockedOf(alice, address(t0)), 10e18);

        vm.warp(s.settleCloses(b) - 1);
        vm.expectRevert(abi.encodeWithSelector(BlindfoldSettlement.NotExpired.selector, s.settleCloses(b)));
        s.expire(b);
        vm.warp(s.settleCloses(b));
        s.expire(b);
        assertEq(vault.lockedOf(alice, address(t0)), 0);
        assertEq(vault.openCommitments(alice), 0);
    }
}
