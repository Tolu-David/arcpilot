/**
 * shared/types.ts
 *
 * Types imported by both the React frontend (src/) and the Express backend
 * (server/). No runtime code — interfaces, enums, and plain type aliases only.
 * Keep this file free of Node.js or browser globals.
 */

// ── Payment adapter ───────────────────────────────────────────────────────────

/**
 * Which payment runtime is active.
 * Controlled by the PAYMENT_ADAPTER env var on the server.
 * - "sim"     : local simulation, never touches a blockchain
 * - "testnet" : Arc Testnet via Circle Gateway (x402-batching)
 * - "mainnet" : Arc Mainnet (requires explicit opt-in; not available in this scaffold)
 */
export type PaymentAdapterMode = 'sim' | 'testnet' | 'mainnet'

/** Result returned by every payment adapter implementation. */
export interface PaymentResult {
  mode: PaymentAdapterMode
  /** True only when funds actually moved (or were simulated as moved). */
  success: boolean
  /** Onchain tx hash (testnet/mainnet) or simulation receipt ID (sim). */
  receiptId: string
  /** Amount in USDC base units (6 decimals). */
  amountUsdc: string
  /** Unix timestamp (seconds). */
  timestamp: number
  /** Human-readable status message. */
  message: string
  /** Simulation flag — always false on testnet/mainnet, always true on sim. */
  simulated: boolean
}

// ── Service catalogue ─────────────────────────────────────────────────────────

/** One callable service offered by the ArcPilot agent-payment API. */
export interface ServiceItem {
  /** URL-safe identifier, e.g. "recommend-spend" */
  id: string
  /** Display name */
  name: string
  /** One-sentence description */
  description: string
  /** HTTP method */
  method: 'GET' | 'POST'
  /** Server-relative path, e.g. "/api/agent/recommend-spend" */
  path: string
  /** Price in USDC expressed as a decimal string, e.g. "0.010000" — empty string = free */
  priceUsdc: string
  /** Whether payment is required before the handler runs */
  requiresPayment: boolean
  /** Expected request body schema (informational, not enforced here) */
  inputSchema?: Record<string, string>
}

// ── Policy engine ─────────────────────────────────────────────────────────────

/** Snapshot of treasury state passed into the policy engine. */
export interface TreasurySnapshot {
  /** Total USDC balance in contract (base units, 6 decimals). */
  totalBalance: bigint
  /** Sum of active obligation amounts (base units). */
  activeObligationsTotal: bigint
  /** Reserve amount computed from reserveBps (base units). */
  reserveAmount: bigint
  /** Available for discretionary spending (base units). Always >= 0. */
  spendableBalance: bigint
  /** Reserve fraction in basis points (0–10 000). */
  reserveBps: number
}

/** One recommendation returned by the policy engine. */
export interface PolicyRecommendation {
  /** Short machine-readable code, e.g. "LOW_BALANCE" */
  code: string
  /** Human-readable explanation */
  message: string
  /** severity: "info" | "warning" | "critical" */
  severity: 'info' | 'warning' | 'critical'
}

/** Result of evaluating a TreasurySnapshot against the policy engine. */
export interface PolicyResult {
  healthy: boolean
  recommendations: PolicyRecommendation[]
  /** ISO-8601 timestamp of evaluation */
  evaluatedAt: string
}

// ── Payment requests ──────────────────────────────────────────────────────────

/** A payment request submitted to the server for execution. */
export interface PaymentRequest {
  /**
   * Caller-supplied idempotency key (UUID v4 or equivalent).
   * The server rejects a second request with the same key within the TTL window.
   */
  idempotencyKey: string
  /** Recipient EVM address */
  to: string
  /** Amount in USDC base units as a decimal string, e.g. "1000000" = 1 USDC */
  amountUsdc: string
  /** Free-text memo, stored in the contract audit log */
  memo: string
  /** Optional payment request ID to pass to the contract (bytes32 hex string) */
  requestId?: string
}

/** Validated and sanitised form of PaymentRequest. */
export interface ValidatedPaymentRequest {
  idempotencyKey: string
  to: `0x${string}`
  amountUsdc: bigint
  memo: string
  requestId: `0x${string}`
}

// ── Audit log ─────────────────────────────────────────────────────────────────

/** One payment record as returned from the contract. */
export interface PaymentRecord {
  to: string
  amount: string       // USDC base units as decimal string
  timestamp: number    // Unix seconds
  memo: string
}

// ── Agent service catalogue (v2) ─────────────────────────────────────────────

/**
 * Availability status returned by the server for a service.
 * - "allowed"            : policy permits this service; request can proceed
 * - "approval-required"  : exceeds an auto-approve threshold; owner must confirm
 * - "unavailable"        : service is disabled, allowlist-restricted, or policy-denied
 */
