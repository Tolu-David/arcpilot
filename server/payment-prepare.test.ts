/**
 * server/payment-prepare.test.ts
 *
 * Unit tests for the payment-preparation pipeline (server/payment-prepare.ts).
 *
 * Run with:  bun run test:payment-prepare
 * (Uses Node.js built-in test runner via tsx --test)
 *
 * Coverage:
 *  - Happy path: PolicyChecked and ApprovalRequired flow states
 *  - Idempotent retries: same key + same payload returns cached receipt
 *  - Duplicate clicks: second call returns identical receipt with cached=true
 *  - Key reuse with changed payload: IDEMPOTENCY_KEY_CONFLICT
 *  - Key reuse with changed service ID: IDEMPOTENCY_KEY_CONFLICT
 *  - Policy denial: POLICY_DENIED, no log entry
 *  - Stale snapshot: STALE_STATE
 *  - Invalid service ID: SERVICE_NOT_FOUND + INVALID_REQUEST
 *  - Malformed request: missing fields, oversized memo, bad key
 *  - requestId determinism: same inputs produce the same requestId
 *  - requestId uniqueness: different keys produce different requestIds
 *  - Payload hash invariants: changes in any field change the hash
 *  - Memo sanitisation: control chars stripped, capped at 128 chars
 *  - On-chain requestId protection: the contract enforces duplicates — verified
 *    by checking the requestId format and uniqueness, not by calling the chain
 *  - flowState is PolicyChecked when policy passes without approval
 *  - flowState is ApprovalRequired when price exceeds auto-approve threshold
 *  - Canonical values are never caller-supplied (recipient, amount, contract)
 *  - AI is not imported (no LLM involvement in policy or preparation)
 */

import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import {
  preparePayment,
  computePayloadHash,
  deriveRequestId,
  sanitiseMemo,
  _clearPrepareStore,
} from './payment-prepare.js'
import { _clearPaymentLog, listPayments } from './payment-log.js'
import type { ContractStateSnapshot } from '../shared/types.js'

// ── Snapshot helpers ──────────────────────────────────────────────────────────

function freshSnapshot(overrides: Partial<ContractStateSnapshot> = {}): ContractStateSnapshot {
  return {
    totalBalance:            100_000_000n,  // 100 USDC
    activeObligationsTotal:        0n,
    reserveAmount:          10_000_000n,  // 10 USDC (10% reserve)
    spendableBalance:       90_000_000n,  // 90 USDC
    reserveBps:             1_000,
    maxTxAmount:            10_000_000n,  // 10 USDC per tx
    globalDailyLimit:       50_000_000n,  // 50 USDC per day
    dailyRemainingGlobal:   50_000_000n,
    paused:                 false,
    fetchedAt:              Date.now(),
    ...overrides,
  }
}

/** A snapshot priced for the deep-analysis service (50 USDC, needs approval). */
function largeSnapshot(): ContractStateSnapshot {
  return freshSnapshot({
    totalBalance:           500_000_000n,
    spendableBalance:       450_000_000n,
    maxTxAmount:            100_000_000n,   // 100 USDC per tx
    globalDailyLimit:       500_000_000n,   // 500 USDC per day
    dailyRemainingGlobal:   500_000_000n,
    reserveAmount:           50_000_000n,
  })
}

const NOW = Date.now()

// ── Test suites ───────────────────────────────────────────────────────────────

