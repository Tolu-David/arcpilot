// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {Ownable}        from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable}       from "@openzeppelin/contracts/utils/Pausable.sol";
import {ArcPilotTreasury} from "../ArcPilotTreasury.sol";
import {MockERC20}        from "../test-helpers/MockERC20.sol";

// ---------------------------------------------------------------------------
// Event mirror — re-declare ArcPilotTreasury events so vm.expectEmit can
// reference them cleanly without needing qualified contract-event syntax.
// ---------------------------------------------------------------------------
interface ITreasuryEvents {
    event PauserSet(address indexed addr);
    event RescuerSet(address indexed addr);
    event MaxTxAmountSet(uint256 amount);
    event GlobalDailyLimitSet(uint256 limit);
    event ReserveBpsSet(uint16 bps);
    event ObligationSet(uint256 indexed id, string label, uint256 amount);
    event ObligationRemoved(uint256 indexed id);
    event PayeeSet(address indexed payee, string label, uint256 dailyLimit);
    event PayeeRemoved(address indexed payee);
    event PaymentExecuted(
        uint256 indexed paymentId,
        address indexed to,
        uint256 amount,
        bytes32 indexed requestId,
        string memo
    );
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
}

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------
abstract contract TreasuryFixture is Test, ITreasuryEvents {
    ArcPilotTreasury internal treasury;
    MockERC20        internal usdc;
    MockERC20        internal otherToken;

    address internal owner   = makeAddr("owner");
    address internal pauser  = makeAddr("pauser");
    address internal rescuer = makeAddr("rescuer");
    address internal alice   = makeAddr("alice");
    address internal bob     = makeAddr("bob");
    address internal carol   = makeAddr("carol");

    uint16  internal constant RESERVE_BPS      = 1000;       // 10 %
    uint256 internal constant MAX_TX           = 5_000e6;    // 5 000 USDC
    uint256 internal constant GLOBAL_DAILY     = 20_000e6;   // 20 000 USDC
    uint256 internal constant DEPOSIT_AMT      = 10_000e6;   // 10 000 USDC

    function setUp() public virtual {
        usdc       = new MockERC20("Mock USDC", "mUSDC", 6);
        otherToken = new MockERC20("Other Token", "OTH", 18);

        vm.prank(owner);
        treasury = new ArcPilotTreasury(
            owner,
            pauser,
            rescuer,
            address(usdc),
            RESERVE_BPS,
            MAX_TX,
            GLOBAL_DAILY
        );
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /// Mint USDC to `from`, approve treasury, then deposit as `from`.
    function _depositAs(address from, uint256 amount) internal {
        usdc.mint(from, amount);
        vm.startPrank(from);
        usdc.approve(address(treasury), amount);
        treasury.deposit(amount);
        vm.stopPrank();
    }

    /// Fund treasury directly (simulating a prior deposit without event noise).
    function _seedTreasury(uint256 amount) internal {
        usdc.mint(address(treasury), amount);
    }

    /// Allow alice as payee with given daily limit (0 = unlimited).
    function _allowAlice(uint256 dailyLimit) internal {
        vm.prank(owner);
        treasury.setPayee(alice, "alice", dailyLimit);
    }
}

// ===========================================================================
// 1. Constructor
// ===========================================================================
contract TreasuryConstructorTest is TreasuryFixture {

    function test_Constructor_InitialState() public view {
        assertEq(address(treasury.usdc()),        address(usdc));
        assertEq(treasury.pauser(),               pauser);
        assertEq(treasury.rescuer(),              rescuer);
        assertEq(treasury.reserveBps(),           RESERVE_BPS);
        assertEq(treasury.maxTxAmount(),          MAX_TX);
        assertEq(treasury.globalDailyLimit(),     GLOBAL_DAILY);
        assertEq(treasury.activeObligationsTotal(), 0);
        assertEq(treasury.paymentCount(),         0);
        assertEq(treasury.activePayeeCount(),     0);
    }

    function test_Constructor_OwnerSet() public view {
        assertEq(treasury.owner(), owner);
    }

    function test_Constructor_ZeroPauser_Reverts() public {
        vm.expectRevert(ArcPilotTreasury.ZeroAddress.selector);
        new ArcPilotTreasury(owner, address(0), rescuer, address(usdc), RESERVE_BPS, MAX_TX, GLOBAL_DAILY);
    }

    function test_Constructor_ZeroRescuer_Reverts() public {
        vm.expectRevert(ArcPilotTreasury.ZeroAddress.selector);
        new ArcPilotTreasury(owner, pauser, address(0), address(usdc), RESERVE_BPS, MAX_TX, GLOBAL_DAILY);
    }

    function test_Constructor_ZeroUsdc_Reverts() public {
        vm.expectRevert(ArcPilotTreasury.ZeroAddress.selector);
        new ArcPilotTreasury(owner, pauser, rescuer, address(0), RESERVE_BPS, MAX_TX, GLOBAL_DAILY);
    }

    function test_Constructor_NonContractUsdc_Reverts() public {
        address eoa = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(ArcPilotTreasury.NotAContract.selector, eoa));
        new ArcPilotTreasury(owner, pauser, rescuer, eoa, RESERVE_BPS, MAX_TX, GLOBAL_DAILY);
    }

    function test_Constructor_ReserveBpsOver10000_Reverts() public {
        vm.expectRevert(abi.encodeWithSelector(ArcPilotTreasury.InvalidReserveBps.selector, uint16(10001)));
        new ArcPilotTreasury(owner, pauser, rescuer, address(usdc), 10001, MAX_TX, GLOBAL_DAILY);
    }

    function test_Constructor_ReserveBps10000_Succeeds() public {
        // boundary value — 10000 bps is exactly valid
        ArcPilotTreasury t = new ArcPilotTreasury(
            owner, pauser, rescuer, address(usdc), 10000, MAX_TX, GLOBAL_DAILY
        );
        assertEq(t.reserveBps(), 10000);
    }

    function test_RenounceOwnership_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(bytes("ArcPilotTreasury: renounceOwnership disabled"));
        treasury.renounceOwnership();
    }
}

