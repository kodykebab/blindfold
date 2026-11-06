// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RiscZeroGroth16Verifier, ControlID} from "risc0/src/groth16/RiscZeroGroth16Verifier.sol";

/// @notice Requires a real locally generated admission receipt exported by the host.
contract OnlineReceiptTest is Test {
    RiscZeroGroth16Verifier verifier;
    bytes seal;
    bytes journal;
    bytes32 imageId;

    function setUp() public {
        string memory fixture = vm.readFile("../results/online.json");
        seal = vm.parseJsonBytes(fixture, ".seal");
        journal = vm.parseJsonBytes(fixture, ".journal");
        imageId = vm.parseJsonBytes32(fixture, ".imageId");
        require(seal.length == 260 && journal.length != 0 && imageId != bytes32(0), "bad fixture");
        verifier = new RiscZeroGroth16Verifier(ControlID.CONTROL_ROOT, ControlID.BN254_CONTROL_ID);
    }

    function test_admissionProofVerifies() public {
        bytes32 digest = sha256(journal);
        uint256 beforeGas = gasleft();
        verifier.verify(seal, imageId, digest);
        emit log_named_uint("online verifier call gas", beforeGas - gasleft());
    }

    function test_everyJournalByteIsBound() public {
        bytes memory changed = journal;
        for (uint256 i; i < changed.length; i++) {
            changed[i] ^= bytes1(uint8(1));
            bytes32 digest = sha256(changed);
            vm.expectRevert();
            verifier.verify(seal, imageId, digest);
            changed[i] ^= bytes1(uint8(1));
        }
    }

    function test_modifiedImageRejected() public {
        bytes32 digest = sha256(journal);
        vm.expectRevert();
        verifier.verify(seal, bytes32(uint256(imageId) ^ 1), digest);
    }

    function test_modifiedProofRejected() public {
        bytes memory changed = seal;
        changed[changed.length - 1] ^= bytes1(uint8(1));
        bytes32 digest = sha256(journal);
        vm.expectRevert();
        verifier.verify(changed, imageId, digest);
    }

    function test_wrongSelectorRejected() public {
        bytes memory changed = seal;
        changed[0] ^= bytes1(uint8(1));
        bytes32 digest = sha256(journal);
        vm.expectRevert();
        verifier.verify(changed, imageId, digest);
    }

    function test_emptyJournalRejected() public {
        bytes32 digest = sha256("");
        vm.expectRevert();
        verifier.verify(seal, imageId, digest);
    }
}
