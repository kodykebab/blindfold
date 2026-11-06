// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {RiscZeroGroth16Verifier, ControlID} from "risc0/src/groth16/RiscZeroGroth16Verifier.sol";

/// @notice Proof composition harness. Reads both real exports; absent files fail.
contract PreparedPairTest is Test {
    RiscZeroGroth16Verifier verifier;
    bytes prepSeal; bytes prepJournal; bytes onlineSeal; bytes onlineJournal;
    bytes32 prepImage; bytes32 onlineImage;
    function setUp() public {
        string memory p = vm.readFile("../results/preparation.json");
        string memory o = vm.readFile("../results/online.json");
        prepSeal = vm.parseJsonBytes(p,".seal"); prepJournal = vm.parseJsonBytes(p,".journal");
        onlineSeal = vm.parseJsonBytes(o,".seal"); onlineJournal = vm.parseJsonBytes(o,".journal");
        prepImage = vm.parseJsonBytes32(p,".imageId"); onlineImage = vm.parseJsonBytes32(o,".imageId");
        require(prepImage != onlineImage && prepImage != 0 && onlineImage != 0,"program identities");
        verifier = new RiscZeroGroth16Verifier(ControlID.CONTROL_ROOT,ControlID.BN254_CONTROL_ID);
    }
    function verifyPair(bytes calldata ps,bytes calldata pj,bytes calldata os,bytes calldata oj) external view {
        require(pj.length == 256 && oj.length == 480,"journal lengths");
        require(keccak256(pj) == keccak256(oj[:256]),"preparation binding");
        verifier.verify(ps,prepImage,sha256(pj));
        verifier.verify(os,onlineImage,sha256(oj));
    }
    function test_pairVerifies() public {
        uint256 beforeGas = gasleft();
        this.verifyPair(prepSeal,prepJournal,onlineSeal,onlineJournal);
        emit log_named_uint("two proof verification gas",beforeGas-gasleft());
    }
    function test_eachBindingWordRejects() public {
        for(uint256 i;i<8;i++) {
            onlineJournal[i*32+31] ^= bytes1(uint8(1));
            vm.expectRevert("preparation binding");
            this.verifyPair(prepSeal,prepJournal,onlineSeal,onlineJournal);
            onlineJournal[i*32+31] ^= bytes1(uint8(1));
        }
    }
    function test_matchingTamperedCommitmentsStillReject() public {
        prepJournal[223] ^= bytes1(uint8(1)); onlineJournal[223] ^= bytes1(uint8(1));
        vm.expectRevert(); this.verifyPair(prepSeal,prepJournal,onlineSeal,onlineJournal);
    }
    function test_swappedProofsReject() public {
        vm.expectRevert(); this.verifyPair(onlineSeal,prepJournal,prepSeal,onlineJournal);
    }
    function test_truncatedJournalRejects() public {
        bytes memory truncated = new bytes(479);
        vm.expectRevert("journal lengths"); this.verifyPair(prepSeal,prepJournal,onlineSeal,truncated);
    }
}
