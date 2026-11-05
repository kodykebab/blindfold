// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Context } from "swap-vm/src/libs/VM.sol";
import { Simulator } from "@1inch/solidity-utils/contracts/mixins/Simulator.sol";
import { SwapVM } from "swap-vm/src/SwapVM.sol";
import { AquaOpcodes } from "swap-vm/src/opcodes/AquaOpcodes.sol";
import { SealedClearing } from "./SealedClearing.sol";

/// @title BlindfoldAquaRouter
/// @notice The official SwapVM + AquaOpcodes composition (as in AquaSwapVMRouter) with one extra
///         instruction appended: SealedClearing, at opcode index = AquaOpcodes length.
contract BlindfoldAquaRouter is Simulator, SwapVM, AquaOpcodes, SealedClearing {
    constructor(address aqua, address weth, address owner)
        SwapVM(aqua, weth, owner, "BlindfoldAquaRouter", "1")
        AquaOpcodes(aqua)
    { }

    function _instructions() internal pure override returns (function(Context memory, bytes calldata) internal[] memory out) {
        function(Context memory, bytes calldata) internal[] memory base = _opcodes();
        out = new function(Context memory, bytes calldata) internal[](base.length + 1);
        for (uint256 i; i < base.length; i++) out[i] = base[i];
        out[base.length] = SealedClearing._sealedClearing;
    }

    function sealedClearingOpcode() external pure returns (uint8) {
        return uint8(_opcodes().length);
    }
}
