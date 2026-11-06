// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {UniswapV3Market} from "../src/market/UniswapV3Market.sol";
import {IV3Pool, IV3Factory} from "../src/market/IExternalMarket.sol";

contract MockV3Pool {
    address public token0;
    address public token1;
    address public factory = address(this);
    uint24 public fee = 500;
    uint160 public sqrtPrice = 1 << 96;
    uint16 public cardinality = 2;
    uint32 public observedAt;
    uint32 public expectedEnd;
    int56 public delta;
    uint160 public liqDelta = uint160((uint256(600) << 128) / 1e18);
    uint256 public output = 99;
    bool public overcharge;
    bool public partialSwap;
    bool public wrongFactory;

    constructor(address a, address b) {
        token0 = a;
        token1 = b;
        observedAt = uint32(block.timestamp);
        expectedEnd = observedAt;
    }

    function getPool(address, address, uint24) external view returns (address) {
        return wrongFactory ? address(0) : address(this);
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPrice, 0, 0, cardinality, cardinality, 0, true);
    }

    function observations(uint256) external view returns (uint32, int56, uint160, bool) {
        return (observedAt, 0, 0, true);
    }

    function setOracle(uint160 sqrt, uint16 count, uint32 time, int56 tickDelta, uint160 liquidityDelta) external {
        sqrtPrice = sqrt;
        cardinality = count;
        observedAt = time;
        delta = tickDelta;
        liqDelta = liquidityDelta;
    }

    function setSwap(uint256 out, bool excess, bool part) external {
        output = out;
        overcharge = excess;
        partialSwap = part;
    }

    function setWrongFactory() external {
        wrongFactory = true;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory ticks, uint160[] memory liquidity)
    {
        require(secondsAgos[0] - secondsAgos[1] == 600, "wrong window");
        require(secondsAgos[1] == uint32(block.timestamp) - expectedEnd, "rolling endpoint");
        // A linear accumulator lets the same fixed window be observed at later execution times.
        ticks = new int56[](2);
        liquidity = new uint160[](2);
        ticks[0] = int56(uint56(uint32(block.timestamp) - secondsAgos[0])) * delta;
        ticks[1] = ticks[0] + delta;
        liquidity[1] = liqDelta;
    }

    function swap(address recipient, bool sell, int256 amount, uint160, bytes calldata)
        external
        returns (int256 a, int256 b)
    {
        uint256 used = uint256(amount) - (partialSwap ? 1 : 0);
        MockERC20(sell ? token1 : token0).transfer(recipient, output);
        (a, b) = sell ? (int256(used), -int256(output)) : (-int256(output), int256(used));
        UniswapV3Market(msg.sender)
            .uniswapV3SwapCallback(sell && overcharge ? a + 1 : a, !sell && overcharge ? b + 1 : b, "");
    }
}

