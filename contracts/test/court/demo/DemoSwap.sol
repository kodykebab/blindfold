// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "v4-core/src/interfaces/external/IERC20Minimal.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";

/// @dev Exact-input swaps on a v4 pool, paid from and taken to this contract, so it is the Swap log's `sender`.
abstract contract V4Swapper is IUnlockCallback {
    IPoolManager public immutable manager;

    constructor(IPoolManager m) {
        manager = m;
    }

    receive() external payable {}

    function _swap(PoolKey memory key, bool zeroForOne, uint256 amountIn) internal returns (uint256) {
        return abi.decode(manager.unlock(abi.encode(key, zeroForOne, amountIn)), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager));
        (PoolKey memory key, bool zeroForOne, uint256 amountIn) = abi.decode(data, (PoolKey, bool, uint256));
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        BalanceDelta d = manager.swap(key, IPoolManager.SwapParams(zeroForOne, -int256(amountIn), limit), "");
        (Currency cin, Currency cout) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        (int128 paid, int128 got) = zeroForOne ? (d.amount0(), d.amount1()) : (d.amount1(), d.amount0());
        uint256 owed = uint256(uint128(-paid));
        if (cin.isAddressZero()) {
            manager.settle{value: owed}();
        } else {
            manager.sync(cin);
            IERC20Minimal(Currency.unwrap(cin)).transfer(address(manager), owed);
            manager.settle();
        }
        uint256 out = uint256(uint128(got));
        manager.take(cout, address(this), out);
        return abi.encode(out);
    }
}

/// @notice The shared router the demo victim swaps through: takes the input from the caller, pays the output to
///         `to`, and reverts below `minOut` (the tx's slippage, which the demo RPC prices its coverage from).
contract DemoRouter is V4Swapper {
    error TooLittleReceived(uint256 out, uint256 minOut);

    constructor(IPoolManager m) V4Swapper(m) {}

    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut, address to)
        external
        payable
        returns (uint256 out)
    {
        Currency cin = zeroForOne ? key.currency0 : key.currency1;
        if (cin.isAddressZero()) require(msg.value == amountIn);
        else IERC20Minimal(Currency.unwrap(cin)).transferFrom(msg.sender, address(this), amountIn);
        out = _swap(key, zeroForOne, amountIn);
        if (out < minOut) revert TooLittleReceived(out, minOut);
        (zeroForOne ? key.currency1 : key.currency0).transfer(to, out);
    }
}

/// @notice The demo sandwich bot's own contract. Its owner's front and back legs both call it; it trades its own
///         balance and keeps the output, so it is the legs' tx `to` and their Swap logs' `sender`.
contract SandwichBot is V4Swapper {
    address public immutable owner;

    constructor(IPoolManager m) payable V4Swapper(m) {
        owner = msg.sender;
    }

    /// @param amountIn 0 sells this contract's whole balance of the input currency (a back leg closing the front)
    function swap(PoolKey calldata key, bool zeroForOne, uint256 amountIn) external returns (uint256) {
        require(msg.sender == owner);
        if (amountIn == 0) amountIn = (zeroForOne ? key.currency0 : key.currency1).balanceOfSelf();
        return _swap(key, zeroForOne, amountIn);
    }

    /// @notice What the bot sizes its front leg from.
    function poolState(PoolKey calldata key) external view returns (uint160 sqrtPriceX96, uint128 liquidity) {
        PoolId id = key.toId();
        (sqrtPriceX96,,,) = StateLibrary.getSlot0(manager, id);
        liquidity = StateLibrary.getLiquidity(manager, id);
    }
}
