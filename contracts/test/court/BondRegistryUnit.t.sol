// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {SandwichCourtVerifier} from "../../src/court/SandwichCourtVerifier.sol";
import {BondRegistry} from "../../src/court/BondRegistry.sol";

/// @dev Returns whatever verdict the test sets, so BondRegistry's own logic can be fuzzed without proofs.
contract MockVerifier {
    SandwichCourtVerifier.Verdict v;

    function set(SandwichCourtVerifier.Verdict memory v_) external {
        v = v_;
    }

    function verify(SandwichCourtVerifier.Claim calldata) external view returns (SandwichCourtVerifier.Verdict memory) {
        return v;
    }
}

contract Reverter {
    receive() external payable {
        revert("no");
    }
}

/// @dev Re-enters claim from its receive hook with the call it was paid by.
contract Reenterer {
    BondRegistry reg;
    bytes call_;
    bool public reentryFailed;

    function arm(BondRegistry r, bytes memory c) external {
        reg = r;
        call_ = c;
    }

    function claim() external {
        (bool ok,) = address(reg).call(call_);
        require(ok, "claim failed");
    }

    receive() external payable {
        (bool ok,) = address(reg).call(call_);
        reentryFailed = !ok;
    }
}

abstract contract RegistryBase is Test {
    address constant WETH = address(0xE7);
    address constant OTHER = address(0x07);
    address constant FACTORY = address(0xFAC);
    bytes32 constant INIT_HASH = keccak256("pool init code");
    address constant PM = address(0x4444);
    uint256 constant DELAY = 1 days;

    MockVerifier mock;
    BondRegistry reg;

    function _deploy() internal {
        mock = new MockVerifier();
        reg = new BondRegistry(
            BondRegistry.Config({
                verifier: SandwichCourtVerifier(address(mock)),
                sourceChainId: block.chainid,
                weth: WETH,
                v3Factory: FACTORY,
                v3InitCodeHash: INIT_HASH,
                v4PoolManager: PM,
                unbondDelay: DELAY
            })
        );
    }

    function _v3Pool(address t0, address t1, uint24 fee) internal pure returns (address) {
        bytes32 salt = keccak256(abi.encode(t0, t1, fee));
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", FACTORY, salt, INIT_HASH)))));
    }

    /// @dev A claim the mock will "verify" as a sandwich of `txHash` in which the attacker made `profit`.
    function _setup(bytes32 txHash, address victim, uint256 profit, bool v4, bool inToken0, address t0, address t1)
        internal
        returns (SandwichCourtVerifier.Claim memory c, bytes memory poolKey)
    {
        if (v4) {
            poolKey = abi.encode(t0, t1, uint24(3000), int24(60), address(0));
            c.v4 = true;
            c.pool = PM;
            c.poolId = keccak256(poolKey);
        } else {
            poolKey = abi.encode(t0, t1, uint24(500));
            c.pool = _v3Pool(t0, t1, 500);
        }
        mock.set(
            SandwichCourtVerifier.Verdict({
                blockNumber: 100,
                blockHash: bytes32(0),
                victimTxHash: txHash,
                attacker: address(0xBAD),
                victim: victim,
                profitInToken0: inToken0,
                profit: profit
            })
        );
    }

    function _receipt(bytes32 txHash, uint256 maxPayout) internal view returns (BondRegistry.Protected memory) {
        return BondRegistry.Protected({
            txHash: txHash, chainId: block.chainid, acceptedAt: 0, maxBlock: 100, maxPayout: maxPayout
        });
    }

    function _sign(uint256 key, BondRegistry.Protected memory r) internal view returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(key, reg.receiptDigest(r));
        return abi.encodePacked(rr, s, v);
    }
}