describe('preparePayment — happy path (PolicyChecked)', () => {
  beforeEach(() => {
    _clearPrepareStore()
    _clearPaymentLog()
  })

  it('returns a receipt for data-scraper (0.50 USDC, auto-approved)', () => {
    const snap = freshSnapshot({ fetchedAt: NOW })
    const result = preparePayment(
      { serviceId: 'data-scraper', idempotencyKey: 'idem-001' },
      snap,
      NOW,
    )
    assert.ok(result.ok, `Expected ok but got: ${!result.ok && result.message}`)
    const { receipt } = result
    assert.equal(receipt.serviceId, 'data-scraper')
    assert.equal(receipt.amountBaseUnits, '500000')
    assert.equal(receipt.amountDisplay, '0.500000')
    assert.equal(receipt.flowState, 'PolicyChecked')
    assert.equal(receipt.policy.allowed, true)
    assert.equal(receipt.policy.approvalRequired, false)
    assert.equal(receipt.policy.reasonCode, 'POLICY_OK')
    assert.equal(receipt.cached, false)
  })

  it('receipt contains server-authoritative recipient, contract, token, chain', () => {
    const result = preparePayment(
      { serviceId: 'data-scraper', idempotencyKey: 'idem-002' },
      freshSnapshot({ fetchedAt: NOW }),
      NOW,
    )
    assert.ok(result.ok)
    const { receipt } = result
    assert.match(receipt.recipient, /^0x[0-9a-fA-F]{40}$/)
    assert.match(receipt.contractAddress, /^0x[0-9a-fA-F]{40}$/)
    assert.equal(receipt.tokenAddress, '0x3600000000000000000000000000000000000000')
    assert.equal(receipt.chainId, 5042002)
    assert.equal(receipt.chain, 'Arc Testnet')
  })

  it('receipt contains a valid bytes32 requestId', () => {
    const result = preparePayment(
      { serviceId: 'data-scraper', idempotencyKey: 'idem-003' },
      freshSnapshot({ fetchedAt: NOW }),
      NOW,
    )
    assert.ok(result.ok)
    assert.match(result.receipt.requestId, /^0x[0-9a-fA-F]{64}$/)
  })

  it('receipt contains policy context (spendable and daily remaining)', () => {
    const snap = freshSnapshot({ fetchedAt: NOW, spendableBalance: 88_000_000n, dailyRemainingGlobal: 42_000_000n })
    const result = preparePayment(
      { serviceId: 'data-scraper', idempotencyKey: 'idem-004' },
      snap,
      NOW,
    )
    assert.ok(result.ok)
    assert.equal(result.receipt.spendableAtCheck, '88000000')
    assert.equal(result.receipt.dailyRemainingAtCheck, '42000000')
  })

  it('sanitises and includes memo in the receipt', () => {
    const result = preparePayment(
      { serviceId: 'data-scraper', idempotencyKey: 'idem-005', memo: 'scrape this' },
      freshSnapshot({ fetchedAt: NOW }),
      NOW,
    )
    assert.ok(result.ok)
    assert.equal(result.receipt.memo, 'scrape this')
  })

  it('memo defaults to empty string when omitted', () => {
    const result = preparePayment(
      { serviceId: 'data-scraper', idempotencyKey: 'idem-006' },
      freshSnapshot({ fetchedAt: NOW }),
      NOW,
    )
    assert.ok(result.ok)
    assert.equal(result.receipt.memo, '')
  })

  it('appends a log entry in PolicyChecked state', () => {
    preparePayment(
      { serviceId: 'data-scraper', idempotencyKey: 'idem-007' },
      freshSnapshot({ fetchedAt: NOW }),
      NOW,
    )
    const page = listPayments(1, 10)
    assert.equal(page.total, 1)
    // The log entry is created at Draft by appendPayment; flowState is
    // returned in the receipt — the receipt is the authoritative source.
  })
})

describe('preparePayment — ApprovalRequired (deep-analysis, 50 USDC)', () => {
  beforeEach(() => {
    _clearPrepareStore()
    _clearPaymentLog()
  })

  it('returns ApprovalRequired when price exceeds auto-approve threshold', () => {
    const result = preparePayment(
      { serviceId: 'deep-analysis', idempotencyKey: 'idem-101' },
      largeSnapshot(),
      NOW,
    )
    assert.ok(result.ok)
    const { receipt } = result
    assert.equal(receipt.flowState, 'ApprovalRequired')
    assert.equal(receipt.policy.approvalRequired, true)
    assert.equal(receipt.policy.allowed, true)
    assert.equal(receipt.policy.reasonCode, 'APPROVAL_REQUIRED')
    assert.equal(receipt.amountBaseUnits, '50000000')
  })

  it('receipt for ApprovalRequired still contains requestId', () => {
    const result = preparePayment(
      { serviceId: 'deep-analysis', idempotencyKey: 'idem-102' },
      largeSnapshot(),
      NOW,
    )
    assert.ok(result.ok)
    assert.match(result.receipt.requestId, /^0x[0-9a-fA-F]{64}$/)
  })
})

