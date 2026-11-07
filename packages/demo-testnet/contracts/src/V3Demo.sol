// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Demo {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}
interface IV3DemoPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function mint(address recipient, int24 lower, int24 upper, uint128 amount, bytes calldata data) external returns (uint256, uint256);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256, int256);
}

/// @notice A demo-only v3 liquidity provider and exact-input swapper for one pool.
contract V3Demo {
    IV3DemoPool public immutable pool;
    IERC20Demo public immutable token0;
    IERC20Demo public immutable token1;
    address public immutable owner;
    uint160 private constant MIN_SQRT = 4295128740;
    uint160 private constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;

    constructor(address pool_) {
        pool = IV3DemoPool(pool_);
        token0 = IERC20Demo(pool.token0());
        token1 = IERC20Demo(pool.token1());
        owner = msg.sender;
    }
    function addLiquidity(uint128 amount) external {
        require(msg.sender == owner, "owner");
        pool.mint(address(this), -887220, 887220, amount, "");
    }
    function swapExactIn(bool zeroForOne, uint256 amountIn, uint256 minOut, address recipient) external returns (uint256 out) {
        IERC20Demo input = zeroForOne ? token0 : token1;
        require(input.transferFrom(msg.sender, address(this), amountIn), "transfer in");
        return _swap(zeroForOne, amountIn, minOut, recipient);
    }
    function swap(bool zeroForOne, uint256 amountIn) external returns (uint256 out) {
        require(msg.sender == owner, "owner");
        IERC20Demo input = zeroForOne ? token0 : token1;
        if (amountIn == 0) amountIn = input.balanceOf(address(this));
        return _swap(zeroForOne, amountIn, 0, address(this));
    }
    function _swap(bool zeroForOne, uint256 amountIn, uint256 minOut, address recipient) private returns (uint256 out) {
        require(amountIn > 0 && amountIn <= uint256(type(int256).max), "amount");
        (int256 a, int256 b) = pool.swap(recipient, zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT : MAX_SQRT, "");
        out = uint256(-(zeroForOne ? b : a));
        require(out >= minOut, "slippage");
    }
    function uniswapV3MintCallback(uint256 a, uint256 b, bytes calldata) external {
        require(msg.sender == address(pool), "pool");
        if (a != 0) require(token0.transfer(msg.sender, a), "token0");
        if (b != 0) require(token1.transfer(msg.sender, b), "token1");
    }
    function uniswapV3SwapCallback(int256 a, int256 b, bytes calldata) external {
        require(msg.sender == address(pool), "pool");
        if (a > 0) require(token0.transfer(msg.sender, uint256(a)), "token0");
        if (b > 0) require(token1.transfer(msg.sender, uint256(b)), "token1");
    }
}
