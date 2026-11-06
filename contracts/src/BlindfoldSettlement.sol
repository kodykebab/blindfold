// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

import {IExternalMarket, IERC20Balance} from "./market/IExternalMarket.sol";

import {BatchAuction} from "./BatchAuction.sol";
import {BlindfoldVault, IERC20Like} from "./BlindfoldVault.sol";

/// @title BlindfoldSettlement
/// @notice Anyone proposes the uniform clearing price p* of a batch; the contract verifies it:
///         1. fills follow from p*, or price priority with a common fraction at one marginal limit;
///         2. the net imbalance is ONE exact-input residual swap on the sealed v4 pool, whose output
///            must cover what the batch owes;
///         3. the pool's marginal price after that swap must equal p* within `toleranceBps` (FM-AMM).
///            Only this contract can swap the sealed pool, so nobody can move that price beforehand.
///         Residual output above what is owed is donated to in-range LPs.
///         Prices: priceX96 = token1 per token0 (raw units) * 2^96 = sqrtPriceX96^2 / 2^96.
contract BlindfoldSettlement is BatchAuction, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant Q96 = 1 << 96;
    bytes32 internal constant ACTIVE_PRICE_SLOT = keccak256("blindfold.activePriceX96");

    error Unauthorized();
    error AlreadyInitialized();
    error OutsideSettleWindow(uint256 nowTs, uint256 opens, uint256 closes);
    error Finalized(uint64 batchId);
    error NotExpired(uint256 at);
    error ZeroPrice();
    error NotMarginalPrice(uint256 proposedX96, uint256 poolX96);
    error PartialResidual(uint256 wanted, uint256 used);
    error ResidualShort(uint256 out, uint256 owed);
    error Imbalanced();
    error InvalidMarginalOrder();
    error PartialLimit(uint256 id);
    error ActiveLiquidity();
    error MissingLiquidity();
    error ExternalConfig();
    error ExternalPrice();
    error PeerUnbalanced(uint256 in0, uint256 out0, uint256 in1, uint256 out1);

    event Filled(
        uint64 indexed batchId, uint256 indexed id, address indexed owner, uint256 amountIn, uint256 amountOut
    );
    event Unfilled(uint64 indexed batchId, uint256 indexed id, address indexed owner);
    event Settled(
        uint64 indexed batchId,
        uint256 priceX96,
        uint256 fills,
        bool residualZeroForOne,
        uint256 residualIn,
        uint256 residualOut,
        uint256 donated,
        address solver
    );
    event PeerSettled(uint64 indexed batchId, uint256 priceX96, uint256 rounding0, uint256 rounding1);
    event ExternalConfigured(address indexed market);
    event ExternalSettled(uint64 indexed batchId, uint256 surplus0, uint256 surplus1);
    event Expired(uint64 indexed batchId, uint256 orders);

    struct Config {
        IPoolManager manager;
        BlindfoldVault vault;
        address depositToken;
        uint256 depositAmount;
        uint256 bountyBps;
        address treasury;
        uint256 commitFee; // REVIEW R3/S3: non-refundable, per commitment
        Schedule schedule;
        uint256 toleranceBps;
    }

    struct Totals {
        uint256 in0; // token0 paid by filled sells
        uint256 in1; // token1 paid by filled buys
        uint256 out0; // token0 owed to filled buys
        uint256 out1; // token1 owed to filled sells
        uint256 fills;
    }

    struct Fill {
        uint256 amountIn;
        uint256 amountOut;
    }

    struct PartialGroup {
        Order referenceOrder;
        uint128 numerator;
    }

    struct Residual {
        bool zeroForOne;
        uint256 amountIn;
        uint256 amountOut;
        uint256 donated;
    }

    IPoolManager public immutable manager;
    uint256 public immutable toleranceBps;
    address public immutable admin;

    enum Route {
        Sealed,
        Peer,
        External
    }

    IExternalMarket public externalMarket;
    PoolKey internal key;
    address public token0;
    address public token1;
    mapping(uint64 => bool) public finalized;
    mapping(uint64 => uint256) public clearingPriceX96;

    constructor(Config memory c)
        BatchAuction(c.vault, c.depositToken, c.depositAmount, c.bountyBps, c.treasury, c.commitFee, c.schedule)
    {
        manager = c.manager;
        toleranceBps = c.toleranceBps;
        admin = msg.sender;
    }

    /// @notice One-shot: the hook address is mined against this contract's address, so the key comes later.
    function initialize(PoolKey calldata k) public virtual {
        if (msg.sender != admin) revert Unauthorized();
        if (token0 != address(0)) revert AlreadyInitialized();
        key = k;
        token0 = Currency.unwrap(k.currency0);
        token1 = Currency.unwrap(k.currency1);
        IERC20Like(token0).approve(address(vault), type(uint256).max);
        IERC20Like(token1).approve(address(vault), type(uint256).max);
    }

    /// @notice Fix the oracle and public route before accepting any commitments.
    function configureExternal(IExternalMarket market) external {
        if (msg.sender != admin) revert Unauthorized();
        if (
            address(externalMarket) != address(0) || commitCount != 0 || token0 == address(0)
                || market.settlement() != address(this) || market.token0() != token0 || market.token1() != token1
                || market.maxDeviationBps() == 0 || market.maxDeviationBps() > 1000
        ) revert ExternalConfig();
        externalMarket = market;
        emit ExternalConfigured(address(market));
    }

    /// @notice Solver search bound for the immutable external market configuration.
    function externalPriceDeviationBps() external view returns (uint256) {
        if (address(externalMarket) == address(0)) revert ExternalConfig();
        return externalMarket.maxDeviationBps();
    }

    /// @notice Historical reference ending at this batch's reveal deadline; no stored-price fallback.
    function referencePriceX96(uint64 batchId) public view returns (uint256) {
        if (address(externalMarket) == address(0)) revert ExternalConfig();
        uint256 price = externalMarket.referencePrice(revealCloses(batchId));
        if (price == 0) revert ExternalPrice();
        return price;
    }

    /// @notice Match at a reference-bounded price and route the residual through the configured public pool.
    function settleExternal(uint64 batchId, uint256 priceX96) external {
        PartialGroup memory group;
        _settleExternal(batchId, priceX96, group);
    }

    /// @notice Use the same price-priority and equal-limit allocation with a partial boundary group.
    function settleExternal(uint64 batchId, uint256 priceX96, uint256 marginalId, uint128 marginalAmountIn) external {
        Order memory ref = orders[marginalId];
        if (
            commitments[marginalId].batchId != batchId || ref.amountIn == 0 || marginalAmountIn == 0
                || marginalAmountIn > ref.amountIn
        ) revert InvalidMarginalOrder();
        _settleExternal(batchId, priceX96, PartialGroup(ref, marginalAmountIn));
    }

    function _settleExternal(uint64 batchId, uint256 priceX96, PartialGroup memory group) internal {
        uint256 ref = referencePriceX96(batchId);
        uint256 diff = priceX96 > ref ? priceX96 - ref : ref - priceX96;
        if (diff > FullMath.mulDiv(ref, externalMarket.maxDeviationBps(), BPS)) revert ExternalPrice();
        _settle(batchId, priceX96, group, Route.External);
    }

    function poolKey() external view returns (PoolKey memory) {
        return key;
    }

    function poolPriceX96() public view returns (uint256) {
        (uint160 sqrtP,,,) = manager.getSlot0(key.toId());
        return FullMath.mulDiv(sqrtP, sqrtP, Q96);
    }

    /// @notice Active pool liquidity, used to identify when peer-only settlement is available.
    function poolLiquidity() external view returns (uint128) {
        return manager.getLiquidity(key.toId());
    }

    /// @notice tokenOut per tokenIn (Q96) while a batch is being settled, else 0. Read by SealedClearing.
    function activeClearingPriceX96(address tokenIn, address tokenOut) external view returns (uint256) {
        uint256 p = _activePrice();
        if (p == 0) return 0;
        if (tokenIn == token0 && tokenOut == token1) return p;
        if (tokenIn == token1 && tokenOut == token0) return FullMath.mulDiv(Q96, Q96, p);
        return 0;
    }

    /// @notice Output of an order at price p (rounded down), and whether its limit holds.
    function quote(Order memory o, uint256 priceX96) public pure returns (uint256 out, bool fills) {
        out = o.zeroForOne ? FullMath.mulDiv(o.amountIn, priceX96, Q96) : FullMath.mulDiv(o.amountIn, Q96, priceX96);
        fills = out != 0 && out >= o.minAmountOut;
    }

    // ---- settle

    function settle(uint64 batchId, uint256 priceX96) external {
        PartialGroup memory group;
        _settle(batchId, priceX96, group, Route.Sealed);
    }

    /// @notice Share a partial fill across every same-side order with the representative's limit.
    /// @dev marginalAmountIn / representative.amountIn is the common input fraction.
    ///      Eligible better same-side limits fill fully; worse limits do not fill. Opposing orders use quote().
    function settle(uint64 batchId, uint256 priceX96, uint256 marginalId, uint128 marginalAmountIn) external {
        Order memory referenceOrder = orders[marginalId];
        if (
            commitments[marginalId].batchId != batchId || referenceOrder.amountIn == 0
                || referenceOrder.minAmountOut == 0 || marginalAmountIn == 0
                || marginalAmountIn >= referenceOrder.amountIn
        ) revert InvalidMarginalOrder();
        // Bound the price itself; comparing rounded outputs would allow a wide
        // band for orders whose minimum is only one raw token unit.
        uint256 limitPrice = referenceOrder.zeroForOne
            ? FullMath.mulDivRoundingUp(referenceOrder.minAmountOut, Q96, referenceOrder.amountIn)
            : FullMath.mulDiv(referenceOrder.amountIn, Q96, referenceOrder.minAmountOut);
        if (priceX96 == 0) revert ZeroPrice();
        if (referenceOrder.zeroForOne) {
            if (priceX96 < limitPrice || priceX96 - limitPrice > FullMath.mulDiv(limitPrice, toleranceBps, BPS)) {
                revert InvalidMarginalOrder();
            }
        } else if (priceX96 > limitPrice || limitPrice - priceX96 > FullMath.mulDiv(priceX96, toleranceBps, BPS)) {
            revert InvalidMarginalOrder();
        }
        _settle(batchId, priceX96, PartialGroup(referenceOrder, marginalAmountIn), Route.Sealed);
    }

    /// @notice Match opposing orders without an AMM swap when there is no active pool liquidity.
    /// @dev Price is the configured external reference, not a solver-selected price. The representative
    ///      defines the same price-priority/proportional group as settle(), but may fill fully
    ///      or have a zero minimum. Both token budgets must cover all payouts independently.
    function settlePeer(uint64 batchId, uint256 marginalId, uint128 marginalAmountIn) external {
        if (manager.getLiquidity(key.toId()) != 0) revert ActiveLiquidity();
        Order memory ref = orders[marginalId];
        if (
            commitments[marginalId].batchId != batchId || ref.amountIn == 0 || marginalAmountIn == 0
                || marginalAmountIn > ref.amountIn
        ) revert InvalidMarginalOrder();
        _settle(batchId, referencePriceX96(batchId), PartialGroup(ref, marginalAmountIn), Route.Peer);
    }

    function _settle(uint64 batchId, uint256 priceX96, PartialGroup memory group, Route route) internal {
        uint256 opens = revealCloses(batchId);
        uint256 closes = opens + settleLength;
        if (block.timestamp < opens || block.timestamp >= closes) {
            revert OutsideSettleWindow(block.timestamp, opens, closes);
        }
        if (finalized[batchId]) revert Finalized(batchId);
        if (priceX96 == 0) revert ZeroPrice();
        if (route == Route.Sealed && manager.getLiquidity(key.toId()) == 0) revert MissingLiquidity();
        finalized[batchId] = true;
        clearingPriceX96[batchId] = priceX96;
        _setActivePrice(priceX96);

        uint256[] storage ids = batchOrderIds[batchId];
        (Totals memory t, Fill[] memory fills) = _collect(ids, priceX96, group);
        Residual memory r;
        if (route == Route.Peer) {
            if (t.out0 == 0 || t.out1 == 0 || t.in0 < t.out0 || t.in1 < t.out1) {
                revert PeerUnbalanced(t.in0, t.out0, t.in1, t.out1);
            }
            // Uniform-price floor quotes can leave indivisible token units. Return
            // all of them to output recipients; no value is left in settlement.
            _returnRounding(ids, fills, t.in0 - t.out0, t.out0, true);
            _returnRounding(ids, fills, t.in1 - t.out1, t.out1, false);
            emit PeerSettled(batchId, priceX96, t.in0 - t.out0, t.in1 - t.out1);
        } else if (route == Route.External) {
            r = _routeExternal(t);
            _returnRounding(ids, fills, t.in0 - t.out0, t.out0, true);
            _returnRounding(ids, fills, t.in1 - t.out1, t.out1, false);
            emit ExternalSettled(batchId, t.in0 - t.out0, t.in1 - t.out1);
        } else {
            r = _route(t);
            _checkMarginal(priceX96);
        }
        _pay(batchId, ids, fills);

        _setActivePrice(0);
        emit Settled(batchId, priceX96, t.fills, r.zeroForOne, r.amountIn, r.amountOut, r.donated, msg.sender);
    }

    /// @notice If nobody settles in time, every order unlocks untouched.
    function expire(uint64 batchId) external {
        uint256 at = settleCloses(batchId);
        if (block.timestamp < at) revert NotExpired(at);
        if (finalized[batchId]) revert Finalized(batchId);
        finalized[batchId] = true;
        uint256[] storage ids = batchOrderIds[batchId];
        for (uint256 i; i < ids.length; i++) {
            Order memory o = orders[ids[i]];
            vault.unlock(o.owner, _inputToken(o.zeroForOne), o.amountIn);
            vault.closeCommitment(o.owner);
        }
        emit Expired(batchId, ids.length);
    }

    function _fill(Order memory o, uint256 id, uint256 priceX96, PartialGroup memory group)
        internal
        pure
        returns (Fill memory f)
    {
        if (group.numerator != 0 && o.zeroForOne == group.referenceOrder.zeroForOne) {
            Order memory ref = group.referenceOrder;
            // Both products fit uint256: each factor is uint128.
            uint256 limit = uint256(o.minAmountOut) * ref.amountIn;
            uint256 boundary = uint256(ref.minAmountOut) * o.amountIn;
            if (limit > boundary) return f;
            if (limit == boundary) {
                f.amountIn = uint256(o.amountIn) * group.numerator / ref.amountIn;
                if (f.amountIn == 0) return f;
                f.amountOut = o.zeroForOne
                    ? FullMath.mulDiv(f.amountIn, priceX96, Q96)
                    : FullMath.mulDiv(f.amountIn, Q96, priceX96);
                uint256 minimum = FullMath.mulDivRoundingUp(o.minAmountOut, f.amountIn, o.amountIn);
                if (f.amountOut < minimum) {
                    // Preserve ordinary partial fills. Only an allocation that
                    // violates its minimum falls back to a whole reduced lot.
                    uint256 lot = _inputLot(o.amountIn, o.minAmountOut);
                    f.amountIn = f.amountIn / lot * lot;
                    if (f.amountIn == 0) return Fill(0, 0);
                    f.amountOut = o.zeroForOne
                        ? FullMath.mulDiv(f.amountIn, priceX96, Q96)
                        : FullMath.mulDiv(f.amountIn, Q96, priceX96);
                    minimum = FullMath.mulDivRoundingUp(o.minAmountOut, f.amountIn, o.amountIn);
                }
                if (f.amountOut == 0 && o.minAmountOut == 0) return Fill(0, 0);
                if (f.amountOut == 0 || f.amountOut < minimum) revert PartialLimit(id);
                return f;
            }
        }
        (uint256 out, bool fills) = quote(o, priceX96);
        if (fills) f = Fill(o.amountIn, out);
    }

    function _inputLot(uint128 amount, uint128 minimum) internal pure returns (uint256) {
        uint256 a = amount;
        uint256 b = minimum;
        while (b != 0) (a, b) = (b, a % b);
        return uint256(amount) / a;
    }

    function _collect(uint256[] storage ids, uint256 priceX96, PartialGroup memory group)
        internal
        returns (Totals memory t, Fill[] memory fills)
    {
        fills = new Fill[](ids.length);
        for (uint256 i; i < ids.length; i++) {
            Order memory o = orders[ids[i]];
            Fill memory f = _fill(o, ids[i], priceX96, group);
            fills[i] = f;
            address tokenIn = _inputToken(o.zeroForOne);
            vault.unlock(o.owner, tokenIn, o.amountIn);
            if (f.amountIn == 0) continue;
            vault.transferInternal(o.owner, address(this), tokenIn, f.amountIn);
            t.fills++;
            if (o.zeroForOne) {
                t.in0 += f.amountIn;
                t.out1 += f.amountOut;
            } else {
                t.in1 += f.amountIn;
                t.out0 += f.amountOut;
            }
        }
    }

    function _returnRounding(
        uint256[] storage ids,
        Fill[] memory fills,
        uint256 surplus,
        uint256 totalOutput,
        bool outputToken0
    ) internal view {
        if (surplus == 0) return;
        uint256 remaining = surplus;
        uint256 first = type(uint256).max;
        for (uint256 i; i < ids.length; i++) {
            if (fills[i].amountIn == 0 || orders[ids[i]].zeroForOne == outputToken0) continue;
            if (first == type(uint256).max || ids[i] < ids[first]) first = i;
            uint256 share = FullMath.mulDiv(surplus, fills[i].amountOut, totalOutput);
            fills[i].amountOut += share;
            remaining -= share;
        }
        fills[first].amountOut += remaining;
    }

    function _route(Totals memory t) internal returns (Residual memory r) {
        if (t.in0 > t.out0 && t.out1 > t.in1) {
            r.zeroForOne = true;
            r.amountIn = t.in0 - t.out0;
            (r.amountOut, r.donated) = _residualSwap(true, r.amountIn, t.out1 - t.in1);
        } else if (t.in1 > t.out1 && t.out0 > t.in0) {
            r.amountIn = t.in1 - t.out1;
            (r.amountOut, r.donated) = _residualSwap(false, r.amountIn, t.out0 - t.in0);
        } else if (t.out0 > t.in0 || t.out1 > t.in1) {
            revert Imbalanced();
        }
    }

    function _routeExternal(Totals memory t) internal returns (Residual memory r) {
        uint256 owed;
        if (t.in0 > t.out0 && t.out1 > t.in1) {
            r.zeroForOne = true;
            r.amountIn = t.in0 - t.out0;
            owed = t.out1 - t.in1;
        } else if (t.in1 > t.out1 && t.out0 > t.in0) {
            r.amountIn = t.in1 - t.out1;
            owed = t.out0 - t.in0;
        } else if (t.out0 > t.in0 || t.out1 > t.in1) {
            revert Imbalanced();
        } else {
            return r;
        }
        address outToken = _inputToken(!r.zeroForOne);
        uint256 beforeBalance = IERC20Balance(outToken).balanceOf(address(this));
        vault.operatorPull(_inputToken(r.zeroForOne), r.amountIn, address(externalMarket));
        r.amountOut = externalMarket.swap(r.zeroForOne, r.amountIn, owed);
        if (r.amountOut < owed || IERC20Balance(outToken).balanceOf(address(this)) - beforeBalance != r.amountOut) {
            revert ResidualShort(r.amountOut, owed);
        }
        vault.operatorPush(outToken, r.amountOut);
        if (r.zeroForOne) {
            t.in0 -= r.amountIn;
            t.in1 += r.amountOut;
        } else {
            t.in1 -= r.amountIn;
            t.in0 += r.amountOut;
        }
    }

    function _checkMarginal(uint256 priceX96) internal view {
        uint256 poolP = poolPriceX96();
        uint256 diff = poolP > priceX96 ? poolP - priceX96 : priceX96 - poolP;
        if (diff * BPS > toleranceBps * priceX96) revert NotMarginalPrice(priceX96, poolP);
    }

    function _pay(uint64 batchId, uint256[] storage ids, Fill[] memory fills) internal {
        for (uint256 i; i < ids.length; i++) {
            uint256 id = ids[i];
            Order memory o = orders[id];
            Fill memory f = fills[i];
            if (f.amountIn != 0) {
                vault.transferInternal(address(this), o.owner, _inputToken(!o.zeroForOne), f.amountOut);
                emit Filled(batchId, id, o.owner, f.amountIn, f.amountOut);
            } else {
                emit Unfilled(batchId, id, o.owner);
            }
            vault.closeCommitment(o.owner);
        }
    }

    // ---- residual swap on the sealed pool

    function _residualSwap(bool zeroForOne, uint256 amountIn, uint256 owed)
        internal
        returns (uint256 out, uint256 donated)
    {
        vault.operatorPull(zeroForOne ? token0 : token1, amountIn, address(this));
        (out, donated) = abi.decode(manager.unlock(abi.encode(zeroForOne, amountIn, owed)), (uint256, uint256));
        vault.operatorPush(zeroForOne ? token1 : token0, owed);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert Unauthorized();
        (bool zeroForOne, uint256 amountIn, uint256 owed) = abi.decode(data, (bool, uint256, uint256));
        PoolKey memory k = key;

        BalanceDelta d = manager.swap(
            k,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        uint256 used = uint256(uint128(-(zeroForOne ? d.amount0() : d.amount1())));
        if (used != amountIn) revert PartialResidual(amountIn, used);
        uint256 out = uint256(uint128(zeroForOne ? d.amount1() : d.amount0()));
        if (out < owed) revert ResidualShort(out, owed);

        Currency cIn = zeroForOne ? k.currency0 : k.currency1;
        manager.sync(cIn);
        IERC20Like(Currency.unwrap(cIn)).transfer(address(manager), amountIn);
        manager.settle();

        uint256 surplus = out - owed;
        if (surplus != 0) manager.donate(k, zeroForOne ? 0 : surplus, zeroForOne ? surplus : 0, "");
        manager.take(zeroForOne ? k.currency1 : k.currency0, address(this), owed);
        return abi.encode(out, surplus);
    }

    // ---- internals

    function _setActivePrice(uint256 p) internal {
        bytes32 slot = ACTIVE_PRICE_SLOT;
        assembly ("memory-safe") {
            tstore(slot, p)
        }
    }

    function _activePrice() internal view returns (uint256 p) {
        bytes32 slot = ACTIVE_PRICE_SLOT;
        assembly ("memory-safe") {
            p := tload(slot)
        }
    }

    function _inputToken(bool zeroForOne) internal view override returns (address) {
        return zeroForOne ? token0 : token1;
    }
}
