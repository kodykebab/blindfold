// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {BatchAuction} from "../src/BatchAuction.sol";
import {BlindfoldVault} from "../src/BlindfoldVault.sol";
import {BlindfoldSettlement} from "../src/BlindfoldSettlement.sol";
import {SealedPoolHook} from "../src/SealedPoolHook.sol";
import {AdmissionVault} from "../src/admission/AdmissionVault.sol";
import {AquaAdmittedSettlement} from "../src/admission/AquaAdmittedSettlement.sol";
import {AdmittedSettlement} from "../src/admission/AdmittedSettlement.sol";
import {IExternalMarket, IV3Factory, IV3Pool} from "../src/market/IExternalMarket.sol";
import {UniswapV3Market} from "../src/market/UniswapV3Market.sol";
import {SealedPoolHookFactory} from "../src/SealedPoolHookFactory.sol";
import {MockExternalMarket} from "../test/utils/MockExternalMarket.sol";

/// @notice Deploys a Blindfold trading deployment and writes deployments/blindfold.local.json, the file the client,
///         keeper, solver and DeployCourt read (PLAN.md seams). Then it checks every relationship a constructor
///         can't (REVIEW S18): it reverts, writing nothing, if any check fails.
///
///         Defaults (FIXES.md fix 7, from the order-flow replay): 120 s batches (60 s needs a prepared key for every
///         order: an inline proof alone can't fit), a settle window equal to the batch, the market's maxDelay equal
///         to the settle window (fix 3), no latest-trade activity check (fix 1), a 600 s reference window and a
///         100 bps deviation band.
///
///         Local, on a plain anvil (mock tokens, its own PoolManager, a mock market quoting 1:1):
///           forge script script/DeployBlindfold.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
///         Real tokens and a public v3 pool (e.g. an Ethereum fork):
///           TOKEN0=… TOKEN1=… POOL_MANAGER=… MARKET=v3 V3_FACTORY=… V3_POOL=… forge script … --broadcast
///         Proof-enforced admission: ADMISSION=on PREPARATION_VERIFIER=… ONLINE_VERIFIER=… ADMISSION_MANIFEST_SHA256=…
///         Every other parameter has an env override; see _config. DEPLOYMENTS_OUT changes the output file.
contract DeployBlindfold is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    string constant ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
    uint256 constant DRAND_GENESIS = 1692803367;
    uint256 constant Q96 = 1 << 96;

    struct Deployment {
        bool admitted;
        address token0;
        address token1;
        IPoolManager manager;
        BlindfoldVault vault;
        BlindfoldSettlement settlement;
        SealedPoolHook hook;
        PoolKey key;
        IExternalMarket market;
        string marketKind;
        address preparationVerifier;
        address onlineVerifier;
        address aquaRoute;
    }

    /// @notice Every deployment setting, so tests can pass them directly; `params()` reads them from the environment.
    struct Params {
        bool admitted;
        address token0; // 0: deploy mock tokens
        address token1;
        address manager; // 0: deploy a PoolManager
        address depositToken; // 0: token1
        uint256 depositAmount;
        uint256 bountyBps;
        address treasury; // 0: the deployer
        uint256 commitFee;
        uint256 start; // aligned up to a drand round
        uint32 batchLength;
        uint32 revealLength;
        uint32 settleLength; // 0: the batch length
        uint256 toleranceBps;
        uint24 poolFee;
        int24 tickSpacing;
        uint160 sqrtPriceX96;
        string marketKind; // none | mock | v3
        address v3Factory;
        address v3Pool;
        uint32 referenceWindow;
        uint32 maxDelay; // 0: the settle window
        uint32 maxObservationAge;
        uint128 minHarmonicLiquidity;
        uint256 maxDeviationBps;
        address preparationVerifier;
        address onlineVerifier;
        address aquaRoute;
    }

    function run() external returns (Deployment memory d) {
        uint256 deployerKey = vm.envOr("DEPLOYER_KEY", vm.deriveKey(vm.envOr("MNEMONIC", ANVIL_MNEMONIC), 0));
        Params memory p = params();
        vm.startBroadcast(deployerKey);
        d = deploy(p, vm.addr(deployerKey));
        vm.stopBroadcast();
        check(d);
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            _write(d);
        }
    }

    /// @notice The environment's settings, with the defaults documented above.
    function params() public view returns (Params memory p) {
        p.aquaRoute = vm.envOr("AQUA_ROUTE", address(0));
        p.admitted = keccak256(bytes(vm.envOr("ADMISSION", string("off")))) == keccak256("on");
        p.token0 = vm.envOr("TOKEN0", address(0));
        p.token1 = vm.envOr("TOKEN1", address(0));
        p.manager = vm.envOr("POOL_MANAGER", address(0));
        p.depositToken = vm.envOr("DEPOSIT_TOKEN", address(0));
        p.depositAmount = vm.envOr("DEPOSIT_AMOUNT", uint256(5e18));
        p.bountyBps = vm.envOr("BOUNTY_BPS", uint256(2000));
        p.treasury = vm.envOr("TREASURY", address(0));
        p.commitFee = vm.envOr("COMMIT_FEE", uint256(1e17));
        p.start = vm.envOr("START", block.timestamp + 3);
        p.batchLength = uint32(vm.envOr("BATCH_LENGTH", uint256(120)));
        p.revealLength = uint32(vm.envOr("REVEAL_LENGTH", uint256(24)));
        p.settleLength = uint32(vm.envOr("SETTLE_LENGTH", uint256(0)));
        p.toleranceBps = vm.envOr("TOLERANCE_BPS", uint256(100));
        p.poolFee = uint24(vm.envOr("POOL_FEE", uint256(3000)));
        p.tickSpacing = int24(int256(vm.envOr("TICK_SPACING", uint256(60))));
        p.sqrtPriceX96 = uint160(vm.envOr("SQRT_PRICE_X96", Q96));
        p.v3Factory = vm.envOr("V3_FACTORY", address(0));
        p.v3Pool = vm.envOr("V3_POOL", address(0));
        p.marketKind = vm.envOr("MARKET", string(p.v3Pool == address(0) ? bytes("mock") : bytes("v3")));
        p.referenceWindow = uint32(vm.envOr("REFERENCE_WINDOW", uint256(600)));
        p.maxDelay = uint32(vm.envOr("MAX_DELAY", uint256(0)));
        p.maxObservationAge = uint32(vm.envOr("MAX_OBSERVATION_AGE", uint256(0)));
        p.minHarmonicLiquidity = uint128(vm.envOr("MIN_HARMONIC_LIQUIDITY", uint256(1e15)));
        p.maxDeviationBps = vm.envOr("MAX_DEVIATION_BPS", uint256(100));
        p.preparationVerifier = vm.envOr("PREPARATION_VERIFIER", address(0));
        p.onlineVerifier = vm.envOr("ONLINE_VERIFIER", address(0));
    }

    function deploy(Params memory p, address deployer) public returns (Deployment memory d) {
        if (p.aquaRoute != address(0)) {
            require(
                p.admitted && keccak256(bytes(p.marketKind)) == keccak256("none"),
                "Aqua requires ADMISSION=on and MARKET=none"
            );
        }
        d.aquaRoute = p.aquaRoute;
        d.admitted = p.admitted;
        (d.token0, d.token1) = _tokens(p);
        d.manager = p.manager == address(0) ? IPoolManager(address(new PoolManager(deployer))) : IPoolManager(p.manager);
        d.vault = d.admitted ? BlindfoldVault(new AdmissionVault(d.token0, d.token1)) : new BlindfoldVault();
        BlindfoldSettlement.Config memory c = _config(p, d, deployer);
        if (d.admitted) {
            require(
                p.preparationVerifier != address(0) && p.onlineVerifier != address(0),
                "admission needs both verifier addresses"
            );
            (d.preparationVerifier, d.onlineVerifier) = (p.preparationVerifier, p.onlineVerifier);
            d.settlement = p.aquaRoute == address(0)
                ? new AdmittedSettlement(c, d.preparationVerifier, d.onlineVerifier)
                : new AquaAdmittedSettlement(c, d.preparationVerifier, d.onlineVerifier, p.aquaRoute);
        } else {
            d.settlement = new BlindfoldSettlement(c);
        }
        d.vault.setOperator(address(d.settlement));
        // The hook's address encodes its permissions, so it is mined against the settlement it serves (AGENTS.md #3).
        // An explicit factory makes the CREATE2 deployer the same in tests, simulation and broadcast.
        d.hook = _mineHook(address(d.manager), address(d.settlement));
        d.key = PoolKey(
            Currency.wrap(d.token0), Currency.wrap(d.token1), p.poolFee, p.tickSpacing, IHooks(address(d.hook))
        );
        (uint160 price,,,) = d.manager.getSlot0(d.key.toId());
        if (price == 0) d.manager.initialize(d.key, p.sqrtPriceX96);
        d.settlement.initialize(d.key);
        (d.market, d.marketKind) = _market(p, d);
        if (address(d.market) != address(0)) d.settlement.configureExternal(d.market);
    }

    function _mineHook(address manager, address settlement) internal returns (SealedPoolHook) {
        SealedPoolHookFactory factory = new SealedPoolHookFactory();
        bytes32 codeHash = factory.initCodeHash(manager, settlement);
        for (uint256 salt; salt < 500_000; salt++) {
            address a = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(factory), bytes32(salt), codeHash))))
            );
            if (uint160(a) & Hooks.ALL_HOOK_MASK == Hooks.BEFORE_SWAP_FLAG) {
                address hook = factory.deploy(manager, settlement, bytes32(salt));
                require(hook == a, "hook deployed at an unexpected address");
                return SealedPoolHook(hook);
            }
        }
        revert("no hook salt found");
    }

    function _tokens(Params memory p) internal returns (address a, address b) {
        (a, b) = (p.token0, p.token1);
        if (a == address(0) || b == address(0)) {
            a = address(new MockERC20("Token A", "TKA", 18));
            b = address(new MockERC20("Token B", "TKB", 18));
        }
        if (a > b) (a, b) = (b, a);
    }

    function _config(Params memory p, Deployment memory d, address deployer)
        internal
        pure
        returns (BlindfoldSettlement.Config memory c)
    {
        // Start on a drand round boundary (MisalignedSchedule otherwise).
        uint256 at = p.start + (3 - (p.start - DRAND_GENESIS) % 3) % 3;
        c = BlindfoldSettlement.Config({
            manager: d.manager,
            vault: d.vault,
            depositToken: p.depositToken == address(0) ? d.token1 : p.depositToken,
            depositAmount: p.depositAmount,
            bountyBps: p.bountyBps,
            treasury: p.treasury == address(0) ? deployer : p.treasury,
            commitFee: p.commitFee,
            schedule: BatchAuction.Schedule({
                start: uint64(at),
                batchLength: p.batchLength,
                revealLength: p.revealLength,
                settleLength: p.settleLength == 0 ? p.batchLength : p.settleLength
            }),
            toleranceBps: p.toleranceBps
        });
    }

    function _market(Params memory p, Deployment memory d)
        internal
        returns (IExternalMarket market, string memory kind)
    {
        kind = p.marketKind;
        bytes32 k = keccak256(bytes(kind));
        if (k == keccak256("none")) return (IExternalMarket(address(0)), kind);
        if (k == keccak256("mock")) return (new MockExternalMarket(address(d.settlement), d.token0, d.token1), kind);
        require(k == keccak256("v3"), "MARKET must be none, mock or v3");
        market = new UniswapV3Market(
            address(d.settlement),
            IV3Factory(p.v3Factory),
            IV3Pool(p.v3Pool),
            p.referenceWindow,
            p.maxDelay == 0 ? d.settlement.settleLength() : p.maxDelay,
            p.maxObservationAge,
            p.minHarmonicLiquidity,
            p.maxDeviationBps
        );
    }

    /// @notice Relationships a constructor can't establish (REVIEW S18). Reverts with the first that fails.
    function check(Deployment memory d) public view {
        BlindfoldSettlement s = d.settlement;
        require(d.vault.operator() == address(s), "vault operator is not the settlement");
        require(s.token0() == d.token0 && s.token1() == d.token1, "settlement pair differs from the pool key");
        require(s.depositToken() == d.token0 || s.depositToken() == d.token1, "deposit token is not in the pair");
        // the hook gates swaps to this settlement only, on this manager, with exactly the beforeSwap permission
        require(
            uint160(address(d.hook)) & Hooks.ALL_HOOK_MASK == Hooks.BEFORE_SWAP_FLAG,
            "hook address has the wrong permissions"
        );
        require(
            d.hook.settlement() == address(s) && d.hook.manager() == address(d.manager),
            "hook is bound to another settlement or manager"
        );
        require(address(s.poolKey().hooks) == address(d.hook), "pool key does not use the sealed hook");
        (uint160 price,,,) = d.manager.getSlot0(d.key.toId());
        require(price != 0, "pool is not initialized");
        require(s.settleLength() <= s.batchLength(), "settle window longer than a batch");
        if (d.aquaRoute != address(0)) {
            require(address(s).code.length <= 24_576, "Aqua settlement exceeds EIP-170");
            require(AquaAdmittedSettlement(address(s)).aquaRoute() == d.aquaRoute, "wrong Aqua route");
            require(address(d.market) == address(0), "Aqua uses the sealed-pool price check");
        }
        if (address(d.market) == address(0)) return;
        require(address(s.externalMarket()) == address(d.market), "settlement does not use the market");
        require(d.market.settlement() == address(s), "market serves another settlement");
        require(
            d.market.token0() == d.token0 && d.market.token1() == d.token1, "market pair differs from the settlement"
        );
        if (keccak256(bytes(d.marketKind)) == keccak256("v3")) {
            // fix 3: a reference older than maxDelay can't settle, so the market must cover the whole settle window
            require(
                UniswapV3Market(address(d.market)).maxDelay() >= s.settleLength(),
                "market maxDelay is shorter than the settle window"
            );
        }
    }

    function _write(Deployment memory d) internal {
        string memory k = "blindfold";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", block.number);
        vm.serializeString(k, "mode", d.admitted ? "admitted" : "local");
        if (d.aquaRoute != address(0)) vm.serializeAddress(k, "aquaRoute", d.aquaRoute);
        vm.serializeAddress(k, "vault", address(d.vault));
        vm.serializeAddress(k, "settlement", address(d.settlement));
        vm.serializeAddress(k, "token0", d.token0);
        vm.serializeAddress(k, "token1", d.token1);
        vm.serializeAddress(k, "depositToken", d.settlement.depositToken());
        vm.serializeAddress(k, "poolManager", address(d.manager));
        vm.serializeAddress(k, "hook", address(d.hook));
        vm.serializeAddress(k, "market", address(d.market));
        vm.serializeString(k, "marketKind", d.marketKind);
        vm.serializeUint(k, "start", d.settlement.start());
        vm.serializeUint(k, "batchLength", d.settlement.batchLength());
        vm.serializeUint(k, "settleLength", d.settlement.settleLength());
        string memory json;
        if (d.admitted) {
            string memory a = "admission";
            vm.serializeString(a, "manifestSha256", vm.envString("ADMISSION_MANIFEST_SHA256"));
            vm.serializeAddress(a, "preparationVerifier", d.preparationVerifier);
            json = vm.serializeString(k, "admission", vm.serializeAddress(a, "onlineVerifier", d.onlineVerifier));
        } else {
            json = vm.serializeString(k, "admission", "off");
        }
        string memory out =
            vm.envOr("DEPLOYMENTS_OUT", string.concat(vm.projectRoot(), "/../deployments/blindfold.local.json"));
        vm.writeJson(json, out);
    }
}
