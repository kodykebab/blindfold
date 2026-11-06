// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {DeployBlindfold} from "../script/DeployBlindfold.s.sol";
import {UniswapV3Market} from "../src/market/UniswapV3Market.sol";

/// The deploy script against the real USDC/WETH 0.05% pool: real tokens, the v3 market with the replay's defaults, and
/// the check that refuses a maxDelay shorter than the settle window (FIXES.md fixes 3 and 7).
contract DeployBlindfoldEthereumForkTest is Test {
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address constant POOL = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;

    DeployBlindfold script;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC", string("https://ethereum-rpc.publicnode.com"));
        uint256 forkBlock = vm.envOr("ETH_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, forkBlock);
        script = new DeployBlindfold();
    }

    function _params() internal view returns (DeployBlindfold.Params memory p) {
        p = script.params();
        (p.token0, p.token1, p.depositAmount) = (USDC, WETH, 1e15);
        (p.marketKind, p.v3Factory, p.v3Pool) = ("v3", FACTORY, POOL);
    }

    function test_ethereum_realPoolDeploysWithTheReplayDefaults() public {
        DeployBlindfold.Deployment memory d = script.deploy(_params(), address(this));
        script.check(d);
        UniswapV3Market m = UniswapV3Market(address(d.market));
        assertEq(d.marketKind, "v3");
        assertEq(m.maxObservationAge(), 0, "no latest-trade activity check (fix 1)");
        assertEq(m.maxDelay(), d.settlement.settleLength(), "the reference covers the whole settle window (fix 3)");
        assertEq(m.window(), 600);
        assertEq(m.maxDeviationBps(), 100);
        // the deployment can price a quote right now, as the client will
        assertGt(m.referencePrice(block.timestamp), 0);
    }

    function test_ethereum_shortMaxDelayIsRefused() public {
        DeployBlindfold.Params memory p = _params();
        p.maxDelay = 30;
        DeployBlindfold.Deployment memory d = script.deploy(p, address(this));
        vm.expectRevert(bytes("market maxDelay is shorter than the settle window"));
        script.check(d);
    }
}