export type ServiceAvailability = 'allowed' | 'approval-required' | 'unavailable'

/**
 * Extended service descriptor returned by GET /api/catalogue.
 * Prices and recipient addresses are server-authoritative — the browser
 * must never override them.
 */
export interface CatalogueService {
  /** Stable URL-safe identifier */
  id: string
  /** Display name */
  name: string
  /** One-sentence description */
  description: string
  /** Canonical price in USDC base units (6 decimals). 0 = free. */
  priceBaseUnits: number
  /** Human-readable price, e.g. "0.50" */
  priceDisplay: string
  /** Server-controlled recipient address — never supplied by the browser */
  recipientAddress: string
  /** Whether this service is active in the catalogue */
  active: boolean
  /** Whether caller is currently on the service allowlist */
  allowlisted: boolean
  /** Server-evaluated availability */
  availability: ServiceAvailability
  /** HTTP method */
  method: 'GET' | 'POST'
  /** Server-relative path */
  path: string
  /** Whether payment is required */
  requiresPayment: boolean
  /** Optional request body schema (informational) */
  inputSchema?: Record<string, string>
}

/**
 * Result returned by POST /api/catalogue/request/:id.
 * The server validates the service ID and policy; the browser never supplies
 * a price or recipient.
 */
export interface ServiceRequestResult {
  /** Whether the request was accepted for processing */
  accepted: boolean
  /** Server-assigned request reference (idempotency) */
  requestRef: string
  /** Service ID that was requested */
  serviceId: string
  /** Price the server used — never trust the browser's copy */
  priceBaseUnits: number
  /** Denial reason when accepted=false */
  denialReason?: string
  /** Policy code when denied, e.g. "POLICY_DENIED" | "SERVICE_UNAVAILABLE" | "INVALID_SERVICE" */
  denialCode?: string
  /** ISO-8601 timestamp */
  timestamp: string
}

// ── Payment history (off-chain server log) ────────────────────────────────────

/**
 * Explicit payment request flow states.
 *
 * The flow through these states is deterministic on the happy path:
 *   Draft → PolicyChecked → Ready → Submitted → Confirmed
 *
 * Branching states:
 *   PolicyChecked → ApprovalRequired  (amount exceeds auto-approve threshold)
 *   ApprovalRequired → Ready           (owner approves)
 *   ApprovalRequired → Denied          (owner denies)
 *
 * Exception / terminal states (payment will not proceed or has failed):
 *   Denied           — policy evaluated and rejected the request
 *   RejectedByWallet — wallet or signing layer refused to sign / broadcast
 *   Reverted         — transaction mined but execution reverted onchain
 *   Cancelled        — user or system cancelled before broadcast
 *
 * Reconciliation state (outcome not yet known):
 *   Unknown          — tx broadcast but receipt could not be fetched or verified;
 *                      or the server restarted while a tx was in-flight.
 *                      Requires manual reconciliation against onchain event logs.
 *
 * IMPORTANT: "Confirmed" is ONLY set after the server has verified the receipt AND
 * validated that the logged recipient and amount match the onchain receipt.
 * A tx that exists onchain but whose details differ remains Unknown.
 */
export type PaymentFlowState =
  | 'Draft'              // request assembled; policy not yet evaluated
  | 'PolicyChecked'      // deterministic policy passed; awaiting user action
  | 'ApprovalRequired'   // policy passed but amount exceeds auto-approve threshold
  | 'Ready'              // approved and ready to broadcast
  | 'Submitted'          // transaction broadcast; awaiting onchain confirmation
  | 'Confirmed'          // receipt verified; recipient and amount match
  | 'Denied'             // policy or owner denied the request; no broadcast
  | 'RejectedByWallet'   // wallet/signer refused to sign or broadcast
  | 'Reverted'           // transaction mined but reverted onchain
  | 'Cancelled'          // cancelled before broadcast
  | 'Unknown'            // outcome undetermined; reconciliation required

/**
 * Onchain transaction status — separate from the flow state.
 *
 * Describes what is known about the actual onchain transaction.
 * A record may have flowState=Confirmed and onChainStatus=confirmed,
 * or flowState=Unknown and onChainStatus=unknown.
 *
 * submitted  — transaction hash assigned; not yet mined
 * pending    — tx in mempool; awaiting block inclusion
 * confirmed  — tx mined and receipt verified
 * reverted   — tx mined but execution reverted (EVM revert)
 * unknown    — tx hash present but receipt fetch failed or details mismatch
 */
export type PaymentOnChainStatus =
  | 'submitted'
  | 'pending'
  | 'confirmed'
  | 'reverted'
  | 'unknown'