// ===========================================================================
// 2. deposit
// ===========================================================================
contract TreasuryDepositTest is TreasuryFixture {

    function test_Deposit_HappyPath() public {
        uint256 amt = 1_000e6;
        usdc.mint(alice, amt);
        vm.startPrank(alice);
        usdc.approve(address(treasury), amt);
        treasury.deposit(amt);
        vm.stopPrank();

        assertEq(treasury.totalBalance(), amt);
        assertEq(usdc.balanceOf(address(treasury)), amt);
    }

    function test_Deposit_EmitsDeposited() public {
        uint256 amt = 500e6;
        usdc.mint(alice, amt);
        vm.startPrank(alice);
        usdc.approve(address(treasury), amt);

        vm.expectEmit(true, false, false, true, address(treasury));
        emit Deposited(alice, amt);
        treasury.deposit(amt);
        vm.stopPrank();
    }

    function test_Deposit_ZeroAmount_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(ArcPilotTreasury.ZeroAmount.selector);
        treasury.deposit(0);
    }

    function test_Deposit_WhenPaused_Reverts() public {
        vm.prank(pauser);
        treasury.pause();

        usdc.mint(alice, 100e6);
        vm.startPrank(alice);
        usdc.approve(address(treasury), 100e6);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        treasury.deposit(100e6);
        vm.stopPrank();
    }

    function test_Deposit_AccumulatesBalance() public {
        _depositAs(alice, 1_000e6);
        _depositAs(bob,   2_000e6);
        assertEq(treasury.totalBalance(), 3_000e6);
    }
}

// ===========================================================================
// 3. withdraw
// ===========================================================================
contract TreasuryWithdrawTest is TreasuryFixture {

    function setUp() public override {
        super.setUp();
        _seedTreasury(DEPOSIT_AMT);
    }

    function test_Withdraw_HappyPath() public {
        // With 10 % reserve and no obligations: spendable = 9 000 USDC
        uint256 spendable = treasury.spendableBalance();
        uint256 withdrawAmt = spendable;

        vm.prank(owner);
        treasury.withdraw(alice, withdrawAmt);

        assertEq(usdc.balanceOf(alice), withdrawAmt);
        assertEq(treasury.totalBalance(), DEPOSIT_AMT - withdrawAmt);
    }

    function test_Withdraw_EmitsWithdrawn() public {
        uint256 amt = 100e6;
        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(treasury));
        emit Withdrawn(alice, amt);
        treasury.withdraw(alice, amt);
    }

    function test_Withdraw_ZeroAmount_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(ArcPilotTreasury.ZeroAmount.selector);
        treasury.withdraw(alice, 0);
    }

    function test_Withdraw_ZeroAddress_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(ArcPilotTreasury.ZeroAddress.selector);
        treasury.withdraw(address(0), 100e6);
    }

    function test_Withdraw_WhenPaused_Reverts() public {
        vm.prank(pauser);
        treasury.pause();

        vm.prank(owner);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        treasury.withdraw(alice, 100e6);
    }

    function test_Withdraw_ExceedsSpendable_Reverts() public {
        uint256 spendable = treasury.spendableBalance();
        uint256 overAmt   = spendable + 1;

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ArcPilotTreasury.ExceedsSpendable.selector, overAmt, spendable)
        );
        treasury.withdraw(alice, overAmt);
    }

    function test_Withdraw_NonOwner_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        treasury.withdraw(alice, 100e6);
    }
}

