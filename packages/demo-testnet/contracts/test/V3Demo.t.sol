// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../src/V3Demo.sol";

contract Token {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address to, uint256 amount) external returns (bool) { allowance[msg.sender][to] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) { allowance[from][msg.sender] -= amount; balanceOf[from] -= amount; balanceOf[to] += amount; return true; }
}
contract Pool {
    Token public token0;
    Token public token1;
    constructor(Token a, Token b) { token0 = a; token1 = b; }
    function mint(address, int24, int24, uint128 n, bytes calldata) external returns (uint256, uint256) {
        V3Demo(msg.sender).uniswapV3MintCallback(n, n, ""); return (n, n);
    }
    function swap(address to, bool zero, int256 amount, uint160, bytes calldata) external returns (int256, int256) {
        if (zero) {
            V3Demo(msg.sender).uniswapV3SwapCallback(amount, -amount, "");
            token1.transfer(to, uint256(amount)); return (amount, -amount);
        }
        V3Demo(msg.sender).uniswapV3SwapCallback(-amount, amount, "");
        token0.transfer(to, uint256(amount)); return (-amount, amount);
    }
}
contract V3DemoTest {
    function testSwapSlippageAndCallbackAuthentication() external {
        Token a = new Token(); Token b = new Token(); Pool pool = new Pool(a, b); V3Demo actor = new V3Demo(address(pool));
        a.mint(address(actor), 100); b.mint(address(actor), 100); actor.addLiquidity(100);
        a.mint(address(this), 40); a.approve(address(actor), 40);
        require(actor.swapExactIn(true, 20, 20, address(this)) == 20, "wrong output");
        require(b.balanceOf(address(this)) == 20, "wrong recipient");
        try actor.swapExactIn(true, 20, 21, address(this)) { revert("slippage accepted"); } catch {}
        require(a.balanceOf(address(this)) == 20, "slippage did not roll back");
        try actor.uniswapV3SwapCallback(1, 0, "") { revert("unauthorized callback accepted"); } catch {}
    }
}
