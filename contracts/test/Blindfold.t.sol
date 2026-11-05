// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {BlindfoldVault} from "../src/BlindfoldVault.sol";
import {BatchAuction} from "../src/BatchAuction.sol";
import {BlindfoldSettlement} from "../src/BlindfoldSettlement.sol";
import {SealedPoolHook} from "../src/SealedPoolHook.sol";
import {HookDeployer} from "./utils/HookDeployer.sol";

contract BlindfoldTest is Test {
    uint256 constant Q96 = 1 << 96;
    uint256 constant DEPOSIT = 5e18;
    uint256 constant BOUNTY_BPS = 2_000;
    uint256 constant TOL_BPS = 100;
    uint64 constant T0 = 1_800_000_000;

    IPoolManager manager;
    BlindfoldVault vault;
    BlindfoldSettlement s;
    PoolKey key;
    MockERC20 t0;
    MockERC20 t1;
    PoolModifyLiquidityTest lp;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address keeper = makeAddr("keeper");
    address solver = makeAddr("solver");
    address treasury = makeAddr("treasury");

    function setUp() public {
        manager = _manager();
        vm.warp(T0);
        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        (t0, t1) = address(a) < address(b) ? (a, b) : (b, a);

        vault = new BlindfoldVault();
        s = new BlindfoldSettlement(
            BlindfoldSettlement.Config({
                manager: manager,
                vault: vault,
                depositToken: address(t1),
                depositAmount: DEPOSIT,
                bountyBps: BOUNTY_BPS,
                treasury: treasury,
                schedule: BatchAuction.Schedule({start: T0, batchLength: 30, revealLength: 24, settleLength: 60}),
                toleranceBps: TOL_BPS
            })
        );
        vault.setOperator(address(s));

        (SealedPoolHook hook,) = HookDeployer.deploySealed(address(this), address(manager), address(s));
        key = PoolKey(Currency.wrap(address(t0)), Currency.wrap(address(t1)), 3000, 60, IHooks(address(hook)));
        manager.initialize(key, uint160(Q96));
        s.initialize(key);

        lp = new PoolModifyLiquidityTest(manager);
        t0.mint(address(this), 1e30);
        t1.mint(address(this), 1e30);
        t0.approve(address(lp), type(uint256).max);
        t1.approve(address(lp), type(uint256).max);
        lp.modifyLiquidity(key, IPoolManager.ModifyLiquidityParams(-60_000, 60_000, 1e22, 0), "");

        _fund(alice);
        _fund(bob);
        _fund(carol);
    }

    /// @dev Local PoolManager by default; the fork suite overrides this with Unichain's.
    function _manager() internal virtual returns (IPoolManager) {
        return new PoolManager(address(this));
    }

    // ---- end to end

    function test_batch_settlesAtOneVerifiedPrice() public {
        uint64 b = s.currentBatch();
        uint256 cA = _commit(alice, _o(alice, true, 100e18, 95e18), "a");
        uint256 cB = _commit(bob, _o(bob, false, 50e18, 45e18), "b");
        uint256 cC = _commit(carol, _o(carol, true, 10e18, 20e18), "c"); // limit 2.0: won't fill near 1.0

        vm.prank(keeper);
        vm.expectRevert();
        s.reveal(cA, _o(alice, true, 100e18, 95e18), "a"); // before the drand round

        vm.warp(s.revealOpens(b));
        vm.startPrank(keeper);
        s.reveal(cA, _o(alice, true, 100e18, 95e18), "a");
        s.reveal(cB, _o(bob, false, 50e18, 45e18), "b");
        s.reveal(cC, _o(carol, true, 10e18, 20e18), "c");
        vm.stopPrank();
        assertEq(vault.balanceOf(keeper, address(t1)), 3 * DEPOSIT * BOUNTY_BPS / 10_000);

        vm.warp(s.revealCloses(b));
        uint256 a1 = vault.balanceOf(alice, address(t1));
        uint256 b0 = vault.balanceOf(bob, address(t0));
        uint256 p = _solve(b);

        assertEq(vault.balanceOf(alice, address(t1)) - a1, 100e18 * p / Q96, "alice at p*");
        assertEq(vault.balanceOf(bob, address(t0)) - b0, 50e18 * Q96 / p, "bob at p*");
        assertEq(vault.balanceOf(carol, address(t0)), 1_000e18, "carol unfilled");
        assertEq(vault.lockedOf(carol, address(t0)), 0);
        assertEq(vault.openCommitments(alice) + vault.openCommitments(bob) + vault.openCommitments(carol), 0);
        _assertSolvent();

        vm.prank(alice);
        vault.withdraw(address(t1), 1);
        emit log_named_decimal_uint("clearing price", p * 1e18 / Q96, 18);
    }

    function test_batch_buyHeavySettlesAbovePoolPrice() public {
        uint64 b = s.currentBatch();
        BatchAuction.Order memory sell = _o(alice, true, 50e18, 45e18);
        BatchAuction.Order memory buy = _o(bob, false, 100e18, 95e18);
        uint256 a = _commit(alice, sell, "a");
        uint256 c = _commit(bob, buy, "b");
        vm.warp(s.revealOpens(b));
        s.reveal(a, sell, "a");
        s.reveal(c, buy, "b");
        vm.warp(s.revealCloses(b));
        uint256 beforeBuy = vault.balanceOf(bob, address(t0));
        uint256 p = _solve(b);
        assertGt(p, Q96);
        assertEq(vault.balanceOf(bob, address(t0)) - beforeBuy, 100e18 * Q96 / p);
        assertEq(vault.openCommitments(alice) + vault.openCommitments(bob), 0);
        _assertSolvent();
    }

    function test_batch_maxCommitmentsSettle() public {
        uint64 b = s.currentBatch();
        BatchAuction.Order memory o = _o(alice, true, 1e18, 0);
        for (uint256 i; i < s.MAX_COMMITS(); i++) {
            _commit(alice, o, bytes32(i));
        }
        vm.prank(alice);
        vm.expectRevert(BatchAuction.BatchFull.selector);
        s.commit(b, bytes32(0), "");
        vm.warp(s.revealOpens(b));
        for (uint256 i; i < s.MAX_COMMITS(); i++) s.reveal(i, o, bytes32(i));
        vm.warp(s.revealCloses(b));
        _solve(b);
        assertEq(vault.openCommitments(alice), 0);
        assertEq(vault.lockedOf(alice, address(t0)), 0);
        _assertSolvent();
    }

    function test_failedSettlement_preservesFundsAndCanExpire() public {
        uint64 b = _twoSided();
        uint256 balance = vault.balanceOf(alice, address(t0));
        vm.expectRevert();
        s.settle(b, Q96);
        assertFalse(s.finalized(b));
        assertEq(s.clearingPriceX96(b), 0);
        assertEq(s.activeClearingPriceX96(address(t0), address(t1)), 0);
        assertEq(vault.balanceOf(alice, address(t0)), balance);
        assertEq(vault.lockedOf(alice, address(t0)), 100e18);
        assertEq(vault.openCommitments(alice), 1);
        vm.warp(s.settleCloses(b));
        s.expire(b);
        assertEq(vault.lockedOf(alice, address(t0)), 0);
        assertEq(vault.openCommitments(alice), 0);
        _assertSolvent();
    }

    function test_expireAndSlash_clearMixedCommitments() public {
        uint64 b = s.currentBatch();
        BatchAuction.Order memory o = _o(alice, true, 10e18, 1);
        uint256 revealed = _commit(alice, o, "a");
        uint256 unrevealed = _commit(alice, o, "b");
        vm.warp(s.revealOpens(b));
        s.reveal(revealed, o, "a");
        vm.warp(s.settleCloses(b));
        s.expire(b);
        assertEq(vault.openCommitments(alice), 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BlindfoldVault.OpenCommitments.selector, alice, 1));
        vault.withdraw(address(t0), 1);
        vm.prank(keeper);
        s.slashUnrevealed(unrevealed);
        assertEq(vault.openCommitments(alice), 0);
        vm.prank(alice);
        vault.withdraw(address(t0), 1_000e18);
        _assertSolvent();
    }

    function test_liquidityRemovedAfterReveal_canExpire() public {
        uint64 b = _twoSided();
        lp.modifyLiquidity(key, IPoolManager.ModifyLiquidityParams(-60_000, 60_000, -1e22, 0), "");
        vm.expectRevert();
        s.settle(b, Q96);
        assertFalse(s.finalized(b));
        assertEq(vault.lockedOf(alice, address(t0)), 100e18);
        vm.warp(s.settleCloses(b));
        s.expire(b);
        assertEq(vault.openCommitments(alice) + vault.openCommitments(bob), 0);
        _assertSolvent();
    }

    function test_tightLimits_unfilledOrdersKeepTheirInputs() public {
        uint64 b = s.currentBatch();
        BatchAuction.Order memory sell = _o(alice, true, 10e18, 10e18 + 1);
        BatchAuction.Order memory buy = _o(bob, false, 10e18, 10e18 + 1);
        uint256 a = _commit(alice, sell, "a");
        uint256 c = _commit(bob, buy, "b");
        vm.warp(s.revealOpens(b));
        s.reveal(a, sell, "a");
        s.reveal(c, buy, "b");
        uint256 a0 = vault.balanceOf(alice, address(t0));
        uint256 b1 = vault.balanceOf(bob, address(t1));
        vm.warp(s.revealCloses(b));
        s.settle(b, Q96);
        assertEq(vault.balanceOf(alice, address(t0)), a0);
        assertEq(vault.balanceOf(bob, address(t1)), b1);
        assertEq(vault.lockedOf(alice, address(t0)), 0);
        assertEq(vault.lockedOf(bob, address(t1)), 0);
        assertEq(vault.openCommitments(alice) + vault.openCommitments(bob), 0);
        _assertSolvent();
    }

    // ---- reveal

    function test_reveal_checksHashAndOwner() public {
        uint64 b = s.currentBatch();
        uint256 c = _commit(alice, _o(alice, true, 10e18, 1), "a");
        bytes32 h = s.orderHash(b, _o(alice, true, 10e18, 1), "x");
        vm.prank(bob);
        uint256 forged = s.commit(b, h, ""); // bob commits an order spending alice's funds

        vm.warp(s.revealOpens(b));
        vm.expectRevert(BatchAuction.HashMismatch.selector);
        s.reveal(c, _o(alice, true, 10e18, 1), "wrong");
        vm.expectRevert(BatchAuction.OwnerMismatch.selector);
        s.reveal(forged, _o(alice, true, 10e18, 1), "x");
        s.reveal(c, _o(alice, true, 10e18, 1), "a");
        vm.expectRevert(abi.encodeWithSelector(BatchAuction.BadStatus.selector, c));
        s.reveal(c, _o(alice, true, 10e18, 1), "a");
    }

    function test_reveal_windowCloses() public {
        uint64 b = s.currentBatch();
        uint256 c = _commit(alice, _o(alice, true, 10e18, 1), "a");
        vm.warp(s.revealCloses(b));
        vm.expectRevert();
        s.reveal(c, _o(alice, true, 10e18, 1), "a");
    }

    function test_commit_currentBatchOnly_roundAfterClose() public {
        uint64 b = s.currentBatch();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BatchAuction.NotCurrentBatch.selector, b + 1, b));
        s.commit(b + 1, bytes32(0), "");
        assertGe(s.revealOpens(b), s.commitsClose(b) + 6);
        assertLt(s.revealOpens(b), s.commitsClose(b) + 9);
    }

    function test_paddingOrder_isNoOp() public {
        uint64 b = s.currentBatch();
        uint256 c = _commit(alice, _o(alice, true, 0, 0), "pad");
        vm.warp(s.revealOpens(b));
        vm.prank(keeper);
        s.reveal(c, _o(alice, true, 0, 0), "pad");
        assertEq(vault.openCommitments(alice), 0);
        assertEq(s.orderIdsOf(b).length, 0);
    }

    // ---- slashing

    function test_slash_unrevealedCommitment() public {
        uint64 b = s.currentBatch();
        vm.prank(carol);
        uint256 c = s.commit(b, keccak256("garbage"), hex"deadbeef");
        vm.warp(s.revealOpens(b));
        vm.expectRevert(abi.encodeWithSelector(BatchAuction.RevealWindowOpen.selector, s.revealCloses(b)));
        s.slashUnrevealed(c);
        vm.warp(s.revealCloses(b));
        vm.prank(keeper);
        s.slashUnrevealed(c);
        assertEq(vault.balanceOf(carol, address(t1)), 1_000e18 - DEPOSIT);
        assertEq(vault.balanceOf(keeper, address(t1)), DEPOSIT * BOUNTY_BPS / 10_000);
        assertEq(vault.balanceOf(treasury, address(t1)), DEPOSIT - DEPOSIT * BOUNTY_BPS / 10_000);
        assertEq(vault.openCommitments(carol), 0);
    }

    function test_slash_unfundedReveal() public {
        uint64 b = s.currentBatch();
        uint256 c = _commit(alice, _o(alice, true, 5_000e18, 1), "a");
        vm.warp(s.revealOpens(b));
        s.reveal(c, _o(alice, true, 5_000e18, 1), "a");
        assertEq(vault.balanceOf(alice, address(t1)), 1_000e18 - DEPOSIT);
        assertEq(s.orderIdsOf(b).length, 0);
    }

    // ---- no free option

    function test_withdraw_blockedWhileCommitmentOpen() public {
        uint64 b = s.currentBatch();
        uint256 c = _commit(alice, _o(alice, true, 100e18, 1), "a");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BlindfoldVault.OpenCommitments.selector, alice, 1));
        vault.withdraw(address(t0), 100e18);
        vm.warp(s.revealOpens(b));
        s.reveal(c, _o(alice, true, 100e18, 1), "a");
        assertEq(vault.lockedOf(alice, address(t0)), 100e18);
    }

    function test_expire_unlocks() public {
        uint64 b = s.currentBatch();
        uint256 c = _commit(alice, _o(alice, true, 100e18, 1), "a");
        vm.warp(s.revealOpens(b));
        s.reveal(c, _o(alice, true, 100e18, 1), "a");
        vm.expectRevert();
        s.expire(b);
        vm.warp(s.settleCloses(b));
        vm.expectRevert();
        s.settle(b, Q96);
        s.expire(b);
        assertEq(vault.lockedOf(alice, address(t0)), 0);
        vm.prank(alice);
        vault.withdraw(address(t0), 1_000e18);
    }

    // ---- price verification

    function test_settle_rejectsBadPrices() public {
        uint64 b = _twoSided();
        vm.expectRevert(); // 10% below market: not the marginal price
        s.settle(b, Q96 * 90 / 100);
        vm.expectRevert(); // too generous: residual can't pay
        s.settle(b, Q96);
        vm.expectRevert();
        s.settle(b, Q96 * 110 / 100);
        _solve(b);
        vm.expectRevert(abi.encodeWithSelector(BlindfoldSettlement.Finalized.selector, b));
        s.settle(b, Q96 * 99 / 100);
    }

    function test_settle_notBeforeRevealsClose() public {
        uint64 b = s.currentBatch();
        _commit(alice, _o(alice, true, 1e18, 1), "a");
        vm.warp(s.revealOpens(b));
        vm.expectRevert();
        s.settle(b, Q96);
    }

    // ---- sealed pool

    function test_sealedPool_rejectsOutsiders() public {
        PoolSwapTest bot = new PoolSwapTest(manager);
        t0.approve(address(bot), type(uint256).max);
        vm.expectRevert();
        bot.swap(
            key,
            IPoolManager.SwapParams(true, -1e18, TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    function test_activePrice_zeroOutsideSettlement() public view {
        assertEq(s.activeClearingPriceX96(address(t0), address(t1)), 0);
    }

    // ---- helpers

    function _twoSided() internal returns (uint64 b) {
        b = s.currentBatch();
        uint256 cA = _commit(alice, _o(alice, true, 100e18, 95e18), "a");
        uint256 cB = _commit(bob, _o(bob, false, 50e18, 45e18), "b");
        vm.warp(s.revealOpens(b));
        s.reveal(cA, _o(alice, true, 100e18, 95e18), "a");
        s.reveal(cB, _o(bob, false, 50e18, 45e18), "b");
        vm.warp(s.revealCloses(b));
    }

    /// @dev Test-only bounded search in both directions; not a production price solver.
    function _solve(uint64 b) internal returns (uint256 p) {
        uint256 pool = s.poolPriceX96();
        for (uint256 k; k <= TOL_BPS; k++) {
            p = pool * (10_000 - k) / 10_000;
            vm.prank(solver);
            try s.settle(b, p) {
                return p;
            } catch {}
            if (k == 0) continue;
            p = pool * (10_000 + k) / 10_000;
            vm.prank(solver);
            try s.settle(b, p) {
                return p;
            } catch {}
        }
        revert("no price");
    }

    function _assertSolvent() internal view {
        address[8] memory acc = [alice, bob, carol, keeper, solver, treasury, address(s), address(this)];
        MockERC20[2] memory toks = [t0, t1];
        for (uint256 j; j < 2; j++) {
            uint256 sum;
            for (uint256 i; i < acc.length; i++) sum += vault.balanceOf(acc[i], address(toks[j]));
            assertEq(sum, toks[j].balanceOf(address(vault)), "vault invariant");
        }
    }

    function _o(address owner, bool z, uint256 amt, uint256 minOut) internal pure returns (BatchAuction.Order memory) {
        return BatchAuction.Order(owner, z, uint128(amt), uint128(minOut));
    }

    function _commit(address user, BatchAuction.Order memory o, bytes32 salt) internal returns (uint256) {
        uint64 b = s.currentBatch();
        bytes32 h = s.orderHash(b, o, salt);
        vm.prank(user);
        return s.commit(b, h, "tlock-ciphertext");
    }

    function _fund(address u) internal {
        t0.mint(u, 1_000e18);
        t1.mint(u, 1_000e18);
        vm.startPrank(u);
        t0.approve(address(vault), 1_000e18);
        t1.approve(address(vault), 1_000e18);
        vault.deposit(address(t0), 1_000e18);
        vault.deposit(address(t1), 1_000e18);
        vm.stopPrank();
    }
}
