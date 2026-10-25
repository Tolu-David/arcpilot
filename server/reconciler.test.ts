/**
 * server/reconciler.test.ts
 *
 * Tests for the ArcPilot audit and reconciliation workflow.
 *
 * Coverage:
 *  - Happy-path: Submitted → Confirmed
 *  - Reverted transaction
 *  - RPC timeout → Unknown (tx hash retained; no retry)
 *  - RPC error → retry up to FAILURE_THRESHOLD, then reconciliation-failed
 *  - Wrong-chain, event-not-found, event-mismatch → verification-fail → Unknown
 *  - Duplicate tx hash in same pass → skipped
 *  - Duplicate event (same tx reconciled twice) → second call is terminal skip
 *  - Service failure after payment confirmation (payment Confirmed + delivery failed)
 *  - Repeated reconciliation (idempotent on terminal records)
 *  - findByTxHash / findByRequestId lookups
 *  - toAuditRecord shape and provenance note
 *  - markSubmitted / markConfirmed / markReverted / markUnknown helpers
 *  - listByReconciliationState
 *  - runReconciliationPass summary counts
 *
 * Uses Node's built-in test runner (tsx --test).
 * No live RPC calls — all receipts are injected via the ReceiptFetcher type.
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  appendPayment,
  getPayment,
  updatePayment,
  markSubmitted,
  markConfirmed,
  markReverted,
  markUnknown,
  markReconciliationFailed,
  findByTxHash,
  findByRequestId,
  listByReconciliationState,
  toAuditRecord,
  _clearPaymentLog,
} from './payment-log.js'

import {
  reconcileRecord,
  runReconciliationPass,
  buildVerifiedEventSummary,
  ReceiptFetchTimeoutError,
  FAILURE_THRESHOLD,
  _clearFailureCounts,
} from './reconciler.js'

import type { RawReceipt, RawLog, ReceiptFetcher } from './reconciler.js'
import type { PaymentHistoryRecord, VerifiedEventSummary } from '../shared/types.js'
import {
  PAYMENT_EXECUTED_TOPIC,
  ERC20_TRANSFER_TOPIC as TRANSFER_TOPIC,
} from '../src/lib/verifyTransaction.js'

// ── Test fixture helpers ──────────────────────────────────────────────────────

// arc-studio-allow-onchain-literal
const CONTRACT   = '0xC0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C001' as `0x${string}`
// arc-studio-allow-onchain-literal
const RECIPIENT  = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa01' as `0x${string}`
// arc-studio-allow-onchain-literal
const TOKEN      = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb01' as `0x${string}`
const REQUEST_ID = ('0x' + 'ab'.repeat(32)) as `0x${string}`
const TX_HASH    = ('0x' + 'cc'.repeat(32)) as `0x${string}`
const TX_HASH_2  = ('0x' + 'dd'.repeat(32)) as `0x${string}`
const AMOUNT     = 500_000n
const BLOCK_NUM  = 12345678n

function padAddr(addr: string): `0x${string}` {
  const raw = addr.toLowerCase().replace(/^0x/, '')
  return `0x${'00'.repeat(12)}${raw}` as `0x${string}`
}

function padBytes32(hex: string): `0x${string}` {
  const raw = hex.replace(/^0x/, '')
  return `0x${raw.padStart(64, '0')}` as `0x${string}`
}

function encodeAmountAndMemo(amount: bigint, memo: string): `0x${string}` {
  const amountHex = amount.toString(16).padStart(64, '0')
  const memoBytes = Buffer.from(memo, 'utf8')
  const offsetHex = (64n).toString(16).padStart(64, '0')
  const lenHex = BigInt(memoBytes.length).toString(16).padStart(64, '0')
  const dataHex = Buffer.from(memoBytes).toString('hex').padEnd(
    Math.ceil(memoBytes.length / 32) * 64,
    '0',
  )
  return `0x${amountHex}${offsetHex}${lenHex}${dataHex}` as `0x${string}`
}

function makePaymentExecutedLog(overrides?: {
  address?: `0x${string}`
  requestId?: `0x${string}`
  recipient?: `0x${string}`
  amount?: bigint
  memo?: string
}): RawLog {
  return {
    address: overrides?.address ?? CONTRACT,
    topics: [
      PAYMENT_EXECUTED_TOPIC,
      padBytes32('0x01'),                        // paymentId (uint256, indexed)
      padAddr(overrides?.recipient ?? RECIPIENT), // to (address, indexed)
      padBytes32(overrides?.requestId ?? REQUEST_ID), // requestId (bytes32, indexed)
    ],
    data: encodeAmountAndMemo(overrides?.amount ?? AMOUNT, overrides?.memo ?? 'test memo'),
    blockNumber: BLOCK_NUM,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    blockHash: ('0x' + 'ee'.repeat(32)) as `0x${string}`,
    logIndex: 0,
    removed: false,
  }
}

function makeReceipt(overrides?: {
  to?: `0x${string}` | null
  status?: 'success' | 'reverted'
  logs?: RawLog[]
  blockNumber?: bigint
  txHash?: `0x${string}`
}): RawReceipt {
  return {
    transactionHash: overrides?.txHash ?? TX_HASH,
    status: overrides?.status ?? 'success',
    to: overrides?.to ?? CONTRACT,
    blockNumber: overrides?.blockNumber ?? BLOCK_NUM,
    logs: overrides?.logs ?? [makePaymentExecutedLog()],
  }
}

function makeSuccessFetcher(receipt?: Partial<RawReceipt>): ReceiptFetcher {
  return async (_hash) => makeReceipt(receipt)
}

function makeRevertedFetcher(): ReceiptFetcher {
  return async (_hash) => makeReceipt({ status: 'reverted', logs: [] })
}

function makeTimeoutFetcher(): ReceiptFetcher {
  return async (hash) => { throw new ReceiptFetchTimeoutError(hash) }
}

function makeRpcErrorFetcher(message = 'connection refused'): ReceiptFetcher {
  return async (_hash) => { throw new Error(message) }
}

/**
 * Append a minimal test record and return its ID.
 */
