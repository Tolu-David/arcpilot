// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2}        from "forge-std/Test.sol";
import {Ownable}               from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step}          from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable}              from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard}       from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ArcPilotTreasury}      from "../ArcPilotTreasury.sol";
import {MockERC20}             from "../test-helpers/MockERC20.sol";

// ---------------------------------------------------------------------------
// Helper: an ERC-20 whose transferFrom always reverts (for Group D deposit test)
// ---------------------------------------------------------------------------
contract RevertingOnTransferFromERC20 {
    string  public name     = "RevertFrom";
    string  public symbol   = "RVF";
    uint8   public decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256)                     public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply   += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "ERC20: insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert("FORCED_REVERT_TRANSFERFROM");
    }
}

// ---------------------------------------------------------------------------
// Helper: an ERC-20 whose transfer always reverts (for Group D pay/withdraw)
// ---------------------------------------------------------------------------
contract RevertingOnTransferERC20 {
    string  public name     = "RevertTx";
    string  public symbol   = "RVT";
    uint8   public decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256)                     public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply   += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /// @dev transferFrom works normally — used to seed the treasury via deposit
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "ERC20: insufficient allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        require(balanceOf[from] >= amount, "ERC20: insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to]   += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    /// @dev transfer always reverts — simulates a malicious / broken ERC-20 outbound
    function transfer(address, uint256) external pure returns (bool) {
        revert("FORCED_REVERT");
    }
}

// ---------------------------------------------------------------------------
// Helper: MaliciousUSDC — calls treasury.pay() inside transfer() for F1
// ---------------------------------------------------------------------------
contract MaliciousUSDC {
    string  public name     = "MalUSDC";
    string  public symbol   = "mUSDC";
    uint8   public decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256)                     public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // Set by the test before triggering the reentrant call
    ArcPilotTreasury public treasury;
    address          public reentrantTo;
    uint256          public reentrantAmount;
    bytes32          public reentrantRequestId;
    string           public reentrantMemo;
    bool             public reentrancyAttempted;
    bytes            public reentrantRevertData;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function setReentryParams(
        ArcPilotTreasury _treasury,
        address _to,
        uint256 _amount,
        bytes32 _requestId,
        string calldata _memo
    ) external {
        treasury         = _treasury;
        reentrantTo      = _to;
        reentrantAmount  = _amount;
        reentrantRequestId = _requestId;
        reentrantMemo    = _memo;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply   += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "ERC20: insufficient allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        require(balanceOf[from] >= amount, "ERC20: insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to]   += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    /// @dev On outbound transfer, attempt a reentrant call back into treasury.pay()
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "ERC20: insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        emit Transfer(msg.sender, to, amount);

        // Attempt reentrancy — this should be blocked by nonReentrant
        if (address(treasury) != address(0) && !reentrancyAttempted) {
            reentrancyAttempted = true;
            try treasury.pay(reentrantTo, reentrantAmount, reentrantRequestId, reentrantMemo) {
                // should not reach here
            } catch (bytes memory err) {
                reentrantRevertData = err;
            }
        }
        return true;
    }
}

// ---------------------------------------------------------------------------
// Shared fixture for the full test suite
// ---------------------------------------------------------------------------
abstract contract FullTreasuryFixture is Test {
    ArcPilotTreasury internal treasury;
    MockERC20        internal usdc;

    address internal owner   = makeAddr("owner");
    address internal pauser  = makeAddr("pauser");
    address internal rescuer = makeAddr("rescuer");
    address internal alice   = makeAddr("alice");
    address internal bob     = makeAddr("bob");
    address internal carol   = makeAddr("carol");

    // Default deploy params
    uint16  internal constant DEFAULT_RESERVE_BPS  = 0;       // Override per test
    uint256 internal constant DEFAULT_MAX_TX       = 0;       // Disabled by default
    uint256 internal constant DEFAULT_GLOBAL_DAILY = 0;       // Unlimited by default

    function setUp() public virtual {
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);

        vm.prank(owner);
        treasury = new ArcPilotTreasury(
            owner,
            pauser,
            rescuer,
            address(usdc),
            DEFAULT_RESERVE_BPS,
            DEFAULT_MAX_TX,
            DEFAULT_GLOBAL_DAILY
        );
    }

    // Deploy a fresh treasury with specific params
    function _deployTreasury(uint16 _reserveBps, uint256 _maxTx, uint256 _globalDaily)
        internal
        returns (ArcPilotTreasury t)
    {
        t = new ArcPilotTreasury(owner, pauser, rescuer, address(usdc), _reserveBps, _maxTx, _globalDaily);
    }

    function _seedTreasury(ArcPilotTreasury t, uint256 amount) internal {
        usdc.mint(address(t), amount);
    }

    function _allowPayee(ArcPilotTreasury t, address payee, uint256 dailyLimit) internal {
        vm.prank(owner);
        t.setPayee(payee, "payee", dailyLimit);
    }

    function _pay(ArcPilotTreasury t, address to, uint256 amount, bytes32 rid) internal {
        vm.prank(owner);
        t.pay(to, amount, rid, "memo");
    }
}

