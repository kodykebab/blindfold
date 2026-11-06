// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {AquaResidual} from "../../src/swapvm/AquaResidual.sol";
import {AquaAdmittedSettlement} from "../../src/admission/AquaAdmittedSettlement.sol";
import {BlindfoldSettlement} from "../../src/BlindfoldSettlement.sol";
import {SafeERC20, IERC20} from "@1inch/solidity-utils/contracts/libraries/SafeERC20.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";

/// @notice Ship the exact settlement-bound strategy with explicitly allocated, funded maker inventory.
contract ShipAquaStrategy is Script {
    using SafeERC20 for IERC20;

    function run() external returns (bytes32 hash) {
        string memory json = vm.readFile(
            vm.envOr("DEPLOYMENTS", string.concat(vm.projectRoot(), "/../deployments/blindfold.local.json"))
        );
        require(vm.parseJsonUint(json, ".chainId") == block.chainid, "deployment is for another chain");
        BlindfoldSettlement settlement = BlindfoldSettlement(vm.parseJsonAddress(json, ".settlement"));
        AquaResidual route = AquaResidual(vm.parseJsonAddress(json, ".aquaRoute"));
        require(
            AquaAdmittedSettlement(address(settlement)).aquaRoute() == address(route),
            "deployment has the wrong Aqua route"
        );
        uint256 key = vm.envOr(
            "MAKER_KEY",
            vm.deriveKey(vm.envOr("MNEMONIC", string("test test test test test test test test test test test junk")), 0)
        );
        require(vm.addr(key) == route.maker(), "MAKER_KEY does not own the configured strategy");
        address[] memory tokens = new address[](2);
        tokens[0] = settlement.token0();
        tokens[1] = settlement.token1();
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = vm.envUint("AQUA_BALANCE0");
        amounts[1] = vm.envUint("AQUA_BALANCE1");
        IAqua aqua = route.router().AQUA();
        bytes memory strategy = abi.encode(route.order(address(settlement)));
        vm.startBroadcast(key);
        for (uint256 i; i < 2; i++) {
            require(
                amounts[i] != 0 && IERC20(tokens[i]).balanceOf(vm.addr(key)) >= amounts[i],
                "fund the maker before shipping"
            );
            IERC20(tokens[i]).forceApprove(address(aqua), amounts[i]);
        }
        hash = aqua.ship(address(route.router()), strategy, tokens, amounts);
        vm.stopBroadcast();
    }
}