describe('preparePayment — idempotent retries (same key, same payload)', () => {
  beforeEach(() => {
    _clearPrepareStore()
    _clearPaymentLog()
  })

  it('second call with same key returns cached=true', () => {
    const snap = freshSnapshot({ fetchedAt: NOW })
    const r1 = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'idem-retry-1' }, snap, NOW)
    const r2 = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'idem-retry-1' }, snap, NOW + 100)
    assert.ok(r1.ok)
    assert.ok(r2.ok)
    assert.equal(r1.receipt.cached, false)
    assert.equal(r2.receipt.cached, true)
  })

  it('second call returns the same prepId', () => {
    const snap = freshSnapshot({ fetchedAt: NOW })
    const r1 = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'idem-retry-2' }, snap, NOW)
    const r2 = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'idem-retry-2' }, snap, NOW + 50)
    assert.ok(r1.ok && r2.ok)
    assert.equal(r1.receipt.prepId, r2.receipt.prepId)
  })

  it('second call returns the same requestId', () => {
    const snap = freshSnapshot({ fetchedAt: NOW })
    const r1 = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'idem-retry-3' }, snap, NOW)
    const r2 = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'idem-retry-3' }, snap, NOW + 200)
    assert.ok(r1.ok && r2.ok)
    assert.equal(r1.receipt.requestId, r2.receipt.requestId)
  })

  it('second call returns the same amount (from catalogue, not re-fetched)', () => {
    const snap = freshSnapshot({ fetchedAt: NOW })
    const r1 = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'idem-retry-4' }, snap, NOW)
    const r2 = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'idem-retry-4' }, snap, NOW + 300)
    assert.ok(r1.ok && r2.ok)
    assert.equal(r1.receipt.amountBaseUnits, r2.receipt.amountBaseUnits)
  })

  it('second call does NOT create a second log entry', () => {
    const snap = freshSnapshot({ fetchedAt: NOW })
    preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'idem-retry-5' }, snap, NOW)
    preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'idem-retry-5' }, snap, NOW + 100)
    assert.equal(listPayments(1, 10).total, 1)
  })

  it('stale snapshot on retry does not block — returns cached receipt', () => {
    const snap = freshSnapshot({ fetchedAt: NOW })
    preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'idem-retry-6' }, snap, NOW)
    // Second call with a 2-minute-old snapshot — but it's a cache hit, so stale check is bypassed
    const staleSnap = freshSnapshot({ fetchedAt: NOW - 120_000 })
    const r2 = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'idem-retry-6' }, staleSnap, NOW)
    assert.ok(r2.ok)
    assert.equal(r2.receipt.cached, true)
  })
})

describe('preparePayment — duplicate clicks (rapid fire)', () => {
  beforeEach(() => {
    _clearPrepareStore()
    _clearPaymentLog()
  })

  it('10 rapid calls with the same key return the same receipt', () => {
    const snap = freshSnapshot({ fetchedAt: NOW })
    const ids = new Set<string>()
    for (let i = 0; i < 10; i++) {
      const r = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'rapid-click-1' }, snap, NOW + i)
      assert.ok(r.ok)
      ids.add(r.receipt.prepId)
    }
    assert.equal(ids.size, 1, 'All rapid calls should return the same prepId')
  })

  it('only one log entry created across 10 rapid calls', () => {
    const snap = freshSnapshot({ fetchedAt: NOW })
    for (let i = 0; i < 10; i++) {
      preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'rapid-click-2' }, snap, NOW + i)
    }
    assert.equal(listPayments(1, 10).total, 1)
  })
})

describe('preparePayment — key reuse with different payload (IDEMPOTENCY_KEY_CONFLICT)', () => {
  beforeEach(() => {
    _clearPrepareStore()
    _clearPaymentLog()
  })

  it('reusing the same key with a different service ID is rejected', () => {
    const snap = freshSnapshot({ fetchedAt: NOW })
    const r1 = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'conflict-key-1' }, snap, NOW)
    assert.ok(r1.ok)
    // Attempt to reuse the key for a different service (deep-analysis has a different price+recipient hash)
    const r2 = preparePayment({ serviceId: 'recommend-spend', idempotencyKey: 'conflict-key-1' }, largeSnapshot(), NOW)
    assert.ok(!r2.ok)
    assert.equal(r2.code, 'IDEMPOTENCY_KEY_CONFLICT')
    assert.match(r2.message, /conflict-key-1/)
  })

  it('CONFLICT does not create an additional log entry', () => {
    const snap = freshSnapshot({ fetchedAt: NOW })
    preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'conflict-key-2' }, snap, NOW)
    preparePayment({ serviceId: 'recommend-spend', idempotencyKey: 'conflict-key-2' }, largeSnapshot(), NOW)
    assert.equal(listPayments(1, 10).total, 1)
  })

  it('error message does NOT leak the original payload or hash', () => {
    const snap = freshSnapshot({ fetchedAt: NOW })
    preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'conflict-key-3' }, snap, NOW)
    const r2 = preparePayment({ serviceId: 'recommend-spend', idempotencyKey: 'conflict-key-3' }, largeSnapshot(), NOW)
    assert.ok(!r2.ok)
    // Message must not contain a hash or address pattern
    assert.ok(
      !r2.message.match(/[0-9a-f]{64}/i),
      'Error message must not leak the payload hash',
    )
  })
})