/**
 * Service delivery status — independent of payment status.
 *
 * A payment can be Confirmed while the underlying service delivery failed or is
 * still pending.  These two axes are tracked separately.
 *
 * not-requested  — payment not yet confirmed; no service call made
 * pending        — payment confirmed; service call in flight
 * succeeded      — service responded successfully
 * failed         — payment confirmed; service returned an error or timed out
 * unknown        — service was invoked; outcome could not be determined
 */
export type ServiceDeliveryStatus =
  | 'not-requested'  // payment not yet confirmed
  | 'pending'        // payment confirmed; service call in flight
  | 'succeeded'      // service responded successfully
  | 'failed'         // payment confirmed; service returned an error
  | 'unknown'        // invoked; outcome undetermined

/**
 * Backward-compatible aliases — existing server code and tests use these names.
 * New code should prefer PaymentFlowState, PaymentOnChainStatus, and
 * ServiceDeliveryStatus above.
 *
 * @deprecated Use PaymentFlowState for the full flow state machine.
 */
export type PaymentStatus = PaymentFlowState

/**
 * @deprecated Use ServiceDeliveryStatus.
 */
export type DeliveryStatus = ServiceDeliveryStatus

/**
 * Policy decision recorded at request submission time.
 */
export interface PolicyDecision {
  /** "allowed" | "approval-required" | "denied" */
  verdict: 'allowed' | 'approval-required' | 'denied'
  /** Machine-readable code, e.g. "POLICY_OK" | "OVER_LIMIT" | "SERVICE_UNAVAILABLE" */
  code: string
  /** Human-readable reason */
  reason: string
}

/**
 * One entry in the off-chain payment log maintained by the server.
 *
 * PROVENANCE WARNING: This record is stored in server memory (or a server-side
 * database in production). It is NOT cryptographically signed or committed to a
 * blockchain. It reflects the server's view of events and may differ from
 * on-chain state if the server process was restarted or experienced an outage.
 * Treat this log as operational metadata — use the contract's PaymentExecuted
 * events as the authoritative, tamper-evident record.
 */
export interface PaymentHistoryRecord {
  /** Server-assigned UUID (stable across retries) */
  id: string
  /** Caller-supplied idempotency key */
  idempotencyKey: string
  /** bytes32 hex requestId passed to the contract */
  requestId: string
  /** Service that triggered this payment (null for direct treasury payments) */
  serviceId: string | null
  /** Server-authoritative recipient address */
  to: string
  /** Amount in USDC base units as a decimal string */
  amountUsdc: string
  /** Human-readable USDC amount, e.g. "0.50" */
  amountDisplay: string
  /** Free-text memo */
  memo: string
  /** Chain name, e.g. "Arc Testnet" */
  chain: string
  /** Chain ID */
  chainId: number
  /** Contract that executed the payment */
  contractAddress: string
  /** Token symbol */
  token: 'USDC'
  /**
   * Current position in the payment flow state machine.
   * Use this for business logic and UI rendering.
   */
  flowState: PaymentFlowState
  /**
   * Legacy field — mirrors flowState for backward compatibility.
   * @deprecated Use flowState.
   */
  status: PaymentFlowState
  /** Onchain tx hash — null until broadcast */
  txHash: string | null
  /** Policy decision recorded at submission time */
  policyDecision: PolicyDecision
  /**
   * Service delivery status — separate from payment flow state.
   * A confirmed payment may have a failed or pending delivery.
   */
  deliveryStatus: ServiceDeliveryStatus
  /** ISO-8601 submission timestamp */
  submittedAt: string
  /** ISO-8601 confirmation timestamp (null until Confirmed or Reverted) */
  confirmedAt: string | null
  /** Whether this was a simulation (sim adapter) */
  simulated: boolean

  // ── Extended audit fields (optional — present when set after initial append) ──

  /** Wallet address that submitted the transaction (source: wallet) */
  actorAddress?: string | null
  /** ERC-20 token address for this payment (source: server-config) */
  tokenAddress?: string
  /** Verified on-chain event summary — set only after verification passes */
  verifiedEvent?: VerifiedEventSummary | null
  /** Block number as decimal string — set after receipt verification */
  blockNumber?: string | null
  /** Error category for this record */
  errorCategory?: PaymentErrorCategory
  /** Reconciliation state */
  reconciliationState?: ReconciliationState
  /** ISO-8601 last-updated timestamp */
  updatedAt?: string
  /** AI advisory verdict recorded at request time (sanitised) */
  aiVerdict?: AiVerdict | null
  /** Sanitised AI reasoning string (addresses redacted) */
  aiReasoningSanitised?: string | null
  /** AI warning messages (sanitised, max 3) */
  aiWarnings?: string[]
}

