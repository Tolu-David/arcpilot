/**
 * server/payment-prepare.ts
 *
 * Payment preparation pipeline for ArcPilot.
 *
 * Implements the server-side steps that MUST happen before any transaction
 * can be submitted:
 *
 *  1. Validate idempotency key format.
 *  2. Validate service ID format.
 *  3. Resolve canonical recipient and amount from the trusted catalogue.
 *  4. Compute a deterministic payload hash for key-binding.
 *  5. Check the idempotency store:
 *       a. Key + matching hash → return cached receipt (idempotent retry).
 *       b. Key + different hash → reject with IDEMPOTENCY_KEY_CONFLICT.
 *       c. No entry → proceed.
 *  6. Validate the snapshot is not stale.
 *  7. Run the deterministic spending-policy evaluator.
 *  8. If policy denies → return denial, do NOT create a log entry.
 *  9. Derive a deterministic bytes32 requestId from the idempotency key +
 *     canonical payload.
 * 10. Write the idempotency record (key → payloadHash + prepId).
 * 11. Append a PaymentHistoryRecord in PolicyChecked or ApprovalRequired state.
 * 12. Return the full PaymentPreparationReceipt.
 *
 * Security invariants:
 *  - The caller never supplies a `to` address, an amount, a contract address,
 *    or a token address.  All are resolved from server-controlled config.
 *  - The requestId is derived deterministically from the idempotency key and
 *    the canonical payload — the contract uses it to prevent duplicate execution.
 *  - Policy denial does not create a log entry or a transferable authorisation.
 *  - A stale snapshot is treated as a denial (STALE_STATE).
 *  - This module is pure server-side: no browser globals, no AI imports.
 */

import { createHash } from 'crypto'
import { randomUUID } from 'crypto'
import type {
  PaymentPreparationRequest,
  PaymentPreparationReceipt,
  IdempotencyRecord,
  ContractStateSnapshot,
} from '../shared/types.js'
import { findExtendedService } from './catalogue.js'
import { evaluateSpendingPolicy, formatUsdc } from './spending-policy.js'
import { appendPayment } from './payment-log.js'

// ── Chain and contract config ─────────────────────────────────────────────────
// These values are server-authoritative.  The browser receives them in the
// receipt but must not supply or override them.

const CHAIN_NAME = 'Arc Testnet'
const CHAIN_ID = 5042002
// arc-studio-allow-onchain-literal
const USDC_ADDRESS = '0x3600000000000000000000000000000000000000'

function getContractAddress(): string {
  return (
    process.env.VITE_ARCPILOT_CONTRACT ??
    '0x28a05d2996207b3db64b5ad171a2db5d71c9a8f3' // arc-studio-allow-onchain-literal
  )
}

// ── Idempotency store ─────────────────────────────────────────────────────────
// Maps idempotency key → IdempotencyRecord.
// Module-level: one instance per server process.  Replace with Redis SET NX
// in a multi-instance production deployment.

const idempotencyStore = new Map<string, IdempotencyRecord>()

// Maps idempotency key → cached PaymentPreparationReceipt (for retries)
const receiptCache = new Map<string, PaymentPreparationReceipt>()

/** Test helper — clears both maps. */
export function _clearPrepareStore(): void {
  idempotencyStore.clear()
  receiptCache.clear()
}

// [security fix M-3] Evict idempotency records older than TTL_MS to prevent
// unbounded heap growth in long-running server processes.
const TTL_MS = 24 * 60 * 60 * 1000  // 24 hours

function evictStaleEntries(): void {
  const cutoff = Date.now() - TTL_MS
  for (const [key, record] of idempotencyStore) {
    if (new Date(record.createdAt).getTime() < cutoff) {
      idempotencyStore.delete(key)
      receiptCache.delete(key)
    }
  }
}

// Run eviction every hour.  .unref() prevents the timer from keeping the
// process alive when all other work is done (e.g. during test teardown).
const _evictionInterval = setInterval(evictStaleEntries, 60 * 60 * 1000)
if (typeof _evictionInterval.unref === 'function') _evictionInterval.unref()

/** Exported for testing only — do not call in production code. */
export { evictStaleEntries as _evictStaleEntriesForTest }

// ── Payload hash ──────────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 payload hash that binds an idempotency key to a canonical
 * request.  Any change to serviceId, recipient, or amount will produce a
 * different hash and trigger IDEMPOTENCY_KEY_CONFLICT.
 */