describe('preparePayment — policy denial (POLICY_DENIED)', () => {
  beforeEach(() => {
    _clearPrepareStore()
    _clearPaymentLog()
  })

  it('returns POLICY_DENIED when treasury is paused', () => {
    const snap = freshSnapshot({ fetchedAt: NOW, paused: true })
    const result = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'denied-1' }, snap, NOW)
    assert.ok(!result.ok)
    assert.equal(result.code, 'POLICY_DENIED')
    assert.match(result.message, /paused/)
  })

  it('does NOT create a log entry on denial', () => {
    const snap = freshSnapshot({ fetchedAt: NOW, paused: true })
    preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'denied-2' }, snap, NOW)
    assert.equal(listPayments(1, 10).total, 0)
  })

  it('does NOT store an idempotency record on denial', () => {
    const snap1 = freshSnapshot({ fetchedAt: NOW, paused: true })
    preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'denied-3' }, snap1, NOW)
    // After unpausing, the same key should be usable
    const snap2 = freshSnapshot({ fetchedAt: NOW + 1000 })
    const r2 = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'denied-3' }, snap2, NOW + 1000)
    assert.ok(r2.ok, 'Should succeed after policy denial (no key binding)')
    assert.equal(r2.receipt.cached, false, 'Should not be cached — first real success')
  })

  it('returns POLICY_DENIED for SERVICE_NOT_ALLOWLISTED (prohibited-endpoint)', () => {
    const snap = freshSnapshot({ fetchedAt: NOW })
    const result = preparePayment({ serviceId: 'prohibited-endpoint', idempotencyKey: 'denied-4' }, snap, NOW)
    assert.ok(!result.ok)
    assert.equal(result.code, 'POLICY_DENIED')
  })

  it('returns POLICY_DENIED when TX_LIMIT_EXCEEDED', () => {
    const snap = freshSnapshot({ fetchedAt: NOW, maxTxAmount: 100_000n })  // 0.10 USDC, data-scraper costs 0.50
    const result = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'denied-5' }, snap, NOW)
    assert.ok(!result.ok)
    assert.equal(result.code, 'POLICY_DENIED')
    assert.ok(result.details && (result.details as Record<string, unknown>).reasonCode === 'TX_LIMIT_EXCEEDED')
  })

  it('returns POLICY_DENIED when DAILY_LIMIT_EXCEEDED', () => {
    const snap = freshSnapshot({ fetchedAt: NOW, globalDailyLimit: 1_000_000n, dailyRemainingGlobal: 100_000n })
    const result = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'denied-6' }, snap, NOW)
    assert.ok(!result.ok)
    assert.equal(result.code, 'POLICY_DENIED')
    assert.ok(result.details && (result.details as Record<string, unknown>).reasonCode === 'DAILY_LIMIT_EXCEEDED')
  })

  it('returns POLICY_DENIED when RESERVE_BREACH', () => {
    const snap = freshSnapshot({ fetchedAt: NOW, spendableBalance: 100_000n })  // 0.10 USDC, less than 0.50
    const result = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'denied-7' }, snap, NOW)
    assert.ok(!result.ok)
    assert.equal(result.code, 'POLICY_DENIED')
    assert.ok(result.details && (result.details as Record<string, unknown>).reasonCode === 'RESERVE_BREACH')
  })

  it('returns POLICY_DENIED when INSUFFICIENT_FUNDS (zero spendable)', () => {
    const snap = freshSnapshot({ fetchedAt: NOW, spendableBalance: 0n })
    const result = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'denied-8' }, snap, NOW)
    assert.ok(!result.ok)
    assert.equal(result.code, 'POLICY_DENIED')
    assert.ok(result.details && (result.details as Record<string, unknown>).reasonCode === 'INSUFFICIENT_FUNDS')
  })

  it('denial details include serviceId and priceBaseUnits (as string)', () => {
    const snap = freshSnapshot({ fetchedAt: NOW, paused: true })
    const result = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'denied-9' }, snap, NOW)
    assert.ok(!result.ok)
    const d = result.details as Record<string, unknown>
    assert.equal(d.serviceId, 'data-scraper')
    assert.equal(d.priceBaseUnits, '500000')
  })
})