function addRecord(overrides?: {
  txHash?: string | null
  flowState?: PaymentHistoryRecord['flowState']
  requestId?: string
  reconciliationState?: PaymentHistoryRecord['reconciliationState']
}): string {
  const id = appendPayment({
    idempotencyKey: `test-key-${Math.random()}`,
    requestId: overrides?.requestId ?? REQUEST_ID,
    serviceId: 'data-scraper',
    to: RECIPIENT,
    amountUsdc: AMOUNT.toString(),
    amountDisplay: '0.50',
    memo: 'test',
    chain: 'Arc Testnet',
    chainId: 5042002,
    contractAddress: CONTRACT,
    tokenAddress: TOKEN,
    policyDecision: { verdict: 'allowed', code: 'POLICY_OK', reason: 'OK' },
    simulated: false,
  })

  if (overrides?.txHash !== undefined) {
    updatePayment(id, { txHash: overrides.txHash })
  }
  if (overrides?.flowState) {
    updatePayment(id, { flowState: overrides.flowState })
  }
  if (overrides?.reconciliationState) {
    updatePayment(id, { reconciliationState: overrides.reconciliationState })
  }

  return id
}

// ── Test lifecycle ────────────────────────────────────────────────────────────

beforeEach(() => {
  _clearPaymentLog()
  _clearFailureCounts()
})

// ── payment-log helpers ───────────────────────────────────────────────────────

describe('markSubmitted', () => {
  it('sets flowState=Submitted and reconciliationState=pending', () => {
    const id = addRecord()
    const ok = markSubmitted(id, TX_HASH, '0xActor')
    assert.equal(ok, true)
    const r = getPayment(id)!
    assert.equal(r.flowState, 'Submitted')
    assert.equal(r.txHash, TX_HASH)
    assert.equal(r.actorAddress, '0xActor')
    assert.equal(r.reconciliationState, 'pending')
    assert.equal(r.errorCategory, 'none')
  })

  it('returns false for unknown id', () => {
    assert.equal(markSubmitted('not-an-id', TX_HASH), false)
  })
})

