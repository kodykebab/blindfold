// SPDX-License-Identifier: MIT
pragma solidity =0.8.26;
import {SealedPoolHook} from "../../src/SealedPoolHook.sol";

/// @notice Local test helper; the caller mines the permission bits offchain before creation.
contract AdmissionPoolFactory {
    function initCodeHash(address manager, address settlement) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(type(SealedPoolHook).creationCode, abi.encode(manager, settlement)));
    }

    function deployHook(address manager, address settlement, bytes32 salt) external returns (address) {
        return address(new SealedPoolHook{salt: salt}(manager, settlement));
    }
}
