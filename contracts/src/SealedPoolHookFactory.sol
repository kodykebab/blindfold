// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SealedPoolHook} from "./SealedPoolHook.sol";

/// @notice Deploys SealedPoolHook with CREATE2 so a deployment can mine a salt whose address carries exactly the
///         beforeSwap permission bits (v4 encodes hook permissions in the address). DeployBlindfold mines against
///         this factory's address; anyone can recompute the hook address from it.
contract SealedPoolHookFactory {
    event HookDeployed(address indexed hook, address indexed manager, address indexed settlement, bytes32 salt);

    function initCodeHash(address manager, address settlement) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(type(SealedPoolHook).creationCode, abi.encode(manager, settlement)));
    }

    /// @notice Deploy the hook for `settlement` on `manager` at the address `salt` gives.
    function deploy(address manager, address settlement, bytes32 salt) external returns (address hook) {
        hook = address(new SealedPoolHook{salt: salt}(manager, settlement));
        emit HookDeployed(hook, manager, settlement, salt);
    }
}
