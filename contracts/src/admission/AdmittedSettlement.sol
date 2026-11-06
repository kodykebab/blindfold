// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BlindfoldSettlement} from "../BlindfoldSettlement.sol";
import {AdmissionVault} from "./AdmissionVault.sol";
import {AdmissionValidator} from "./AdmissionValidator.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

/// @notice Proof-enforced admission sharing the ordinary reveal/settle/expire lifecycle.
contract AdmittedSettlement is BlindfoldSettlement {
    error InvalidAdmissionConfig();
    error AdmissionContext();
    error FundingState();
    error FundingBudget();

    address public immutable preparationVerifier;
    address public immutable onlineVerifier;
    AdmissionValidator private immutable admissionValidator;
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
        admissionValidator = new AdmissionValidator(preparation, online);
    }

    /// @notice Proofs are mandatory for every commitment in this deployment.
    function admissionRequired() public pure override returns (bool) {
        return true;
    }

    /// @notice Bind the fixed vault pair to an initialized sealed pool and this settlement.
    function initialize(PoolKey calldata k) public override {
        admissionValidator.validatePool(manager, AdmissionVault(address(vault)), k);
        super.initialize(k);
    }

    /// @dev initialize already pins the key to the vault's ordered pair, which holds the deposit token (constructor),
    ///      so the base key check would only repeat it; skipping it keeps this contract under the EIP-170 size limit.
    function _checkPoolKey(PoolKey calldata) internal pure override {}

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
        // Reuse the sole accounting/event path. Failed validation reverts fees and reservations too.
        id = _commit(batchId, hash, ciphertext);
        (bytes32 root, uint256 step) =
            admissionValidator.verify(proof, msg.sender, batchId, hash, keccak256(ciphertext));
        activeBatch[msg.sender] = batchId;
        fundingRoot[msg.sender] = root;
        emit FundingAdvanced(msg.sender, batchId, step + 1, root);
    }
}
