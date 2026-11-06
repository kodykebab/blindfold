// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {AquaSettlementTest} from "./AquaSettlement.t.sol";

/// @notice The Aqua lifecycle against Unichain's real v4 PoolManager; Aqua is deployed from pinned source.
contract AquaUnichainForkTest is AquaSettlementTest {
    function _manager() internal override returns (IPoolManager) {
        vm.createSelectFork("unichain");
        IPoolManager manager_ = IPoolManager(0x1F98400000000000000000000000000000000004);
        require(address(manager_).code.length != 0, "missing Unichain manager");
        return manager_;
    }
}