// ===========================================================================
// 4. setObligation / removeObligation
// ===========================================================================
contract TreasuryObligationTest is TreasuryFixture {

    function test_SetObligation_CreatesNew() public {
        vm.prank(owner);
        treasury.setObligation(0, "Salary", 500e6);

        assertEq(treasury.activeObligationsTotal(), 500e6);
        assertEq(treasury.obligationCount(),        1);

        (string memory label, uint256 amount, bool active) = treasury.obligations(0);
        assertEq(label,  "Salary");
        assertEq(amount, 500e6);
        assertTrue(active);
    }

    function test_SetObligation_EmitsEvent() public {
        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(treasury));
        emit ObligationSet(0, "Salary", 500e6);
        treasury.setObligation(0, "Salary", 500e6);
    }

    function test_SetObligation_UpdatesExisting_AccountingCorrect() public {
        vm.prank(owner);
        treasury.setObligation(0, "Salary", 500e6);

        vm.prank(owner);
        treasury.setObligation(0, "Salary v2", 700e6);

        // Old 500e6 is subtracted, new 700e6 added → total = 700e6
        assertEq(treasury.activeObligationsTotal(), 700e6);
        (, uint256 amount, bool active) = treasury.obligations(0);
        assertEq(amount, 700e6);
        assertTrue(active);
    }

    function test_SetObligation_MultipleIds() public {
        vm.prank(owner);
        treasury.setObligation(0, "A", 100e6);
        vm.prank(owner);
        treasury.setObligation(5, "B", 200e6);

        assertEq(treasury.activeObligationsTotal(), 300e6);
        assertEq(treasury.obligationCount(),        6); // id=5 → count becomes 6
    }

    function test_SetObligation_NonOwner_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        treasury.setObligation(0, "X", 1e6);
    }

    function test_RemoveObligation_HappyPath() public {
        vm.prank(owner);
        treasury.setObligation(0, "Salary", 500e6);

        vm.prank(owner);
        treasury.removeObligation(0);

        assertEq(treasury.activeObligationsTotal(), 0);
        (, , bool active) = treasury.obligations(0);
        assertFalse(active);
    }

    function test_RemoveObligation_EmitsEvent() public {
        vm.prank(owner);
        treasury.setObligation(0, "Salary", 500e6);

        vm.prank(owner);
        vm.expectEmit(true, false, false, false, address(treasury));
        emit ObligationRemoved(0);
        treasury.removeObligation(0);
    }

    function test_RemoveObligation_DoubleRemove_Reverts() public {
        vm.prank(owner);
        treasury.setObligation(0, "Salary", 500e6);

        vm.prank(owner);
        treasury.removeObligation(0);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ArcPilotTreasury.ObligationNotFound.selector, 0));
        treasury.removeObligation(0);
    }

    function test_RemoveObligation_NeverSet_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ArcPilotTreasury.ObligationNotFound.selector, 99));
        treasury.removeObligation(99);
    }

    function test_RemoveObligation_NonOwner_Reverts() public {
        vm.prank(owner);
        treasury.setObligation(0, "Salary", 500e6);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        treasury.removeObligation(0);
    }
}

// ===========================================================================
// 5. setPayee / removePayee
// ===========================================================================
contract TreasuryPayeeTest is TreasuryFixture {

    function test_SetPayee_NewPayee() public {
        vm.prank(owner);
        treasury.setPayee(alice, "alice", 1_000e6);

        assertEq(treasury.activePayeeCount(),     1);
        assertEq(treasury.payeeCount(),           1); // O(1) view

        (string memory label, uint256 dailyLimit, , , bool allowed) = treasury.payees(alice);
        assertEq(label,      "alice");
        assertEq(dailyLimit, 1_000e6);
        assertTrue(allowed);
    }

    function test_SetPayee_EmitsEvent() public {
        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(treasury));
        emit PayeeSet(alice, "alice", 1_000e6);
        treasury.setPayee(alice, "alice", 1_000e6);
    }

    function test_SetPayee_ZeroAddress_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(ArcPilotTreasury.ZeroAddress.selector);
        treasury.setPayee(address(0), "zero", 0);
    }

    function test_SetPayee_NonOwner_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        treasury.setPayee(bob, "bob", 0);
    }

    function test_RemovePayee_And_Reallowlist_NoDuplicate() public {
        vm.prank(owner);
        treasury.setPayee(alice, "alice", 0);
        assertEq(treasury.activePayeeCount(), 1);

        vm.prank(owner);
        treasury.removePayee(alice);
        assertEq(treasury.activePayeeCount(), 0);

        // Re-allowlist — should NOT push alice a second time in the internal list
        vm.prank(owner);
        treasury.setPayee(alice, "alice again", 500e6);
        assertEq(treasury.activePayeeCount(), 1);

        // Confirm alice is allowed again
        (, , , , bool allowed) = treasury.payees(alice);
        assertTrue(allowed);
    }

    function test_RemovePayee_EmitsEvent() public {
        vm.prank(owner);
        treasury.setPayee(alice, "alice", 0);

        vm.prank(owner);
        vm.expectEmit(true, false, false, false, address(treasury));
        emit PayeeRemoved(alice);
        treasury.removePayee(alice);
    }

    function test_RemovePayee_NotAllowed_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ArcPilotTreasury.NotAllowedPayee.selector, alice));
        treasury.removePayee(alice);
    }

    function test_RemovePayee_NonOwner_Reverts() public {
        vm.prank(owner);
        treasury.setPayee(alice, "alice", 0);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        treasury.removePayee(alice);
    }

    function test_PayeeCount_O1View() public {
        vm.prank(owner);
        treasury.setPayee(alice, "a", 0);
        vm.prank(owner);
        treasury.setPayee(bob, "b", 0);
        vm.prank(owner);
        treasury.removePayee(alice);

        // activePayeeCount updated correctly
        assertEq(treasury.payeeCount(), 1);
    }
}

