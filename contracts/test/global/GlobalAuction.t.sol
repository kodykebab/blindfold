// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {BlindfoldVault} from "../../src/BlindfoldVault.sol";
import {GlobalAuction} from "../../src/global/GlobalAuction.sol";
import {IGlobalAdmission} from "../../src/global/IGlobalAdmission.sol";
import {IExternalMarket} from "../../src/market/IExternalMarket.sol";

// Test-only statement checker. Production uses GlobalAdmissionVerifier and real Groth16 proofs.
contract GlobalProofMock is IGlobalAdmission {
    function verify(bytes32 p, bytes32 o, bytes calldata proof) external pure returns (bool) {
        if (proof.length == 64) return keccak256(proof) == keccak256(abi.encode(p, o));
        (bytes memory first, bytes memory second) = abi.decode(proof, (bytes, bytes));
        return keccak256(first) == keccak256(abi.encode(p)) && keccak256(second) == keccak256(abi.encode(o));
    }
}

contract GlobalMarketMock is IExternalMarket {
    address public settlement;
    address public token0;
    address public token1;
    uint256 public maxDeviationBps = 100;
    uint256 public rate = 1 << 96;
    bool public stale;
    bool public fail;
    uint256 public haircut;

    constructor(address s, address a, address b) {
        settlement = s;
        token0 = a;
        token1 = b;
    }

    function configure(uint256 p, bool stale_, bool fail_, uint256 haircut_) external {
        rate = p;
        stale = stale_;
        fail = fail_;
        haircut = haircut_;
    }

    function referencePrice(uint256) external view returns (uint256) {
        require(!stale, "stale");
        return rate;
    }

    function swap(bool direction, uint256 amount, uint256 minimum) external returns (uint256 out) {
        require(msg.sender == settlement && !fail, "swap");
        out = (direction ? amount * rate / (1 << 96) : amount * (1 << 96) / rate) - haircut;
        require(out >= minimum, "minimum");
        MockERC20(direction ? token1 : token0).transfer(msg.sender, out);
    }
}