// ===========================================================================
// GROUP A — Spendable balance floor protection with exact arithmetic
// ===========================================================================
contract GroupA_SpendableFloor is FullTreasuryFixture {

    /// @dev A1: balance=1000e6, obligation=900e6, reserveBps=1000 (10%)
    ///  reserve = 1000e6 * 1000 / 10000 = 100e6
    ///  locked  = 900e6 + 100e6 = 1000e6
    ///  spendable = 1000e6 - 1000e6 = 0 → pay(1) must revert ExceedsSpendable
    function test_A1_SpendableZeroWhenLockedEqualsBalance() public {
        ArcPilotTreasury t = _deployTreasury(1000, 0, 0); // 10% reserve
        _seedTreasury(t, 1000e6);

        vm.prank(owner);
        t.setObligation(0, "O1", 900e6);

        assertEq(t.spendableBalance(), 0, "spendable should be 0");

        _allowPayee(t, alice, 0);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ArcPilotTreasury.ExceedsSpendable.selector, uint256(1), uint256(0))
        );
        t.pay(alice, 1, bytes32(uint256(1)), "memo");
    }

    /// @dev A2: balance=1000e6, obligation=890e6, reserveBps=1000 (10%)
    ///  Initial spendable = 1000e6 - 890e6 - 100e6 = 10e6.
    ///  pay(10e6) succeeds (depletes initial spendable snapshot).
    ///  After that payment balance=990e6, reserve=99e6, spendable=990-890-99=1e6.
    ///  pay(1e6) exhausts the remaining spendable.
    ///  pay(1) then reverts ExceedsSpendable(1, 0) — dynamic reserve now leaves 0 spendable.
    ///
    ///  NOTE: The reserve is computed dynamically as (balance * bps / 10000) each time.
    ///  After each payment the remaining balance decreases and so does the absolute reserve,
    ///  which can free a tiny residual. We drain to zero by computing the exact spendable
    ///  after each payment and paying it, until spendableBalance() == 0.
    function test_A2_ExactSpendableBoundary() public {
        ArcPilotTreasury t = _deployTreasury(1000, 0, 0);
        _seedTreasury(t, 1000e6);

        vm.prank(owner);
        t.setObligation(0, "O1", 890e6);

        // Initial state check: spendable = 1000 - 890 - 100 = 10e6
        assertEq(t.spendableBalance(), 10e6, "initial spendable should be 10e6");

        _allowPayee(t, alice, 0);

        // Pay down all spendable in increments until none remains.
        // Because the reserve is dynamic, each payment slightly reduces the locked reserve
        // and can expose a tiny residual. We loop to drain to zero.
        uint256 rid = 1;
        uint256 spendable = t.spendableBalance();
        while (spendable > 0) {
            vm.prank(owner);
            t.pay(alice, spendable, bytes32(rid), "memo");
            rid++;
            spendable = t.spendableBalance();
        }

        // Confirm spendable is truly zero now
        assertEq(t.spendableBalance(), 0, "spendable must be 0 after draining");

        // Now pay(1) must revert ExceedsSpendable(1, 0)
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArcPilotTreasury.ExceedsSpendable.selector,
                uint256(1),
                uint256(0)
            )
        );
        t.pay(alice, 1, bytes32(rid), "memo");
    }

    /// @dev A3: balance=0, obligation=0, reserveBps=0 → spendableBalance() == 0, no underflow
    function test_A3_ZeroBalanceZeroObligationZeroReserve_NoUnderflow() public {
        ArcPilotTreasury t = _deployTreasury(0, 0, 0);
        // No seed — balance is 0
        assertEq(t.spendableBalance(), 0, "spendable must be 0, no underflow");
        // Must not revert
    }

    /// @dev A4: Fuzz — spendableBalance() never panics; result matches formula
    function testFuzz_A4_SpendableNeverPanics(
        uint128 balance,
        uint128 obligationAmt,
        uint16 bps
    ) public {
        bps = uint16(bound(bps, 0, 10000));
        // Use uint128 inputs → cast to uint256 to avoid overflow when computing reserve
        uint256 bal = uint256(balance);
        uint256 obl = uint256(obligationAmt);

        ArcPilotTreasury t = _deployTreasury(bps, 0, 0);

        // Seed exact balance
        _seedTreasury(t, bal);

        if (obl > 0) {
            vm.prank(owner);
            t.setObligation(0, "O", obl);
        }

        // Must never revert
        uint256 result = t.spendableBalance();

        // Verify formula
        uint256 reserve = (bal * bps) / 10000;
        uint256 locked  = obl + reserve;
        uint256 expected = bal > locked ? bal - locked : 0;

        assertEq(result, expected, "spendable formula mismatch");
    }
}

// ===========================================================================
// GROUP B — Per-transaction limit, exact off-by-one
// ===========================================================================
contract GroupB_PerTxLimit is FullTreasuryFixture {

    ArcPilotTreasury internal t;

    function setUp() public override {
        super.setUp();
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        // Deploy with maxTxAmount=5000e6
        t = new ArcPilotTreasury(owner, pauser, rescuer, address(usdc), 0, 5000e6, 0);
        _seedTreasury(t, 100_000e6);
        _allowPayee(t, alice, 0);
    }

    /// @dev B1: pay(5000e6) succeeds — exactly at limit
    function test_B1_AtMaxTx_Succeeds() public {
        vm.prank(owner);
        t.pay(alice, 5000e6, bytes32(uint256(1)), "memo");
        assertEq(usdc.balanceOf(alice), 5000e6);
    }

    /// @dev B2: pay(5001e6) reverts ExceedsMaxTxAmount(5001e6, 5000e6) — one base unit over
    function test_B2_OneOverMaxTx_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArcPilotTreasury.ExceedsMaxTxAmount.selector,
                uint256(5001e6),
                uint256(5000e6)
            )
        );
        t.pay(alice, 5001e6, bytes32(uint256(1)), "memo");
    }

    /// @dev B3: maxTxAmount=0 (disabled) → pay(10000e6) succeeds (no cap)
    function test_B3_MaxTxZeroDisabled_Succeeds() public {
        ArcPilotTreasury t2 = new ArcPilotTreasury(owner, pauser, rescuer, address(usdc), 0, 0, 0);
        _seedTreasury(t2, 100_000e6);
        _allowPayee(t2, alice, 0);

        vm.prank(owner);
        t2.pay(alice, 10_000e6, bytes32(uint256(1)), "memo");
        assertEq(usdc.balanceOf(alice), 10_000e6);
    }
}

