// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {GlobalAuction} from "../../src/global/GlobalAuction.sol";
import {GlobalProofMock} from "./GlobalAuction.t.sol";
import {BlindfoldVault, IERC20Like} from "../../src/BlindfoldVault.sol";
import {UniswapV3Route} from "../../src/market/UniswapV3Route.sol";
import {IV3Factory, IV3Pool, IERC20Balance} from "../../src/market/IExternalMarket.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

contract GlobalEthereumForkTest is Test {
    address constant WBTC = 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    IV3Factory constant FACTORY = IV3Factory(0x1F98431c8aD98523631AE4a59f267346ea31F984);
    GlobalAuction g;
    BlindfoldVault vault;
    UniswapV3Route route;
    uint64 start;
    uint256 forkTime;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC", string("https://ethereum-rpc.publicnode.com"));
        uint256 at = vm.envOr("GLOBAL_FORK_BLOCK", uint256(0));
        if (at == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, at);
        emit log_named_uint("global Ethereum fork block", block.number);
        forkTime = block.timestamp;
        start = uint64(1692803367 + (forkTime - 60 - 1692803367) / 3 * 3);
        vm.warp(start);
        address[] memory tokens = new address[](3);
        tokens[0] = WBTC;
        tokens[1] = USDC;
        tokens[2] = WETH;
        vault = new BlindfoldVault();
        g = new GlobalAuction(
            GlobalAuction.Config(
                vault, new GlobalProofMock(), tokens, start, 30, 12, 30, 10, 1, 2000, address(0xfee), keccak256("test")
            )
        );
        vault.setOperator(address(g));
        address[] memory path = new address[](3);
        path[0] = WBTC;
        path[1] = WETH;
        path[2] = USDC;
        UniswapV3Route.HopConfig[] memory hops = new UniswapV3Route.HopConfig[](2);
        hops[0] = UniswapV3Route.HopConfig(IV3Pool(FACTORY.getPool(WBTC, WETH, 500)), 1, 1800);
        hops[1] = UniswapV3Route.HopConfig(IV3Pool(FACTORY.getPool(USDC, WETH, 500)), 1, 1800);
        route = new UniswapV3Route(address(g), FACTORY, path, hops, 600, 60, 100);
        g.addMarket(route, true);
        address[] memory direct = new address[](2);
        direct[0] = WBTC;
        direct[1] = WETH;
        UniswapV3Route.HopConfig[] memory single = new UniswapV3Route.HopConfig[](1);
        single[0] = hops[0];
        g.addMarket(new UniswapV3Route(address(g), FACTORY, direct, single, 600, 60, 100), true);
        g.sealConfiguration();
        deal(WBTC, address(this), 1e8);
        deal(USDC, address(this), 10000e6);
        IERC20Like(WBTC).approve(address(vault), type(uint256).max);
        IERC20Like(USDC).approve(address(vault), type(uint256).max);
        vault.deposit(WBTC, 1e8);
        vault.deposit(USDC, 10000e6);
    }

    function test_globalSharedVaultRoutesRealPoolsBothDirections() public {
        uint256 snapshot = vm.snapshotState();
        for (uint256 side; side < 2; side++) {
            vm.warp(forkTime);
            uint256[8] memory p = g.prices(0);
            p[1] = side == 0 ? p[1] + p[1] / 100 : p[1] - p[1] / 100;
            uint8 input = side == 0 ? 0 : 1;
            uint8 output = side == 0 ? 1 : 0;
            uint128 amount = side == 0 ? uint128(1e6) : uint128(100e6);
            uint256 quoted = FullMath.mulDiv(amount, p[input], p[output]);
            GlobalAuction.Order memory order =
                GlobalAuction.Order(address(this), input, output, amount, uint128(quoted));
            _admitReveal(order);
            uint128[] memory f = new uint128[](1);
            f[0] = type(uint128).max;
            GlobalAuction.Route[] memory routes = new GlobalAuction.Route[](1);
            routes[0] = GlobalAuction.Route(input, output, 0, amount, uint128(quoted));
            uint256 beforeGas = gasleft();
            g.settleAtPrices(0, p, f, routes);
            emit log_named_uint("global two-hop settlement gas", beforeGas - gasleft());
            assertEq(vault.openCommitments(address(this)), 0);
            assertEq(vault.balanceOf(address(g), WBTC) + vault.balanceOf(address(g), USDC), 0);
            assertEq(vault.balanceOf(address(this), WETH), 0);
            assertEq(IERC20Balance(WETH).balanceOf(address(route)), 0);
            if (side == 0) vm.revertToState(snapshot);
        }
    }

    function _admitReveal(GlobalAuction.Order memory order) private {
        vm.warp(start);
        bytes32 hash = g.orderHash(0, order, 0);
        bytes32 key = bytes32(uint256(1));
        bytes32 root = bytes32(uint256(2));
        (bytes32 ps, bytes32 os) = g.admissionStatements(address(this), 0, hash, key, root, keccak256("test"));
        uint256 id = g.admit(0, hash, "test", key, root, abi.encode(ps, os));
        vm.warp(g.revealOpens(0));
        g.reveal(id, order, 0);
        vm.warp(forkTime);
    }
}
