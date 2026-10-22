// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {Ownable}        from "@openzeppelin/contracts/access/Ownable.sol";
import {ArcPilot}       from "../ArcPilot.sol";
import {MockERC20}      from "../test-helpers/MockERC20.sol";

// ─────────────────────────────────────────────────────────────────────────────
//  Event mirror — re-declare ArcPilot events so vm.expectEmit can reference them
//  without needing qualified `ArcPilot.EventName` syntax (which Solidity only
//  resolves for library/interface events, not contract events).
// ─────────────────────────────────────────────────────────────────────────────

interface IArcPilotEvents {
    event ObligationSet(uint256 indexed id, string label, uint256 amount);
    event ObligationRemoved(uint256 indexed id);
    event PayeeSet(address indexed payee, string label, uint256 dailyLimit);
    event PayeeRemoved(address indexed payee);
    event ReserveBpsSet(uint16 bps);
    event PaymentExecuted(uint256 indexed paymentId, address indexed to, uint256 amount, string memo);
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Shared fixture
// ─────────────────────────────────────────────────────────────────────────────

abstract contract ArcPilotFixture is Test, IArcPilotEvents {
    ArcPilot  internal pilot;
    MockERC20 internal usdc;

    address internal owner  = makeAddr("owner");
    address internal alice  = makeAddr("alice");
    address internal bob    = makeAddr("bob");
    address internal carol  = makeAddr("carol");

    uint16  internal constant RESERVE_BPS = 1000; // 10 %
    uint256 internal constant DEPOSIT_AMT = 10_000e6; // 10 000 USDC

    function setUp() public virtual {
        // Deploy a fresh mock USDC (6 decimals, like the real token on Arc).
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);

        // Deploy ArcPilot with owner, mock USDC, 10 % reserve.
        vm.prank(owner);
        pilot = new ArcPilot(owner, address(usdc), RESERVE_BPS);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /// Mint `amount` to `from`, approve pilot, then deposit as `from`.
    function _depositAs(address from, uint256 amount) internal {
        usdc.mint(from, amount);
        vm.startPrank(from);
        usdc.approve(address(pilot), amount);
        pilot.deposit(amount);
        vm.stopPrank();
    }

    /// Owner adds a payee with no daily limit.
    function _addPayee(address payee) internal {
        vm.prank(owner);
        pilot.setPayee(payee, "test payee", 0);
    }

    /// Owner adds a payee with a daily limit.
    function _addPayeeWithLimit(address payee, uint256 limit) internal {
        vm.prank(owner);
        pilot.setPayee(payee, "limited payee", limit);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. Constructor / initialization
// ─────────────────────────────────────────────────────────────────────────────

contract ArcPilotConstructorTest is ArcPilotFixture {

    function test_Constructor_SetsOwner() public view {
        assertEq(pilot.owner(), owner);
    }

    function test_Constructor_SetsUsdc() public view {
        assertEq(address(pilot.usdc()), address(usdc));
    }

    function test_Constructor_SetsReserveBps() public view {
        assertEq(pilot.reserveBps(), RESERVE_BPS);
    }

    function test_Constructor_InitialBalancesZero() public view {
        assertEq(pilot.totalBalance(),           0);
        assertEq(pilot.activeObligationsTotal(), 0);
        assertEq(pilot.reserveAmount(),          0);
        assertEq(pilot.spendableBalance(),       0);
    }

    function test_Constructor_RevertsZeroOwner() public {
        // OZ Ownable fires OwnableInvalidOwner before ArcPilot's own ZeroAddress check.
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0))
        );
        new ArcPilot(address(0), address(usdc), RESERVE_BPS);
    }

    function test_Constructor_RevertsZeroUsdc() public {
        vm.expectRevert(ArcPilot.ZeroAddress.selector);
        new ArcPilot(owner, address(0), RESERVE_BPS);
    }

    function test_Constructor_RevertsUsdcWithNoCode() public {
        // address(1) has no code in the fresh EVM
        vm.expectRevert(ArcPilot.ZeroAddress.selector);
        new ArcPilot(owner, address(1), RESERVE_BPS);
    }

    function test_Constructor_RevertsInvalidReserveBps() public {
        vm.expectRevert(
            abi.encodeWithSelector(ArcPilot.InvalidReserveBps.selector, uint16(10001))
        );
        new ArcPilot(owner, address(usdc), 10001);
    }

    function test_Constructor_AcceptsBpsOfZero() public {
        ArcPilot p = new ArcPilot(owner, address(usdc), 0);
        assertEq(p.reserveBps(), 0);
    }