/**
 * Paginated response from GET /api/payments.
 */
export interface PaymentHistoryPage {
  records: PaymentHistoryRecord[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  /** Provenance notice — always present, always displayed to the user */
  provenanceNotice: string
}

/**
 * On-chain payment event decoded from the contract's PaymentExecuted event.
 * This is the authoritative record — verifiable by anyone with RPC access.
 */
export interface OnChainPaymentEvent {
  /** Contract-assigned sequential payment index */
  paymentId: number
  /** Recipient address */
  to: string
  /** Amount in USDC base units */
  amountBaseUnits: bigint
  /** Human-readable amount */
  amountDisplay: string
  /** Memo string from the event */
  memo: string
  /** Block number */
  blockNumber: number
  /** Block timestamp (unix seconds) */
  blockTimestamp: number
  /** Transaction hash */
  txHash: string
}

// ── Spending policy ───────────────────────────────────────────────────────────

/**
 * Machine-readable reason codes produced by the spending-policy evaluator.
 *
 * POLICY_OK           — all checks passed; payment may proceed
 * APPROVAL_REQUIRED   — checks passed but amount exceeds auto-approve threshold
 * SERVICE_NOT_FOUND   — service ID is not in the catalogue
 * SERVICE_UNAVAILABLE — service is inactive
 * SERVICE_NOT_ALLOWLISTED — caller is not on the service allowlist
 * INVALID_AMOUNT      — amount is zero, negative, or not an integer string
 * TX_LIMIT_EXCEEDED   — amount exceeds maxTxAmount
 * DAILY_LIMIT_EXCEEDED — amount exceeds the remaining global daily budget
 * RESERVE_BREACH      — payment would reduce spendable balance below zero
 * INSUFFICIENT_FUNDS  — spendable balance is zero (treasury empty or fully obligated)
 * TREASURY_PAUSED     — contract is paused; no payments can execute
 * STALE_STATE         — contract state snapshot is older than the staleness threshold
 */
export type SpendingPolicyReasonCode =
  | 'POLICY_OK'
  | 'APPROVAL_REQUIRED'
  | 'SERVICE_NOT_FOUND'
  | 'SERVICE_UNAVAILABLE'
  | 'SERVICE_NOT_ALLOWLISTED'
  | 'INVALID_AMOUNT'
  | 'TX_LIMIT_EXCEEDED'
  | 'DAILY_LIMIT_EXCEEDED'
  | 'RESERVE_BREACH'
  | 'INSUFFICIENT_FUNDS'
  | 'TREASURY_PAUSED'
  | 'STALE_STATE'

/**
 * A fresh read of the on-chain contract state, fetched immediately before
 * policy evaluation.  All monetary values are in USDC base units (bigint).
 *
 * `fetchedAt` is the Unix timestamp (ms) at which the RPC call returned.
 * The evaluator rejects snapshots older than STALE_STATE_THRESHOLD_MS.
 */
export interface ContractStateSnapshot {
  /** USDC base units held by the contract. */
  totalBalance: bigint
  /** Sum of all active obligation amounts. */
  activeObligationsTotal: bigint
  /** Reserve held back (= totalBalance * reserveBps / 10_000). */
  reserveAmount: bigint
  /** Available for discretionary spending (= totalBalance - obligations - reserve, floored at 0). */
  spendableBalance: bigint
  /** Reserve fraction in basis points. */
  reserveBps: number
  /** Per-transaction cap (0 = no cap). */
  maxTxAmount: bigint
  /** Global daily spend limit (0 = no limit). */
  globalDailyLimit: bigint
  /** Global daily spend remaining at snapshot time. */
  dailyRemainingGlobal: bigint
  /** Whether the contract is currently paused. */
  paused: boolean
  /** Unix timestamp (ms) at which this snapshot was fetched. */
  fetchedAt: number
}

/**
 * Input to the spending-policy evaluator.
 * All fields are validated inside the evaluator — never trust caller-supplied
 * amounts or recipients.
 */
export interface SpendingPolicyRequest {
  /**
   * Service ID as it appears in the extended catalogue.
   * The evaluator looks up the canonical price and recipient from the catalogue;
   * no amount or recipient is accepted from the caller.
   */
  serviceId: string
}

/**
 * The policy values that were active at evaluation time.
 * Returned inside SpendingPolicyResult so the caller can log exactly what
 * limits applied, without having to re-fetch state.
 */
export interface SpendingPolicyContext {
  serviceId: string
  /** Canonical price in USDC base units, from the server catalogue. */
  priceBaseUnits: bigint
  /** Human-readable price, e.g. "0.50". */
  priceDisplay: string
  /** Auto-approve threshold in base units. */
  autoApproveThreshold: bigint
  /** Contract maxTxAmount (0 = unlimited). */
  maxTxAmount: bigint
  /** Contract globalDailyLimit (0 = unlimited). */
  globalDailyLimit: bigint
  /** Remaining global daily budget at snapshot time. */
  dailyRemainingGlobal: bigint
  /** Contract spendableBalance at snapshot time. */
  spendableBalance: bigint
  /** Whether the contract was paused at snapshot time. */
  paused: boolean
  /** Unix timestamp (ms) of the contract state snapshot. */
  snapshotAge: number
}

/**
 * Result of a spending-policy evaluation.
 *
 * The contract remains the final enforcement boundary.  This result is
 * advisory — a POLICY_OK here does not guarantee the on-chain transaction
 * will succeed (state may change between evaluation and broadcast).
 */
export interface SpendingPolicyResult {
  /** True when allowed === true and approvalRequired === false. */
  allowed: boolean
  /** Whether the request is accepted but requires human sign-off. */
  approvalRequired: boolean
  /** Machine-readable decision code. */
  reasonCode: SpendingPolicyReasonCode
  /** User-readable explanation of the decision. */
  explanation: string
  /** Canonical service ID resolved from the catalogue. */
  serviceId: string
  /** Canonical price in USDC base units (from catalogue, not caller). */
  priceBaseUnits: bigint
  /** Policy values active at evaluation time. */
  context: SpendingPolicyContext
  /** ISO-8601 timestamp of evaluation. */
  evaluatedAt: string
}

// ── AI recommendation ─────────────────────────────────────────────────────────

/**
 * Advisory verdicts the AI model may return.
 *
 * - "recommend"          : model advises proceeding with the payment
 * - "reject"             : model advises against the payment
 * - "request-approval"   : model advises escalating for human sign-off
 * - "choose_alternative" : model advises using a different catalogue service
 *                          (alternatives[] must be non-empty; backend validates every ID)
 */
export type AiVerdict =
  | 'recommend'
  | 'reject'
  | 'request-approval'
  | 'choose_alternative'

/**
 * Structured output returned by the AI model and validated server-side.
 *
 * Shape mirrors the user-facing contract:
 *   { recommendation, serviceId, reasoning, warnings, alternatives }
 *
 * Security invariants enforced by the server before this type is constructed:
 *  - `recommendation` must be one of the four permitted AiVerdict values.
 *  - `serviceId` must match the requested service ID — the model may not redirect
 *    a payment to a different service via this field.
 *  - `reasoning` must be ≤200 chars and must not contain wallet or contract addresses.
 *  - `warnings` is an array of plain-text advisory notes (≤3 items, ≤150 chars each).
 *    No executable content; address-like strings are rejected.
 *  - `alternatives` is an array of catalogue service IDs (≤3 items).
 *    Every ID is validated against the live server catalogue — the model cannot
 *    invent a service.  The backend resolves the canonical price and recipient
 *    from the catalogue; the model-supplied ID is used only as a lookup key.
 *    Must be empty for any verdict other than "choose_alternative".
 *  - The model never supplies an amount, recipient address, contract address, or
 *    calldata — those fields are absent from the schema and rejected if present.
 */
export interface AiRecommendationOutput {
  /**
   * Advisory verdict for the proposed payment.
   * One of: "recommend" | "reject" | "request-approval" | "choose_alternative".
   */
  recommendation: AiVerdict

