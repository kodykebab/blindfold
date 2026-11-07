// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {DeployBlindfold} from "../script/DeployBlindfold.s.sol";
import {BlindfoldVault} from "../src/BlindfoldVault.sol";
import {AquaAdmittedSettlement} from "../src/admission/AquaAdmittedSettlement.sol";
import {AdmittedSettlement} from "../src/admission/AdmittedSettlement.sol";
import {SealedPoolHook} from "../src/SealedPoolHook.sol";
import {IExternalMarket} from "../src/market/IExternalMarket.sol";
import {HookDeployer} from "./utils/HookDeployer.sol";
import {MockExternalMarket} from "./utils/MockExternalMarket.sol";

contract StubVerifier {}

/// FIXES.md fix 7 / REVIEW S18: the deploy script wires a working deployment and refuses broken ones.
contract DeployBlindfoldTest is Test {
    DeployBlindfold script;

    function setUp() public {
        vm.warp(1_800_000_000);
        script = new DeployBlindfold();
    }

    /// A field-by-field copy: assigning a memory struct only aliases it.
    function _copy(DeployBlindfold.Deployment memory d) internal pure returns (DeployBlindfold.Deployment memory c) {
        c = DeployBlindfold.Deployment(
            d.admitted,
            d.token0,
            d.token1,
            d.manager,
            d.vault,
            d.settlement,
            d.hook,
            d.key,
            d.market,
            d.marketKind,
            d.preparationVerifier,
            d.onlineVerifier,
            d.aquaRoute
        );
    }

    /// The environment defaults, with nothing set: what a plain `forge script` run uses locally.
    function _params() internal view returns (DeployBlindfold.Params memory p) {
        p = script.params();
    }

    function test_localDeploymentIsWiredAndPassesItsChecks() public {
        DeployBlindfold.Deployment memory d = script.deploy(_params(), address(this));
        assertFalse(d.admitted);
        assertEq(address(d.settlement.vault()), address(d.vault));
        assertEq(d.vault.operator(), address(d.settlement));
        assertEq(address(d.settlement.externalMarket()), address(d.market));
        assertEq(d.marketKind, "mock");
        // defaults from the replay
        assertEq(d.settlement.batchLength(), 120);
        assertEq(d.settlement.settleLength(), 120);
        assertEq(d.settlement.revealLength(), 24);
        assertEq((d.settlement.start() - 1692803367) % 3, 0, "start on a drand round");
        assertGt(d.settlement.start(), block.timestamp);
        script.check(d);
    }

    function test_admittedDeploymentUsesTheFixedPairAndVerifiers() public {
        address prep = address(new StubVerifier());
        address online = address(new StubVerifier());
        DeployBlindfold.Params memory p = _params();
        (p.admitted, p.preparationVerifier, p.onlineVerifier) = (true, prep, online);
        DeployBlindfold.Deployment memory d = script.deploy(p, address(this));
        assertTrue(d.admitted);
        assertTrue(d.settlement.admissionRequired());
        assertEq(AdmittedSettlement(address(d.settlement)).preparationVerifier(), prep);
        assertEq(AdmittedSettlement(address(d.settlement)).onlineVerifier(), online);
        script.check(d);
    }

    function test_aquaDeploymentPinsRouteAndUsesSealedPriceValidation() public {
        address registry = deployCode("Aqua.sol:Aqua");
        address router =
            deployCode("BlindfoldAquaRouter.sol:BlindfoldAquaRouter", abi.encode(registry, address(0), address(this)));
        address route = deployCode("AquaResidual.sol:AquaResidual", abi.encode(router, address(this), uint256(5000)));
        DeployBlindfold.Params memory p = _params();
        p.admitted = true;
        p.preparationVerifier = address(new StubVerifier());
        p.onlineVerifier = address(new StubVerifier());
        p.aquaRoute = route;
        vm.expectRevert(bytes("Aqua requires ADMISSION=on and MARKET=none"));
        script.deploy(p, address(this));
        p.marketKind = "none";
        DeployBlindfold.Deployment memory d = script.deploy(p, address(this));
        assertEq(AquaAdmittedSettlement(address(d.settlement)).aquaRoute(), route);
        assertEq(address(d.settlement.externalMarket()), address(0));
        script.check(d);
        p.admitted = false;
        vm.expectRevert(bytes("Aqua requires ADMISSION=on and MARKET=none"));
        script.deploy(p, address(this));
    }

    function test_checksRejectBrokenRelationships() public {
        DeployBlindfold.Deployment memory d = script.deploy(_params(), address(this));
        DeployBlindfold.Deployment memory bad;

        bad = _copy(d);
        bad.vault = new BlindfoldVault();
        vm.expectRevert(bytes("vault operator is not the settlement"));
        script.check(bad);

        // a sealed hook mined for some other settlement
        bad = _copy(d);
        (bad.hook,) = HookDeployer.deploySealed(address(this), address(d.manager), address(0xbeef));
        vm.expectRevert(bytes("hook is bound to another settlement or manager"));
        script.check(bad);

        // the right hook, but a pool nobody initialized
        bad = _copy(d);
        bad.key = PoolKey(d.key.currency0, d.key.currency1, 500, 10, IHooks(address(d.hook)));
        vm.expectRevert(bytes("pool is not initialized"));
        script.check(bad);

        // a market wired to another settlement
        bad = _copy(d);
        bad.market = IExternalMarket(address(new MockExternalMarket(address(0xbeef), d.token0, d.token1)));
        vm.expectRevert(bytes("settlement does not use the market"));
        script.check(bad);
    }

    function test_constructorChecksStillGuardTheConfig() public {
        DeployBlindfold.Params memory p = _params();
        p.settleLength = 240; // settlement windows must not overlap the next batch
        vm.expectRevert(abi.encodeWithSignature("InvalidSettlementWindow(uint256,uint256)", 240, 120));
        script.deploy(p, address(this));
        p = _params();
        p.admitted = true; // without verifier addresses
        vm.expectRevert(bytes("admission needs both verifier addresses"));
        script.deploy(p, address(this));
    }
}