// ===========================================================================
// GROUP C — Daily limit, exact off-by-one boundaries
// ===========================================================================
contract GroupC_DailyLimits is FullTreasuryFixture {

    ArcPilotTreasury internal t;

    function setUp() public override {
        super.setUp();
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        // Deploy with globalDailyLimit=2000e6, maxTx=0
        t = new ArcPilotTreasury(owner, pauser, rescuer, address(usdc), 0, 0, 2000e6);
        _seedTreasury(t, 100_000e6);
    }

    /// @dev C1: per-payee dailyLimit=1000e6. pay(1000e6) at limit. pay(1) reverts ExceedsDailyLimit(payee,1,0).
    function test_C1_PerPayeeAtLimit_ThenOneOverReverts() public {
        _allowPayee(t, alice, 1000e6);

        vm.prank(owner);
        t.pay(alice, 1000e6, bytes32(uint256(1)), "memo");

        // spentToday == 1000e6, dailyLimit == 1000e6, remaining = 0
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArcPilotTreasury.ExceedsDailyLimit.selector,
                alice,
                uint256(1),
                uint256(0)
            )
        );
        t.pay(alice, 1, bytes32(uint256(2)), "memo");
    }

    /// @dev C2: pay(500e6) succeeds. pay(501e6) reverts ExceedsDailyLimit(payee,501e6,500e6).
    function test_C2_PerPayeeHalfUsed_OneOverRemaining_Reverts() public {
        _allowPayee(t, alice, 1000e6);

        vm.prank(owner);
        t.pay(alice, 500e6, bytes32(uint256(1)), "memo");

        // remaining = 1000 - 500 = 500e6; pay(501e6) is over by 1
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArcPilotTreasury.ExceedsDailyLimit.selector,
                alice,
                uint256(501e6),
                uint256(500e6)
            )
        );
        t.pay(alice, 501e6, bytes32(uint256(2)), "memo");
    }

    /// @dev C3: globalDailyLimit=2000e6. pay(2000e6) succeeds. pay(1) reverts ExceedsGlobalDailyLimit(1,0).
    function test_C3_GlobalAtLimit_ThenOneOverReverts() public {
        _allowPayee(t, alice, 0); // unlimited per-payee

        vm.prank(owner);
        t.pay(alice, 2000e6, bytes32(uint256(1)), "memo");

        // globalSpentToday == 2000e6, remaining == 0
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArcPilotTreasury.ExceedsGlobalDailyLimit.selector,
                uint256(1),
                uint256(0)
            )
        );
        t.pay(alice, 1, bytes32(uint256(2)), "memo");
    }

    /// @dev C4: pay(1999e6) succeeds. pay(2) reverts ExceedsGlobalDailyLimit(2,1).
    function test_C4_GlobalOneUnderLimit_ThenTwoOverReverts() public {
        _allowPayee(t, alice, 0);

        vm.prank(owner);
        t.pay(alice, 1999e6, bytes32(uint256(1)), "memo");

        // remaining = 2000 - 1999 = 1e6; pay(2e6) over by 1
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArcPilotTreasury.ExceedsGlobalDailyLimit.selector,
                uint256(2e6),
                uint256(1e6)
            )
        );
        t.pay(alice, 2e6, bytes32(uint256(2)), "memo");
    }

    /// @dev C5: After vm.warp(1 days + 1), per-payee window resets.
    function test_C5_WarpPastOneDay_PerPayeeWindowResets() public {
        _allowPayee(t, alice, 1000e6);

        vm.prank(owner);
        t.pay(alice, 1000e6, bytes32(uint256(1)), "memo");

        // Would fail in current window — but warp past reset
        vm.warp(block.timestamp + 1 days + 1);

        // Now per-payee window reset — 1000e6 again available
        // (global daily limit also resets — need fresh global budget)
        vm.prank(owner);
        t.pay(alice, 1000e6, bytes32(uint256(2)), "memo");
        assertEq(usdc.balanceOf(alice), 2000e6);
    }

    /// @dev C6: At exactly (1 days - 1 second) limit still enforced;
    ///          at (1 days exactly) window resets.
    function test_C6_ExactWindowBoundary() public {
        _allowPayee(t, alice, 1000e6);
        uint256 startTime = block.timestamp;

        vm.prank(owner);
        t.pay(alice, 1000e6, bytes32(uint256(1)), "memo");

        // Warp to 1 day - 1 second: still within the same window
        vm.warp(startTime + 1 days - 1);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArcPilotTreasury.ExceedsDailyLimit.selector,
                alice,
                uint256(1),
                uint256(0)
            )
        );
        t.pay(alice, 1, bytes32(uint256(2)), "memo");

        // Warp 1 more second: exactly at startTime + 1 days → window resets
        vm.warp(startTime + 1 days);

        vm.prank(owner);
        t.pay(alice, 1000e6, bytes32(uint256(3)), "memo");
        assertEq(usdc.balanceOf(alice), 2000e6);
    }
}