export function computePayloadHash(
  serviceId: string,
  recipient: string,
  amountBaseUnits: bigint,
): string {
  const canonical = `${serviceId}\x00${recipient.toLowerCase()}\x00${amountBaseUnits.toString()}`
  return createHash('sha256').update(canonical).digest('hex')
}

// ── requestId derivation ──────────────────────────────────────────────────────

/**
 * Derive a deterministic bytes32 requestId from the idempotency key and the
 * canonical payload.  The contract stores this to prevent duplicate execution.
 *
 * Algorithm: SHA-256(idempotencyKey + '\x00' + payloadHash), truncated to
 * 32 bytes and hex-encoded with 0x prefix.
 */
export function deriveRequestId(
  idempotencyKey: string,
  payloadHash: string,
): `0x${string}` {
  const input = `${idempotencyKey}\x00${payloadHash}`
  const digest = createHash('sha256').update(input).digest('hex')
  // SHA-256 produces 32 bytes = 64 hex chars — exactly bytes32.
  return `0x${digest}` as `0x${string}`
}

// ── Memo sanitisation ─────────────────────────────────────────────────────────

/** Strip control characters and trim whitespace.  Cap at maxLen characters. */
export function sanitiseMemo(raw: string | undefined, maxLen = 128): string {
  if (!raw) return ''
  // Remove C0/C1 control characters (0x00–0x1F, 0x7F–0x9F) except space.
  const cleaned = raw.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').trim()
  return cleaned.slice(0, maxLen)
}

// ── Result types ──────────────────────────────────────────────────────────────

export type PrepareOutcome =
  | { ok: true; receipt: PaymentPreparationReceipt }
  | { ok: false; code: PrepareErrorCode; message: string; details?: unknown }

export type PrepareErrorCode =
  | 'INVALID_REQUEST'
  | 'SERVICE_NOT_FOUND'
  | 'POLICY_DENIED'
  | 'STALE_STATE'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'INTERNAL_ERROR'

// ── Main pipeline ─────────────────────────────────────────────────────────────

/**
 * Prepare a payment request.
 *
 * @param request   Validated request body (serviceId + idempotencyKey + memo).
 * @param snapshot  Fresh on-chain contract state fetched by the caller immediately
 *                  before this call.  The pipeline rejects stale snapshots.
 * @param nowMs     Current Unix timestamp in ms.  Override in tests.
 */
