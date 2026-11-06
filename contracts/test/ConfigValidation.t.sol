// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {BatchAuction} from "../src/BatchAuction.sol";
import {BlindfoldSettlement} from "../src/BlindfoldSettlement.sol";
import {BlindfoldVault} from "../src/BlindfoldVault.sol";
import {SealedPoolHook} from "../src/SealedPoolHook.sol";
import {AdmissionVault} from "../src/admission/AdmissionVault.sol";
import {AdmittedSettlement} from "../src/admission/AdmittedSettlement.sol";
import {HookDeployer} from "./utils/HookDeployer.sol";

contract NoopVerifier {
    function verifyProof(bytes calldata, uint256[2] calldata) external pure {}
    function verifyProof(bytes calldata, uint256[4] calldata) external pure {}
}

/// REVIEW S18 (configuration validation) and S17 (arithmetic domains), auction side. Court is out of scope here.
contract ConfigValidationTest is Test {
    uint64 constant START = 1_800_000_000; // START - drand genesis is a multiple of 3
    uint256 constant Q96 = 1 << 96;

    PoolManager manager;
    MockERC20 t0;
    MockERC20 t1;
    address treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(START);
        manager = new PoolManager(address(this));
        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        (t0, t1) = address(a) < address(b) ? (a, b) : (b, a);
    }

    function _config(BlindfoldVault vault) internal view returns (BlindfoldSettlement.Config memory) {
        return BlindfoldSettlement.Config({
            manager: manager,
            vault: vault,
            depositToken: address(t1),
            depositAmount: 5e18,
            bountyBps: 2_000,
            treasury: treasury,
            commitFee: 1e17,
            schedule: BatchAuction.Schedule(START, 30, 24, 30),
            toleranceBps: 100
        });
    }

    function _key(IHooks hook) internal view returns (PoolKey memory) {
        return PoolKey(Currency.wrap(address(t0)), Currency.wrap(address(t1)), 3000, 60, hook);
    }

    function _err(BatchAuction.ConfigField f) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(BatchAuction.InvalidAuctionConfig.selector, f);
    }

    // ---- constructor (base settlement)

    function test_constructor_acceptsAWorkingConfig() public {
        BlindfoldSettlement s = new BlindfoldSettlement(_config(new BlindfoldVault()));
        assertEq(s.toleranceBps(), 100);
    }

    function test_constructor_rejectsUnusableInputs() public {
        BlindfoldVault vault = new BlindfoldVault();
        BlindfoldSettlement.Config memory c;

        c = _config(BlindfoldVault(address(0xbeef)));
        vm.expectRevert(_err(BatchAuction.ConfigField.Vault));
        new BlindfoldSettlement(c);

        c = _config(vault);
        c.depositToken = address(0xbeef);
        vm.expectRevert(_err(BatchAuction.ConfigField.DepositToken));
        new BlindfoldSettlement(c);

        c = _config(vault);
        c.treasury = address(0);
        vm.expectRevert(_err(BatchAuction.ConfigField.Treasury));
        new BlindfoldSettlement(c);

        c = _config(vault);
        c.depositAmount = 0;
        vm.expectRevert(_err(BatchAuction.ConfigField.DepositAmount));
        new BlindfoldSettlement(c);

        c = _config(vault);
        c.depositAmount = uint256(type(uint128).max) + 1;
        vm.expectRevert(_err(BatchAuction.ConfigField.DepositAmount));
        new BlindfoldSettlement(c);

        c = _config(vault);
        c.commitFee = uint256(type(uint128).max) + 1;
        vm.expectRevert(_err(BatchAuction.ConfigField.CommitFee));
        new BlindfoldSettlement(c);

        c = _config(vault);
        c.schedule.revealLength = 0;
        vm.expectRevert(_err(BatchAuction.ConfigField.RevealLength));
        new BlindfoldSettlement(c);

        c = _config(vault);
        c.toleranceBps = 10_001;
        vm.expectRevert(_err(BatchAuction.ConfigField.ToleranceBps));
        new BlindfoldSettlement(c);

        c = _config(vault);
        c.bountyBps = 10_001;
        vm.expectRevert(bytes("config"));
        new BlindfoldSettlement(c);
    }

    /// The largest accepted deposit and bounty still settle their arithmetic exactly.
    function test_constructor_boundaryValuesAccepted() public {
        BlindfoldSettlement.Config memory c = _config(new BlindfoldVault());
        c.depositAmount = type(uint128).max;
        c.commitFee = type(uint128).max;
        c.bountyBps = 10_000;
        c.toleranceBps = 10_000;
        BlindfoldSettlement s = new BlindfoldSettlement(c);
        assertEq(s.depositAmount() * s.bountyBps() / 10_000, type(uint128).max);
    }

    // ---- initialize (base settlement)

    function test_initialize_rejectsBadKeys() public {
        BlindfoldSettlement s = new BlindfoldSettlement(_config(new BlindfoldVault()));
        PoolKey memory k = _key(IHooks(address(0)));

        // currencies out of order
        (k.currency0, k.currency1) = (k.currency1, k.currency0);
        vm.expectRevert(_err(BatchAuction.ConfigField.PoolKey));
        s.initialize(k);

        // native ETH (currency 0) is not an ERC-20
        k = _key(IHooks(address(0)));
        k.currency0 = Currency.wrap(address(0));
        vm.expectRevert(_err(BatchAuction.ConfigField.PoolKey));
        s.initialize(k);

        // the deposit token must be one of the pool's currencies
        MockERC20 other = new MockERC20("X", "X", 18);
        (address lo, address hi) =
            address(other) < address(t0) ? (address(other), address(t0)) : (address(t0), address(other));
        k = PoolKey(Currency.wrap(lo), Currency.wrap(hi), 3000, 60, IHooks(address(0))); // t0 and X, no t1
        vm.expectRevert(_err(BatchAuction.ConfigField.PoolKey));
        s.initialize(k);

        // only the admin, and only once
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(BlindfoldSettlement.Unauthorized.selector);
        s.initialize(_key(IHooks(address(0))));
        s.initialize(_key(IHooks(address(0))));
        vm.expectRevert(BlindfoldSettlement.AlreadyInitialized.selector);
        s.initialize(_key(IHooks(address(0))));
    }

    // ---- pre-start behavior

    function test_preStart_commitRevertsAndNothingIsDue() public {
        BlindfoldVault vault = new BlindfoldVault();
        BlindfoldSettlement.Config memory c = _config(vault);
        c.schedule.start = START + 300;
        BlindfoldSettlement s = new BlindfoldSettlement(c);
        vault.setOperator(address(s));
        s.initialize(_key(IHooks(address(0))));

        vm.expectRevert(BatchAuction.AuctionNotStarted.selector);
        s.commit(0, bytes32(0), hex"00");
        // batch 0 can't settle or expire before its own windows, which all lie after start
        uint256 opens = s.revealCloses(0);
        vm.expectRevert(
            abi.encodeWithSelector(BlindfoldSettlement.OutsideSettleWindow.selector, START, opens, opens + 30)
        );
        s.settle(0, Q96);
        vm.expectRevert(abi.encodeWithSelector(BlindfoldSettlement.NotExpired.selector, s.settleCloses(0)));
        s.expire(0);
        assertGt(s.revealOpens(0), c.schedule.start);
    }

    // ---- admitted deployment: the pair, hook and pool relationship

    function _admittedSetup() internal returns (AdmissionVault vault, AdmittedSettlement s, NoopVerifier v) {
        vault = new AdmissionVault(address(t0), address(t1));
        v = new NoopVerifier();
        s = new AdmittedSettlement(_config(vault), address(v), address(v));
    }

    function test_admitted_constructorRejectsMissingPieces() public {
        (AdmissionVault vault,, NoopVerifier v) = _admittedSetup();
        BlindfoldSettlement.Config memory c = _config(vault);

        vm.expectRevert(AdmittedSettlement.InvalidAdmissionConfig.selector);
        new AdmittedSettlement(c, address(0xbeef), address(v)); // verifier without code

        c.manager = IPoolManager(address(0xbeef));
        vm.expectRevert(AdmittedSettlement.InvalidAdmissionConfig.selector);
        new AdmittedSettlement(c, address(v), address(v));

        c = _config(vault);
        c.commitFee = 0; // proof-admitted commitments are released unpenalized, so the fee is their only cost
        vm.expectRevert(AdmittedSettlement.InvalidAdmissionConfig.selector);
        new AdmittedSettlement(c, address(v), address(v));

        c = _config(vault);
        c.depositToken = address(new MockERC20("X", "X", 18)); // not one of the vault's pair
        vm.expectRevert(AdmittedSettlement.InvalidAdmissionConfig.selector);
        new AdmittedSettlement(c, address(v), address(v));
    }

    function test_admitted_initializeRequiresTheSealedPool() public {
        (AdmissionVault vault, AdmittedSettlement s,) = _admittedSetup();

        // the vault's operator must be this settlement
        (SealedPoolHook hook,) = HookDeployer.deploySealed(address(this), address(manager), address(s));
        PoolKey memory k = _key(IHooks(address(hook)));
        manager.initialize(k, uint160(Q96));
        vm.expectRevert(AdmittedSettlement.InvalidAdmissionConfig.selector);
        s.initialize(k);
        vault.setOperator(address(s));

        // no hook at all: anyone could swap the pool
        PoolKey memory open = _key(IHooks(address(0)));
        manager.initialize(open, uint160(Q96));
        vm.expectRevert(AdmittedSettlement.InvalidAdmissionConfig.selector);
        s.initialize(open);

        // a sealed hook mined for another settlement
        (SealedPoolHook foreign,) = HookDeployer.deploySealed(address(this), address(manager), address(0xbeef));
        PoolKey memory wrong = _key(IHooks(address(foreign)));
        manager.initialize(wrong, uint160(Q96));
        vm.expectRevert(AdmittedSettlement.InvalidAdmissionConfig.selector);
        s.initialize(wrong);

        // the right hook on a pool nobody initialized (other fee tier)
        PoolKey memory fresh = _key(IHooks(address(hook)));
        fresh.fee = 500;
        fresh.tickSpacing = 10;
        vm.expectRevert(AdmittedSettlement.InvalidAdmissionConfig.selector);
        s.initialize(fresh);

        s.initialize(k);
        assertEq(s.token0(), address(t0));
    }

    // ---- S17: price arithmetic at the edges of the v4 domain

    /// quote() is exact over every uint128 amount and every v4 price, or reverts; it never wraps.
    function testFuzz_quote_exactOrReverts(uint128 amountIn, uint160 sqrtSeed, bool zeroForOne) public {
        BlindfoldSettlement s = new BlindfoldSettlement(_config(new BlindfoldVault()));
        uint160 sqrtP = uint160(bound(sqrtSeed, TickMath.MIN_SQRT_PRICE, TickMath.MAX_SQRT_PRICE - 1));
        uint256 p = FullMath.mulDiv(sqrtP, sqrtP, Q96);
        vm.assume(p != 0);
        BatchAuction.Order memory o = BatchAuction.Order(address(1), zeroForOne, amountIn, 0);
        // 2^128 * 2^224 / 2^96 = 2^256 is the only way out of range; check the exact value otherwise
        (bool ok, bytes memory ret) = address(s).staticcall(abi.encodeCall(s.quote, (o, p)));
        if (zeroForOne) {
            if (ok) assertEq(abi.decode(ret, (uint256)), FullMath.mulDiv(amountIn, p, Q96));
        } else {
            assertTrue(ok, "Q96 * amount / price always fits");
            assertEq(abi.decode(ret, (uint256)), FullMath.mulDiv(amountIn, Q96, p));
        }
    }

    /// The marginal-price check's products fit 256 bits for any v4 price once toleranceBps <= BPS.
    function test_marginalCheck_productsFit() public pure {
        uint256 maxP = FullMath.mulDiv(TickMath.MAX_SQRT_PRICE, TickMath.MAX_SQRT_PRICE, Q96);
        assertLt(maxP, uint256(1) << 225);
        // diff <= maxP and both factors are at most BPS
        assertLt(maxP * 10_000, type(uint256).max / 2);
    }

    /// A batch's aggregate input: at most MAX_COMMITS orders of uint128 each, far inside 256 bits and int256.
    function test_aggregateResidual_fitsSignedSwapAmount() public pure {
        uint256 total = 64 * uint256(type(uint128).max);
        assertLt(total, uint256(type(int256).max));
    }
}