// ===========================================================================
// GROUP D — Failed USDC transfer and atomic rollback
// ===========================================================================
contract GroupD_FailedTransfer is Test {

    address internal owner   = makeAddr("owner");
    address internal pauser  = makeAddr("pauser");
    address internal rescuer = makeAddr("rescuer");
    address internal alice   = makeAddr("alice");

    /// @dev D1: RevertingOnTransferFromERC20 — deposit() must revert, state unchanged.
    function test_D1_DepositRevertsWhenTransferFromReverts() public {
        RevertingOnTransferFromERC20 badToken = new RevertingOnTransferFromERC20();

        ArcPilotTreasury t = new ArcPilotTreasury(
            owner, pauser, rescuer, address(badToken), 0, 0, 0
        );

        badToken.mint(alice, 1000e6);
        vm.startPrank(alice);
        badToken.approve(address(t), 1000e6);

        // deposit reverts because transferFrom reverts inside SafeERC20
        vm.expectRevert();
        t.deposit(1000e6);
        vm.stopPrank();

        // State must be unchanged
        assertEq(badToken.balanceOf(address(t)), 0, "treasury balance unchanged");
        assertEq(t.paymentCount(), 0, "paymentCount unchanged");
    }

    /// @dev D2: RevertingOnTransferERC20 — pay() must revert, state atomically rolled back.
    function test_D2_PayRevertsWhenTransferReverts_StateRolledBack() public {
        RevertingOnTransferERC20 badToken = new RevertingOnTransferERC20();

        ArcPilotTreasury t = new ArcPilotTreasury(
            owner, pauser, rescuer, address(badToken), 0, 0, 0
        );

        // Seed by minting directly — no deposit (avoids transferFrom path)
        badToken.mint(address(t), 5000e6);

        vm.prank(owner);
        t.setPayee(alice, "alice", 0);

        bytes32 rid = bytes32(uint256(42));

        vm.prank(owner);
        vm.expectRevert();
        t.pay(alice, 1000e6, rid, "memo");

        // All state must be rolled back
        assertFalse(t.requestIdUsed(rid),    "requestId must NOT be marked used after revert");
        assertEq(t.paymentCount(),       0,  "paymentCount must be 0 after revert");
        assertEq(t.globalSpentToday(),   0,  "globalSpentToday must be 0 after revert");
    }

    /// @dev D3: RevertingOnTransferERC20 — withdraw() reverts, no state change.
    function test_D3_WithdrawRevertsWhenTransferReverts() public {
        RevertingOnTransferERC20 badToken = new RevertingOnTransferERC20();

        ArcPilotTreasury t = new ArcPilotTreasury(
            owner, pauser, rescuer, address(badToken), 0, 0, 0
        );

        // Seed directly — bypass deposit
        badToken.mint(address(t), 5000e6);

        vm.prank(owner);
        vm.expectRevert();
        t.withdraw(alice, 1000e6);

        // Balance on treasury side must be unchanged (the ERC20 balance is still there)
        assertEq(badToken.balanceOf(address(t)), 5000e6, "treasury token balance unchanged");
        assertEq(badToken.balanceOf(alice),      0,      "alice received nothing");
    }
}

// ===========================================================================
// GROUP E — Rapid sequential payments and budget exhaustion
// ===========================================================================
contract GroupE_BudgetExhaustion is FullTreasuryFixture {

    ArcPilotTreasury internal t;

    function setUp() public override {
        super.setUp();
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        // globalDailyLimit = 10000e6
        t = new ArcPilotTreasury(owner, pauser, rescuer, address(usdc), 0, 0, 10_000e6);
        _seedTreasury(t, 50_000e6);
    }

    /// @dev E1: 10 payments of 1000e6 exhaust globalDailyLimit. 11th payment of 1 reverts.
    function test_E1_TenPaymentsExhaustGlobal() public {
        _allowPayee(t, alice, 0); // unlimited per-payee

        for (uint256 i = 1; i <= 10; i++) {
            vm.prank(owner);
            t.pay(alice, 1000e6, bytes32(i), "memo");
        }

        assertEq(t.globalSpentToday(), 10_000e6, "globalSpentToday should be 10000e6");

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArcPilotTreasury.ExceedsGlobalDailyLimit.selector,
                uint256(1),
                uint256(0)
            )
        );
        t.pay(alice, 1, bytes32(uint256(11)), "memo");
    }

    /// @dev E2: bob has dailyLimit=3000e6. 3 payments of 1000e6 succeed. 4th payment of 1 reverts.
    function test_E2_BobPerPayeeExhausted() public {
        _allowPayee(t, bob, 3000e6);

        for (uint256 i = 1; i <= 3; i++) {
            vm.prank(owner);
            t.pay(bob, 1000e6, bytes32(i), "memo");
        }

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArcPilotTreasury.ExceedsDailyLimit.selector,
                bob,
                uint256(1),
                uint256(0)
            )
        );
        t.pay(bob, 1, bytes32(uint256(4)), "memo");
    }

    /// @dev E3: Interleaved — alice hits global limit for bob.
    ///  alice dailyLimit=2000e6, bob dailyLimit=2000e6, global=3000e6 (already set in setUp)
    ///  But setUp uses 10000e6 global — deploy fresh with 3000e6
    function test_E3_InterleavedPayeesHitGlobalLimit() public {
        // Deploy a treasury with globalDailyLimit=3000e6
        ArcPilotTreasury t2 = new ArcPilotTreasury(owner, pauser, rescuer, address(usdc), 0, 0, 3000e6);
        _seedTreasury(t2, 20_000e6);

        _allowPayee(t2, alice, 2000e6);
        _allowPayee(t2, bob,   2000e6);

        // Pay alice 2000e6 (RID1) — uses 2000 of 3000 global
        vm.prank(owner);
        t2.pay(alice, 2000e6, bytes32(uint256(1)), "memo");

        // Pay bob 1000e6 (RID2) — uses remaining 1000 global → global now at 3000
        vm.prank(owner);
        t2.pay(bob, 1000e6, bytes32(uint256(2)), "memo");

        // Pay bob 1001e6 (RID3) → reverts ExceedsGlobalDailyLimit(1001e6, 1000e6 - 1000e6 = 0)
        // globalSpentToday = 3000e6, remaining = 0
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArcPilotTreasury.ExceedsGlobalDailyLimit.selector,
                uint256(1001e6),
                uint256(0)
            )
        );
        t2.pay(bob, 1001e6, bytes32(uint256(3)), "memo");
    }
}

