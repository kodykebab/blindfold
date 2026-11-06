// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
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
import {IV3Pool, IV3Factory, IERC20Balance} from "../src/market/IExternalMarket.sol";

contract ExternalEthereumForkTest is Test {
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    IV3Factory constant FACTORY = IV3Factory(0x1F98431c8aD98523631AE4a59f267346ea31F984);
    uint256 constant Q96 = 1 << 96;
    BlindfoldVault vault;
    BlindfoldSettlement s;
    UniswapV3Market market;
    uint256 forkTime;
    uint64 start;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC", string("https://ethereum-rpc.publicnode.com"));
        uint256 forkBlock = vm.envOr("ETH_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, forkBlock);
        emit log_named_uint("external market fork block", block.number);
        forkTime = block.timestamp;
        start = uint64(forkTime - 60);
        vault = new BlindfoldVault();
        PoolManager manager = new PoolManager(address(this));
        s = new BlindfoldSettlement(
            BlindfoldSettlement.Config(
                manager, vault, USDC, 1e6, 0, address(0x1234), BatchAuction.Schedule(start, 30, 24, 30), 100
            )
        );
        vault.setOperator(address(s));
        (address pool) = FACTORY.getPool(USDC, WETH, 500);
        market = new UniswapV3Market(address(s), FACTORY, IV3Pool(pool), 600, 30, 120, 1e15, 100);
        (uint160 sqrt,,,,,,) = IV3Pool(pool).slot0();
        (IHooks hook) = _hook(address(manager));
        PoolKey memory key = PoolKey(Currency.wrap(USDC), Currency.wrap(WETH), 3000, 60, hook);
        manager.initialize(key, sqrt);
        s.initialize(key);
        s.configureExternal(market);
        deal(USDC, address(this), 100_000e6);
        deal(WETH, address(this), 100e18);
        IERC20Like(USDC).approve(address(vault), type(uint256).max);
        IERC20Like(WETH).approve(address(vault), type(uint256).max);
        vault.deposit(USDC, 100_000e6);
        vault.deposit(WETH, 100e18);
    }

    function _hook(address manager) internal returns (IHooks) {
        (SealedPoolHook hook,) = HookDeployer.deploySealed(address(this), manager, address(s));
        return IHooks(address(hook));
    }

    function _ready(bool sell, uint128 amount, uint128 minimum) internal returns (uint256 id) {
        vm.warp(start);
        BatchAuction.Order memory o = BatchAuction.Order(address(this), sell, amount, minimum);
        id = s.commit(0, s.orderHash(0, o, bytes32(0)), "fixture");
        vm.warp(s.revealOpens(0));
        s.reveal(id, o, bytes32(0));
        vm.warp(forkTime);
    }

    function test_ethereum_publicPoolFillsOneSidedBatchBothDirections() public {
        uint256 snapshot = vm.snapshotState();
        for (uint256 i; i < 2; i++) {
            uint256 ref = s.referencePriceX96(0);
            bool sell = i == 0;
            uint128 amount = sell ? uint128(1000e6) : uint128(1e18);
            uint256 proposed = sell ? (ref - ref / 100) : ref * 101 / 100;
            uint256 quoted = sell ? FullMath.mulDiv(amount, proposed, Q96) : FullMath.mulDiv(amount, Q96, proposed);
            _ready(sell, amount, uint128(quoted));
            address outToken = sell ? WETH : USDC;
            uint256 beforeOut = vault.balanceOf(address(this), outToken);
            uint256 beforeGas = gasleft();
            s.settleExternal(0, proposed);
            emit log_named_uint("external settlement call gas (fork, warm setup)", beforeGas - gasleft());
            assertGe(vault.balanceOf(address(this), outToken) - beforeOut, quoted);
            assertEq(s.poolLiquidity(), 0);
            assertEq(vault.openCommitments(address(this)), 0);
            assertEq(vault.balanceOf(address(s), USDC) + vault.balanceOf(address(s), WETH), 0);
            assertEq(IERC20Balance(USDC).balanceOf(address(market)) + IERC20Balance(WETH).balanceOf(address(market)), 0);
            if (i == 0) vm.revertToState(snapshot);
        }
    }

    function test_ethereum_largeResidualRevertsThenPartialFillExecutes() public {
        uint256 snapshot = vm.snapshotState();
        for (uint256 i; i < 2; i++) {
            bool sell = i == 0;
            uint256 ref = s.referencePriceX96(0);
            uint256 proposed = sell ? ref - ref / 100 : ref + ref / 100;
            uint128 amount = sell ? uint128(2_000_000e6) : uint128(1000e18);
            address input = sell ? USDC : WETH;
            deal(input, address(this), amount);
            vault.deposit(input, amount);
            uint256 minimum = sell ? FullMath.mulDiv(amount, proposed, Q96) : FullMath.mulDiv(amount, Q96, proposed);
            uint256 id = _ready(sell, amount, uint128(minimum * 99 / 100));
            uint256 beforeInput = vault.balanceOf(address(this), input);
            vm.expectRevert(UniswapV3Market.InsufficientOutput.selector);
            s.settleExternal(0, proposed);
            assertFalse(s.finalized(0));
            assertEq(vault.balanceOf(address(this), input), beforeInput);
            assertEq(vault.lockedOf(address(this), input), amount);
            uint128 partialInput = sell ? uint128(1000e6) : uint128(1e18);
            s.settleExternal(0, proposed, id, partialInput);
            assertEq(vault.balanceOf(address(this), input), beforeInput - partialInput);
            assertEq(vault.lockedOf(address(this), input), 0);
            assertEq(vault.openCommitments(address(this)), 0);
            assertEq(vault.balanceOf(address(s), USDC) + vault.balanceOf(address(s), WETH), 0);
            if (i == 0) vm.revertToState(snapshot);
        }
    }

    function test_ethereum_staleObservationFailsClosed() public {
        vm.warp(forkTime + 121);
        vm.expectRevert(UniswapV3Market.StaleObservation.selector);
        market.referencePrice(block.timestamp);
    }
}