  /**
   * The service ID this recommendation applies to.
   * The server verifies this matches the requested service ID — any mismatch
   * is treated as a schema violation and the AI result is discarded.
   */
  serviceId: string

  /**
   * One-sentence advisory reasoning (max 200 chars).
   * Must not contain wallet addresses, contract addresses, amounts, or calldata.
   */
  reasoning: string

  /**
   * Optional advisory warnings (≤3 items, each ≤150 chars).
   * Plain-text only.  The server rejects any warning containing an address-like string.
   */
  warnings: string[]

  /**
   * Catalogue service IDs to consider as alternatives (≤3 items).
   * Non-empty only when recommendation === "choose_alternative".
   * Every ID is validated against the live server catalogue.
   * The backend resolves the canonical price and recipient from the catalogue
   * for each alternative — model-supplied prices and addresses are never used.
   */
  alternatives: string[]
}

/**
 * Full response from POST /api/catalogue/recommend.
 *
 * The deterministic policy result is always included.
 * The AI recommendation is included when the model responds successfully;
 * otherwise `aiError` explains why AI was unavailable and `aiRecommendation`
 * is null.  Policy enforcement decisions must NEVER be derived from the AI
 * section — only from `policy`.
 */
export interface RecommendationResponse {
  /** Canonical service ID resolved from the catalogue. */
  serviceId: string
  /** Server-authoritative price in USDC base units (decimal string for JSON). */
  priceBaseUnits: string
  /** Deterministic spending-policy result — always present. */
  policy: {
    allowed: boolean
    approvalRequired: boolean
    reasonCode: SpendingPolicyReasonCode
    explanation: string
    evaluatedAt: string
  }
  /**
   * Spendable USDC balance at evaluation time (base units, decimal string).
   * Derived from the contract state snapshot — displayed in the UI as context.
   * Never use this value as an authoritative balance for payment authorisation.
   */
  spendable: string
  /**
   * Remaining global daily budget at evaluation time (base units, decimal string).
   * Advisory only — recheck at payment time.
   */
  dailyRemaining: string
  /** AI advisory recommendation — null when unavailable. */
  aiRecommendation: AiRecommendationOutput | null
  /** Human-readable error when AI is unavailable. */
  aiError: string | null
  /** ISO-8601 timestamp of the full evaluation. */
  evaluatedAt: string
}

// ── Payment preparation ───────────────────────────────────────────────────────

/**
 * Request body accepted by POST /api/prepare.
 *
 * The caller supplies only a service ID and an idempotency key.
 * ALL monetary values, recipient addresses, contract addresses, and
 * network parameters are resolved server-side from trusted sources.
 * The browser must NEVER supply a `to`, `amount`, or `contractAddress`.
 */
export interface PaymentPreparationRequest {
  /**
   * Service to prepare a payment for.
   * Resolved against the server catalogue — the server derives the canonical
   * recipient and amount.  An unknown ID returns 404.
   */
  serviceId: string
  /**
   * Caller-supplied idempotency key (UUID v4 recommended, max 128 chars).
   * Repeated requests with the same key and same canonical payload return
   * the cached preparation receipt without re-running policy.
   * Reusing the key with a different payload returns 409 IDEMPOTENCY_KEY_CONFLICT.
   */
  idempotencyKey: string
  /**
   * Optional short memo (max 128 chars).  Stored in the log and passed to
   * the contract as the audit trail note.  Treated as untrusted user input —
   * sanitised before use.
   */
  memo?: string
}

/**
 * One idempotency record stored server-side.
 * Binds a key to an actor (placeholder for future auth) and a payload hash
 * so that key-reuse with a different payload can be detected.
 */
export interface IdempotencyRecord {
  /** The caller-supplied idempotency key. */
  key: string
  /**
   * SHA-256 hex digest of the canonical payload:
   *   serviceId + '\x00' + to + '\x00' + amountBaseUnits.toString()
   * Used to detect payload mismatch on key reuse.
   */
  payloadHash: string
  /** ISO-8601 timestamp when this record was created. */
  createdAt: string
  /** Server-assigned preparation record ID (mirrors PaymentHistoryRecord.id). */
  prepId: string
}

/**
 * Full payment preparation receipt returned by POST /api/prepare.
 *
 * Contains everything the wallet/signing layer needs to construct and sign
 * the transaction, plus the policy result and approval state so the UI can
 * decide whether to show a Review Payment or Request Approval action.
 *
 * IMPORTANT: This receipt does NOT reserve funds, does NOT authorise a
 * transaction, and does NOT guarantee the on-chain call will succeed.
 * Contract state may change between preparation and broadcast.
 * The contract enforces duplicate prevention via its on-chain requestId store.
 */
export interface PaymentPreparationReceipt {
  /** Server-assigned preparation ID (stable across retries). */
  prepId: string
  /** Idempotency key that produced this receipt. */
  idempotencyKey: string
  /**
   * Deterministic bytes32 requestId derived from the idempotency key and
   * canonical payload.  Pass this to the contract's executePayment call.
   * The contract's on-chain requestId store prevents duplicate execution even
   * if the signing layer does not check for duplicates.
   */
  requestId: string
  /** True when this response was served from the idempotency cache. */
  cached: boolean

