// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {BatchAuction} from "../../src/BatchAuction.sol";
import {BlindfoldSettlement} from "../../src/BlindfoldSettlement.sol";
import {BlindfoldVault} from "../../src/BlindfoldVault.sol";
import {AdmissionVault} from "../../src/admission/AdmissionVault.sol";
import {AdmittedSettlement} from "../../src/admission/AdmittedSettlement.sol";
import {AdmissionProof} from "../../src/admission/AdmissionProof.sol";
import {AdmissionValidator} from "../../src/admission/AdmissionValidator.sol";
import {SealedPoolHook} from "../../src/SealedPoolHook.sol";
import {HookDeployer} from "../utils/HookDeployer.sol";

// These tests isolate settlement accounting/context from cryptography. Real generated verifier
// integration is tested separately; this double deliberately checks the exact derived inputs.
contract StatementVerifier {
    bytes32 public expected;
    bool public reject;

    function configure(bytes32 value, bool fail) external {
        expected = value;
        reject = fail;
    }

    function verifyProof(bytes calldata, uint256[2] calldata inputs) external view {
        require(!reject && keccak256(abi.encode(inputs)) == expected, "preparation rejected");
    }

    function verifyProof(bytes calldata, uint256[4] calldata inputs) external view {
        require(!reject && keccak256(abi.encode(inputs)) == expected, "online rejected");
    }
}

