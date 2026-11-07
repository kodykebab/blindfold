// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IV3Pool, IERC20Balance} from "../src/market/IExternalMarket.sol";
import {IERC20Like} from "../src/BlindfoldVault.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

/// @notice Local-fork experiment actor for contracts/test/solver-sandwich.mjs; never deploy with real funds.
/// @dev Exact-input swaps on one v3 pool, restricted to the deploying account.
contract ExternalSandwichActor {
    IV3Pool public immutable pool;
    address public immutable owner;

    constructor(IV3Pool pool_) {
        pool = pool_;
        owner = msg.sender;
    }

    /// @notice Exact-input swap; `sell` means token0 in.
    function trade(bool sell, uint256 amount) external returns (uint256 output) {
        require(msg.sender == owner, "owner only");
        (int256 a, int256 b) = pool.swap(
            address(this), sell, int256(amount), sell ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1, ""
        );
        require(uint256(sell ? a : b) == amount, "partial trade");
        return uint256(-(sell ? b : a));
    }

    function uniswapV3SwapCallback(int256 a, int256 b, bytes calldata) external {
        require(msg.sender == address(pool), "pool only");
        if (a > 0) require(IERC20Like(pool.token0()).transfer(msg.sender, uint256(a)));
        if (b > 0) require(IERC20Like(pool.token1()).transfer(msg.sender, uint256(b)));
    }

    function withdraw(address token, address recipient) external {
        require(msg.sender == owner, "owner only");
        require(IERC20Like(token).transfer(recipient, IERC20Balance(token).balanceOf(address(this))));
    }
}