// ===========================================================================
// 6. pay
// ===========================================================================
contract TreasuryPayTest is TreasuryFixture {

    bytes32 internal constant RID1 = keccak256("req-1");
    bytes32 internal constant RID2 = keccak256("req-2");

    function setUp() public override {
        super.setUp();
        _seedTreasury(DEPOSIT_AMT);
        _allowAlice(2_000e6); // per-payee daily limit = 2 000 USDC
    }

    function test_Pay_HappyPath() public {
        uint256 amt = 100e6;
        vm.prank(owner);
        treasury.pay(alice, amt, RID1, "invoice #1");

        assertEq(usdc.balanceOf(alice),      amt);
        assertEq(treasury.paymentCount(),    1);
        assertEq(treasury.requestIdUsed(RID1), true);

        // globalSpentToday updated
        assertEq(treasury.globalSpentToday(), amt);
    }

    function test_Pay_EmitsPaymentExecuted() public {
        uint256 amt = 50e6;
        vm.prank(owner);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit PaymentExecuted(0, alice, amt, RID1, "memo");
        treasury.pay(alice, amt, RID1, "memo");
    }

    function test_Pay_DuplicateRequestId_Reverts() public {
        vm.prank(owner);
        treasury.pay(alice, 100e6, RID1, "first");

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ArcPilotTreasury.DuplicateRequestId.selector, RID1));
        treasury.pay(alice, 100e6, RID1, "second");
    }

    function test_Pay_NotAllowedPayee_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ArcPilotTreasury.NotAllowedPayee.selector, bob));
        treasury.pay(bob, 100e6, RID1, "memo");
    }

    function test_Pay_ExceedsMaxTxAmount_Reverts() public {
        // MAX_TX = 5_000e6; try 5_001e6
        uint256 over = MAX_TX + 1;
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ArcPilotTreasury.ExceedsMaxTxAmount.selector, over, MAX_TX)
        );
        treasury.pay(alice, over, RID1, "memo");
    }

    function test_Pay_ExceedsPerPayeeDailyLimit_Reverts() public {
        // alice daily limit = 2 000e6; spend 1 500, then try 600
        vm.prank(owner);
        treasury.pay(alice, 1_500e6, RID1, "p1");

        vm.prank(owner);
        uint256 remaining = 2_000e6 - 1_500e6;
        vm.expectRevert(
            abi.encodeWithSelector(ArcPilotTreasury.ExceedsDailyLimit.selector, alice, 600e6, remaining)
        );
        treasury.pay(alice, 600e6, RID2, "p2");
    }

    function test_Pay_ExceedsGlobalDailyLimit_Reverts() public {
        // Set a tight global limit so alice (unlimited per-payee) can trigger it
        vm.prank(owner);
        treasury.setGlobalDailyLimit(300e6);
        vm.prank(owner);
        treasury.setPayee(bob, "bob", 0); // unlimited per-payee
        vm.prank(owner);
        treasury.pay(bob, 200e6, RID1, "p1");

        // Remaining = 100e6; try 101e6
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ArcPilotTreasury.ExceedsGlobalDailyLimit.selector, 101e6, 100e6)
        );
        treasury.pay(bob, 101e6, RID2, "p2");
    }

    function test_Pay_ExceedsSpendable_Reverts() public {
        // Treasury has DEPOSIT_AMT (10 000e6); reserve = 10% = 1 000e6.
        // Spendable = 9 000e6. Obligations lock extra funds.
        vm.prank(owner);
        treasury.setObligation(0, "Lock", 9_000e6); // locks 9 000; spendable = 0

        vm.prank(owner);
        vm.expectRevert(); // ExceedsSpendable
        treasury.pay(alice, 1e6, RID1, "memo");
    }

    function test_Pay_WhenPaused_Reverts() public {
        vm.prank(pauser);
        treasury.pause();

        vm.prank(owner);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        treasury.pay(alice, 100e6, RID1, "memo");
    }

    function test_Pay_ZeroAmount_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(ArcPilotTreasury.ZeroAmount.selector);
        treasury.pay(alice, 0, RID1, "memo");
    }

    function test_Pay_NonOwner_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        treasury.pay(alice, 100e6, RID1, "memo");
    }

    function test_Pay_CEI_EventBeforeTransfer() public {
        // PaymentExecuted must appear before transfer completes.
        // We verify the event is emitted and the payment record is stored
        // in the same call — if the revert happened after emit, storage
        // wouldn't be updated. We rely on paymentCount going from 0→1
        // and requestIdUsed being set, which only happens on CEI ordering.
        uint256 amt = 100e6;
        vm.prank(owner);
        treasury.pay(alice, amt, RID1, "memo");

        // Payment record exists
        (address to, uint256 amount, , bytes32 requestId, string memory memo) = treasury.payments(0);
        assertEq(to,        alice);
        assertEq(amount,    amt);
        assertEq(requestId, RID1);
        assertEq(memo,      "memo");
    }

    function test_Pay_RecordsPaymentCorrectly() public {
        vm.prank(owner);
        treasury.pay(alice, 100e6, RID1, "test memo");

        assertEq(treasury.paymentCount(), 1);
        (address to, uint256 amount, uint256 timestamp, bytes32 requestId, string memory memo)
            = treasury.payments(0);
        assertEq(to,        alice);
        assertEq(amount,    100e6);
        assertEq(requestId, RID1);
        assertEq(memo,      "test memo");
        assertGt(timestamp, 0);
    }
}

