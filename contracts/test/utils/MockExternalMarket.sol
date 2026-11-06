// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IExternalMarket} from "../../src/market/IExternalMarket.sol";
import {IERC20Like} from "../../src/BlindfoldVault.sol";

contract MockExternalMarket is IExternalMarket {
    address public immutable settlement;
    address public immutable token0;
    address public immutable token1;
    uint256 public maxDeviationBps = 100;
    uint256 public price = 1 << 96;
    uint256 public outputBps = 10_000;
    bool public fail;

    constructor(address s, address a, address b) {
        settlement = s;
        token0 = a;
        token1 = b;
    }

    function setPrice(uint256 p) external {
        price = p;
    }

    function setOutputBps(uint256 bps) external {
        outputBps = bps;
    }

    function setFail(bool f) external {
        fail = f;
    }

    function referencePrice(uint256) external view returns (uint256) {
        require(!fail, "oracle unavailable");
        return price;
    }

    function swap(bool sell, uint256 amount, uint256 minimum) external returns (uint256 out) {
        require(msg.sender == settlement);
        out = amount * outputBps / 10_000;
        require(out >= minimum, "short output");
        IERC20Like(sell ? token1 : token0).transfer(settlement, out);
    }
}
