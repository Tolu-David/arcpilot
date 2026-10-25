/**
 * server/payment-log.ts
 *
 * In-process payment history log.
 *
 * PROVENANCE: This store lives in server memory.  It is NOT a blockchain — it
 * is not cryptographically signed, not tamper-evident, and not persistent across
 * process restarts.  It records the server's view of each payment request as it
 * moves through the lifecycle.  The authoritative, verifiable record is the
 * ArcPilotTreasury contract's PaymentExecuted event log.
 *
 * In production, replace the Map with a database write.  The interface is
 * unchanged — callers only use appendPayment(), updatePayment(), getPayment(),
 * and listPayments().
 */

import { randomUUID } from 'crypto'
import type {
  PaymentHistoryRecord,
  PaymentHistoryPage,
  PaymentFlowState,
  ServiceDeliveryStatus,
  PolicyDecision,
  PaymentErrorCategory,
  ReconciliationState,
  VerifiedEventSummary,
  AiVerdict,
  AuditRecord,
} from '../shared/types.js'

export const PROVENANCE_NOTICE =
  'This log is maintained by the ArcPilot server process. ' +
  'It is NOT stored on-chain and is not tamper-evident. ' +
  "Use the contract's PaymentExecuted events for the authoritative, verifiable record."

// Module-level store — one instance per process.
const log = new Map<string, PaymentHistoryRecord>()

// Insertion-order list of IDs for stable pagination.
const insertionOrder: string[] = []

// ── Write API ─────────────────────────────────────────────────────────────────

export interface AppendParams {
  idempotencyKey: string
  requestId: string
  serviceId: string | null
  to: string
  amountUsdc: string
  amountDisplay: string
  memo: string
  chain: string
  chainId: number
  contractAddress: string
  tokenAddress?: string
  policyDecision: PolicyDecision
  simulated: boolean
  actorAddress?: string | null
  aiVerdict?: AiVerdict | null
  aiReasoningSanitised?: string | null
  aiWarnings?: string[]
}

/**
 * Create a new log entry in the Draft flow state.
 * Returns the server-assigned record ID.
 */
export function appendPayment(params: AppendParams): string {
  const id = randomUUID()
  const now = new Date().toISOString()
  const record: PaymentHistoryRecord = {
    id,
    idempotencyKey: params.idempotencyKey,
    requestId: params.requestId,
    serviceId: params.serviceId,
    to: params.to,
    amountUsdc: params.amountUsdc,
    amountDisplay: params.amountDisplay,
    memo: params.memo,
    chain: params.chain,
    chainId: params.chainId,
    contractAddress: params.contractAddress,
    token: 'USDC',
    flowState: 'Draft',
    status: 'Draft',           // backward-compat alias
    txHash: null,
    policyDecision: params.policyDecision,
    deliveryStatus: 'not-requested',
    submittedAt: now,
    confirmedAt: null,
    simulated: params.simulated,
    // Extended audit fields
    tokenAddress: params.tokenAddress,
    actorAddress: params.actorAddress ?? null,
    aiVerdict: params.aiVerdict ?? null,
    aiReasoningSanitised: params.aiReasoningSanitised ?? null,
    aiWarnings: params.aiWarnings ?? [],
    verifiedEvent: null,
    blockNumber: null,
    errorCategory: 'none',
    reconciliationState: 'none',
    updatedAt: now,
  }
  log.set(id, record)
  insertionOrder.push(id)
  return id
}

export interface UpdateParams {
  flowState?: PaymentFlowState
  /** @deprecated Use flowState */
  status?: PaymentFlowState
  txHash?: string | null
  confirmedAt?: string | null
  deliveryStatus?: ServiceDeliveryStatus
  actorAddress?: string | null
  verifiedEvent?: VerifiedEventSummary | null
  blockNumber?: string | null
  errorCategory?: PaymentErrorCategory
  reconciliationState?: ReconciliationState
  aiVerdict?: AiVerdict | null
  aiReasoningSanitised?: string | null
  aiWarnings?: string[]
}