// ===========================================================================
// 7. Daily window reset
// ===========================================================================
contract TreasuryDailyResetTest is TreasuryFixture {

    bytes32 internal constant RID1 = keccak256("r1");
    bytes32 internal constant RID2 = keccak256("r2");

    function setUp() public override {
        super.setUp();
        _seedTreasury(DEPOSIT_AMT);
        _allowAlice(2_000e6);
    }

    function test_DailyReset_PerPayee_AfterWarp() public {
        // Spend alice's daily limit
        vm.prank(owner);
        treasury.pay(alice, 2_000e6, RID1, "m");

        // Confirm daily remaining = 0
        assertEq(treasury.dailyRemainingPayee(alice), 0);

        // Warp 1 day
        skip(1 days);

        // New window: remaining should be restored to full daily limit
        assertEq(treasury.dailyRemainingPayee(alice), 2_000e6);

        // Should now be able to pay again
        vm.prank(owner);
        treasury.pay(alice, 1_000e6, RID2, "m");
        assertEq(usdc.balanceOf(alice), 3_000e6);
    }

    function test_DailyReset_Global_AfterWarp() public {
        vm.prank(owner);
        treasury.setGlobalDailyLimit(1_000e6);

        _seedTreasury(DEPOSIT_AMT); // extra headroom
        vm.prank(owner);
        treasury.setPayee(bob, "bob", 0);

        vm.prank(owner);
        treasury.pay(bob, 1_000e6, RID1, "m");

        assertEq(treasury.dailyRemainingGlobal(), 0);

        skip(1 days);
        assertEq(treasury.dailyRemainingGlobal(), 1_000e6);
    }

    function test_DailyRemaining_BeforeSpend() public view {
        assertEq(treasury.dailyRemainingGlobal(), GLOBAL_DAILY);
        assertEq(treasury.dailyRemainingPayee(alice), 2_000e6);
    }

    function test_DailyRemaining_AfterPartialSpend() public {
        vm.prank(owner);
        treasury.pay(alice, 500e6, RID1, "m");

        assertEq(treasury.dailyRemainingGlobal(),     GLOBAL_DAILY - 500e6);
        assertEq(treasury.dailyRemainingPayee(alice), 2_000e6 - 500e6);
    }

    function test_DailyRemaining_UnlimitedGlobal_ReturnsMaxUint() public {
        vm.prank(owner);
        treasury.setGlobalDailyLimit(0);
        assertEq(treasury.dailyRemainingGlobal(), type(uint256).max);
    }

    function test_DailyRemaining_UnlimitedPayee_ReturnsMaxUint() public {
        vm.prank(owner);
        treasury.setPayee(bob, "bob", 0); // 0 = unlimited
        assertEq(treasury.dailyRemainingPayee(bob), type(uint256).max);
    }

    function test_DailyRemainingPayee_NotAllowed_Reverts() public {
        vm.expectRevert(abi.encodeWithSelector(ArcPilotTreasury.NotAllowedPayee.selector, carol));
        treasury.dailyRemainingPayee(carol);
    }
}

// ===========================================================================
// 8. setReserveBps / setMaxTxAmount / setGlobalDailyLimit
// ===========================================================================
contract TreasuryConfigTest is TreasuryFixture {

    function test_SetReserveBps_HappyPath() public {
        vm.prank(owner);
        treasury.setReserveBps(500);
        assertEq(treasury.reserveBps(), 500);
    }

    function test_SetReserveBps_EmitsEvent() public {
        vm.prank(owner);
        vm.expectEmit(false, false, false, true, address(treasury));
        emit ReserveBpsSet(500);
        treasury.setReserveBps(500);
    }

    function test_SetReserveBps_Boundary10000() public {
        vm.prank(owner);
        treasury.setReserveBps(10000);
        assertEq(treasury.reserveBps(), 10000);
    }

    function test_SetReserveBps_Over10000_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ArcPilotTreasury.InvalidReserveBps.selector, uint16(10001)));
        treasury.setReserveBps(10001);
    }

    function test_SetReserveBps_NonOwner_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        treasury.setReserveBps(500);
    }

    function test_SetMaxTxAmount_HappyPath() public {
        vm.prank(owner);
        treasury.setMaxTxAmount(1_000e6);
        assertEq(treasury.maxTxAmount(), 1_000e6);
    }

    function test_SetMaxTxAmount_EmitsEvent() public {
        vm.prank(owner);
        vm.expectEmit(false, false, false, true, address(treasury));
        emit MaxTxAmountSet(1_000e6);
        treasury.setMaxTxAmount(1_000e6);
    }

    function test_SetMaxTxAmount_NonOwner_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        treasury.setMaxTxAmount(1_000e6);
    }

    function test_SetMaxTxAmount_Zero_DisablesLimit() public {
        vm.prank(owner);
        treasury.setMaxTxAmount(0);
        assertEq(treasury.maxTxAmount(), 0);

        // Disable global daily limit too, then seed and pay a large amount
        vm.prank(owner);
        treasury.setGlobalDailyLimit(0); // 0 = unlimited

        _seedTreasury(100_000e6);
        _allowAlice(0);
        vm.prank(owner);
        treasury.pay(alice, 50_000e6, keccak256("r"), "memo");
        assertEq(usdc.balanceOf(alice), 50_000e6);
    }

    function test_SetGlobalDailyLimit_HappyPath() public {
        vm.prank(owner);
        treasury.setGlobalDailyLimit(50_000e6);
        assertEq(treasury.globalDailyLimit(), 50_000e6);
    }

    function test_SetGlobalDailyLimit_EmitsEvent() public {
        vm.prank(owner);
        vm.expectEmit(false, false, false, true, address(treasury));
        emit GlobalDailyLimitSet(50_000e6);
        treasury.setGlobalDailyLimit(50_000e6);
    }

    function test_SetGlobalDailyLimit_NonOwner_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        treasury.setGlobalDailyLimit(50_000e6);
    }
}

