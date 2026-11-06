// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BlindfoldSettlement} from "../BlindfoldSettlement.sol";
import {SealedPoolHook} from "../SealedPoolHook.sol";
import {AdmissionVault} from "./AdmissionVault.sol";
import {AdmissionProof} from "./AdmissionProof.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";

/// @notice Proof-enforced admission sharing the ordinary reveal/settle/expire lifecycle.
contract AdmittedSettlement is BlindfoldSettlement {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    error InvalidAdmissionConfig();
    error AdmissionContext();
    error FundingState();
    error FundingBudget();

    address public immutable preparationVerifier;
    address public immutable onlineVerifier;
    mapping(address => uint64) public activeBatch;
    mapping(address => bytes32) public fundingRoot;

    event FundingAdvanced(address indexed owner, uint64 indexed batchId, uint256 step, bytes32 root);

    constructor(Config memory c, address preparation, address online) BlindfoldSettlement(c) {
        if (
            preparation.code.length == 0 || online.code.length == 0 || c.manager == IPoolManager(address(0))
                || address(c.manager).code.length == 0 || c.treasury == address(0) || c.depositAmount == 0
                || c.depositAmount > type(uint128).max || c.commitFee == 0 || c.commitFee > type(uint128).max
                || c.toleranceBps > BPS || c.schedule.revealLength == 0 || block.chainid > type(uint64).max
        ) {
            revert InvalidAdmissionConfig();
        }
        AdmissionVault v = AdmissionVault(address(c.vault));
        if (c.depositToken != v.token0() && c.depositToken != v.token1()) revert InvalidAdmissionConfig();
        preparationVerifier = preparation;
        onlineVerifier = online;
    }

    /// @notice Proofs are mandatory for every commitment in this deployment.
    function admissionRequired() public pure override returns (bool) {
        return true;
    }

    /// @notice Bind the fixed vault pair to an initialized sealed pool and this settlement.
    function initialize(PoolKey calldata k) public override {
        AdmissionVault v = AdmissionVault(address(vault));
        if (
            Currency.unwrap(k.currency0) != v.token0() || Currency.unwrap(k.currency1) != v.token1()
                || vault.operator() != address(this)
                || uint160(address(k.hooks)) & Hooks.ALL_HOOK_MASK != Hooks.BEFORE_SWAP_FLAG
        ) {
            revert InvalidAdmissionConfig();
        }
        SealedPoolHook h = SealedPoolHook(address(k.hooks));
        if (h.manager() != address(manager) || h.settlement() != address(this)) revert InvalidAdmissionConfig();
        (uint160 price,,,) = manager.getSlot0(k.toId());
        if (price == 0) revert InvalidAdmissionConfig();
        super.initialize(k);
    }

    /// @notice Read the effective root/step; fully closed accounts restart from canonical zero.
    function admissionState(address owner) external view returns (uint64 batch, bytes32 root, uint256 step) {
        step = vault.openCommitments(owner);
        if (step != 0) return (activeBatch[owner], fundingRoot[owner], step);
    }

    /// @notice Accept proof-bound ciphertext and reserve cumulative private input capacity atomically.
    function admit(uint64 batchId, bytes32 hash, bytes calldata ciphertext, bytes calldata proof)
        external
        returns (uint256 id)
    {
        if (token0 == address(0) || ciphertext.length > 2048) revert AdmissionContext();
        (AdmissionProof.Pair memory p, AdmissionProof.Statement memory a) = AdmissionProof.decode(proof);
        uint256 step = vault.openCommitments(msg.sender);
        if (
            a.chainId != block.chainid || a.settlement != address(this) || a.owner != msg.sender || a.batch != batchId
                || a.round != targetRound(batchId) || a.orderHash != hash || a.ciphertextHash != keccak256(ciphertext)
        ) revert AdmissionContext();
        if (
            a.step != step
                || (step == 0
                        ? a.oldRoot != bytes32(0)
                        : activeBatch[msg.sender] != batchId || a.oldRoot != fundingRoot[msg.sender])
        ) revert FundingState();
        // Reuse the sole accounting/event path. Any later failure rolls all of it back.
        id = _commit(batchId, hash, ciphertext);
        if (a.budget0 > vault.freeBalance(msg.sender, token0) || a.budget1 > vault.freeBalance(msg.sender, token1)) {
            revert FundingBudget();
        }
        AdmissionProof.verify(p, a, preparationVerifier, onlineVerifier);
        activeBatch[msg.sender] = batchId;
        fundingRoot[msg.sender] = a.newRoot;
        emit FundingAdvanced(msg.sender, batchId, step + 1, a.newRoot);
    }
}
