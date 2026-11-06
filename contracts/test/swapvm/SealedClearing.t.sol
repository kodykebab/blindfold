// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { AquaSwapVMTest } from "swap-vm/test/base/AquaSwapVMTest.sol";
import { SwapVM } from "swap-vm/src/SwapVM.sol";
import { ISwapVM } from "swap-vm/src/interfaces/ISwapVM.sol";
import { BlindfoldAquaRouter } from "../../src/swapvm/BlindfoldAquaRouter.sol";

contract SealedClearingTest is AquaSwapVMTest {
    bytes4 constant PRICE_SIG = bytes4(keccak256("activeClearingPriceX96(address,address)"));

    function setUp() public override {
        super.setUp();
        if (address(tokenA) > address(tokenB)) (tokenA, tokenB) = (tokenB, tokenA);
    }

    function _deployRouter() internal override returns (SwapVM) {
        return new BlindfoldAquaRouter(address(aqua), address(0), address(this));
    }

    /// @dev `taker` plays BlindfoldSettlement: the only allowed taker, and the price source.
    function _shipSealed() internal returns (ISwapVM.Order memory order) {
        uint8 op = BlindfoldAquaRouter(payable(address(swapVM))).sealedClearingOpcode();
        order = createStrategy(abi.encodePacked(op, uint8(20), address(taker)));
        shipStrategy(order, tokenA, tokenB, 1_000e18, 3_000_000e18);
        tokenB.mint(maker, 3_000_000e18);
    }

    function _program(address t, uint256 amount, bool exactIn) internal view returns (SwapProgram memory) {
        return SwapProgram({ amount: amount, taker: t == address(taker) ? taker : taker2, tokenA: tokenA, tokenB: tokenB, zeroForOne: true, isExactIn: exactIn });
    }

    function _setPrice(uint256 p) internal {
        vm.mockCall(address(taker), abi.encodeWithSelector(PRICE_SIG), abi.encode(p));
    }

    function test_noActiveBatch_reverts() public {
        ISwapVM.Order memory order = _shipSealed();
        SwapProgram memory sp = _program(address(taker), 10e18, true);
        mintTokenInToTaker(sp);
        _setPrice(0);
        vm.expectRevert();
        swap(sp, order);
    }

    function test_exactIn_fillsAtClearingPrice() public {
        ISwapVM.Order memory order = _shipSealed();
        SwapProgram memory sp = _program(address(taker), 10e18, true);
        mintTokenInToTaker(sp);
        _setPrice(uint256(3_200) << 96);
        (uint256 amountIn, uint256 amountOut) = swap(sp, order);
        assertEq(amountIn, 10e18);
        assertEq(amountOut, 32_000e18);
    }

    function test_exactOut_roundsAgainstTaker() public {
        ISwapVM.Order memory order = _shipSealed();
        SwapProgram memory sp = _program(address(taker), 32_000e18 + 1, false);
        mintTokenInToTaker(sp);
        _setPrice(uint256(3_200) << 96);
        (uint256 amountIn, uint256 amountOut) = swap(sp, order);
        assertEq(amountOut, 32_000e18 + 1);
        assertEq(amountIn, 10e18 + 1, "rounded up");
    }

    function test_otherTaker_rejected() public {
        ISwapVM.Order memory order = _shipSealed();
        SwapProgram memory sp = _program(address(taker2), 10e18, true);
        mintTokenInToTaker(sp);
        _setPrice(uint256(3_200) << 96);
        vm.expectRevert();
        swap(sp, order);
    }
}