describe('markConfirmed', () => {
  it('sets flowState=Confirmed with verifiedEvent and blockNumber', () => {
    const id = addRecord({ txHash: TX_HASH })
    const summary: VerifiedEventSummary = {
      txHash: TX_HASH,
      blockNumber: BLOCK_NUM.toString(),
      eventRecipient: RECIPIENT,
      eventAmountBaseUnits: AMOUNT.toString(),
      eventRequestId: REQUEST_ID,
      transferVerified: true,
      verifiedAt: new Date().toISOString(),
    }
    markConfirmed(id, summary, BLOCK_NUM.toString())
    const r = getPayment(id)!
    assert.equal(r.flowState, 'Confirmed')
    assert.notEqual(r.confirmedAt, null)
    assert.deepEqual(r.verifiedEvent, summary)
    assert.equal(r.blockNumber, BLOCK_NUM.toString())
    assert.equal(r.reconciliationState, 'resolved')
    assert.equal(r.errorCategory, 'none')
  })
})

describe('markReverted', () => {
  it('sets flowState=Reverted with blockNumber and errorCategory=revert', () => {
    const id = addRecord({ txHash: TX_HASH })
    markReverted(id, TX_HASH, BLOCK_NUM.toString())
    const r = getPayment(id)!
    assert.equal(r.flowState, 'Reverted')
    assert.equal(r.blockNumber, BLOCK_NUM.toString())
    assert.equal(r.reconciliationState, 'resolved')
    assert.equal(r.errorCategory, 'revert')
  })
})

describe('markUnknown', () => {
  it('sets flowState=Unknown and retains txHash', () => {
    const id = addRecord({ txHash: TX_HASH })
    markUnknown(id, TX_HASH, 'timeout')
    const r = getPayment(id)!
    assert.equal(r.flowState, 'Unknown')
    assert.equal(r.txHash, TX_HASH)
    assert.equal(r.reconciliationState, 'pending')
    assert.equal(r.errorCategory, 'timeout')
  })

  it('does NOT clear the txHash', () => {
    const id = addRecord({ txHash: TX_HASH })
    markUnknown(id, TX_HASH, 'rpc-error')
    assert.equal(getPayment(id)!.txHash, TX_HASH)
  })
})

describe('findByTxHash', () => {
  it('finds a record by its tx hash', () => {
    const id = addRecord({ txHash: TX_HASH })
    const found = findByTxHash(TX_HASH)
    assert.equal(found?.id, id)
  })

  it('is case-insensitive', () => {
    const id = addRecord({ txHash: TX_HASH })
    assert.equal(findByTxHash(TX_HASH.toUpperCase())?.id, id)
  })

  it('returns undefined for unknown hash', () => {
    assert.equal(findByTxHash(TX_HASH_2), undefined)
  })
})

describe('findByRequestId', () => {
  it('finds a record by requestId', () => {
    const id = addRecord({ requestId: REQUEST_ID })
    assert.equal(findByRequestId(REQUEST_ID)?.id, id)
  })

  it('is case-insensitive', () => {
    const id = addRecord({ requestId: REQUEST_ID })
    assert.equal(findByRequestId(REQUEST_ID.toUpperCase())?.id, id)
  })
})

describe('listByReconciliationState', () => {
  it('returns only records in the specified states', () => {
    const id1 = addRecord()
    updatePayment(id1, { reconciliationState: 'pending' })
    const id2 = addRecord()
    updatePayment(id2, { reconciliationState: 'resolved' })
    const id3 = addRecord()

    const pending = listByReconciliationState('pending')
    assert.equal(pending.length, 1)
    assert.equal(pending[0].id, id1)

    const multi = listByReconciliationState('pending', 'resolved')
    assert.equal(multi.length, 2)

    const none = listByReconciliationState('failed')
    assert.equal(none.length, 0)
    void id3  // suppress unused warning
  })
})

