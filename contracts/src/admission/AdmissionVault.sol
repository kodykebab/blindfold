// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BlindfoldVault} from "../BlindfoldVault.sol";

interface IBalanceToken {
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Fixed-pair vault for ordinary, non-rebasing ERC-20s with exact transfers.
contract AdmissionVault is BlindfoldVault {
    error UnsupportedToken();
    error InexactTransfer();

    address public immutable token0;
    address public immutable token1;

    constructor(address a, address b) {
        if (a >= b || a.code.length == 0 || b.code.length == 0) revert UnsupportedToken();
        token0 = a;
        token1 = b;
    }

    function _receive(address token, address from, uint256 amount) internal override {
        if (token != token0 && token != token1) revert UnsupportedToken();
        uint256 beforeBalance = IBalanceToken(token).balanceOf(address(this));
        super._receive(token, from, amount);
        uint256 afterBalance = IBalanceToken(token).balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) revert InexactTransfer();
    }

    function _send(address token, address to, uint256 amount) internal override {
        if (token != token0 && token != token1) revert UnsupportedToken();
        uint256 beforeVault = IBalanceToken(token).balanceOf(address(this));
        uint256 beforeRecipient = IBalanceToken(token).balanceOf(to);
        super._send(token, to, amount);
        uint256 afterVault = IBalanceToken(token).balanceOf(address(this));
        uint256 afterRecipient = IBalanceToken(token).balanceOf(to);
        if (
            afterVault > beforeVault || beforeVault - afterVault != amount || afterRecipient < beforeRecipient
                || afterRecipient - beforeRecipient != amount
        ) revert InexactTransfer();
    }
}
