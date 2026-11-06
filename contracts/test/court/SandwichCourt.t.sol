// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {SandwichCourtVerifier, IL1Block} from "../../src/court/SandwichCourtVerifier.sol";

contract MockL1Block is IL1Block {
    uint64 public number;
    bytes32 public hash;

    function set(uint64 n, bytes32 h) external {
        number = n;
        hash = h;
    }
}

/// @dev Exposes internals for unit tests.
contract VerifierHarness is SandwichCourtVerifier {
    constructor(IL1Block l1) SandwichCourtVerifier(l1) {}

    function recover(bytes memory raw) external pure returns (address) {
        return _recover(raw, 0);
    }

    function predicate(Swap memory f, Swap memory v, Swap memory b) external pure returns (bool, uint256, uint256) {
        return _predicate(f, v, b);
    }

    /// @dev The proven Swap of a claim's front (0), victim (1) or back (2) leg.
    function legSwap(Claim calldata c, uint256 which) external pure returns (Swap memory) {
        return _swapOf(which == 0 ? c.front : which == 1 ? c.victim : c.back, c, _header(c.header));
    }
}

/// @dev Fixture loading and block-hash installation, shared by the Court test contracts.
abstract contract CourtFixtures is Test {
    using stdJson for string;

    string constant V3 = "test/court/fixtures/v3.json";
    string constant V4 = "test/court/fixtures/v4.json";
    // block 26354079: attacker and victim both trade through the v4 Universal Router (S5)
    string constant V4_ROUTER = "test/court/fixtures/v4router.json";
    // the same block's front and victim, with a later swap through that router by a third wallet as the "back"
    string constant V4_ROUTER_UNRELATED = "test/court/fixtures/v4router-unrelated.json";
    address constant UNIVERSAL_ROUTER = 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af;
    address constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;

    VerifierHarness court;
    MockL1Block l1;

    function setUp() public virtual {
        l1 = new MockL1Block();
        court = new VerifierHarness(l1);
    }

    // ---- helpers

    function _claim(string memory path) internal view returns (SandwichCourtVerifier.Claim memory c, string memory j) {
        j = vm.readFile(path);
        c.header = j.readBytes(".header");
        assertEq(keccak256(c.header), j.readBytes32(".blockHash"), "fixture header hashes to the real block hash");
        c.front = _leg(j, ".front");
        c.victim = _leg(j, ".victim");
        c.back = _leg(j, ".back");
        c.v4 = j.readBool(".v4");
        c.pool = j.readAddress(".pool");
        c.poolId = j.readBytes32(".poolId");
    }

    function _anchoredClaim(string memory path)
        internal
        view
        returns (SandwichCourtVerifier.Claim memory c, string memory j)
    {
        (c, j) = _claim(path);
        c.anchor.header = j.readBytes(".anchor.header");
        c.anchor.accountProof = j.readBytesArray(".anchor.accountProof");
        c.anchor.storageProof = j.readBytesArray(".anchor.storageProof");
    }

    function _leg(string memory j, string memory k) internal pure returns (SandwichCourtVerifier.Leg memory l) {
        l.index = j.readUint(string.concat(k, ".index"));
        l.rawTx = j.readBytes(string.concat(k, ".rawTx"));
        l.txProof = j.readBytesArray(string.concat(k, ".txProof"));
        l.receiptProof = j.readBytesArray(string.concat(k, ".receiptProof"));
        l.logIndex = j.readUint(string.concat(k, ".logIndex"));
    }

    function _installBlockhash(string memory j) internal {
        uint256 n = j.readUint(".blockNumber");
        vm.roll(n + 10);
        vm.setBlockhash(n, j.readBytes32(".blockHash"));
    }

    function _installHistory(string memory j) internal {
        uint256 n = j.readUint(".blockNumber");
        vm.roll(n + 300); // beyond BLOCKHASH's 256-block window
        vm.etch(HISTORY, j.readBytes(".historyCode")); // the real EIP-2935 bytecode
        vm.store(HISTORY, bytes32(n % 8191), j.readBytes32(".blockHash"));
    }

    function _checkpoint(string memory j) internal {
        l1.set(uint64(j.readUint(".anchor.number")), j.readBytes32(".anchor.hash"));
        court.checkpoint();
    }

    function _assertVerdict(SandwichCourtVerifier.Verdict memory v, string memory j) internal pure {
        assertEq(v.blockNumber, j.readUint(".blockNumber"));
        assertEq(v.attacker, j.readAddress(".attacker"), "attacker = the RPC-reported front/back sender");
        assertEq(v.victim, j.readAddress(".victimFrom"));
        assertEq(v.victimTxHash, keccak256(j.readBytes(".victim.rawTx")));
        assertGt(v.profit, 0);
        assertGt(v.frontIn, v.profit, "the front leg paid in more than the attacker made");
    }
}