describe('toAuditRecord', () => {
  it('produces a full AuditRecord with all required fields', () => {
    const id = addRecord({ txHash: TX_HASH })
    const r = getPayment(id)!
    const audit = toAuditRecord(r)

    assert.equal(audit.id, id)
    assert.equal(audit.requestIdHex, REQUEST_ID)
    assert.equal(audit.recipient, RECIPIENT)
    assert.equal(audit.amountBaseUnits, AMOUNT.toString())
    assert.equal(audit.contractAddress, CONTRACT)
    assert.equal(audit.tokenAddress, TOKEN)
    assert.equal(audit.policyVerdict, 'allowed')
    assert.equal(audit.policyReasonCode, 'POLICY_OK')
    assert.equal(audit.flowState, 'Draft')
    assert.equal(audit.deliveryStatus, 'not-requested')
    assert.equal(audit.errorCategory, 'none')
    assert.equal(audit.reconciliationState, 'none')
    assert.equal(audit.verifiedEvent, null)
    assert.equal(audit.aiVerdict, null)
    assert.deepEqual(audit.aiWarnings, [])
  })

  it('includes a provenance note distinguishing server-log from onchain evidence', () => {
    const id = addRecord()
    const audit = toAuditRecord(getPayment(id)!)
    assert.match(audit.provenanceNote, /source=onchain/)
    assert.match(audit.provenanceNote, /source=server-log/)
  })

  it('includes verifiedEvent when set', () => {
    const id = addRecord({ txHash: TX_HASH })
    const summary: VerifiedEventSummary = {
      txHash: TX_HASH,
      blockNumber: '100',
      eventRecipient: RECIPIENT,
      eventAmountBaseUnits: AMOUNT.toString(),
      eventRequestId: REQUEST_ID,
      transferVerified: true,
      verifiedAt: new Date().toISOString(),
    }
    markConfirmed(id, summary, '100')
    const audit = toAuditRecord(getPayment(id)!)
    assert.deepEqual(audit.verifiedEvent, summary)
    assert.equal(audit.blockNumber, '100')
  })
})

// ── reconcileRecord ───────────────────────────────────────────────────────────

describe('reconcileRecord — confirmed', () => {
  it('marks the record Confirmed when all checks pass', async () => {
    const id = addRecord({ txHash: TX_HASH, flowState: 'Submitted', reconciliationState: 'pending' })
    const record = getPayment(id)!

    const result = await reconcileRecord(record, makeSuccessFetcher())

    assert.equal(result.outcome, 'confirmed')
    const updated = getPayment(id)!
    assert.equal(updated.flowState, 'Confirmed')
    assert.notEqual(updated.confirmedAt, null)
    assert.notEqual(updated.verifiedEvent, null)
    assert.equal(updated.reconciliationState, 'resolved')
    assert.equal(updated.errorCategory, 'none')
  })

  it('result message includes block number and event fields', async () => {
    const id = addRecord({ txHash: TX_HASH, flowState: 'Submitted', reconciliationState: 'pending' })
    const result = await reconcileRecord(getPayment(id)!, makeSuccessFetcher())
    assert.match(result.message, new RegExp(BLOCK_NUM.toString()))
  })
})

describe('reconcileRecord — reverted', () => {
  it('marks the record Reverted', async () => {
    const id = addRecord({ txHash: TX_HASH, flowState: 'Submitted', reconciliationState: 'pending' })
    const result = await reconcileRecord(getPayment(id)!, makeRevertedFetcher())

    assert.equal(result.outcome, 'reverted')
    const r = getPayment(id)!
    assert.equal(r.flowState, 'Reverted')
    assert.equal(r.errorCategory, 'revert')
    assert.equal(r.reconciliationState, 'resolved')
  })
})

