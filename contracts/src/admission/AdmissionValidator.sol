// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AdmissionProof} from "./AdmissionProof.sol";
import {SealedPoolHook} from "../SealedPoolHook.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {AdmissionVault} from "./AdmissionVault.sol";
import {BlindfoldVault} from "../BlindfoldVault.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

interface IAdmissionState {
    function vault() external view returns (BlindfoldVault);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function targetRound(uint64 batch) external view returns (uint64);
    function activeBatch(address owner) external view returns (uint64);
    function fundingRoot(address owner) external view returns (bytes32);
}

/// @notice Stateless admission validation; funding and commitment state remain in the settlement.
contract AdmissionValidator {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    error InvalidAdmissionConfig();
    error AdmissionContext();
    error FundingState();
    error FundingBudget();

    address private immutable preparation;
    address private immutable online;

    constructor(address preparation_, address online_) {
        preparation = preparation_;
        online = online_;
    }

    /// @notice Check that the caller's fixed vault pair and initialized pool use its sealed hook.
    function validatePool(IPoolManager manager, AdmissionVault vault, PoolKey calldata k) external view {
        if (
            Currency.unwrap(k.currency0) != vault.token0() || Currency.unwrap(k.currency1) != vault.token1()
                || vault.operator() != msg.sender
                || uint160(address(k.hooks)) & Hooks.ALL_HOOK_MASK != Hooks.BEFORE_SWAP_FLAG
        ) revert InvalidAdmissionConfig();
        SealedPoolHook h = SealedPoolHook(address(k.hooks));
        if (h.manager() != address(manager) || h.settlement() != msg.sender) revert InvalidAdmissionConfig();
        (uint160 price,,,) = manager.getSlot0(k.toId());
        if (price == 0) revert InvalidAdmissionConfig();
    }

    /// @notice Validate after the caller reserves this commitment; return the new root and prior step.
    function verify(bytes calldata proof, address owner, uint64 batch, bytes32 hash, bytes32 ciphertextHash)
        external
        view
        returns (bytes32 newRoot, uint256 step)
    {
        IAdmissionState settlement = IAdmissionState(msg.sender);
        (AdmissionProof.Pair memory p, AdmissionProof.Statement memory a) = AdmissionProof.decode(proof);
        if (
            a.chainId != block.chainid || a.settlement != msg.sender || a.owner != owner || a.batch != batch
                || a.round != settlement.targetRound(batch) || a.orderHash != hash || a.ciphertextHash != ciphertextHash
        ) revert AdmissionContext();
        BlindfoldVault vault = settlement.vault();
        // _commit has already opened exactly one reservation. No state is kept by this helper.
        step = vault.openCommitments(owner) - 1;
        if (
            a.step != step
                || (step == 0
                        ? a.oldRoot != bytes32(0)
                        : settlement.activeBatch(owner) != batch || a.oldRoot != settlement.fundingRoot(owner))
        ) revert FundingState();
        if (
            a.budget0 > vault.freeBalance(owner, settlement.token0())
                || a.budget1 > vault.freeBalance(owner, settlement.token1())
        ) revert FundingBudget();
        AdmissionProof.verify(p, a, preparation, online);
        return (a.newRoot, step);
    }
}
