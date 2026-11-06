// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {SealedPoolHook} from "blindfold/SealedPoolHook.sol";

/// @dev Test-only CREATE2 deployer; the integration test mines the permission bits offchain.
contract SolverHookFactory {
    function initCodeHash(address manager, address settlement) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(type(SealedPoolHook).creationCode, abi.encode(manager, settlement)));
    }

    function deploy(bytes32 salt, address manager, address settlement) external returns (address) {
        return address(new SealedPoolHook{salt: salt}(manager, settlement));
    }
}
