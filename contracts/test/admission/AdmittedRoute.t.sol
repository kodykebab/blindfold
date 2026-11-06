// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AdmittedSettlementTest} from "./AdmittedSettlement.t.sol";
import {AdmissionProof} from "../../src/admission/AdmissionProof.sol";
import {BatchAuction} from "../../src/BatchAuction.sol";
import {UniswapV3Route} from "../../src/market/UniswapV3Route.sol";
import {UniswapV3Market} from "../../src/market/UniswapV3Market.sol";
import {IV3Factory, IV3Pool} from "../../src/market/IExternalMarket.sol";
import {RouteFactoryMock, RoutePoolMock} from "../UniswapV3Route.t.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

contract AdmittedRouteTest is AdmittedSettlementTest {
    function test_admittedMultihopSellRollbackAndRetry() public {
        _roundTrip(true);
    }

    function test_admittedMultihopBuyRollbackAndRetry() public {
        _roundTrip(false);
    }

    function _roundTrip(bool sell) internal {
        MockERC20 middle = new MockERC20("Middle", "M", 18);
        RouteFactoryMock factory = new RouteFactoryMock();
        address[] memory path = new address[](3);
        path[0] = address(t0);
        path[1] = address(middle);
        path[2] = address(t1);
        UniswapV3Route.HopConfig[] memory hops = new UniswapV3Route.HopConfig[](2);
        RoutePoolMock finalPool;
        for (uint256 i; i < 2; i++) {
            (address a, address b) = path[i] < path[i + 1] ? (path[i], path[i + 1]) : (path[i + 1], path[i]);
            RoutePoolMock pool = new RoutePoolMock(a, b, address(factory));
            factory.setPool(a, b, address(pool));
            MockERC20(a).mint(address(pool), 1000);
            MockERC20(b).mint(address(pool), 1000);
            pool.setOutputBps(10_000);
            hops[i] = UniswapV3Route.HopConfig(IV3Pool(address(pool)), 1e17, 120);
            if (i == (sell ? 1 : 0)) finalPool = pool;
        }
        UniswapV3Route route = new UniswapV3Route(address(s), IV3Factory(address(factory)), path, hops, 600, 30, 100);
        s.configureExternal(route);
        BatchAuction.Order memory order = BatchAuction.Order(alice, sell, 10, 10);
        bytes32 salt = bytes32(uint256(1));
        AdmissionProof.Statement memory a = statement();
        a.orderHash = s.orderHash(0, order, salt);
        uint256 id = admit(a);
        vm.warp(s.revealOpens(0));
        vm.prank(alice);
        s.reveal(id, order, salt);
        vm.warp(s.revealCloses(0));

        MockERC20 input = sell ? t0 : t1;
        uint256 beforeBalance = vault.balanceOf(alice, address(input));
        finalPool.setOutputBps(8000);
        vm.expectRevert(UniswapV3Market.InsufficientOutput.selector);
        s.settleExternal(0, 1 << 96);
        assertFalse(s.finalized(0));
        assertEq(vault.openCommitments(alice), 1);
        assertEq(vault.lockedOf(alice, address(input)), 10);
        assertEq(vault.balanceOf(alice, address(input)), beforeBalance);
        assertEq(s.fundingRoot(alice), a.newRoot);
        assertEq(t0.balanceOf(address(route)) + t1.balanceOf(address(route)) + middle.balanceOf(address(route)), 0);

        finalPool.setOutputBps(10_000);
        s.settleExternal(0, 1 << 96);
        assertTrue(s.finalized(0));
        assertEq(vault.openCommitments(alice), 0);
        assertEq(vault.balanceOf(alice, address(t0)), sell ? 90 : 110);
        assertEq(vault.balanceOf(alice, address(t1)), sell ? 109 : 89);
        assertEq(vault.balanceOf(alice, address(middle)), 0);
        assertEq(middle.balanceOf(address(route)), 0);
        (, bytes32 root, uint256 step) = s.admissionState(alice);
        assertEq(root, bytes32(0));
        assertEq(step, 0);
    }
}
