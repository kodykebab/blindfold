// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {UniswapV3Route} from "../src/market/UniswapV3Route.sol";
import {UniswapV3Market} from "../src/market/UniswapV3Market.sol";
import {IV3Pool, IV3Factory} from "../src/market/IExternalMarket.sol";

contract RouteFactoryMock {
    mapping(bytes32 => address) public pools;

    function setPool(address a, address b, address pool) external {
        pools[keccak256(abi.encode(a, b, uint24(500)))] = pool;
    }

    function getPool(address a, address b, uint24 f) external view returns (address) {
        return pools[keccak256(abi.encode(a, b, f))];
    }
}

contract RoutePoolMock {
    address public token0;
    address public token1;
    address public factory;
    uint24 public fee = 500;
    int24 public tick;
    int24 public spotTick;
    uint32 public observedAt;
    uint128 public liquidity = 1e18;
    uint256 public outputBps = 9990;
    bool public missingHistory;

    constructor(address a, address b, address f) {
        token0 = a;
        token1 = b;
        factory = f;
        observedAt = uint32(block.timestamp);
    }

    function setOracle(int24 t, int24 spot, uint32 at, uint128 l) external {
        tick = t;
        spotTick = spot;
        observedAt = at;
        liquidity = l;
    }

    function setOutputBps(uint256 x) external {
        outputBps = x;
    }

    function setMissingHistory() external {
        missingHistory = true;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (TickMath.getSqrtPriceAtTick(spotTick), spotTick, 0, 2, 2, 0, true);
    }

    function observations(uint256) external view returns (uint32, int56, uint160, bool) {
        return (observedAt, 0, 0, true);
    }

    function observe(uint32[] calldata ago) external view returns (int56[] memory ticks, uint160[] memory ls) {
        require(!missingHistory, "OLD");
        ticks = new int56[](2);
        ls = new uint160[](2);
        for (uint256 i; i < 2; i++) {
            uint256 time = block.timestamp - ago[i];
            ticks[i] = int56(uint56(time)) * tick;
            ls[i] = uint160((time << 128) / liquidity);
        }
    }

    function swap(address recipient, bool sell, int256 amount, uint160, bytes calldata)
        external
        returns (int256 a, int256 b)
    {
        uint160 sqrt = TickMath.getSqrtPriceAtTick(spotTick);
        uint256 p = FullMath.mulDiv(sqrt, sqrt, 1 << 96);
        uint256 out = sell ? FullMath.mulDiv(uint256(amount), p, 1 << 96) : FullMath.mulDiv(uint256(amount), 1 << 96, p);
        out = out * outputBps / 10_000;
        MockERC20(sell ? token1 : token0).transfer(recipient, out);
        (a, b) = sell ? (amount, -int256(out)) : (-int256(out), amount);
        UniswapV3Market(msg.sender).uniswapV3SwapCallback(a, b, "");
    }
}

