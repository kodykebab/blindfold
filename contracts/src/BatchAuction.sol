// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BlindfoldVault} from "./BlindfoldVault.sol";

/// @title BatchAuction
/// @notice Sealed batches. Orders are timelock-encrypted (tlock) to a future drand quicknet round:
///         - commit: a hash, the ciphertext (event only) and a fixed deposit; direction and size stay hidden;
///         - reveal: ANYONE may reveal after the round is published, for a bounty, so nobody can withhold a reveal;
///         - slashUnrevealed: a commitment nobody revealed in time forfeits its deposit.
///         Settlement is implemented by BlindfoldSettlement, which inherits this contract.
abstract contract BatchAuction {
    /// drand quicknet: unchained BLS on G1, one round every 3 s
    uint256 public constant DRAND_GENESIS = 1692803367;
    uint256 public constant DRAND_PERIOD = 3;
    /// orders target the round 2 rounds after commits close, so nobody can decrypt while commits are open
    uint256 public constant DRAND_MARGIN = 2;
    uint256 public constant MAX_COMMITS = 64;
    uint256 internal constant BPS = 10_000;

    struct Order {
        address owner; // must equal the committer
        bool zeroForOne; // sell token0 for token1
        uint128 amountIn; // 0 = padding order (no-op)
        uint128 minAmountOut;
    }

    enum Status {
        None,
        Committed,
        Revealed,
        Slashed
    }

    struct Commitment {
        address committer;
        uint64 batchId;
        Status status;
        bytes32 hash;
    }

    struct Schedule {
        uint64 start; // batch 0 opens
        uint32 batchLength;
        uint32 revealLength;
        uint32 settleLength;
    }

    error NotCurrentBatch(uint64 batchId, uint64 current);
    error BatchFull();
    error BadStatus(uint256 commitId);
    error OutsideRevealWindow(uint256 nowTs, uint256 opens, uint256 closes);
    error RevealWindowOpen(uint256 closes);
    error HashMismatch();
    error OwnerMismatch();

    event Committed(
        uint256 indexed commitId, uint64 indexed batchId, address indexed committer, bytes32 hash, uint64 round, bytes ciphertext
    );
    event Revealed(uint256 indexed commitId, uint64 indexed batchId, address indexed revealer, Order order);
    event RevealedUnfunded(uint256 indexed commitId, uint64 indexed batchId, address indexed revealer, Order order);
    event Slashed(uint256 indexed commitId, uint64 indexed batchId, address indexed caller);

    BlindfoldVault public immutable vault;
    address public immutable depositToken;
    uint256 public immutable depositAmount;
    uint256 public immutable bountyBps;
    address public immutable treasury;
    uint64 public immutable start;
    uint32 public immutable batchLength;
    uint32 public immutable revealLength;
    uint32 public immutable settleLength;

    uint256 public commitCount;
    mapping(uint256 => Commitment) public commitments;
    mapping(uint256 => Order) internal orders;
    mapping(uint64 => uint256[]) internal batchCommitIds;
    mapping(uint64 => uint256[]) internal batchOrderIds; // funded, non-padding reveals

    constructor(
        BlindfoldVault vault_,
        address depositToken_,
        uint256 depositAmount_,
        uint256 bountyBps_,
        address treasury_,
        Schedule memory s
    ) {
        require(bountyBps_ <= BPS && s.batchLength != 0 && s.start >= DRAND_GENESIS, "config");
        vault = vault_;
        depositToken = depositToken_;
        depositAmount = depositAmount_;
        bountyBps = bountyBps_;
        treasury = treasury_;
        start = s.start;
        batchLength = s.batchLength;
        revealLength = s.revealLength;
        settleLength = s.settleLength;
    }

    // ---- schedule

    function currentBatch() public view returns (uint64) {
        return uint64((block.timestamp - start) / batchLength);
    }

    function commitsClose(uint64 batchId) public view returns (uint256) {
        return uint256(start) + (uint256(batchId) + 1) * batchLength;
    }

    /// @notice The drand quicknet round clients encrypt this batch's orders to.
    function targetRound(uint64 batchId) public view returns (uint64) {
        return uint64((commitsClose(batchId) - DRAND_GENESIS) / DRAND_PERIOD + 1 + DRAND_MARGIN);
    }

    function roundTime(uint64 round) public pure returns (uint256) {
        return DRAND_GENESIS + (uint256(round) - 1) * DRAND_PERIOD;
    }

    /// @dev Reveals open at the scheduled publication time of the batch's drand round.
    function revealOpens(uint64 batchId) public view returns (uint256) {
        return roundTime(targetRound(batchId));
    }

    function revealCloses(uint64 batchId) public view returns (uint256) {
        return revealOpens(batchId) + revealLength;
    }

    function settleCloses(uint64 batchId) public view returns (uint256) {
        return revealCloses(batchId) + settleLength;
    }

    // ---- views

    /// @notice Hash a client commits to; it encrypts abi.encode(order, salt) to targetRound(batchId).
    function orderHash(uint64 batchId, Order memory order, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), batchId, order, salt));
    }

    function commitIdsOf(uint64 batchId) external view returns (uint256[] memory) {
        return batchCommitIds[batchId];
    }

    function orderIdsOf(uint64 batchId) external view returns (uint256[] memory) {
        return batchOrderIds[batchId];
    }

    function getOrder(uint256 commitId) external view returns (Order memory) {
        return orders[commitId];
    }

    // ---- actions

    function commit(uint64 batchId, bytes32 hash, bytes calldata ciphertext) external returns (uint256 id) {
        uint64 cur = currentBatch();
        if (batchId != cur) revert NotCurrentBatch(batchId, cur);
        if (batchCommitIds[batchId].length >= MAX_COMMITS) revert BatchFull();

        vault.transferInternal(msg.sender, address(this), depositToken, depositAmount);
        vault.openCommitment(msg.sender);

        id = commitCount++;
        commitments[id] = Commitment(msg.sender, batchId, Status.Committed, hash);
        batchCommitIds[batchId].push(id);
        emit Committed(id, batchId, msg.sender, hash, targetRound(batchId), ciphertext);
    }

    function reveal(uint256 id, Order calldata order, bytes32 salt) external {
        Commitment storage c = commitments[id];
        if (c.status != Status.Committed) revert BadStatus(id);
        uint64 b = c.batchId;
        uint256 opens = revealOpens(b);
        uint256 closes = opens + revealLength;
        if (block.timestamp < opens || block.timestamp >= closes) revert OutsideRevealWindow(block.timestamp, opens, closes);
        if (orderHash(b, order, salt) != c.hash) revert HashMismatch();
        if (order.owner != c.committer) revert OwnerMismatch();

        c.status = Status.Revealed;
        address owner = order.owner;
        uint256 bounty = depositAmount * bountyBps / BPS;
        vault.transferInternal(address(this), msg.sender, depositToken, bounty);

        address tokenIn = _inputToken(order.zeroForOne);
        if (order.amountIn != 0 && vault.freeBalance(owner, tokenIn) < order.amountIn) {
            vault.transferInternal(address(this), treasury, depositToken, depositAmount - bounty);
            vault.closeCommitment(owner);
            emit RevealedUnfunded(id, b, msg.sender, order);
            return;
        }

        vault.transferInternal(address(this), owner, depositToken, depositAmount - bounty);
        if (order.amountIn == 0) {
            vault.closeCommitment(owner);
        } else {
            vault.lock(owner, tokenIn, order.amountIn);
            orders[id] = order;
            batchOrderIds[b].push(id);
        }
        emit Revealed(id, b, msg.sender, order);
    }

    function slashUnrevealed(uint256 id) external {
        Commitment storage c = commitments[id];
        if (c.status != Status.Committed) revert BadStatus(id);
        uint256 closes = revealCloses(c.batchId);
        if (block.timestamp < closes) revert RevealWindowOpen(closes);

        c.status = Status.Slashed;
        uint256 bounty = depositAmount * bountyBps / BPS;
        vault.transferInternal(address(this), msg.sender, depositToken, bounty);
        vault.transferInternal(address(this), treasury, depositToken, depositAmount - bounty);
        vault.closeCommitment(c.committer);
        emit Slashed(id, c.batchId, msg.sender);
    }

    function _inputToken(bool zeroForOne) internal view virtual returns (address);
}