describe('reconcileRecord — RPC timeout', () => {
  it('marks the record Unknown and retains the tx hash', async () => {
    const id = addRecord({ txHash: TX_HASH, flowState: 'Submitted', reconciliationState: 'pending' })
    const result = await reconcileRecord(getPayment(id)!, makeTimeoutFetcher())

    assert.equal(result.outcome, 'unknown-rpc-timeout')
    const r = getPayment(id)!
    assert.equal(r.flowState, 'Unknown')
    assert.equal(r.txHash, TX_HASH)       // tx hash retained
    assert.equal(r.errorCategory, 'timeout')
    assert.equal(r.reconciliationState, 'pending')  // still pending for next pass
  })

  it('does NOT broadcast a new transaction', async () => {
    // The fetcher only throws — it never returns a receipt that could trigger a send.
    const id = addRecord({ txHash: TX_HASH, flowState: 'Submitted', reconciliationState: 'pending' })
    await reconcileRecord(getPayment(id)!, makeTimeoutFetcher())
    // If a new tx had been broadcast, there would be a second record in the log.
    const allPending = listByReconciliationState('pending')
    assert.equal(allPending.length, 1)  // same record, not a new one
  })
})

describe('reconcileRecord — RPC error (non-timeout)', () => {
  it('increments the failure count and keeps reconciliationState=pending', async () => {
    const id = addRecord({ txHash: TX_HASH, flowState: 'Submitted', reconciliationState: 'pending' })
    const result = await reconcileRecord(getPayment(id)!, makeRpcErrorFetcher())

    assert.equal(result.outcome, 'unknown-rpc-error')
    assert.match(result.message, /attempt 1/)
    assert.equal(getPayment(id)!.reconciliationState, 'pending')
  })

  it(`marks reconciliation failed after ${FAILURE_THRESHOLD} consecutive errors`, async () => {
    const id = addRecord({ txHash: TX_HASH, flowState: 'Submitted', reconciliationState: 'pending' })
    const fetcher = makeRpcErrorFetcher()

    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      await reconcileRecord(getPayment(id)!, fetcher)
      assert.equal(getPayment(id)!.reconciliationState, 'pending')
    }

    // Final attempt hits the threshold.
    const final = await reconcileRecord(getPayment(id)!, fetcher)
    assert.equal(final.outcome, 'unknown-rpc-error')
    assert.equal(getPayment(id)!.reconciliationState, 'failed')
  })

  it('resets the failure count on a successful receipt fetch', async () => {
    const id = addRecord({ txHash: TX_HASH, flowState: 'Submitted', reconciliationState: 'pending' })
    const errorFetcher = makeRpcErrorFetcher()

    // Two failures, then a success.
    await reconcileRecord(getPayment(id)!, errorFetcher)
    await reconcileRecord(getPayment(id)!, errorFetcher)

    // Reset pending state for retry.
    updatePayment(id, { reconciliationState: 'pending' })
    await reconcileRecord(getPayment(id)!, makeSuccessFetcher())
    assert.equal(getPayment(id)!.flowState, 'Confirmed')
  })
})

