// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Context } from "swap-vm/src/libs/VM.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

interface IClearingPriceSource {
    /// @return priceX96 tokenOut per tokenIn (Q96) of the batch being settled right now; 0 if none
    function activeClearingPriceX96(address tokenIn, address tokenOut) external view returns (uint256 priceX96);
}

/// @title SealedClearing
/// @notice SwapVM instruction: an Aqua-shipped strategy fills only at the verified uniform clearing price
///         of the batch being settled, and only when the settlement contract itself is the taker.
///         Args: 20 bytes, the BlindfoldSettlement address.
/// @dev Quotes use 512-bit intermediate products (REVIEW S17): `amountIn * priceX96` can exceed 256 bits, and a
///      plain `amountOut << 96` drops high bits silently, which would quote a tiny input for a huge output.
///      A result that doesn't fit 256 bits reverts.
contract SealedClearing {
    uint256 private constant Q96 = 1 << 96;

    error SealedClearingWrongTaker(address taker, address settlement);
    error SealedClearingInactive();
    error SealedClearingAmountPreset();

    function _sealedClearing(Context memory ctx, bytes calldata args) internal view {
        address settlement = address(bytes20(args[0:20]));
        if (ctx.query.taker != settlement) revert SealedClearingWrongTaker(ctx.query.taker, settlement);
        uint256 priceX96 = IClearingPriceSource(settlement).activeClearingPriceX96(ctx.query.tokenIn, ctx.query.tokenOut);
        if (priceX96 == 0) revert SealedClearingInactive();
        if (ctx.query.isExactIn) {
            if (ctx.swap.amountOut != 0) revert SealedClearingAmountPreset();
            ctx.swap.amountOut = Math.mulDiv(ctx.swap.amountIn, priceX96, Q96);
        } else {
            if (ctx.swap.amountIn != 0) revert SealedClearingAmountPreset();
            // round up against the taker
            ctx.swap.amountIn = Math.mulDiv(ctx.swap.amountOut, Q96, priceX96, Math.Rounding.Ceil);
        }
    }
}
