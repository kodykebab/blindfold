// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {SandwichCourtVerifier, IL1Block} from "../src/court/SandwichCourtVerifier.sol";
import {BondRegistry} from "../src/court/BondRegistry.sol";

/// @notice Deploys Court: SandwichCourtVerifier + BondRegistry, bonds the demo RPC signer (anvil account 4), and
///         writes deployments/court.local.json {chainId, deployBlock, verifier, bondRegistry, rpcSigner}.
///         Defaults judge this chain itself through BLOCKHASH (a plain anvil or a Unichain fork). Run it after
///         DeployBlindfold so the registry pins that deployment's PoolManager, or set V4_POOL_MANAGER.
///         To judge Ethereum from Base: L1_BLOCK=0x4200000000000000000000000000000000000015 SOURCE_CHAIN_ID=1,
///         plus Ethereum's WETH, V3_FACTORY and V4_POOL_MANAGER.
///         COURT_POOLS (required): comma-separated pools to cover (v3 pool address left-padded to 32 bytes, or v4
///         PoolId). The registry refuses to deploy without one, since it could never pay (REVIEW R8, S18).
///         UNBOND_DELAY defaults to 2 days and can't be shorter than the ~27.3 h a sandwich stays provable.
///   forge script script/DeployCourt.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract DeployCourt is Script {
    string constant ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
    address constant UNICHAIN_V3_FACTORY = 0x1F98400000000000000000000000000000000003;
    address constant UNICHAIN_POOL_MANAGER = 0x1F98400000000000000000000000000000000004;
    address constant OP_STACK_WETH = 0x4200000000000000000000000000000000000006;
    bytes32 constant V3_INIT_CODE_HASH = 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;

    function run() external returns (SandwichCourtVerifier verifier, BondRegistry registry) {
        string memory mnemonic = vm.envOr("MNEMONIC", ANVIL_MNEMONIC);
        uint256 deployerKey = vm.envOr("DEPLOYER_KEY", vm.deriveKey(mnemonic, 0));
        uint256 rpcKey = vm.envOr("RPC_SIGNER_KEY", vm.deriveKey(mnemonic, 4));

        vm.startBroadcast(deployerKey);
        verifier = new SandwichCourtVerifier(IL1Block(vm.envOr("L1_BLOCK", address(0))));
        registry = new BondRegistry(
            BondRegistry.Config({
                verifier: verifier,
                sourceChainId: vm.envOr("SOURCE_CHAIN_ID", block.chainid),
                weth: vm.envOr("WETH", OP_STACK_WETH),
                v3Factory: vm.envOr("V3_FACTORY", UNICHAIN_V3_FACTORY),
                v3InitCodeHash: vm.envOr("V3_INIT_CODE_HASH", V3_INIT_CODE_HASH),
                v4PoolManager: vm.envOr("V4_POOL_MANAGER", _poolManager()),
                unbondDelay: vm.envOr("UNBOND_DELAY", uint256(2 days)),
                claimWindow: vm.envOr("CLAIM_WINDOW", uint256(10 minutes)),
                pools: vm.envOr("COURT_POOLS", ",", new bytes32[](0))
            })
        );
        vm.stopBroadcast();

        vm.startBroadcast(rpcKey);
        registry.bond{value: vm.envOr("BOND", uint256(10 ether))}();
        vm.stopBroadcast();

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            _write(verifier, registry, vm.addr(rpcKey));
        }
    }

    /// @dev The PoolManager DeployBlindfold used (its own one on a plain anvil), else Unichain's.
    function _poolManager() internal view returns (address) {
        string memory path = string.concat(vm.projectRoot(), "/../deployments/blindfold.local.json");
        if (!vm.exists(path)) return UNICHAIN_POOL_MANAGER;
        return vm.parseJsonAddress(vm.readFile(path), ".poolManager");
    }

    function _write(SandwichCourtVerifier verifier, BondRegistry registry, address rpcSigner) internal {
        string memory dir = string.concat(vm.projectRoot(), "/../deployments"); // kept in git by .gitkeep
        string memory k = "court";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", block.number);
        vm.serializeAddress(k, "verifier", address(verifier));
        vm.serializeAddress(k, "bondRegistry", address(registry));
        vm.writeJson(vm.serializeAddress(k, "rpcSigner", rpcSigner), string.concat(dir, "/court.local.json"));
    }
}
