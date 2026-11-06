// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {BondRegistry} from "../../src/court/BondRegistry.sol";
import {DemoRouter, SandwichBot} from "./demo/DemoSwap.sol";

/// @notice The packages/demo-bots sandwich, offline: a plain ETH/DEMO 0.3% v4 pool, a bot contract that both legs
///         call, and a victim swapping through a shared router. Checks the shape Court needs (one bot contract as
///         the front and back Swap sender, the router as the victim's) and that it leaves a fee-capped budget.
contract DemoSandwichTest is Test {
    uint160 constant PRICE_1 = 79228162514264337593543950336;
    bytes32 constant V4_SWAP = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");

    IPoolManager manager;
    PoolKey key;
    DemoRouter router;
    SandwichBot bot;
    address owner = makeAddr("bot owner");
    address victim = makeAddr("victim");

    function setUp() public {
        manager = new PoolManager(address(this));
        MockERC20 token = new MockERC20("Demo", "DEMO", 18);
        key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(token)), 3000, 60, IHooks(address(0)));
        manager.initialize(key, PRICE_1);
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        token.mint(address(this), 2000 ether);
        token.approve(address(lp), type(uint256).max);
        lp.modifyLiquidity{value: 1001 ether}(
            key,
            IPoolManager.ModifyLiquidityParams(TickMath.minUsableTick(60), TickMath.maxUsableTick(60), 1000e18, 0),
            ""
        );
        router = new DemoRouter(manager);
        vm.deal(owner, 100 ether);
        vm.prank(owner);
        bot = new SandwichBot{value: 100 ether}(manager);
        vm.deal(victim, 10 ether);
    }

    receive() external payable {} // the liquidity helper refunds unused ETH

    function test_demoSandwich_shapeAndBudget() public {
        vm.recordLogs();
        vm.prank(owner);
        uint256 frontIn = 15 ether;
        bot.swap(key, true, frontIn);
        vm.prank(victim);
        uint256 got = router.swapExactIn{value: 10 ether}(key, true, 10 ether, 9.5 ether, victim);
        vm.prank(owner);
        uint256 back = bot.swap(key, false, 0); // sells everything the front bought

        Vm.Log[] memory logs = vm.getRecordedLogs();
        address[3] memory want = [address(bot), address(router), address(bot)];
        uint256 n;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] != V4_SWAP) continue;
            assertEq(address(uint160(uint256(logs[i].topics[2]))), want[n++], "Swap sender");
        }
        assertEq(n, 3);
        assertGe(got, 9.5 ether, "the victim still clears its slippage");
        assertEq(MockERC20(Currency.unwrap(key.currency1)).balanceOf(address(bot)), 0, "the back closes the front");
        assertGt(back, frontIn, "the bot profits");
        BondRegistry.Config memory cfg;
        uint256 budget = new BondRegistry(cfg).budgetFor(back - frontIn, frontIn, key.fee);
        assertEq(budget, frontIn * 3000 / 1e6, "the front leg's fee caps the budget");
        assertLt(budget, back - frontIn);
    }

    function test_onlyTheOwnerTrades() public {
        vm.expectRevert();
        bot.swap(key, true, 1 ether);
    }
}