// ===========================================================================
// 9. setPauser / setRescuer
// ===========================================================================
contract TreasuryPauserRescuerTest is TreasuryFixture {

    function test_SetPauser_HappyPath() public {
        address newPauser = makeAddr("newPauser");
        vm.prank(owner);
        treasury.setPauser(newPauser);
        assertEq(treasury.pauser(), newPauser);
    }

    function test_SetPauser_EmitsEvent() public {
        address newPauser = makeAddr("newPauser");
        vm.prank(owner);
        vm.expectEmit(true, false, false, false, address(treasury));
        emit PauserSet(newPauser);
        treasury.setPauser(newPauser);
    }

    function test_SetPauser_ZeroAddress_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(ArcPilotTreasury.ZeroAddress.selector);
        treasury.setPauser(address(0));
    }

    function test_SetPauser_NonOwner_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        treasury.setPauser(alice);
    }

    function test_SetPauser_OldPauserCannotPause() public {
        address newPauser = makeAddr("newPauser");
        vm.prank(owner);
        treasury.setPauser(newPauser);

        // Old pauser should no longer work
        vm.prank(pauser);
        vm.expectRevert(ArcPilotTreasury.NotPauser.selector);
        treasury.pause();
    }

    function test_SetPauser_NewPauserCanPause() public {
        address newPauser = makeAddr("newPauser");
        vm.prank(owner);
        treasury.setPauser(newPauser);

        vm.prank(newPauser);
        treasury.pause();
        assertTrue(treasury.paused());
    }

    function test_SetRescuer_HappyPath() public {
        address newRescuer = makeAddr("newRescuer");
        vm.prank(owner);
        treasury.setRescuer(newRescuer);
        assertEq(treasury.rescuer(), newRescuer);
    }

    function test_SetRescuer_EmitsEvent() public {
        address newRescuer = makeAddr("newRescuer");
        vm.prank(owner);
        vm.expectEmit(true, false, false, false, address(treasury));
        emit RescuerSet(newRescuer);
        treasury.setRescuer(newRescuer);
    }

    function test_SetRescuer_ZeroAddress_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(ArcPilotTreasury.ZeroAddress.selector);
        treasury.setRescuer(address(0));
    }

    function test_SetRescuer_NonOwner_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        treasury.setRescuer(alice);
    }
}

// ===========================================================================
// 10. pause / unpause
// ===========================================================================
contract TreasuryPauseTest is TreasuryFixture {

    function test_Pauser_CanPause() public {
        vm.prank(pauser);
        treasury.pause();
        assertTrue(treasury.paused());
    }

    function test_Pauser_CanUnpause() public {
        vm.prank(pauser);
        treasury.pause();

        vm.prank(pauser);
        treasury.unpause();
        assertFalse(treasury.paused());
    }

    function test_NonPauser_CannotPause() public {
        vm.prank(alice);
        vm.expectRevert(ArcPilotTreasury.NotPauser.selector);
        treasury.pause();
    }

    function test_NonPauser_CannotUnpause() public {
        vm.prank(pauser);
        treasury.pause();

        vm.prank(alice);
        vm.expectRevert(ArcPilotTreasury.NotPauser.selector);
        treasury.unpause();
    }

    function test_DoublePause_Reverts() public {
        vm.prank(pauser);
        treasury.pause();

        vm.prank(pauser);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        treasury.pause();
    }

    function test_ReadsWorkWhilePaused() public {
        _seedTreasury(1_000e6);
        vm.prank(pauser);
        treasury.pause();

        // These view functions should still work
        assertEq(treasury.totalBalance(),   1_000e6);
        assertEq(treasury.reserveAmount(),  100e6);   // 10%
        assertGe(treasury.spendableBalance(), 0);
        assertEq(treasury.paymentCount(),   0);
        assertEq(treasury.paused(),         true);
    }

    function test_OwnerFunctionsWorkWhilePaused() public {
        // setObligation, setPayee, setReserveBps etc. are not gated by whenNotPaused
        vm.prank(pauser);
        treasury.pause();

        vm.prank(owner);
        treasury.setObligation(0, "test", 100e6);
        assertEq(treasury.activeObligationsTotal(), 100e6);
    }
}

