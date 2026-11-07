// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {BatchAuction} from "../../src/BatchAuction.sol";
import {BlindfoldSettlement} from "../../src/BlindfoldSettlement.sol";
import {AdmissionVault} from "../../src/admission/AdmissionVault.sol";
import {AdmissionProof} from "../../src/admission/AdmissionProof.sol";
import {AquaAdmittedSettlement} from "../../src/admission/AquaAdmittedSettlement.sol";
import {SealedPoolHook} from "../../src/SealedPoolHook.sol";
import {HookDeployer} from "../utils/HookDeployer.sol";
import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {BlindfoldAquaRouter} from "../../src/swapvm/BlindfoldAquaRouter.sol";
import {AquaResidual} from "../../src/swapvm/AquaResidual.sol";
import {ISwapVM} from "swap-vm/src/interfaces/ISwapVM.sol";
import {TakerTraitsLib} from "swap-vm/src/libs/TakerTraits.sol";

// Accounting tests use a verifier double; the real-proof CLI gate exercises generated verifiers separately.
contract AquaTestVerifier {
    function verifyProof(bytes calldata, uint256[2] calldata) external pure {}
    function verifyProof(bytes calldata, uint256[4] calldata) external pure {}
}

contract AquaSettlementTest is Test {
    uint256 constant Q96 = 1 << 96;
    uint64 constant START = 1800000000;
    IPoolManager manager;
    AdmissionVault vault;
    AquaAdmittedSettlement s;
    Aqua aqua;
    BlindfoldAquaRouter router;
    AquaResidual route;
    MockERC20 t0;
    MockERC20 t1;
    PoolKey key;
    bytes32 strategyHash;
    address maker = makeAddr("maker");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address treasury = makeAddr("treasury");

    function _manager() internal virtual returns (IPoolManager) {
        // PoolManager pins 0.8.26; SwapVM pins 0.8.30. Deploy its separately compiled artifact.
        return IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
    }

    function setUp() public virtual {
        manager = _manager();
        vm.warp(START);
        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        (t0, t1) = address(a) < address(b) ? (a, b) : (b, a);
        vault = new AdmissionVault(address(t0), address(t1));
        AquaTestVerifier verifier = new AquaTestVerifier();
        aqua = new Aqua();
        router = new BlindfoldAquaRouter(address(aqua), address(0), address(this));
        route = new AquaResidual(router, maker, 5000);
        s = new AquaAdmittedSettlement(
            BlindfoldSettlement.Config({
                manager: manager,
                vault: vault,
                depositToken: address(t1),
                depositAmount: 5e18,
                bountyBps: 2000,
                treasury: treasury,
                commitFee: 1,
                schedule: BatchAuction.Schedule(START, 30, 24, 30),
                toleranceBps: 100
            }),
            address(verifier),
            address(verifier),
            address(route)
        );
        vault.setOperator(address(s));
        (SealedPoolHook hook,) = HookDeployer.deploySealed(address(this), address(manager), address(s));
        key = PoolKey(Currency.wrap(address(t0)), Currency.wrap(address(t1)), 3000, 60, IHooks(address(hook)));
        manager.initialize(key, uint160(Q96));
        s.initialize(key);
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        t0.mint(address(this), 1e30);
        t1.mint(address(this), 1e30);
        t0.approve(address(lp), type(uint256).max);
        t1.approve(address(lp), type(uint256).max);
        lp.modifyLiquidity(key, IPoolManager.ModifyLiquidityParams(-60000, 60000, 1e22, 0), "");
        _fund(alice);
        _fund(bob);
        t0.mint(maker, 1e24);
        t1.mint(maker, 1e24);
        vm.startPrank(maker);
        t0.approve(address(aqua), type(uint256).max);
        t1.approve(address(aqua), type(uint256).max);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1e24;
        amounts[1] = 1e24;
        strategyHash = aqua.ship(address(router), abi.encode(route.order(address(s))), _tokens(), amounts);
        vm.stopPrank();
    }

    function _tokens() internal view returns (address[] memory tokens) {
        tokens = new address[](2);
        tokens[0] = address(t0);
        tokens[1] = address(t1);
    }

    function _fund(address owner) internal {
        t0.mint(owner, 1000e18);
        t1.mint(owner, 1000e18);
        vm.startPrank(owner);
        t0.approve(address(vault), type(uint256).max);
        t1.approve(address(vault), type(uint256).max);
        vault.deposit(address(t0), 1000e18);
        vault.deposit(address(t1), 1000e18);
        vm.stopPrank();
    }

    function _admit(address owner, bool direction, uint128 amount, uint128 minimum)
        internal
        returns (BatchAuction.Order memory o, uint256 id)
    {
        o = BatchAuction.Order(owner, direction, amount, minimum);
        (uint64 batch, bytes32 root, uint256 step) = s.admissionState(owner);
        AdmissionProof.Statement memory a = AdmissionProof.Statement({
            domain: AdmissionProof.DOMAIN,
            chainId: block.chainid,
            settlement: address(s),
            owner: owner,
            batch: batch,
            round: s.targetRound(batch),
            keyCommitment: bytes32(uint256(1)),
            network: AdmissionProof.NETWORK,
            step: step,
            oldRoot: root,
            newRoot: keccak256(abi.encode(owner, step + 1)),
            budget0: amount,
            budget1: amount,
            orderHash: s.orderHash(batch, o, bytes32(0)),
            ciphertextHash: keccak256(hex"aabb")
        });
        bytes memory p =
            abi.encode(a.domain, a.chainId, a.settlement, a.owner, a.batch, a.round, a.keyCommitment, a.network);
        vm.prank(owner);
        id = s.admit(batch, a.orderHash, hex"aabb", abi.encode(new bytes(384), p, new bytes(384), abi.encode(a)));
    }

    function _batch(bool sellHeavy, uint128 size) internal {
        (BatchAuction.Order memory a, uint256 idA) = _admit(alice, sellHeavy, size, 0);
        (BatchAuction.Order memory b, uint256 idB) = _admit(bob, !sellHeavy, size / 2, 0);
        vm.warp(s.revealOpens(0));
        s.reveal(idA, a, 0);
        s.reveal(idB, b, 0);
        vm.warp(s.revealCloses(0));
    }

    function _solve() internal returns (uint256 p) {
        uint256 pool = s.poolPriceX96();
        for (uint256 k; k <= 100; k++) {
            p = pool * (10000 - k) / 10000;
            try s.settle(0, p) {
                return p;
            } catch {}
            p = pool * (10000 + k) / 10000;
            try s.settle(0, p) {
                return p;
            } catch {}
        }
        revert("no combined candidate");
    }

    function _assertSolvent() internal view {
        address[6] memory accounts = [alice, bob, treasury, address(this), address(s), maker];
        for (uint256 j; j < 2; j++) {
            MockERC20 token = j == 0 ? t0 : t1;
            uint256 sum;
            for (uint256 i; i < accounts.length; i++) {
                sum += vault.balanceOf(accounts[i], address(token));
            }
            assertEq(token.balanceOf(address(vault)), sum);
            assertEq(token.balanceOf(address(s)), 0, "no residual tokens stranded");
            assertEq(token.balanceOf(address(route)), 0);
            assertEq(token.balanceOf(address(router)), 0);
        }
    }

    function test_sellResidual_movesMakerTokensAndClosesAccounts() public {
        _batch(true, 100e18);
        uint256 p = _solve();
        assertGt(t0.balanceOf(maker), 1e24);
        assertLt(t1.balanceOf(maker), 1e24);
        assertEq(vault.balanceOf(alice, address(t0)), 900e18);
        assertEq(vault.balanceOf(alice, address(t1)), 999e18 - 1 + 100e18 * p / Q96);
        assertEq(vault.openCommitments(alice), 0);
        assertEq(vault.openCommitments(bob), 0);
        assertEq(s.activeClearingPriceX96(address(t0), address(t1)), 0);
        vm.prank(alice);
        vault.withdraw(address(t0), 900e18);
        _assertSolvent();
    }

    function test_buyResidual_movesMakerTokensAndUsesDirectDivision() public {
        _batch(false, 100e18);
        uint256 p = _solve();
        assertGt(t1.balanceOf(maker), 1e24);
        assertLt(t0.balanceOf(maker), 1e24);
        assertEq(vault.balanceOf(alice, address(t0)), 1000e18 + 100e18 * Q96 / p);
        _assertSolvent();
    }

    function _assertFailedBatch() internal view {
        assertFalse(s.finalized(0));
        assertEq(s.clearingPriceX96(0), 0);
        assertEq(s.activeClearingPriceX96(address(t0), address(t1)), 0);
        assertEq(vault.lockedOf(alice, address(t0)), 100e18);
        assertEq(vault.openCommitments(alice), 1);
        assertEq(t0.balanceOf(maker), 1e24);
        assertEq(t1.balanceOf(maker), 1e24);
        _assertSolvent();
    }

    function test_revokedMakerAllowance_rollsBackAndExpires() public {
        _batch(true, 100e18);
        vm.prank(maker);
        t1.approve(address(aqua), 0);
        vm.expectRevert();
        s.settle(0, Q96 * 9950 / 10000);
        _assertFailedBatch();
        vm.warp(s.settleCloses(0));
        s.expire(0);
        vm.prank(alice);
        vault.withdraw(address(t0), 1000e18);
    }

    function test_dockedStrategy_rollsBack() public {
        _batch(true, 100e18);
        vm.prank(maker);
        aqua.dock(address(router), strategyHash, _tokens());
        vm.expectRevert();
        s.settle(0, Q96 * 9950 / 10000);
        _assertFailedBatch();
    }

    function test_missingMakerInventory_rollsBack() public {
        _batch(true, 100e18);
        vm.prank(maker);
        t1.transfer(bob, 1e24);
        vm.expectRevert();
        s.settle(0, Q96 * 9950 / 10000);
        assertFalse(s.finalized(0));
        assertEq(vault.lockedOf(alice, address(t0)), 100e18);
        _assertSolvent();
    }

    function test_badClearingPrice_rollsBackBothVenues() public {
        _batch(true, 100e18);
        vm.expectRevert();
        s.settle(0, Q96 * 9 / 10);
        _assertFailedBatch();
        vm.expectRevert();
        s.settle(0, Q96);
        _assertFailedBatch();
    }

    function test_externalCallerCannotExecuteHelperOrSettlementCallback() public {
        bytes memory data = abi.encode(true, 1e18, 1e18);
        vm.expectRevert(AquaResidual.Unauthorized.selector);
        route.unlockCallback(data);
        vm.expectRevert(BlindfoldSettlement.Unauthorized.selector);
        s.unlockCallback(data);
    }

    function test_outsiderCannotTakeShippedStrategy() public {
        TakerTraitsLib.Args memory t;
        t.isExactIn = true;
        t.useTransferFromAndAquaPush = true;
        ISwapVM.Order memory o = route.order(address(s));
        bytes memory data = TakerTraitsLib.build(t);
        vm.expectRevert();
        router.swap(o, address(t0), address(t1), 1e18, data);
    }

    function test_tinyResidualCannotSpendOldTokenDonations() public {
        (BatchAuction.Order memory a, uint256 id) = _admit(alice, true, 2, 0);
        vm.warp(s.revealOpens(0));
        s.reveal(id, a, 0);
        vm.warp(s.revealCloses(0));
        t1.mint(address(s), 100);
        // Each one-unit leg produces zero after its rounding/fee; the single unit owed is still a deficit.
        vm.expectRevert();
        s.settle(0, Q96 * 999 / 1000);
        assertFalse(s.finalized(0));
        assertEq(t1.balanceOf(address(s)), 100);
        assertEq(vault.lockedOf(alice, address(t0)), 2);
    }

    function test_noActiveBatchRejectsTheAuthorizedTaker() public {
        TakerTraitsLib.Args memory t;
        t.isExactIn = true;
        t.useTransferFromAndAquaPush = true;
        ISwapVM.Order memory o = route.order(address(s));
        bytes memory data = TakerTraitsLib.build(t);
        vm.prank(address(s));
        vm.expectRevert();
        router.swap(o, address(t0), address(t1), 1e18, data);
    }

    function test_partialGroupUsesBothVenuesAndUnlocksRemainder() public {
        (BatchAuction.Order memory a, uint256 idA) = _admit(alice, true, 100e18, 99e18);
        (BatchAuction.Order memory b, uint256 idB) = _admit(bob, true, 100e18, 99e18);
        vm.warp(s.revealOpens(0));
        s.reveal(idA, a, 0);
        s.reveal(idB, b, 0);
        vm.warp(s.revealCloses(0));
        s.settle(0, (Q96 * 99 + 99) / 100, idA, 10e18);
        assertEq(vault.balanceOf(alice, address(t0)), 990e18);
        assertEq(vault.balanceOf(bob, address(t0)), 990e18);
        assertEq(vault.lockedOf(alice, address(t0)), 0);
        assertGt(t0.balanceOf(maker), 1e24);
        _assertSolvent();
    }

    function test_smallResidualHasNoUnaccountedRounding() public {
        _batch(true, 1000);
        _solve();
        _assertSolvent();
    }

    function test_routeConfigRequiresMakerAndBothVenues() public {
        vm.expectRevert(AquaResidual.AquaConfig.selector);
        new AquaResidual(router, address(0), 5000);
        vm.expectRevert(AquaResidual.AquaConfig.selector);
        new AquaResidual(router, maker, 0);
        vm.expectRevert(AquaResidual.AquaConfig.selector);
        new AquaResidual(router, maker, 10000);
    }

    function test_deploymentSizeAndAdmissionPolicy() public view {
        assertLe(address(s).code.length, 24576);
        assertLe(address(route).code.length, 24576);
        assertTrue(s.admissionRequired());
        assertEq(s.aquaRoute(), address(route));
    }

    function testFuzz_bothDirectionsStaySolvent(uint96 amount, bool sellHeavy) public {
        uint128 size = uint128(bound(amount, 1e17, 100e18));
        _batch(sellHeavy, size);
        _solve();
        _assertSolvent();
    }
}
