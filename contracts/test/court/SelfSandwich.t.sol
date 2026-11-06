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
import {feeCappedBudget} from "../../src/court/BondRegistry.sol";

/// @notice R8's economic model, run on a real v4 PoolManager. A coalition plays attacker and victim: fronts that pay
///         WETH (token0) for X, its own victim swap, then backs that sell X. It is paid the most BondRegistry would
///         pay: incidents pair fronts with backs one-to-one, each pays `feeCappedBudget(profit, frontIn, fee)`, and
///         the coalition picks the best pairing the verifier accepts. The same net holdings are then reached by one
///         direct trade from the same pool. The payout must stay below what the sandwich route cost extra, or faking
///         sandwiches would pay.
///         Stated assumptions: the coalition earns none of the LP fees (third-party liquidity, listed pool, static
///         fee), and gas costs nothing (it only adds to the coalition's cost).
contract SelfSandwichModelTest is Test {
    uint160 constant PRICE_1 = 79228162514264337593543950336; // sqrtPriceX96 of 1:1
    uint256 constant CLOSE_TOLERANCE_BPS = 100; // as SandwichCourtVerifier

    IPoolManager manager;
    PoolSwapTest router;
    PoolModifyLiquidityTest lp;
    MockERC20 weth; // token0
    MockERC20 x; // token1

    function setUp() public {
        manager = new PoolManager(address(this));
        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        (weth, x) = address(a) < address(b) ? (a, b) : (b, a);
        router = new PoolSwapTest(manager);
        lp = new PoolModifyLiquidityTest(manager);
        for (uint256 i; i < 2; i++) {
            MockERC20 t = i == 0 ? weth : x;
            t.mint(address(this), 1e30);
            t.approve(address(router), type(uint256).max);
            t.approve(address(lp), type(uint256).max);
        }
    }

    /// @dev A pool at 1:1 with third-party liquidity: full range plus a deeper band around the price.
    function _pool(uint256 tier) internal returns (PoolKey memory key) {
        uint24[4] memory fees = [uint24(100), 500, 3000, 10_000];
        int24[4] memory spacings = [int24(1), 10, 60, 200];
        int24 s = spacings[tier];
        key = PoolKey(Currency.wrap(address(weth)), Currency.wrap(address(x)), fees[tier], s, IHooks(address(0)));
        manager.initialize(key, PRICE_1);
        lp.modifyLiquidity(
            key, IPoolManager.ModifyLiquidityParams(TickMath.minUsableTick(s), TickMath.maxUsableTick(s), 1e21, 0), ""
        );
        lp.modifyLiquidity(key, IPoolManager.ModifyLiquidityParams(-50 * s, 50 * s, 1e22, 0), "");
    }

    /// @dev Exact-input swap (amount > 0) or exact-output (amount < 0 here means "receive -amount").
    function _swap(PoolKey memory key, bool wethIn, int256 amountSpecified) internal {
        router.swap(
            key,
            IPoolManager.SwapParams(
                wethIn, amountSpecified, wethIn ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    function _balances() internal view returns (int256, int256) {
        return (int256(weth.balanceOf(address(this))), int256(x.balanceOf(address(this))));
    }

    struct Run {
        uint256[] bought; // X each front received
        uint256 sold; // X each back sells
        uint256[] got; // WETH each back received
        int256 dW; // the coalition's net WETH change
        int256 dX; // and X change
    }

    /// @dev fronts, victim, backs; returns what each leg moved and the coalition's net change.
    function _sandwich(PoolKey memory key, uint256 nf, uint256 nb, uint256 a, uint256 v, uint256 closeBps)
        internal
        returns (Run memory run)
    {
        (int256 w0, int256 x0) = _balances();
        run.bought = new uint256[](nf);
        run.got = new uint256[](nb);
        for (uint256 i; i < nf; i++) {
            uint256 before = x.balanceOf(address(this));
            _swap(key, true, -int256(a));
            run.bought[i] = x.balanceOf(address(this)) - before;
        }
        _swap(key, true, -int256(v)); // the coalition's own victim tx
        run.sold = (run.bought[0] * closeBps) / 10_000;
        for (uint256 j; j < nb; j++) {
            uint256 before = weth.balanceOf(address(this));
            _swap(key, false, -int256(run.sold));
            run.got[j] = weth.balanceOf(address(this)) - before;
        }
        (int256 w1, int256 x1) = _balances();
        (run.dW, run.dX) = (w1 - w0, x1 - x0);
    }

    /// @dev What BondRegistry pays at most: the best one-to-one pairing of fronts (from `i` on) with unused backs.
    function _payout(Run memory run, uint256 a, uint24 fee, uint256 i, uint256 usedBacks)
        internal
        view
        returns (uint256 best)
    {
        if (i == run.bought.length) return 0;
        best = _payout(run, a, fee, i + 1, usedBacks); // front i opens no incident
        uint256 diff = run.bought[i] > run.sold ? run.bought[i] - run.sold : run.sold - run.bought[i];
        if (diff * 10_000 > run.bought[i] * CLOSE_TOLERANCE_BPS) return best; // no back closes this front
        for (uint256 j; j < run.got.length; j++) {
            if (usedBacks & (1 << j) != 0 || run.got[j] <= a) continue; // taken, or no profit
            uint256 b = feeCappedBudget(run.got[j] - a, a, fee) + _payout(run, a, fee, i + 1, usedBacks | (1 << j));
            if (b > best) best = b;
        }
    }

    /// @dev WETH the coalition would have had more by reaching the same net X with one direct trade.
    function _extraCost(PoolKey memory key, Run memory run) internal returns (int256) {
        (int256 w0,) = _balances();
        if (run.dX > 0) _swap(key, true, run.dX); // exact output: buy the X directly
        else if (run.dX < 0) _swap(key, false, run.dX); // exact input: sell the X directly
        (int256 w1,) = _balances();
        return (w1 - w0) - run.dW;
    }

    function testFuzz_selfSandwichNeverPays(
        uint8 tier,
        uint8 fronts,
        uint8 backs,
        uint96 aRaw,
        uint96 vRaw,
        uint16 closeRaw
    ) public {
        PoolKey memory key = _pool(tier % 4);
        uint256 a = bound(aRaw, 1e15, 1e21);
        uint256 v = bound(vRaw, 1e14, 1e21);
        uint256 close = bound(closeRaw, 10_000 - CLOSE_TOLERANCE_BPS, 10_000);

        uint256 snap = vm.snapshotState();
        Run memory run = _sandwich(key, 1 + fronts % 3, 1 + backs % 3, a, v, close);
        uint256 payout = _payout(run, a, key.fee, 0, 0);
        vm.revertToState(snap);
        int256 extra = _extraCost(key, run);

        if (payout > 0) assertLt(int256(payout), extra, "the payout would cover the cost of faking the sandwich");
    }

    /// @dev One concrete run, so the numbers are visible: a 0.05% pool, a 10 WETH front and a 20 WETH victim.
    function test_selfSandwich_example() public {
        PoolKey memory key = _pool(1);
        uint256 snap = vm.snapshotState();
        Run memory run = _sandwich(key, 1, 1, 10 ether, 20 ether, 10_000);
        uint256 profit = run.got[0] - 10 ether;
        uint256 payout = _payout(run, 10 ether, key.fee, 0, 0);
        vm.revertToState(snap);
        int256 extra = _extraCost(key, run);
        assertEq(payout, 0.005 ether, "budget = the front leg's 0.05% fee, below the profit");
        assertGt(profit, payout);
        assertGt(extra, int256(payout) + int256(0.004 ether), "faking it cost the front and back fees and more");
        emit log_named_decimal_uint("attacker profit", profit, 18);
        emit log_named_decimal_uint("payout", payout, 18);
        emit log_named_decimal_int("extra cost over a direct trade", extra, 18);
    }

    /// @dev The stated assumption matters: a coalition that also adds most of the in-range liquidity just before
    ///      its front leg (JIT) and removes it after the back recovers most of the fees, and then the same payout
    ///      does exceed its cost. This is why only listed pools are covered and `maxPayout` stays the RPC's limit.
    function test_jitLiquidity_breaksTheBound() public {
        PoolKey memory key = _pool(1);
        int24 s = key.tickSpacing;
        uint256 snap = vm.snapshotState();
        (int256 w0, int256 x0) = _balances();
        lp.modifyLiquidity(key, IPoolManager.ModifyLiquidityParams(-20 * s, 20 * s, 1e23, bytes32("jit")), "");
        Run memory run = _sandwich(key, 1, 1, 50 ether, 200 ether, 10_000);
        lp.modifyLiquidity(key, IPoolManager.ModifyLiquidityParams(-20 * s, 20 * s, -1e23, bytes32("jit")), "");
        (int256 w1, int256 x1) = _balances();
        run.dW = w1 - w0; // the LP round trip, fees included, counts as the coalition's own
        run.dX = x1 - x0;
        uint256 payout = _payout(run, 50 ether, key.fee, 0, 0);
        vm.revertToState(snap);
        int256 extra = _extraCost(key, run);
        assertGt(payout, 0);
        assertGt(int256(payout), extra, "with the fees back, the payout outweighs the cost");
    }
}
