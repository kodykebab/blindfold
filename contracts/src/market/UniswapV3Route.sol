// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {IExternalMarket, IV3Pool, IV3Factory, IERC20Balance} from "./IExternalMarket.sol";
import {UniswapV3Market} from "./UniswapV3Market.sol";

/// @notice A fixed, authenticated path for one pair's atomic residual execution.
/// @dev Each hop reuses the single-pool callback and historical oracle checks.
contract UniswapV3Route is IExternalMarket {
    uint256 private constant Q96 = 1 << 96;
    error Config();
    error Unauthorized();
    error PriceDeviation();
    error InvalidTransfer();
    error InvalidOutput();

    struct HopConfig {
        IV3Pool pool;
        uint128 minimumLiquidity;
        uint32 maximumObservationAge;
    }

    address public immutable settlement;
    address public immutable token0;
    address public immutable token1;
    uint256 public immutable maxDeviationBps;
    address[] public path;
    UniswapV3Market[] public markets;

    constructor(
        address settlement_,
        IV3Factory factory,
        address[] memory path_,
        HopConfig[] memory hops,
        uint32 window,
        uint32 maximumDelay,
        uint256 deviationBps
    ) {
        if (
            settlement_ == address(0) || hops.length == 0 || hops.length > 3 || path_.length != hops.length + 1
                || path_[0] == address(0) || path_[0] >= path_[path_.length - 1]
        ) revert Config();
        settlement = settlement_;
        token0 = path_[0];
        token1 = path_[path_.length - 1];
        maxDeviationBps = deviationBps;
        for (uint256 i; i < path_.length; i++) {
            if (path_[i] == address(0)) revert Config();
            for (uint256 j; j < i; j++) {
                if (path_[j] == path_[i]) revert Config();
            }
            path.push(path_[i]);
        }
        for (uint256 i; i < hops.length; i++) {
            UniswapV3Market m = new UniswapV3Market(
                address(this),
                factory,
                hops[i].pool,
                window,
                maximumDelay,
                hops[i].maximumObservationAge,
                hops[i].minimumLiquidity,
                deviationBps
            );
            address a = m.token0();
            address b = m.token1();
            if (!((a == path_[i] && b == path_[i + 1]) || (b == path_[i] && a == path_[i + 1]))) revert Config();
            markets.push(m);
        }
    }

    /// @notice Number of authenticated pools; endpoints need no direct pool.
    function hopCount() external view returns (uint256) {
        return markets.length;
    }

    /// @notice Composite raw endpoint price, with one shared historical end time for every hop.
    function referencePrice(uint256 end) external view returns (uint256 price) {
        price = Q96;
        uint256 spot = Q96;
        for (uint256 i; i < markets.length; i++) {
            UniswapV3Market m = markets[i];
            uint256 p = m.referencePrice(end);
            (uint160 sqrt,,,,,,) = m.pool().slot0();
            uint256 current = FullMath.mulDiv(sqrt, sqrt, Q96);
            if (p == 0 || current == 0) revert PriceDeviation();
            if (path[i] != m.token0()) {
                p = FullMath.mulDiv(Q96, Q96, p);
                current = FullMath.mulDiv(Q96, Q96, current);
            }
            price = FullMath.mulDiv(price, p, Q96);
            spot = FullMath.mulDiv(spot, current, Q96);
            if (price == 0 || spot == 0) revert PriceDeviation();
        }
        uint256 diff = spot > price ? spot - price : price - spot;
        if (diff > FullMath.mulDiv(price, maxDeviationBps, 10_000)) revert PriceDeviation();
    }

    /// @notice Execute every hop or revert all transfers; only the endpoint output reaches settlement.
    function swap(bool zeroForOne, uint256 amountIn, uint256 minimumOut) external returns (uint256 out) {
        if (msg.sender != settlement) revert Unauthorized();
        if (amountIn == 0 || minimumOut == 0) revert InvalidOutput();
        out = amountIn;
        for (uint256 step; step < markets.length; step++) {
            uint256 i = zeroForOne ? step : markets.length - 1 - step;
            address input = path[zeroForOne ? i : i + 1];
            address output = path[zeroForOne ? i + 1 : i];
            UniswapV3Market m = markets[i];
            uint256 beforeOutput = IERC20Balance(output).balanceOf(address(this));
            _sendExact(input, address(m), out);
            out = m.swap(input == m.token0(), out, step + 1 == markets.length ? minimumOut : 1);
            if (out == 0 || IERC20Balance(output).balanceOf(address(this)) - beforeOutput != out) {
                revert InvalidOutput();
            }
        }
        if (out < minimumOut) revert InvalidOutput();
        _sendExact(zeroForOne ? token1 : token0, settlement, out);
    }

    function _sendExact(address token, address recipient, uint256 amount) internal {
        uint256 beforeFrom = IERC20Balance(token).balanceOf(address(this));
        uint256 beforeTo = IERC20Balance(token).balanceOf(recipient);
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSignature("transfer(address,uint256)", recipient, amount));
        if (
            !ok || (data.length != 0 && !abi.decode(data, (bool)))
                || beforeFrom - IERC20Balance(token).balanceOf(address(this)) != amount
                || IERC20Balance(token).balanceOf(recipient) - beforeTo != amount
        ) revert InvalidTransfer();
    }
}
