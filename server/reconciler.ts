/**
 * server/reconciler.ts
 *
 * ArcPilot audit and reconciliation workflow.
 *
 * The reconciler checks chain state for payment records whose outcome has
 * not been established (flowState = Submitted | Unknown) and updates the
 * server log to reflect what actually happened on-chain.
 *
 * Key design invariants:
 *  1. The reconciler never broadcasts a new transaction.  It only reads chain
 *     state.  If the outcome is ambiguous (RPC timeout, mismatched event), the
 *     record remains Unknown for the next reconciliation pass.
 *  2. The reconciler never retries a payment whose tx hash it cannot verify.
 *     The operator must manually inspect the chain and resolve the record.
 *  3. "Confirmed" is only set when verifyTransactionReceipt returns
 *     outcome === 'confirmed' (all field checks passed).
 *  4. Each record is reconciled at most once per pass.  Duplicate tx hashes
 *     are deduplicated by requestId before processing.
 *  5. Reconciliation state is tracked per record:
 *       pending     → being checked this pass
 *       resolved    → terminal outcome established
 *       failed      → RPC outage persisted across FAILURE_THRESHOLD passes
 *
 * This module is pure server-side.  No browser globals, no React, no AI imports.
 */

import type { PaymentHistoryRecord, TxVerificationResult, VerifiedEventSummary } from '../shared/types.js'
import {
  listByReconciliationState,
  markConfirmed,
  markReverted,
  markUnknown,
  markReconciliationFailed,
  updatePayment,
  findByTxHash,
  findByRequestId,
} from './payment-log.js'
import { verifyTransactionReceipt, receiptTimeoutResult } from '../src/lib/verifyTransaction.js'

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A "fetcher" for a raw transaction receipt.
 *
 * In production this wraps `viem.getTransactionReceipt`.
 * In tests it is replaced by a mock.
 *
 * Must resolve with the raw receipt object (as returned by wagmi/viem),
 * or throw `ReceiptFetchTimeoutError` on timeout, or throw any other
 * Error on RPC failure.
 *
 * The reconciler does NOT import viem directly — the caller provides the
 * fetcher so the module stays testable without a live RPC.
 */
export type ReceiptFetcher = (txHash: `0x${string}`) => Promise<RawReceipt>

/**
 * Minimal receipt shape required by the reconciler / verifier.
 * Matches the wagmi/viem TransactionReceipt type.
 */
export interface RawReceipt {
  transactionHash: `0x${string}`
  status: 'success' | 'reverted'
  to: `0x${string}` | null
  blockNumber: bigint
  logs: RawLog[]
}

export interface RawLog {
  address: `0x${string}`
  topics: `0x${string}`[]
  data: `0x${string}`
  blockNumber: bigint
  transactionHash: `0x${string}` | null
  transactionIndex: number
  blockHash: `0x${string}` | null
  logIndex: number
  removed: boolean
}

/**
 * Error thrown (or rejected with) when a receipt fetch times out.
 * The reconciler catches this and sets flowState = Unknown without
 * changing the tx hash.
 */
export class ReceiptFetchTimeoutError extends Error {
  constructor(txHash: string) {
    super(`Receipt fetch timed out for tx ${txHash}`)
    this.name = 'ReceiptFetchTimeoutError'
  }
}

/**
 * Result of reconciling a single record.
 */
export interface ReconcileRecordResult {
  id: string
  /** requestId bytes32 */
  requestId: string
  /** tx hash that was checked */
  txHash: string
  /** Outcome code */
  outcome:
    | 'confirmed'
    | 'reverted'
    | 'unknown-verification-fail'
    | 'unknown-rpc-timeout'
    | 'unknown-rpc-error'
    | 'skipped-no-tx-hash'
    | 'skipped-already-terminal'
    | 'duplicate-skipped'
  /** Human-readable description */
  message: string
}

/**
 * Summary of a full reconciliation pass.
 */
