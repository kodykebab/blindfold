// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BlindfoldVault, IERC20Like} from "../BlindfoldVault.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {IExternalMarket, IERC20Balance} from "../market/IExternalMarket.sol";
import {IGlobalAdmission} from "./IGlobalAdmission.sol";

/// @notice Versioned configurationSealed multi-token batches with one vault operator and atomic settlement.
/// @dev Prices are raw base-token units per token, scaled by Q96. Registry freezes before admission.
contract GlobalAuction {
    uint256 public constant Q96 = 1 << 96;
    uint256 public constant ONE = type(uint128).max;
    uint256 public constant MAX_ORDERS = 64;
    uint256 public constant MAX_TOKENS = 8;
    uint256 public constant GENESIS = 1692803367;
    bytes32 public constant ORDER_DOMAIN = keccak256("blindfold.global.order.v1");
    bytes32 public constant ONLINE_DOMAIN = keccak256("blindfold.global.online.v1");
    bytes32 public constant PREPARED_DOMAIN = keccak256("blindfold.prepared-key.v1");
    // Same canonical quicknet identity as the preparation circuit.
    bytes32 public immutable drandIdentity;

    struct OnlineStatement {
        bytes32 domain;
        bytes32 preparation;
        bytes32 registry;
        uint256 step;
        bytes32 previous;
        bytes32 root;
        uint256[8] budget;
        bytes32 order;
        bytes32 ciphertext;
    }

    struct Order {
        address owner;
        uint8 tokenIn;
        uint8 tokenOut;
        uint128 amountIn;
        uint128 minAmountOut;
    }

    struct Config {
        BlindfoldVault vault;
        IGlobalAdmission verifier;
        address[] tokens;
        uint64 start;
        uint32 batchLength;
        uint32 revealLength;
        uint32 settleLength;
        uint128 depositAmount;
        uint128 commitFee;
        uint16 bountyBps;
        address treasury;
        bytes32 drandIdentity;
    }
    enum Status {
        None,
        Committed,
        Revealed,
        Closed
    }

    struct Commitment {
        address owner;
        uint64 batch;
        bytes32 hash;
        Status status;
    }

    struct Funding {
        uint64 batch;
        uint8 step;
        bytes32 root;
        uint64 open;
    }

    struct Route {
        uint8 input;
        uint8 output;
        uint8 market;
        uint128 amount;
        uint128 minimum;
    }

    struct Totals {
        uint256[8] incoming;
        uint256[8] owed;
        uint256[] inputs;
        uint256[] outputs;
    }

    error ConfigError();
    error Unauthorized();
    error Window();
    error InvalidProof();
    error InvalidOrder();
    error State();
    error Allocation();
    error Insolvent(uint256 token);
    error Transfer();
    error Reentrant();
    event Admitted(
        uint256 indexed id, uint64 indexed batch, address indexed owner, bytes32 hash, uint64 round, bytes ciphertext
    );
    event Revealed(uint256 indexed id, Order order);
    event Closed(uint256 indexed id, bool slashed);
    event Filled(uint64 indexed batch, uint256 indexed id, uint256 input, uint256 output);
    event Rebate(uint64 indexed batch, address indexed owner, uint8 indexed token, uint256 amount);
    event Settled(uint64 indexed batch, bytes32 pricesHash, uint256 fillCount);
    event Expired(uint64 indexed batch);
    event MarketAdded(uint256 indexed index, address indexed market);
    event ConfigurationSealed(bytes32 registryHash);

    BlindfoldVault public immutable vault;
    IGlobalAdmission public immutable verifier;
    address public immutable admin;
    address public immutable treasury;
    uint64 public immutable start;
    uint32 public immutable batchLength;
    uint32 public immutable revealLength;
    uint32 public immutable settleLength;
    uint128 public immutable depositAmount;
    uint128 public immutable commitFee;
    uint16 public immutable bountyBps;
    address[] public tokens;
    bytes32 public immutable registryHash;
    IExternalMarket[8] public oracles;
    IExternalMarket[] public markets;
    bool public configurationSealed;
    uint256 private entered;
    uint256 public commitCount;
    mapping(uint256 => Commitment) public commitments;
    mapping(uint256 => Order) public orders;
    mapping(address => Funding) public funding;
    mapping(uint64 => uint256[]) private ids;
    mapping(uint64 => bool) public finalized;

    modifier guarded() {
        if (entered != 0) revert Reentrant();
        entered = 1;
        _;
        entered = 0;
    }

    constructor(Config memory c) {
        if (
            address(c.vault).code.length == 0 || address(c.verifier).code.length == 0 || c.treasury == address(0)
                || c.tokens.length < 2 || c.tokens.length > 8 || c.start < block.timestamp || c.start < GENESIS
                || c.batchLength < 3 || c.batchLength % 3 != 0 || (c.start - GENESIS) % 3 != 0 || c.revealLength == 0
                || c.settleLength == 0 || c.settleLength > c.batchLength || c.bountyBps > 10000
                || c.drandIdentity == bytes32(0)
        ) revert ConfigError();
        for (uint256 i; i < c.tokens.length; i++) {
            if (c.tokens[i].code.length == 0 || (i != 0 && c.tokens[i - 1] >= c.tokens[i])) revert ConfigError();
            tokens.push(c.tokens[i]);
        }
        vault = c.vault;
        verifier = c.verifier;
        admin = msg.sender;
        treasury = c.treasury;
        start = c.start;
        batchLength = c.batchLength;
        revealLength = c.revealLength;
        settleLength = c.settleLength;
        depositAmount = c.depositAmount;
        commitFee = c.commitFee;
        bountyBps = c.bountyBps;
        drandIdentity = c.drandIdentity;
        address[8] memory padded;
        for (uint256 i; i < c.tokens.length; i++) {
            padded[i] = c.tokens[i];
        }
        registryHash = keccak256(abi.encode(padded));
    }

    /// @notice Add an immutable authenticated adapter; index 0 token is the price numeraire.
    function addMarket(IExternalMarket m, bool priceOracle) external {
        if (msg.sender != admin || configurationSealed || markets.length >= 64 || m.settlement() != address(this)) {
            revert ConfigError();
        }
        uint256 a = _index(m.token0());
        uint256 b = _index(m.token1());
        if (a >= b || m.maxDeviationBps() > 1000) revert ConfigError();
        for (uint256 i; i < markets.length; i++) {
            if (address(markets[i]) == address(m)) revert ConfigError();
        }
        if (priceOracle) {
            if (a != 0 || address(oracles[b]) != address(0)) revert ConfigError();
            oracles[b] = m;
        }
        markets.push(m);
        emit MarketAdded(markets.length - 1, address(m));
    }

    function sealConfiguration() external {
        if (msg.sender != admin || configurationSealed || vault.operator() != address(this)) revert ConfigError();
        for (uint256 i = 1; i < tokens.length; i++) {
            if (address(oracles[i]) == address(0)) revert ConfigError();
        }
        configurationSealed = true;
        emit ConfigurationSealed(registryHash);
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    function commitIdsOf(uint64 b) external view returns (uint256[] memory) {
        return ids[b];
    }

    function currentBatch() public view returns (uint64) {
        if (block.timestamp < start) revert Window();
        return uint64((block.timestamp - start) / batchLength);
    }

    function commitsClose(uint64 b) public view returns (uint256) {
        return uint256(start) + (uint256(b) + 1) * batchLength;
    }

    function targetRound(uint64 b) public view returns (uint64) {
        return uint64((commitsClose(b) - GENESIS) / 3 + 3);
    }

    function revealOpens(uint64 b) public view returns (uint256) {
        return GENESIS + (uint256(targetRound(b)) - 1) * 3;
    }

    function revealCloses(uint64 b) public view returns (uint256) {
        return revealOpens(b) + revealLength;
    }

    function settleCloses(uint64 b) public view returns (uint256) {
        return revealCloses(b) + settleLength;
    }

    function orderHash(uint64 b, Order memory o, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(ORDER_DOMAIN, block.chainid, address(this), registryHash, b, o, salt));
    }

    /// @notice Canonical current funding budget, after the next admission's deposit and fee.
    function budgets(address owner) public view returns (uint256[8] memory result) {
        for (uint256 i; i < tokens.length; i++) {
            result[i] = vault.freeBalance(owner, tokens[i]);
        }
        result[0] -= uint256(depositAmount) + commitFee;
    }

    function admissionStatements(
        address owner,
        uint64 b,
        bytes32 hash,
        bytes32 key,
        bytes32 root,
        bytes32 ciphertextHash
    ) public view returns (bytes32 preparation, bytes32 online) {
        Funding memory f = funding[owner];
        if (f.open != 0 && f.batch != b) revert State();
        OnlineStatement memory statement;
        preparation = keccak256(
            abi.encode(PREPARED_DOMAIN, block.chainid, address(this), owner, b, targetRound(b), key, drandIdentity)
        );
        statement.domain = ONLINE_DOMAIN;
        statement.preparation = preparation;
        statement.registry = registryHash;
        statement.step = f.batch == b ? f.step : 0;
        statement.previous = f.batch == b ? f.root : bytes32(0);
        statement.root = root;
        statement.budget = budgets(owner);
        statement.order = hash;
        statement.ciphertext = ciphertextHash;
        online = keccak256(abi.encode(statement));
    }

    /// @notice Admission always verifies encryption and cumulative per-token funding. No unproved commit path exists.
    function admit(uint64 b, bytes32 hash, bytes calldata ciphertext, bytes32 key, bytes32 root, bytes calldata proof)
        external
        guarded
        returns (uint256 id)
    {
        if (
            !configurationSealed || b != currentBatch() || ids[b].length >= MAX_ORDERS || ciphertext.length > 2048
                || root == bytes32(0)
        ) revert State();
        {
            (bytes32 p, bytes32 o) = admissionStatements(msg.sender, b, hash, key, root, keccak256(ciphertext));
            if (!verifier.verify(p, o, proof)) revert InvalidProof();
        }
        Funding storage f = funding[msg.sender];
        if (f.batch != b) {
            f.batch = b;
            f.step = 0;
            f.root = 0;
        }
        if (f.step >= MAX_ORDERS) revert State();
        f.step++;
        f.root = root;
        f.open++;
        vault.transferInternal(msg.sender, address(this), tokens[0], depositAmount);
        vault.transferInternal(msg.sender, treasury, tokens[0], commitFee);
        vault.openCommitment(msg.sender);
        id = commitCount++;
        commitments[id] = Commitment(msg.sender, b, hash, Status.Committed);
        ids[b].push(id);
        emit Admitted(id, b, msg.sender, hash, targetRound(b), ciphertext);
    }

    function reveal(uint256 id, Order calldata o, bytes32 salt) external guarded {
        Commitment storage c = commitments[id];
        if (c.status != Status.Committed) revert State();
        if (block.timestamp < revealOpens(c.batch) || block.timestamp >= revealCloses(c.batch)) revert Window();
        if (
            o.owner != c.owner || o.tokenIn >= tokens.length || o.tokenOut >= tokens.length || o.tokenIn == o.tokenOut
                || o.amountIn == 0 || orderHash(c.batch, o, salt) != c.hash
        ) revert InvalidOrder();
        c.status = Status.Revealed;
        orders[id] = o;
        vault.lock(o.owner, tokens[o.tokenIn], o.amountIn);
        uint256 bounty = uint256(depositAmount) * bountyBps / 10000;
        vault.transferInternal(address(this), msg.sender, tokens[0], bounty);
        vault.transferInternal(address(this), o.owner, tokens[0], depositAmount - bounty);
        emit Revealed(id, o);
    }

    function slashUnrevealed(uint256 id) external guarded {
        _slash(id);
    }

    function _slash(uint256 id) private {
        Commitment storage c = commitments[id];
        if (c.status != Status.Committed || block.timestamp < revealCloses(c.batch)) revert State();
        uint256 bounty = uint256(depositAmount) * bountyBps / 10000;
        vault.transferInternal(address(this), msg.sender, tokens[0], bounty);
        vault.transferInternal(address(this), treasury, tokens[0], depositAmount - bounty);
        _close(id, true);
    }

    function _close(uint256 id, bool slashed) private {
        Commitment storage c = commitments[id];
        c.status = Status.Closed;
        funding[c.owner].open--;
        vault.closeCommitment(c.owner);
        emit Closed(id, slashed);
    }

    /// @notice One historical price vector for the entire batch, including cross-pair cycles.
    function prices(uint64 b) public view returns (uint256[8] memory p) {
        for (uint256 i; i < tokens.length; i++) {
            p[i] = tokenPriceX96(b, uint8(i));
        }
    }

    /// @notice Independently validate one token's reference, allowing unrelated stale markets to be excluded.
    function tokenPriceX96(uint64 b, uint8 token) public view returns (uint256 value) {
        if (token >= tokens.length) revert ConfigError();
        if (token == 0) return Q96;
        uint256 inverse = oracles[token].referencePrice(commitsClose(b));
        if (inverse == 0) revert ConfigError();
        value = FullMath.mulDiv(Q96, Q96, inverse);
        if (value == 0 || value > type(uint128).max) revert ConfigError();
    }

    /// @notice Fractions are in commitment order, including zero for unrevealed/closed entries.
    /// Equal limits share a fraction; filling a worse limit requires a full fraction at better limits.
    function settle(uint64 b, uint128[] calldata fractions, Route[] calldata routes) external guarded {
        _settle(b, prices(b), fractions, routes);
    }

    /// @notice Permit venue fees within immutable oracle bands while preserving a single consistent token-price vector.
    function settleAtPrices(
        uint64 b,
        uint256[8] calldata proposed,
        uint128[] calldata fractions,
        Route[] calldata routes
    ) external guarded {
        if (proposed[0] != Q96) revert Allocation();
        for (uint256 i = 1; i < 8; i++) {
            if (i >= tokens.length) {
                if (proposed[i] != 0) revert Allocation();
                continue;
            }
            if (proposed[i] == 0) continue;
            uint256 baseline = tokenPriceX96(b, uint8(i));
            uint256 band = oracles[i].maxDeviationBps();
            uint256 difference = proposed[i] > baseline ? proposed[i] - baseline : baseline - proposed[i];
            if (
                proposed[i] == 0 || proposed[i] > type(uint128).max
                    || difference > FullMath.mulDiv(baseline, band, 10000)
            ) {
                revert Allocation();
            }
        }
        _settle(b, proposed, fractions, routes);
    }

    function _settle(uint64 b, uint256[8] memory p, uint128[] calldata fractions, Route[] calldata routes) private {
        if (finalized[b] || block.timestamp < revealCloses(b) || block.timestamp >= settleCloses(b)) revert Window();
        if (fractions.length != ids[b].length || routes.length > 64) revert Allocation();
        Totals memory t = _collect(b, fractions, p);
        uint256[8] memory available;
        for (uint256 i; i < 8; i++) {
            available[i] = t.incoming[i];
        }
        for (uint256 i; i < routes.length; i++) {
            _route(routes[i], available, t.owed, b);
        }
        for (uint256 i; i < tokens.length; i++) {
            if (available[i] < t.owed[i]) revert Insolvent(i);
        }
        finalized[b] = true;
        _pay(b, t, available);
        emit Settled(b, keccak256(abi.encode(p)), _fillCount(t.inputs));
    }

    function _collect(uint64 b, uint128[] calldata fractions, uint256[8] memory p) private returns (Totals memory t) {
        uint256[] storage list = ids[b];
        t.inputs = new uint256[](list.length);
        t.outputs = new uint256[](list.length);
        for (uint256 i; i < list.length; i++) {
            uint256 id = list[i];
            Order memory o = orders[id];
            if (fractions[i] > ONE || (commitments[id].status != Status.Revealed && fractions[i] != 0)) {
                revert Allocation();
            }
            if (commitments[id].status != Status.Revealed) continue;
            _priority(b, i, fractions, p);
            if (p[o.tokenIn] == 0 || p[o.tokenOut] == 0) {
                vault.unlock(o.owner, tokens[o.tokenIn], o.amountIn);
                continue;
            }
            uint256 amount = FullMath.mulDiv(o.amountIn, fractions[i], ONE);
            uint256 out = FullMath.mulDiv(amount, p[o.tokenIn], p[o.tokenOut]);
            if (out < FullMath.mulDivRoundingUp(o.minAmountOut, amount, o.amountIn)) {
                uint256 lot = _lot(o.amountIn, o.minAmountOut);
                amount = amount / lot * lot;
                out = FullMath.mulDiv(amount, p[o.tokenIn], p[o.tokenOut]);
            }
            if (out == 0) amount = 0;
            if (out < FullMath.mulDivRoundingUp(o.minAmountOut, amount, o.amountIn)) revert Allocation();
            t.inputs[i] = amount;
            t.outputs[i] = out;
            t.incoming[o.tokenIn] += amount;
            t.owed[o.tokenOut] += out;
            vault.unlock(o.owner, tokens[o.tokenIn], o.amountIn);
            vault.transferInternal(o.owner, address(this), tokens[o.tokenIn], amount);
        }
        if (_fillCount(t.inputs) == 0) revert Allocation();
    }

    function _priority(uint64 b, uint256 i, uint128[] calldata f, uint256[8] memory p) private view {
        Order memory a = orders[ids[b][i]];
        if (p[a.tokenIn] == 0 || p[a.tokenOut] == 0) {
            if (f[i] != 0) revert Allocation();
            return;
        }
        bool eligible = FullMath.mulDiv(a.amountIn, p[a.tokenIn], p[a.tokenOut]) >= a.minAmountOut;
        if (!eligible && f[i] != 0) revert Allocation();
        for (uint256 j; j < i; j++) {
            if (commitments[ids[b][j]].status != Status.Revealed) continue;
            Order memory z = orders[ids[b][j]];
            if (a.tokenIn != z.tokenIn || a.tokenOut != z.tokenOut) continue;
            uint256 x = uint256(a.minAmountOut) * z.amountIn;
            uint256 y = uint256(z.minAmountOut) * a.amountIn;
            if ((x == y && f[i] != f[j]) || (x > y && f[i] != 0 && f[j] != ONE) || (x < y && f[j] != 0 && f[i] != ONE))
            {
                revert Allocation();
            }
        }
    }

    function _route(Route calldata r, uint256[8] memory available, uint256[8] memory owed, uint64 b) private {
        if (
            r.input >= tokens.length || r.output >= tokens.length || r.input == r.output || r.market >= markets.length
                || r.amount == 0 || r.minimum == 0 || available[r.input] < owed[r.input]
                || r.amount > available[r.input] - owed[r.input] || available[r.output] >= owed[r.output]
        ) revert Allocation();
        IExternalMarket m = markets[r.market];
        bool forward = tokens[r.input] == m.token0();
        if (
            tokens[r.input] != (forward ? m.token0() : m.token1())
                || tokens[r.output] != (forward ? m.token1() : m.token0())
        ) {
            revert Allocation();
        }
        m.referencePrice(commitsClose(b)); // health of every execution path, not only numeraire oracles
        uint256 beforeMarket = IERC20Balance(tokens[r.input]).balanceOf(address(m));
        uint256 beforeOut = IERC20Balance(tokens[r.output]).balanceOf(address(this));
        vault.operatorPull(tokens[r.input], r.amount, address(m));
        if (IERC20Balance(tokens[r.input]).balanceOf(address(m)) - beforeMarket != r.amount) revert Transfer();
        uint256 out = m.swap(forward, r.amount, r.minimum);
        if (out < r.minimum || IERC20Balance(tokens[r.output]).balanceOf(address(this)) - beforeOut != out) {
            revert Transfer();
        }
        _approve(tokens[r.output], out);
        vault.operatorPush(tokens[r.output], out);
        _approve(tokens[r.output], 0);
        available[r.input] -= r.amount;
        available[r.output] += out;
    }

    function _pay(uint64 b, Totals memory t, uint256[8] memory available) private {
        uint256[] storage list = ids[b];
        for (uint256 i; i < list.length; i++) {
            uint256 id = list[i];
            if (commitments[id].status != Status.Revealed) continue;
            Order memory o = orders[id];
            vault.transferInternal(address(this), o.owner, tokens[o.tokenOut], t.outputs[i]);
            emit Filled(b, id, t.inputs[i], t.outputs[i]);
            _close(id, false);
        }
        // Return each token's surplus to contributors of that token; cumulative division conserves every unit.
        for (uint256 k; k < tokens.length; k++) {
            uint256 surplus = available[k] - t.owed[k];
            if (surplus == 0) continue;
            // A routed token can have no input contributors. Its output recipients then own its surplus.
            bool input = t.incoming[k] != 0;
            uint256 total = input ? t.incoming[k] : t.owed[k];
            uint256 cumulative;
            uint256 paid;
            for (uint256 i; i < list.length; i++) {
                Order memory o = orders[list[i]];
                uint256 weight = input ? (o.tokenIn == k ? t.inputs[i] : 0) : (o.tokenOut == k ? t.outputs[i] : 0);
                if (weight == 0) continue;
                cumulative += weight;
                uint256 next = FullMath.mulDiv(surplus, cumulative, total);
                vault.transferInternal(address(this), o.owner, tokens[k], next - paid);
                emit Rebate(b, o.owner, uint8(k), next - paid);
                paid = next;
            }
            if (paid != surplus) revert Insolvent(k);
        }
    }

    /// @notice Permissionless bounded cleanup, including unrevealed commitments and all remaining locks.
    function expire(uint64 b) external guarded {
        if (finalized[b] || block.timestamp < settleCloses(b)) revert Window();
        finalized[b] = true;
        for (uint256 i; i < ids[b].length; i++) {
            uint256 id = ids[b][i];
            if (commitments[id].status == Status.Committed) {
                _slash(id);
            } else if (commitments[id].status == Status.Revealed) {
                Order memory o = orders[id];
                vault.unlock(o.owner, tokens[o.tokenIn], o.amountIn);
                _close(id, false);
            }
        }
        emit Expired(b);
    }

    function _approve(address token, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20Like.approve, (address(vault), amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert Transfer();
    }

    function _index(address token) private view returns (uint256) {
        for (uint256 i; i < tokens.length; i++) {
            if (tokens[i] == token) return i;
        }
        revert ConfigError();
    }

    function _lot(uint256 a, uint256 b) private pure returns (uint256) {
        if (b == 0) return 1;
        uint256 original = a;
        while (b != 0) {
            uint256 next = a % b;
            a = b;
            b = next;
        }
        return original / a;
    }

    function _fillCount(uint256[] memory amounts) private pure returns (uint256 count) {
        for (uint256 i; i < amounts.length; i++) {
            if (amounts[i] != 0) count++;
        }
    }
}