contract AdmittedSettlementTest is Test {
    uint64 constant START = 1800000000;
    AdmissionVault vault;
    AdmittedSettlement s;
    MockERC20 t0;
    MockERC20 t1;
    StatementVerifier prep;
    StatementVerifier online;
    address alice = makeAddr("alice");
    address treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(START);
        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        (t0, t1) = address(a) < address(b) ? (a, b) : (b, a);
        vault = new AdmissionVault(address(t0), address(t1));
        prep = new StatementVerifier();
        online = new StatementVerifier();
        IPoolManager manager = new PoolManager(address(this));
        s = new AdmittedSettlement(
            BlindfoldSettlement.Config({
                manager: manager,
                vault: vault,
                depositToken: address(t1),
                depositAmount: 5,
                bountyBps: 2000,
                treasury: treasury,
                commitFee: 1,
                schedule: BatchAuction.Schedule(START, 30, 24, 30),
                toleranceBps: 100
            }),
            address(prep),
            address(online)
        );
        vault.setOperator(address(s));
        (SealedPoolHook hook,) = HookDeployer.deploySealed(address(this), address(manager), address(s));
        PoolKey memory key =
            PoolKey(Currency.wrap(address(t0)), Currency.wrap(address(t1)), 3000, 60, IHooks(address(hook)));
        manager.initialize(key, uint160(1 << 96));
        s.initialize(key);
        t0.mint(alice, 1000);
        t1.mint(alice, 1000);
        vm.startPrank(alice);
        t0.approve(address(vault), 1000);
        t1.approve(address(vault), 1000);
        vault.deposit(address(t0), 100);
        vault.deposit(address(t1), 100);
        vm.stopPrank();
    }

    function statement() internal view returns (AdmissionProof.Statement memory a) {
        (uint64 batch, bytes32 root, uint256 step) = s.admissionState(alice);
        a = AdmissionProof.Statement({
            domain: AdmissionProof.DOMAIN,
            chainId: block.chainid,
            settlement: address(s),
            owner: alice,
            batch: batch,
            round: s.targetRound(batch),
            keyCommitment: bytes32(uint256(1)),
            network: AdmissionProof.NETWORK,
            step: step,
            oldRoot: root,
            newRoot: keccak256(abi.encode(step + 1)),
            budget0: 100,
            budget1: 100 - (step + 1) * 6,
            orderHash: keccak256(abi.encode(step)),
            ciphertextHash: keccak256(hex"aabb")
        });
    }

    function proof(AdmissionProof.Statement memory a) internal returns (bytes memory) {
        bytes memory p =
            abi.encode(a.domain, a.chainId, a.settlement, a.owner, a.batch, a.round, a.keyCommitment, a.network);
        bytes memory o = abi.encode(a);
        bytes32 pd = keccak256(p);
        bytes32 od = keccak256(o);
        bytes32 fd = keccak256(
            abi.encode(
                a.chainId,
                a.settlement,
                a.owner,
                a.batch,
                a.step,
                a.oldRoot,
                a.newRoot,
                a.budget0,
                a.budget1,
                a.orderHash
            )
        );
        prep.configure(
            keccak256(abi.encode([uint256(uint128(uint256(pd) >> 128)), uint256(uint128(uint256(pd)))])), false
        );
        online.configure(
            keccak256(
                abi.encode(
                    [
                        uint256(uint128(uint256(od) >> 128)),
                        uint256(uint128(uint256(od))),
                        uint256(uint128(uint256(fd) >> 128)),
                        uint256(uint128(uint256(fd)))
                    ]
                )
            ),
            false
        );
        return abi.encode(new bytes(384), p, new bytes(384), o);
    }

    function admit(AdmissionProof.Statement memory a) internal returns (uint256) {
        bytes memory p = proof(a);
        vm.prank(alice);
        return s.admit(uint64(a.batch), a.orderHash, hex"aabb", p);
    }

    function assertUntouched() internal view {
        assertEq(s.commitCount(), 0);
        assertEq(vault.openCommitments(alice), 0);
        assertEq(vault.balanceOf(alice, address(t1)), 100);
        assertEq(vault.balanceOf(treasury, address(t1)), 0);
        assertEq(s.fundingRoot(alice), bytes32(0));
    }

    function test_deployedContractsRespectEip170() public {
        assertLe(address(s).code.length, 24_576, "enforced settlement exceeds EIP-170");
        AdmissionValidator validator = new AdmissionValidator(address(prep), address(online));
        assertLe(address(validator).code.length, 24_576, "admission validator exceeds EIP-170");
    }

    function test_initializeStillChecksPairHookAndPool() public {
        PoolKey memory key = s.poolKey();
        key.currency0 = Currency.wrap(address(123));
        vm.expectRevert(AdmittedSettlement.InvalidAdmissionConfig.selector);
        s.initialize(key);
        key = s.poolKey();
        key.hooks = IHooks(address(0));
        vm.expectRevert(AdmittedSettlement.InvalidAdmissionConfig.selector);
        s.initialize(key);
        key = s.poolKey();
        (SealedPoolHook wrongHook,) = HookDeployer.deploySealed(address(this), address(s.manager()), address(123));
        key.hooks = IHooks(address(wrongHook));
        vm.expectRevert(AdmittedSettlement.InvalidAdmissionConfig.selector);
        s.initialize(key);
        key = s.poolKey();
        key.fee = 500; // This pool has never been initialized.
        vm.expectRevert(AdmittedSettlement.InvalidAdmissionConfig.selector);
        s.initialize(key);
        key = s.poolKey();
        vm.prank(alice);
        vm.expectRevert(BlindfoldSettlement.Unauthorized.selector);
        s.initialize(key);
        vm.expectRevert(BlindfoldSettlement.AlreadyInitialized.selector);
        s.initialize(key);
    }

    function test_failedAppendPreservesExistingFundingAndFees() public {
        admit(statement());
        bytes32 root = s.fundingRoot(alice);
        uint256 balance = vault.balanceOf(alice, address(t1));
        AdmissionProof.Statement memory a = statement();
        bytes memory p = proof(a);
        online.configure(bytes32(0), true);
        vm.prank(alice);
        vm.expectRevert("online rejected");
        s.admit(0, a.orderHash, hex"aabb", p);
        assertEq(s.commitCount(), 1);
        assertEq(s.commitIdsOf(0).length, 1);
        assertEq(vault.openCommitments(alice), 1);
        assertEq(vault.balanceOf(alice, address(t1)), balance);
        assertEq(vault.balanceOf(treasury, address(t1)), 1);
        assertEq(s.fundingRoot(alice), root);
        admit(a);
        assertEq(vault.openCommitments(alice), 2);
    }

    function test_wrongFundingRootRejectedAfterReservation() public {
        admit(statement());
        AdmissionProof.Statement memory a = statement();
        a.oldRoot = bytes32(uint256(123));
        bytes memory p = proof(a);
        vm.prank(alice);
        vm.expectRevert(AdmittedSettlement.FundingState.selector);
        s.admit(0, a.orderHash, hex"aabb", p);
        assertEq(s.commitCount(), 1);
        assertEq(vault.openCommitments(alice), 1);
        assertEq(vault.balanceOf(treasury, address(t1)), 1);
    }

    function test_appendAndReplayProtection() public {
        AdmissionProof.Statement memory a = statement();
        bytes memory p = proof(a);
        vm.prank(alice);
        s.admit(0, a.orderHash, hex"aabb", p);
        assertEq(vault.openCommitments(alice), 1);
        assertEq(s.fundingRoot(alice), a.newRoot);
        vm.prank(alice);
        vm.expectRevert(AdmittedSettlement.FundingState.selector);
        s.admit(0, a.orderHash, hex"aabb", p);
        admit(statement());
        assertEq(vault.openCommitments(alice), 2);
        assertEq(vault.balanceOf(treasury, address(t1)), 2);
    }

    function test_uncheckedCommitCannotBypass() public {
        vm.prank(alice);
        vm.expectRevert(BatchAuction.AdmissionRequired.selector);
        s.commit(0, bytes32(0), hex"00");
        assertUntouched();
    }

    function test_budgetUsesBalanceAfterFeeAndDeposit() public {
        AdmissionProof.Statement memory a = statement();
        a.budget1 = 95;
        bytes memory p = proof(a);
        vm.prank(alice);
        vm.expectRevert(AdmittedSettlement.FundingBudget.selector);
        s.admit(0, a.orderHash, hex"aabb", p);
        assertUntouched();
        vm.prank(alice);
        vault.deposit(address(t1), 1);
        admit(a);
        assertEq(vault.freeBalance(alice, address(t1)), 95);
    }

    function test_failedEitherProofRollsBackAllAccounting() public {
        AdmissionProof.Statement memory a = statement();
        bytes memory p = proof(a);
        online.configure(bytes32(0), true);
        vm.prank(alice);
        vm.expectRevert("online rejected");
        s.admit(0, a.orderHash, hex"aabb", p);
        assertUntouched();
        p = proof(a);
        prep.configure(bytes32(0), true);
        vm.prank(alice);
        vm.expectRevert("preparation rejected");
        s.admit(0, a.orderHash, hex"aabb", p);
        assertUntouched();
    }

    function test_contextAndCiphertextAreBound() public {
        AdmissionProof.Statement memory a = statement();
        for (uint256 i; i < 7; i++) {
            AdmissionProof.Statement memory bad = statement();
            if (i == 0) bad.chainId++;
            if (i == 1) bad.settlement = address(123);
            if (i == 2) bad.owner = address(123);
            if (i == 3) bad.batch++;
            if (i == 4) bad.round++;
            if (i == 5) bad.orderHash = bytes32(uint256(123));
            if (i == 6) bad.ciphertextHash = bytes32(uint256(123));
            bytes memory p = proof(bad);
            vm.prank(alice);
            vm.expectRevert(AdmittedSettlement.AdmissionContext.selector);
            s.admit(0, a.orderHash, hex"aabb", p);
            assertUntouched();
        }
    }

    function test_noncanonicalProofRejected() public {
        AdmissionProof.Statement memory a = statement();
        bytes memory p = bytes.concat(proof(a), hex"00");
        vm.prank(alice);
        vm.expectRevert(AdmissionProof.InvalidEncoding.selector);
        s.admit(0, a.orderHash, hex"aabb", p);
        assertUntouched();
    }

    function test_cannotWithdrawOrSwitchBatchWhileOpen() public {
        admit(statement());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BlindfoldVault.OpenCommitments.selector, alice, 1));
        vault.withdraw(address(t0), 1);
        vm.warp(START + 30);
        AdmissionProof.Statement memory a = statement();
        a.batch = 1;
        a.round = s.targetRound(1);
        bytes memory p = proof(a);
        vm.prank(alice);
        vm.expectRevert(AdmittedSettlement.FundingState.selector);
        s.admit(1, a.orderHash, hex"aabb", p);
    }

    function test_releaseResetsEffectiveStateAndAllowsNextBatch() public {
        uint256 id = admit(statement());
        vm.warp(s.revealCloses(0));
        s.slashUnrevealed(id);
        (uint64 batch, bytes32 root, uint256 step) = s.admissionState(alice);
        assertEq(batch, 0);
        assertEq(root, bytes32(0));
        assertEq(step, 0);
        AdmissionProof.Statement memory a = statement();
        a.batch = s.currentBatch();
        a.round = s.targetRound(uint64(a.batch));
        a.budget1 = vault.freeBalance(alice, address(t1)) - 6;
        admit(a);
        assertEq(vault.openCommitments(alice), 1);
    }

    function test_prestartRejectedWithoutAccounting() public {
        AdmissionProof.Statement memory a = statement();
        bytes memory p = proof(a);
        vm.warp(START - 1);
        vm.prank(alice);
        vm.expectRevert(BatchAuction.AuctionNotStarted.selector);
        s.admit(0, a.orderHash, hex"aabb", p);
        assertUntouched();
    }

    function test_unsupportedTokenDepositRejected() public {
        MockERC20 other = new MockERC20("X", "X", 18);
        other.mint(address(this), 1);
        other.approve(address(vault), 1);
        vm.expectRevert(AdmissionVault.UnsupportedToken.selector);
        vault.deposit(address(other), 1);
        assertEq(vault.balanceOf(address(this), address(other)), 0);
    }
}