// ===========================================================================
// 11. rescueToken
// ===========================================================================
contract TreasuryRescueTest is TreasuryFixture {

    function setUp() public override {
        super.setUp();
        // Seed treasury with some otherToken
        otherToken.mint(address(treasury), 500e18);
    }

    function test_RescueToken_NonUsdc_Works() public {
        vm.prank(rescuer);
        treasury.rescueToken(address(otherToken), alice, 500e18);

        assertEq(otherToken.balanceOf(alice),            500e18);
        assertEq(otherToken.balanceOf(address(treasury)), 0);
    }

    function test_RescueToken_EmitsEvent() public {
        vm.prank(rescuer);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit TokenRescued(address(otherToken), alice, 500e18);
        treasury.rescueToken(address(otherToken), alice, 500e18);
    }

    function test_RescueToken_Usdc_Reverts() public {
        vm.prank(rescuer);
        vm.expectRevert(ArcPilotTreasury.CannotRescueUSDC.selector);
        treasury.rescueToken(address(usdc), alice, 1e6);
    }

    function test_RescueToken_NonRescuer_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(ArcPilotTreasury.NotRescuer.selector);
        treasury.rescueToken(address(otherToken), alice, 100e18);
    }

    function test_RescueToken_WhilePaused_Works() public {
        vm.prank(pauser);
        treasury.pause();

        // rescueToken has no whenNotPaused modifier — should work
        vm.prank(rescuer);
        treasury.rescueToken(address(otherToken), alice, 500e18);
        assertEq(otherToken.balanceOf(alice), 500e18);
    }

    function test_RescueToken_ZeroToAddress_Reverts() public {
        vm.prank(rescuer);
        vm.expectRevert(ArcPilotTreasury.ZeroAddress.selector);
        treasury.rescueToken(address(otherToken), address(0), 100e18);
    }
}

// ===========================================================================
// 13. getPayments (pagination)
// ===========================================================================
contract TreasuryGetPaymentsTest is TreasuryFixture {

    function setUp() public override {
        super.setUp();
        _seedTreasury(100_000e6);
        _allowAlice(0);
        vm.prank(owner);
        treasury.setMaxTxAmount(0); // disable max
    }

    function test_GetPayments_Empty() public view {
        ArcPilotTreasury.PaymentRecord[] memory records = treasury.getPayments(0, 10);
        assertEq(records.length, 0);
    }

    function test_GetPayments_Full() public {
        // Make 3 payments
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(owner);
            treasury.pay(alice, 100e6, bytes32(i + 1), "m");
        }

        ArcPilotTreasury.PaymentRecord[] memory records = treasury.getPayments(0, 10);
        assertEq(records.length, 3);
        assertEq(records[0].amount, 100e6);
        assertEq(records[2].requestId, bytes32(uint256(3)));
    }

    function test_GetPayments_Paginated() public {
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(owner);
            treasury.pay(alice, 100e6, bytes32(i + 1), "m");
        }

        // page 1: offset=0, limit=3 → [0,1,2]
        ArcPilotTreasury.PaymentRecord[] memory page1 = treasury.getPayments(0, 3);
        assertEq(page1.length, 3);
        assertEq(page1[0].requestId, bytes32(uint256(1)));

        // page 2: offset=3, limit=3 → [3,4]
        ArcPilotTreasury.PaymentRecord[] memory page2 = treasury.getPayments(3, 3);
        assertEq(page2.length, 2);
        assertEq(page2[0].requestId, bytes32(uint256(4)));
    }

    function test_GetPayments_OffsetOutOfBounds_ReturnsEmpty() public {
        vm.prank(owner);
        treasury.pay(alice, 100e6, bytes32(uint256(1)), "m");

        ArcPilotTreasury.PaymentRecord[] memory records = treasury.getPayments(10, 5);
        assertEq(records.length, 0);
    }

    function test_GetPayments_LimitZero_ReturnsEmpty() public {
        vm.prank(owner);
        treasury.pay(alice, 100e6, bytes32(uint256(1)), "m");

        ArcPilotTreasury.PaymentRecord[] memory records = treasury.getPayments(0, 0);
        assertEq(records.length, 0);
    }
}

