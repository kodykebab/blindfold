// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {Verifier as PreparationVerifier} from "global-preparation/Verifier.sol";
import {Verifier as OnlineVerifier} from "global-online/Verifier.sol";
import {GlobalAuction} from "blindfold/src/global/GlobalAuction.sol";
import {GlobalAdmissionVerifier} from "blindfold/src/global/GlobalAdmissionVerifier.sol";
import {BlindfoldVault} from "blindfold/src/BlindfoldVault.sol";
import {GlobalMarketMock} from "blindfold/test/global/GlobalAuction.t.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

/// @notice Real circuit proofs enter the actual auction, reveal, route, settle and withdraw.
/// The synthetic preparation fixture fixes deployment context; etching only locates auction code at that address.
contract GlobalAdmissionIntegrationTest is Test {
    address constant AUCTION = 0x0101010101010101010101010101010101010101;
    address constant OWNER = 0x0202020202020202020202020202020202020202;
    uint256 constant GENESIS = 1692803367;
    bytes32 constant IDENTITY = keccak256(
        "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"
        "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a"
    );
    GlobalAuction g;
    BlindfoldVault vault;
    bytes proof;
    bytes ciphertext;
    bytes32 root;
    bytes32 key;
    bytes32 hash;

    function setUp() public {
        vm.chainId(130);
        uint64 start = uint64(GENESIS + 2751);
        vm.warp(start);
        address[] memory tokens = new address[](3);
        MockERC20 implementation = new MockERC20("test", "T", 18);
        for (uint256 i; i < 3; i++) {
            tokens[i] = address(uint160(0x1001 + i));
            vm.etch(tokens[i], address(implementation).code);
        }
        vault = new BlindfoldVault();
        GlobalAdmissionVerifier v =
            new GlobalAdmissionVerifier(address(new PreparationVerifier()), address(new OnlineVerifier()));
        GlobalAuction deployed = new GlobalAuction(
            GlobalAuction.Config(vault, v, tokens, start, 30, 12, 30, 10, 1, 2000, address(0xfee), IDENTITY)
        );
        vm.etch(AUCTION, address(deployed).code);
        g = GlobalAuction(AUCTION);
        // Constructor storage must be initialized too; copy only the declared token array and immutable registry configuration.
        // Instead of assuming storage slots, copy all constructor-touched slots recorded by Foundry.
        // Dynamic tokens slot is derived with stdStorage, while immutable values live in the copied runtime code.
        // Deploy once more with access recording to identify storage writes for the complete constructor state.
        vm.record();
        GlobalAuction template = new GlobalAuction(
            GlobalAuction.Config(vault, v, tokens, start, 30, 12, 30, 10, 1, 2000, address(0xfee), IDENTITY)
        );
        (, bytes32[] memory writes) = vm.accesses(address(template));
        for (uint256 i; i < writes.length; i++) {
            vm.store(AUCTION, writes[i], vm.load(address(template), writes[i]));
        }
        vault.setOperator(AUCTION);
        for (uint256 i = 1; i < 3; i++) {
            GlobalMarketMock m = new GlobalMarketMock(AUCTION, tokens[0], tokens[i]);
            g.addMarket(m, true);
        }
        GlobalMarketMock route = new GlobalMarketMock(AUCTION, tokens[1], tokens[2]);
        g.addMarket(route, false);
        MockERC20(tokens[2]).mint(address(route), 10000);
        g.sealConfiguration();
        for (uint256 i; i < 3; i++) {
            uint256 amount = i == 0 ? 1011 : 1000;
            MockERC20(tokens[i]).mint(OWNER, amount);
            vm.startPrank(OWNER);
            MockERC20(tokens[i]).approve(address(vault), amount);
            vault.deposit(tokens[i], amount);
            vm.stopPrank();
        }
        string memory p = vm.readFile("../results/global-preparation/proof.json");
        string memory o = vm.readFile("../results/global-online/proof.json");
        proof = abi.encode(vm.parseJsonBytes(p, ".proof"), vm.parseJsonBytes(o, ".proof"));
        string memory state = vm.readFile("../results/global-online/global-state.json");
        ciphertext = vm.parseJsonBytes(state, ".ciphertext");
        root = vm.parseJsonBytes32(state, ".root");
        key = vm.parseJsonBytes32(state, ".keyCommitment");
        hash = vm.parseJsonBytes32(state, ".orderHash");
        vm.warp(start + 210);
    }

    function test_statementDigestsMatchExports() public view {
        (bytes32 p, bytes32 o) = g.admissionStatements(OWNER, 7, hash, key, root, keccak256(ciphertext));
        assertEq(
            p,
            keccak256(vm.parseJsonBytes(vm.readFile("../results/global-preparation/proof.json"), ".journal")),
            "preparation digest"
        );
        assertEq(
            o,
            keccak256(vm.parseJsonBytes(vm.readFile("../results/global-online/proof.json"), ".journal")),
            "online digest"
        );
    }

    function _admit() private returns (uint256) {
        vm.prank(OWNER);
        return g.admit(7, hash, ciphertext, key, root, proof);
    }

    function test_realProofThroughSettlementAndWithdrawal() public {
        uint256 before = gasleft();
        uint256 id = _admit();
        emit log_named_uint("global_real_admission_gas", before - gasleft());
        vm.warp(g.revealOpens(7));
        GlobalAuction.Order memory o = GlobalAuction.Order(OWNER, 1, 2, 100, 90);
        assertEq(g.orderHash(7, o, 0), hash);
        g.reveal(id, o, 0);
        vm.warp(g.revealCloses(7));
        uint128[] memory f = new uint128[](1);
        f[0] = type(uint128).max;
        GlobalAuction.Route[] memory routes = new GlobalAuction.Route[](1);
        routes[0] = GlobalAuction.Route(1, 2, 2, 100, 100);
        g.settle(7, f, routes);
        assertEq(vault.openCommitments(OWNER), 0);
        assertEq(vault.balanceOf(OWNER, address(0x1003)), 1100);
        vm.prank(OWNER);
        vault.withdraw(address(0x1003), 1100);
        assertEq(MockERC20(address(0x1003)).balanceOf(OWNER), 1100);
    }

    function test_rejectCiphertextMutation() public {
        ciphertext[0] = bytes1(uint8(ciphertext[0]) ^ 1);
        vm.expectRevert();
        _admit();
    }

    function test_rejectOwnerReplay() public {
        vm.expectRevert();
        g.admit(7, hash, ciphertext, key, root, proof);
    }

    function test_rejectRootMutation() public {
        root = bytes32(uint256(root) ^ 1);
        vm.expectRevert();
        _admit();
    }

    function test_rejectProofReplay() public {
        _admit();
        vm.expectRevert();
        _admit();
    }

    function test_rejectBudgetChange() public {
        vm.prank(OWNER);
        vault.withdraw(address(0x1002), 1);
        vm.expectRevert();
        _admit();
    }

    function test_rejectChainReplay() public {
        vm.chainId(131);
        vm.expectRevert();
        _admit();
    }

    function test_rejectWrongProofEncoding() public {
        proof = hex"1234";
        vm.expectRevert();
        _admit();
    }
}
