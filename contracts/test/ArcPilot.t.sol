// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @dev  ArcPilot.t.sol  — compatibility shim
 *
 * ArcPilot.sol was updated in milestone 1 to the same 7-argument constructor
 * and 4-argument pay() as ArcPilotTreasury.sol.
 *
 * The full test suite for this logic lives in ArcPilotTreasury.t.sol (108 tests).
 * This file provides a lightweight compile-verification pass for ArcPilot.sol
 * (which shares the same ABI) so that forge build succeeds for both contracts.
 *
 * Run the comprehensive suite:
 *   forge test --match-path "contracts/test/ArcPilotTreasury.t.sol" -vv
 */

import {Test}      from "forge-std/Test.sol";
import {ArcPilot}  from "../ArcPilot.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

contract ArcPilotCompileTest is Test {
    ArcPilot  internal pilot;
    MockERC20 internal usdc;

    address internal owner   = makeAddr("owner");
    address internal pauser  = makeAddr("pauser");
    address internal rescuer = makeAddr("rescuer");

    function setUp() public {
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        vm.prank(owner);
        pilot = new ArcPilot(
            owner,
            pauser,
            rescuer,
            address(usdc),
            1000,   // 10% reserve
            0,      // no maxTxAmount
            0       // no globalDailyLimit
        );
    }

    /// @dev Smoke-test: contract deploys and reads are sane.
    function test_Deploy() public view {
        assertEq(address(pilot.usdc()), address(usdc));
        assertEq(pilot.reserveBps(), 1000);
        assertEq(pilot.pauser(), pauser);
        assertEq(pilot.rescuer(), rescuer);
        assertEq(pilot.owner(), owner);
    }

    /// @dev Smoke-test: pay() accepts 4 arguments and requestId deduplication works.
    function test_PaySignature() public {
        // Fund treasury
        usdc.mint(owner, 1_000e6);
        vm.startPrank(owner);
        usdc.approve(address(pilot), 1_000e6);
        pilot.deposit(1_000e6);

        // Allow payee
        address payee = makeAddr("payee");
        pilot.setPayee(payee, "test", 0);

        // Execute payment with explicit requestId
        bytes32 rid = keccak256("invoice-001");
        pilot.pay(payee, 100e6, rid, "invoice #1");
        vm.stopPrank();

        assertEq(pilot.paymentCount(), 1);
        assertTrue(pilot.requestIdUsed(rid));
    }

    /// @dev Duplicate requestId must revert.
    function test_DuplicateRequestIdReverts() public {
        usdc.mint(owner, 1_000e6);
        vm.startPrank(owner);
        usdc.approve(address(pilot), 1_000e6);
        pilot.deposit(1_000e6);

        address payee = makeAddr("payee2");
        pilot.setPayee(payee, "test", 0);

        bytes32 rid = keccak256("invoice-002");
        pilot.pay(payee, 100e6, rid, "first");
        vm.expectRevert(abi.encodeWithSelector(ArcPilot.DuplicateRequestId.selector, rid));
        pilot.pay(payee, 100e6, rid, "second");
        vm.stopPrank();
    }
}