/**
 * Update mutable fields of an existing record.
 * Keeps `status` and `flowState` in sync automatically.
 * Returns false when the ID is not found.
 */
export function updatePayment(id: string, patch: UpdateParams): boolean {
  const existing = log.get(id)
  if (!existing) return false
  const resolvedFlowState = patch.flowState ?? patch.status
  log.set(id, {
    ...existing,
    ...patch,
    ...(resolvedFlowState !== undefined && {
      flowState: resolvedFlowState,
      status: resolvedFlowState,
    }),
    updatedAt: new Date().toISOString(),
  })
  return true
}

// ── Lifecycle helpers ─────────────────────────────────────────────────────────

/**
 * Transition a record to Submitted when the tx hash is known.
 * Sets reconciliationState to 'pending' so the reconciler picks it up.
 */
export function markSubmitted(
  id: string,
  txHash: string,
  actorAddress?: string,
): boolean {
  return updatePayment(id, {
    flowState: 'Submitted',
    txHash,
    actorAddress: actorAddress ?? null,
    reconciliationState: 'pending',
    errorCategory: 'none',
  })
}

/**
 * Transition a record to Confirmed after all verification checks pass.
 * Only call this when `verifiedEvent` is non-null.
 */
export function markConfirmed(
  id: string,
  verifiedEvent: VerifiedEventSummary,
  blockNumber: string,
): boolean {
  return updatePayment(id, {
    flowState: 'Confirmed',
    confirmedAt: new Date().toISOString(),
    verifiedEvent,
    blockNumber,
    reconciliationState: 'resolved',
    errorCategory: 'none',
  })
}

/**
 * Transition a record to Reverted after a mined revert is confirmed.
 */
export function markReverted(
  id: string,
  txHash: string,
  blockNumber: string,
): boolean {
  return updatePayment(id, {
    flowState: 'Reverted',
    txHash,
    blockNumber,
    confirmedAt: new Date().toISOString(),
    reconciliationState: 'resolved',
    errorCategory: 'revert',
  })
}

/**
 * Transition a record to Unknown when the receipt cannot be verified.
 * Retains the tx hash. Does NOT broadcast a new transaction.
 */
export function markUnknown(
  id: string,
  txHash: string,
  errorCategory: PaymentErrorCategory,
): boolean {
  return updatePayment(id, {
    flowState: 'Unknown',
    txHash,
    reconciliationState: 'pending',
    errorCategory,
  })
}

/**
 * Mark reconciliation as failed after repeated RPC outages.
 */
export function markReconciliationFailed(id: string): boolean {
  return updatePayment(id, {
    reconciliationState: 'failed',
  })
}

// ── Read API ──────────────────────────────────────────────────────────────────

export function getPayment(id: string): PaymentHistoryRecord | undefined {
  return log.get(id)
}

/**
 * Return a paginated, most-recent-first slice of the log.
 *
 * @param page     1-based page number
 * @param pageSize Records per page (1–100, clamped)
 */
export function listPayments(page: number, pageSize: number): PaymentHistoryPage {
  const size = Math.max(1, Math.min(100, pageSize))
  const p = Math.max(1, page)
  const total = insertionOrder.length

  // Most recent first
  const reversed = [...insertionOrder].reverse()
  const start = (p - 1) * size
  const slice = reversed.slice(start, start + size)
  const records = slice.map((id) => log.get(id)!).filter(Boolean)

  return {
    records,
    total,
    page: p,
    pageSize: size,
    totalPages: total === 0 ? 1 : Math.ceil(total / size),
    provenanceNotice: PROVENANCE_NOTICE,
  }
}

/** Find a record by transaction hash. Returns the first match. */
export function findByTxHash(txHash: string): PaymentHistoryRecord | undefined {
  const normalised = txHash.toLowerCase()
  for (const id of insertionOrder) {
    const r = log.get(id)
    if (r?.txHash?.toLowerCase() === normalised) return r
  }
  return undefined
}