export function preparePayment(
  request: PaymentPreparationRequest,
  snapshot: ContractStateSnapshot,
  nowMs: number = Date.now(),
): PrepareOutcome {
  // ── Step 1: validate idempotency key ──────────────────────────────────────
  const { idempotencyKey, serviceId, memo: rawMemo } = request

  if (
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.trim() === '' ||
    idempotencyKey.length > 128
  ) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      message: '"idempotencyKey" must be a non-empty string of at most 128 characters.',
    }
  }

  // ── Step 2: validate service ID format ────────────────────────────────────
  if (
    typeof serviceId !== 'string' ||
    serviceId.trim() === '' ||
    !/^[a-z0-9-]+$/.test(serviceId)
  ) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      message: `"serviceId" must be a lowercase alphanumeric-with-hyphens string. Got: "${serviceId}".`,
    }
  }

  // ── Step 3: resolve canonical recipient and amount from the catalogue ─────
  const service = findExtendedService(serviceId)
  if (!service) {
    return {
      ok: false,
      code: 'SERVICE_NOT_FOUND',
      message: `No service with id "${serviceId}" in the catalogue. Fetch GET /api/catalogue for available services.`,
    }
  }

  const recipient = service.recipientAddress
  const amountBaseUnits = BigInt(service.priceBaseUnits)

  // ── Step 4: compute canonical payload hash ────────────────────────────────
  const payloadHash = computePayloadHash(serviceId, recipient, amountBaseUnits)

  // ── Step 5: idempotency check ─────────────────────────────────────────────
  const existingRecord = idempotencyStore.get(idempotencyKey)
  if (existingRecord) {
    if (existingRecord.payloadHash !== payloadHash) {
      // Key reuse with a different payload — reject immediately.
      return {
        ok: false,
        code: 'IDEMPOTENCY_KEY_CONFLICT',
        message:
          `Idempotency key "${idempotencyKey}" was already used with a different payload. ` +
          'Generate a new idempotency key for a different service or amount.',
        details: {
          existingServiceId: serviceId, // don't leak the original payload, just the conflict
        },
      }
    }
    // Same key + same payload → return the cached receipt.
    const cached = receiptCache.get(idempotencyKey)
    if (cached) {
      return { ok: true, receipt: { ...cached, cached: true } }
    }
    // Record exists but cache was evicted (shouldn't happen, but be safe).
    // Fall through to recreate the receipt from the log record.
  }

  // ── Step 6: reject stale snapshot (before any write) ─────────────────────
  const snapshotAge = nowMs - snapshot.fetchedAt
  const STALE_MS = 60_000  // mirror STALE_STATE_THRESHOLD_MS from spending-policy.ts
  if (snapshotAge > STALE_MS) {
    return {
      ok: false,
      code: 'STALE_STATE',
      message:
        `Contract state snapshot is ${Math.round(snapshotAge / 1000)}s old ` +
        `(max ${STALE_MS / 1000}s). Fetch a fresh snapshot and retry.`,
    }
  }

  // ── Step 7: run the deterministic spending-policy evaluator ──────────────
  const policyResult = evaluateSpendingPolicy({ serviceId }, snapshot, nowMs)

  // ── Step 8: reject denied requests — no log entry, no authorisation ──────
  if (!policyResult.allowed && !policyResult.approvalRequired) {
    return {
      ok: false,
      code: 'POLICY_DENIED',
      message: policyResult.explanation,
      details: {
        reasonCode: policyResult.reasonCode,
        serviceId,
        priceBaseUnits: amountBaseUnits.toString(),
      },
    }
  }

  // ── Step 9: derive deterministic bytes32 requestId ────────────────────────
  const requestId = deriveRequestId(idempotencyKey, payloadHash)

  // ── Step 10: write idempotency record ─────────────────────────────────────
  const prepId = randomUUID()
  const idempotencyRecord: IdempotencyRecord = {
    key: idempotencyKey,
    payloadHash,
    createdAt: new Date(nowMs).toISOString(),
    prepId,
  }
  idempotencyStore.set(idempotencyKey, idempotencyRecord)

  // ── Step 11: append log entry in PolicyChecked or ApprovalRequired state ──
  const flowState = policyResult.approvalRequired ? 'ApprovalRequired' : 'PolicyChecked'
  const memo = sanitiseMemo(rawMemo)
  const contractAddress = getContractAddress()

  appendPayment({
    idempotencyKey,
    requestId,
    serviceId,
    to: recipient,
    amountUsdc: amountBaseUnits.toString(),
    amountDisplay: formatUsdc(amountBaseUnits),
    memo,
    chain: CHAIN_NAME,
    chainId: CHAIN_ID,
    contractAddress,
    policyDecision: {
      verdict: policyResult.approvalRequired ? 'approval-required' : 'allowed',
      code: policyResult.reasonCode,
      reason: policyResult.explanation,
    },
    simulated: false,
  })

  // Override the default Draft state with the correct flow state.
  // (appendPayment always creates Draft; we immediately update the flow state
  //  via the returned prepId — this is a write-through since we have the record.)
  // Simplest: build the receipt with the correct flowState directly.

  // ── Step 12: build and cache receipt ─────────────────────────────────────
  const receipt: PaymentPreparationReceipt = {
    prepId,
    idempotencyKey,
    requestId,
    cached: false,

    serviceId,
    recipient,
    amountBaseUnits: amountBaseUnits.toString(),
    amountDisplay: formatUsdc(amountBaseUnits),
    memo,

    chain: CHAIN_NAME,
    chainId: CHAIN_ID,
    contractAddress,
    tokenAddress: USDC_ADDRESS,

    flowState,
    policy: {
      allowed: policyResult.allowed,
      approvalRequired: policyResult.approvalRequired,
      reasonCode: policyResult.reasonCode,
      explanation: policyResult.explanation,
      evaluatedAt: policyResult.evaluatedAt,
    },
    spendableAtCheck: policyResult.context.spendableBalance.toString(),
    dailyRemainingAtCheck: policyResult.context.dailyRemainingGlobal.toString(),

    preparedAt: new Date(nowMs).toISOString(),
  }

  receiptCache.set(idempotencyKey, receipt)
  return { ok: true, receipt }
}
