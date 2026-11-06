// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IGlobalAdmission} from "./IGlobalAdmission.sol";

/// @notice Binds separately generated key-preparation and global online Groth16 proofs.
/// @dev Deploy with reviewed circuit-specific generated verifiers. The auction constructs both digests.
contract GlobalAdmissionVerifier is IGlobalAdmission {
    address public immutable preparationVerifier;
    address public immutable onlineVerifier;
    bytes32 public immutable preparationCodeHash;
    bytes32 public immutable onlineCodeHash;
    error Config();

    constructor(address preparation, address online) {
        if (preparation.code.length == 0 || online.code.length == 0 || preparation == online) revert Config();
        preparationVerifier = preparation;
        onlineVerifier = online;
        preparationCodeHash = preparation.codehash;
        onlineCodeHash = online.codehash;
    }

    function verify(bytes32 preparation, bytes32 online, bytes calldata proof) external view returns (bool) {
        (bytes memory first, bytes memory second) = abi.decode(proof, (bytes, bytes));
        return _verify(preparationVerifier, preparation, first) && _verify(onlineVerifier, online, second);
    }

    function _verify(address verifier, bytes32 digest, bytes memory proof) private view returns (bool) {
        uint256[2] memory inputs = [uint256(uint128(uint256(digest) >> 128)), uint256(uint128(uint256(digest)))];
        (bool ok,) = verifier.staticcall(abi.encodeWithSignature("verifyProof(bytes,uint256[2])", proof, inputs));
        return ok;
    }
}
