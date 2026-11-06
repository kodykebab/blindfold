// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SandwichCourtVerifier} from "./SandwichCourtVerifier.sol";
import {RLPReader} from "./lib/RLPReader.sol";

/// @title BondRegistry
/// @notice A protected RPC bonds ETH here and signs an EIP-712 `Protected` receipt for every tx it accepts, before
///         that tx runs. The receipt names who gets paid (`beneficiary`, S15) and the most the RPC will pay.
///         Insured event: the receipted tx is proven to be the victim of a sandwich (SandwichCourtVerifier) in a
///         canonical Uniswap pool, landed by `maxBlock`, with the attacker's profit in ETH or WETH. That proves a
///         sandwich-shaped sequence and the attacker's profit; it does not prove the RPC leaked the tx, nor how
///         much the victim lost, so coverage is capped and profit-based rather than a loss refund.
///         The beneficiary is paid min(attacker profit, receipt.maxPayout) from the RPC's bond, once per tx, plus
///         the prover's execution gas.
///         - Profit is valued 1:1 only when it is in ETH or WETH; claims for other profit tokens revert
///           unpaid (no oracle), so they stay claimable if valuation is added later.
///         - The cap is set by the RPC from the tx's own slippage, so sandwiching yourself can't pay more
///           than the slippage the RPC agreed to cover (REVIEW.md R8).
///         - The pool is pinned: a v3 pool must come from the canonical factory, a v4 pool from the
///           canonical PoolManager, so fake contracts emitting Swap-shaped logs can't be claimed.
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
    }

    bytes32 public constant PROTECTED_TYPEHASH = keccak256(
        "Protected(bytes32 txHash,uint256 chainId,uint64 acceptedAt,uint64 maxBlock,uint256 maxPayout,address beneficiary)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    error AlreadyPaid(bytes32 txHash);
    error NoBeneficiary();
    error WrongChain();
    error NotReceipted();
    error TooLate(uint256 blockNumber, uint256 maxBlock);
    error IssuedAfterIncident(uint256 acceptedAt, uint256 blockTimestamp);
    error UnknownPool();
    error UnvaluedProfit(address token);
    error BadSignature();
    error NoBond(address rpc);
    error UnbondNotReady(uint256 at);
    error TransferFailed();

    event Bonded(address indexed rpc, uint256 amount, uint256 total);
    event UnbondRequested(address indexed rpc, uint256 at);
    event Unbonded(address indexed rpc, uint256 amount);
    event Claimed(
        address indexed rpc,
        bytes32 indexed txHash,
        address indexed beneficiary,
        uint256 payout,
        uint256 gasRefund,
        address prover
    );

    SandwichCourtVerifier public immutable verifier;
    uint256 public immutable sourceChainId;
    address public immutable weth;
    address public immutable v3Factory;
    bytes32 public immutable v3InitCodeHash;
    address public immutable v4PoolManager;
    uint256 public immutable unbondDelay;

    mapping(address rpc => uint256) public bondOf;
    mapping(address rpc => uint256) public unbondAt;
    mapping(bytes32 txHash => bool) public paid;

    constructor(Config memory c) {
        verifier = c.verifier;
        sourceChainId = c.sourceChainId;
        weth = c.weth;
        v3Factory = c.v3Factory;
        v3InitCodeHash = c.v3InitCodeHash;
        v4PoolManager = c.v4PoolManager;
        unbondDelay = c.unbondDelay;
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

    /// @notice Withdraw the whole bond once the delay has passed.
    function unbond() external {
        uint256 at = unbondAt[msg.sender];
        if (at == 0 || block.timestamp < at) revert UnbondNotReady(at);
        uint256 amount = bondOf[msg.sender];
        bondOf[msg.sender] = 0;
        unbondAt[msg.sender] = 0;
        _send(msg.sender, amount);
        emit Unbonded(msg.sender, amount);
    }

    // ---- claims

    /// @notice Prove that a receipted tx was sandwiched and pay the receipt's beneficiary from the signing RPC's bond.
    /// @param poolKey v3: abi.encode(token0, token1, fee); v4: abi.encode(PoolKey) (5 words).
    /// @return payout what the beneficiary received (the prover also gets its execution gas at basefee)
    function claim(
        SandwichCourtVerifier.Claim calldata c,
        Protected calldata r,
        bytes calldata sig,
        bytes calldata poolKey
    ) external returns (uint256 payout) {
        uint256 gasStart = gasleft();
        if (paid[r.txHash]) revert AlreadyPaid(r.txHash);
        if (r.beneficiary == address(0)) revert NoBeneficiary();
        // the receipt's chain must be the one this registry judges, through the matching block-hash path
        bool local = c.anchor.header.length == 0;
        if (r.chainId != sourceChainId || local != (sourceChainId == block.chainid)) revert WrongChain();

        address rpc = _signer(r, sig);
        uint256 available = bondOf[rpc];
        if (available == 0) revert NoBond(rpc);

        SandwichCourtVerifier.Verdict memory v = verifier.verify(c);
        if (v.victimTxHash != r.txHash) revert NotReceipted();
        if (v.blockNumber > r.maxBlock) revert TooLate(v.blockNumber, r.maxBlock);
        // `verify` authenticated this header, so its timestamp is the sandwich block's
        if (r.acceptedAt > _blockTimestamp(c.header)) {
            revert IssuedAfterIncident(r.acceptedAt, _blockTimestamp(c.header));
        }

        // shortcut: only ETH/WETH profit is valued (1:1); others revert unpaid so a later valuation can still pay them
        address token = _profitToken(c, poolKey, v.profitInToken0);
        if (token != weth && token != address(0)) revert UnvaluedProfit(token);
        payout = v.profit < r.maxPayout ? v.profit : r.maxPayout;
        if (payout > available) payout = available;
        // shortcut: execution gas at basefee only (no calldata or L1 data fee); add an overhead if provers need it
        uint256 refund = (gasStart - gasleft()) * block.basefee;
        if (refund > available - payout) refund = available - payout;

        paid[r.txHash] = true;
        bondOf[rpc] = available - payout - refund;
        _send(r.beneficiary, payout);
        _send(msg.sender, refund);
        emit Claimed(rpc, r.txHash, r.beneficiary, payout, refund, msg.sender);
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
