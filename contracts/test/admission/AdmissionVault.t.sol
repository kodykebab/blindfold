// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {AdmissionVault} from "../../src/admission/AdmissionVault.sol";

contract TaxToken is MockERC20 {
    bool public tax;
    constructor() MockERC20("Tax", "TAX", 18) {}

    function setTax(bool value) external {
        tax = value;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        super.transfer(to, amount);
        if (tax && amount > 0) _burn(to, 1);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        super.transferFrom(from, to, amount);
        if (tax && amount > 0) _burn(to, 1);
        return true;
    }
}

contract AdmissionVaultTest is Test {
    function test_exactTransfersAndTaxRollback() public {
        TaxToken token = new TaxToken();
        MockERC20 other = new MockERC20("Other", "OTHER", 18);
        (address a, address b) =
            address(token) < address(other) ? (address(token), address(other)) : (address(other), address(token));
        AdmissionVault vault = new AdmissionVault(a, b);
        token.mint(address(this), 100);
        token.approve(address(vault), 100);
        token.setTax(true);
        vm.expectRevert(AdmissionVault.InexactTransfer.selector);
        vault.deposit(address(token), 10);
        assertEq(vault.balanceOf(address(this), address(token)), 0);
        assertEq(token.balanceOf(address(vault)), 0);
        token.setTax(false);
        vault.deposit(address(token), 10);
        assertEq(vault.freeBalance(address(this), address(token)), 10);
        token.setTax(true);
        vm.expectRevert(AdmissionVault.InexactTransfer.selector);
        vault.withdraw(address(token), 5);
        assertEq(vault.freeBalance(address(this), address(token)), 10);
        assertEq(token.balanceOf(address(vault)), 10);
        token.setTax(false);
        vault.withdraw(address(token), 10);
        assertEq(token.balanceOf(address(this)), 100);
        assertEq(vault.freeBalance(address(this), address(token)), 0);
    }

    function test_pairMustBeSortedContracts() public {
        vm.expectRevert(AdmissionVault.UnsupportedToken.selector);
        new AdmissionVault(address(0), address(1));
        MockERC20 a = new MockERC20("A", "A", 18);
        vm.expectRevert(AdmissionVault.UnsupportedToken.selector);
        new AdmissionVault(address(a), address(a));
    }
}
