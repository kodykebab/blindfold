// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @title BlindfoldVault
/// @notice Users pre-fund the vault (ideally with both pool tokens) so a commit never has to escrow
///         its input token, which would reveal direction and size. The operator (BlindfoldSettlement)
///         moves internal balances.
/// @dev Invariant: for each token, the sum of balanceOf over all accounts == token.balanceOf(vault).
///      A user with an open commitment can't withdraw: otherwise they could watch the market after the
///      batch closes and drain the vault so their order fails (the commit-reveal free option).
contract BlindfoldVault {
    error Unauthorized();
    error OperatorSet();
    error Insufficient(address account, address token, uint256 free, uint256 needed);
    error OpenCommitments(address account, uint256 open);
    error TokenTransferFailed();

    event Deposit(address indexed account, address indexed token, uint256 amount);
    event Withdraw(address indexed account, address indexed token, uint256 amount);

    address public immutable admin;
    address public operator;

    mapping(address account => mapping(address token => uint256)) public balanceOf;
    mapping(address account => mapping(address token => uint256)) public lockedOf;
    mapping(address account => uint256) public openCommitments;

    constructor() {
        admin = msg.sender;
    }

    function setOperator(address op) external {
        if (msg.sender != admin) revert Unauthorized();
        if (operator != address(0)) revert OperatorSet();
        operator = op;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
        _;
    }

    function freeBalance(address account, address token) public view returns (uint256) {
        return balanceOf[account][token] - lockedOf[account][token];
    }

    // ---- users

    function deposit(address token, uint256 amount) external {
        _receive(token, msg.sender, amount);
        balanceOf[msg.sender][token] += amount;
        emit Deposit(msg.sender, token, amount);
    }

    function withdraw(address token, uint256 amount) external {
        uint256 open = openCommitments[msg.sender];
        if (open != 0) revert OpenCommitments(msg.sender, open);
        _debit(msg.sender, token, amount);
        _send(token, msg.sender, amount);
        emit Withdraw(msg.sender, token, amount);
    }

    // ---- operator

    function transferInternal(address from, address to, address token, uint256 amount) external onlyOperator {
        if (amount == 0) return;
        _debit(from, token, amount);
        balanceOf[to][token] += amount;
    }

    function lock(address account, address token, uint256 amount) external onlyOperator {
        uint256 free = freeBalance(account, token);
        if (free < amount) revert Insufficient(account, token, free, amount);
        lockedOf[account][token] += amount;
    }

    function unlock(address account, address token, uint256 amount) external onlyOperator {
        lockedOf[account][token] -= amount;
    }

    function openCommitment(address account) external onlyOperator {
        openCommitments[account]++;
    }

    function closeCommitment(address account) external onlyOperator {
        openCommitments[account]--;
    }

    /// @notice Real tokens out of the operator's own account (to route a residual swap).
    function operatorPull(address token, uint256 amount, address to) external onlyOperator {
        _debit(msg.sender, token, amount);
        _send(token, to, amount);
    }

    /// @notice Real tokens into the operator's own account.
    function operatorPush(address token, uint256 amount) external onlyOperator {
        _receive(token, msg.sender, amount);
        balanceOf[msg.sender][token] += amount;
    }

    // ---- internals

    function _debit(address account, address token, uint256 amount) internal {
        uint256 free = freeBalance(account, token);
        if (free < amount) revert Insufficient(account, token, free, amount);
        balanceOf[account][token] -= amount;
    }

    function _receive(address token, address from, uint256 amount) internal virtual {
        (bool ok, bytes memory r) = token.call(abi.encodeCall(IERC20Like.transferFrom, (from, address(this), amount)));
        if (!ok || (r.length != 0 && !abi.decode(r, (bool)))) revert TokenTransferFailed();
    }

    function _send(address token, address to, uint256 amount) internal virtual {
        (bool ok, bytes memory r) = token.call(abi.encodeCall(IERC20Like.transfer, (to, amount)));
        if (!ok || (r.length != 0 && !abi.decode(r, (bool)))) revert TokenTransferFailed();
    }
}