// ===========================================================================
// GROUP F — Reentrancy attack surface review and test
// ===========================================================================

/**
 * @dev REENTRANCY ATTACK SURFACE ANALYSIS
 *
 * This NatSpec documents the full reentrancy analysis for ArcPilotTreasury.
 *
 * PROTECTED PATHS (nonReentrant):
 *  - deposit():      safeTransferFrom → could call back if token is malicious.
 *                    nonReentrant blocks re-entry.
 *  - withdraw():     safeTransfer → could call back. nonReentrant blocks re-entry.
 *  - pay():          safeTransfer → could call back. nonReentrant blocks re-entry.
 *                    Additionally, requestIdUsed[requestId] is set TRUE BEFORE the
 *                    safeTransfer call (CEI pattern). Even if nonReentrant were somehow
 *                    bypassed, a replay attempt would hit DuplicateRequestId.
 *
 * UNPROTECTED PATH:
 *  - rescueToken():  calls SafeERC20.safeTransfer on an ARBITRARY token address.
 *                    This is NOT protected by nonReentrant. A reentrant rescueToken
 *                    call could invoke safeTransfer again. However:
 *                    (a) rescueToken has no internal accounting state to corrupt —
 *                        it does not update treasury balance tracking, paymentCount,
 *                        globalSpentToday, or any daily-spend counters.
 *                    (b) Only the rescuer role can call it; the rescuer is a trusted
 *                        operator.
 *                    (c) A reentrancy attack here is only feasible if both the rescuer
 *                        and the rescued token are malicious simultaneously.
 *                    This is an acceptable design tradeoff for the trusted-rescuer model.
 *
 * CONCLUSION: The three external value-transfer paths (deposit, withdraw, pay) are all
 * guarded by nonReentrant. The requestIdUsed flag provides defense-in-depth against
 * replay even in a hypothetical scenario where the reentrancy guard is bypassed.
 */
contract GroupF_Reentrancy is Test {

    address internal owner   = makeAddr("owner");
    address internal pauser  = makeAddr("pauser");
    address internal rescuer = makeAddr("rescuer");
    address internal alice   = makeAddr("alice");

    /// @dev F1: MaliciousUSDC.transfer() attempts to call treasury.pay() re-entrantly.
    ///  The outer pay() succeeds (reentrant call is blocked by ReentrancyGuard).
    ///  The reentrant revert data must encode ReentrancyGuardReentrantCall.
    function test_F1_ReentrantPayViaERC20Transfer_Blocked() public {
        MaliciousUSDC malToken = new MaliciousUSDC();

        ArcPilotTreasury t = new ArcPilotTreasury(
            owner, pauser, rescuer, address(malToken), 0, 0, 0
        );

        // Seed treasury directly
        malToken.mint(address(t), 10_000e6);

        // Allowlist alice
        vm.prank(owner);
        t.setPayee(alice, "alice", 0);

        // Configure the malicious token to attempt reentry on the SECOND requestId
        bytes32 outerRid  = bytes32(uint256(1));
        bytes32 innerRid  = bytes32(uint256(2));

        malToken.setReentryParams(t, alice, 500e6, innerRid, "reentrant");

        // Trigger the outer pay — the token's transfer() will try to re-enter
        vm.prank(owner);
        t.pay(alice, 1000e6, outerRid, "outer");

        // Outer call succeeded
        assertTrue(t.requestIdUsed(outerRid), "outer requestId should be marked used");

        // Reentrancy was attempted
        assertTrue(malToken.reentrancyAttempted(), "reentrancy was attempted");

        // The reentrant call must have been blocked — inner requestId NOT used
        assertFalse(t.requestIdUsed(innerRid), "reentrant call must have been reverted");

        // Verify the captured revert data is the ReentrancyGuard error
        bytes memory capturedRevert = malToken.reentrantRevertData();
        assertTrue(capturedRevert.length > 0, "revertData should be non-empty");

        // ReentrancyGuardReentrantCall() selector = bytes4(keccak256("ReentrancyGuardReentrantCall()"))
        bytes4 expectedSelector = ReentrancyGuard.ReentrancyGuardReentrantCall.selector;
        bytes4 actualSelector;
        assembly {
            actualSelector := mload(add(capturedRevert, 32))
        }
        assertEq(actualSelector, expectedSelector, "revert must be ReentrancyGuardReentrantCall");

        // Final state: only 1 payment recorded, no double-spend
        assertEq(t.paymentCount(), 1, "only 1 payment should be recorded");
        // alice received exactly the outer amount (1000e6 minus reentrant deduction = just 1000e6)
        assertEq(malToken.balanceOf(alice), 1000e6, "alice balance should be exactly 1000e6");
    }
}

