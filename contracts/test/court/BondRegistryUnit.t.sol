// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {SandwichCourtVerifier} from "../../src/court/SandwichCourtVerifier.sol";
import {BondRegistry, MAX_BUDGET} from "../../src/court/BondRegistry.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

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

/// @dev Collects a claim and tries to collect it again from its receive hook.
contract Reenterer {
    BondRegistry reg;
    bytes32 txHash;
    bool public reentryFailed;

    function arm(BondRegistry r, bytes32 h) external {
        reg = r;
        txHash = h;
    }

    function collect() external {
        reg.collect(txHash);
    }

    receive() external payable {
        (bool ok,) = address(reg).call(abi.encodeCall(BondRegistry.collect, (txHash)));
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
    uint256 constant WINDOW = 1 hours;
    uint256 constant BLOCK_TIME = 1_000;

    uint24 constant DYNAMIC_FEE = 0x800000;

    MockVerifier mock;
    BondRegistry reg;
    address payee; // the beneficiary _receipt names: the victim of the last _setup
    bytes32 legs; // the attacker legs of the next _setup; 0 = unique per claim (its own incident)
    bytes32 backLeg; // if set, the next _setup's back tx comes from this instead of `legs`
    uint256 frontIn = type(uint128).max; // the front leg's input: by default its fee never binds the budget
    uint24 v4Fee = 3000;
    uint24 v3Fee = 500;

    function _deploy() internal {
        mock = new MockVerifier();
        bytes32[] memory pools = new bytes32[](5);
        pools[0] = bytes32(uint256(uint160(_v3Pool(WETH, OTHER, 500))));
        pools[1] = bytes32(uint256(uint160(_v3Pool(OTHER, WETH, 500))));
        pools[2] = keccak256(_v4Key(OTHER, WETH, 3000));
        pools[3] = keccak256(_v4Key(address(0), OTHER, 3000));
        pools[4] = keccak256(_v4Key(address(0), OTHER, DYNAMIC_FEE)); // listed, but its fee can't be read
        reg = new BondRegistry(
            BondRegistry.Config({
                verifier: SandwichCourtVerifier(address(mock)),
                sourceChainId: block.chainid,
                weth: WETH,
                v3Factory: FACTORY,
                v3InitCodeHash: INIT_HASH,
                v4PoolManager: PM,
                unbondDelay: DELAY,
                claimWindow: WINDOW,
                pools: pools
            })
        );
    }

    function _v4Key(address t0, address t1, uint24 fee) internal pure returns (bytes memory) {
        return abi.encode(t0, t1, fee, int24(60), address(0));
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
        payee = victim;
        c.header = _header(BLOCK_TIME);
        bytes32 l = legs == 0 ? txHash : legs;
        c.front.rawTx = abi.encode("front", l);
        c.back.rawTx = abi.encode("back", backLeg == 0 ? l : backLeg);
        if (v4) {
            poolKey = _v4Key(t0, t1, v4Fee);
            c.v4 = true;
            c.pool = PM;
            c.poolId = keccak256(poolKey);
        } else {
            poolKey = abi.encode(t0, t1, v3Fee);
            c.pool = _v3Pool(t0, t1, v3Fee);
        }
        mock.set(
            SandwichCourtVerifier.Verdict({
                blockNumber: 100,
                blockHash: bytes32(0),
                victimTxHash: txHash,
                attacker: address(0xBAD),
                victim: victim,
                profitInToken0: inToken0,
                profit: profit,
                frontIn: frontIn
            })
        );
    }

    /// @dev A block header RLP with only the timestamp (field 11) set; the registry reads nothing else from it.
    function _header(uint256 ts) internal pure returns (bytes memory) {
        bytes memory items;
        for (uint256 i; i < 11; i++) {
            items = bytes.concat(items, hex"80");
        }
        bytes memory tsb;
        for (uint256 x = ts; x != 0; x >>= 8) {
            tsb = bytes.concat(bytes1(uint8(x)), tsb);
        }
        bytes memory enc =
            ts == 0 ? bytes(hex"80") : ts < 0x80 ? tsb : bytes.concat(bytes1(uint8(0x80 + tsb.length)), tsb);
        items = bytes.concat(items, enc);
        return bytes.concat(bytes1(uint8(0xc0 + items.length)), items);
    }

    function _receipt(bytes32 txHash, uint256 maxPayout) internal view returns (BondRegistry.Protected memory) {
        return BondRegistry.Protected({
            txHash: txHash,
            chainId: block.chainid,
            acceptedAt: 0,
            maxBlock: 100,
            maxPayout: maxPayout,
            beneficiary: payee
        });
    }

    function _sign(uint256 key, BondRegistry.Protected memory r) internal view returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(key, reg.receiptDigest(r));
        return abi.encodePacked(rr, s, v);
    }

    function _claimed(bytes32 txHash) internal view returns (bool) {
        (, address rpc,,,,) = reg.claims(txHash);
        return rpc != address(0);
    }

    function _collected(bytes32 txHash) internal view returns (bool done) {
        (,,,,, done) = reg.claims(txHash);
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

    /// @dev Claim, wait out the window, collect: what the beneficiary received.
    function _claimAndCollect(
        SandwichCourtVerifier.Claim memory c,
        BondRegistry.Protected memory r,
        bytes memory sig,
        bytes memory key
    ) internal returns (uint256) {
        reg.claim(c, r, sig, key);
        vm.warp(block.timestamp + WINDOW);
        return reg.collect(r.txHash);
    }

    // ---- payout math, one claim per incident

    /// @dev payout = min(profit, front leg's fee, maxPayout, bond); the refund fits in what's left; ETH held = bonds.
    function testFuzz_payoutIsMinOfProfitFeeCapAndBond(
        uint96 profit,
        uint128 frontIn_,
        uint96 cap,
        uint96 bond,
        uint32 basefee
    ) public {
        vm.assume(bond > 0 && profit > 0);
        vm.deal(rpc, bond);
        _bond(bond);
        vm.fee(basefee);
        frontIn = frontIn_;
        (SandwichCourtVerifier.Claim memory c, bytes memory key) =
            _setup("tx", victim, profit, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("tx", cap);
        bytes memory sig = _sign(KEY, r);
        uint256 budget = uint256(frontIn_) * 500 / 1e6; // the v3 pool _setup uses is the 0.05% tier
        if (profit < budget) budget = profit;
        address prover = makeAddr("prover");
        if (budget == 0) {
            vm.expectRevert(BondRegistry.ZeroBudget.selector);
            reg.claim(c, r, sig, key);
            return;
        }
        vm.prank(prover);
        reg.claim(c, r, sig, key);
        vm.warp(block.timestamp + WINDOW);
        uint256 paid = reg.collect("tx");

        uint256 expected = budget < cap ? budget : cap;
        if (expected > bond) expected = bond;
        assertEq(paid, expected, "payout");
        assertEq(victim.balance, expected, "beneficiary");
        assertLe(prover.balance, uint256(bond) - expected, "refund fits the bond");
        assertEq(reg.bondOf(rpc), uint256(bond) - expected - prover.balance, "bond accounting");
        assertEq(reg.reservedOf(rpc), 0, "reservation released");
        assertEq(address(reg).balance, reg.bondOf(rpc), "ETH held = bonds");
    }

    function test_refundCappedByWhatIsLeft() public {
        _bond(1 ether);
        vm.fee(1_000 gwei); // a refund far above what's left after the reservation
        (SandwichCourtVerifier.Claim memory c, bytes memory key) =
            _setup("tx", victim, 1 ether - 1, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("tx", 10 ether);
        bytes memory sig = _sign(KEY, r);
        address prover = makeAddr("prover");
        vm.prank(prover);
        reg.claim(c, r, sig, key);
        assertEq(prover.balance, 1, "prover gets only the unreserved remainder");
        vm.warp(block.timestamp + WINDOW);
        reg.collect("tx");
        assertEq(victim.balance, 1 ether - 1, "the reservation still pays in full");
        assertEq(reg.bondOf(rpc), 0);
    }

    function test_zeroCapPaysNothingButUsesTheClaim() public {
        _bond(1 ether);
        (SandwichCourtVerifier.Claim memory c, bytes memory key) = _setup("tx", victim, 5, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("tx", 0);
        assertEq(_claimAndCollect(c, r, _sign(KEY, r), key), 0);
        assertTrue(_claimed("tx") && _collected("tx"));
    }

    // ---- incidents (S14)

    function test_incident_twoVictimsShareOneProfit() public {
        _bond(10 ether);
        legs = "same front and back";
        (SandwichCourtVerifier.Claim memory c1, bytes memory key) =
            _setup("v1", makeAddr("v1"), 1 ether, false, true, WETH, OTHER);
        BondRegistry.Protected memory r1 = _receipt("v1", 1 ether);
        bytes32 incident = reg.claim(c1, r1, _sign(KEY, r1), key);
        (SandwichCourtVerifier.Claim memory c2,) = _setup("v2", makeAddr("v2"), 1 ether, false, true, WETH, OTHER);
        BondRegistry.Protected memory r2 = _receipt("v2", 1 ether);
        assertEq(reg.claim(c2, r2, _sign(KEY, r2), key), incident, "same attacker legs, same incident");
        vm.warp(block.timestamp + WINDOW);
        uint256 total = reg.collect("v1") + reg.collect("v2");
        assertEq(total, 1 ether, "one attacker profit pays once in total");
        assertEq(makeAddr("v1").balance, 0.5 ether);
        assertEq(makeAddr("v2").balance, 0.5 ether);
        assertEq(reg.bondOf(rpc), 9 ether);
        assertEq(reg.reservedOf(rpc), 0);
    }

    function test_incident_capsThatFitTheBudgetPayInFull() public {
        _bond(10 ether);
        legs = "legs";
        (SandwichCourtVerifier.Claim memory c1, bytes memory key) =
            _setup("v1", makeAddr("v1"), 1 ether, false, true, WETH, OTHER);
        BondRegistry.Protected memory r1 = _receipt("v1", 0.3 ether);
        reg.claim(c1, r1, _sign(KEY, r1), key);
        (SandwichCourtVerifier.Claim memory c2,) = _setup("v2", makeAddr("v2"), 1 ether, false, true, WETH, OTHER);
        BondRegistry.Protected memory r2 = _receipt("v2", 0.2 ether);
        reg.claim(c2, r2, _sign(KEY, r2), key);
        vm.warp(block.timestamp + WINDOW);
        assertEq(reg.collect("v1"), 0.3 ether);
        assertEq(reg.collect("v2"), 0.2 ether);
        assertEq(reg.bondOf(rpc), 9.5 ether, "the unclaimed half of the profit stays in the bond");
    }

    function test_incident_sharesFollowTheCaps() public {
        _bond(10 ether);
        legs = "legs";
        (SandwichCourtVerifier.Claim memory c1, bytes memory key) =
            _setup("big", makeAddr("big"), 2 ether, false, true, WETH, OTHER);
        BondRegistry.Protected memory r1 = _receipt("big", 3 ether); // weight capped at the 2 ether budget
        reg.claim(c1, r1, _sign(KEY, r1), key);
        (SandwichCourtVerifier.Claim memory c2,) = _setup("small", makeAddr("small"), 2 ether, false, true, WETH, OTHER);
        BondRegistry.Protected memory r2 = _receipt("small", 1 ether);
        reg.claim(c2, r2, _sign(KEY, r2), key);
        vm.warp(block.timestamp + WINDOW);
        assertEq(reg.shareOf("big"), uint256(4 ether) / 3, "shareOf previews what collect pays");
        assertEq(reg.collect("big"), uint256(4 ether) / 3); // 2 * 2/3
        assertEq(reg.collect("small"), uint256(2 ether) / 3); // 2 * 1/3
    }

    function test_incident_eachRpcPaysFromItsOwnBond() public {
        uint256 key2 = 0xB0B;
        address rpc2 = vm.addr(key2);
        vm.deal(rpc2, 10 ether);
        _bond(10 ether);
        vm.prank(rpc2);
        reg.bond{value: 10 ether}();
        legs = "legs";
        (SandwichCourtVerifier.Claim memory c1, bytes memory pk) =
            _setup("v1", makeAddr("v1"), 1 ether, false, true, WETH, OTHER);
        BondRegistry.Protected memory r1 = _receipt("v1", 1 ether);
        reg.claim(c1, r1, _sign(KEY, r1), pk);
        (SandwichCourtVerifier.Claim memory c2,) = _setup("v2", makeAddr("v2"), 1 ether, false, true, WETH, OTHER);
        BondRegistry.Protected memory r2 = _receipt("v2", 1 ether);
        reg.claim(c2, r2, _sign(key2, r2), pk);
        assertEq(reg.reservedOf(rpc), 1 ether);
        assertEq(reg.reservedOf(rpc2), 1 ether);
        vm.warp(block.timestamp + WINDOW);
        reg.collect("v1");
        reg.collect("v2");
        assertEq(reg.bondOf(rpc), 9.5 ether);
        assertEq(reg.bondOf(rpc2), 9.5 ether);
    }

    function test_incident_windowRules() public {
        _bond(10 ether);
        legs = "legs";
        (SandwichCourtVerifier.Claim memory c1, bytes memory key) =
            _setup("v1", victim, 1 ether, false, true, WETH, OTHER);
        BondRegistry.Protected memory r1 = _receipt("v1", 1 ether);
        bytes32 incident = reg.claim(c1, r1, _sign(KEY, r1), key);
        (,, uint64 closesAt) = reg.incidents(incident);
        assertEq(closesAt, block.timestamp + WINDOW);

        vm.expectRevert(abi.encodeWithSelector(BondRegistry.ClaimWindowOpen.selector, closesAt));
        reg.collect("v1");

        vm.warp(closesAt); // the window is closed from closesAt on
        (SandwichCourtVerifier.Claim memory c2,) = _setup("v2", victim, 1 ether, false, true, WETH, OTHER);
        BondRegistry.Protected memory r2 = _receipt("v2", 1 ether);
        bytes memory sig2 = _sign(KEY, r2);
        vm.expectRevert(abi.encodeWithSelector(BondRegistry.ClaimWindowClosed.selector, incident, closesAt));
        reg.claim(c2, r2, sig2, key);

        reg.collect("v1");
        vm.expectRevert(abi.encodeWithSelector(BondRegistry.AlreadyCollected.selector, bytes32("v1")));
        reg.collect("v1");
        vm.expectRevert(abi.encodeWithSelector(BondRegistry.UnknownClaim.selector, bytes32("nope")));
        reg.collect("nope");
        (c1,) = _setup("v1", victim, 1 ether, false, true, WETH, OTHER);
        bytes memory sig1 = _sign(KEY, r1);
        vm.expectRevert(abi.encodeWithSelector(BondRegistry.AlreadyClaimed.selector, bytes32("v1")));
        reg.claim(c1, r1, sig1, key);
    }

    /// @dev Up to three claims on one incident: totals never exceed the profit, no claim exceeds its cap or reserve.
    function testFuzz_incidentConservation(uint96 profit, uint96[3] calldata caps, uint96 bond) public {
        vm.assume(bond > 0 && profit > 0);
        vm.deal(rpc, bond);
        _bond(bond);
        legs = "legs";
        bytes32[3] memory ids = [bytes32("a"), "b", "c"];
        for (uint256 i; i < 3; i++) {
            (SandwichCourtVerifier.Claim memory c, bytes memory key) =
                _setup(ids[i], address(uint160(0xBEEF + i)), profit, false, true, WETH, OTHER);
            BondRegistry.Protected memory r = _receipt(ids[i], caps[i]);
            bytes memory sig = _sign(KEY, r);
            if (reg.bondOf(rpc) == reg.reservedOf(rpc)) {
                vm.expectRevert(abi.encodeWithSelector(BondRegistry.NoBond.selector, rpc));
                reg.claim(c, r, sig, key);
                ids[i] = 0;
                continue;
            }
            reg.claim(c, r, sig, key);
        }
        vm.warp(block.timestamp + WINDOW);
        uint256 total;
        for (uint256 i; i < 3; i++) {
            if (ids[i] == 0) continue;
            uint256 paid = reg.collect(ids[i]);
            assertLe(paid, caps[i], "within its cap");
            total += paid;
        }
        assertLe(total, profit, "within the attacker's profit");
        assertLe(total, bond, "within the bond");
        assertEq(address(reg).balance, reg.bondOf(rpc), "ETH held = bonds");
        assertEq(reg.reservedOf(rpc), 0);
    }

    // ---- self-sandwich bounds (R8)

    function test_budget_frontFeeCapsTheProfit() public {
        _bond(10 ether);
        frontIn = 100 ether; // at 0.05%: a 0.05 ether fee
        (SandwichCourtVerifier.Claim memory c, bytes memory key) =
            _setup("tx", victim, 1 ether, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("tx", 10 ether);
        bytes32 incident = reg.claim(c, r, _sign(KEY, r), key);
        (uint256 budget,,) = reg.incidents(incident);
        assertEq(budget, 0.05 ether);
        vm.warp(block.timestamp + WINDOW);
        assertEq(reg.collect("tx"), 0.05 ether, "the profit is 1 ether, but faking it would only have cost the fee");
    }

    function test_rejects_zeroBudget() public {
        _bond(10 ether);
        frontIn = 1999; // 1999 * 500 / 1e6 rounds to 0
        (SandwichCourtVerifier.Claim memory c, bytes memory key) =
            _setup("tx", victim, 1 ether, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("tx", 10 ether);
        bytes memory sig = _sign(KEY, r);
        uint256 before = reg.bondOf(rpc);
        vm.expectRevert(BondRegistry.ZeroBudget.selector);
        reg.claim(c, r, sig, key);
        assertEq(reg.bondOf(rpc), before, "no gas refund either");
        assertEq(reg.budgetFor(1 ether, 2000, 500), 1, "one more wei of input and the fee rounds to 1");
    }

    function test_rejects_unlistedPool() public {
        _bond(10 ether);
        v3Fee = 3000; // a real canonical-factory pool, just not one the deployer listed
        (SandwichCourtVerifier.Claim memory c, bytes memory key) = _setup("tx", victim, 1, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("tx", 10 ether);
        bytes memory sig = _sign(KEY, r);
        vm.expectRevert(BondRegistry.UnsupportedPool.selector);
        reg.claim(c, r, sig, key);
    }

    function test_rejects_dynamicFeePool() public {
        _bond(10 ether);
        v4Fee = DYNAMIC_FEE; // listed, but the key doesn't say what fee the legs paid
        (SandwichCourtVerifier.Claim memory c, bytes memory key) =
            _setup("tx", victim, 1, true, true, address(0), OTHER);
        BondRegistry.Protected memory r = _receipt("tx", 10 ether);
        bytes memory sig = _sign(KEY, r);
        vm.expectRevert(BondRegistry.UnsupportedPool.selector);
        reg.claim(c, r, sig, key);
    }

    function test_oneFront_manyBacks_shareOneBudget() public {
        _bond(10 ether);
        frontIn = 100 ether; // a 0.05 ether fee
        legs = "front";
        backLeg = "back 1";
        (SandwichCourtVerifier.Claim memory c1, bytes memory key) =
            _setup("v1", makeAddr("v1"), 1 ether, false, true, WETH, OTHER);
        BondRegistry.Protected memory r1 = _receipt("v1", 1 ether);
        bytes32 incident = reg.claim(c1, r1, _sign(KEY, r1), key);
        backLeg = "back 2"; // the same front-run, closed by another back leg
        (SandwichCourtVerifier.Claim memory c2,) = _setup("v2", makeAddr("v2"), 1 ether, false, true, WETH, OTHER);
        BondRegistry.Protected memory r2 = _receipt("v2", 1 ether);
        assertEq(reg.claim(c2, r2, _sign(KEY, r2), key), incident, "same front swap, same incident");
        vm.warp(block.timestamp + WINDOW);
        assertEq(reg.collect("v1") + reg.collect("v2"), 0.05 ether, "the front leg's fee funds one budget");
    }

    function test_rejects_oneBackClosingTwoFronts() public {
        _bond(10 ether);
        backLeg = "one back";
        legs = "front 1";
        (SandwichCourtVerifier.Claim memory c1, bytes memory key) =
            _setup("v1", makeAddr("v1"), 1 ether, false, true, WETH, OTHER);
        BondRegistry.Protected memory r1 = _receipt("v1", 1 ether);
        reg.claim(c1, r1, _sign(KEY, r1), key);
        legs = "front 2"; // a second front-run, but closed by the same back swap: only one round trip happened
        (SandwichCourtVerifier.Claim memory c2,) = _setup("v2", makeAddr("v2"), 1 ether, false, true, WETH, OTHER);
        BondRegistry.Protected memory r2 = _receipt("v2", 1 ether);
        bytes memory sig2 = _sign(KEY, r2);
        vm.expectRevert(BondRegistry.BackLegReused.selector);
        reg.claim(c2, r2, sig2, key);
        c2.back.logIndex = 1; // another Swap log in the back tx is another back swap
        reg.claim(c2, r2, sig2, key);
    }

    function test_sameFrontTx_anotherSwapLog_isAnotherIncident() public {
        _bond(10 ether);
        legs = "front";
        (SandwichCourtVerifier.Claim memory c1, bytes memory key) =
            _setup("v1", makeAddr("v1"), 1 ether, false, true, WETH, OTHER);
        BondRegistry.Protected memory r1 = _receipt("v1", 1 ether);
        bytes32 first = reg.claim(c1, r1, _sign(KEY, r1), key);
        backLeg = "its own back";
        (SandwichCourtVerifier.Claim memory c2,) = _setup("v2", makeAddr("v2"), 1 ether, false, true, WETH, OTHER);
        c2.front.logIndex = 1; // a second swap in the same tx and pool: it paid its own fee
        BondRegistry.Protected memory r2 = _receipt("v2", 1 ether);
        assertTrue(reg.claim(c2, r2, _sign(KEY, r2), key) != first);
    }

    // ---- number ranges (S17)

    /// @dev The budget is min(profit, frontIn * fee / 1e6, MAX_BUDGET), exactly, for any amounts: no overflow.
    function testFuzz_budget_exactForAnyAmounts(uint256 profit, uint256 frontIn_, uint24 feeRaw) public view {
        uint24 fee = uint24(bound(feeRaw, 0, 1e6));
        uint256 expected = FullMath.mulDiv(frontIn_, fee, 1e6); // 512-bit reference
        if (profit < expected) expected = profit;
        if (expected > MAX_BUDGET) expected = MAX_BUDGET;
        assertEq(reg.budgetFor(profit, frontIn_, fee), expected);
    }

    function test_extremeAmounts_payWithoutOverflow() public {
        // the largest profit and front input a v3 Swap log can carry (int256), three RPCs' claims with unlimited caps
        uint256[3] memory keys = [KEY, 0xB0B, 0xC0C];
        frontIn = uint256(type(int256).max);
        legs = "huge";
        bytes32[3] memory ids = [bytes32("a"), "b", "c"];
        for (uint256 i; i < 3; i++) {
            address signer = vm.addr(keys[i]);
            vm.deal(signer, 10 ether);
            vm.prank(signer);
            reg.bond{value: 10 ether}();
            (SandwichCourtVerifier.Claim memory c, bytes memory key) =
                _setup(ids[i], address(uint160(0xBEEF + i)), type(uint256).max, false, true, WETH, OTHER);
            BondRegistry.Protected memory r = _receipt(ids[i], type(uint256).max);
            bytes32 incident = reg.claim(c, r, _sign(keys[i], r), key);
            (uint256 budget, uint256 totalWeight,) = reg.incidents(incident);
            assertEq(budget, MAX_BUDGET, "capped above all ETH");
            assertEq(totalWeight, MAX_BUDGET * (i + 1), "weights add up without overflow");
        }
        vm.warp(block.timestamp + WINDOW);
        uint256 total;
        for (uint256 i; i < 3; i++) {
            total += reg.collect(ids[i]); // budget * weight / totalWeight, capped by what each RPC reserved
        }
        assertEq(total, 30 ether, "each claim gets its RPC's whole bond, which is all there is");
        assertEq(address(reg).balance, 0);
    }

    // ---- which token the profit is in

    function test_profitToken_allFourSides() public {
        _bond(10 ether);
        // v3, profit in token0 = WETH
        (SandwichCourtVerifier.Claim memory c, bytes memory key) = _setup("a", victim, 1, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("a", 1 ether);
        reg.claim(c, r, _sign(KEY, r), key);
        // v3, profit in token1 = WETH
        (c, key) = _setup("b", victim, 2, false, false, OTHER, WETH);
        r = _receipt("b", 1 ether);
        reg.claim(c, r, _sign(KEY, r), key);
        // v4, profit in currency1 = WETH
        (c, key) = _setup("c", victim, 3, true, false, OTHER, WETH);
        r = _receipt("c", 1 ether);
        reg.claim(c, r, _sign(KEY, r), key);
        // v4, profit in currency0 = native ETH
        (c, key) = _setup("d", victim, 4, true, true, address(0), OTHER);
        r = _receipt("d", 1 ether);
        reg.claim(c, r, _sign(KEY, r), key);
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

        vm.warp(block.timestamp + WINDOW);
        reg.collect("a");
        reg.collect("b");
        reg.collect("c");
        reg.collect("d");
        assertEq(victim.balance, 1 + 2 + 3 + 4);
    }

    function _verdict(bytes32 txHash, bool inToken0, uint256 profit)
        internal
        view
        returns (SandwichCourtVerifier.Verdict memory)
    {
        return SandwichCourtVerifier.Verdict(100, bytes32(0), txHash, address(0xBAD), victim, inToken0, profit, frontIn);
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

    // ---- receipts and signatures

    function test_signature_vAsZeroOrOne() public {
        _bond(1 ether);
        (SandwichCourtVerifier.Claim memory c, bytes memory key) = _setup("tx", victim, 7, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("tx", 1 ether);
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(KEY, reg.receiptDigest(r));
        assertEq(_claimAndCollect(c, r, abi.encodePacked(rr, s, v - 27), key), 7);
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
        assertEq(_claimAndCollect(c, r, sig, key), 7);
    }

    function test_acceptedAt_boundary() public {
        _bond(1 ether);
        (SandwichCourtVerifier.Claim memory c, bytes memory key) = _setup("tx", victim, 7, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("tx", 1 ether);
        r.acceptedAt = uint64(BLOCK_TIME + 1);
        bytes memory sig = _sign(KEY, r);
        vm.expectRevert(abi.encodeWithSelector(BondRegistry.IssuedAfterIncident.selector, BLOCK_TIME + 1, BLOCK_TIME));
        reg.claim(c, r, sig, key);
        r.acceptedAt = uint64(BLOCK_TIME);
        assertEq(_claimAndCollect(c, r, _sign(KEY, r), key), 7);
    }

    function test_rejects_noBeneficiary() public {
        _bond(1 ether);
        (SandwichCourtVerifier.Claim memory c, bytes memory key) = _setup("tx", victim, 7, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("tx", 1 ether);
        r.beneficiary = address(0);
        bytes memory sig = _sign(KEY, r);
        vm.expectRevert(BondRegistry.NoBeneficiary.selector);
        reg.claim(c, r, sig, key);
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
                    "Protected(bytes32 txHash,uint256 chainId,uint64 acceptedAt,uint64 maxBlock,uint256 maxPayout,address beneficiary)"
                ),
                r.txHash,
                r.chainId,
                r.acceptedAt,
                r.maxBlock,
                r.maxPayout,
                r.beneficiary
            )
        );
        assertEq(reg.receiptDigest(r), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }

    // ---- transfers and reentrancy

    function test_beneficiaryThatRejectsEth_staysCollectable() public {
        _bond(1 ether);
        address bad = address(new Reverter());
        (SandwichCourtVerifier.Claim memory c, bytes memory key) = _setup("tx", bad, 7, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("tx", 1 ether);
        reg.claim(c, r, _sign(KEY, r), key);
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(BondRegistry.TransferFailed.selector);
        reg.collect("tx");
        assertFalse(_collected("tx"));
        assertEq(reg.bondOf(rpc), 1 ether);
        assertEq(reg.reservedOf(rpc), 7, "the reservation is kept for a later collect");
    }

    function test_reentrantBeneficiary_cannotCollectTwice() public {
        _bond(1 ether);
        Reenterer re = new Reenterer();
        (SandwichCourtVerifier.Claim memory c, bytes memory key) =
            _setup("tx", address(re), 7, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("tx", 1 ether);
        reg.claim(c, r, _sign(KEY, r), key);
        vm.warp(block.timestamp + WINDOW);
        re.arm(reg, "tx");
        re.collect();
        assertTrue(re.reentryFailed(), "the nested collect hit AlreadyCollected");
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

    function test_unbond_keepsReservationsForOpenClaims() public {
        _bond(1 ether);
        (SandwichCourtVerifier.Claim memory c, bytes memory key) =
            _setup("tx", victim, 0.4 ether, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt("tx", 1 ether);
        reg.claim(c, r, _sign(KEY, r), key);
        vm.prank(rpc);
        reg.requestUnbond();
        vm.warp(block.timestamp + DELAY);
        uint256 before = rpc.balance;
        vm.prank(rpc);
        reg.unbond();
        assertEq(rpc.balance - before, 0.6 ether, "only the unreserved part leaves");
        reg.collect("tx");
        assertEq(victim.balance, 0.4 ether, "the claim still pays after the unbond");
        assertEq(reg.bondOf(rpc), 0);
    }
}

/// @dev Random bonds, unbond requests, time, claims on a few shared incidents, and collections, across three RPCs.
contract RegistryHandler is RegistryBase {
    uint256[3] keys = [uint256(0xA1), 0xA2, 0xA3];
    uint256 nonce;
    bytes32[] public open;
    mapping(bytes32 incident => uint256) public paidOut;
    mapping(bytes32 incident => uint256) public budgetOf;
    bool public overpaid;

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
        vm.warp(block.timestamp + (dt % 2 days));
    }

    function unbond(uint8 who) external {
        address a = vm.addr(keys[who % 3]);
        uint256 at = reg.unbondAt(a);
        if (at == 0 || block.timestamp < at) return;
        vm.prank(a);
        reg.unbond();
    }

    function claim(uint8 who, uint8 leg, uint96 profit, uint96 cap) external {
        uint256 key = keys[who % 3];
        address rpc = vm.addr(key);
        if (reg.bondOf(rpc) == reg.reservedOf(rpc)) return;
        legs = bytes32(uint256(leg % 4) + 1); // four incidents, shared by many claims
        bytes32 incident = _incidentOf(legs);
        (,, uint64 closesAt) = reg.incidents(incident);
        if (closesAt != 0 && block.timestamp >= closesAt) return;
        if (closesAt == 0 && profit == 0) return; // a zero budget never opens an incident
        uint256 budget = closesAt == 0 ? profit : budgetOf[incident];
        bytes32 txHash = keccak256(abi.encode(nonce++));
        (SandwichCourtVerifier.Claim memory c, bytes memory pk) =
            _setup(txHash, address(uint160(uint256(txHash))), budget, false, true, WETH, OTHER);
        BondRegistry.Protected memory r = _receipt(txHash, cap);
        reg.claim(c, r, _sign(key, r), pk);
        budgetOf[incident] = budget;
        open.push(txHash);
    }

    function collect(uint256 i) external {
        if (open.length == 0) return;
        bytes32 txHash = open[i % open.length];
        (bytes32 incident,,,,, bool done) = reg.claims(txHash);
        (,, uint64 closesAt) = reg.incidents(incident);
        if (done || block.timestamp < closesAt) return;
        paidOut[incident] += reg.collect(txHash);
        if (paidOut[incident] > budgetOf[incident]) overpaid = true;
    }

    function totalBonds() external view returns (uint256 s) {
        for (uint256 i; i < 3; i++) {
            s += reg.bondOf(vm.addr(keys[i]));
        }
    }

    function reservationsCovered() external view returns (bool) {
        for (uint256 i; i < 3; i++) {
            address a = vm.addr(keys[i]);
            if (reg.reservedOf(a) > reg.bondOf(a)) return false;
        }
        return true;
    }

    /// @dev The id BondRegistry derives for a v3 claim made by `_setup` with these legs.
    function _incidentOf(bytes32 l) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                block.chainid,
                bytes32(0),
                _v3Pool(WETH, OTHER, 500),
                bytes32(0),
                keccak256(abi.encode("front", l)),
                uint256(0) // front log index
            )
        );
    }
}

contract BondRegistryInvariantTest is RegistryBase {
    RegistryHandler handler;

    function setUp() public {
        _deploy();
        handler = new RegistryHandler(reg, mock);
        targetContract(address(handler));
    }

    /// @dev Every wei the registry holds belongs to some RPC's bond: claims, refunds and unbonds never over-pay.
    function invariant_ethHeldEqualsBonds() public view {
        assertEq(address(reg).balance, handler.totalBonds());
    }

    /// @dev No incident pays out more than the attacker's profit, however many claims share it.
    function invariant_incidentNeverOverpays() public view {
        assertFalse(handler.overpaid());
    }

    /// @dev Reservations never exceed the bond they hold back.
    function invariant_reservationsCovered() public view {
        assertTrue(handler.reservationsCovered());
    }
}
