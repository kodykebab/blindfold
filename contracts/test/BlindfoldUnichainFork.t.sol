// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BlindfoldTest} from "./Blindfold.t.sol";

/// @notice The whole Blindfold suite again, against the real Uniswap v4 PoolManager on a Unichain mainnet fork.
contract BlindfoldUnichainForkTest is BlindfoldTest {
    IPoolManager constant UNICHAIN_POOL_MANAGER = IPoolManager(0x1F98400000000000000000000000000000000004);

    function _manager() internal override returns (IPoolManager) {
        vm.createSelectFork("unichain");
        require(address(UNICHAIN_POOL_MANAGER).code.length > 0, "no PoolManager on fork");
        return UNICHAIN_POOL_MANAGER;
    }
}