export interface ReconciliationPassResult {
  startedAt: string
  completedAt: string
  checkedCount: number
  confirmedCount: number
  revertedCount: number
  unknownCount: number
  skippedCount: number
  results: ReconcileRecordResult[]
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * After this many consecutive failed reconciliation passes for a record,
 * mark reconciliationState = 'failed' and stop retrying automatically.
 * Operator must manually resolve.
 */
export const FAILURE_THRESHOLD = 5

// Track per-record failure counts (in memory; reset on process restart).
const failureCounts = new Map<string, number>()

/** Test helper — clears the failure count map. */
export function _clearFailureCounts(): void {
  failureCounts.clear()
}

// ── Core helpers ──────────────────────────────────────────────────────────────

/**
 * Build a VerifiedEventSummary from a confirmed TxVerificationResult.
 * Only call when result.outcome === 'confirmed'.
 */
export function buildVerifiedEventSummary(
  result: TxVerificationResult,
  contractAddress: string,
): VerifiedEventSummary {
  const event = result.decodedEvent!
  return {
    txHash: result.txHash,
    blockNumber: (result.blockNumber ?? 0n).toString(),
    eventRecipient: event.to,
    eventAmountBaseUnits: event.amount.toString(),
    eventRequestId: event.requestId,
    transferVerified: result.outcome === 'confirmed', // verifier confirms Transfer when present
    verifiedAt: new Date().toISOString(),
  }
}

// ── Single-record reconciliation ──────────────────────────────────────────────

/**
 * Reconcile a single payment record.
 *
 * Steps:
 *  1. Skip records without a tx hash (can't look up chain state).
 *  2. Skip records already in a terminal state (Confirmed, Reverted, Denied, etc.)
 *     unless they are explicitly in reconciliationState = 'pending'.
 *  3. Fetch the receipt using the provided fetcher.
 *  4. Run verifyTransactionReceipt.
 *  5. Update the log based on the verification outcome.
 *     - confirmed          → markConfirmed
 *     - reverted           → markReverted
 *     - wrong-chain /
 *       event-not-found /
 *       event-mismatch /
 *       transfer-mismatch  → markUnknown (verification-fail)
 *     - receipt-timeout    → markUnknown (timeout)
 *  6. On RPC error: increment failure count; if >= FAILURE_THRESHOLD, markReconciliationFailed.
 *
 * @param record         The payment record to reconcile.
 * @param fetchReceipt   Receipt fetcher (injected for testability).
 * @returns              ReconcileRecordResult describing what happened.
 */
export async function reconcileRecord(
  record: PaymentHistoryRecord,
  fetchReceipt: ReceiptFetcher,
): Promise<ReconcileRecordResult> {
  const { id, txHash, requestId, contractAddress, to, amountUsdc } = record

  // ── Guard: no tx hash ──────────────────────────────────────────────────────
  if (!txHash) {
    return {
      id,
      requestId,
      txHash: '',
      outcome: 'skipped-no-tx-hash',
      message: `Record ${id} has no tx hash — cannot reconcile.`,
    }
  }

  // ── Guard: already terminal ────────────────────────────────────────────────
  const terminalStates = new Set(['Confirmed', 'Reverted', 'Denied', 'RejectedByWallet', 'Cancelled'])
  if (terminalStates.has(record.flowState) && record.reconciliationState !== 'pending') {
    return {
      id,
      requestId,
      txHash,
      outcome: 'skipped-already-terminal',
      message: `Record ${id} is in terminal state ${record.flowState} — skipping.`,
    }
  }

  // ── Mark in-progress ───────────────────────────────────────────────────────
  updatePayment(id, { reconciliationState: 'in-progress' })

  // ── Fetch receipt ──────────────────────────────────────────────────────────
  let rawReceipt: RawReceipt

  try {
    rawReceipt = await fetchReceipt(txHash as `0x${string}`)
  } catch (err) {
    // Distinguish timeout from other RPC errors.
    const isTimeout = err instanceof ReceiptFetchTimeoutError ||
      (err instanceof Error && err.message.includes('timed out'))

    if (isTimeout) {
      const timeoutResult = receiptTimeoutResult(txHash as `0x${string}`)
      markUnknown(id, txHash, 'timeout')
      return {
        id,
        requestId,
        txHash,
        outcome: 'unknown-rpc-timeout',
        message: timeoutResult.explanation,
      }
    }

    // RPC error (not timeout).
    const count = (failureCounts.get(id) ?? 0) + 1
    failureCounts.set(id, count)
    if (count >= FAILURE_THRESHOLD) {
      markReconciliationFailed(id)
      return {
        id,
        requestId,
        txHash,
        outcome: 'unknown-rpc-error',
        message: `RPC error after ${count} attempts — marked reconciliation failed. Manual resolution required.`,
      }
    }
    // Revert to 'pending' so we retry next pass.
    updatePayment(id, { reconciliationState: 'pending' })
    return {
      id,
      requestId,
      txHash,
      outcome: 'unknown-rpc-error',
      message: `RPC error (attempt ${count}/${FAILURE_THRESHOLD}): ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // ── Build minimal PaymentPreparationReceipt shape for the verifier ─────────
  const prepReceipt = {
    requestId,
    recipient: to,
    amountBaseUnits: amountUsdc,
    contractAddress,
    tokenAddress: record.tokenAddress ?? '',
    chainId: record.chainId,
  }

  // ── Verify ─────────────────────────────────────────────────────────────────
  // Cast rawReceipt — the verifier accepts the same shape as wagmi's receipt.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const verResult = verifyTransactionReceipt(rawReceipt as any, prepReceipt as any)

  // Reset failure count on successful receipt fetch (regardless of verify outcome).
  failureCounts.delete(id)

  // ── Act on outcome ─────────────────────────────────────────────────────────
  switch (verResult.outcome) {
    case 'confirmed': {
      const summary = buildVerifiedEventSummary(verResult, contractAddress)
      const blockStr = (verResult.blockNumber ?? 0n).toString()
      markConfirmed(id, summary, blockStr)
      return {
        id,
        requestId,
        txHash,
        outcome: 'confirmed',
        message: `Payment confirmed at block ${blockStr}. Event verified: requestId=${verResult.decodedEvent?.requestId}, to=${verResult.decodedEvent?.to}, amount=${verResult.decodedEvent?.amount}.`,
      }
    }

    case 'reverted': {
      const blockStr = (verResult.blockNumber ?? 0n).toString()
      markReverted(id, txHash, blockStr)
      return {
        id,
        requestId,
        txHash,
        outcome: 'reverted',
        message: `Transaction reverted at block ${blockStr}.`,
      }
    }

    default: {
      // wrong-chain, event-not-found, event-mismatch, transfer-mismatch, unknown
      markUnknown(id, txHash, 'verification-fail')
      return {
        id,
        requestId,
        txHash,
        outcome: 'unknown-verification-fail',
        message: `Verification failed (${verResult.outcome}): ${verResult.explanation}`,
      }
    }
  }
}

// ── Full reconciliation pass ──────────────────────────────────────────────────

/**
 * Run a full reconciliation pass.
 *
 * Finds all records in reconciliationState = 'pending' (includes Submitted
 * and Unknown records awaiting lookup) and reconciles each one.
 *
 * Deduplicates by txHash to avoid redundant RPC calls: if two records share
 * the same tx hash, only the first is reconciled; the second is skipped with
 * `duplicate-skipped`.  (This should not happen in practice — one tx = one
 * prepId — but guards against edge cases.)
 *
 * @param fetchReceipt  Receipt fetcher.  Injected for testability.
 * @returns             Summary of this reconciliation pass.
 */
export async function runReconciliationPass(
  fetchReceipt: ReceiptFetcher,
): Promise<ReconciliationPassResult> {
  const startedAt = new Date().toISOString()
  const pending = listByReconciliationState('pending')

  const seenTxHashes = new Set<string>()
  const results: ReconcileRecordResult[] = []

  for (const record of pending) {
    // Duplicate tx hash guard.
    if (record.txHash) {
      const norm = record.txHash.toLowerCase()
      if (seenTxHashes.has(norm)) {
        results.push({
          id: record.id,
          requestId: record.requestId,
          txHash: record.txHash,
          outcome: 'duplicate-skipped',
          message: `Tx hash ${record.txHash} already reconciled this pass — skipping duplicate.`,
        })
        continue
      }
      seenTxHashes.add(norm)
    }

    const result = await reconcileRecord(record, fetchReceipt)
    results.push(result)
  }

  const completedAt = new Date().toISOString()
  return {
    startedAt,
    completedAt,
    checkedCount: pending.length,
    confirmedCount: results.filter(r => r.outcome === 'confirmed').length,
    revertedCount:  results.filter(r => r.outcome === 'reverted').length,
    unknownCount:   results.filter(r => r.outcome.startsWith('unknown')).length,
    skippedCount:   results.filter(r => r.outcome.startsWith('skipped') || r.outcome === 'duplicate-skipped').length,
    results,
  }
}

// ── Scheduled reconciliation loop ─────────────────────────────────────────────

let reconciliationTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start the background reconciliation loop.
 *
 * Runs `runReconciliationPass` every `intervalMs` milliseconds.
 * Errors in a pass are caught and logged — they never kill the loop.
 *
 * @param fetchReceipt   Receipt fetcher.
 * @param intervalMs     Interval between passes (default: 30 seconds).
 * @returns              A stop function that clears the timer.
 */
export function startReconciliationLoop(
  fetchReceipt: ReceiptFetcher,
  intervalMs = 30_000,
): () => void {
  if (reconciliationTimer) {
    clearInterval(reconciliationTimer)
  }

  reconciliationTimer = setInterval(async () => {
    try {
      const result = await runReconciliationPass(fetchReceipt)
      if (result.checkedCount > 0) {
        console.log(
          `[Reconciler] Pass complete: ${result.confirmedCount} confirmed, ` +
          `${result.revertedCount} reverted, ${result.unknownCount} unknown, ` +
          `${result.skippedCount} skipped.`,
        )
      }
    } catch (err) {
      console.error('[Reconciler] Unhandled error in reconciliation pass:', err)
    }
  }, intervalMs)

  return () => {
    if (reconciliationTimer) {
      clearInterval(reconciliationTimer)
      reconciliationTimer = null
    }
  }
}
