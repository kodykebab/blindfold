// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {IERC20Like} from "../BlindfoldVault.sol";
import {IERC20Balance} from "../market/IExternalMarket.sol";
import {ISwapVM} from "swap-vm/src/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "swap-vm/src/libs/MakerTraits.sol";
import {TakerTraitsLib} from "swap-vm/src/libs/TakerTraits.sol";
import {BlindfoldAquaRouter} from "./BlindfoldAquaRouter.sol";

interface IAquaSettlement {
    function manager() external view returns (IPoolManager);
    function poolKey() external view returns (PoolKey memory);
}

/// @notice Immutable, storage-free Aqua/v4 residual execution for AquaAdmittedSettlement.
/// @dev Delegatecall only. Never adds storage: the caller owns custody, batch state and price validation.
contract AquaResidual {
    error Unauthorized();
    error AquaConfig();
    error AquaTransfer();
    error PartialResidual(uint256 wanted, uint256 used);
    error ResidualShort(uint256 out, uint256 owed);
    error UnexpectedDelta(int128 amountIn, int128 amountOut);

    event AquaResidualFilled(bytes32 indexed strategyHash, bool zeroForOne, uint256 amountIn, uint256 amountOut);

    address private immutable self = address(this);
    BlindfoldAquaRouter public immutable router;
    address public immutable maker;
    uint256 public immutable shareBps;
    uint8 private immutable opcode;

    constructor(BlindfoldAquaRouter router_, address maker_, uint256 shareBps_) {
        if (address(router_).code.length == 0 || maker_ == address(0) || shareBps_ == 0 || shareBps_ >= 10_000) {
            revert AquaConfig();
        }
        if (address(router_.AQUA()).code.length == 0) revert AquaConfig();
        router = router_;
        maker = maker_;
        shareBps = shareBps_;
        opcode = router_.sealedClearingOpcode();
    }

    /// @notice Exact callback-free strategy the maker ships for this settlement and router.
    function order(address settlement) public view returns (ISwapVM.Order memory) {
        MakerTraitsLib.Args memory m;
        m.maker = maker;
        m.useAquaInsteadOfSignature = true;
        m.program = abi.encodePacked(opcode, uint8(20), settlement);
        return MakerTraitsLib.build(m);
    }

    /// @notice Split the already-funded residual, cover all liabilities and donate aggregate surplus.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (address(this) == self) revert Unauthorized();
        IPoolManager manager = IAquaSettlement(address(this)).manager();
        if (msg.sender != address(manager)) revert Unauthorized();
        PoolKey memory key = IAquaSettlement(address(this)).poolKey();
        (bool zeroForOne, uint256 amountIn, uint256 owed) = abi.decode(data, (bool, uint256, uint256));
        uint256 aquaIn = FullMath.mulDiv(amountIn, shareBps, 10_000);
        uint256 aquaOut = aquaIn == 0 ? 0 : _aqua(key, zeroForOne, aquaIn);
        uint256 poolIn = amountIn - aquaIn; // share < 100%: every nonzero residual moves v4 too
        uint256 poolOut = _pool(manager, key, zeroForOne, poolIn);
        uint256 out = aquaOut + poolOut;
        if (out < owed) revert ResidualShort(out, owed);
        uint256 surplus = out - owed;
        Currency output = zeroForOne ? key.currency1 : key.currency0;
        // Pay v4's input delta, collect its entire output, then fund the donation from the combined
        // output. This handles tiny residuals and Aqua rounding surplus without borrowing old balances.
        manager.take(output, address(this), poolOut);
        if (surplus != 0) {
            manager.donate(key, zeroForOne ? 0 : surplus, zeroForOne ? surplus : 0, "");
            manager.sync(output);
            IERC20Like(Currency.unwrap(output)).transfer(address(manager), surplus);
            manager.settle();
        }
        return abi.encode(out, surplus);
    }

    function _aqua(PoolKey memory key, bool zeroForOne, uint256 amount) private returns (uint256 out) {
        address input = Currency.unwrap(zeroForOne ? key.currency0 : key.currency1);
        address output = Currency.unwrap(zeroForOne ? key.currency1 : key.currency0);
        uint256 beforeIn = IERC20Balance(input).balanceOf(address(this));
        uint256 beforeOut = IERC20Balance(output).balanceOf(address(this));
        if (!IERC20Like(input).approve(address(router), amount)) revert AquaTransfer();
        TakerTraitsLib.Args memory t;
        t.taker = address(this);
        t.isExactIn = true;
        t.useTransferFromAndAquaPush = true;
        uint256 used;
        bytes32 hash;
        (used, out, hash) = router.swap(order(address(this)), input, output, amount, TakerTraitsLib.build(t));
        if (
            used != amount || beforeIn - IERC20Balance(input).balanceOf(address(this)) != amount
                || IERC20Balance(output).balanceOf(address(this)) - beforeOut != out
        ) revert AquaTransfer();
        emit AquaResidualFilled(hash, zeroForOne, amount, out);
    }

    function _pool(IPoolManager manager, PoolKey memory key, bool zeroForOne, uint256 amount)
        private
        returns (uint256 out)
    {
        BalanceDelta d = manager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 input = zeroForOne ? d.amount0() : d.amount1();
        int128 output = zeroForOne ? d.amount1() : d.amount0();
        if (input > 0 || output < 0) revert UnexpectedDelta(input, output);
        uint256 used = uint256(-int256(input));
        if (used != amount) revert PartialResidual(amount, used);
        out = uint256(int256(output));
        Currency currency = zeroForOne ? key.currency0 : key.currency1;
        manager.sync(currency);
        IERC20Like(Currency.unwrap(currency)).transfer(address(manager), amount);
        manager.settle();
    }
}