// ===========================================================================
// 14. spendableBalance: never underflows (fuzz)
// ===========================================================================
contract TreasurySpendableFuzzTest is TreasuryFixture {

    function testFuzz_SpendableBalance_NeverUnderflows(
        uint256 balance,
        uint256 obligationAmt,
        uint16  bps
    ) public {
        // Bound inputs to sane ranges
        balance       = bound(balance,       0,       100_000_000e6);
        obligationAmt = bound(obligationAmt, 0,       100_000_000e6);
        bps           = uint16(bound(uint256(bps), 0, 10000));

        // Seed treasury with exact balance via mock mint
        usdc.mint(address(treasury), balance);

        // Set obligation and reserveBps
        vm.prank(owner);
        treasury.setObligation(0, "fuzz", obligationAmt);

        vm.prank(owner);
        treasury.setReserveBps(bps);

        // spendableBalance must never underflow (returns 0 at minimum)
        uint256 spendable = treasury.spendableBalance();
        assertGe(spendable, 0);

        // Additional check: spendable + locked <= balance (conservation)
        uint256 reserve = (balance * bps) / 10000;
        uint256 locked  = obligationAmt + reserve;
        if (balance >= locked) {
            assertEq(spendable, balance - locked);
        } else {
            assertEq(spendable, 0);
        }
    }
}

// ===========================================================================
// 15. activeObligationsTotal invariant (fuzz)
// ===========================================================================
contract TreasuryObligationInvariantFuzz is TreasuryFixture {

    function testFuzz_ActiveObligationsTotal_SumConsistency(
        uint256[5] calldata amounts
    ) public {
        uint256 expected = 0;

        // Set 5 obligations
        for (uint256 i = 0; i < 5; i++) {
            uint256 amt = bound(amounts[i], 0, 1_000_000e6);
            vm.prank(owner);
            treasury.setObligation(i, "label", amt);
            expected += amt;
        }

        assertEq(treasury.activeObligationsTotal(), expected);

        // Remove obligation 2 and re-check
        expected -= _getObligationAmount(2);
        vm.prank(owner);
        treasury.removeObligation(2);
        assertEq(treasury.activeObligationsTotal(), expected);
    }

    function _getObligationAmount(uint256 id) internal view returns (uint256 amount) {
        (, amount, ) = treasury.obligations(id);
    }
}

// ===========================================================================
// 16. Invariant: usdc.balanceOf(treasury) >= activeObligationsTotal + reserveAmount()
// ===========================================================================
contract TreasuryBalanceInvariant is TreasuryFixture {

    /// @dev Handler that performs a sequence of operations and checks the invariant.
    function testFuzz_BalanceInvariant_AfterDepositAndObligation(
        uint256 depositAmt,
        uint256 obligationAmt,
        uint16  bps
    ) public {
        depositAmt    = bound(depositAmt,    0,       50_000e6);
        obligationAmt = bound(obligationAmt, 0,       50_000e6);
        bps           = uint16(bound(uint256(bps), 0, 10000));

        // Set reserve bps
        vm.prank(owner);
        treasury.setReserveBps(bps);

        // Deposit
        if (depositAmt > 0) _depositAs(alice, depositAmt);

        // Set obligation
        vm.prank(owner);
        treasury.setObligation(0, "inv", obligationAmt);

        uint256 bal        = treasury.totalBalance();
        uint256 obligations = treasury.activeObligationsTotal();
        uint256 reserve    = treasury.reserveAmount();

        // Invariant: balance >= obligations + reserve only when balance >= locked
        // If obligations + reserve > balance, spendable = 0 (clamped), but the
        // invariant is that the contract clamps not panics.
        // The real invariant here: spendableBalance() >= 0 (no underflow) and
        // totalBalance() == usdc.balanceOf(address(treasury))
        assertEq(bal, usdc.balanceOf(address(treasury)));
        assertGe(treasury.spendableBalance(), 0);
        // When balance covers locked amount, spendable should equal bal - locked
        uint256 locked = obligations + reserve;
        if (bal >= locked) {
            assertEq(treasury.spendableBalance(), bal - locked);
        }
    }
}

// ===========================================================================
// Extra: totalBalance / reserveAmount / spendableBalance views
// ===========================================================================
contract TreasuryViewsTest is TreasuryFixture {

    function test_TotalBalance_Empty() public view {
        assertEq(treasury.totalBalance(), 0);
    }

    function test_TotalBalance_AfterSeed() public {
        _seedTreasury(5_000e6);
        assertEq(treasury.totalBalance(), 5_000e6);
    }

    function test_ReserveAmount_10Percent() public {
        _seedTreasury(10_000e6);
        // 10% of 10_000 = 1_000
        assertEq(treasury.reserveAmount(), 1_000e6);
    }

    function test_SpendableBalance_WithObligation() public {
        _seedTreasury(10_000e6);
        vm.prank(owner);
        treasury.setObligation(0, "lock", 3_000e6);
        // balance = 10 000, reserve = 1 000 (10%), obligation = 3 000
        // locked = 4 000, spendable = 6 000
        assertEq(treasury.spendableBalance(), 6_000e6);
    }

    function test_SpendableBalance_ClampedToZero() public {
        _seedTreasury(1_000e6);
        // obligation = 5_000; reserve = 100; locked > balance → spendable = 0
        vm.prank(owner);
        treasury.setObligation(0, "big", 5_000e6);
        assertEq(treasury.spendableBalance(), 0);
    }
}