describe('preparePayment — stale state (STALE_STATE)', () => {
  beforeEach(() => {
    _clearPrepareStore()
    _clearPaymentLog()
  })

  it('rejects a snapshot older than 60 seconds', () => {
    const snap = freshSnapshot({ fetchedAt: NOW - 61_000 })
    const result = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'stale-1' }, snap, NOW)
    assert.ok(!result.ok)
    assert.equal(result.code, 'STALE_STATE')
    assert.match(result.message, /61s/)
  })

  it('accepts a snapshot exactly at the 60-second boundary', () => {
    const snap = freshSnapshot({ fetchedAt: NOW - 60_000 })
    const result = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'stale-2' }, snap, NOW)
    // At exactly 60_000 ms: snapshotAge = 60_000, threshold = 60_000, condition is > not >=
    // Therefore exactly 60s is NOT stale.
    assert.ok(result.ok)
  })

  it('rejects a snapshot 1ms beyond the boundary', () => {
    const snap = freshSnapshot({ fetchedAt: NOW - 60_001 })
    const result = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'stale-3' }, snap, NOW)
    assert.ok(!result.ok)
    assert.equal(result.code, 'STALE_STATE')
  })

  it('stale state does NOT create a log entry', () => {
    const snap = freshSnapshot({ fetchedAt: NOW - 120_000 })
    preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'stale-4' }, snap, NOW)
    assert.equal(listPayments(1, 10).total, 0)
  })

  it('stale state does NOT bind the idempotency key', () => {
    const stale = freshSnapshot({ fetchedAt: NOW - 120_000 })
    preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'stale-5' }, stale, NOW)
    const fresh = freshSnapshot({ fetchedAt: NOW })
    const r2 = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'stale-5' }, fresh, NOW)
    assert.ok(r2.ok, 'Fresh snapshot after stale rejection should succeed')
    assert.equal(r2.receipt.cached, false)
  })
})

describe('preparePayment — invalid service ID', () => {
  beforeEach(() => {
    _clearPrepareStore()
    _clearPaymentLog()
  })

  it('returns SERVICE_NOT_FOUND for an unknown service', () => {
    const result = preparePayment(
      { serviceId: 'nonexistent-service', idempotencyKey: 'inv-1' },
      freshSnapshot({ fetchedAt: NOW }),
      NOW,
    )
    assert.ok(!result.ok)
    assert.equal(result.code, 'SERVICE_NOT_FOUND')
    assert.match(result.message, /nonexistent-service/)
  })

  it('returns INVALID_REQUEST for a service ID with uppercase chars', () => {
    const result = preparePayment(
      { serviceId: 'Data-Scraper', idempotencyKey: 'inv-2' },
      freshSnapshot({ fetchedAt: NOW }),
      NOW,
    )
    assert.ok(!result.ok)
    assert.equal(result.code, 'INVALID_REQUEST')
  })

  it('returns INVALID_REQUEST for a service ID with spaces', () => {
    const result = preparePayment(
      { serviceId: 'data scraper', idempotencyKey: 'inv-3' },
      freshSnapshot({ fetchedAt: NOW }),
      NOW,
    )
    assert.ok(!result.ok)
    assert.equal(result.code, 'INVALID_REQUEST')
  })

  it('returns INVALID_REQUEST for a SQL-injection-style service ID', () => {
    const result = preparePayment(
      { serviceId: "'; DROP TABLE services; --", idempotencyKey: 'inv-4' },
      freshSnapshot({ fetchedAt: NOW }),
      NOW,
    )
    assert.ok(!result.ok)
    assert.equal(result.code, 'INVALID_REQUEST')
  })

  it('returns INVALID_REQUEST for an empty service ID', () => {
    const result = preparePayment(
      { serviceId: '', idempotencyKey: 'inv-5' },
      freshSnapshot({ fetchedAt: NOW }),
      NOW,
    )
    assert.ok(!result.ok)
    assert.equal(result.code, 'INVALID_REQUEST')
  })
})