contract GlobalAuctionTest is Test {
    uint128 constant ONE = type(uint128).max;
    uint256 constant Q = 1 << 96;
    GlobalAuction g;
    BlindfoldVault vault;
    GlobalProofMock proof;
    MockERC20[3] t;
    GlobalMarketMock[3] m;
    address a = address(0xa1);
    address b = address(0xb1);
    address c = address(0xc1);
    uint64 start;

    function setUp() public {
        start = uint64(GlobalGenesis() + 300);
        vm.warp(start);
        address[] memory tokenList = new address[](3);
        for (uint256 i; i < 3; i++) {
            t[i] = new MockERC20("token", "T", 18);
            tokenList[i] = address(t[i]);
        }
        for (uint256 i; i < 3; i++) {
            for (uint256 j = i + 1; j < 3; j++) {
                if (tokenList[i] > tokenList[j]) (tokenList[i], tokenList[j]) = (tokenList[j], tokenList[i]);
            }
        }
        for (uint256 i; i < 3; i++) {
            t[i] = MockERC20(tokenList[i]);
        }
        vault = new BlindfoldVault();
        proof = new GlobalProofMock();
        g = new GlobalAuction(
            GlobalAuction.Config(
                vault, proof, tokenList, start, 30, 12, 30, 10, 1, 2000, address(0xfee), keccak256("test identity")
            )
        );
        vault.setOperator(address(g));
        m[0] = new GlobalMarketMock(address(g), tokenList[0], tokenList[1]);
        m[1] = new GlobalMarketMock(address(g), tokenList[0], tokenList[2]);
        m[2] = new GlobalMarketMock(address(g), tokenList[1], tokenList[2]);
        g.addMarket(m[0], true);
        g.addMarket(m[1], true);
        g.addMarket(m[2], false);
        g.sealConfiguration();
        for (uint256 i; i < 3; i++) {
            for (uint256 j; j < 3; j++) {
                t[i].mint(address(m[j]), 1e24);
            }
            _fund(a, i, 1e20);
            _fund(b, i, 1e20);
            _fund(c, i, 1e20);
        }
    }

    function GlobalGenesis() private pure returns (uint256) {
        return 1692803367;
    }

    function _fund(address owner, uint256 index, uint256 amount) internal {
        t[index].mint(owner, amount);
        vm.startPrank(owner);
        t[index].approve(address(vault), amount);
        vault.deposit(address(t[index]), amount);
        vm.stopPrank();
    }

    function _order(address owner, uint8 input, uint8 output, uint128 amount, uint128 minimum)
        internal
        pure
        returns (GlobalAuction.Order memory)
    {
        return GlobalAuction.Order(owner, input, output, amount, minimum);
    }

    function _admit(GlobalAuction.Order memory o, bytes32 salt) internal returns (uint256 id) {
        uint64 batch = g.currentBatch();
        bytes32 hash = g.orderHash(batch, o, salt);
        bytes32 root = keccak256(abi.encode(o, salt, g.commitCount()));
        (bytes32 p, bytes32 q) =
            g.admissionStatements(o.owner, batch, hash, bytes32(uint256(1)), root, keccak256("ciphertext"));
        vm.prank(o.owner);
        id = g.admit(batch, hash, "ciphertext", bytes32(uint256(1)), root, abi.encode(p, q));
    }

    function _cycle(uint128 amount) internal returns (uint256[] memory ids) {
        ids = new uint256[](3);
        GlobalAuction.Order memory x = _order(a, 0, 1, amount, amount);
        GlobalAuction.Order memory y = _order(b, 1, 2, amount, amount);
        GlobalAuction.Order memory z = _order(c, 2, 0, amount, amount);
        ids[0] = _admit(x, "a");
        ids[1] = _admit(y, "b");
        ids[2] = _admit(z, "c");
        vm.warp(g.revealOpens(0));
        g.reveal(ids[0], x, "a");
        g.reveal(ids[1], y, "b");
        g.reveal(ids[2], z, "c");
        vm.warp(g.revealCloses(0));
    }

    function _fractions(uint256 n, uint128 fraction) internal pure returns (uint128[] memory f) {
        f = new uint128[](n);
        for (uint256 i; i < n; i++) {
            f[i] = fraction;
        }
    }

    function _settle(uint256 n, uint128 fraction) internal {
        g.settle(0, _fractions(n, fraction), new GlobalAuction.Route[](0));
    }

    function _clean() internal view {
        for (uint256 i; i < 3; i++) {
            assertEq(vault.lockedOf(a, address(t[i])), 0);
            assertEq(vault.lockedOf(b, address(t[i])), 0);
            assertEq(vault.lockedOf(c, address(t[i])), 0);
            assertEq(vault.balanceOf(address(g), address(t[i])), 0);
            uint256 sum = vault.balanceOf(a, address(t[i])) + vault.balanceOf(b, address(t[i]))
                + vault.balanceOf(c, address(t[i])) + vault.balanceOf(address(this), address(t[i]))
                + vault.balanceOf(address(0xfee), address(t[i]));
            assertEq(sum, t[i].balanceOf(address(vault)), "solvency");
        }
        assertEq(vault.openCommitments(a) + vault.openCommitments(b) + vault.openCommitments(c), 0);
    }

    function test_threeTokenCycleNeedsNoPoolExecution() public {
        _cycle(1000);
        for (uint256 i; i < 3; i++) {
            m[i].configure(Q, false, true, 0);
        }
        _settle(3, ONE);
        _clean();
    }

    function testFuzz_cycleConservesTokens(uint128 amount, uint128 share) public {
        amount = uint128(bound(amount, 2, 1e19));
        share = uint128(bound(share, ONE / 2 + 1, ONE));
        _cycle(amount);
        _settle(3, share);
        _clean();
    }

    function test_unbalancedCycleRollsBackAndExpires() public {
        _cycle(1000);
        uint128[] memory f = _fractions(3, ONE);
        f[0] = ONE / 2;
        vm.expectRevert();
        g.settle(0, f, new GlobalAuction.Route[](0));
        assertFalse(g.finalized(0));
        assertEq(vault.lockedOf(a, address(t[0])), 1000);
        vm.warp(g.settleCloses(0));
        g.expire(0);
        _clean();
    }

    function test_oneSidedExternalRoute() public {
        GlobalAuction.Order memory x = _order(a, 1, 2, 1000, 990);
        uint256 id = _admit(x, "a");
        vm.warp(g.revealOpens(0));
        g.reveal(id, x, "a");
        vm.warp(g.revealCloses(0));
        GlobalAuction.Route[] memory r = new GlobalAuction.Route[](1);
        r[0] = GlobalAuction.Route(1, 2, 2, 1000, 1000);
        g.settle(0, _fractions(1, ONE), r);
        _clean();
    }

    function test_reverseExternalRoute() public {
        GlobalAuction.Order memory x = _order(a, 2, 1, 1000, 990);
        uint256 id = _admit(x, "a");
        vm.warp(g.revealOpens(0));
        g.reveal(id, x, "a");
        vm.warp(g.revealCloses(0));
        GlobalAuction.Route[] memory r = new GlobalAuction.Route[](1);
        r[0] = GlobalAuction.Route(2, 1, 2, 1000, 1000);
        g.settle(0, _fractions(1, ONE), r);
        _clean();
    }

    function test_cannotSpendPayoutBudgetOnRoute() public {
        _cycle(1000);
        GlobalAuction.Route[] memory r = new GlobalAuction.Route[](1);
        r[0] = GlobalAuction.Route(0, 1, 0, 1, 1);
        vm.expectRevert(GlobalAuction.Allocation.selector);
        g.settle(0, _fractions(3, ONE), r);
    }

    function test_stalePriceRevertsEvenPureCycle() public {
        _cycle(1000);
        m[0].configure(Q, true, false, 0);
        vm.expectRevert("stale");
        _settle(3, ONE);
    }

    function test_changedProofStatementRejected() public {
        GlobalAuction.Order memory x = _order(a, 0, 1, 1000, 1000);
        bytes32 hash = g.orderHash(0, x, "a");
        (bytes32 p, bytes32 q) =
            g.admissionStatements(a, 0, hash, bytes32(uint256(1)), bytes32(uint256(2)), keccak256("ciphertext"));
        vm.prank(a);
        vm.expectRevert(GlobalAuction.InvalidProof.selector);
        g.admit(0, hash, "changed", bytes32(uint256(1)), bytes32(uint256(2)), abi.encode(p, q));
        assertEq(vault.openCommitments(a), 0);
    }

    function test_cannotWithdrawOrEnterOverlappingBatch() public {
        _admit(_order(a, 0, 1, 1000, 1000), "a");
        vm.prank(a);
        vm.expectRevert();
        vault.withdraw(address(t[2]), 1);
        vm.warp(start + 30);
        vm.expectRevert(GlobalAuction.State.selector);
        g.admissionStatements(a, 1, 0, 0, 0, 0);
    }

    function test_unrevealedExpiryReleasesAllTokens() public {
        _admit(_order(a, 0, 1, 1000, 1000), "a");
        vm.warp(g.settleCloses(0));
        g.expire(0);
        _clean();
        vm.prank(a);
        vault.withdraw(address(t[2]), 1);
    }

    function test_cannotConfigureAfterSealOrSetSecondOperator() public {
        vm.expectRevert();
        g.addMarket(m[0], false);
        vm.expectRevert();
        vault.setOperator(address(1));
    }

    function test_badRevealAndDuplicateSettle() public {
        _cycle(1000);
        _settle(3, ONE);
        vm.expectRevert();
        _settle(3, ONE);
        vm.expectRevert();
        g.reveal(0, _order(a, 0, 1, 999, 999), "a");
    }

    function test_equalLimitsCannotChooseWinners() public {
        GlobalAuction.Order memory x = _order(a, 0, 1, 1000, 900);
        GlobalAuction.Order memory y = _order(b, 0, 1, 2000, 1800);
        GlobalAuction.Order memory z = _order(c, 1, 0, 3000, 2700);
        uint256 ix = _admit(x, "a");
        uint256 iy = _admit(y, "b");
        uint256 iz = _admit(z, "c");
        vm.warp(g.revealOpens(0));
        g.reveal(ix, x, "a");
        g.reveal(iy, y, "b");
        g.reveal(iz, z, "c");
        vm.warp(g.revealCloses(0));
        uint128[] memory f = _fractions(3, ONE);
        f[0] = ONE / 2;
        vm.expectRevert(GlobalAuction.Allocation.selector);
        g.settle(0, f, new GlobalAuction.Route[](0));
        _settle(3, ONE / 2 + 1);
        _clean();
    }

    function test_betterLimitsMustFillBeforeWorse() public {
        GlobalAuction.Order memory x = _order(a, 0, 1, 1000, 800);
        GlobalAuction.Order memory y = _order(b, 0, 1, 1000, 900);
        uint256 ix = _admit(x, "a");
        uint256 iy = _admit(y, "b");
        vm.warp(g.revealOpens(0));
        g.reveal(ix, x, "a");
        g.reveal(iy, y, "b");
        vm.warp(g.revealCloses(0));
        uint128[] memory f = _fractions(2, ONE / 2);
        vm.expectRevert(GlobalAuction.Allocation.selector);
        g.settle(0, f, new GlobalAuction.Route[](0));
    }

    function test_maximumBatchSettlesWithinMeasuredGas() public {
        GlobalAuction.Order memory x = _order(a, 0, 1, 1000, 1000);
        GlobalAuction.Order memory y = _order(b, 1, 0, 1000, 1000);
        for (uint256 i; i < 64; i++) {
            _admit(i % 2 == 0 ? x : y, bytes32(i));
        }
        vm.prank(a);
        vm.expectRevert(GlobalAuction.State.selector);
        g.admit(0, bytes32(0), "", bytes32(0), bytes32(uint256(1)), "");
        vm.warp(g.revealOpens(0));
        for (uint256 i; i < 64; i++) {
            g.reveal(i, i % 2 == 0 ? x : y, bytes32(i));
        }
        vm.warp(g.revealCloses(0));
        uint256 before = gasleft();
        _settle(64, ONE);
        emit log_named_uint("global_64_order_settlement_gas", before - gasleft());
        _clean();
    }

    function test_lastRouteFailureRollsBackEveryEarlierTransfer() public {
        GlobalAuction.Order memory x = _order(a, 0, 1, 1000, 1000);
        GlobalAuction.Order memory y = _order(b, 0, 2, 1000, 1000);
        uint256 ix = _admit(x, "a");
        uint256 iy = _admit(y, "b");
        vm.warp(g.revealOpens(0));
        g.reveal(ix, x, "a");
        g.reveal(iy, y, "b");
        vm.warp(g.revealCloses(0));
        GlobalAuction.Route[] memory r = new GlobalAuction.Route[](2);
        r[0] = GlobalAuction.Route(0, 1, 0, 1000, 1000);
        r[1] = GlobalAuction.Route(0, 2, 1, 1000, 1000);
        uint256 before = t[0].balanceOf(address(m[0]));
        m[1].configure(Q, false, true, 0);
        vm.expectRevert(bytes("swap"));
        g.settle(0, _fractions(2, ONE), r);
        assertEq(t[0].balanceOf(address(m[0])), before);
        assertEq(vault.lockedOf(a, address(t[0])), 1000);
        m[1].configure(Q, false, false, 0);
        g.settle(0, _fractions(2, ONE), r);
        _clean();
    }

    function test_mixedRawUnitPricesClearCycle() public {
        // Raw quantities model tokens with different decimals; no 18-decimal assumption enters settlement.
        m[0].configure(Q * 10000000000, false, false, 0);
        m[1].configure(Q / 100, false, false, 0);
        uint256[8] memory prices = g.prices(0);
        uint128 amount0 = 1000000000000;
        uint128 amount1 = uint128(uint256(amount0) * prices[0] / prices[1]);
        uint128 amount2 = uint128(uint256(amount1) * prices[1] / prices[2]);
        _fund(a, 0, amount0);
        _fund(b, 1, amount1);
        _fund(c, 2, amount2);
        GlobalAuction.Order memory x = _order(a, 0, 1, amount0, amount1);
        GlobalAuction.Order memory y = _order(b, 1, 2, amount1, amount2);
        GlobalAuction.Order memory z = _order(c, 2, 0, amount2, 0);
        _admit(x, "a");
        _admit(y, "b");
        _admit(z, "c");
        vm.warp(g.revealOpens(0));
        g.reveal(0, x, "a");
        g.reveal(1, y, "b");
        g.reveal(2, z, "c");
        vm.warp(g.revealCloses(0));
        _settle(3, ONE);
        _clean();
    }

    function test_settledBatchStillAllowsUnrevealedCleanup() public {
        GlobalAuction.Order memory x = _order(a, 0, 1, 1000, 1000);
        _admit(x, "missing");
        GlobalAuction.Order memory y = _order(b, 0, 1, 1000, 1000);
        GlobalAuction.Order memory z = _order(c, 1, 0, 1000, 1000);
        _admit(y, "b");
        _admit(z, "c");
        vm.warp(g.revealOpens(0));
        g.reveal(1, y, "b");
        g.reveal(2, z, "c");
        vm.warp(g.revealCloses(0));
        uint128[] memory f = _fractions(3, ONE);
        f[0] = 0;
        g.settle(0, f, new GlobalAuction.Route[](0));
        assertEq(vault.openCommitments(a), 1);
        g.slashUnrevealed(0);
        _clean();
    }

    function test_oneSidedVenueFeeUsesBoundedPriceVector() public {
        GlobalAuction.Order memory x = _order(a, 1, 2, 10000, 9800);
        _admit(x, "a");
        vm.warp(g.revealOpens(0));
        g.reveal(0, x, "a");
        vm.warp(g.revealCloses(0));
        m[2].configure(Q, false, false, 30);
        GlobalAuction.Route[] memory r = new GlobalAuction.Route[](1);
        r[0] = GlobalAuction.Route(1, 2, 2, 10000, 9970);
        vm.expectRevert();
        g.settle(0, _fractions(1, ONE), r);
        uint256[8] memory p = g.prices(0);
        p[1] = Q - Q / 200;
        p[2] = Q + Q / 200;
        g.settleAtPrices(0, p, _fractions(1, ONE), r);
        _clean();
    }

    function test_rejectOutOfBandAndUnusedSlotPrices() public {
        _cycle(1000);
        uint256[8] memory p = g.prices(0);
        p[1] = Q + Q / 100 + 1;
        vm.expectRevert(GlobalAuction.Allocation.selector);
        g.settleAtPrices(0, p, _fractions(3, ONE), new GlobalAuction.Route[](0));
        p[1] = Q;
        p[7] = 1;
        vm.expectRevert(GlobalAuction.Allocation.selector);
        g.settleAtPrices(0, p, _fractions(3, ONE), new GlobalAuction.Route[](0));
    }

    function test_unrelatedStaleTokenCanBeExcludedWithoutInventingAPrice() public {
        GlobalAuction.Order memory x = _order(a, 0, 1, 1000, 1000);
        GlobalAuction.Order memory y = _order(b, 1, 0, 1000, 1000);
        GlobalAuction.Order memory z = _order(c, 0, 2, 1000, 900);
        _admit(x, "a");
        _admit(y, "b");
        _admit(z, "c");
        vm.warp(g.revealOpens(0));
        g.reveal(0, x, "a");
        g.reveal(1, y, "b");
        g.reveal(2, z, "c");
        vm.warp(g.revealCloses(0));
        m[1].configure(Q, true, false, 0);
        uint256[8] memory p;
        p[0] = Q;
        p[1] = Q;
        uint128[] memory f = _fractions(3, ONE);
        vm.expectRevert(GlobalAuction.Allocation.selector);
        g.settleAtPrices(0, p, f, new GlobalAuction.Route[](0));
        f[2] = 0;
        g.settleAtPrices(0, p, f, new GlobalAuction.Route[](0));
        _clean();
        assertEq(vault.balanceOf(c, address(t[2])), 1e20);
    }
}
