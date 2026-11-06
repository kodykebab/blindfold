// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Verifies the prepared key and global encrypted-order/funding relation.
/// @dev Both statement digests are computed by the auction, never supplied by the caller.
interface IGlobalAdmission {
    function verify(bytes32 preparation, bytes32 online, bytes calldata proof) external view returns (bool);
}