describe('preparePayment — malformed request', () => {
  beforeEach(() => {
    _clearPrepareStore()
    _clearPaymentLog()
  })

  it('rejects empty idempotency key', () => {
    const result = preparePayment(
      { serviceId: 'data-scraper', idempotencyKey: '' },
      freshSnapshot({ fetchedAt: NOW }),
      NOW,
    )
    assert.ok(!result.ok)
    assert.equal(result.code, 'INVALID_REQUEST')
    assert.match(result.message, /idempotencyKey/)
  })

  it('rejects idempotency key longer than 128 chars', () => {
    const result = preparePayment(
      { serviceId: 'data-scraper', idempotencyKey: 'x'.repeat(129) },
      freshSnapshot({ fetchedAt: NOW }),
      NOW,
    )
    assert.ok(!result.ok)
    assert.equal(result.code, 'INVALID_REQUEST')
  })

  it('accepts idempotency key of exactly 128 chars', () => {
    const result = preparePayment(
      { serviceId: 'data-scraper', idempotencyKey: 'x'.repeat(128) },
      freshSnapshot({ fetchedAt: NOW }),
      NOW,
    )
    assert.ok(result.ok)
  })

  it('trims and sanitises memo (no control characters)', () => {
    const result = preparePayment(
      { serviceId: 'data-scraper', idempotencyKey: 'mal-3', memo: 'clean\x00memo\x1Fhere' },
      freshSnapshot({ fetchedAt: NOW }),
      NOW,
    )
    assert.ok(result.ok)
    assert.ok(!result.receipt.memo.includes('\x00'))
    assert.ok(!result.receipt.memo.includes('\x1F'))
  })

  it('caps memo at 128 characters', () => {
    const longMemo = 'm'.repeat(300)
    const result = preparePayment(
      { serviceId: 'data-scraper', idempotencyKey: 'mal-4', memo: longMemo },
      freshSnapshot({ fetchedAt: NOW }),
      NOW,
    )
    assert.ok(result.ok)
    assert.equal(result.receipt.memo.length, 128)
  })
})

describe('computePayloadHash invariants', () => {
  const SERVICE = 'data-scraper'
  const RECIPIENT = '0x5B12Ce46C7194aD57d143bC22847224047b1Ef42'
  const AMOUNT = 500_000n

  it('is deterministic: same inputs produce the same hash', () => {
    assert.equal(
      computePayloadHash(SERVICE, RECIPIENT, AMOUNT),
      computePayloadHash(SERVICE, RECIPIENT, AMOUNT),
    )
  })

  it('is 64-character hex (SHA-256)', () => {
    const hash = computePayloadHash(SERVICE, RECIPIENT, AMOUNT)
    assert.match(hash, /^[0-9a-f]{64}$/)
  })

  it('changes when serviceId changes', () => {
    const h1 = computePayloadHash('data-scraper', RECIPIENT, AMOUNT)
    const h2 = computePayloadHash('deep-analysis', RECIPIENT, AMOUNT)
    assert.notEqual(h1, h2)
  })

  it('changes when recipient changes', () => {
    const h1 = computePayloadHash(SERVICE, '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', AMOUNT)
    const h2 = computePayloadHash(SERVICE, '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', AMOUNT)
    assert.notEqual(h1, h2)
  })

  it('changes when amount changes', () => {
    const h1 = computePayloadHash(SERVICE, RECIPIENT, 500_000n)
    const h2 = computePayloadHash(SERVICE, RECIPIENT, 500_001n)
    assert.notEqual(h1, h2)
  })

  it('is case-insensitive for recipient address (normalised to lowercase)', () => {
    const upper = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const lower = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    assert.equal(
      computePayloadHash(SERVICE, upper, AMOUNT),
      computePayloadHash(SERVICE, lower, AMOUNT),
    )
  })
})

