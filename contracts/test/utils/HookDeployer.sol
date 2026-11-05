// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {SealedPoolHook} from "../../src/SealedPoolHook.sol";

/// @notice Mines a CREATE2 salt so the hook address carries exactly the BEFORE_SWAP permission flag.
library HookDeployer {
    function deploySealed(address deployer, address manager, address settlement)
        internal
        returns (SealedPoolHook hook, uint256 tries)
    {
        bytes32 codeHash =
            keccak256(abi.encodePacked(type(SealedPoolHook).creationCode, abi.encode(manager, settlement)));
        for (uint256 salt; salt < 500_000; salt++) {
            address a = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, bytes32(salt), codeHash))))
            );
            if (uint160(a) & Hooks.ALL_HOOK_MASK == Hooks.BEFORE_SWAP_FLAG) {
                hook = new SealedPoolHook{salt: bytes32(salt)}(manager, settlement);
                require(address(hook) == a, "address");
                return (hook, salt + 1);
            }
        }
        revert("no salt");
    }
}