  // ── Canonical payment parameters (all server-authoritative) ──────────────
  /** Service that was resolved. */
  serviceId: string
  /** Server-authoritative recipient address (from catalogue). */
  recipient: string
  /** Amount in USDC base units as a decimal string (from catalogue). */
  amountBaseUnits: string
  /** Human-readable amount, e.g. "0.50". */
  amountDisplay: string
  /** Sanitised memo (max 128 chars). */
  memo: string

  // ── Network and contract parameters ──────────────────────────────────────
  /** Chain name, e.g. "Arc Testnet". */
  chain: string
  /** Chain ID as a number. */
  chainId: number
  /** Contract address to call. */
  contractAddress: string
  /** ERC-20 token address (USDC). */
  tokenAddress: string

  // ── Policy result ─────────────────────────────────────────────────────────
  /** Current flow state after preparation: PolicyChecked or ApprovalRequired. */
  flowState: Extract<PaymentFlowState, 'PolicyChecked' | 'ApprovalRequired'>
  /** Deterministic policy result at preparation time. */
  policy: {
    allowed: boolean
    approvalRequired: boolean
    reasonCode: SpendingPolicyReasonCode
    explanation: string
    evaluatedAt: string
  }
  /**
   * Spendable balance at policy-check time (decimal string, base units).
   * Advisory only — state may change before broadcast.
   */
  spendableAtCheck: string
  /**
   * Remaining global daily budget at policy-check time (decimal string).
   * Advisory only.
   */
  dailyRemainingAtCheck: string