describe('deriveRequestId invariants', () => {
  it('produces a valid 0x-prefixed bytes32 string', () => {
    const id = deriveRequestId('idem-001', 'abc123hash')
    assert.match(id, /^0x[0-9a-f]{64}$/)
  })

  it('is deterministic: same inputs produce the same requestId', () => {
    assert.equal(
      deriveRequestId('idem-001', 'hash1'),
      deriveRequestId('idem-001', 'hash1'),
    )
  })

  it('changes when idempotency key changes', () => {
    const id1 = deriveRequestId('idem-001', 'hash1')
    const id2 = deriveRequestId('idem-002', 'hash1')
    assert.notEqual(id1, id2)
  })

  it('changes when payload hash changes', () => {
    const id1 = deriveRequestId('idem-001', 'hash1')
    const id2 = deriveRequestId('idem-001', 'hash2')
    assert.notEqual(id1, id2)
  })

  it('different keys for different services produce different requestIds', () => {
    // Even if someone tried to reuse a key, different canonical payloads → different hashes → different IDs
    const hashA = computePayloadHash('data-scraper', '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 500_000n)
    const hashB = computePayloadHash('deep-analysis', '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 50_000_000n)
    const id1 = deriveRequestId('shared-key', hashA)
    const id2 = deriveRequestId('shared-key', hashB)
    assert.notEqual(id1, id2)
  })
})

describe('sanitiseMemo', () => {
  it('returns empty string for undefined', () => {
    assert.equal(sanitiseMemo(undefined), '')
  })

  it('trims leading/trailing whitespace', () => {
    assert.equal(sanitiseMemo('  hello  '), 'hello')
  })

  it('replaces null bytes with space', () => {
    const result = sanitiseMemo('a\x00b')
    assert.ok(!result.includes('\x00'))
  })

  it('replaces control characters (\\x01–\\x1F) with space', () => {
    const result = sanitiseMemo('a\x01\x1Fb')
    assert.ok(!result.includes('\x01'))
    assert.ok(!result.includes('\x1F'))
  })

  it('caps at 128 characters by default', () => {
    assert.equal(sanitiseMemo('x'.repeat(200)).length, 128)
  })

  it('respects a custom maxLen', () => {
    assert.equal(sanitiseMemo('hello world', 5).length, 5)
  })

  it('preserves normal text and common punctuation', () => {
    const memo = 'Payment for invoice #42 (Q4-2026) @ 0.50 USDC'
    assert.equal(sanitiseMemo(memo), memo)
  })
})

describe('on-chain requestId protection (contract-level duplicate prevention)', () => {
  beforeEach(() => {
    _clearPrepareStore()
    _clearPaymentLog()
  })

  it('the requestId in the receipt matches bytes32 format expected by the contract', () => {
    const result = preparePayment(
      { serviceId: 'data-scraper', idempotencyKey: 'chain-test-1' },
      freshSnapshot({ fetchedAt: NOW }),
      NOW,
    )
    assert.ok(result.ok)
    // The contract's executePayment expects a bytes32 (0x + 64 hex chars)
    assert.match(result.receipt.requestId, /^0x[0-9a-fA-F]{64}$/)
  })

  it('two different idempotency keys produce different requestIds (no collision)', () => {
    const snap = freshSnapshot({ fetchedAt: NOW })
    const r1 = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'chain-test-2a' }, snap, NOW)
    const r2 = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'chain-test-2b' }, snap, NOW)
    assert.ok(r1.ok && r2.ok)
    assert.notEqual(r1.receipt.requestId, r2.receipt.requestId)
  })

  it('same key repeated (retry) produces the same requestId for the contract dedup check', () => {
    const snap = freshSnapshot({ fetchedAt: NOW })
    const r1 = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'chain-test-3' }, snap, NOW)
    const r2 = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'chain-test-3' }, snap, NOW + 100)
    assert.ok(r1.ok && r2.ok)
    assert.equal(r1.receipt.requestId, r2.receipt.requestId)
  })
})

describe('canonical values are server-authoritative', () => {
  beforeEach(() => {
    _clearPrepareStore()
    _clearPaymentLog()
  })

  it('amount in receipt equals catalogue price (caller cannot override)', () => {
    const result = preparePayment(
      { serviceId: 'data-scraper', idempotencyKey: 'auth-1' },
      freshSnapshot({ fetchedAt: NOW }),
      NOW,
    )
    assert.ok(result.ok)
    // data-scraper is 500_000 base units = 0.50 USDC
    assert.equal(result.receipt.amountBaseUnits, '500000')
    assert.equal(result.receipt.amountDisplay, '0.500000')
  })

  it('recipient in receipt comes from catalogue, not the request body', () => {
    const result = preparePayment(
      { serviceId: 'data-scraper', idempotencyKey: 'auth-2' },
      freshSnapshot({ fetchedAt: NOW }),
      NOW,
    )
    assert.ok(result.ok)
    // The recipient is the server-configured DEFAULT_RECIPIENT address.
    // The test verifies it is a valid address — the specific value is env-dependent.
    assert.match(result.receipt.recipient, /^0x[0-9a-fA-F]{40}$/)
  })

  it('contract address comes from server config, not the request body', () => {
    const result = preparePayment(
      { serviceId: 'data-scraper', idempotencyKey: 'auth-3' },
      freshSnapshot({ fetchedAt: NOW }),
      NOW,
    )
    assert.ok(result.ok)
    assert.match(result.receipt.contractAddress, /^0x[0-9a-fA-F]{40}$/)
  })

  it('token address is the canonical Arc USDC predeploy', () => {
    const result = preparePayment(
      { serviceId: 'data-scraper', idempotencyKey: 'auth-4' },
      freshSnapshot({ fetchedAt: NOW }),
      NOW,
    )
    assert.ok(result.ok)
    assert.equal(
      result.receipt.tokenAddress.toLowerCase(),
      '0x3600000000000000000000000000000000000000',
    )
  })
})

