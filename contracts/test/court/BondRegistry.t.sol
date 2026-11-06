// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {stdJson} from "forge-std/StdJson.sol";
import {CourtFixtures} from "./SandwichCourt.t.sol";
import {SandwichCourtVerifier} from "../../src/court/SandwichCourtVerifier.sol";
import {BondRegistry} from "../../src/court/BondRegistry.sol";

/// @notice BondRegistry against the real mainnet sandwiches in fixtures/: v4 (ETH/0x373c…, hooked; profit in ETH)
///         and v3 (WETH/USDT 0.01%; profit in USDT, which is not valued).
contract BondRegistryTest is CourtFixtures {
    using stdJson for string;

    // Ethereum mainnet
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address constant V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    bytes32 constant V3_INIT_CODE_HASH = 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;
    address constant V4_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    // the v4 fixture's PoolKey, read from the back-run tx's calldata (it hashes to the fixture's poolId)
    address constant V4_TOKEN1 = 0x373C863E4C34Db35B58C98Dd15a018E1ab53F6ea;
    address constant V4_HOOKS = 0x15e5E7206C661a1E881F5CD33A94eAF2328FA8cc;
    uint256 constant DELAY = 2 days;
    uint256 constant BOND = 10 ether;

    BondRegistry reg;
    uint256 constant RPC_KEY = 0xA11CE;
    address rpc;
    address prover = makeAddr("prover");

    function setUp() public override {
        super.setUp();
        rpc = vm.addr(RPC_KEY);
        reg = _registry(WETH, V4_POOL_MANAGER);
        vm.deal(rpc, 100 ether);
        vm.prank(rpc);
        reg.bond{value: BOND}();
    }

    // ---- payouts

    function test_v4_local_paysVictimTheProfit() public {
        (SandwichCourtVerifier.Claim memory c, SandwichCourtVerifier.Verdict memory v) = _localV4();
        assertTrue(v.profitInToken0, "attacker profits in currency0 = native ETH");
        uint256 paid = _claimAndCheck(c, _receipt(v, 100 ether), _v4Key(), v.profit);
        assertEq(paid, v.profit);
        assertEq(reg.bondOf(rpc), BOND - v.profit);
    }

    function test_v3_profitInUsdt_revertsUnpaid() public {
        // the real v3 sandwich starts and profits in USDT: no oracle, so it is not paid and stays claimable
        (SandwichCourtVerifier.Claim memory c, string memory j) = _claim(V3);
        vm.chainId(1);
        _installBlockhash(j);
        SandwichCourtVerifier.Verdict memory v = court.verify(c);
        assertFalse(v.profitInToken0);
        BondRegistry.Protected memory r = _receipt(v, 100 ether);
        bytes memory sig = _sign(RPC_KEY, r);
        vm.expectRevert(abi.encodeWithSelector(BondRegistry.UnvaluedProfit.selector, USDT));
        reg.claim(c, r, sig, abi.encode(WETH, USDT, uint24(100)));
        assertFalse(reg.paid(r.txHash));
    }

    function test_v4_anchored_paysVictimInNativeEth() public {
        (SandwichCourtVerifier.Claim memory c, SandwichCourtVerifier.Verdict memory v) = _anchoredV4();
        assertTrue(v.profitInToken0, "attacker profits in currency0 = native ETH");
        _claimAndCheck(c, _receipt(v, 100 ether), _v4Key(), v.profit);
    }

    function test_payoutCappedByReceipt() public {
        // the self-sandwich bound (R8): whoever controls both sides gets at most the receipt's cap
        (SandwichCourtVerifier.Claim memory c, SandwichCourtVerifier.Verdict memory v) = _localV4();
        uint256 cap = v.profit / 3;
        _claimAndCheck(c, _receipt(v, cap), _v4Key(), cap);
    }

    function test_payoutLimitedByBond() public {
        (SandwichCourtVerifier.Claim memory c, SandwichCourtVerifier.Verdict memory v) = _localV4();
        uint256 key = 0xB0B;
        address thin = vm.addr(key);
        vm.deal(thin, 1 ether);
        vm.prank(thin);
        reg.bond{value: v.profit / 2}();
        BondRegistry.Protected memory r = _receipt(v, 100 ether);
        _claimAndCheckSigned(c, r, _sign(key, r), _v4Key(), v.profit / 2);
        assertEq(reg.bondOf(thin), 0);
    }

    function test_proverGetsGasAtBasefee() public {
        (SandwichCourtVerifier.Claim memory c, SandwichCourtVerifier.Verdict memory v) = _localV4();
        vm.fee(1 gwei);
        BondRegistry.Protected memory r = _receipt(v, 100 ether);
        bytes memory sig = _sign(RPC_KEY, r); // before the prank: _sign makes an external call
        vm.prank(prover);
        reg.claim(c, r, sig, _v4Key());
        uint256 refund = prover.balance;
        assertGt(refund, 0);
        assertEq(reg.bondOf(rpc), BOND - v.profit - refund);
    }

    // ---- rejections

    function test_rejects_replay() public {
        (SandwichCourtVerifier.Claim memory c, SandwichCourtVerifier.Verdict memory v) = _localV4();
        BondRegistry.Protected memory r = _receipt(v, 100 ether);
        bytes memory sig = _sign(RPC_KEY, r);
        reg.claim(c, r, sig, _v4Key());
        vm.expectRevert(abi.encodeWithSelector(BondRegistry.AlreadyPaid.selector, r.txHash));
        reg.claim(c, r, sig, _v4Key());
    }

    function test_rejects_receiptForAnotherTx() public {
        (SandwichCourtVerifier.Claim memory c, SandwichCourtVerifier.Verdict memory v) = _localV4();
        BondRegistry.Protected memory r = _receipt(v, 100 ether);
        r.txHash = keccak256("some other tx");
        bytes memory sig = _sign(RPC_KEY, r);
        vm.expectRevert(BondRegistry.NotReceipted.selector);
        reg.claim(c, r, sig, _v4Key());
    }

    function test_rejects_landedAfterMaxBlock() public {
        (SandwichCourtVerifier.Claim memory c, SandwichCourtVerifier.Verdict memory v) = _localV4();
        BondRegistry.Protected memory r = _receipt(v, 100 ether);
        r.maxBlock = uint64(v.blockNumber - 1);
        bytes memory sig = _sign(RPC_KEY, r);
        vm.expectRevert(abi.encodeWithSelector(BondRegistry.TooLate.selector, v.blockNumber, v.blockNumber - 1));
        reg.claim(c, r, sig, _v4Key());
    }

    function test_rejects_wrongChain() public {
        (SandwichCourtVerifier.Claim memory c, SandwichCourtVerifier.Verdict memory v) = _localV4();
        BondRegistry.Protected memory r = _receipt(v, 100 ether);
        r.chainId = 8453;
        bytes memory sig = _sign(RPC_KEY, r);
        vm.expectRevert(BondRegistry.WrongChain.selector);
        reg.claim(c, r, sig, _v4Key());
    }

    function test_rejects_localPathForAnotherChain() public {
        // registry on chain 31337 judging Ethereum: a claim without an L1 anchor would read local hashes
        (SandwichCourtVerifier.Claim memory c, string memory j) = _claim(V3);
        _installBlockhash(j);
        SandwichCourtVerifier.Verdict memory v = court.verify(c);
        BondRegistry.Protected memory r = _receipt(v, 100 ether);
        bytes memory sig = _sign(RPC_KEY, r);
        vm.expectRevert(BondRegistry.WrongChain.selector);
        reg.claim(c, r, sig, _v4Key());
    }

    function test_rejects_unbondedSigner() public {
        (SandwichCourtVerifier.Claim memory c, SandwichCourtVerifier.Verdict memory v) = _localV4();
        BondRegistry.Protected memory r = _receipt(v, 100 ether);
        bytes memory sig = _sign(0xBAD, r);
        vm.expectRevert(abi.encodeWithSelector(BondRegistry.NoBond.selector, vm.addr(0xBAD)));
        reg.claim(c, r, sig, _v4Key());
    }

    function test_rejects_tamperedReceipt() public {
        (SandwichCourtVerifier.Claim memory c, SandwichCourtVerifier.Verdict memory v) = _localV4();
        BondRegistry.Protected memory r = _receipt(v, 1);
        bytes memory sig = _sign(RPC_KEY, r);
        r.maxPayout = 100 ether; // raise the cap after signing: recovers a different, unbonded signer
        vm.expectRevert();
        reg.claim(c, r, sig, _v4Key());
    }

    function test_rejects_v3PoolNotFromFactory() public {
        (SandwichCourtVerifier.Claim memory c, string memory j) = _claim(V3);
        vm.chainId(1);
        _installBlockhash(j);
        BondRegistry.Protected memory r = _receipt(court.verify(c), 100 ether);
        bytes memory sig = _sign(RPC_KEY, r);
        vm.expectRevert(BondRegistry.UnknownPool.selector);
        reg.claim(c, r, sig, abi.encode(WETH, USDT, uint24(500))); // wrong fee tier: a different pool address
    }

    function test_rejects_v4NotCanonicalPoolManager() public {
        reg = _registry(WETH, address(0x4444)); // pinned to a different PoolManager
        vm.prank(rpc);
        reg.bond{value: BOND}();
        (SandwichCourtVerifier.Claim memory c, SandwichCourtVerifier.Verdict memory v) = _anchoredV4();
        BondRegistry.Protected memory r = _receipt(v, 100 ether);
        bytes memory sig = _sign(RPC_KEY, r);
        vm.expectRevert(BondRegistry.UnknownPool.selector);
        reg.claim(c, r, sig, _v4Key());
    }

    function test_rejects_v4WrongPoolKey() public {
        (SandwichCourtVerifier.Claim memory c, SandwichCourtVerifier.Verdict memory v) = _anchoredV4();
        BondRegistry.Protected memory r = _receipt(v, 100 ether);
        bytes memory sig = _sign(RPC_KEY, r);
        vm.expectRevert(BondRegistry.UnknownPool.selector);
        reg.claim(c, r, sig, abi.encode(WETH, V4_TOKEN1, uint24(0), int24(60), V4_HOOKS)); // claims WETH, not ETH
    }

    // ---- unbonding

    function test_unbond_afterDelay_andClaimableMeanwhile() public {
        vm.prank(rpc);
        reg.requestUnbond();
        vm.prank(rpc);
        vm.expectRevert(abi.encodeWithSelector(BondRegistry.UnbondNotReady.selector, block.timestamp + DELAY));
        reg.unbond();

        (SandwichCourtVerifier.Claim memory c, SandwichCourtVerifier.Verdict memory v) = _localV4();
        _claimAndCheck(c, _receipt(v, 100 ether), _v4Key(), v.profit); // still pays during the delay

        vm.warp(block.timestamp + DELAY);
        uint256 before = rpc.balance;
        vm.prank(rpc);
        reg.unbond();
        assertEq(rpc.balance - before, BOND - v.profit);
        assertEq(reg.bondOf(rpc), 0);
    }

    function test_unbond_requiresRequest() public {
        vm.prank(rpc);
        vm.expectRevert(abi.encodeWithSelector(BondRegistry.UnbondNotReady.selector, 0));
        reg.unbond();
    }

    // ---- helpers

    function _registry(address weth, address pm) internal returns (BondRegistry) {
        return new BondRegistry(
            BondRegistry.Config({
                verifier: SandwichCourtVerifier(address(court)),
                sourceChainId: 1,
                weth: weth,
                v3Factory: V3_FACTORY,
                v3InitCodeHash: V3_INIT_CODE_HASH,
                v4PoolManager: pm,
                unbondDelay: DELAY
            })
        );
    }

    /// @dev Registry on Ethereum itself: local BLOCKHASH path.
    function _localV4()
        internal
        returns (SandwichCourtVerifier.Claim memory c, SandwichCourtVerifier.Verdict memory v)
    {
        vm.chainId(1);
        string memory j;
        (c, j) = _claim(V4);
        _installBlockhash(j);
        v = court.verify(c);
    }

    /// @dev Registry on an L2 judging Ethereum: L1-anchor path.
    function _anchoredV4()
        internal
        returns (SandwichCourtVerifier.Claim memory c, SandwichCourtVerifier.Verdict memory v)
    {
        string memory j;
        (c, j) = _anchoredClaim(V4);
        _checkpoint(j);
        v = court.verify(c);
    }

    function _v4Key() internal pure returns (bytes memory) {
        return abi.encode(address(0), V4_TOKEN1, uint24(0), int24(60), V4_HOOKS);
    }

    function _receipt(SandwichCourtVerifier.Verdict memory v, uint256 maxPayout)
        internal
        pure
        returns (BondRegistry.Protected memory)
    {
        return BondRegistry.Protected({
            txHash: v.victimTxHash, chainId: 1, acceptedAt: 0, maxBlock: uint64(v.blockNumber), maxPayout: maxPayout
        });
    }

    function _sign(uint256 key, BondRegistry.Protected memory r) internal view returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(key, reg.receiptDigest(r));
        return abi.encodePacked(rr, s, v);
    }

    function _claimAndCheck(
        SandwichCourtVerifier.Claim memory c,
        BondRegistry.Protected memory r,
        bytes memory poolKey,
        uint256 expected
    ) internal returns (uint256) {
        return _claimAndCheckSigned(c, r, _sign(RPC_KEY, r), poolKey, expected);
    }

    function _claimAndCheckSigned(
        SandwichCourtVerifier.Claim memory c,
        BondRegistry.Protected memory r,
        bytes memory sig,
        bytes memory poolKey,
        uint256 expected
    ) internal returns (uint256 paid) {
        SandwichCourtVerifier.Verdict memory v = court.verify(c);
        uint256 before = v.victim.balance;
        vm.prank(prover);
        paid = reg.claim(c, r, sig, poolKey);
        assertEq(paid, expected, "payout");
        assertEq(v.victim.balance - before, expected, "victim received the payout");
        assertTrue(reg.paid(r.txHash));
    }
}
