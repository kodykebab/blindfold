// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {BlindfoldTest} from "./Blindfold.t.sol";
import {BlindfoldSettlement} from "../src/BlindfoldSettlement.sol";
import {MockExternalMarket} from "./utils/MockExternalMarket.sol";

contract ExternalConfigurationTest is BlindfoldTest {
    function test_external_missingConfigurationFailsClosed() public {
        vm.expectRevert(BlindfoldSettlement.ExternalConfig.selector);
        s.referencePriceX96(0);
    }

    function test_external_configurationCannotChangeAfterCommit() public {
        _commit(alice, _o(alice, true, 1, 0), "a");
        MockExternalMarket market = new MockExternalMarket(address(s), address(t0), address(t1));
        vm.expectRevert(BlindfoldSettlement.ExternalConfig.selector);
        s.configureExternal(market);
    }

    function test_external_rejectsWrongTokensOrSettlement() public {
        MockExternalMarket wrongPair = new MockExternalMarket(address(s), address(t1), address(t0));
        vm.expectRevert(BlindfoldSettlement.ExternalConfig.selector);
        s.configureExternal(wrongPair);
        MockExternalMarket wrongSettlement = new MockExternalMarket(address(this), address(t0), address(t1));
        vm.expectRevert(BlindfoldSettlement.ExternalConfig.selector);
        s.configureExternal(wrongSettlement);
    }
}