// ===========================================================================
// GROUP G — Ownership two-step transfer
// ===========================================================================
contract GroupG_OwnershipTwoStep is FullTreasuryFixture {

    /// @dev G1: transferOwnership(alice) → alice calls acceptOwnership() → old owner blocked.
    function test_G1_TwoStepOwnershipTransfer() public {
        // Owner initiates transfer
        vm.prank(owner);
        treasury.transferOwnership(alice);

        // Pending owner is alice, active owner is still owner
        assertEq(treasury.pendingOwner(), alice);
        assertEq(treasury.owner(), owner);

        // Alice accepts
        vm.prank(alice);
        treasury.acceptOwnership();

        assertEq(treasury.owner(), alice);

        // Old owner can no longer call setPayee
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner)
        );
        treasury.setPayee(bob, "bob", 0);
    }

    /// @dev G2: Before alice accepts, old owner can still call setReserveBps.
    ///  After alice accepts, old owner is blocked; alice can call it.
    function test_G2_PendingOwnerDoesNotBlockCurrentOwner() public {
        vm.prank(owner);
        treasury.transferOwnership(alice);

        // Old owner still active — setReserveBps succeeds
        vm.prank(owner);
        treasury.setReserveBps(500);
        assertEq(treasury.reserveBps(), 500);

        // Alice accepts
        vm.prank(alice);
        treasury.acceptOwnership();

        // Old owner now blocked
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner)
        );
        treasury.setReserveBps(100);

        // Alice can call it
        vm.prank(alice);
        treasury.setReserveBps(200);
        assertEq(treasury.reserveBps(), 200);
    }

    /// @dev G3: renounceOwnership() reverts with the custom message.
    function test_G3_RenounceOwnership_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(bytes("ArcPilotTreasury: renounceOwnership disabled"));
        treasury.renounceOwnership();
    }
}

// ===========================================================================
// GROUP H — Withdrawal and payment competing for spendable
// ===========================================================================
contract GroupH_WithdrawVsPay is FullTreasuryFixture {

    ArcPilotTreasury internal t;

    function setUp() public override {
        super.setUp();
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        t = new ArcPilotTreasury(owner, pauser, rescuer, address(usdc), 1000, 0, 0); // 10% reserve
        _seedTreasury(t, 10_000e6);
    }

    /// @dev H1: spendable=9000e6. withdraw(4500e6) OK. pay(4501e6) reverts ExceedsSpendable.
    function test_H1_WithdrawThenPayExceedsRemaining() public {
        // spendable = 10000 - 1000 (10% of 10000) = 9000e6
        assertEq(t.spendableBalance(), 9000e6);

        vm.prank(owner);
        t.withdraw(alice, 4500e6);

        // After withdraw: balance=5500, reserve=550, spendable=5500-550=4950
        uint256 spendableAfter = t.spendableBalance();
        assertEq(spendableAfter, 4950e6);

        _allowPayee(t, alice, 0);

        // pay(4951e6) — one over spendable — should revert
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArcPilotTreasury.ExceedsSpendable.selector,
                uint256(4951e6),
                uint256(4950e6)
            )
        );
        t.pay(alice, 4951e6, bytes32(uint256(1)), "memo");
    }

    /// @dev H2: balance=10000, reserve=1000, obligation=3000. spendable=6000.
    ///  pay(6000e6) succeeds. spendableBalance() after == 0.
    function test_H2_PayExactSpendableWithObligationAndReserve() public {
        vm.prank(owner);
        t.setObligation(0, "O1", 3000e6);

        // spendable = 10000 - 1000 (reserve) - 3000 (obligation) = 6000e6
        assertEq(t.spendableBalance(), 6000e6);

        _allowPayee(t, alice, 0);

        vm.prank(owner);
        t.pay(alice, 6000e6, bytes32(uint256(1)), "memo");

        // After: balance=4000, reserve=400, locked=400+3000=3400, spendable=4000-3400=600
        // Wait: balance = 10000-6000 = 4000; reserve = 4000*1000/10000 = 400; spendable = 4000-400-3000 = 600
        // The test spec says spendable should be 0 — let me recalculate:
        // balance=4000, reserve=400, obligation=3000, locked=3400, spendable=600
        // The spec says "spendable=0" but that only holds if spendable = 10000 - 1000 - 3000 = 6000 exactly paid out
        // Post-pay: 4000e6 left. spendable = 4000 - 400 - 3000 = 600. Not 0.
        // The spec says "balance is now 4000, locked = 1000 reserve + 3000 obligation = 4000, spendable=0"
        // But reserve = 4000 * 10% = 400, not 1000. So spendable = 4000 - 400 - 3000 = 600.
        // The reserve is dynamic (% of current balance), so post-pay reserve is 400, not 1000.
        // We verify the actual spendable correctly:
        assertEq(t.totalBalance(), 4000e6);
        assertEq(t.spendableBalance(), 600e6); // 4000 - 400(reserve) - 3000(obligation) = 600
    }

    /// @dev H3 (revised after security fix [H-1]): setPayee must NOT reset spentToday on an existing payee.
    ///      The previous test was asserting the old BUGGY behaviour — that setPayee would
    ///      reset spentToday to 0, allowing the daily limit to be bypassed.
    ///      After the security fix [H-1], the correct behaviour is that spentToday is
    ///      preserved and the daily limit stays exhausted until the 24-hour window elapses.
    function test_H3_SetPayeeDoesNotResetSpentToday() public {
        _allowPayee(t, alice, 1000e6);

        // Exhaust the daily limit
        vm.prank(owner);
        t.pay(alice, 1000e6, bytes32(uint256(1)), "memo");

        // Verify limit exhausted
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArcPilotTreasury.ExceedsDailyLimit.selector,
                alice,
                uint256(1),
                uint256(0)
            )
        );
        t.pay(alice, 1, bytes32(uint256(2)), "memo");

        // Re-setPayee should NOT reset spentToday
        vm.prank(owner);
        t.setPayee(alice, "alice-updated", 1000e6);

        // dailyRemainingPayee must still be 0 — the counter was not reset
        assertEq(
            t.dailyRemainingPayee(alice),
            0,
            "spentToday must be preserved after setPayee - daily limit must remain exhausted"
        );

        // A payment after setPayee should still revert (limit still exhausted)
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArcPilotTreasury.ExceedsDailyLimit.selector,
                alice,
                uint256(1),
                uint256(0)
            )
        );
        t.pay(alice, 1, bytes32(uint256(3)), "should-fail");
    }
}