/** Find a record by its bytes32 requestId. Returns the first match. */
export function findByRequestId(requestId: string): PaymentHistoryRecord | undefined {
  const normalised = requestId.toLowerCase()
  for (const id of insertionOrder) {
    const r = log.get(id)
    if (r?.requestId?.toLowerCase() === normalised) return r
  }
  return undefined
}

/**
 * List all records in the given reconciliation states.
 * Used by the reconciler to find records that need chain lookup.
 */
export function listByReconciliationState(
  ...states: ReconciliationState[]
): PaymentHistoryRecord[] {
  const stateSet = new Set(states)
  return insertionOrder
    .map(id => log.get(id)!)
    .filter(r => r && stateSet.has(r.reconciliationState ?? 'none'))
}

const AUDIT_PROVENANCE =
  'Fields marked source=onchain are derived from verified transaction receipts ' +
  'and are independently verifiable via any RPC endpoint. ' +
  'Fields marked source=server-log are the server\'s operational view only, ' +
  'stored in memory, and are NOT cryptographically tamper-evident.'

/**
 * Convert a PaymentHistoryRecord to the full AuditRecord shape.
 */
export function toAuditRecord(r: PaymentHistoryRecord): AuditRecord {
  return {
    id: r.id,
    idempotencyKey: r.idempotencyKey,
    requestIdHex: r.requestId,
    actorAddress: r.actorAddress ?? null,
    submittedAt: r.submittedAt,
    serviceId: r.serviceId,
    recipient: r.to,
    amountBaseUnits: r.amountUsdc,
    amountDisplay: r.amountDisplay,
    memo: r.memo,
    chainId: r.chainId,
    chain: r.chain,
    contractAddress: r.contractAddress,
    tokenAddress: r.tokenAddress ?? '',
    policyVerdict: r.policyDecision.verdict,
    policyReasonCode: r.policyDecision.code,
    policyExplanation: r.policyDecision.reason,
    approvalRequired: r.policyDecision.verdict === 'approval-required',
    aiVerdict: r.aiVerdict ?? null,
    aiReasoningSanitised: r.aiReasoningSanitised ?? null,
    aiWarnings: r.aiWarnings ?? [],
    txHash: r.txHash,
    blockNumber: r.blockNumber ?? null,
    verifiedEvent: r.verifiedEvent ?? null,
    flowState: r.flowState,
    deliveryStatus: r.deliveryStatus,
    errorCategory: r.errorCategory ?? 'none',
    reconciliationState: r.reconciliationState ?? 'none',
    confirmedAt: r.confirmedAt,
    updatedAt: r.updatedAt ?? r.submittedAt,
    provenanceNote: AUDIT_PROVENANCE,
  }
}

/** Test helper — clears the store. */
export function _clearPaymentLog(): void {
  log.clear()
  insertionOrder.length = 0
}

// ── Demo seed (development only) ─────────────────────────────────────────────
// Pre-populates representative records so the UI is never blank in local dev.
// All demo addresses are placeholders — replace with real addresses before use.

