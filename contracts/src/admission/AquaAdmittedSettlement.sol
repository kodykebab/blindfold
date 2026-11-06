// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AdmittedSettlement} from "./AdmittedSettlement.sol";

/// @notice Proof-enforced pair settlement with an immutable Aqua/v4 residual executor.
/// @dev The executor runs in this contract's context so the vault operator and Aqua taker remain
///      this settlement. It owns no storage; all batch state and final price checks stay here.
contract AquaAdmittedSettlement is AdmittedSettlement {
    error InvalidAquaRoute();
    address public immutable aquaRoute;

    constructor(Config memory c, address preparation, address online, address route)
        AdmittedSettlement(c, preparation, online)
    {
        if (route.code.length == 0) revert InvalidAquaRoute();
        aquaRoute = route;
    }

    /// @notice Execute the configured residual route during this pool manager's unlock only.
    function unlockCallback(
        bytes calldata /* data */
    )
        public
        override
        returns (bytes memory)
    {
        if (msg.sender != address(manager)) revert Unauthorized();
        (bool ok, bytes memory result) = aquaRoute.delegatecall(msg.data);
        if (!ok) {
            assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        }
        return abi.decode(result, (bytes));
    }
}
