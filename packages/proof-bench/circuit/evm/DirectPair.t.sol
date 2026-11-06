// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {Verifier as PreparationVerifier} from "direct-preparation/Verifier.sol";
import {Verifier as OnlineVerifier} from "direct-online/Verifier.sol";

/// @notice Proof composition harness. Reads both real exports; absent files fail.
contract DirectPairTest is Test {
    PreparationVerifier preparationVerifier;
    OnlineVerifier onlineVerifier;
    bytes prepSeal;
    bytes prepJournal;
    bytes onlineSeal;
    bytes onlineJournal;

    struct PublicAdmission {
        bytes32 domain;
        uint256 chainId;
        address settlement;
        address owner;
        uint256 batch;
        uint256 round;
        bytes32 keyCommitment;
        bytes32 config;
        uint256 step;
        bytes32 oldRoot;
        bytes32 newRoot;
        uint256 budget0;
        uint256 budget1;
        bytes32 orderHash;
        bytes32 ciphertextHash;
    }

    struct AdmissionState {
        address owner;
        uint64 batch;
        uint64 round;
        bytes32 root;
        uint256 step;
        uint256 free0;
        uint256 free1;
    }
    bytes32 constant DOMAIN = keccak256("blindfold.prepared-key.v1");
    bytes32 constant CONFIG = keccak256(
        "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"
        "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a"
    );
    address constant SETTLEMENT = 0x0101010101010101010101010101010101010101;
    bytes ciphertext;

    function setUp() public {
        vm.chainId(130);
        ciphertext = vm.parseBytes(
            string.concat(
                "0x", vm.parseJsonString(vm.readFile("../../results/canonical-interop.json"), ".fixture.ciphertext")
            )
        );
        string memory p = vm.readFile("../../results/direct-preparation/proof.json");
        string memory o = vm.readFile("../../results/direct-online/proof.json");
        prepSeal = vm.parseJsonBytes(p, ".proof");
        prepJournal = vm.parseJsonBytes(p, ".journal");
        onlineSeal = vm.parseJsonBytes(o, ".proof");
        onlineJournal = vm.parseJsonBytes(o, ".journal");
        preparationVerifier = new PreparationVerifier();
        onlineVerifier = new OnlineVerifier();
    }

    function verifyPair(bytes calldata ps, bytes calldata pj, bytes calldata os, bytes calldata oj) external view {
        require(pj.length == 256 && oj.length == 480, "journal lengths");
        require(keccak256(pj) == keccak256(oj[:256]), "preparation binding");
        bytes32 prepDigest = keccak256(pj);
        bytes32 onlineDigest = keccak256(oj);
        PublicAdmission memory a = abi.decode(oj, (PublicAdmission));
        bytes32 fundingDigest = keccak256(
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
        uint256[2] memory pi = [uint256(uint128(uint256(prepDigest) >> 128)), uint256(uint128(uint256(prepDigest)))];
        uint256[4] memory oi = [
            uint256(uint128(uint256(onlineDigest) >> 128)),
            uint256(uint128(uint256(onlineDigest))),
            uint256(uint128(uint256(fundingDigest) >> 128)),
            uint256(uint128(uint256(fundingDigest)))
        ];
        preparationVerifier.verifyProof(ps, pi);
        onlineVerifier.verifyProof(os, oi);
    }

    // Application-state boundary model: the settlement must derive these inputs
    // from its own state, including free balances AFTER this commit's deposit.
    function verifyAdmission(
        bytes calldata ps,
        bytes calldata pj,
        bytes calldata os,
        bytes calldata oj,
        AdmissionState calldata state,
        bytes calldata ct
    ) external view returns (bytes32 newRoot, bytes32 orderHash) {
        require(oj.length == 480, "journal lengths");
        PublicAdmission memory a = abi.decode(oj, (PublicAdmission));
        require(a.domain == DOMAIN && a.config == CONFIG, "configuration");
        require(a.chainId == block.chainid && a.settlement == msg.sender, "deployment");
        require(a.owner == state.owner, "owner");
        require(a.batch == state.batch && a.round == state.round, "schedule");
        require(a.step == state.step && a.oldRoot == state.root, "funding state");
        require(a.budget0 <= state.free0 && a.budget1 <= state.free1, "available budget");
        require(ct.length <= 2048 && keccak256(ct) == a.ciphertextHash, "ciphertext");
        this.verifyPair(ps, pj, os, oj);
        return (a.newRoot, a.orderHash);
    }

    function _state() internal view returns (AdmissionState memory s) {
        PublicAdmission memory a = abi.decode(onlineJournal, (PublicAdmission));
        s = AdmissionState(a.owner, uint64(a.batch), uint64(a.round), a.oldRoot, a.step, a.budget0, a.budget1);
    }

    function test_applicationBindingAcceptsExactState() public {
        AdmissionState memory s = _state();
        vm.prank(SETTLEMENT);
        (bytes32 root, bytes32 orderHash) =
            this.verifyAdmission(prepSeal, prepJournal, onlineSeal, onlineJournal, s, ciphertext);
        PublicAdmission memory a = abi.decode(onlineJournal, (PublicAdmission));
        assertEq(root, a.newRoot);
        assertEq(orderHash, a.orderHash);
    }

    function test_applicationRejectsWrongOwnerScheduleRootAndBudget() public {
        for (uint256 i; i < 7; i++) {
            AdmissionState memory s = _state();
            if (i == 0) s.owner = address(0xBAD);
            else if (i == 1) s.batch++;
            else if (i == 2) s.round++;
            else if (i == 3) s.root ^= bytes32(uint256(1));
            else if (i == 4) s.step++;
            else if (i == 5) s.free0--;
            else s.free1--;
            vm.expectRevert();
            vm.prank(SETTLEMENT);
            this.verifyAdmission(prepSeal, prepJournal, onlineSeal, onlineJournal, s, ciphertext);
        }
    }

    function test_applicationRejectsOtherDeploymentAndChain() public {
        AdmissionState memory s = _state();
        vm.expectRevert("deployment");
        this.verifyAdmission(prepSeal, prepJournal, onlineSeal, onlineJournal, s, ciphertext);
        vm.chainId(131);
        vm.expectRevert("deployment");
        vm.prank(SETTLEMENT);
        this.verifyAdmission(prepSeal, prepJournal, onlineSeal, onlineJournal, s, ciphertext);
    }

    function test_applicationRejectsDifferentCiphertext() public {
        AdmissionState memory s = _state();
        ciphertext[ciphertext.length - 1] ^= bytes1(uint8(1));
        vm.expectRevert("ciphertext");
        vm.prank(SETTLEMENT);
        this.verifyAdmission(prepSeal, prepJournal, onlineSeal, onlineJournal, s, ciphertext);
    }

    function test_everySharedJournalByteStillNeedsValidProofs() public {
        for (uint256 i; i < prepJournal.length; i++) {
            prepJournal[i] ^= bytes1(uint8(1));
            onlineJournal[i] ^= bytes1(uint8(1));
            vm.expectRevert();
            this.verifyPair(prepSeal, prepJournal, onlineSeal, onlineJournal);
            prepJournal[i] ^= bytes1(uint8(1));
            onlineJournal[i] ^= bytes1(uint8(1));
        }
    }

    function test_eachOnlineStateByteIsBound() public {
        for (uint256 i = 256; i < onlineJournal.length; i++) {
            onlineJournal[i] ^= bytes1(uint8(1));
            vm.expectRevert();
            this.verifyPair(prepSeal, prepJournal, onlineSeal, onlineJournal);
            onlineJournal[i] ^= bytes1(uint8(1));
        }
    }

    function test_pairVerifies() public {
        uint256 beforeGas = gasleft();
        this.verifyPair(prepSeal, prepJournal, onlineSeal, onlineJournal);
        emit log_named_uint("two proof verification gas", beforeGas - gasleft());
    }

    function test_eachBindingWordRejects() public {
        for (uint256 i; i < 8; i++) {
            onlineJournal[i * 32 + 31] ^= bytes1(uint8(1));
            vm.expectRevert("preparation binding");
            this.verifyPair(prepSeal, prepJournal, onlineSeal, onlineJournal);
            onlineJournal[i * 32 + 31] ^= bytes1(uint8(1));
        }
    }

    function test_matchingTamperedCommitmentsStillReject() public {
        prepJournal[223] ^= bytes1(uint8(1));
        onlineJournal[223] ^= bytes1(uint8(1));
        vm.expectRevert();
        this.verifyPair(prepSeal, prepJournal, onlineSeal, onlineJournal);
    }

    function test_modifiedPreparationProofRejects() public {
        prepSeal[prepSeal.length - 1] ^= bytes1(uint8(1));
        vm.expectRevert();
        this.verifyPair(prepSeal, prepJournal, onlineSeal, onlineJournal);
    }

    function test_swappedProofsReject() public {
        vm.expectRevert();
        this.verifyPair(onlineSeal, prepJournal, prepSeal, onlineJournal);
    }

    function test_truncatedJournalRejects() public {
        bytes memory truncated = new bytes(479);
        vm.expectRevert("journal lengths");
        this.verifyPair(prepSeal, prepJournal, onlineSeal, truncated);
    }
}
