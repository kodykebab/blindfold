// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ExternalEthereumForkTest} from "./ExternalEthereumFork.t.sol";
import {IERC20Like} from "../src/BlindfoldVault.sol";
import {IV3Pool, IERC20Balance} from "../src/market/IExternalMarket.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

/// @notice Fork experiment: actual v3 swaps around the unchanged settlement.
/// @dev A test-only atomic wrapper measures a stricter output floor. It is not
///      an enforced protocol policy: callers can still use settleExternal directly.
contract ExternalSandwichForkTest is ExternalEthereumForkTest {
    IV3Pool internal attackPool;
    error QuoteDeteriorated();

    function uniswapV3SwapCallback(int256 a, int256 b, bytes calldata) external {
        require(msg.sender == address(attackPool), "pool only");
        if (a > 0) IERC20Like(USDC).transfer(msg.sender, uint256(a));
        if (b > 0) IERC20Like(WETH).transfer(msg.sender, uint256(b));
    }

    function _trade(bool sell, uint256 amount) internal returns (uint256) {
        (int256 a, int256 b) = attackPool.swap(
            address(this), sell, int256(amount), sell ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1, ""
        );
        require(uint256(sell ? a : b) == amount, "partial attacker swap");
        return uint256(-(sell ? b : a));
    }

    function guardedSettle(bool sell, uint256 price, uint256 minimum) external {
        require(msg.sender == address(this));
        address output = sell ? WETH : USDC;
        uint256 beforeOut = vault.balanceOf(address(this), output);
        s.settleExternal(0, price);
        if (vault.balanceOf(address(this), output) - beforeOut < minimum) revert QuoteDeteriorated();
    }

    function test_sandwichSweep_realPool() public {
        attackPool = IV3Pool(FACTORY.getPool(USDC, WETH, 500));
        // Refresh the activity observation using actual swaps, not an oracle mock.
        // All compared cases start after this identical 10,000-USDC round trip.
        deal(USDC, address(this), 10_000e6);
        uint256 seed = _trade(true, 10_000e6);
        _trade(false, seed);
        uint256 initial = vm.snapshotState();
        for (uint256 direction; direction < 2; direction++) {
            Case memory c = _prepareCase(direction == 0);
            uint256[9] memory sizes = [uint256(1), 2, 5, 10, 20, 50, 100, 200, 500];
            uint256 accepted;
            for (uint256 j; j < sizes.length; j++) {
                uint256 state = vm.snapshotState();
                if (_measure(c, sizes[j] * (c.sell ? 3000e6 : 1e18))) accepted++;
                assertTrue(vm.revertToState(state));
            }
            assertGt(accepted, 0, "must exercise successful attacked settlements");
            assertTrue(vm.revertToState(initial));
            initial = vm.snapshotState();
        }
    }

    function _prepareCase(bool sell) internal returns (Case memory c) {
        c.sell = sell;
        c.amount = uint128(
            sell ? vm.envOr("SANDWICH_USDC_INPUT", uint256(30_000e6)) : vm.envOr("SANDWICH_WETH_INPUT", uint256(10e18))
        );
        uint256 ref = s.referencePriceX96(0);
        c.price = sell ? ref - ref / 100 : ref + ref / 100;
        c.minimum = sell ? FullMath.mulDiv(c.amount, c.price, Q96) : FullMath.mulDiv(c.amount, Q96, c.price);
        _ready(sell, c.amount, uint128(c.minimum));
        c.input = sell ? USDC : WETH;
        c.output = sell ? WETH : USDC;
        deal(c.input, address(this), sell ? 10_000_000e6 : 10_000e18);
        c.beforeOut = vault.balanceOf(address(this), c.output);
        uint256 ready = vm.snapshotState();
        s.settleExternal(0, c.price);
        c.baseline = vault.balanceOf(address(this), c.output) - c.beforeOut;
        emit log_named_uint("direction (0 USDC, 1 WETH)", sell ? 0 : 1);
        emit log_named_uint("baseline output raw units", c.baseline);
        assertTrue(vm.revertToState(ready));
        this.guardedSettle(sell, c.price, c.baseline * 9998 / 10_000);
        assertEq(vault.balanceOf(address(this), c.output) - c.beforeOut, c.baseline);
        assertTrue(vm.revertToState(ready));
    }

    struct Case {
        bool sell;
        uint128 amount;
        uint256 price;
        uint256 minimum;
        uint256 baseline;
        uint256 beforeOut;
        address input;
        address output;
    }

    function _measure(Case memory c, uint256 front) internal returns (bool) {
        uint256 beforeAttack = IERC20Balance(c.input).balanceOf(address(this));
        uint256 beforeOther = IERC20Balance(c.output).balanceOf(address(this));
        uint256 back = _trade(c.sell, front);
        uint256 attacked = vm.snapshotState();
        (bool ordinary,) = address(s).call(abi.encodeWithSignature("settleExternal(uint64,uint256)", 0, c.price));
        if (!ordinary) {
            assertFalse(s.finalized(0));
            assertEq(vault.lockedOf(address(this), c.input), c.amount);
            assertEq(vault.balanceOf(address(this), c.output), c.beforeOut);
            emit log_named_uint("ordinary rejected front input raw", front);
            return false;
        }
        uint256 actual = vault.balanceOf(address(this), c.output) - c.beforeOut;
        _trade(!c.sell, back);
        assertEq(IERC20Balance(c.output).balanceOf(address(this)), beforeOther, "attacker closes inventory");
        int256 profit = int256(IERC20Balance(c.input).balanceOf(address(this))) - int256(beforeAttack);
        emit log_named_uint("front input raw", front);
        emit log_named_int("attacker profit raw, after pool fees before gas", profit);
        emit log_named_uint("victim output loss raw", c.baseline - actual);
        assertGe(actual, c.minimum);
        assertEq(vault.lockedOf(address(this), c.input), 0);
        assertEq(vault.openCommitments(address(this)), 0);
        assertEq(IERC20Balance(USDC).balanceOf(address(market)), 0);
        assertEq(IERC20Balance(WETH).balanceOf(address(market)), 0);
        _checkGuard(c, actual, attacked);
        return true;
    }

    function _checkGuard(Case memory c, uint256 actual, uint256 attacked) internal {
        assertTrue(vm.revertToState(attacked));
        (bool guarded, bytes memory reason) =
            address(this).call(abi.encodeCall(this.guardedSettle, (c.sell, c.price, c.baseline * 9998 / 10_000)));
        emit log_named_uint("2bps guard accepted", guarded ? 1 : 0);
        if (!guarded) {
            assertEq(reason, abi.encodeWithSelector(QuoteDeteriorated.selector));
            assertFalse(s.finalized(0));
            assertEq(vault.balanceOf(address(this), c.output), c.beforeOut);
            assertEq(vault.lockedOf(address(this), c.input), c.amount);
        } else {
            assertGe(vault.balanceOf(address(this), c.output) - c.beforeOut, c.baseline * 9998 / 10_000);
        }
        // A quote sampled AFTER the front-run accepts the degraded execution.
        assertTrue(vm.revertToState(attacked));
        this.guardedSettle(c.sell, c.price, actual * 9998 / 10_000);
        assertEq(vault.balanceOf(address(this), c.output) - c.beforeOut, actual);
    }
}