/// @notice Real Ethereum mainnet sandwiches (v3 and v4) found and proven by packages/court-watcher.
contract SandwichCourtTest is CourtFixtures {
    using stdJson for string;

    // ---- local block hash (BLOCKHASH, EIP-2935)

    function test_v3_blockhash() public {
        (SandwichCourtVerifier.Claim memory c, string memory j) = _claim(V3);
        _installBlockhash(j);
        _assertVerdict(court.verify(c), j);
    }

    function test_v4_blockhash() public {
        (SandwichCourtVerifier.Claim memory c, string memory j) = _claim(V4);
        _installBlockhash(j);
        _assertVerdict(court.verify(c), j);
    }

    function test_v3_eip2935() public {
        (SandwichCourtVerifier.Claim memory c, string memory j) = _claim(V3);
        _installHistory(j);
        _assertVerdict(court.verify(c), j);
    }

    function test_v4_eip2935() public {
        (SandwichCourtVerifier.Claim memory c, string memory j) = _claim(V4);
        _installHistory(j);
        _assertVerdict(court.verify(c), j);
    }

    // ---- L1 anchor (Court on Base judging Ethereum)

    function test_v3_anchor() public {
        (SandwichCourtVerifier.Claim memory c, string memory j) = _anchoredClaim(V3);
        _checkpoint(j);
        _assertVerdict(court.verify(c), j);
    }

    function test_v4_anchor() public {
        (SandwichCourtVerifier.Claim memory c, string memory j) = _anchoredClaim(V4);
        _checkpoint(j);
        _assertVerdict(court.verify(c), j);
    }

    function test_anchor_requiresCheckpoint() public {
        (SandwichCourtVerifier.Claim memory c,) = _anchoredClaim(V3);
        vm.expectRevert(SandwichCourtVerifier.BadAnchor.selector);
        court.verify(c);
    }

    function test_anchor_rejectsWrongCheckpointNumber() public {
        (SandwichCourtVerifier.Claim memory c, string memory j) = _anchoredClaim(V3);
        l1.set(uint64(j.readUint(".anchor.number") + 1), j.readBytes32(".anchor.hash"));
        court.checkpoint();
        vm.expectRevert(SandwichCourtVerifier.BadAnchor.selector);
        court.verify(c);
    }

    function test_anchor_rejectsOtherBlocksStorageProof() public {
        (SandwichCourtVerifier.Claim memory c, string memory j) = _anchoredClaim(V3);
        (SandwichCourtVerifier.Claim memory other,) = _anchoredClaim(V4);
        _checkpoint(j);
        c.anchor.storageProof = other.anchor.storageProof; // slot proof for a different block
        vm.expectRevert();
        court.verify(c);
    }

    // ---- rejections

    function test_rejects_tamperedVictimTx() public {
        (SandwichCourtVerifier.Claim memory c, string memory j) = _claim(V3);
        _installBlockhash(j);
        c.victim.rawTx[c.victim.rawTx.length - 1] ^= 0x01;
        vm.expectRevert(abi.encodeWithSelector(SandwichCourtVerifier.NotSandwich.selector, uint8(8)));
        court.verify(c);
    }

    function test_rejects_legsOutOfOrder() public {
        (SandwichCourtVerifier.Claim memory c, string memory j) = _claim(V3);
        _installBlockhash(j);
        (c.front, c.back) = (c.back, c.front);
        vm.expectRevert(SandwichCourtVerifier.BadOrder.selector);
        court.verify(c);
    }

    function test_rejects_wrongV4PoolId() public {
        (SandwichCourtVerifier.Claim memory c, string memory j) = _claim(V4);
        _installBlockhash(j);
        c.poolId = keccak256("other pool");
        vm.expectRevert();
        court.verify(c);
    }

    function test_rejects_v4ClaimedAsV3() public {
        (SandwichCourtVerifier.Claim memory c, string memory j) = _claim(V4);
        _installBlockhash(j);
        c.v4 = false;
        vm.expectRevert();
        court.verify(c);
    }

    function test_rejects_wrongLogHint() public {
        (SandwichCourtVerifier.Claim memory c, string memory j) = _claim(V3);
        _installBlockhash(j);
        c.victim.logIndex = c.victim.logIndex == 0 ? 1 : 0;
        vm.expectRevert();
        court.verify(c);
    }

    function test_rejects_unknownBlock() public {
        (SandwichCourtVerifier.Claim memory c, string memory j) = _claim(V3);
        vm.roll(j.readUint(".blockNumber") + 9_000); // outside BLOCKHASH and EIP-2935 windows
        vm.expectRevert();
        court.verify(c);
    }

    // ---- router attribution (S5), on real swaps

    function test_v4_sharedRouter_victimIsAVictim() public {
        // the old predicate rejected this real sandwich: the victim's swap and the attacker's were both made by the
        // Universal Router, and a router's address was taken to be the trader
        (SandwichCourtVerifier.Claim memory c, string memory j) = _claim(V4_ROUTER);
        _installBlockhash(j);
        for (uint256 i; i < 3; i++) {
            assertEq(court.legSwap(c, i).caller, UNIVERSAL_ROUTER, "every leg's swap was made by the router");
        }
        SandwichCourtVerifier.Verdict memory v = court.verify(c);
        _assertVerdict(v, j);
        assertTrue(v.attacker != v.victim);
    }

    function test_rejects_sharedRouter_unrelatedWallets() public {
        // three real swaps in one pool, all made by the Universal Router, signed by three different wallets: the
        // router is no identity, so this is no sandwich
        (SandwichCourtVerifier.Claim memory c, string memory j) = _claim(V4_ROUTER_UNRELATED);
        _installBlockhash(j);
        assertEq(court.legSwap(c, 0).caller, court.legSwap(c, 2).caller, "same router on both 'attacker' legs");
        vm.expectRevert(abi.encodeWithSelector(SandwichCourtVerifier.NotSandwich.selector, uint8(6)));
        court.verify(c);
    }

    // ---- predicate (synthetic swaps, pool-side amounts)

    function test_predicate() public view {
        address bot = address(0xB07);
        address user = address(0xA11CE);
        // front buys 100 token1 for 50 token0, victim also sells token0, back sells 100 token1 for 52 token0
        SandwichCourtVerifier.Swap memory f = SandwichCourtVerifier.Swap(bot, 50, -100);
        SandwichCourtVerifier.Swap memory v = SandwichCourtVerifier.Swap(user, 10, -18);
        SandwichCourtVerifier.Swap memory b = SandwichCourtVerifier.Swap(bot, -52, 100);
        (bool z, uint256 profit, uint256 frontIn) = court.predicate(f, v, b);
        assertTrue(z);
        assertEq(profit, 2);
        assertEq(frontIn, 50);
    }

    function test_predicate_sharedRouter() public view {
        // S5: attacker and victim both trade through one public router; the router is not the trader
        address router = address(0x7247);
        SandwichCourtVerifier.Swap memory f = SandwichCourtVerifier.Swap(router, 50, -100);
        SandwichCourtVerifier.Swap memory v = SandwichCourtVerifier.Swap(router, 10, -18);
        SandwichCourtVerifier.Swap memory b = SandwichCourtVerifier.Swap(router, -52, 100);
        (, uint256 profit,) = court.predicate(f, v, b);
        assertEq(profit, 2);
    }

    function test_predicate_v4AmountRange() public view {
        // S17: v4 amounts are int128, so the predicate's arithmetic holds across their whole range
        int256 m = int256(type(int128).max);
        SandwichCourtVerifier.Swap memory f = SandwichCourtVerifier.Swap(address(1), m - 1, -m);
        SandwichCourtVerifier.Swap memory v = SandwichCourtVerifier.Swap(address(2), 1, -1);
        SandwichCourtVerifier.Swap memory b = SandwichCourtVerifier.Swap(address(1), -m, m);
        (, uint256 profit, uint256 frontIn) = court.predicate(f, v, b);
        assertEq(profit, 1);
        assertEq(frontIn, uint256(m - 1));
    }

    function test_predicate_rejectsAmountsBeyondRange() public {
        // S17: a v3 log can carry int256 amounts no real token reaches; those revert instead of verifying
        SandwichCourtVerifier.Swap memory v = SandwichCourtVerifier.Swap(address(2), 1, -1);
        vm.expectRevert(); // negating int256.min overflows
        court.predicate(
            SandwichCourtVerifier.Swap(address(1), 1, type(int256).min),
            v,
            SandwichCourtVerifier.Swap(address(1), -2, type(int256).max)
        );
    }

    function test_predicate_rejections() public {
        address bot = address(0xB07);
        address user = address(0xA11CE);
        SandwichCourtVerifier.Swap memory f = SandwichCourtVerifier.Swap(bot, 50, -100);
        SandwichCourtVerifier.Swap memory v = SandwichCourtVerifier.Swap(user, 10, -18);

        vm.expectRevert(abi.encodeWithSelector(SandwichCourtVerifier.NotSandwich.selector, uint8(1)));
        court.predicate(f, SandwichCourtVerifier.Swap(user, -10, 18), SandwichCourtVerifier.Swap(bot, -52, 100));
        vm.expectRevert(abi.encodeWithSelector(SandwichCourtVerifier.NotSandwich.selector, uint8(4)));
        court.predicate(f, v, SandwichCourtVerifier.Swap(user, -52, 100)); // back made by another contract
        vm.expectRevert(abi.encodeWithSelector(SandwichCourtVerifier.NotSandwich.selector, uint8(2)));
        court.predicate(f, v, SandwichCourtVerifier.Swap(bot, -26, 50)); // closes only half
        vm.expectRevert(abi.encodeWithSelector(SandwichCourtVerifier.NotSandwich.selector, uint8(3)));
        court.predicate(f, v, SandwichCourtVerifier.Swap(bot, -49, 100)); // a loss
        // a front that pays nothing in (here token1 = 0) is no sandwich, however much the back gets
        vm.expectRevert(abi.encodeWithSelector(SandwichCourtVerifier.NotSandwich.selector, uint8(3)));
        court.predicate(
            SandwichCourtVerifier.Swap(bot, -100, 0),
            SandwichCourtVerifier.Swap(user, -18, 10),
            SandwichCourtVerifier.Swap(bot, 100, -52)
        );
    }

    // ---- signer recovery for every tx type

    function test_recover_allTxTypes() public view {
        string memory j = vm.readFile("test/court/fixtures/signed.json");
        address signer = j.readAddress(".signer");
        string[5] memory kinds = ["preEip155", "eip155", "eip2930", "eip1559", "eip7702"];
        for (uint256 i; i < kinds.length; i++) {
            assertEq(court.recover(j.readBytes(string.concat(".", kinds[i]))), signer, kinds[i]);
        }
    }
}