contract UniswapV3MarketTest is Test {
    MockERC20 a;
    MockERC20 b;
    MockV3Pool pool;
    UniswapV3Market market;
    uint256 constant Q96 = 1 << 96;

    function setUp() public {
        vm.warp(1_800_000_000);
        MockERC20 x = new MockERC20("A", "A", 18);
        MockERC20 y = new MockERC20("B", "B", 18);
        (a, b) = address(x) < address(y) ? (x, y) : (y, x);
        pool = new MockV3Pool(address(a), address(b));
        market = _deploy(1e17);
        a.mint(address(pool), 1000);
        b.mint(address(pool), 1000);
    }

    function _deploy(uint128 minimum) internal returns (UniswapV3Market) {
        return new UniswapV3Market(
            address(this), IV3Factory(address(pool)), IV3Pool(address(pool)), 600, 30, 60, minimum, 100
        );
    }

    function test_referenceFixedEndpointAndNegativeRounding() public {
        uint256 end = block.timestamp;
        assertEq(market.referencePrice(end), Q96);
        vm.warp(end + 10);
        assertEq(market.referencePrice(end), Q96);
        pool.setOracle(uint160(Q96), 2, uint32(end), -1, uint160((uint256(600) << 128) / 1e18));
        uint160 sqrt = TickMath.getSqrtPriceAtTick(-1);
        assertEq(market.referencePrice(end), FullMath.mulDiv(sqrt, sqrt, Q96));
    }

    function test_referenceRejectsFutureOldInactiveThinAndDiverged() public {
        uint256 end = block.timestamp;
        vm.expectRevert(UniswapV3Market.NotReady.selector);
        market.referencePrice(end + 1);
        vm.expectRevert(UniswapV3Market.StaleReference.selector);
        market.referencePrice(end - 31);
        pool.setOracle(uint160(Q96), 1, uint32(end), 0, 1);
        vm.expectRevert(UniswapV3Market.InsufficientHistory.selector);
        market.referencePrice(end);
        pool.setOracle(uint160(Q96), 2, uint32(end - 61), 0, 1);
        vm.expectRevert(UniswapV3Market.StaleObservation.selector);
        market.referencePrice(end);
        pool.setOracle(uint160(Q96), 2, uint32(end), 0, type(uint160).max);
        vm.expectRevert(UniswapV3Market.ThinLiquidity.selector);
        market.referencePrice(end);
        pool.setOracle(uint160(2 * Q96), 2, uint32(end), 0, uint160((uint256(600) << 128) / 1e18));
        vm.expectRevert(UniswapV3Market.PriceDeviation.selector);
        market.referencePrice(end);
    }

    function _deployQuiet() internal returns (UniswapV3Market) {
        // maxObservationAge 0: no activity check
        return
            new UniswapV3Market(address(this), IV3Factory(address(pool)), IV3Pool(address(pool)), 600, 30, 0, 1e17, 100);
    }

    /// A pool nobody traded for a day still prices: its mean and spot are both the last price.
    function test_activityCheckOff_quietPoolPrices() public {
        UniswapV3Market quiet = _deployQuiet();
        assertEq(quiet.maxObservationAge(), 0);
        pool.setOracle(uint160(Q96), 2, uint32(block.timestamp - 1 days), 0, uint160((uint256(600) << 128) / 1e18));
        assertEq(quiet.referencePrice(block.timestamp), Q96);
        // the same pool under a 60 s activity policy is rejected
        vm.expectRevert(UniswapV3Market.StaleObservation.selector);
        market.referencePrice(block.timestamp);
    }

    /// Without the activity check every other safeguard still applies, including against a fresh manipulating swap.
    function test_activityCheckOff_keepsDeviationLiquidityAndHistoryChecks() public {
        UniswapV3Market quiet = _deployQuiet();
        uint160 healthy = uint160((uint256(600) << 128) / 1e18);
        uint32 dayAgo = uint32(block.timestamp - 1 days);
        // a swap right before settlement moves spot 4x off the mean (and refreshes the observation)
        pool.setOracle(uint160(2 * Q96), 2, uint32(block.timestamp), 0, healthy);
        vm.expectRevert(UniswapV3Market.PriceDeviation.selector);
        quiet.referencePrice(block.timestamp);
        // spot inside the 1% band still prices; outside does not
        pool.setOracle(uint160(Q96 + Q96 / 250), 2, dayAgo, 0, healthy); // ~+0.8%
        quiet.referencePrice(block.timestamp);
        pool.setOracle(uint160(Q96 + Q96 / 150), 2, dayAgo, 0, healthy); // ~+1.3%
        vm.expectRevert(UniswapV3Market.PriceDeviation.selector);
        quiet.referencePrice(block.timestamp);
        pool.setOracle(uint160(Q96), 2, dayAgo, 0, type(uint160).max);
        vm.expectRevert(UniswapV3Market.ThinLiquidity.selector);
        quiet.referencePrice(block.timestamp);
        pool.setOracle(uint160(Q96), 1, dayAgo, 0, healthy);
        vm.expectRevert(UniswapV3Market.InsufficientHistory.selector);
        quiet.referencePrice(block.timestamp);
        pool.setOracle(uint160(Q96), 2, dayAgo, 0, healthy);
        vm.expectRevert(UniswapV3Market.StaleReference.selector);
        quiet.referencePrice(block.timestamp - 31);
    }

    function test_factoryAuthentication() public {
        pool.setWrongFactory();
        vm.expectRevert(UniswapV3Market.Config.selector);
        _deploy(1);
    }

    function test_swapBothDirectionsAndCallbackAuthorization() public {
        vm.expectRevert(UniswapV3Market.Unauthorized.selector);
        market.uniswapV3SwapCallback(1, -1, "");
        vm.prank(address(pool));
        vm.expectRevert(UniswapV3Market.Unauthorized.selector);
        market.uniswapV3SwapCallback(1, -1, "");
        vm.prank(address(1));
        vm.expectRevert(UniswapV3Market.Unauthorized.selector);
        market.swap(true, 100, 99);
        a.mint(address(market), 100);
        b.mint(address(market), 100);
        assertEq(market.swap(true, 100, 99), 99);
        assertEq(market.swap(false, 100, 99), 99);
        assertEq(a.balanceOf(address(market)) + b.balanceOf(address(market)), 0);
        assertEq(a.balanceOf(address(this)), 99);
        assertEq(b.balanceOf(address(this)), 99);
    }

    function test_shortPartialAndOverchargedSwapRollBack() public {
        a.mint(address(market), 100);
        vm.expectRevert(UniswapV3Market.InsufficientOutput.selector);
        market.swap(true, 100, 100);
        pool.setSwap(99, true, false);
        vm.expectRevert(UniswapV3Market.InvalidSwap.selector);
        market.swap(true, 100, 99);
        pool.setSwap(99, false, true);
        vm.expectRevert(UniswapV3Market.InvalidSwap.selector);
        market.swap(true, 100, 99);
        assertEq(a.balanceOf(address(market)), 100);
        assertEq(b.balanceOf(address(this)), 0);
        pool.setSwap(99, false, false);
        assertEq(market.swap(true, 100, 99), 99);
    }
}