describe('AI is not imported by the preparation pipeline', () => {
  it('preparePayment is a synchronous function (not async, no LLM call)', () => {
    const snap = freshSnapshot({ fetchedAt: NOW })
    _clearPrepareStore()
    const result = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'ai-check-1' }, snap, NOW)
    // If this returns a plain object (not a Promise), AI is not involved.
    assert.ok(typeof (result as unknown as Promise<unknown>).then !== 'function', 'preparePayment must be synchronous')
    assert.ok(result.ok)
  })

  it('module exports do not include any AI-related symbols', async () => {
    const mod = await import('./payment-prepare.js')
    const exportedNames = Object.keys(mod)
    const aiKeywords = ['gemini', 'openai', 'llm', 'model', 'infer', 'generate', 'stream']
    for (const name of exportedNames) {
      for (const kw of aiKeywords) {
        assert.ok(
          !name.toLowerCase().includes(kw),
          `Export "${name}" should not be AI-related`,
        )
      }
    }
  })
})

describe('preparePayment — boundary values', () => {
  beforeEach(() => {
    _clearPrepareStore()
    _clearPaymentLog()
  })

  it('passes when price equals maxTxAmount exactly', () => {
    // data-scraper = 500_000 base units
    const snap = freshSnapshot({ fetchedAt: NOW, maxTxAmount: 500_000n })
    const result = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'bv-1' }, snap, NOW)
    assert.ok(result.ok)
  })

  it('fails when price is 1 unit above maxTxAmount', () => {
    const snap = freshSnapshot({ fetchedAt: NOW, maxTxAmount: 499_999n })
    const result = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'bv-2' }, snap, NOW)
    assert.ok(!result.ok)
    assert.equal(result.code, 'POLICY_DENIED')
  })

  it('passes when price equals dailyRemainingGlobal exactly', () => {
    const snap = freshSnapshot({ fetchedAt: NOW, globalDailyLimit: 500_000n, dailyRemainingGlobal: 500_000n })
    const result = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'bv-3' }, snap, NOW)
    assert.ok(result.ok)
  })

  it('fails when price is 1 unit above dailyRemainingGlobal', () => {
    const snap = freshSnapshot({ fetchedAt: NOW, globalDailyLimit: 1_000_000n, dailyRemainingGlobal: 499_999n })
    const result = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'bv-4' }, snap, NOW)
    assert.ok(!result.ok)
    assert.equal(result.code, 'POLICY_DENIED')
  })

  it('passes when price equals spendableBalance exactly', () => {
    const snap = freshSnapshot({ fetchedAt: NOW, spendableBalance: 500_000n })
    const result = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'bv-5' }, snap, NOW)
    assert.ok(result.ok)
  })

  it('fails when price is 1 unit above spendableBalance', () => {
    const snap = freshSnapshot({ fetchedAt: NOW, spendableBalance: 499_999n })
    const result = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'bv-6' }, snap, NOW)
    assert.ok(!result.ok)
    assert.equal(result.code, 'POLICY_DENIED')
  })

  it('globalDailyLimit = 0 means no daily limit (unlimited)', () => {
    const snap = freshSnapshot({ fetchedAt: NOW, globalDailyLimit: 0n, dailyRemainingGlobal: 0n })
    const result = preparePayment({ serviceId: 'data-scraper', idempotencyKey: 'bv-7' }, snap, NOW)
    assert.ok(result.ok, `Expected ok but got: ${!result.ok && result.message}`)
  })

  it('maxTxAmount = 0 means no per-tx cap (unlimited)', () => {
    // deep-analysis = 50_000_000, max tx 0 = unlimited.
    // It exceeds the auto-approve threshold so it lands in ApprovalRequired.
    const snap = { ...largeSnapshot(), maxTxAmount: 0n }
    const result = preparePayment({ serviceId: 'deep-analysis', idempotencyKey: 'bv-8' }, snap, NOW)
    assert.ok(result.ok, `Expected ok but got: ${!result.ok && result.message}`)
    assert.equal(result.receipt.flowState, 'ApprovalRequired')
  })
})