contract UniswapV3RouteTest is Test {
    uint256 constant Q96 = 1 << 96;
    MockERC20[4] tokens;
    RouteFactoryMock factory;

    function setUp() public {
        vm.warp(1_800_000_000);
        factory = new RouteFactoryMock();
        for (uint256 i; i < 4; i++) {
            tokens[i] = new MockERC20("T", "T", 18);
        }
        for (uint256 i; i < 4; i++) {
            for (uint256 j = i + 1; j < 4; j++) {
                if (address(tokens[i]) > address(tokens[j])) (tokens[i], tokens[j]) = (tokens[j], tokens[i]);
            }
        }
    }

    function _route(uint256 count) internal returns (UniswapV3Route r, RoutePoolMock[] memory pools) {
        return _route(count, 120);
    }

    function _route(uint256 count, uint32 maxObservationAge)
        internal
        returns (UniswapV3Route r, RoutePoolMock[] memory pools)
    {
        address[] memory path = new address[](count + 1);
        UniswapV3Route.HopConfig[] memory hs = new UniswapV3Route.HopConfig[](count);
        pools = new RoutePoolMock[](count);
        for (uint256 i; i <= count; i++) {
            path[i] = address(tokens[i]);
        }
        // Three-hop case includes an internally reversed pair.
        if (count == 3) (path[1], path[2]) = (path[2], path[1]);
        for (uint256 i; i < count; i++) {
            (address a, address b) = path[i] < path[i + 1] ? (path[i], path[i + 1]) : (path[i + 1], path[i]);
            pools[i] = new RoutePoolMock(a, b, address(factory));
            factory.setPool(a, b, address(pools[i]));
            MockERC20(a).mint(address(pools[i]), 1e30);
            MockERC20(b).mint(address(pools[i]), 1e30);
            hs[i] = UniswapV3Route.HopConfig(IV3Pool(address(pools[i])), 1e17, maxObservationAge);
        }
        r = new UniswapV3Route(address(this), IV3Factory(address(factory)), path, hs, 600, 30, 100);
    }

    function test_route_oneTwoThreeHopsBothDirections() public {
        for (uint256 n = 1; n <= 3; n++) {
            (UniswapV3Route r,) = _route(n);
            assertEq(r.hopCount(), n);
            assertEq(r.referencePrice(block.timestamp), Q96);
            for (uint256 side; side < 2; side++) {
                bool sell = side == 0;
                MockERC20 input = MockERC20(sell ? r.token0() : r.token1());
                MockERC20 output = MockERC20(sell ? r.token1() : r.token0());
                input.mint(address(r), 100e18);
                uint256 beforeOut = output.balanceOf(address(this));
                uint256 expected = 100e18;
                for (uint256 i; i < n; i++) {
                    expected = expected * 9990 / 10_000;
                }
                assertEq(r.swap(sell, 100e18, expected), expected);
                assertEq(output.balanceOf(address(this)) - beforeOut, expected);
                for (uint256 i; i <= n; i++) {
                    assertEq(MockERC20(r.path(i)).balanceOf(address(r)), 0);
                    for (uint256 j; j < n; j++) {
                        assertEq(MockERC20(r.path(i)).balanceOf(address(r.markets(j))), 0);
                    }
                }
            }
        }
    }

    function test_route_referenceCompositionInversionAndAggregateDeviation() public {
        (UniswapV3Route r, RoutePoolMock[] memory pools) = _route(3);
        // All sorted pools have the same price: path traverses two forward and one reverse.
        uint256 expected = Q96;
        for (uint256 i; i < 3; i++) {
            pools[i].setOracle(100, 100, uint32(block.timestamp), 1e18);
            uint256 p = r.markets(i).referencePrice(block.timestamp);
            if (r.path(i) != pools[i].token0()) p = FullMath.mulDiv(Q96, Q96, p);
            expected = FullMath.mulDiv(expected, p, Q96);
        }
        assertEq(r.referencePrice(block.timestamp), expected);
        // Each leg is within 1%; their combined deviation exceeds 1%.
        pools[0].setOracle(0, 60, uint32(block.timestamp), 1e18);
        pools[1].setOracle(0, -60, uint32(block.timestamp), 1e18);
        pools[2].setOracle(0, 60, uint32(block.timestamp), 1e18);
        vm.expectRevert(UniswapV3Route.PriceDeviation.selector);
        r.referencePrice(block.timestamp);
    }

    /// Hops without the activity check price through a quiet middle pool, and still fail closed on liquidity.
    function test_route_quietHopPricesWithoutActivityCheck() public {
        (UniswapV3Route r, RoutePoolMock[] memory pools) = _route(3, 0);
        pools[1].setOracle(0, 0, uint32(block.timestamp - 1 days), 1e18);
        r.referencePrice(block.timestamp);
        pools[1].setOracle(0, 0, uint32(block.timestamp - 1 days), 1);
        vm.expectRevert(UniswapV3Market.ThinLiquidity.selector);
        r.referencePrice(block.timestamp);
    }

    function test_route_anyInvalidHopFailsClosed() public {
        (UniswapV3Route r, RoutePoolMock[] memory pools) = _route(3);
        pools[1].setOracle(0, 0, uint32(block.timestamp - 121), 1e18);
        vm.expectRevert(UniswapV3Market.StaleObservation.selector);
        r.referencePrice(block.timestamp);
        pools[1].setOracle(0, 0, uint32(block.timestamp), 1);
        vm.expectRevert(UniswapV3Market.ThinLiquidity.selector);
        r.referencePrice(block.timestamp);
        pools[1].setOracle(0, 0, uint32(block.timestamp), 1e18);
        pools[1].setMissingHistory();
        vm.expectRevert(bytes("OLD"));
        r.referencePrice(block.timestamp);
    }

    function test_route_finalFailureRollsBackEveryHopAndDustIsNotSpent() public {
        (UniswapV3Route r, RoutePoolMock[] memory pools) = _route(3);
        tokens[0].mint(address(r), 100e18);
        tokens[1].mint(address(r), 77);
        uint256 original = pools[0].token0() == address(tokens[0]) ? tokens[0].balanceOf(address(pools[0])) : 0;
        vm.expectRevert(UniswapV3Market.InsufficientOutput.selector);
        r.swap(true, 100e18, 100e18);
        assertEq(tokens[0].balanceOf(address(r)), 100e18);
        assertEq(tokens[0].balanceOf(address(pools[0])), original);
        assertEq(tokens[1].balanceOf(address(r)), 77);
        r.swap(true, 100e18, 99e18);
        assertEq(tokens[1].balanceOf(address(r)), 77);
        vm.prank(address(123));
        vm.expectRevert(UniswapV3Route.Unauthorized.selector);
        r.swap(true, 1, 1);
    }

    function test_route_rejectsCyclesDisconnectedPoolsAndWrongEndpoints() public {
        (UniswapV3Route r, RoutePoolMock[] memory pools) = _route(2);
        address[] memory path = new address[](3);
        path[0] = r.token0();
        path[1] = address(tokens[1]);
        path[2] = r.token1();
        UniswapV3Route.HopConfig[] memory hs = new UniswapV3Route.HopConfig[](2);
        hs[0] = UniswapV3Route.HopConfig(IV3Pool(address(pools[0])), 1e17, 120);
        hs[1] = UniswapV3Route.HopConfig(IV3Pool(address(pools[0])), 1e17, 120);
        vm.expectRevert(UniswapV3Route.Config.selector);
        new UniswapV3Route(address(this), IV3Factory(address(factory)), path, hs, 600, 30, 100);
        path[1] = path[0];
        vm.expectRevert(UniswapV3Route.Config.selector);
        new UniswapV3Route(address(this), IV3Factory(address(factory)), path, hs, 600, 30, 100);
        path[0] = address(tokens[3]);
        vm.expectRevert(UniswapV3Route.Config.selector);
        new UniswapV3Route(address(this), IV3Factory(address(factory)), path, hs, 600, 30, 100);
    }

    function test_route_rejectsInvalidHopCountAndUnauthenticatedPools() public {
        address[] memory path = new address[](1);
        path[0] = address(tokens[0]);
        UniswapV3Route.HopConfig[] memory hs = new UniswapV3Route.HopConfig[](0);
        vm.expectRevert(UniswapV3Route.Config.selector);
        new UniswapV3Route(address(this), IV3Factory(address(factory)), path, hs, 600, 30, 100);
        path = new address[](5);
        hs = new UniswapV3Route.HopConfig[](4);
        vm.expectRevert(UniswapV3Route.Config.selector);
        new UniswapV3Route(address(this), IV3Factory(address(factory)), path, hs, 600, 30, 100);
        (UniswapV3Route r, RoutePoolMock[] memory pools) = _route(1);
        path = new address[](2);
        path[0] = r.token0();
        path[1] = r.token1();
        hs = new UniswapV3Route.HopConfig[](1);
        hs[0] = UniswapV3Route.HopConfig(IV3Pool(address(pools[0])), 1e17, 120);
        factory.setPool(path[0], path[1], address(0));
        vm.expectRevert(UniswapV3Market.Config.selector);
        new UniswapV3Route(address(this), IV3Factory(address(factory)), path, hs, 600, 30, 100);
    }

    function test_route_rejectsNonTransferringTokensAndZeroOutput() public {
        (UniswapV3Route r, RoutePoolMock[] memory pools) = _route(2);
        tokens[0].mint(address(r), 100e18);
        vm.mockCall(
            address(tokens[0]),
            abi.encodeWithSignature("transfer(address,uint256)", address(r.markets(0)), 100e18),
            abi.encode(true)
        );
        vm.expectRevert(UniswapV3Route.InvalidTransfer.selector);
        r.swap(true, 100e18, 90e18);
        vm.clearMockedCalls();
        pools[1].setOutputBps(0);
        vm.expectRevert(UniswapV3Market.InvalidSwap.selector);
        r.swap(true, 100e18, 1);
        assertEq(tokens[0].balanceOf(address(r)), 100e18);
    }

    function testFuzz_route_conservesEveryHop(uint96 seed, bool sell) public {
        (UniswapV3Route r,) = _route(3);
        uint256 amount = bound(uint256(seed), 1e6, 1e24);
        MockERC20(sell ? r.token0() : r.token1()).mint(address(r), amount);
        uint256 expected = amount;
        for (uint256 i; i < 3; i++) {
            expected = expected * 9990 / 10_000;
        }
        assertEq(r.swap(sell, amount, expected), expected);
        for (uint256 i; i < 4; i++) {
            assertEq(tokens[i].balanceOf(address(r)), 0);
        }
    }
}
