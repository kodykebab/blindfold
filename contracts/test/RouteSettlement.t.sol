// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {BlindfoldTest} from "./Blindfold.t.sol";
import {BlindfoldSettlement} from "../src/BlindfoldSettlement.sol";
import {BatchAuction} from "../src/BatchAuction.sol";
import {UniswapV3Route} from "../src/market/UniswapV3Route.sol";
import {UniswapV3Market} from "../src/market/UniswapV3Market.sol";
import {IV3Factory, IV3Pool} from "../src/market/IExternalMarket.sol";
import {RouteFactoryMock, RoutePoolMock} from "./UniswapV3Route.t.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

contract RouteSettlementTest is BlindfoldTest {
    UniswapV3Route route;
    MockERC20 middle;
    RoutePoolMock lastPool;

    function setUp() public override {
        super.setUp();
        middle = new MockERC20("Middle", "M", 18);
        RouteFactoryMock f = new RouteFactoryMock();
        address[] memory path = new address[](3);
        path[0] = address(t0);
        path[1] = address(middle);
        path[2] = address(t1);
        UniswapV3Route.HopConfig[] memory hops = new UniswapV3Route.HopConfig[](2);
        for (uint256 i; i < 2; i++) {
            (address a, address b) = path[i] < path[i + 1] ? (path[i], path[i + 1]) : (path[i + 1], path[i]);
            RoutePoolMock pool = new RoutePoolMock(a, b, address(f));
            f.setPool(a, b, address(pool));
            MockERC20(a).mint(address(pool), 1e30);
            MockERC20(b).mint(address(pool), 1e30);
            hops[i] = UniswapV3Route.HopConfig(IV3Pool(address(pool)), 1e17, 120);
            lastPool = pool;
        }
        route = new UniswapV3Route(address(s), IV3Factory(address(f)), path, hops, 600, 30, 100);
        s.configureExternal(route);
    }

    function _readyRoute(bool sell) internal returns (uint64 b, uint256 id) {
        b = s.currentBatch();
        BatchAuction.Order memory o = _o(alice, sell, 100e18, 90e18);
        id = _commit(alice, o, "route");
        vm.warp(s.revealOpens(b));
        s.reveal(id, o, "route");
        lp.modifyLiquidity(key, IPoolManager.ModifyLiquidityParams(-60_000, 60_000, -1e22, 0), "");
        vm.warp(s.revealCloses(b));
    }

    function test_routeSettlement_bothDirectionsNoIntermediateFunding() public {
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < 2; i++) {
            bool sell = i == 0;
            (uint64 b,) = _readyRoute(sell);
            address output = sell ? address(t1) : address(t0);
            uint256 beforeOut = vault.balanceOf(alice, output);
            s.settleExternal(b, sell ? Q96 - Q96 / 100 : Q96 + Q96 / 100);
            assertEq(vault.balanceOf(alice, output) - beforeOut, 99.8001e18);
            assertEq(vault.balanceOf(alice, address(middle)), 0);
            assertEq(middle.balanceOf(address(route)), 0);
            assertEq(vault.openCommitments(alice), 0);
            assertEq(vault.balanceOf(address(s), address(t0)) + vault.balanceOf(address(s), address(t1)), 0);
            _assertSolvent();
            if (i == 0) vm.revertToState(snap);
        }
    }

    function test_routeSettlement_rejectsShortPrefundingBeforeSpendingDonations() public {
        (uint64 b,) = _readyRoute(true);
        t0.mint(address(route), 100e18);
        vm.mockCall(
            address(t0), abi.encodeWithSignature("transfer(address,uint256)", address(route), 100e18), abi.encode(true)
        );
        vm.expectRevert(BlindfoldSettlement.ExternalInputTransfer.selector);
        s.settleExternal(b, Q96 - Q96 / 100);
        vm.clearMockedCalls();
        assertFalse(s.finalized(b));
        assertEq(t0.balanceOf(address(route)), 100e18);
        assertEq(vault.lockedOf(alice, address(t0)), 100e18);
        _assertSolvent();
    }

    function test_routeSettlement_badFinalHopRollsBackAndExpires() public {
        (uint64 b,) = _readyRoute(true);
        lastPool.setOutputBps(8000);
        vm.expectRevert(UniswapV3Market.InsufficientOutput.selector);
        s.settleExternal(b, Q96 - Q96 / 100);
        assertFalse(s.finalized(b));
        assertEq(vault.lockedOf(alice, address(t0)), 100e18);
        assertEq(t0.balanceOf(address(route)) + middle.balanceOf(address(route)) + t1.balanceOf(address(route)), 0);
        vm.warp(s.settleCloses(b));
        s.expire(b);
        assertEq(vault.openCommitments(alice), 0);
        _assertSolvent();
    }
}
