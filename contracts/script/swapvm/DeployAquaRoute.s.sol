// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {BlindfoldAquaRouter} from "../../src/swapvm/BlindfoldAquaRouter.sol";
import {AquaResidual} from "../../src/swapvm/AquaResidual.sol";

/// @notice Deploy the immutable maker/split configuration before DeployBlindfold uses AQUA_ROUTE.
contract DeployAquaRoute is Script {
    function run() external returns (AquaResidual route) {
        uint256 key = vm.envOr(
            "DEPLOYER_KEY",
            vm.deriveKey(vm.envOr("MNEMONIC", string("test test test test test test test test test test test junk")), 0)
        );
        address maker = vm.envOr("AQUA_MAKER", vm.addr(key));
        address registry = vm.envOr("AQUA_REGISTRY", address(0));
        uint256 share = vm.envOr("AQUA_SHARE_BPS", uint256(5000));
        require(registry != address(0) || block.chainid == 31337, "set AQUA_REGISTRY outside local Anvil");
        vm.startBroadcast(key);
        if (registry == address(0)) registry = address(new Aqua());
        BlindfoldAquaRouter router = new BlindfoldAquaRouter(registry, address(0), vm.addr(key));
        route = new AquaResidual(router, maker, share);
        vm.stopBroadcast();
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            vm.serializeAddress("aqua", "registry", registry);
            vm.serializeAddress("aqua", "router", address(router));
            vm.serializeAddress("aqua", "route", address(route));
            vm.serializeAddress("aqua", "maker", maker);
            string memory json = vm.serializeUint("aqua", "shareBps", share);
            vm.writeJson(
                json, vm.envOr("AQUA_ROUTE_OUT", string.concat(vm.projectRoot(), "/../deployments/aqua.local.json"))
            );
        }
    }
}