contract BondRegistryUnitTest is RegistryBase {
    uint256 constant KEY = 0xA11CE;
    address rpc;
    address victim = makeAddr("victim");

    function setUp() public {
        _deploy();
        rpc = vm.addr(KEY);
        vm.deal(rpc, 1_000 ether);
    }

    function _bond(uint256 amount) internal {
        vm.prank(rpc);
        reg.bond{value: amount}();
    }

    // ---- payout math

    /// @dev payout = min(profit, maxPayout, bond); refund fits in what's left; ETH in the registry = bonds.
    function testFuzz_payoutIsMinOfProfitCapAndBond(uint96 profit, uint96 cap, uint96 bond, uint32 basefee) public {
        vm.assume(bond > 0);
        vm.deal(rpc, bond);
        _bond(bond);
        vm.fee(basefee);
        (SandwichCourtVerifier.Claim memory c, bytes memory key) =
            _setup("tx", victim, profit, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("tx", cap);
        bytes memory sig = _sign(KEY, r);
        address prover = makeAddr("prover");
        vm.prank(prover);
        uint256 paid = reg.claim(c, r, sig, key);

        uint256 expected = profit < cap ? profit : cap;
        if (expected > bond) expected = bond;
        assertEq(paid, expected, "payout");
        assertEq(victim.balance, expected, "victim");
        assertLe(prover.balance, uint256(bond) - expected, "refund fits the bond");
        assertEq(reg.bondOf(rpc), uint256(bond) - expected - prover.balance, "bond accounting");
        assertEq(address(reg).balance, reg.bondOf(rpc), "ETH held = bonds");
    }

    function test_refundCappedByWhatIsLeft() public {
        _bond(1 ether);
        vm.fee(1_000 gwei); // a refund far above what's left after the payout
        (SandwichCourtVerifier.Claim memory c, bytes memory key) =
            _setup("tx", victim, 1 ether - 1, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("tx", 10 ether);
        bytes memory sig = _sign(KEY, r);
        address prover = makeAddr("prover");
        vm.prank(prover);
        reg.claim(c, r, sig, key);
        assertEq(victim.balance, 1 ether - 1, "victim paid first");
        assertEq(prover.balance, 1, "prover gets only the remainder");
        assertEq(reg.bondOf(rpc), 0);
    }

    function test_zeroCapPaysNothingButUsesTheClaim() public {
        _bond(1 ether);
        (SandwichCourtVerifier.Claim memory c, bytes memory key) = _setup("tx", victim, 5, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("tx", 0);
        assertEq(reg.claim(c, r, _sign(KEY, r), key), 0);
        assertTrue(reg.paid("tx"));
    }

    // ---- which token the profit is in

    function test_profitToken_allFourSides() public {
        _bond(10 ether);
        // v3, profit in token0 = WETH
        (SandwichCourtVerifier.Claim memory c, bytes memory key) = _setup("a", victim, 1, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("a", 1 ether);
        assertEq(reg.claim(c, r, _sign(KEY, r), key), 1);
        // v3, profit in token1 = WETH
        (c, key) = _setup("b", victim, 2, false, false, OTHER, WETH);
        r = _receipt("b", 1 ether);
        assertEq(reg.claim(c, r, _sign(KEY, r), key), 2);
        // v4, profit in currency1 = WETH
        (c, key) = _setup("c", victim, 3, true, false, OTHER, WETH);
        r = _receipt("c", 1 ether);
        assertEq(reg.claim(c, r, _sign(KEY, r), key), 3);
        // v4, profit in currency0 = native ETH
        (c, key) = _setup("d", victim, 4, true, true, address(0), OTHER);
        r = _receipt("d", 1 ether);
        assertEq(reg.claim(c, r, _sign(KEY, r), key), 4);
        // profit in the non-ETH side of each kind of pool
        (c, key) = _setup("e", victim, 5, false, false, WETH, OTHER);
        r = _receipt("e", 1 ether);
        bytes memory sig = _sign(KEY, r);
        vm.expectRevert(abi.encodeWithSelector(BondRegistry.UnvaluedProfit.selector, OTHER));
        reg.claim(c, r, sig, key);
        (c, key) = _setup("f", victim, 6, true, true, address(0), OTHER);
        mock.set(_verdict("f", false, 6));
        r = _receipt("f", 1 ether);
        sig = _sign(KEY, r);
        vm.expectRevert(abi.encodeWithSelector(BondRegistry.UnvaluedProfit.selector, OTHER));
        reg.claim(c, r, sig, key);
        assertEq(victim.balance, 1 + 2 + 3 + 4);
    }

    function _verdict(bytes32 txHash, bool inToken0, uint256 profit)
        internal
        view
        returns (SandwichCourtVerifier.Verdict memory)
    {
        return SandwichCourtVerifier.Verdict(100, bytes32(0), txHash, address(0xBAD), victim, inToken0, profit);
    }

    function test_v4PoolKeyMustHashExactly() public {
        _bond(1 ether);
        (SandwichCourtVerifier.Claim memory c, bytes memory key) =
            _setup("tx", victim, 1, true, true, address(0), OTHER);
        BondRegistry.Protected memory r = _receipt("tx", 1 ether);
        bytes memory sig = _sign(KEY, r);
        vm.expectRevert(BondRegistry.UnknownPool.selector);
        reg.claim(c, r, sig, abi.encodePacked(key, uint256(0))); // trailing word: a different hash
    }

    // ---- signatures

    function test_signature_vAsZeroOrOne() public {
        _bond(1 ether);
        (SandwichCourtVerifier.Claim memory c, bytes memory key) = _setup("tx", victim, 7, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("tx", 1 ether);
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(KEY, reg.receiptDigest(r));
        assertEq(reg.claim(c, r, abi.encodePacked(rr, s, v - 27), key), 7);
    }

    function test_signature_rejects() public {
        _bond(1 ether);
        (SandwichCourtVerifier.Claim memory c, bytes memory key) = _setup("tx", victim, 7, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("tx", 1 ether);
        bytes memory sig = _sign(KEY, r);
        vm.expectRevert(BondRegistry.BadSignature.selector);
        reg.claim(c, r, abi.encodePacked(bytes32(0), bytes32(0)), key); // 64 bytes
        vm.expectRevert(BondRegistry.BadSignature.selector);
        reg.claim(c, r, abi.encodePacked(bytes32(0), bytes32(0), uint8(27)), key); // recovers nobody
        assertEq(reg.claim(c, r, sig, key), 7);
    }

    function test_receiptDigest_isEip712() public view {
        BondRegistry.Protected memory r = _receipt("tx", 5);
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BondRegistry"),
                keccak256("1"),
                block.chainid,
                address(reg)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Protected(bytes32 txHash,uint256 chainId,uint64 acceptedAt,uint64 maxBlock,uint256 maxPayout)"
                ),
                r.txHash,
                r.chainId,
                r.acceptedAt,
                r.maxBlock,
                r.maxPayout
            )
        );
        assertEq(reg.receiptDigest(r), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }

    // ---- transfers and reentrancy

    function test_victimThatRejectsEth_revertsTheWholeClaim() public {
        _bond(1 ether);
        address bad = address(new Reverter());
        (SandwichCourtVerifier.Claim memory c, bytes memory key) = _setup("tx", bad, 7, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("tx", 1 ether);
        bytes memory sig = _sign(KEY, r);
        vm.expectRevert(BondRegistry.TransferFailed.selector);
        reg.claim(c, r, sig, key);
        assertFalse(reg.paid("tx"));
        assertEq(reg.bondOf(rpc), 1 ether);
    }

    function test_reentrantVictim_cannotClaimTwice() public {
        _bond(1 ether);
        Reenterer re = new Reenterer();
        (SandwichCourtVerifier.Claim memory c, bytes memory key) =
            _setup("tx", address(re), 7, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("tx", 1 ether);
        re.arm(reg, abi.encodeCall(BondRegistry.claim, (c, r, _sign(KEY, r), key)));
        re.claim();
        assertTrue(re.reentryFailed(), "the nested claim hit AlreadyPaid");
        assertEq(address(re).balance, 7);
        assertEq(reg.bondOf(rpc), 1 ether - 7);
    }

    // ---- unbonding

    function test_unbond_lifecycle() public {
        _bond(1 ether);
        vm.prank(rpc);
        reg.requestUnbond();
        uint256 first = reg.unbondAt(rpc);
        vm.warp(block.timestamp + DELAY / 2);
        vm.prank(rpc);
        reg.requestUnbond(); // re-requesting restarts the delay
        assertEq(reg.unbondAt(rpc), first + DELAY / 2);
        _bond(1 ether); // bonding more during the delay is still all withdrawn at the end
        uint256 at = reg.unbondAt(rpc);
        vm.warp(at - 1);
        vm.prank(rpc);
        vm.expectRevert(abi.encodeWithSelector(BondRegistry.UnbondNotReady.selector, at));
        reg.unbond();
        vm.warp(at);
        uint256 before = rpc.balance;
        vm.prank(rpc);
        reg.unbond();
        assertEq(rpc.balance - before, 2 ether);
        assertEq(reg.unbondAt(rpc), 0, "a new unbond needs a new request");

        (SandwichCourtVerifier.Claim memory c, bytes memory key) = _setup("tx", victim, 7, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("tx", 1 ether);
        bytes memory sig = _sign(KEY, r);
        vm.expectRevert(abi.encodeWithSelector(BondRegistry.NoBond.selector, rpc));
        reg.claim(c, r, sig, key);
    }
}

/// @dev Random bonds, unbond requests, time, unbonds and claims across three RPCs.
contract RegistryHandler is RegistryBase {
    uint256[3] keys = [uint256(0xA1), 0xA2, 0xA3];
    uint256 nonce;
    uint256 public paidOut;

    constructor(BondRegistry r, MockVerifier m) {
        reg = r;
        mock = m;
        for (uint256 i; i < 3; i++) {
            vm.deal(vm.addr(keys[i]), 1e30);
        }
    }

    function bond(uint8 who, uint96 amount) external {
        vm.prank(vm.addr(keys[who % 3]));
        reg.bond{value: amount}();
    }

    function requestUnbond(uint8 who) external {
        vm.prank(vm.addr(keys[who % 3]));
        reg.requestUnbond();
    }

    function wait(uint32 dt) external {
        vm.warp(block.timestamp + dt);
    }

    function unbond(uint8 who) external {
        address a = vm.addr(keys[who % 3]);
        uint256 at = reg.unbondAt(a);
        if (at == 0 || block.timestamp < at) return;
        vm.prank(a);
        reg.unbond();
    }

    function claim(uint8 who, uint96 profit, uint96 cap) external {
        uint256 key = keys[who % 3];
        if (reg.bondOf(vm.addr(key)) == 0) return;
        bytes32 txHash = keccak256(abi.encode(nonce++));
        address victim = address(uint160(uint256(txHash)));
        (SandwichCourtVerifier.Claim memory c, bytes memory pk) =
            _setup(txHash, victim, profit, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt(txHash, cap);
        paidOut += reg.claim(c, r, _sign(key, r), pk);
    }

    function totalBonds() external view returns (uint256 s) {
        for (uint256 i; i < 3; i++) {
            s += reg.bondOf(vm.addr(keys[i]));
        }
    }
}

contract BondRegistryInvariantTest is RegistryBase {
    RegistryHandler handler;

    function setUp() public {
        _deploy();
        handler = new RegistryHandler(reg, mock);
        targetContract(address(handler));
    }

    /// @dev Every wei the registry holds belongs to some RPC's bond: claims and unbonds never over-pay.
    function invariant_ethHeldEqualsBonds() public view {
        assertEq(address(reg).balance, handler.totalBonds());
    }
}
