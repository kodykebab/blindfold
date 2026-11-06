// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SandwichCourtVerifier} from "./SandwichCourtVerifier.sol";
import {RLPReader} from "./lib/RLPReader.sol";

/// @title BondRegistry
/// @notice A protected RPC bonds ETH here and signs an EIP-712 `Protected` receipt for every tx it accepts, before
///         that tx runs. The receipt names who gets paid (S15) and the most the RPC will pay (`maxPayout`).
///         Insured event: the receipted tx is proven to be the victim of a sandwich (SandwichCourtVerifier) in a
///         canonical Uniswap pool, landed by `maxBlock`, with the attacker's profit in ETH or WETH. That proves a
///         sandwich-shaped sequence and the attacker's profit; it does not prove the RPC leaked the tx, nor how
///         much the victim lost, so coverage is capped and profit-based rather than a loss refund.
///         Payouts per incident (S14): every claim against the same attacker legs (chain, block, pool, front and
///         back tx) shares one budget, the attacker's profit. The first claim opens a `claimWindow`; claims made in
///         it reserve their share from their RPC's bond; after it closes each claim collects
///         `budget * weight / totalWeight` (or its whole weight if the weights fit the budget), where
///         `weight = min(maxPayout, budget)`. So no claim gets more than its cap and an incident never pays more
///         than the attacker made, however many receipts (or self-made victims) sit between the same legs (R8).
///         Unclaimed coverage stays in the bond.
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
    }

    struct Incident {
        uint256 budget; // the attacker's profit, shared by every claim on this incident
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

    constructor(Config memory c) {
        verifier = c.verifier;
        sourceChainId = c.sourceChainId;
        weth = c.weth;
        v3Factory = c.v3Factory;
        v3InitCodeHash = c.v3InitCodeHash;
        v4PoolManager = c.v4PoolManager;
        unbondDelay = c.unbondDelay;
        claimWindow = c.claimWindow;
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
        uint256 profit;
        (incident, profit) = _proveIncident(c, r, poolKey);
        uint256 free = _register(incident, profit, rpc, r);
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

    /// @dev Verifies the sandwich and returns its incident id and the attacker's (ETH-valued) profit.
    function _proveIncident(SandwichCourtVerifier.Claim calldata c, Protected calldata r, bytes calldata poolKey)
        internal
        view
        returns (bytes32 incident, uint256 profit)
    {
        SandwichCourtVerifier.Verdict memory v = verifier.verify(c);
        if (v.victimTxHash != r.txHash) revert NotReceipted();
        if (v.blockNumber > r.maxBlock) revert TooLate(v.blockNumber, r.maxBlock);
        uint256 ts = _blockTimestamp(c.header); // `verify` authenticated this header
        if (r.acceptedAt > ts) revert IssuedAfterIncident(r.acceptedAt, ts);
        // shortcut: only ETH/WETH profit is valued (1:1); others revert unpaid so a later valuation can still pay them
        address token = _profitToken(c, poolKey, v.profitInToken0);
        if (token != weth && token != address(0)) revert UnvaluedProfit(token);
        incident = keccak256(
            abi.encode(r.chainId, v.blockHash, c.pool, c.poolId, keccak256(c.front.rawTx), keccak256(c.back.rawTx))
        );
        profit = v.profit;
    }

    /// @dev Opens the incident on its first claim, records this claim and reserves its weight from the bond.
    /// @return free the RPC's bond left unreserved
    function _register(bytes32 incident, uint256 profit, address rpc, Protected calldata r)
        internal
        returns (uint256 free)
    {
        Incident storage inc = incidents[incident];
        if (inc.closesAt == 0) {
            inc.budget = profit;
            inc.closesAt = uint64(block.timestamp + claimWindow);
            emit IncidentOpened(incident, profit, inc.closesAt);
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

    /// @dev Checks the pool really is a Uniswap pool and returns the token the attacker profited in.
    function _profitToken(SandwichCourtVerifier.Claim calldata c, bytes calldata poolKey, bool inToken0)
        internal
        view
        returns (address)
    {
        if (c.v4) {
            if (c.pool != v4PoolManager || keccak256(poolKey) != c.poolId) revert UnknownPool();
            (address c0, address c1) = abi.decode(poolKey, (address, address));
            return inToken0 ? c0 : c1;
        }
        (address t0, address t1, uint24 fee) = abi.decode(poolKey, (address, address, uint24));
        bytes32 salt = keccak256(abi.encode(t0, t1, fee));
        address pool = address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", v3Factory, salt, v3InitCodeHash)))));
        if (pool != c.pool) revert UnknownPool();
        return inToken0 ? t0 : t1;
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
