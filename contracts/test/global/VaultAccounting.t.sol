// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {BlindfoldVault} from "../../src/BlindfoldVault.sol";

contract ShortToken {
    mapping(address => uint256) public balanceOf;
    bool public short;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setShort(bool value) external {
        short = value;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        return _move(from, to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function _move(address from, address to, uint256 amount) private returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += short ? amount - 1 : amount;
        return true;
    }
}

contract CallbackToken {
    mapping(address => uint256) public balanceOf;
    BlindfoldVault public vault;
    bool public callbackRejected;

    constructor(BlindfoldVault v) {
        vault = v;
    }

    function mint(address owner, uint256 amount) external {
        balanceOf[owner] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        (bool ok, bytes memory data) = address(vault).call(abi.encodeCall(vault.deposit, (address(this), 0)));
        require(!ok && bytes4(data) == BlindfoldVault.Reentrant.selector, "deposit callback not blocked");
        callbackRejected = true;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        (bool ok, bytes memory data) = address(vault).call(abi.encodeCall(vault.withdraw, (address(this), 0)));
        require(!ok && bytes4(data) == BlindfoldVault.Reentrant.selector, "withdraw callback not blocked");
        callbackRejected = true;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract VaultAccountingTest is Test {
    BlindfoldVault v;
    ShortToken t;

    function setUp() public {
        v = new BlindfoldVault();
        t = new ShortToken();
        t.mint(address(this), 1000);
    }

    function test_depositRejectsShortTransferEvenWithDonatedBalance() public {
        t.mint(address(v), 100);
        t.setShort(true);
        vm.expectRevert();
        v.deposit(address(t), 100);
        assertEq(v.balanceOf(address(this), address(t)), 0);
        assertEq(t.balanceOf(address(v)), 100);
    }

    function test_withdrawRejectsRecipientFeeAndRollsBackLedger() public {
        v.deposit(address(t), 100);
        t.setShort(true);
        vm.expectRevert();
        v.withdraw(address(t), 100);
        assertEq(v.balanceOf(address(this), address(t)), 100);
        assertEq(t.balanceOf(address(v)), 100);
    }

    function test_operatorPushRejectsUnbackedCredit() public {
        v.setOperator(address(this));
        t.setShort(true);
        vm.expectRevert();
        v.operatorPush(address(t), 100);
        assertEq(v.balanceOf(address(this), address(t)), 0);
    }

    function test_EOAIsNotAToken() public {
        vm.expectRevert();
        v.deposit(address(0x1234), 100);
    }

    function testFuzz_roundtrip(uint128 amount) public {
        amount = uint128(bound(amount, 0, 1000));
        v.deposit(address(t), amount);
        v.withdraw(address(t), amount);
        assertEq(v.balanceOf(address(this), address(t)), 0);
        assertEq(t.balanceOf(address(this)), 1000);
    }

    function test_tokenCallbacksCannotReenterCustody() public {
        CallbackToken token = new CallbackToken(v);
        token.mint(address(this), 100);
        v.deposit(address(token), 100);
        assertTrue(token.callbackRejected());
        v.withdraw(address(token), 100);
        assertEq(token.balanceOf(address(this)), 100);
        assertEq(v.balanceOf(address(this), address(token)), 0);
    }
}
