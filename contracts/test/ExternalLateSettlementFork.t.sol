// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {ExternalSandwichActor} from "./ExternalSandwichActor.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {BlindfoldVault, IERC20Like} from "../src/BlindfoldVault.sol";
import {BatchAuction} from "../src/BatchAuction.sol";
import {BlindfoldSettlement} from "../src/BlindfoldSettlement.sol";
import {SealedPoolHook} from "../src/SealedPoolHook.sol";
import {HookDeployer} from "./utils/HookDeployer.sol";
import {UniswapV3Market} from "../src/market/UniswapV3Market.sol";
import {IV3Pool, IV3Factory} from "../src/market/IExternalMarket.sol";

/// FIXES.md fix 3: the public-pool route can settle anywhere in a long settle window when the market's maxDelay covers
/// that window, so a slow solver or the keeper's fallback still lands. Real USDC/WETH 0.05% pool on an Ethereum fork.
contract ExternalLateSettlementForkTest is Test {
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    IV3Factory constant FACTORY = IV3Factory(0x1F98431c8aD98523631AE4a59f267346ea31F984);
    uint256 constant Q96 = 1 << 96;
    uint32 constant SETTLE = 300;
    uint32 constant LATE = 240; // settle this long after reveals close
    BlindfoldVault vault;
    BlindfoldSettlement s;
    UniswapV3Market market;
    IV3Pool pool;
    uint256 forkTime;
    uint64 start;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC", string("https://ethereum-rpc.publicnode.com"));
        uint256 forkBlock = vm.envOr("ETH_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, forkBlock);
        forkTime = block.timestamp;
        // revealCloses(0) = start + 300 (batch) + 6 (drand) + 24 (reveal) lands LATE seconds before the fork's time
        uint256 at = forkTime - LATE - 330;
        start = uint64(at - (at - 1692803367) % 3);
        vault = new BlindfoldVault();
        PoolManager manager = new PoolManager(address(this));
        s = new BlindfoldSettlement(
            BlindfoldSettlement.Config(
                manager, vault, USDC, 1e6, 0, address(0x1234), 0, BatchAuction.Schedule(start, 300, 24, SETTLE), 100
            )
        );
        vault.setOperator(address(s));
        pool = IV3Pool(FACTORY.getPool(USDC, WETH, 500));
        // Establish activity with real swaps; public fork heads can otherwise be quiet for longer than 120 s.
        ExternalSandwichActor activity = new ExternalSandwichActor(IV3Pool(pool));
        deal(USDC, address(activity), 10_000e6);
        uint256 bought = activity.trade(true, 10_000e6);
        activity.trade(false, bought);

        // maxDelay covers the whole settle window
        market = new UniswapV3Market(address(s), FACTORY, pool, 600, SETTLE, 120, 1e15, 100);
        (uint160 sqrt,,,,,,) = pool.slot0();
        (SealedPoolHook hook,) = HookDeployer.deploySealed(address(this), address(manager), address(s));
        PoolKey memory key = PoolKey(Currency.wrap(USDC), Currency.wrap(WETH), 3000, 60, IHooks(address(hook)));
        manager.initialize(key, sqrt);
        s.initialize(key);
        s.configureExternal(market);
        deal(USDC, address(this), 100_000e6);
        IERC20Like(USDC).approve(address(vault), type(uint256).max);
        vault.deposit(USDC, 100_000e6);
    }

    function test_ethereum_settlesLateInTheWindowWhenMaxDelayCoversIt() public {
        // a one-sided sell of 1,000 USDC with a 1% limit, priced from the reference the settlement will use
        vm.warp(forkTime);
        uint256 ref = s.referencePriceX96(0);
        uint256 proposed = ref - ref / 100;
        BatchAuction.Order memory o =
            BatchAuction.Order(address(this), true, 1000e6, uint128(FullMath.mulDiv(1000e6, proposed, Q96)));
        // committed and revealed on schedule
        vm.warp(start);
        uint256 id = s.commit(0, s.orderHash(0, o, bytes32(0)), "fixture");
        vm.warp(s.revealOpens(0));
        s.reveal(id, o, bytes32(0));
        // LATE seconds after reveals closed, well past the 30 s the tests used to allow
        vm.warp(forkTime);
        assertGe(block.timestamp - s.revealCloses(0), LATE); // drand alignment can add up to 2 s
        uint256 before = vault.balanceOf(address(this), WETH);
        s.settleExternal(0, proposed);
        assertGe(vault.balanceOf(address(this), WETH) - before, o.minAmountOut);
        assertTrue(s.finalized(0));
    }

    function test_ethereum_shortMaxDelayRejectsTheSameLateSettlement() public {
        UniswapV3Market short = new UniswapV3Market(address(s), FACTORY, pool, 600, 30, 120, 1e15, 100);
        uint256 end = s.revealCloses(0);
        assertGe(block.timestamp - end, LATE);
        vm.expectRevert(UniswapV3Market.StaleReference.selector);
        short.referencePrice(end);
        // the long-delay market still checks spot against the reference at execution time
        assertGt(market.referencePrice(end), 0);
    }
}
