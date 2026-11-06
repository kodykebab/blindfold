// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SandwichCourtVerifier} from "./SandwichCourtVerifier.sol";
import {RLPReader} from "./lib/RLPReader.sol";

uint256 constant FEE_UNITS = 1e6; // Uniswap fees are in hundredths of a bip
uint256 constant MAX_BUDGET = type(uint128).max; // wei; more than all ETH there is (S17)

/// @notice An incident's budget (R8, S17): the attacker's profit, capped by the swap fee its front leg paid
///         (`frontIn * fee / 1e6`, rounded down) and by `MAX_BUDGET`. Exact and overflow-free for any inputs with
///         `fee <= 1e6`. The `MAX_BUDGET` cap keeps `budget * weight` and the sum of an incident's weights in range.
function feeCappedBudget(uint256 profit, uint256 frontIn, uint24 fee) pure returns (uint256 budget) {
    // frontIn * fee / 1e6 without overflow: with frontIn = q * 1e6 + r, it is q * fee + r * fee / 1e6
    uint256 cap = (frontIn / FEE_UNITS) * fee + ((frontIn % FEE_UNITS) * fee) / FEE_UNITS;
    budget = profit < cap ? profit : cap;
    if (budget > MAX_BUDGET) budget = MAX_BUDGET;
}