  /** ISO-8601 timestamp of this preparation. */
  preparedAt: string
}

// ── Transaction verification ──────────────────────────────────────────────────

/**
 * Result of verifying a mined transaction receipt against a preparation receipt.
 *
 * The verifier checks:
 *  1. Chain ID matches the preparation receipt
 *  2. Transaction did not revert (status === 'success')
 *  3. PaymentExecuted event present with matching requestId, recipient, and amount
 *  4. ERC-20 Transfer log present (from = contract, to = recipient, value = amount)
 *     where available in the receipt logs
 *
 * "Confirmed" is ONLY set when ALL checks pass.
 * Any log mismatch, missing event, or chain mismatch resolves to a specific
 * failure code rather than silently confirming.
 */
export type TxVerificationOutcome =
  | 'confirmed'           // all checks passed
  | 'reverted'            // tx mined; EVM execution reverted
  | 'wrong-chain'         // chainId in receipt ≠ preparation chainId
  | 'event-not-found'     // PaymentExecuted event absent from logs
  | 'event-mismatch'      // event present but requestId / to / amount wrong
  | 'transfer-mismatch'   // Transfer log found but from/to/value mismatch
  | 'receipt-timeout'     // RPC did not return a receipt within the deadline
  | 'unknown'             // catch-all for unexpected errors

export interface TxVerificationResult {
  outcome: TxVerificationOutcome
  /** True only when outcome === 'confirmed'. */
  verified: boolean
  /** Matching PaymentFlowState to apply to the record. */
  flowState: Extract<PaymentFlowState,
    'Confirmed' | 'Reverted' | 'Unknown'>
  /** Human-readable explanation of the outcome. */
  explanation: string
  /** Transaction hash — always present (even on timeout, so it can be retained). */
  txHash: `0x${string}`
  /** Block number when the tx was mined (null on timeout or pre-mine failure). */
  blockNumber: bigint | null
  /**
   * Decoded PaymentExecuted event fields, if the event was found.
   * Present even on event-mismatch so the caller can log what was actually emitted.
   */
  decodedEvent: {
    requestId: `0x${string}`
    to: `0x${string}`
    amount: bigint
    memo: string
  } | null
}

// ── Reconciliation ────────────────────────────────────────────────────────────

/**
 * Reconciliation state for a payment record.
 *
 * none          — no reconciliation needed (terminal state or not yet submitted)
 * pending       — submitted/unknown; awaiting receipt fetch
 * in-progress   — reconciliation loop has fetched a receipt and is verifying
 * resolved      — chain outcome established; record updated to Confirmed/Reverted
 * failed        — reconciliation could not establish the outcome (persistent RPC failure)
 */
export type ReconciliationState =
  | 'none'
  | 'pending'
  | 'in-progress'
  | 'resolved'
  | 'failed'

/**
 * Error category for a payment record.
 *
 * none              — no error
 * policy-denial     — rejected by deterministic policy before broadcast
 * wallet-rejection  — user or wallet refused to sign
 * rpc-error         — RPC call failed; tx may or may not have been broadcast
 * revert            — tx mined but EVM execution reverted
 * verification-fail — receipt fetched but event verification failed
 * timeout           — receipt request timed out; outcome unknown
 * service-failure   — payment confirmed but service delivery failed
 * unknown           — catch-all
 */
export type PaymentErrorCategory =
  | 'none'
  | 'policy-denial'
  | 'wallet-rejection'
  | 'rpc-error'
  | 'revert'
  | 'verification-fail'
  | 'timeout'
  | 'service-failure'
  | 'unknown'

/**
 * Verified on-chain event summary recorded after receipt verification.
 * Present only after verification succeeds (outcome === 'confirmed').
 */
export interface VerifiedEventSummary {
  /** Transaction hash */
  txHash: string
  /** Block number */
  blockNumber: string
  /** Decoded recipient address from PaymentExecuted event */
  eventRecipient: string
  /** Decoded amount from PaymentExecuted event (base units, decimal string) */
  eventAmountBaseUnits: string
  /** Decoded requestId bytes32 from PaymentExecuted event */
  eventRequestId: string
  /** Whether the ERC-20 Transfer log was also verified */
  transferVerified: boolean
  /** ISO-8601 verification timestamp */
  verifiedAt: string
}

/**
 * Full audit record — extends PaymentHistoryRecord with every field
 * required for the complete audit trail.
 *
 * IMPORTANT: Fields with source="server-log" are the server's view of
 * events and are NOT cryptographically tamper-evident.
 * Fields with source="onchain" are derived from verified transaction receipts
 * and event logs, which are independently verifiable via any RPC endpoint.
 */
export interface AuditRecord {
  // ── Identity ──────────────────────────────────────────────────────────────
  /** Server-assigned record UUID (source: server-log) */
  id: string
  /** Caller-supplied idempotency key (source: server-log) */
  idempotencyKey: string
  /** bytes32 hex requestId passed to the contract (source: server-log + onchain) */
  requestIdHex: string

