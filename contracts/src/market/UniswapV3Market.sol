// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IExternalMarket, IV3Pool, IV3Factory} from "./IExternalMarket.sol";

/// @notice One authenticated v3 pool provides batch-timed reference prices and exact-input execution.
/// @dev Mean-tick rounding and harmonic liquidity math follow Uniswap v3 OracleLibrary (GPL-2.0-or-later):
/// https://github.com/Uniswap/v3-periphery/blob/main/contracts/libraries/OracleLibrary.sol
contract UniswapV3Market is IExternalMarket {
    uint256 private constant Q96 = 1 << 96;
    uint256 private constant BPS = 10_000;

    error Config();
    error NotReady();
    error StaleReference();
    error StaleObservation();
    error InsufficientHistory();
    error ThinLiquidity();
    error PriceDeviation();
    error Unauthorized();
    error InvalidSwap();
    error InsufficientOutput();
    error TokenTransferFailed();

    address public immutable settlement;
    IV3Pool public immutable pool;
    address public immutable token0;
    address public immutable token1;
    uint32 public immutable window;
    uint32 public immutable maxDelay;
    uint32 public immutable maxObservationAge;
    uint128 public immutable minHarmonicLiquidity;
    uint256 public immutable maxDeviationBps;

    // Callback budget is live only during a settlement-authorized swap.
    uint256 private remainingInput;
    address private inputToken;

    constructor(
        address settlement_,
        IV3Factory factory_,
        IV3Pool pool_,
        uint32 window_,
        uint32 maxDelay_,
        uint32 maxObservationAge_,
        uint128 minHarmonicLiquidity_,
        uint256 maxDeviationBps_
    ) {
        if (
            settlement_ == address(0) || window_ == 0 || window_ > uint32(type(int32).max) || maxDelay_ == 0
                || uint256(window_) + maxDelay_ > type(uint32).max || maxObservationAge_ == 0
                || minHarmonicLiquidity_ == 0 || maxDeviationBps_ == 0 || maxDeviationBps_ > 1000
        ) revert Config();
        address a = pool_.token0();
        address b = pool_.token1();
        if (
            a == address(0) || a >= b || pool_.factory() != address(factory_)
                || factory_.getPool(a, b, pool_.fee()) != address(pool_)
        ) revert Config();
        settlement = settlement_;
        pool = pool_;
        token0 = a;
        token1 = b;
        window = window_;
        maxDelay = maxDelay_;
        maxObservationAge = maxObservationAge_;
        minHarmonicLiquidity = minHarmonicLiquidity_;
        maxDeviationBps = maxDeviationBps_;
    }

    /// @notice Raw token1/token0 Q96 reference over [end-window,end], independent of solver call time.
    function referencePrice(uint256 end) external view returns (uint256 price) {
        if (end > block.timestamp || end < window) revert NotReady();
        uint256 age = block.timestamp - end;
        if (age > maxDelay) revert StaleReference();
        uint160 spotSqrt = _activeSpot();
        price = _historicalPrice(uint32(age));
        uint256 spot = FullMath.mulDiv(spotSqrt, spotSqrt, Q96);
        uint256 diff = spot > price ? spot - price : price - spot;
        if (diff > FullMath.mulDiv(price, maxDeviationBps, BPS)) revert PriceDeviation();
    }

    function _activeSpot() internal view returns (uint160 spotSqrt) {
        uint16 index;
        uint16 cardinality;
        (spotSqrt,, index, cardinality,,,) = pool.slot0();
        if (cardinality < 2) revert InsufficientHistory();
        (uint32 observedAt,,, bool initialized) = pool.observations(index);
        uint32 observationAge;
        unchecked {
            observationAge = uint32(block.timestamp) - observedAt;
        }
        if (!initialized || observationAge > maxObservationAge) revert StaleObservation();
    }

    function _historicalPrice(uint32 age) internal view returns (uint256 price) {
        uint32[] memory lookbacks = new uint32[](2);
        lookbacks[0] = uint32(age) + window;
        lookbacks[1] = uint32(age);
        (int56[] memory ticks, uint160[] memory liquidity) = pool.observe(lookbacks);
        if (ticks.length != 2 || liquidity.length != 2) revert InsufficientHistory();
        int56 tickDelta;
        uint160 liquidityDelta;
        unchecked {
            tickDelta = ticks[1] - ticks[0];
            liquidityDelta = liquidity[1] - liquidity[0];
        }
        if (liquidityDelta == 0) revert ThinLiquidity();
        uint256 meanLiquidity = (uint192(window) * type(uint160).max) / (uint192(liquidityDelta) << 32);
        if (meanLiquidity < minHarmonicLiquidity) revert ThinLiquidity();
        int56 seconds_ = int56(uint56(window));
        int56 mean = tickDelta / seconds_;
        if (tickDelta < 0 && tickDelta % seconds_ != 0) mean--;
        if (mean < TickMath.MIN_TICK || mean > TickMath.MAX_TICK) revert PriceDeviation();
        uint160 sqrt = TickMath.getSqrtPriceAtTick(int24(mean));
        price = FullMath.mulDiv(sqrt, sqrt, Q96);
        if (price == 0) revert PriceDeviation();
    }

    /// @notice Settlement prefunds exact input; pool sends output directly back to settlement.
    function swap(bool zeroForOne, uint256 amountIn, uint256 minimumOut) external returns (uint256 out) {
        if (msg.sender != settlement) revert Unauthorized();
        if (inputToken != address(0) || amountIn == 0 || amountIn > uint256(type(int256).max) || minimumOut == 0) {
            revert InvalidSwap();
        }
        inputToken = zeroForOne ? token0 : token1;
        remainingInput = amountIn;
        (int256 a0, int256 a1) = pool.swap(
            settlement,
            zeroForOne,
            int256(amountIn),
            zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
            ""
        );
        int256 used = zeroForOne ? a0 : a1;
        int256 received = zeroForOne ? a1 : a0;
        if (used != int256(amountIn) || received >= 0 || received == type(int256).min || remainingInput != 0) {
            revert InvalidSwap();
        }
        out = uint256(-received);
        if (out < minimumOut) revert InsufficientOutput();
        inputToken = address(0);
    }

    /// @notice Pays only the authenticated pool, within the live exact-input callback budget.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != address(pool) || inputToken == address(0)) revert Unauthorized();
        int256 owed = inputToken == token0 ? amount0Delta : amount1Delta;
        int256 other = inputToken == token0 ? amount1Delta : amount0Delta;
        if (owed <= 0 || other > 0 || uint256(owed) > remainingInput) revert InvalidSwap();
        remainingInput -= uint256(owed);
        (bool ok, bytes memory data) =
            inputToken.call(abi.encodeWithSignature("transfer(address,uint256)", msg.sender, uint256(owed)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }
}
