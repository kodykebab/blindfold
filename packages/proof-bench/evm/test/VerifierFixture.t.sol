// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RiscZeroGroth16Verifier, ControlID} from "risc0/src/groth16/RiscZeroGroth16Verifier.sol";
import {TestReceipt} from "risc0/test/TestReceiptV3_0.sol";

/// @notice Checks verifier plumbing with the upstream receipt fixture.
contract VerifierFixtureTest is Test {
    RiscZeroGroth16Verifier verifier;

    function setUp() public {
        verifier = new RiscZeroGroth16Verifier(ControlID.CONTROL_ROOT, ControlID.BN254_CONTROL_ID);
    }

    function test_upstreamReceiptVerifies() public {
        uint256 start = gasleft();
        verifier.verify(TestReceipt.SEAL, TestReceipt.IMAGE_ID, sha256(TestReceipt.JOURNAL));
        emit log_named_uint("verifier call gas", start - gasleft());
    }

    function test_modifiedJournalRejected() public {
        bytes32 digest = sha256("modified");
        vm.expectRevert();
        verifier.verify(TestReceipt.SEAL, TestReceipt.IMAGE_ID, digest);
    }

    function test_modifiedProgramRejected() public {
        bytes32 digest = sha256(TestReceipt.JOURNAL);
        vm.expectRevert();
        verifier.verify(TestReceipt.SEAL, bytes32(uint256(TestReceipt.IMAGE_ID) ^ 1), digest);
    }
}