  // ── Actor ─────────────────────────────────────────────────────────────────
  /** Wallet address that submitted the transaction, if known (source: server-log) */
  actorAddress: string | null
  /** ISO-8601 timestamp when the request was received (source: server-log) */
  submittedAt: string

  // ── Service and payment parameters ────────────────────────────────────────
  /** Service ID (source: server-log, resolved from catalogue) */
  serviceId: string | null
  /** Server-authoritative recipient address (source: catalogue) */
  recipient: string
  /** Amount in USDC base units, decimal string (source: catalogue) */
  amountBaseUnits: string
  /** Human-readable USDC amount (source: catalogue) */
  amountDisplay: string
  /** Free-text memo (sanitised; source: server-log) */
  memo: string

  // ── Network and contract ──────────────────────────────────────────────────
  /** Chain ID (source: server-config) */
  chainId: number
  /** Chain name (source: server-config) */
  chain: string
  /** Treasury contract address (source: server-config) */
  contractAddress: string
  /** ERC-20 token address (source: server-config) */
  tokenAddress: string

  // ── Policy result ─────────────────────────────────────────────────────────
  /** Deterministic policy verdict at submission time (source: server-log) */
  policyVerdict: 'allowed' | 'approval-required' | 'denied'
  /** Machine-readable policy reason code (source: server-log) */
  policyReasonCode: string
  /** Human-readable policy explanation (source: server-log) */
  policyExplanation: string
  /** Whether human approval was required (source: server-log) */
  approvalRequired: boolean

  // ── AI recommendation (sanitised metadata only) ───────────────────────────
  /** AI advisory verdict — null if AI was unavailable (source: server-log) */
  aiVerdict: AiVerdict | null
  /**
   * Sanitised AI reasoning — original reasoning with address-like strings
   * redacted. Never store the raw model output. (source: server-log)
   */
  aiReasoningSanitised: string | null
  /** AI warning messages (sanitised). Max 3 items. (source: server-log) */
  aiWarnings: string[]

  // ── Transaction ───────────────────────────────────────────────────────────
  /** Onchain tx hash — null until broadcast (source: wallet/onchain) */
  txHash: string | null
  /** Block number — null until mined (source: onchain) */
  blockNumber: string | null

  // ── Verification ─────────────────────────────────────────────────────────
  /**
   * Verified on-chain event summary — null until verification succeeds.
   * Only set after ALL verification checks pass (contract, event, Transfer log).
   * Source: onchain — independently verifiable.
   */
  verifiedEvent: VerifiedEventSummary | null

  // ── Status ────────────────────────────────────────────────────────────────
  /** Current payment flow state (source: server-log + onchain) */
  flowState: PaymentFlowState
  /** Service delivery status (source: server-log) */
  deliveryStatus: ServiceDeliveryStatus
  /** Error category (source: server-log) */
  errorCategory: PaymentErrorCategory
  /** Reconciliation state (source: server-log) */
  reconciliationState: ReconciliationState
  /** ISO-8601 confirmation timestamp (source: onchain) */
  confirmedAt: string | null
  /** ISO-8601 last-updated timestamp (source: server-log) */
  updatedAt: string

  // ── Provenance ────────────────────────────────────────────────────────────
  /**
   * Always present. Distinguishes server-log metadata from on-chain evidence.
   * Fields marked source="onchain" are derived from verified transaction receipts.
   * Fields marked source="server-log" are the server's operational view only.
   */
  provenanceNote: string
}

/** Response shape for the /api/agent/audit-summary endpoint. */
export interface AuditSummary {
  totalPayments: number
  totalUsdc: string    // formatted, e.g. "12.500000"
  uniquePayees: number
  summary: string
  paidBy: string
  amountUsdc: string
  timestamp: string    // ISO-8601
}