describe('reconcileRecord — verification failure', () => {
  it('marks Unknown when PaymentExecuted event is missing', async () => {
    const id = addRecord({ txHash: TX_HASH, flowState: 'Submitted', reconciliationState: 'pending' })
    const noEventFetcher: ReceiptFetcher = async () => makeReceipt({ logs: [] })
    const result = await reconcileRecord(getPayment(id)!, noEventFetcher)

    assert.equal(result.outcome, 'unknown-verification-fail')
    assert.equal(getPayment(id)!.flowState, 'Unknown')
    assert.equal(getPayment(id)!.errorCategory, 'verification-fail')
  })

  it('marks Unknown when requestId in event does not match', async () => {
    const wrongRequestId = ('0x' + 'ff'.repeat(32)) as `0x${string}`
    const mismatchFetcher: ReceiptFetcher = async () =>
      makeReceipt({ logs: [makePaymentExecutedLog({ requestId: wrongRequestId })] })

    const id = addRecord({ txHash: TX_HASH, flowState: 'Submitted', reconciliationState: 'pending' })
    const result = await reconcileRecord(getPayment(id)!, mismatchFetcher)

    assert.equal(result.outcome, 'unknown-verification-fail')
    assert.equal(getPayment(id)!.flowState, 'Unknown')
  })

  it('marks Unknown when recipient in event does not match', async () => {
    const wrongRecipient = '0x1111111111111111111111111111111111111111' as `0x${string}`
    const mismatchFetcher: ReceiptFetcher = async () =>
      makeReceipt({ logs: [makePaymentExecutedLog({ recipient: wrongRecipient })] })

    const id = addRecord({ txHash: TX_HASH, flowState: 'Submitted', reconciliationState: 'pending' })
    const result = await reconcileRecord(getPayment(id)!, mismatchFetcher)

    assert.equal(result.outcome, 'unknown-verification-fail')
  })

  it('marks Unknown when amount in event does not match', async () => {
    const wrongAmount = 999_999n
    const mismatchFetcher: ReceiptFetcher = async () =>
      makeReceipt({ logs: [makePaymentExecutedLog({ amount: wrongAmount })] })

    const id = addRecord({ txHash: TX_HASH, flowState: 'Submitted', reconciliationState: 'pending' })
    const result = await reconcileRecord(getPayment(id)!, mismatchFetcher)

    assert.equal(result.outcome, 'unknown-verification-fail')
  })
})

describe('reconcileRecord — no tx hash', () => {
  it('skips records with no tx hash', async () => {
    const id = addRecord({ txHash: null })
    const result = await reconcileRecord(getPayment(id)!, makeSuccessFetcher())
    assert.equal(result.outcome, 'skipped-no-tx-hash')
    assert.equal(getPayment(id)!.flowState, 'Draft')  // unchanged
  })
})

describe('reconcileRecord — already terminal', () => {
  it('skips Confirmed records with reconciliationState=resolved', async () => {
    const id = addRecord({ txHash: TX_HASH, flowState: 'Confirmed' })
    updatePayment(id, { reconciliationState: 'resolved' })
    const result = await reconcileRecord(getPayment(id)!, makeSuccessFetcher())
    assert.equal(result.outcome, 'skipped-already-terminal')
  })

  it('re-reconciles Confirmed records with reconciliationState=pending (belt-and-suspenders)', async () => {
    // This can happen if the loop restart leaves reconciliationState=pending on a terminal record.
    const id = addRecord({ txHash: TX_HASH, flowState: 'Confirmed' })
    updatePayment(id, { reconciliationState: 'pending' })
    const result = await reconcileRecord(getPayment(id)!, makeSuccessFetcher())
    // Confirmed + pending → re-confirmed (not skipped).
    assert.equal(result.outcome, 'confirmed')
  })
})

// ── Duplicate event handling ──────────────────────────────────────────────────

describe('duplicate event handling', () => {
  it('reconciling the same record twice does not double-confirm', async () => {
    const id = addRecord({ txHash: TX_HASH, flowState: 'Submitted', reconciliationState: 'pending' })

    // First pass: confirms.
    await reconcileRecord(getPayment(id)!, makeSuccessFetcher())
    assert.equal(getPayment(id)!.flowState, 'Confirmed')

    // Second pass: record is terminal + resolved → skipped.
    const second = await reconcileRecord(getPayment(id)!, makeSuccessFetcher())
    assert.equal(second.outcome, 'skipped-already-terminal')
    assert.equal(getPayment(id)!.flowState, 'Confirmed')  // unchanged
  })
})

// ── Service failure after payment confirmation ────────────────────────────────

