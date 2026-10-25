// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract ArcPilotTreasury is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error ZeroAmount();
    error NotAContract(address addr);
    error InvalidReserveBps(uint16 bps);
    error NotAllowedPayee(address payee);
    error DuplicateRequestId(bytes32 requestId);
    error ExceedsSpendable(uint256 requested, uint256 available);
    error ExceedsDailyLimit(address payee, uint256 requested, uint256 remaining);
    error ExceedsGlobalDailyLimit(uint256 requested, uint256 remaining);
    error ExceedsMaxTxAmount(uint256 requested, uint256 max);
    error ObligationNotFound(uint256 id);
    error CannotRescueUSDC();
    error NotPauser();
    error NotRescuer();

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

    IERC20 public immutable usdc;
    address public pauser;
    address public rescuer;
    uint16 public reserveBps;
    uint256 public maxTxAmount;
    uint256 public globalDailyLimit;
    uint256 public globalSpentToday;
    uint256 public globalDayStart;
    uint256 public activeObligationsTotal;
    uint256 public obligationCount;

    struct Obligation {
        string label;
        uint256 amount;
        bool active;
    }

    mapping(uint256 => Obligation) public obligations;

    struct PayeePolicy {
        string label;
        uint256 dailyLimit;
        uint256 spentToday;
        uint256 dayStart;
        bool allowed;
    }

    mapping(address => PayeePolicy) public payees;
    address[] internal _payeeList;
    uint256 public activePayeeCount;
    mapping(address => bool) internal _payeeEverAdded;
    mapping(bytes32 => bool) public requestIdUsed;
    uint256 public paymentCount;

    struct PaymentRecord {
        address to;
        uint256 amount;
        uint256 timestamp;
        bytes32 requestId;
        string memo;
    }

    mapping(uint256 => PaymentRecord) public payments;

    modifier onlyPauser() {
        if (msg.sender != pauser) revert NotPauser();
        _;
    }

    modifier onlyRescuer() {
        if (msg.sender != rescuer) revert NotRescuer();
        _;
    }

    constructor(
        address initialOwner,
        address initialPauser,
        address initialRescuer,
        address _usdc,
        uint16 _reserveBps,
        uint256 _maxTxAmount,
        uint256 _globalDailyLimit
    ) Ownable(initialOwner) {
        if (initialPauser == address(0)) revert ZeroAddress();
        if (initialRescuer == address(0)) revert ZeroAddress();
        if (_usdc == address(0)) revert ZeroAddress();
        if (_usdc.code.length == 0) revert NotAContract(_usdc);
        if (_reserveBps > 10000) revert InvalidReserveBps(_reserveBps);

        usdc = IERC20(_usdc);
        reserveBps = _reserveBps;
        maxTxAmount = _maxTxAmount;
        globalDailyLimit = _globalDailyLimit;
        pauser = initialPauser;
        rescuer = initialRescuer;
        globalDayStart = block.timestamp;
    }

    function totalBalance() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function totalObligations() public view returns (uint256) {
        return activeObligationsTotal;
    }

    function reserveAmount() public view returns (uint256) {
        return (totalBalance() * reserveBps) / 10000;
    }

    function spendableBalance() public view returns (uint256) {
        uint256 bal = totalBalance();
        uint256 locked = activeObligationsTotal + (bal * reserveBps) / 10000;
        return bal > locked ? bal - locked : 0;
    }

    function dailyRemainingGlobal() public view returns (uint256) {
        if (globalDailyLimit == 0) return type(uint256).max;
        if (block.timestamp >= globalDayStart + 1 days) return globalDailyLimit;
        return globalDailyLimit > globalSpentToday ? globalDailyLimit - globalSpentToday : 0;
    }

    function dailyRemainingPayee(address payee) public view returns (uint256) {
        PayeePolicy storage p = payees[payee];
        if (!p.allowed) revert NotAllowedPayee(payee);
        if (p.dailyLimit == 0) return type(uint256).max;
        if (block.timestamp >= p.dayStart + 1 days) return p.dailyLimit;
        return p.dailyLimit > p.spentToday ? p.dailyLimit - p.spentToday : 0;
    }

    function payeeCount() external view returns (uint256) {
        return activePayeeCount;
    }

    function getPayments(uint256 offset, uint256 limit) external view returns (PaymentRecord[] memory records) {
        uint256 total = paymentCount;
        if (offset >= total || limit == 0) {
            return new PaymentRecord[](0);
        }

        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }

        records = new PaymentRecord[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            records[i - offset] = payments[i];
        }
    }

    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    function withdraw(address to, uint256 amount) external nonReentrant onlyOwner whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        uint256 spendable = spendableBalance();
        if (amount > spendable) revert ExceedsSpendable(amount, spendable);

        usdc.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    function pay(address to, uint256 amount, bytes32 requestId, string calldata memo)
        external
        nonReentrant
        onlyOwner
        whenNotPaused
    {
        if (amount == 0) revert ZeroAmount();
        if (requestIdUsed[requestId]) revert DuplicateRequestId(requestId);
        if (!payees[to].allowed) revert NotAllowedPayee(to);
        if (maxTxAmount != 0 && amount > maxTxAmount) revert ExceedsMaxTxAmount(amount, maxTxAmount);

        if (block.timestamp >= globalDayStart + 1 days) {
            globalSpentToday = 0;
            globalDayStart = block.timestamp;
        }

        if (globalDailyLimit != 0 && globalSpentToday + amount > globalDailyLimit) {
            revert ExceedsGlobalDailyLimit(amount, globalDailyLimit - globalSpentToday);
        }

        PayeePolicy storage policy = payees[to];
        if (block.timestamp >= policy.dayStart + 1 days) {
            policy.spentToday = 0;
            policy.dayStart = block.timestamp;
        }

        if (policy.dailyLimit != 0 && policy.spentToday + amount > policy.dailyLimit) {
            revert ExceedsDailyLimit(to, amount, policy.dailyLimit - policy.spentToday);
        }

        uint256 spendable = spendableBalance();
        if (amount > spendable) revert ExceedsSpendable(amount, spendable);

        requestIdUsed[requestId] = true;
        globalSpentToday += amount;
        policy.spentToday += amount;

        uint256 pid = paymentCount;
        payments[pid] = PaymentRecord(to, amount, block.timestamp, requestId, memo);
        paymentCount++;

        emit PaymentExecuted(pid, to, amount, requestId, memo);
        usdc.safeTransfer(to, amount);
    }

    function setObligation(uint256 id, string calldata label, uint256 amount) external onlyOwner {
        if (obligations[id].active) {
            activeObligationsTotal -= obligations[id].amount;
        }

        activeObligationsTotal += amount;
        obligations[id] = Obligation(label, amount, true);

        if (id >= obligationCount) {
            obligationCount = id + 1;
        }

        emit ObligationSet(id, label, amount);
    }

    function removeObligation(uint256 id) external onlyOwner {
        if (id >= obligationCount || !obligations[id].active) revert ObligationNotFound(id);

        activeObligationsTotal -= obligations[id].amount;
        obligations[id].active = false;

        emit ObligationRemoved(id);
    }

    function setPayee(address payee, string calldata label, uint256 dailyLimit) external onlyOwner {
        if (payee == address(0)) revert ZeroAddress();

        if (!_payeeEverAdded[payee]) {
            _payeeList.push(payee);
            _payeeEverAdded[payee] = true;
        }

        if (!payees[payee].allowed) {
            activePayeeCount++;
        }

        payees[payee] = PayeePolicy(label, dailyLimit, 0, block.timestamp, true);
        emit PayeeSet(payee, label, dailyLimit);
    }

    function removePayee(address payee) external onlyOwner {
        if (!payees[payee].allowed) revert NotAllowedPayee(payee);

        activePayeeCount--;
        payees[payee].allowed = false;
        emit PayeeRemoved(payee);
    }

    function setReserveBps(uint16 bps) external onlyOwner {
        if (bps > 10000) revert InvalidReserveBps(bps);

        reserveBps = bps;
        emit ReserveBpsSet(bps);
    }

    function setMaxTxAmount(uint256 amount) external onlyOwner {
        maxTxAmount = amount;
        emit MaxTxAmountSet(amount);
    }

    function setGlobalDailyLimit(uint256 limit) external onlyOwner {
        globalDailyLimit = limit;
        emit GlobalDailyLimitSet(limit);
    }

    function setPauser(address addr) external onlyOwner {
        if (addr == address(0)) revert ZeroAddress();

        pauser = addr;
        emit PauserSet(addr);
    }

    function setRescuer(address addr) external onlyOwner {
        if (addr == address(0)) revert ZeroAddress();

        rescuer = addr;
        emit RescuerSet(addr);
    }

    function pause() external onlyPauser whenNotPaused {
        _pause();
    }

    function unpause() external onlyPauser whenPaused {
        _unpause();
    }

    function rescueToken(address token, address to, uint256 amount) external onlyRescuer {
        if (token == address(usdc)) revert CannotRescueUSDC();
        if (to == address(0)) revert ZeroAddress();

        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    /// @notice Ownership can never be renounced on this contract.
    /// @dev Overrides Ownable.renounceOwnership to prevent permanent lock of treasury funds.
    ///      Ownership transfer is always two-step via Ownable2Step (transferOwnership + acceptOwnership).
    function renounceOwnership() public pure override {
        revert("ArcPilotTreasury: renounceOwnership disabled");
    }
}
