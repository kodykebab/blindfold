// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice eth_call probe. Its code is installed on the token holder for one call, so `transfer` spends that holder's balance.
contract TransferProbe {
    function arrived(address token, address vault, uint256 amount) external returns (uint256) {
        uint256 beforeBalance = IERC20Balance(token).balanceOf(vault);
        IERC20Balance(token).transfer(vault, amount);
        return IERC20Balance(token).balanceOf(vault) - beforeBalance;
    }
}