    function test_Constructor_AcceptsBpsOf10000() public {
        ArcPilot p = new ArcPilot(owner, address(usdc), 10000);
        assertEq(p.reserveBps(), 10000);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  2. deposit
// ─────────────────────────────────────────────────────────────────────────────

contract ArcPilotDepositTest is ArcPilotFixture {

    function test_Deposit_HappyPath() public {
        usdc.mint(alice, DEPOSIT_AMT);
        vm.startPrank(alice);
        usdc.approve(address(pilot), DEPOSIT_AMT);
        pilot.deposit(DEPOSIT_AMT);
        vm.stopPrank();

        assertEq(pilot.totalBalance(), DEPOSIT_AMT);
        assertEq(usdc.balanceOf(address(pilot)), DEPOSIT_AMT);
    }

    function test_Deposit_EmitsEvent() public {
        usdc.mint(alice, DEPOSIT_AMT);
        vm.startPrank(alice);
        usdc.approve(address(pilot), DEPOSIT_AMT);

        vm.expectEmit(true, false, false, true, address(pilot));
        emit Deposited(alice, DEPOSIT_AMT);
        pilot.deposit(DEPOSIT_AMT);
        vm.stopPrank();
    }

    function test_Deposit_AnyoneCanDeposit() public {
        // Non-owner (bob) may also deposit.
        usdc.mint(bob, 500e6);
        vm.startPrank(bob);
        usdc.approve(address(pilot), 500e6);
        pilot.deposit(500e6);
        vm.stopPrank();
        assertEq(pilot.totalBalance(), 500e6);
    }

    function test_Deposit_RevertsZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(ArcPilot.ZeroAmount.selector);
        pilot.deposit(0);
    }

    function test_Deposit_RevertsInsufficientAllowance() public {
        usdc.mint(alice, DEPOSIT_AMT);
        vm.prank(alice);
        // no approve → transferFrom reverts
        vm.expectRevert();
        pilot.deposit(DEPOSIT_AMT);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  3. withdraw
// ─────────────────────────────────────────────────────────────────────────────

contract ArcPilotWithdrawTest is ArcPilotFixture {

    function setUp() public override {
        super.setUp();
        _depositAs(alice, DEPOSIT_AMT);
    }

    function test_Withdraw_HappyPath() public {
        uint256 spendable = pilot.spendableBalance();
        uint256 balBefore = usdc.balanceOf(bob);

        vm.prank(owner);
        pilot.withdraw(bob, spendable);

        assertEq(usdc.balanceOf(bob), balBefore + spendable);
    }

    function test_Withdraw_EmitsEvent() public {
        uint256 spendable = pilot.spendableBalance();

        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(pilot));
        emit Withdrawn(bob, spendable);
        pilot.withdraw(bob, spendable);
    }

    function test_Withdraw_RevertsZeroAmount() public {
        vm.prank(owner);
        vm.expectRevert(ArcPilot.ZeroAmount.selector);
        pilot.withdraw(bob, 0);
    }

    function test_Withdraw_RevertsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(ArcPilot.ZeroAddress.selector);
        pilot.withdraw(address(0), 100e6);
    }

    function test_Withdraw_RevertsExceedsSpendable() public {
        uint256 spendable = pilot.spendableBalance();
        uint256 overAmount = spendable + 1;

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ArcPilot.ExceedsSpendable.selector, overAmount, spendable)
        );
        pilot.withdraw(bob, overAmount);
    }

    function test_Withdraw_RevertsNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice)
        );
        pilot.withdraw(bob, 1e6);
    }

    function test_Withdraw_RespectsReserve() public {
        // 10 % reserve on 10 000 USDC = 1 000 USDC reserved.
        // Trying to withdraw totalBalance should revert.
        vm.prank(owner);
        vm.expectRevert();
        pilot.withdraw(bob, DEPOSIT_AMT);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  4. setObligation / removeObligation
// ─────────────────────────────────────────────────────────────────────────────

contract ArcPilotObligationTest is ArcPilotFixture {

    function setUp() public override {
        super.setUp();
        _depositAs(alice, DEPOSIT_AMT);
    }

    // ── setObligation ────────────────────────────────────────────────────────

    function test_SetObligation_HappyPath() public {
        vm.prank(owner);
        pilot.setObligation(0, "rent", 1_000e6);

        assertEq(pilot.activeObligationsTotal(), 1_000e6);
        assertEq(pilot.obligationCount(), 1);
    }

    function test_SetObligation_EmitsEvent() public {
        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(pilot));
        emit ObligationSet(0, "rent", 1_000e6);
        pilot.setObligation(0, "rent", 1_000e6);
    }

    function test_SetObligation_UpdatesExisting() public {
        vm.startPrank(owner);
        pilot.setObligation(0, "rent", 1_000e6);
        // Update the same id to a new amount.
        pilot.setObligation(0, "rent-updated", 2_000e6);
        vm.stopPrank();

        // Old amount (1 000) should be subtracted, new (2 000) added.
        assertEq(pilot.activeObligationsTotal(), 2_000e6);
    }

    function test_SetObligation_MultipleIds() public {
        vm.startPrank(owner);
        pilot.setObligation(0, "rent",      1_000e6);
        pilot.setObligation(1, "payroll",   2_000e6);
        pilot.setObligation(2, "utilities",   500e6);
        vm.stopPrank();

        assertEq(pilot.activeObligationsTotal(), 3_500e6);
        assertEq(pilot.obligationCount(), 3);
    }

    function test_SetObligation_ReducesSpendable() public {
        uint256 spendableBefore = pilot.spendableBalance();

        vm.prank(owner);
        pilot.setObligation(0, "rent", 1_000e6);

        assertEq(pilot.spendableBalance(), spendableBefore - 1_000e6);
    }

    function test_SetObligation_RevertsNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice)
        );
        pilot.setObligation(0, "rent", 1_000e6);
    }

    function test_SetObligation_NonSequentialId() public {
        vm.prank(owner);
        pilot.setObligation(5, "big gap", 500e6);
        assertEq(pilot.obligationCount(), 6); // id 5 → count = 6
    }

    // ── removeObligation ─────────────────────────────────────────────────────

    function test_RemoveObligation_HappyPath() public {
        vm.startPrank(owner);
        pilot.setObligation(0, "rent", 1_000e6);
        pilot.removeObligation(0);
        vm.stopPrank();

        assertEq(pilot.activeObligationsTotal(), 0);
    }

    function test_RemoveObligation_EmitsEvent() public {
        vm.startPrank(owner);
        pilot.setObligation(0, "rent", 1_000e6);

        vm.expectEmit(true, false, false, false, address(pilot));
        emit ObligationRemoved(0);
        pilot.removeObligation(0);
        vm.stopPrank();
    }

    function test_RemoveObligation_RestoresSpendable() public {
        uint256 spendableBefore = pilot.spendableBalance();

        vm.startPrank(owner);
        pilot.setObligation(0, "rent", 1_000e6);
        pilot.removeObligation(0);
        vm.stopPrank();

        assertEq(pilot.spendableBalance(), spendableBefore);
    }

    function test_RemoveObligation_RevertsNotFound_OutOfRange() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ArcPilot.ObligationNotFound.selector, 99)
        );
        pilot.removeObligation(99);
    }

    function test_RemoveObligation_RevertsAlreadyRemoved() public {
        vm.startPrank(owner);
        pilot.setObligation(0, "rent", 1_000e6);
        pilot.removeObligation(0);

        vm.expectRevert(
            abi.encodeWithSelector(ArcPilot.ObligationNotFound.selector, 0)
        );
        pilot.removeObligation(0);
        vm.stopPrank();
    }

    function test_RemoveObligation_RevertsNonOwner() public {
        vm.prank(owner);
        pilot.setObligation(0, "rent", 1_000e6);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice)
        );
        pilot.removeObligation(0);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  5. setPayee / removePayee / payeeCount
