// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AdmittedSettlementTest} from "./AdmittedSettlement.t.sol";
import {AdmissionProof} from "../../src/admission/AdmissionProof.sol";
import {BatchAuction} from "../../src/BatchAuction.sol";
import {MockExternalMarket} from "../utils/MockExternalMarket.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

/// @notice Admission accounting and public routing compose on the same deployed settlement.
contract AdmittedExternalTest is AdmittedSettlementTest {
    function test_admittedSellExternalRollbackAndRetry() public {
        _externalRoundTrip(true);
    }

    function test_admittedBuyExternalRollbackAndRetry() public {
        _externalRoundTrip(false);
    }

    function _externalRoundTrip(bool sell) internal {
        MockExternalMarket market = new MockExternalMarket(address(s), address(t0), address(t1));
        s.configureExternal(market);
        t0.mint(address(market), 1000);
        t1.mint(address(market), 1000);
        BatchAuction.Order memory order = BatchAuction.Order(alice, sell, 10, 10);
        bytes32 salt = bytes32(uint256(1));
        AdmissionProof.Statement memory a = statement();
        a.orderHash = s.orderHash(0, order, salt);
        uint256 id = admit(a);
        vm.warp(s.revealOpens(0));
        vm.prank(alice);
        s.reveal(id, order, salt);
        vm.warp(s.revealCloses(0));

        MockERC20 input = sell ? t0 : t1;
        MockERC20 output = sell ? t1 : t0;
        uint256 beforeInput = vault.balanceOf(alice, address(input));
        uint256 beforeOutput = vault.balanceOf(alice, address(output));
        market.setMaxInput(9);
        vm.expectRevert("capacity exceeded");
        s.settleExternal(0, 1 << 96);
        assertFalse(s.finalized(0));
        assertEq(vault.openCommitments(alice), 1);
        assertEq(vault.lockedOf(alice, address(input)), 10);
        assertEq(vault.balanceOf(alice, address(input)), beforeInput);
        assertEq(vault.balanceOf(alice, address(output)), beforeOutput);
        assertEq(input.balanceOf(address(market)), 1000);
        assertEq(s.fundingRoot(alice), a.newRoot);

        market.setMaxInput(0);
        s.settleExternal(0, 1 << 96);
        assertTrue(s.finalized(0));
        assertEq(vault.openCommitments(alice), 0);
        assertEq(vault.lockedOf(alice, address(input)), 0);
        assertEq(vault.balanceOf(alice, address(t0)), sell ? 90 : 110);
        assertEq(vault.balanceOf(alice, address(t1)), sell ? 109 : 89);
        assertEq(vault.balanceOf(treasury, address(t1)), 1);
        (, bytes32 root, uint256 step) = s.admissionState(alice);
        assertEq(root, bytes32(0));
        assertEq(step, 0);
        uint256 amount = vault.freeBalance(alice, address(output));
        uint256 beforeWallet = output.balanceOf(alice);
        vm.prank(alice);
        vault.withdraw(address(output), amount);
        assertEq(output.balanceOf(alice), beforeWallet + amount);
    }
}
