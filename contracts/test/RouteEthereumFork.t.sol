// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {BlindfoldVault, IERC20Like} from "../src/BlindfoldVault.sol";
import {BlindfoldSettlement} from "../src/BlindfoldSettlement.sol";
import {BatchAuction} from "../src/BatchAuction.sol";
import {SealedPoolHook} from "../src/SealedPoolHook.sol";
import {HookDeployer} from "./utils/HookDeployer.sol";
import {UniswapV3Route} from "../src/market/UniswapV3Route.sol";
import {IV3Factory, IV3Pool, IERC20Balance} from "../src/market/IExternalMarket.sol";

contract RouteEthereumForkTest is Test {
    address constant WBTC = 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    IV3Factory constant FACTORY = IV3Factory(0x1F98431c8aD98523631AE4a59f267346ea31F984);
    uint256 constant Q96 = 1 << 96;
    BlindfoldVault vault;
    BlindfoldSettlement s;
    UniswapV3Route route;
    uint256 forkTime;
    uint64 start;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC", string("https://ethereum-rpc.publicnode.com"));
        uint256 at = vm.envOr("ROUTING_FORK_BLOCK", uint256(0));
        if (at == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, at);
        forkTime = block.timestamp;
        start = uint64(forkTime - 60);
        emit log_named_uint("routing fork block", block.number);
        vault = new BlindfoldVault();
        PoolManager manager = new PoolManager(address(this));
        s = new BlindfoldSettlement(
            BlindfoldSettlement.Config(
                manager, vault, USDC, 1e6, 0, address(123), BatchAuction.Schedule(start, 30, 24, 30), 100
            )
        );
        vault.setOperator(address(s));
        (SealedPoolHook hook,) = HookDeployer.deploySealed(address(this), address(manager), address(s));
        PoolKey memory key = PoolKey(Currency.wrap(WBTC), Currency.wrap(USDC), 3000, 60, IHooks(address(hook)));
        manager.initialize(key, uint160(Q96));
        s.initialize(key);
        address[] memory path = new address[](3);
        path[0] = WBTC;
        path[1] = WETH;
        path[2] = USDC;
        UniswapV3Route.HopConfig[] memory hops = new UniswapV3Route.HopConfig[](2);
        // Fixture guard values; not production calibration.
        hops[0] = UniswapV3Route.HopConfig(IV3Pool(FACTORY.getPool(WBTC, WETH, 500)), 1, 1800);
        hops[1] = UniswapV3Route.HopConfig(IV3Pool(FACTORY.getPool(USDC, WETH, 500)), 1, 1800);
        route = new UniswapV3Route(address(s), FACTORY, path, hops, 600, 30, 100);
        s.configureExternal(route);
        deal(WBTC, address(this), 10e8);
        deal(USDC, address(this), 10000e6);
        IERC20Like(WBTC).approve(address(vault), type(uint256).max);
        IERC20Like(USDC).approve(address(vault), type(uint256).max);
        vault.deposit(WBTC, 10e8);
        vault.deposit(USDC, 10000e6);
    }

    function test_ethereum_multihopSettlementBothDirections() public {
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < 2; i++) {
            bool sell = i == 0;
            uint256 ref = s.referencePriceX96(0);
            uint256 p = sell ? ref - ref / 100 : ref + ref / 100;
            uint128 amount = sell ? uint128(1e6) : uint128(100e6);
            uint256 quoted = sell ? FullMath.mulDiv(amount, p, Q96) : FullMath.mulDiv(amount, Q96, p);
            vm.warp(start);
            BatchAuction.Order memory o = BatchAuction.Order(address(this), sell, amount, uint128(quoted));
            uint256 id = s.commit(0, s.orderHash(0, o, 0), "route");
            vm.warp(s.revealOpens(0));
            s.reveal(id, o, 0);
            vm.warp(forkTime);
            address output = sell ? USDC : WBTC;
            uint256 beforeOut = vault.balanceOf(address(this), output);
            uint256 gasBefore = gasleft();
            s.settleExternal(0, p);
            emit log_named_uint("two-hop settlement gas (warm setup)", gasBefore - gasleft());
            assertGe(vault.balanceOf(address(this), output) - beforeOut, quoted);
            assertEq(s.poolLiquidity(), 0);
            assertEq(vault.openCommitments(address(this)), 0);
            assertEq(IERC20Balance(WETH).balanceOf(address(route)), 0);
            assertEq(vault.balanceOf(address(this), WETH), 0);
            assertEq(vault.balanceOf(address(s), WBTC) + vault.balanceOf(address(s), USDC), 0);
            if (i == 0) vm.revertToState(snap);
        }
    }
}