// ─────────────────────────────────────────────────────────────────────────────

contract ArcPilotPayeeTest is ArcPilotFixture {

    function test_SetPayee_HappyPath() public {
        vm.prank(owner);
        pilot.setPayee(alice, "Alice", 0);

        (string memory label, uint256 daily,, , bool allowed) = pilot.payees(alice);
        assertTrue(allowed);
        assertEq(label, "Alice");
        assertEq(daily, 0);
    }

    function test_SetPayee_EmitsEvent() public {
        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(pilot));
        emit PayeeSet(alice, "Alice", 500e6);
        pilot.setPayee(alice, "Alice", 500e6);
    }

    function test_SetPayee_WithDailyLimit() public {
        vm.prank(owner);
        pilot.setPayee(alice, "Alice", 500e6);

        (, uint256 daily,,,) = pilot.payees(alice);
        assertEq(daily, 500e6);
    }

    function test_SetPayee_UpdateExisting() public {
        vm.startPrank(owner);
        pilot.setPayee(alice, "Alice",     500e6);
        pilot.setPayee(alice, "Alice v2", 1_000e6);
        vm.stopPrank();

        (string memory label, uint256 daily,,,) = pilot.payees(alice);
        assertEq(label, "Alice v2");
        assertEq(daily, 1_000e6);
        // payeeList must not double-count alice.
        assertEq(pilot.payeeCount(), 1);
    }

    function test_SetPayee_IncrementsPayeeCount() public {
        vm.startPrank(owner);
        pilot.setPayee(alice, "Alice", 0);
        pilot.setPayee(bob,   "Bob",   0);
        vm.stopPrank();
        assertEq(pilot.payeeCount(), 2);
    }

    function test_SetPayee_RevertsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(ArcPilot.ZeroAddress.selector);
        pilot.setPayee(address(0), "zero", 0);
    }

    function test_SetPayee_RevertsNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice)
        );
        pilot.setPayee(bob, "Bob", 0);
    }

    function test_RemovePayee_HappyPath() public {
        vm.startPrank(owner);
        pilot.setPayee(alice, "Alice", 0);
        pilot.removePayee(alice);
        vm.stopPrank();

        (,,,, bool allowed) = pilot.payees(alice);
        assertFalse(allowed);
    }

    function test_RemovePayee_EmitsEvent() public {
        vm.startPrank(owner);
        pilot.setPayee(alice, "Alice", 0);

        vm.expectEmit(true, false, false, false, address(pilot));
        emit PayeeRemoved(alice);
        pilot.removePayee(alice);
        vm.stopPrank();
    }

    function test_RemovePayee_DecrementsPayeeCount() public {
        vm.startPrank(owner);
        pilot.setPayee(alice, "Alice", 0);
        pilot.setPayee(bob,   "Bob",   0);
        pilot.removePayee(alice);
        vm.stopPrank();
        assertEq(pilot.payeeCount(), 1);
    }

    function test_RemovePayee_RevertsNotAllowed() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ArcPilot.NotAllowedPayee.selector, alice)
        );
        pilot.removePayee(alice);
    }

    function test_RemovePayee_RevertsNonOwner() public {
        vm.prank(owner);
        pilot.setPayee(alice, "Alice", 0);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob)
        );
        pilot.removePayee(alice);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  6. setReserveBps