export function seedDemoPayments(contractAddress: string): void {
  if (log.size > 0) return  // already seeded

  // Demo recipient addresses — clearly labelled as demo fixtures.
  // arc-studio-allow-onchain-literal
  const DEMO_ADDR_A = '0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA' as const
  // arc-studio-allow-onchain-literal
  const DEMO_ADDR_B = '0xbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb' as const

  const now = Date.now()
  const sec = (offset: number) => new Date(now - offset * 1000).toISOString()

  const base = {
    chain: 'Arc Testnet',
    chainId: 5042002,
    contractAddress,
    simulated: true,
  }

  // 1. Confirmed — service delivered (happy path)
  {
    const id = randomUUID()
    const r: PaymentHistoryRecord = {
      id,
      idempotencyKey: 'demo-idem-1',
      requestId: '0xaaaa000000000000000000000000000000000000000000000000000000000001',
      serviceId: 'data-scraper',
      to: DEMO_ADDR_A,
      amountUsdc: '500000',
      amountDisplay: '0.50',
      memo: 'Data Scraper run #1',
      token: 'USDC',
      flowState: 'Confirmed',
      status: 'Confirmed',
      txHash: '0xabababababababababababababababababababababababababababababababababab',
      policyDecision: { verdict: 'allowed', code: 'POLICY_OK', reason: 'Within daily limit.' },
      deliveryStatus: 'succeeded',
      submittedAt: sec(3600),
      confirmedAt: sec(3540),
      ...base,
    }
    log.set(id, r); insertionOrder.push(id)
  }

  // 2. Confirmed — payment succeeded but service delivery failed
  {
    const id = randomUUID()
    const r: PaymentHistoryRecord = {
      id,
      idempotencyKey: 'demo-idem-2',
      requestId: '0xbbbb000000000000000000000000000000000000000000000000000000000002',
      serviceId: 'data-scraper',
      to: DEMO_ADDR_A,
      amountUsdc: '500000',
      amountDisplay: '0.50',
      memo: 'Data Scraper run #2',
      token: 'USDC',
      flowState: 'Confirmed',
      status: 'Confirmed',
      txHash: '0xbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc',
      policyDecision: { verdict: 'allowed', code: 'POLICY_OK', reason: 'Within daily limit.' },
      deliveryStatus: 'failed',
      submittedAt: sec(7200),
      confirmedAt: sec(7140),
      ...base,
    }
    log.set(id, r); insertionOrder.push(id)
  }

  // 3. ApprovalRequired — waiting for owner sign-off; tx not yet broadcast
  {
    const id = randomUUID()
    const r: PaymentHistoryRecord = {
      id,
      idempotencyKey: 'demo-idem-3',
      requestId: '0xcccc000000000000000000000000000000000000000000000000000000000003',
      serviceId: 'deep-analysis',
      to: DEMO_ADDR_B,
      amountUsdc: '50000000',
      amountDisplay: '50.00',
      memo: 'Deep Analysis — Q4 report',
      token: 'USDC',
      flowState: 'ApprovalRequired',
      status: 'ApprovalRequired',
      txHash: null,
      policyDecision: {
        verdict: 'approval-required',
        code: 'OVER_AUTO_APPROVE_THRESHOLD',
        reason: 'Amount exceeds auto-approve limit of 10 USDC.',
      },
      deliveryStatus: 'not-requested',
      submittedAt: sec(120),
      confirmedAt: null,
      ...base,
    }
    log.set(id, r); insertionOrder.push(id)
  }

  // 4. Denied — policy rejected before broadcast
  {
    const id = randomUUID()
    const r: PaymentHistoryRecord = {
      id,
      idempotencyKey: 'demo-idem-4',
      requestId: '0xdddd000000000000000000000000000000000000000000000000000000000004',
      serviceId: 'prohibited-endpoint',
      to: DEMO_ADDR_B,
      amountUsdc: '150000000',
      amountDisplay: '150.00',
      memo: 'Prohibited endpoint request',
      token: 'USDC',
      flowState: 'Denied',
      status: 'Denied',
      txHash: null,
      policyDecision: {
        verdict: 'denied',
        code: 'SERVICE_UNAVAILABLE',
        reason: 'Service is not active or caller is not allowlisted.',
      },
      deliveryStatus: 'not-requested',
      submittedAt: sec(300),
      confirmedAt: null,
      ...base,
    }
    log.set(id, r); insertionOrder.push(id)
  }

  // 5. Submitted — broadcast; awaiting confirmation
  {
    const id = randomUUID()
    const r: PaymentHistoryRecord = {
      id,
      idempotencyKey: 'demo-idem-5',
      requestId: '0xeeee000000000000000000000000000000000000000000000000000000000005',
      serviceId: 'data-scraper',
      to: DEMO_ADDR_A,
      amountUsdc: '500000',
      amountDisplay: '0.50',
      memo: 'Data Scraper run #3',
      token: 'USDC',
      flowState: 'Submitted',
      status: 'Submitted',
      txHash: null,
      policyDecision: { verdict: 'allowed', code: 'POLICY_OK', reason: 'Within daily limit.' },
      deliveryStatus: 'not-requested',
      submittedAt: sec(30),
      confirmedAt: null,
      ...base,
    }
    log.set(id, r); insertionOrder.push(id)
  }

  // 6. Reverted onchain — tx mined but execution reverted
  {
    const id = randomUUID()
    const r: PaymentHistoryRecord = {
      id,
      idempotencyKey: 'demo-idem-6',
      requestId: '0xffff000000000000000000000000000000000000000000000000000000000006',
      serviceId: 'data-scraper',
      to: DEMO_ADDR_A,
      amountUsdc: '500000',
      amountDisplay: '0.50',
      memo: 'Data Scraper run #4 (reverted)',
      token: 'USDC',
      flowState: 'Reverted',
      status: 'Reverted',
      txHash: '0xfafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafa',
      policyDecision: { verdict: 'allowed', code: 'POLICY_OK', reason: 'Within daily limit.' },
      deliveryStatus: 'not-requested',
      submittedAt: sec(10800),
      confirmedAt: sec(10740),
      ...base,
    }
    log.set(id, r); insertionOrder.push(id)
  }

  // 7. Unknown — tx hash present but receipt could not be verified
  {
    const id = randomUUID()
    const r: PaymentHistoryRecord = {
      id,
      idempotencyKey: 'demo-idem-7',
      requestId: '0x1111000000000000000000000000000000000000000000000000000000000007',
      serviceId: 'data-scraper',
      to: DEMO_ADDR_A,
      amountUsdc: '500000',
      amountDisplay: '0.50',
      memo: 'Data Scraper run #5 (unknown)',
      token: 'USDC',
      flowState: 'Unknown',
      status: 'Unknown',
      txHash: '0x1212121212121212121212121212121212121212121212121212121212121212',
      policyDecision: { verdict: 'allowed', code: 'POLICY_OK', reason: 'Within daily limit.' },
      deliveryStatus: 'unknown',
      submittedAt: sec(14400),
      confirmedAt: null,
      ...base,
    }
    log.set(id, r); insertionOrder.push(id)
  }

  // 8. RejectedByWallet — wallet refused to sign
  {
    const id = randomUUID()
    const r: PaymentHistoryRecord = {
      id,
      idempotencyKey: 'demo-idem-8',
      requestId: '0x2222000000000000000000000000000000000000000000000000000000000008',
      serviceId: 'data-scraper',
      to: DEMO_ADDR_A,
      amountUsdc: '500000',
      amountDisplay: '0.50',
      memo: 'Data Scraper run #6 (wallet rejected)',
      token: 'USDC',
      flowState: 'RejectedByWallet',
      status: 'RejectedByWallet',
      txHash: null,
      policyDecision: { verdict: 'allowed', code: 'POLICY_OK', reason: 'Within daily limit.' },
      deliveryStatus: 'not-requested',
      submittedAt: sec(18000),
      confirmedAt: null,
      ...base,
    }
    log.set(id, r); insertionOrder.push(id)
  }

  // 9. Cancelled — user cancelled before broadcast
  {
    const id = randomUUID()
    const r: PaymentHistoryRecord = {
      id,
      idempotencyKey: 'demo-idem-9',
      requestId: '0x3333000000000000000000000000000000000000000000000000000000000009',
      serviceId: 'deep-analysis',
      to: DEMO_ADDR_B,
      amountUsdc: '50000000',
      amountDisplay: '50.00',
      memo: 'Deep Analysis — cancelled',
      token: 'USDC',
      flowState: 'Cancelled',
      status: 'Cancelled',
      txHash: null,
      policyDecision: {
        verdict: 'approval-required',
        code: 'OVER_AUTO_APPROVE_THRESHOLD',
        reason: 'Amount exceeds auto-approve limit of 10 USDC.',
      },
      deliveryStatus: 'not-requested',
      submittedAt: sec(21600),
      confirmedAt: null,
      ...base,
    }
    log.set(id, r); insertionOrder.push(id)
  }
}