/// @title BondRegistry
/// @notice A protected RPC bonds ETH here and signs an EIP-712 `Protected` receipt for every tx it accepts, before
///         that tx runs. The receipt names who gets paid (S15) and the most the RPC will pay (`maxPayout`).
///         Insured event: the receipted tx is proven to be the victim of a sandwich (SandwichCourtVerifier) in a
///         canonical Uniswap pool, landed by `maxBlock`, with the attacker's profit in ETH or WETH. That proves a
///         sandwich-shaped sequence and the attacker's profit; it does not prove the RPC leaked the tx, nor how
///         much the victim lost, so coverage is capped and profit-based rather than a loss refund.
///         Payouts per incident (S14): every claim against the same front-run (chain, block, pool, front tx and
///         its Swap log) shares one budget, whichever back leg it cites. The first claim opens a `claimWindow`;
///         claims made in it reserve their share from their RPC's bond; after it closes each claim collects
///         `budget * weight / totalWeight` (or its whole weight if the weights fit the budget), where
///         `weight = min(maxPayout, budget)`. Unclaimed coverage stays in the bond.
///         Self-sandwiches (R8): Court can't tell a leak from someone sandwiching their own tx, so a payout must never
///         be worth faking. The budget is `min(profit, frontIn * fee / 1e6)`: the attacker's profit, capped by the
///         swap fee its front leg paid. Reaching the same holdings through front, victim and back costs at least
///         the fees of the extra legs more than one direct trade would (pool state is path-independent; fees leave
///         the curve), so a coalition playing both sides loses at least what the back leg's fee and gas cost. This
///         holds only where the coalition does not earn the fees back, so:
///         - only pools the deployer lists in `Config.pools` are covered (anyone can create a pool and be its only
///           LP), with a static fee; zero-fee pools have no budget and their claims revert;
///         - an incident is one front swap paired with one back swap, neither reused by another incident, so
///           pairing legs differently can't count a fee twice;
///         - out of scope: a coalition that provides most of a listed pool's in-range liquidity (JIT) and so
///           recovers most of the fees. `maxPayout` and the bond bound what that can take.
///         - Profit is valued 1:1 only when it is in ETH or WETH; claims for other profit tokens revert unpaid.
///         - Pools are pinned: v3 pools must come from the canonical factory, v4 from the canonical PoolManager.
///         One registry judges one source chain: its own chain via BLOCKHASH/EIP-2935, or Ethereum through
///         the verifier's L1 anchor when deployed on an OP-stack L2.
contract BondRegistry {
    struct Protected {
        bytes32 txHash;
        uint256 chainId; // chain the protected tx runs on
        uint64 acceptedAt; // unix seconds; must not be after the sandwich block (coverage precedes the event)
        uint64 maxBlock; // the tx must land by this block
        uint256 maxPayout; // wei
        address beneficiary; // who is paid; not inferred from the tx signer (smart wallets, relayers)
    }

    struct Config {
        SandwichCourtVerifier verifier;
        uint256 sourceChainId;
        address weth; // source chain's WETH; native ETH (v4 currency address(0)) also counts
        address v3Factory;
        bytes32 v3InitCodeHash;
        address v4PoolManager;
        uint256 unbondDelay;
        uint256 claimWindow;
        bytes32[] pools; // covered pools: a v3 pool's address (left-padded) or a v4 PoolId
    }

    struct Incident {
        uint256 budget; // min(profit, front leg's fee), shared by every claim on this incident
        uint256 totalWeight;
        uint64 closesAt; // claims accepted before, collected from
    }

    struct Claim {
        bytes32 incident;
        address rpc;
        address beneficiary;
        uint256 weight; // min(maxPayout, budget): the claim's share key and its cap
        uint256 reserved; // held from the RPC's bond until collected
        bool collected;
    }

    bytes32 public constant PROTECTED_TYPEHASH = keccak256(
        "Protected(bytes32 txHash,uint256 chainId,uint64 acceptedAt,uint64 maxBlock,uint256 maxPayout,address beneficiary)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    error AlreadyClaimed(bytes32 txHash);
    error NoBeneficiary();
    error WrongChain();
    error NotReceipted();
    error TooLate(uint256 blockNumber, uint256 maxBlock);
    error IssuedAfterIncident(uint256 acceptedAt, uint256 blockTimestamp);
    error UnknownPool();
    error UnsupportedPool();
    error ZeroBudget();
    error BackLegReused();
    error UnvaluedProfit(address token);
    error BadSignature();
    error NoBond(address rpc);
    error ClaimWindowClosed(bytes32 incident, uint256 closedAt);
    error ClaimWindowOpen(uint256 closesAt);
    error UnknownClaim(bytes32 txHash);
    error AlreadyCollected(bytes32 txHash);
    error UnbondNotReady(uint256 at);
    error TransferFailed();

    event Bonded(address indexed rpc, uint256 amount, uint256 total);
    event UnbondRequested(address indexed rpc, uint256 at);
    event Unbonded(address indexed rpc, uint256 amount);
    event IncidentOpened(bytes32 indexed incident, uint256 budget, uint64 closesAt);
    event ClaimRegistered(
        bytes32 indexed incident,
        bytes32 indexed txHash,
        address indexed rpc,
        address beneficiary,
        uint256 weight,
        uint256 reserved,
        uint256 gasRefund
    );
    event Collected(bytes32 indexed incident, bytes32 indexed txHash, address indexed beneficiary, uint256 payout);

    SandwichCourtVerifier public immutable verifier;
    uint256 public immutable sourceChainId;
    address public immutable weth;
    address public immutable v3Factory;
    bytes32 public immutable v3InitCodeHash;
    address public immutable v4PoolManager;
    uint256 public immutable unbondDelay;
    uint256 public immutable claimWindow;

    mapping(address rpc => uint256) public bondOf;
    mapping(address rpc => uint256) public reservedOf;
    mapping(address rpc => uint256) public unbondAt;
    mapping(bytes32 incident => Incident) public incidents;
    mapping(bytes32 txHash => Claim) public claims;
    mapping(bytes32 pool => bool) public covered;
    mapping(bytes32 backSwap => bool) public backUsed; // pool, pool id, back tx and its Swap log

    constructor(Config memory c) {
        verifier = c.verifier;
        sourceChainId = c.sourceChainId;
        weth = c.weth;
        v3Factory = c.v3Factory;
        v3InitCodeHash = c.v3InitCodeHash;
        v4PoolManager = c.v4PoolManager;
        unbondDelay = c.unbondDelay;
        claimWindow = c.claimWindow;
        for (uint256 i; i < c.pools.length; i++) {
            covered[c.pools[i]] = true;
        }
    }

    // ---- bonds

    /// @notice Add to the caller's bond. The caller is the address that signs receipts.
    function bond() external payable {
        bondOf[msg.sender] += msg.value;
        emit Bonded(msg.sender, msg.value, bondOf[msg.sender]);
    }

    /// @notice Start the withdrawal delay. The bond stays claimable until `unbond`.
    function requestUnbond() external {
        uint256 at = block.timestamp + unbondDelay;
        unbondAt[msg.sender] = at;
        emit UnbondRequested(msg.sender, at);
    }

    /// @notice Withdraw the bond once the delay has passed, except what open claims have reserved.
    function unbond() external {
        uint256 at = unbondAt[msg.sender];
        if (at == 0 || block.timestamp < at) revert UnbondNotReady(at);
        uint256 amount = bondOf[msg.sender] - reservedOf[msg.sender];
        bondOf[msg.sender] -= amount;
        unbondAt[msg.sender] = 0;
        _send(msg.sender, amount);
        emit Unbonded(msg.sender, amount);
    }

    // ---- claims

    /// @notice Prove that a receipted tx was sandwiched and register its claim on the incident. The beneficiary
    ///         collects with `collect` once the incident's claim window closes; the prover gets its execution gas
    ///         at basefee now, from the RPC's unreserved bond.
    /// @param poolKey v3: abi.encode(token0, token1, fee); v4: abi.encode(PoolKey) (5 words).
    function claim(
        SandwichCourtVerifier.Claim calldata c,
        Protected calldata r,
        bytes calldata sig,
        bytes calldata poolKey
    ) external returns (bytes32 incident) {
        uint256 gasStart = gasleft();
        address rpc = _checkReceipt(c, r, sig);
        uint256 budget;
        (incident, budget) = _proveIncident(c, r, poolKey);
        uint256 free = _register(incident, budget, rpc, r);
        // shortcut: execution gas at basefee only (no calldata or L1 data fee); add an overhead if provers need it
        uint256 refund = (gasStart - gasleft()) * block.basefee;
        if (refund > free) refund = free;
        bondOf[rpc] -= refund;
        _send(msg.sender, refund);
        Claim storage cl = claims[r.txHash];
        emit ClaimRegistered(incident, r.txHash, rpc, r.beneficiary, cl.weight, cl.reserved, refund);
    }

    /// @notice Pay a registered claim its share once its incident's claim window has closed. Anyone may call it;
    ///         the payout always goes to the beneficiary the receipt names.
    function collect(bytes32 txHash) external returns (uint256 payout) {
        Claim storage cl = claims[txHash];
        if (cl.rpc == address(0)) revert UnknownClaim(txHash);
        if (cl.collected) revert AlreadyCollected(txHash);
        uint64 closesAt = incidents[cl.incident].closesAt;
        if (block.timestamp < closesAt) revert ClaimWindowOpen(closesAt);
        payout = shareOf(txHash);
        cl.collected = true;
        reservedOf[cl.rpc] -= cl.reserved;
        bondOf[cl.rpc] -= payout;
        _send(cl.beneficiary, payout);
        emit Collected(cl.incident, txHash, cl.beneficiary, payout);
    }

    /// @notice What a claim collects: its weight's share of the incident budget (its whole weight if all weights
    ///         fit the budget), never more than it reserved from the RPC's bond. Final once the window closes.
    function shareOf(bytes32 txHash) public view returns (uint256 share) {
        Claim storage cl = claims[txHash];
        Incident storage inc = incidents[cl.incident];
        share = inc.totalWeight <= inc.budget ? cl.weight : (inc.budget * cl.weight) / inc.totalWeight;
        if (share > cl.reserved) share = cl.reserved;
    }

    /// @notice The EIP-712 digest an RPC signs for a receipt.
    function receiptDigest(Protected calldata r) public view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("BondRegistry"), keccak256("1"), block.chainid, address(this))
        );
        bytes32 h = keccak256(
            abi.encode(PROTECTED_TYPEHASH, r.txHash, r.chainId, r.acceptedAt, r.maxBlock, r.maxPayout, r.beneficiary)
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, h));
    }

    /// @notice An incident's budget: the attacker's profit, capped by the swap fee its front leg paid (see
    ///         `feeCappedBudget`).
    function budgetFor(uint256 profit, uint256 frontIn, uint24 fee) public pure returns (uint256) {
        return feeCappedBudget(profit, frontIn, fee);
    }

    // ---- internals

    /// @dev Receipt-only checks, cheapest first: new claim, a beneficiary, the right chain and path, a bonded signer.
    function _checkReceipt(SandwichCourtVerifier.Claim calldata c, Protected calldata r, bytes calldata sig)
        internal
        view
        returns (address rpc)
    {
        if (claims[r.txHash].rpc != address(0)) revert AlreadyClaimed(r.txHash);
        if (r.beneficiary == address(0)) revert NoBeneficiary();
        // the receipt's chain must be the one this registry judges, through the matching block-hash path
        bool local = c.anchor.header.length == 0;
        if (r.chainId != sourceChainId || local != (sourceChainId == block.chainid)) revert WrongChain();
        rpc = _signer(r, sig);
        if (bondOf[rpc] == reservedOf[rpc]) revert NoBond(rpc);
    }

    /// @dev Verifies the sandwich; returns its incident id (its front leg's swap) and its budget in ETH. A new
    ///      incident also takes its back leg's swap.
    function _proveIncident(SandwichCourtVerifier.Claim calldata c, Protected calldata r, bytes calldata poolKey)
        internal
        returns (bytes32 incident, uint256 budget)
    {
        SandwichCourtVerifier.Verdict memory v = verifier.verify(c);
        if (v.victimTxHash != r.txHash) revert NotReceipted();
        if (v.blockNumber > r.maxBlock) revert TooLate(v.blockNumber, r.maxBlock);
        uint256 ts = _blockTimestamp(c.header); // `verify` authenticated this header
        if (r.acceptedAt > ts) revert IssuedAfterIncident(r.acceptedAt, ts);
        // shortcut: only ETH/WETH profit is valued (1:1); others revert unpaid so a later valuation can still pay them
        (address token, uint24 fee) = _pool(c, poolKey, v.profitInToken0);
        if (token != weth && token != address(0)) revert UnvaluedProfit(token);
        budget = budgetFor(v.profit, v.frontIn, fee);
        if (budget == 0) revert ZeroBudget();
        // incidents pair one front swap with one back swap, so each budget stands for a real round trip (R8):
        // several fronts closed by one back, or one front by several backs, can't count a fee more than once
        incident =
            keccak256(abi.encode(r.chainId, v.blockHash, c.pool, c.poolId, keccak256(c.front.rawTx), c.front.logIndex));
        if (incidents[incident].closesAt == 0) {
            bytes32 back = keccak256(abi.encode(c.pool, c.poolId, keccak256(c.back.rawTx), c.back.logIndex));
            if (backUsed[back]) revert BackLegReused();
            backUsed[back] = true;
        }
    }

    /// @dev Opens the incident on its first claim, records this claim and reserves its weight from the bond.
    /// @return free the RPC's bond left unreserved
    function _register(bytes32 incident, uint256 budget, address rpc, Protected calldata r)
        internal
        returns (uint256 free)
    {
        Incident storage inc = incidents[incident];
        if (inc.closesAt == 0) {
            inc.budget = budget;
            inc.closesAt = uint64(block.timestamp + claimWindow);
            emit IncidentOpened(incident, budget, inc.closesAt);
        } else if (block.timestamp >= inc.closesAt) {
            revert ClaimWindowClosed(incident, inc.closesAt);
        }
        uint256 weight = r.maxPayout < inc.budget ? r.maxPayout : inc.budget;
        inc.totalWeight += weight;
        free = bondOf[rpc] - reservedOf[rpc];
        uint256 reserved = weight < free ? weight : free;
        reservedOf[rpc] += reserved;
        claims[r.txHash] = Claim(incident, rpc, r.beneficiary, weight, reserved, false);
        free -= reserved;
    }

    function _signer(Protected calldata r, bytes calldata sig) internal view returns (address s) {
        if (sig.length != 65) revert BadSignature();
        uint8 v = uint8(sig[64]);
        s = ecrecover(receiptDigest(r), v < 27 ? v + 27 : v, bytes32(sig[0:32]), bytes32(sig[32:64]));
        if (s == address(0)) revert BadSignature();
    }

    /// @dev Checks the pool is a covered Uniswap pool with a static fee; returns the profit token and the fee.
    function _pool(SandwichCourtVerifier.Claim calldata c, bytes calldata poolKey, bool inToken0)
        internal
        view
        returns (address token, uint24 fee)
    {
        address t0;
        address t1;
        (t0, t1, fee) = abi.decode(poolKey, (address, address, uint24)); // a v4 PoolKey starts with the same three
        bytes32 id;
        if (c.v4) {
            if (c.pool != v4PoolManager || keccak256(poolKey) != c.poolId) revert UnknownPool();
            id = c.poolId;
        } else {
            bytes32 salt = keccak256(abi.encode(t0, t1, fee));
            address pool =
                address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", v3Factory, salt, v3InitCodeHash)))));
            if (pool != c.pool) revert UnknownPool();
            id = bytes32(uint256(uint160(pool)));
        }
        // a v4 dynamic fee (flag 0x800000) can't be read from the key
        if (!covered[id] || fee > FEE_UNITS) revert UnsupportedPool();
        token = inToken0 ? t0 : t1;
    }

    /// @dev Header field 11 is the block timestamp (every fork since Frontier).
    function _blockTimestamp(bytes calldata header) internal pure returns (uint256 t) {
        bytes memory b = RLPReader.readBytes(RLPReader.readList(header)[11]);
        for (uint256 i; i < b.length; i++) {
            t = (t << 8) | uint8(b[i]);
        }
    }

    function _send(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