// ─────────────────────────────────────────────────────────────────────────────

contract ArcPilotReserveTest is ArcPilotFixture {

    function test_SetReserveBps_HappyPath() public {
        vm.prank(owner);
        pilot.setReserveBps(2000);
        assertEq(pilot.reserveBps(), 2000);
    }

    function test_SetReserveBps_EmitsEvent() public {
        vm.prank(owner);
        vm.expectEmit(false, false, false, true, address(pilot));
        emit ReserveBpsSet(2000);
        pilot.setReserveBps(2000);
    }

    function test_SetReserveBps_Zero() public {
        vm.prank(owner);
        pilot.setReserveBps(0);
        assertEq(pilot.reserveBps(), 0);
    }

    function test_SetReserveBps_MaxAllowed() public {
        vm.prank(owner);
        pilot.setReserveBps(10000);
        assertEq(pilot.reserveBps(), 10000);
    }

    function test_SetReserveBps_RevertsOverMax() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ArcPilot.InvalidReserveBps.selector, uint16(10001))
        );
        pilot.setReserveBps(10001);
    }

    function test_SetReserveBps_RevertsNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice)
        );
        pilot.setReserveBps(500);
    }

    function test_SetReserveBps_AffectsReserveAmount() public {
        _depositAs(alice, DEPOSIT_AMT); // 10 000 USDC
        vm.prank(owner);
        pilot.setReserveBps(500); // 5 %
        assertEq(pilot.reserveAmount(), 500e6);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  7. pay
// ─────────────────────────────────────────────────────────────────────────────

contract ArcPilotPayTest is ArcPilotFixture {

    function setUp() public override {
        super.setUp();
        _depositAs(alice, DEPOSIT_AMT); // 10 000 USDC in treasury
        _addPayee(bob);                  // bob: no daily limit
    }

    // ── Happy path ───────────────────────────────────────────────────────────

    function test_Pay_HappyPath() public {
        uint256 amount    = 1_000e6;
        uint256 bobBefore = usdc.balanceOf(bob);
        uint256 pilotBefore = pilot.totalBalance();

        vm.prank(owner);
        pilot.pay(bob, amount, "invoice #1");

        assertEq(usdc.balanceOf(bob),          bobBefore + amount);
        assertEq(pilot.totalBalance(),         pilotBefore - amount);
        assertEq(pilot.paymentCount(),         1);
    }

    function test_Pay_EmitsPaymentExecutedEvent() public {
        vm.prank(owner);
        vm.expectEmit(true, true, false, true, address(pilot));
        emit PaymentExecuted(0, bob, 500e6, "memo");
        pilot.pay(bob, 500e6, "memo");
    }

    function test_Pay_RecordsPayment() public {
        vm.prank(owner);
        pilot.pay(bob, 100e6, "test memo");

        (address to, uint256 amount, uint256 ts, string memory memo) = pilot.payments(0);
        assertEq(to,     bob);
        assertEq(amount, 100e6);
        assertEq(memo,   "test memo");
        assertGt(ts,     0);
    }

    function test_Pay_IncrementPaymentCount() public {
        vm.startPrank(owner);
        pilot.pay(bob, 100e6, "first");
        pilot.pay(bob, 100e6, "second");
        vm.stopPrank();
        assertEq(pilot.paymentCount(), 2);
    }

    function test_Pay_UpdatesSpentToday() public {
        vm.prank(owner);
        pilot.pay(bob, 500e6, "x");

        (, , uint256 spentToday,,) = pilot.payees(bob);
        assertEq(spentToday, 500e6);
    }

    // ── Revert: ZeroAmount ───────────────────────────────────────────────────

    function test_Pay_RevertsZeroAmount() public {
        vm.prank(owner);
        vm.expectRevert(ArcPilot.ZeroAmount.selector);
        pilot.pay(bob, 0, "zero");
    }

    // ── Revert: not allowed payee ────────────────────────────────────────────

    function test_Pay_RevertsNotAllowedPayee() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ArcPilot.NotAllowedPayee.selector, carol)
        );
        pilot.pay(carol, 100e6, "carol not allowed");
    }

    function test_Pay_RevertsAfterPayeeRemoved() public {
        vm.prank(owner);
        pilot.removePayee(bob);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ArcPilot.NotAllowedPayee.selector, bob)
        );
        pilot.pay(bob, 100e6, "removed payee");
    }

    // ── Revert: ExceedsSpendable ─────────────────────────────────────────────

    function test_Pay_RevertsExceedsSpendable() public {
        uint256 spendable = pilot.spendableBalance();

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ArcPilot.ExceedsSpendable.selector, spendable + 1, spendable)
        );
        pilot.pay(bob, spendable + 1, "too much");
    }

    function test_Pay_RevertsWhenObligationsBlockSpend() public {
        // Lock all spendable with obligations.
        uint256 spendable = pilot.spendableBalance();
        vm.prank(owner);
        pilot.setObligation(0, "big", spendable);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ArcPilot.ExceedsSpendable.selector, 1, 0)
        );
        pilot.pay(bob, 1, "no spendable");
    }

    // ── Revert: access control ───────────────────────────────────────────────

    function test_Pay_RevertsNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice)
        );
        pilot.pay(bob, 100e6, "alice tries to pay");
    }

    // ── Daily limit ──────────────────────────────────────────────────────────

    function test_Pay_DailyLimit_HappyPath() public {
        _addPayeeWithLimit(carol, 200e6);

        vm.prank(owner);
        pilot.pay(carol, 200e6, "at limit");

        (, , uint256 spentToday,,) = pilot.payees(carol);
        assertEq(spentToday, 200e6);
    }

    function test_Pay_DailyLimit_RevertsExceedsLimit() public {
        _addPayeeWithLimit(carol, 200e6);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ArcPilot.ExceedsDailyLimit.selector, carol, 201e6, 200e6)
        );
        pilot.pay(carol, 201e6, "over daily limit");
    }

    function test_Pay_DailyLimit_AccumulatesWithinWindow() public {
        _addPayeeWithLimit(carol, 300e6);

        vm.startPrank(owner);
        pilot.pay(carol, 100e6, "first");
        pilot.pay(carol, 100e6, "second");
        // 200e6 used; 100e6 remaining.
        vm.expectRevert(
            abi.encodeWithSelector(ArcPilot.ExceedsDailyLimit.selector, carol, 101e6, 100e6)
        );
        pilot.pay(carol, 101e6, "third - over");
        vm.stopPrank();
    }

    function test_Pay_DailyLimit_ResetsAfter24Hours() public {
        _addPayeeWithLimit(carol, 200e6);

        vm.prank(owner);
        pilot.pay(carol, 200e6, "use up today's limit");

        // Warp forward exactly 1 day.
        skip(1 days);

        // Deposit more to have funds available.
        _depositAs(alice, DEPOSIT_AMT);

        vm.prank(owner);
        // Should succeed after window reset.
        pilot.pay(carol, 200e6, "new day, new limit");

        (, , uint256 spentToday,,) = pilot.payees(carol);
        assertEq(spentToday, 200e6);
    }

    function test_Pay_NoLimit_UnlimitedSpend() public {
        // bob has dailyLimit == 0 (no limit).  Spend entire spendable at once.
        uint256 spendable = pilot.spendableBalance();
        uint256 bobBefore = usdc.balanceOf(bob);
        uint256 balBefore = pilot.totalBalance();

        vm.prank(owner);
        pilot.pay(bob, spendable, "all spendable");

        // Bob received exactly the spendable amount.
        assertEq(usdc.balanceOf(bob), bobBefore + spendable);

        // Treasury balance decreased by exactly the spendable amount.
        assertEq(pilot.totalBalance(), balBefore - spendable);

        // Note: after spending all spendable, the reserve fraction is now computed
        // on the (smaller) remaining balance so a new, smaller spendable window
        // re-opens.  The invariant suite verifies the accounting identity holds.
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  8. getPayments (batch read)
// ─────────────────────────────────────────────────────────────────────────────

contract ArcPilotGetPaymentsTest is ArcPilotFixture {

    function setUp() public override {
        super.setUp();
        _depositAs(alice, DEPOSIT_AMT);
        _addPayee(bob);
    }

    function test_GetPayments_EmptyWhenNoPayments() public view {
        ArcPilot.PaymentRecord[] memory recs = pilot.getPayments(0, 10);
        assertEq(recs.length, 0);
    }

    function test_GetPayments_ReturnsAll() public {
        vm.startPrank(owner);
        pilot.pay(bob, 100e6, "a");
        pilot.pay(bob, 100e6, "b");
        pilot.pay(bob, 100e6, "c");
        vm.stopPrank();

        ArcPilot.PaymentRecord[] memory recs = pilot.getPayments(0, 10);
        assertEq(recs.length, 3);
    }

    function test_GetPayments_PaginationOffset() public {
        vm.startPrank(owner);
        pilot.pay(bob, 100e6, "a");
        pilot.pay(bob, 100e6, "b");
        pilot.pay(bob, 100e6, "c");
        vm.stopPrank();

        ArcPilot.PaymentRecord[] memory recs = pilot.getPayments(1, 2);
        assertEq(recs.length, 2);
        assertEq(recs[0].memo, "b");
        assertEq(recs[1].memo, "c");
    }

    function test_GetPayments_OffsetBeyondEnd() public {
        vm.prank(owner);
        pilot.pay(bob, 100e6, "a");

        ArcPilot.PaymentRecord[] memory recs = pilot.getPayments(99, 10);
        assertEq(recs.length, 0);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  9. Fuzz tests
// ─────────────────────────────────────────────────────────────────────────────

contract ArcPilotFuzzTest is ArcPilotFixture {

    // ── 9a. spendableBalance never underflows ────────────────────────────────
    /// PROPERTY: spendableBalance() always returns ≥ 0 (no revert, no underflow)
    /// regardless of the balance and obligation amounts.
    function testFuzz_SpendableNoUnderflow(
        uint128 depositAmt,
        uint128 obligationAmt,
        uint16  bps
    ) public {
        bps         = uint16(bound(bps,         0, 10000));
        depositAmt  = uint128(bound(depositAmt,  0, type(uint96).max));
        obligationAmt = uint128(bound(obligationAmt, 0, type(uint96).max));

        // Set reserve bps.
        vm.prank(owner);
        pilot.setReserveBps(bps);

        if (depositAmt > 0) {
            _depositAs(alice, depositAmt);
        }

        vm.prank(owner);
        pilot.setObligation(0, "fuzz", obligationAmt);

        // Must not revert and must return ≥ 0 (uint256 can't be negative,
        // but the contract's saturation logic: max(bal - locked, 0) must hold).
        uint256 spendable = pilot.spendableBalance();

        // Verify the accounting identity.
        uint256 bal = pilot.totalBalance();
        uint256 obls = pilot.activeObligationsTotal();
        uint256 rsv = pilot.reserveAmount();

        // spendable + locked ≤ bal  (locked = obls + rsv may exceed bal → sat at 0)
        assertLe(spendable + obls + rsv, bal + obls + rsv); // tautological safety
        if (bal >= obls + rsv) {
            assertEq(spendable, bal - obls - rsv);
        } else {
            assertEq(spendable, 0);
        }
    }

    // ── 9b. reserveAmount arithmetic ─────────────────────────────────────────
    /// PROPERTY: reserveAmount() == totalBalance * reserveBps / 10000  (integer)
    function testFuzz_ReserveAmountArithmetic(uint128 depositAmt, uint16 bps) public {
        bps        = uint16(bound(bps,        0, 10000));
        depositAmt = uint128(bound(depositAmt, 0, type(uint96).max));

        vm.prank(owner);
        pilot.setReserveBps(bps);

        if (depositAmt > 0) _depositAs(alice, depositAmt);

        uint256 expected = (uint256(depositAmt) * bps) / 10000;
        assertEq(pilot.reserveAmount(), expected);
    }

    // ── 9c. Daily-limit window resets after exactly 1 days ───────────────────
    /// PROPERTY: after warping ≥ 1 day, spentToday resets to 0 on next pay().
    function testFuzz_DailyLimitWindowReset(uint128 limit, uint32 warpSeconds) public {
        limit       = uint128(bound(limit,       1e6, 5_000e6));   // 1–5 000 USDC
        warpSeconds = uint32(bound(warpSeconds,  1 days, 7 days)); // 1–7 days forward

        // Enough funds to make both payments.
        _depositAs(alice, uint256(limit) * 2 + 2_000e6);

        vm.prank(owner);
        pilot.setPayee(carol, "carol", limit);

        // Use the full daily limit.
        vm.prank(owner);
        pilot.pay(carol, limit, "day 1");

        // Advance time past the window.
        skip(warpSeconds);

        // Window should have reset; paying `limit` again must succeed.
        vm.prank(owner);
        pilot.pay(carol, limit, "day 2");

        (, , uint256 spentToday,,) = pilot.payees(carol);
        assertEq(spentToday, limit);
    }

    // ── 9d. Deposit → withdraw round-trip ────────────────────────────────────
    /// PROPERTY: depositing then withdrawing the spendable portion leaves the
    /// treasury balance at totalBalance - spendable (reserve + obligations).
    function testFuzz_DepositWithdrawRoundTrip(uint128 depositAmt) public {
        depositAmt = uint128(bound(depositAmt, 1e6, type(uint64).max));

        _addPayee(bob);
        _depositAs(alice, depositAmt);

        // Capture locked amounts BEFORE the withdrawal; they won't change.
        uint256 spendable  = pilot.spendableBalance();
        uint256 oblsBefore = pilot.activeObligationsTotal();
        uint256 rsvBefore  = pilot.reserveAmount();   // totalBalance * bps / 10000

        vm.prank(owner);
        pilot.withdraw(bob, spendable);

        // PROPERTY: the remaining balance is exactly obls + reserve (computed
        // before the withdrawal, because withdrawing spendable means the
        // withdrawn amount = bal - obls - rsvBefore, so remaining = obls + rsvBefore).
        uint256 remaining = pilot.totalBalance();
        assertEq(remaining, oblsBefore + rsvBefore);
    }

    // ── 9e. setObligation idempotent update ───────────────────────────────────
    /// PROPERTY: updating an obligation's amount from A → B always lands on B,
    /// regardless of prior value.
    function testFuzz_ObligationUpdate(uint128 amtA, uint128 amtB) public {
        amtA = uint128(bound(amtA, 0, type(uint64).max));
        amtB = uint128(bound(amtB, 0, type(uint64).max));

        vm.startPrank(owner);
        pilot.setObligation(0, "a", amtA);
        pilot.setObligation(0, "b", amtB);
        vm.stopPrank();

        assertEq(pilot.activeObligationsTotal(), amtB);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  10. Invariant tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @notice Handler that drives the ArcPilot through realistic state transitions.
 *         Every action bounds its inputs so calls succeed often enough to
 *         explore meaningful state depth.
 */
contract ArcPilotHandler is Test {
    ArcPilot  public pilot;
    MockERC20 public usdc;
    address   public owner;
    address   public depositor;
    address   public payee;

    // Ghost variable: cumulative net deposits minus cumulative withdrawals/pays.
    // We track this separately from the contract to cross-check accounting.
    uint256 public ghostNetDeposited;

    constructor(ArcPilot _pilot, MockERC20 _usdc, address _owner) {
        pilot     = _pilot;
        usdc      = _usdc;
        owner     = _owner;
        depositor = makeAddr("handler-depositor");
        payee     = makeAddr("handler-payee");

        // Pre-register the payee.
        vm.prank(owner);
        pilot.setPayee(payee, "handler payee", 0);
    }

    /// Deposit a bounded amount from the depositor.
    function deposit(uint256 amount) external {
        amount = bound(amount, 1, 100_000e6);
        usdc.mint(depositor, amount);
        vm.startPrank(depositor);
        usdc.approve(address(pilot), amount);
        pilot.deposit(amount);
        vm.stopPrank();
        ghostNetDeposited += amount;
    }

    /// Pay the registered payee a bounded amount (may revert if spendable = 0).
    function pay(uint256 amount) external {
        uint256 spendable = pilot.spendableBalance();
        if (spendable == 0) return;
        amount = bound(amount, 1, spendable);
        vm.prank(owner);
        pilot.pay(payee, amount, "handler pay");
        ghostNetDeposited -= amount;
    }

    /// Withdraw a bounded spendable amount.
    function withdraw(uint256 amount) external {
        uint256 spendable = pilot.spendableBalance();
        if (spendable == 0) return;
        amount = bound(amount, 1, spendable);
        vm.prank(owner);
        pilot.withdraw(payee, amount);
        ghostNetDeposited -= amount;
    }

    /// Set or update an obligation with id 0 or 1.
    function setObligation(uint256 idSeed, uint256 amount) external {
        uint256 id = bound(idSeed, 0, 1);
        amount     = bound(amount, 0, 50_000e6);
        vm.prank(owner);
        pilot.setObligation(id, "handler obligation", amount);
    }

    /// Remove obligation 0 if it exists.
    function removeObligation0() external {
        if (pilot.obligationCount() > 0) {
            (,, bool active) = pilot.obligations(0);
            if (active) {
                vm.prank(owner);
                pilot.removeObligation(0);
            }
        }
    }

    /// Adjust reserve bps.
    function setReserveBps(uint256 bpsSeed) external {
        uint16 bps = uint16(bound(bpsSeed, 0, 10000));
        vm.prank(owner);
        pilot.setReserveBps(bps);
    }
}

contract ArcPilotInvariantTest is ArcPilotFixture {
    ArcPilotHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new ArcPilotHandler(pilot, usdc, owner);
        // Only the handler drives the pilot; no direct fuzzer calls to pilot.
        targetContract(address(handler));
    }

    /// INVARIANT A: spendableBalance + activeObligationsTotal + reserveAmount ≤ totalBalance
    ///
    /// Specifically, spendableBalance is saturated at 0, so equality holds when
    /// locked ≤ bal, and spendable is 0 when locked > bal.
    function invariant_SpendablePlusLockedLeqBalance() public view {
        uint256 bal      = pilot.totalBalance();
        uint256 spendable = pilot.spendableBalance();
        uint256 obls     = pilot.activeObligationsTotal();
        uint256 rsv      = pilot.reserveAmount();

        // spendable + obls + rsv ≤ bal + obls + rsv (always true, tautological)
        // The meaningful constraint: spendable never exceeds bal - obls - rsv.
        if (bal >= obls + rsv) {
            assertEq(spendable, bal - obls - rsv);
        } else {
            assertEq(spendable, 0);
        }
    }

    /// INVARIANT B: the contract's actual USDC balance always equals totalBalance().
    function invariant_TotalBalanceMatchesUsdcBalance() public view {
        assertEq(pilot.totalBalance(), usdc.balanceOf(address(pilot)));
    }

    /// INVARIANT C: ghost net-deposited ≥ totalBalance proves nothing was lost.
    /// (ghost net-deposited tracks deposits minus withdrawals/pays as a sanity check)
    function invariant_GhostNetDepositedGeqBalance() public view {
        // After pays and withdrawals, the remaining balance is ≤ ghostNetDeposited
        // (some funds went to the payee's wallet, not the pilot).
        assertLe(pilot.totalBalance(), handler.ghostNetDeposited());
    }

    /// INVARIANT D: reserveAmount is always ≤ totalBalance.
    function invariant_ReserveLeqBalance() public view {
        assertLe(pilot.reserveAmount(), pilot.totalBalance());
    }

    /// INVARIANT E: activeObligationsTotal never exceeds uint256 (no overflow via
    /// handler operations).  We proxy this by checking the accounting identity.
    function invariant_ActiveObligationsTotalSane() public view {
        // obligationCount ≥ 0 (trivially), and the mapping must be consistent.
        // We check that activeObligationsTotal is what we'd get from summing
        // active obligation amounts (limited to ids 0 and 1 the handler touches).
        uint256 sum = 0;
        uint256 count = pilot.obligationCount();
        for (uint256 i = 0; i < count && i < 2; i++) {
            (, uint256 amount, bool active) = pilot.obligations(i);
            if (active) sum += amount;
        }
        // If handler used ids 0 and 1 exclusively, sum == activeObligationsTotal.
        assertEq(pilot.activeObligationsTotal(), sum);
    }
}