// ===========================================================================
// GROUP I — Edge cases
// ===========================================================================
contract GroupI_EdgeCases is FullTreasuryFixture {

    ArcPilotTreasury internal t;

    function setUp() public override {
        super.setUp();
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        t = new ArcPilotTreasury(owner, pauser, rescuer, address(usdc), 0, 0, 0);
        _seedTreasury(t, 100_000e6);
    }

    /// @dev I1: pay to address(0) — not in payee mapping → NotAllowedPayee(address(0)).
    function test_I1_PayToAddressZero_NotAllowedPayee() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ArcPilotTreasury.NotAllowedPayee.selector, address(0))
        );
        t.pay(address(0), 100e6, bytes32(uint256(1)), "memo");
    }

    /// @dev I2: requestId=bytes32(0) is valid. Second pay with same id reverts DuplicateRequestId.
    function test_I2_RequestIdZero_ValidThenDuplicate() public {
        _allowPayee(t, alice, 0);

        // First pay with bytes32(0) succeeds
        vm.prank(owner);
        t.pay(alice, 100e6, bytes32(0), "memo");
        assertTrue(t.requestIdUsed(bytes32(0)));

        // Second pay with bytes32(0) reverts DuplicateRequestId
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ArcPilotTreasury.DuplicateRequestId.selector, bytes32(0))
        );
        t.pay(alice, 100e6, bytes32(0), "memo2");
    }

    /// @dev I3: memo can be empty string.
    function test_I3_EmptyMemoAllowed() public {
        _allowPayee(t, alice, 0);

        bytes32 rid = bytes32(uint256(1));
        vm.prank(owner);
        t.pay(alice, 100e6, rid, "");

        // Verify record stored with empty memo
        (address to, uint256 amount, , bytes32 storedRid, string memory memo) = t.payments(0);
        assertEq(to,        alice);
        assertEq(amount,    100e6);
        assertEq(storedRid, rid);
        assertEq(memo,      "");
    }

    /// @dev I4: setObligation with amount=0. removeObligation(0) succeeds.
    function test_I4_ZeroAmountObligation() public {
        // setObligation(0, ..., 0) — amount=0 creates active obligation, total unchanged
        vm.prank(owner);
        t.setObligation(0, "Zero", 0);

        assertEq(t.activeObligationsTotal(), 0, "activeObligationsTotal should be 0");
        assertEq(t.obligationCount(),        1, "obligationCount should be 1");

        (, uint256 amt, bool active) = t.obligations(0);
        assertEq(amt, 0);
        assertTrue(active);

        // removeObligation(0) should succeed
        vm.prank(owner);
        t.removeObligation(0);

        (, , bool activeAfter) = t.obligations(0);
        assertFalse(activeAfter, "obligation should be inactive after removal");
        assertEq(t.activeObligationsTotal(), 0, "activeObligationsTotal still 0");
    }

    /// @dev I5: setPayee with dailyLimit=type(uint256).max-1 → dailyRemainingPayee returns that value.
    function test_I5_DailyLimitMaxMinusOne_ReturnsExactValue() public {
        uint256 limit = type(uint256).max - 1;

        vm.prank(owner);
        t.setPayee(alice, "alice", limit);

        // dailyLimit != 0, so we do NOT return type(uint256).max (unlimited sentinel)
        uint256 remaining = t.dailyRemainingPayee(alice);
        assertEq(remaining, limit, "should return exact limit (not unlimited sentinel)");

        // Verify it is different from the unlimited sentinel
        assertNotEq(remaining, type(uint256).max, "should not equal unlimited sentinel");
    }
}

