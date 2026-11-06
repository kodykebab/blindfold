// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PeerClearingTest} from "./PeerClearing.t.sol";

contract PeerClearingForkTest is PeerClearingTest {
    function _manager() internal override returns (IPoolManager) {
        vm.createSelectFork("unichain");
        IPoolManager deployed = IPoolManager(0x1F98400000000000000000000000000000000004);
        require(address(deployed).code.length > 0, "no PoolManager on fork");
        return deployed;
    }
}