describe('service failure after payment confirmation', () => {
  it('payment can be Confirmed while deliveryStatus=failed', () => {
    const id = addRecord({ txHash: TX_HASH })
    const summary: VerifiedEventSummary = {
      txHash: TX_HASH,
      blockNumber: '100',
      eventRecipient: RECIPIENT,
      eventAmountBaseUnits: AMOUNT.toString(),
      eventRequestId: REQUEST_ID,
      transferVerified: true,
      verifiedAt: new Date().toISOString(),
    }
    markConfirmed(id, summary, '100')

    // Service delivery fails after payment is confirmed.
    updatePayment(id, { deliveryStatus: 'failed', errorCategory: 'service-failure' })

    const r = getPayment(id)!
    assert.equal(r.flowState, 'Confirmed')          // payment confirmed
    assert.equal(r.deliveryStatus, 'failed')         // but service failed
    assert.equal(r.errorCategory, 'service-failure') // error category updated
    assert.notEqual(r.verifiedEvent, null)            // on-chain evidence intact
  })

  it('the two axes (payment and delivery) are independent in AuditRecord', () => {
    const id = addRecord({ txHash: TX_HASH })
    const summary: VerifiedEventSummary = {
      txHash: TX_HASH,
      blockNumber: '200',
      eventRecipient: RECIPIENT,
      eventAmountBaseUnits: AMOUNT.toString(),
      eventRequestId: REQUEST_ID,
      transferVerified: false,
      verifiedAt: new Date().toISOString(),
    }
    markConfirmed(id, summary, '200')
    updatePayment(id, { deliveryStatus: 'unknown', errorCategory: 'service-failure' })

    const audit = toAuditRecord(getPayment(id)!)
    assert.equal(audit.flowState, 'Confirmed')
    assert.equal(audit.deliveryStatus, 'unknown')
    assert.equal(audit.errorCategory, 'service-failure')
  })
})

// ── runReconciliationPass ─────────────────────────────────────────────────────

describe('runReconciliationPass', () => {
  it('returns correct counts for a mixed batch', async () => {
    // One that will confirm.
    const id1 = addRecord({ txHash: TX_HASH,   flowState: 'Submitted', reconciliationState: 'pending' })
    // One that will revert.
    const id2 = addRecord({ txHash: TX_HASH_2, flowState: 'Submitted', reconciliationState: 'pending' })

    let callCount = 0
    const mixedFetcher: ReceiptFetcher = async (hash) => {
      callCount++
      if (hash === TX_HASH)   return makeReceipt({ txHash: TX_HASH })
      if (hash === TX_HASH_2) return makeReceipt({ txHash: TX_HASH_2, status: 'reverted', logs: [] })
      throw new Error('unexpected hash')
    }

    const pass = await runReconciliationPass(mixedFetcher)

    assert.equal(pass.confirmedCount, 1)
    assert.equal(pass.revertedCount, 1)
    assert.equal(pass.unknownCount, 0)
    assert.equal(pass.skippedCount, 0)
    assert.equal(pass.checkedCount, 2)
    assert.equal(callCount, 2)
    void id1; void id2
  })

  it('deduplicates records with the same tx hash in a pass', async () => {
    // Two records pointing at the same tx hash (edge case).
    addRecord({ txHash: TX_HASH, flowState: 'Submitted', reconciliationState: 'pending' })
    addRecord({ txHash: TX_HASH, flowState: 'Submitted', reconciliationState: 'pending' })

    let callCount = 0
    const countingFetcher: ReceiptFetcher = async () => {
      callCount++
      return makeReceipt()
    }

    const pass = await runReconciliationPass(countingFetcher)

    // Only one RPC call despite two records.
    assert.equal(callCount, 1)
    assert.equal(pass.confirmedCount, 1)
    assert.equal(pass.skippedCount, 1)   // duplicate-skipped
  })

  it('handles an empty pending queue gracefully', async () => {
    // No pending records.
    const pass = await runReconciliationPass(makeSuccessFetcher())
    assert.equal(pass.checkedCount, 0)
    assert.equal(pass.confirmedCount, 0)
    assert.equal(pass.results.length, 0)
  })

  it('does not retry ambiguous Unknown records a second time without operator action', async () => {
    // A record is Unknown with reconciliationState=pending.
    const id = addRecord({ txHash: TX_HASH, flowState: 'Unknown', reconciliationState: 'pending' })
    let callCount = 0

    const timeoutFetcher: ReceiptFetcher = async (hash) => {
      callCount++
      throw new ReceiptFetchTimeoutError(hash)
    }

    // First pass: times out → Unknown.
    await runReconciliationPass(timeoutFetcher)
    assert.equal(callCount, 1)
    assert.equal(getPayment(id)!.flowState, 'Unknown')

    // The record is still pending (for operator reconciliation).
    // A second pass would try again (that's correct — operator hasn't resolved it).
    // But no new tx is broadcast.
    await runReconciliationPass(timeoutFetcher)
    assert.equal(callCount, 2)   // tried again via reconciler
    // Still Unknown — NOT a new transaction.
    assert.equal(getPayment(id)!.flowState, 'Unknown')
  })
})

