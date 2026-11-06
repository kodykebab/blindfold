// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { Context } from "swap-vm/src/libs/VM.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SealedClearing } from "../../src/swapvm/SealedClearing.sol";

/// Runs the instruction on a bare Context; `this` plays the settlement (taker and price source).
contract SealedClearingHarness is SealedClearing {
    function run(bool exactIn, uint256 amountIn, uint256 amountOut, bytes calldata args, bool reverse)
        external
        view
        returns (uint256, uint256)
    {
        Context memory ctx;
        ctx.query.taker = msg.sender;
        ctx.query.tokenIn = reverse ? address(2) : address(1);
        ctx.query.tokenOut = reverse ? address(1) : address(2);
        ctx.query.isExactIn = exactIn;
        ctx.swap.amountIn = amountIn;
        ctx.swap.amountOut = amountOut;
        _sealedClearing(ctx, args);
        return (ctx.swap.amountIn, ctx.swap.amountOut);
    }
}

/// REVIEW S17: SealedClearing quotes at full precision over the whole uint256 amount domain.
contract SealedClearingMathTest is Test {
    uint256 constant Q96 = 1 << 96;
    SealedClearingHarness h;
    uint256 price;

    function activeClearingPriceX96(address tokenIn, address tokenOut) external view returns (uint256) {
        require(tokenIn == address(1) && tokenOut == address(2), "must use canonical price");
        return price;
    }

    function setUp() public {
        h = new SealedClearingHarness();
    }

    function _run(bool exactIn, uint256 amountIn, uint256 amountOut) internal view returns (uint256, uint256) {
        return h.run(exactIn, amountIn, amountOut, abi.encodePacked(address(this)), false);
    }

    /// The old `(amountOut << 96)` dropped high bits: 2^170 out at price 1 quoted an input of 0.
    function test_exactOut_largeAmountKeepsHighBits() public {
        price = Q96;
        (uint256 amountIn,) = _run(false, 0, uint256(1) << 170);
        assertEq(amountIn, uint256(1) << 170);
    }

    /// The old `amountIn * priceX96` reverted once the product passed 2^256, though the quote fits.
    function test_exactIn_largeProductStillQuotes() public {
        price = uint256(1) << 160;
        (, uint256 amountOut) = _run(true, uint256(1) << 120, 0);
        assertEq(amountOut, uint256(1) << 184);
    }

    function test_resultBeyond256Bits_reverts() public {
        price = type(uint256).max;
        vm.expectRevert();
        this.runExternal(true, type(uint256).max, 0);
    }

    function runExternal(bool exactIn, uint256 amountIn, uint256 amountOut) external view returns (uint256, uint256) {
        return _run(exactIn, amountIn, amountOut);
    }

    function testFuzz_matchesFullPrecision(uint128 amount, uint256 priceSeed, bool exactIn) public {
        price = bound(priceSeed, 1, uint256(1) << 224);
        if (exactIn) {
            (, uint256 out) = _run(true, amount, 0);
            assertEq(out, Math.mulDiv(amount, price, Q96));
        } else {
            (uint256 inp,) = _run(false, 0, amount);
            assertEq(inp, Math.mulDiv(amount, Q96, price, Math.Rounding.Ceil));
            // rounded against the taker: what it pays always covers the output at the clearing price
            assertGe(Math.mulDiv(inp, price, Q96, Math.Rounding.Ceil), amount);
        }
    }
    function test_reversePriceDoesNotLoseOneWeiThroughReciprocalRounding() public {
        price = 3 * Q96;
        (, uint256 out) = h.run(true, 3e18, 0, abi.encodePacked(address(this)), true);
        assertEq(out, 1e18);
        (uint256 inp,) = h.run(false, 0, 1e18, abi.encodePacked(address(this)), true);
        assertEq(inp, 3e18);
    }

    function testFuzz_reverseMatchesSettlementDivision(uint128 amount, uint128 priceSeed) public {
        price = bound(priceSeed, 1, type(uint128).max);
        (, uint256 out) = h.run(true, amount, 0, abi.encodePacked(address(this)), true);
        assertEq(out, Math.mulDiv(amount, Q96, price));
        (uint256 inp,) = h.run(false, 0, amount, abi.encodePacked(address(this)), true);
        assertEq(inp, Math.mulDiv(amount, price, Q96, Math.Rounding.Ceil));
    }

}