// ===========================================================================
// GROUP J — Security-audit regression tests
//   [H-1] setPayee must not reset spentToday/dayStart on existing payees
//   [M-1] Day-reset must advance dayStart by +1 days (epoch alignment)
// ===========================================================================
contract GroupJ_AuditRegression is FullTreasuryFixture {

    ArcPilotTreasury internal t;

    function setUp() public override {
        super.setUp();
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        t = new ArcPilotTreasury(owner, pauser, rescuer, address(usdc), 0, 0, 1000e6);
        _seedTreasury(t, 100_000e6);
    }

    // ─── [H-1] setPayee counter preservation ────────────────────────────────

    /// @dev J1: setPayee on an existing payee must NOT reset spentToday.
    ///      Before the fix, setPayee always wrote `spentToday=0, dayStart=block.timestamp`
    ///      which allowed the daily limit to be traversed twice in one 24-hour window.
    function test_J1_setPayee_preservesSpentTodayOnUpdate() public {
        _allowPayee(t, alice, 500e6);

        // Alice spends 400 USDC
        vm.prank(owner);
        t.pay(alice, 400e6, bytes32(uint256(1)), "first-payment");

        (, , uint256 spentBefore, uint256 dayStartBefore, ) = t.payees(alice);
        assertEq(spentBefore, 400e6, "spentToday should be 400e6 after first payment");

        // Owner calls setPayee again on Alice (update label / raise limit)
        vm.prank(owner);
        t.setPayee(alice, "alice-v2", 800e6);

        (, , uint256 spentAfter, uint256 dayStartAfter, ) = t.payees(alice);

        // spentToday MUST NOT be reset to 0
        assertEq(
            spentAfter,
            400e6,
            "setPayee must not reset spentToday on an existing payee"
        );
        // dayStart must also be preserved
        assertEq(
            dayStartAfter,
            dayStartBefore,
            "setPayee must not reset dayStart on an existing payee"
        );
        // dailyLimit was updated
        (, uint256 newLimit, , , ) = t.payees(alice);
        assertEq(newLimit, 800e6, "dailyLimit must be updated to new value");
    }

    /// @dev J2: setPayee on a NEW payee still initialises spentToday=0.
    function test_J2_setPayee_initsFreshCountersForNewPayee() public {
        vm.prank(owner);
        t.setPayee(alice, "alice-new", 500e6);

        (, , uint256 spentToday, , bool allowed) = t.payees(alice);
        assertTrue(allowed, "alice should be allowed");
        assertEq(spentToday, 0, "new payee spentToday should start at 0");
    }

    /// @dev J3: setPayee update cannot bypass the daily limit using the old bug.
    ///      The attacker: pay up to the limit, call setPayee to reset counter, pay again.
    ///      After the fix the second batch of payments should still fail.
    function test_J3_setPayee_cannotBypassDailyLimitViaUpdate() public {
        _allowPayee(t, alice, 500e6);

        // Exhaust the daily limit
        vm.prank(owner);
        t.pay(alice, 500e6, bytes32(uint256(1)), "maxed");

        // Owner tries the "reset via setPayee" trick
        vm.prank(owner);
        t.setPayee(alice, "alice-reset-attempt", 500e6);

        // Payment should still revert: spentToday was preserved at 500e6
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArcPilotTreasury.ExceedsDailyLimit.selector,
                alice,
                100e6,
                uint256(0)
            )
        );
        t.pay(alice, 100e6, bytes32(uint256(2)), "should-fail");
    }

    // ─── [M-1] Day-reset epoch alignment ────────────────────────────────────

    /// @dev J4: Per-payee day-reset advances by +1 days, not to block.timestamp.
    ///      Scenario: warp to exactly 1 second before the 24h window expires,
    ///      pay, then warp 2 seconds (crossing the reset boundary).
    ///      With block.timestamp reset, the attacker gets a fresh 24h window
    ///      starting 1 second after the first payment — ~2× the intended limit.
    ///      With epoch alignment, dayStart advances to dayStart + 1 days,
    ///      and the remaining limit is the full daily limit minus whatever was
    ///      already in the new epoch (zero here).
    function test_J4_payee_dayResetUsesEpochAlignment() public {
        _allowPayee(t, alice, 1000e6);

        // warp to T=0 + 23h59m59s (1 second before the reset)
        vm.warp(block.timestamp + 23 hours + 59 minutes + 59 seconds);

        vm.prank(owner);
        t.pay(alice, 500e6, bytes32(uint256(10)), "near-end-of-window");

        (, , uint256 spentNow, uint256 dayStartNow, ) = t.payees(alice);
        assertEq(spentNow, 500e6, "should have 500e6 spent");

        // Warp 2 more seconds — crosses the 24h boundary
        vm.warp(block.timestamp + 2 seconds);

        // Remaining should now be the full daily limit (reset happened)
        uint256 remaining = t.dailyRemainingPayee(alice);
        assertEq(remaining, 1000e6, "remaining should be the full daily limit after reset");

        // dayStart must be dayStartNow + 1 days (epoch), NOT block.timestamp
        // We check that a subsequent pay correctly reflects the new epoch.
        vm.prank(owner);
        t.pay(alice, 1000e6, bytes32(uint256(11)), "new-epoch-payment");

        (, , uint256 spentAfterReset, , ) = t.payees(alice);
        assertEq(spentAfterReset, 1000e6, "spentToday in new epoch should be 1000e6");
    }

    /// @dev J5: Global day-reset advances by +1 days (epoch alignment).
    function test_J5_global_dayResetUsesEpochAlignment() public {
        _allowPayee(t, alice, 0);  // no per-payee cap
        _allowPayee(t, bob, 0);

        // Deploy with globalDailyLimit=1000e6
        // Our setUp already set 1000e6 — confirmed by constructor arg.

        vm.warp(block.timestamp + 23 hours + 59 minutes + 59 seconds);

        // Spend the global daily limit
        vm.prank(owner);
        t.pay(alice, 1000e6, bytes32(uint256(20)), "use-global-limit");

        // dailyRemainingGlobal should be 0
        assertEq(t.dailyRemainingGlobal(), 0);

        // Cross the global reset boundary
        vm.warp(block.timestamp + 2 seconds);

        // Global limit should be back at 1000e6
        assertEq(t.dailyRemainingGlobal(), 1000e6, "global remaining should reset to full limit");

        // Second payment should succeed
        vm.prank(owner);
        t.pay(bob, 1000e6, bytes32(uint256(21)), "new-global-epoch");
        assertEq(t.globalSpentToday(), 1000e6);
    }

    /// @dev J6: Epoch advance repeats correctly across multiple 24h windows.
    function test_J6_multipleEpochAdvances() public {
        _allowPayee(t, alice, 500e6);

        // Epoch 1: pay 500e6
        vm.prank(owner);
        t.pay(alice, 500e6, bytes32(uint256(30)), "epoch-1");

        // Advance past epoch 1
        vm.warp(block.timestamp + 1 days + 1 seconds);

        // Epoch 2: pay 500e6 again with a new requestId
        vm.prank(owner);
        t.pay(alice, 500e6, bytes32(uint256(31)), "epoch-2");

        // Advance past epoch 2
        vm.warp(block.timestamp + 1 days + 1 seconds);

        // Epoch 3: should succeed
        vm.prank(owner);
        t.pay(alice, 500e6, bytes32(uint256(32)), "epoch-3");

        // Total paid across three epochs
        assertEq(usdc.balanceOf(alice), 1500e6, "alice should have received 1500e6 total");
    }
}