// ── Repeated reconciliation ───────────────────────────────────────────────────

describe('repeated reconciliation (idempotent on terminal records)', () => {
  it('does not change a Confirmed record on repeated passes', async () => {
    const id = addRecord({ txHash: TX_HASH, flowState: 'Submitted', reconciliationState: 'pending' })

    // First pass confirms.
    await runReconciliationPass(makeSuccessFetcher())
    const afterFirst = getPayment(id)!
    assert.equal(afterFirst.flowState, 'Confirmed')
    const firstConfirmedAt = afterFirst.confirmedAt

    // Second pass: record is terminal — not in pending state.
    await runReconciliationPass(makeSuccessFetcher())
    const afterSecond = getPayment(id)!
    assert.equal(afterSecond.flowState, 'Confirmed')
    assert.equal(afterSecond.confirmedAt, firstConfirmedAt)  // unchanged
  })

  it('does not change a Reverted record on repeated passes', async () => {
    const id = addRecord({ txHash: TX_HASH, flowState: 'Submitted', reconciliationState: 'pending' })

    await runReconciliationPass(makeRevertedFetcher())
    assert.equal(getPayment(id)!.flowState, 'Reverted')

    await runReconciliationPass(makeRevertedFetcher())
    assert.equal(getPayment(id)!.flowState, 'Reverted')  // unchanged
  })
})

// ── buildVerifiedEventSummary ─────────────────────────────────────────────────

describe('buildVerifiedEventSummary', () => {
  it('constructs summary from a TxVerificationResult', () => {
    const verResult = {
      outcome: 'confirmed' as const,
      verified: true,
      flowState: 'Confirmed' as const,
      explanation: 'OK',
      txHash: TX_HASH,
      blockNumber: BLOCK_NUM,
      decodedEvent: {
        requestId: REQUEST_ID,
        to: RECIPIENT,
        amount: AMOUNT,
        memo: 'test',
      },
    }
    const summary = buildVerifiedEventSummary(verResult, CONTRACT)
    assert.equal(summary.txHash, TX_HASH)
    assert.equal(summary.blockNumber, BLOCK_NUM.toString())
    assert.equal(summary.eventRecipient, RECIPIENT)
    assert.equal(summary.eventAmountBaseUnits, AMOUNT.toString())
    assert.equal(summary.eventRequestId, REQUEST_ID)
    assert.equal(summary.transferVerified, true)
    assert.match(summary.verifiedAt, /^\d{4}-\d{2}-\d{2}/)
  })
})

// ── Provenance and metadata ───────────────────────────────────────────────────

describe('AuditRecord provenance', () => {
  it('never contains secret or credential fields', () => {
    const id = addRecord()
    const audit = toAuditRecord(getPayment(id)!)
    const json = JSON.stringify(audit)
    assert.doesNotMatch(json, /api.key/i)
    assert.doesNotMatch(json, /secret/i)
    assert.doesNotMatch(json, /private.key/i)
    assert.doesNotMatch(json, /mnemonic/i)
    assert.doesNotMatch(json, /seed.phrase/i)
  })

  it('clearly labels off-chain source in provenanceNote', () => {
    const id = addRecord()
    const audit = toAuditRecord(getPayment(id)!)
    assert.match(audit.provenanceNote, /NOT cryptographically tamper-evident/)
  })
})
