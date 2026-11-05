// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTestHooks} from "v4-core/src/test/BaseTestHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";

/// @title SealedPoolHook
/// @notice beforeSwap-only hook: the pool can be swapped only by BlindfoldSettlement, i.e. only inside
///         sealed batches. Liquidity adds and removes stay open.
contract SealedPoolHook is BaseTestHooks {
    error OnlySettlement(address sender);
    error OnlyManager();

    address public immutable manager;
    address public immutable settlement;

    constructor(address manager_, address settlement_) {
        manager = manager_;
        settlement = settlement_;
    }

    function beforeSwap(address sender, PoolKey calldata, IPoolManager.SwapParams calldata, bytes calldata)
        external
        view
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != manager) revert OnlyManager();
        if (sender != settlement) revert OnlySettlement(sender);
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }
}
