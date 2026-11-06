// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IExternalMarket {
    function settlement() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function maxDeviationBps() external view returns (uint256);
    function referencePrice(uint256 end) external view returns (uint256);
    function swap(bool zeroForOne, uint256 amountIn, uint256 minimumOut) external returns (uint256 amountOut);
}

interface IV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function factory() external view returns (address);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function observations(uint256 index) external view returns (uint32, int56, uint160, bool);
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory, uint160[] memory);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
}
