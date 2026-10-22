// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title ArcPilot
 * @notice Onchain USDC treasury with configurable obligations, reserve policy,
 *         permitted payees, per-payee spending limits, and a verifiable audit log.
 *
 * Key concepts:
 *  - totalBalance   = contract's USDC ERC-20 balance
 *  - obligations    = sum of all configured recurring obligation amounts
 *  - reserveBps     = percentage of totalBalance held as reserve (basis points, 0-10000)
 *  - spendable      = totalBalance - obligations - reserve
 *  - Payees are explicitly allowed by the owner, each with an optional per-payee daily limit
 *  - Every payment is recorded onchain as a PaymentRecord for auditability
 */
contract ArcPilot is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Token ────────────────────────────────────────────────────────────────
    /// @notice USDC token (6 decimals on Arc)
    IERC20 public immutable usdc;

    // ── Reserve policy ───────────────────────────────────────────────────────
    /// @notice Reserve as a fraction of total balance in basis points (0–10000)
    uint16 public reserveBps;

    // ── Obligations ──────────────────────────────────────────────────────────
    struct Obligation {
        string  label;
        uint256 amount;   // USDC, 6-decimal
        bool    active;
    }

    uint256 public obligationCount;
    uint256 public activeObligationsTotal;
    mapping(uint256 => Obligation) public obligations;

    // ── Payees ───────────────────────────────────────────────────────────────
    struct PayeePolicy {
        string  label;
        uint256 dailyLimit;   // 0 = no limit
        uint256 spentToday;
        uint256 dayStart;
        bool    allowed;
    }

    mapping(address => PayeePolicy) public payees;
    address[] public payeeList;

    // ── Payments ─────────────────────────────────────────────────────────────
    struct PaymentRecord {
        address to;
        uint256 amount;
        uint256 timestamp;
        string  memo;
    }

    uint256 public paymentCount;
    mapping(uint256 => PaymentRecord) public payments;

    // ── Events ───────────────────────────────────────────────────────────────
    event ObligationSet(uint256 indexed id, string label, uint256 amount);
    event ObligationRemoved(uint256 indexed id);
    event PayeeSet(address indexed payee, string label, uint256 dailyLimit);
    event PayeeRemoved(address indexed payee);
    event ReserveBpsSet(uint16 bps);
    event PaymentExecuted(uint256 indexed paymentId, address indexed to, uint256 amount, string memo);
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    // ── Custom errors ─────────────────────────────────────────────────────────
    error NotAllowedPayee(address payee);
    error ExceedsDailyLimit(address payee, uint256 requested, uint256 remaining);
    error ExceedsSpendable(uint256 requested, uint256 spendable);
    error InvalidReserveBps(uint16 bps);
    error ZeroAmount();
    error ZeroAddress();
    error ObligationNotFound(uint256 id);

    // ── Constructor ───────────────────────────────────────────────────────────
    /**
     * @param initialOwner Initial owner address
     * @param _usdc      USDC token address (0x3600...0000 on Arc)
     * @param _reserveBps Initial reserve fraction in basis points
     */
    constructor(address initialOwner, address _usdc, uint16 _reserveBps) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        if (_usdc == address(0)) revert ZeroAddress();
        if (_usdc.code.length == 0) revert ZeroAddress();
        if (_reserveBps > 10000) revert InvalidReserveBps(_reserveBps);
        usdc = IERC20(_usdc);
        reserveBps = _reserveBps;
    }

    // ── Treasury reads ────────────────────────────────────────────────────────
    /// @notice Total USDC held by this contract
    function totalBalance() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Sum of all active obligation amounts
    function totalObligations() public view returns (uint256) {
        return activeObligationsTotal;
    }

    /// @notice USDC amount held as reserve
    function reserveAmount() public view returns (uint256) {
        return (totalBalance() * reserveBps) / 10000;
    }

    /// @notice USDC available for discretionary spending
    function spendableBalance() public view returns (uint256) {
        uint256 bal = totalBalance();
        uint256 obls = totalObligations();
        uint256 rsv = (bal * reserveBps) / 10000;
        uint256 locked = obls + rsv;
        return bal > locked ? bal - locked : 0;
    }

    // ── Reserve ────────────────────────────────────────────────────────────────
    function setReserveBps(uint16 _bps) external onlyOwner {
        if (_bps > 10000) revert InvalidReserveBps(_bps);
        reserveBps = _bps;
        emit ReserveBpsSet(_bps);
    }

    // ── Obligations ────────────────────────────────────────────────────────────
    function setObligation(uint256 id, string calldata label, uint256 amount) external onlyOwner {
        Obligation storage obligation = obligations[id];
        if (obligation.active) {
            activeObligationsTotal -= obligation.amount;
        }
        activeObligationsTotal += amount;

        obligations[id] = Obligation(label, amount, true);
        if (id >= obligationCount) obligationCount = id + 1;
        emit ObligationSet(id, label, amount);
    }

    function removeObligation(uint256 id) external onlyOwner {
        if (id >= obligationCount || !obligations[id].active) revert ObligationNotFound(id);
        activeObligationsTotal -= obligations[id].amount;
        obligations[id].active = false;
        emit ObligationRemoved(id);
    }

    // ── Payees ────────────────────────────────────────────────────────────────
    function setPayee(address payee, string calldata label, uint256 dailyLimit) external onlyOwner {
        if (payee == address(0)) revert ZeroAddress();
        if (!payees[payee].allowed) {
            payeeList.push(payee);
        }
        payees[payee] = PayeePolicy({
            label: label,
            dailyLimit: dailyLimit,
            spentToday: 0,
            dayStart: block.timestamp,
            allowed: true
        });
        emit PayeeSet(payee, label, dailyLimit);
    }

    function removePayee(address payee) external onlyOwner {
        if (!payees[payee].allowed) revert NotAllowedPayee(payee);
        payees[payee].allowed = false;
        emit PayeeRemoved(payee);
    }

    function payeeCount() external view returns (uint256) {
        uint256 count = 0;
        uint256 len = payeeList.length;
        for (uint256 i = 0; i < len; i++) {
            if (payees[payeeList[i]].allowed) count++;
        }
        return count;
    }

    // ── Payments ──────────────────────────────────────────────────────────────
    /**
     * @notice Execute a USDC payment to a permitted payee.
     * @dev Enforces spendable cap and per-payee daily limit.
     */
    function pay(address to, uint256 amount, string calldata memo) external nonReentrant onlyOwner {
        if (amount == 0) revert ZeroAmount();
        if (!payees[to].allowed) revert NotAllowedPayee(to);

        // Refresh daily window
        PayeePolicy storage policy = payees[to];
        uint256 windowStart = policy.dayStart;
        if (block.timestamp >= windowStart + 1 days) {
            policy.spentToday = 0;
            policy.dayStart = block.timestamp;
        }

        // Check daily limit
        if (policy.dailyLimit > 0) {
            uint256 remaining = policy.dailyLimit - policy.spentToday;
            if (amount > remaining) revert ExceedsDailyLimit(to, amount, remaining);
        }

        // Check spendable
        uint256 spendable = spendableBalance();
        if (amount > spendable) revert ExceedsSpendable(amount, spendable);

        // Record
        policy.spentToday += amount;
        payments[paymentCount] = PaymentRecord(to, amount, block.timestamp, memo);
        emit PaymentExecuted(paymentCount, to, amount, memo);
        paymentCount++;

        usdc.safeTransfer(to, amount);
    }

    // ── Deposit / Withdraw (owner) ─────────────────────────────────────────────
    /// @notice Pull USDC into the treasury. Anyone may call this; the caller must have approved this contract to spend the amount first.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraw USDC from the treasury (owner only, respects spendable)
    function withdraw(address to, uint256 amount) external nonReentrant onlyOwner {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        uint256 spendable = spendableBalance();
        if (amount > spendable) revert ExceedsSpendable(amount, spendable);
        usdc.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    // ── Batch payment history read ─────────────────────────────────────────────
    function getPayments(uint256 offset, uint256 limit)
        external view
        returns (PaymentRecord[] memory records)
    {
        uint256 total = paymentCount;
        if (offset >= total) return new PaymentRecord[](0);
        uint256 end = offset + limit > total ? total : offset + limit;
        records = new PaymentRecord[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            records[i - offset] = payments[i];
        }
    }
}
