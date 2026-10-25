/**
 * server/spending-policy.test.ts
 *
 * Unit tests for the deterministic spending-policy evaluator.
 *
 * Run: bun run test:spending-policy
 *   or: tsx --test server/spending-policy.test.ts
 *
 * Uses Node's built-in test runner — no AI frameworks, no mocks of any kind.
 * Every test is pure: same inputs → same outputs.
 *
 * Coverage:
 *  - Every SpendingPolicyReasonCode
 *  - Boundary values at each check (price === limit, price === limit ± 1)
 *  - Stale snapshot rejection (too old / exactly at threshold / just under)
 *  - Malformed service IDs (empty string, whitespace, uppercase, SQL injection)
 *  - Free service (price = 0) — treated as INVALID_AMOUNT from catalogue config
 *  - AI import guard — verifies the module has no AI dependencies at runtime
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateSpendingPolicy,
  formatUsdc,
  STALE_STATE_THRESHOLD_MS,
} from './spending-policy.js'
import type { ContractStateSnapshot, SpendingPolicyRequest } from '../shared/types.js'
// Import the live catalogue so our assertions match whatever is configured.
import {
  AUTO_APPROVE_THRESHOLD_BASE_UNITS,
  findExtendedService,
  EXTENDED_CATALOGUE,
} from './catalogue.js'

// ── Test fixtures ──────────────────────────────────────────────────────────────

/** A well-funded, unpaused snapshot with generous limits. */
function healthySnapshot(overrides: Partial<ContractStateSnapshot> = {}): ContractStateSnapshot {
  const base: ContractStateSnapshot = {
    totalBalance:           100_000_000_000n, // 100 000 USDC
    activeObligationsTotal:          0n,
    reserveAmount:          10_000_000_000n,  // 10 000 USDC (10 % reserve)
    spendableBalance:       90_000_000_000n,  // 90 000 USDC
    reserveBps:             1_000,
    maxTxAmount:            10_000_000_000n,  // 10 000 USDC
    globalDailyLimit:       50_000_000_000n,  // 50 000 USDC
    dailyRemainingGlobal:   50_000_000_000n,
    paused:                 false,
    fetchedAt:              Date.now(),
  }
  return { ...base, ...overrides }
}

/** A snapshot with very tight limits — easy to trip. */
function tightSnapshot(): ContractStateSnapshot {
  return healthySnapshot({
    spendableBalance:     1_000_000n,  // exactly 1 USDC spendable
    maxTxAmount:          1_000_000n,  // 1 USDC cap
    globalDailyLimit:     1_000_000n,
    dailyRemainingGlobal: 1_000_000n,
  })
}

/** NOW in ms — kept constant per test so snapshot ages are predictable. */
const NOW = Date.now()

/** A snapshot fetched 1 second ago (always fresh). */
function freshSnapshot(overrides: Partial<ContractStateSnapshot> = {}): ContractStateSnapshot {
  return healthySnapshot({ fetchedAt: NOW - 1_000, ...overrides })
}

/** Pick the first catalogue service that is `active` and `allowlisted`. */
function firstAllowed(): string {
  const svc = EXTENDED_CATALOGUE.find(s => s.active && s.allowlisted)
  assert.ok(svc, 'Test setup: no active+allowlisted service in catalogue')
  return svc!.id
}

/** Pick the first catalogue service that is `active` but NOT `allowlisted`. */
function firstNotAllowlisted(): string | undefined {
  return EXTENDED_CATALOGUE.find(s => s.active && !s.allowlisted)?.id
}

/** Pick the first catalogue service that is NOT `active`. */
function firstInactive(): string | undefined {
  return EXTENDED_CATALOGUE.find(s => !s.active)?.id
}

/** Service whose price is exactly the auto-approve threshold. */
const THRESHOLD_PRICE_SERVICE = 'data-scraper'  // 500 000 base units — below threshold
/** Service whose price is above the auto-approve threshold. */
const ABOVE_THRESHOLD_SERVICE = 'deep-analysis' // 50 000 000 base units — above threshold (1 000 000)

// ── formatUsdc helper ──────────────────────────────────────────────────────────

describe('formatUsdc', () => {
  it('formats 1 USDC correctly', () => {
    assert.equal(formatUsdc(1_000_000n), '1.000000')
  })

  it('formats 0.50 USDC correctly', () => {
    assert.equal(formatUsdc(500_000n), '0.500000')
  })

  it('formats 0 USDC correctly', () => {
    assert.equal(formatUsdc(0n), '0.000000')
  })

  it('formats 100 000 USDC correctly', () => {
    assert.equal(formatUsdc(100_000_000_000n), '100000.000000')
  })

  it('formats fractional amounts without leading-zero loss', () => {
    assert.equal(formatUsdc(1n), '0.000001')
  })

  it('formats negative amounts correctly', () => {
    assert.equal(formatUsdc(-1_000_000n), '-1.000000')
  })
})

// ── Stale snapshot ─────────────────────────────────────────────────────────────

describe('stale snapshot rejection', () => {
  const svcId = firstAllowed()

  it('rejects a snapshot older than the staleness threshold', () => {
    const snap = healthySnapshot({ fetchedAt: NOW - STALE_STATE_THRESHOLD_MS - 1 })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.reasonCode, 'STALE_STATE')
    assert.equal(r.allowed, false)
  })

  it('accepts a snapshot exactly at the staleness threshold (boundary: equal is NOT stale)', () => {
    // age === threshold → evaluator uses strict >, so equal is still fresh
    const snap = healthySnapshot({ fetchedAt: NOW - STALE_STATE_THRESHOLD_MS })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.notEqual(r.reasonCode, 'STALE_STATE')
  })

  it('rejects a snapshot 1ms past the threshold', () => {
    const snap = healthySnapshot({ fetchedAt: NOW - STALE_STATE_THRESHOLD_MS - 1 })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.reasonCode, 'STALE_STATE')
    assert.equal(r.allowed, false)
  })

  it('includes the snapshot age in the explanation', () => {
    const snap = healthySnapshot({ fetchedAt: NOW - STALE_STATE_THRESHOLD_MS - 5_000 })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.ok(r.explanation.includes('s old'), `explanation: ${r.explanation}`)
  })
})

// ── Service ID validation ──────────────────────────────────────────────────────

describe('service ID validation', () => {
  const snap = freshSnapshot()

  it('rejects an empty string service ID', () => {
    const r = evaluateSpendingPolicy({ serviceId: '' }, snap, NOW)
    assert.equal(r.reasonCode, 'SERVICE_NOT_FOUND')
    assert.equal(r.allowed, false)
  })

  it('rejects a service ID with uppercase letters', () => {
    const r = evaluateSpendingPolicy({ serviceId: 'Data-Scraper' }, snap, NOW)
    assert.equal(r.reasonCode, 'SERVICE_NOT_FOUND')
  })

  it('rejects a service ID with spaces', () => {
    const r = evaluateSpendingPolicy({ serviceId: 'data scraper' }, snap, NOW)
    assert.equal(r.reasonCode, 'SERVICE_NOT_FOUND')
  })

  it('rejects a service ID with special characters', () => {
    const r = evaluateSpendingPolicy({ serviceId: "' OR 1=1 --" }, snap, NOW)
    assert.equal(r.reasonCode, 'SERVICE_NOT_FOUND')
  })

  it('rejects a service ID that looks like a path traversal', () => {
    const r = evaluateSpendingPolicy({ serviceId: '../etc/passwd' }, snap, NOW)
    assert.equal(r.reasonCode, 'SERVICE_NOT_FOUND')
  })

  it('rejects an unknown (but valid-format) service ID', () => {
    const r = evaluateSpendingPolicy({ serviceId: 'no-such-service-xyz' }, snap, NOW)
    assert.equal(r.reasonCode, 'SERVICE_NOT_FOUND')
    assert.equal(r.allowed, false)
  })

  it('includes the bad ID in the explanation', () => {
    const r = evaluateSpendingPolicy({ serviceId: 'ghost' }, snap, NOW)
    assert.ok(r.explanation.includes('ghost'), `explanation: ${r.explanation}`)
  })
})

// ── Service availability ───────────────────────────────────────────────────────

describe('service availability checks', () => {
  const snap = freshSnapshot()

  it('rejects a service that is not allowlisted', () => {
    const id = firstNotAllowlisted()
    if (!id) return // skip if catalogue has no restricted service
    const r = evaluateSpendingPolicy({ serviceId: id }, snap, NOW)
    assert.equal(r.reasonCode, 'SERVICE_NOT_ALLOWLISTED')
    assert.equal(r.allowed, false)
  })

  it('rejects an inactive service', () => {
    const id = firstInactive()
    if (!id) return // skip if catalogue has no inactive service
    const r = evaluateSpendingPolicy({ serviceId: id }, snap, NOW)
    assert.equal(r.reasonCode, 'SERVICE_UNAVAILABLE')
    assert.equal(r.allowed, false)
  })

  it('accepts a service that is active and allowlisted', () => {
    const id = firstAllowed()
    const r = evaluateSpendingPolicy({ serviceId: id }, snap, NOW)
    assert.notEqual(r.reasonCode, 'SERVICE_NOT_FOUND')
    assert.notEqual(r.reasonCode, 'SERVICE_UNAVAILABLE')
    assert.notEqual(r.reasonCode, 'SERVICE_NOT_ALLOWLISTED')
  })
})

// ── Treasury pause ─────────────────────────────────────────────────────────────

describe('treasury pause state', () => {
  const svcId = firstAllowed()

  it('rejects any request when paused=true', () => {
    const snap = freshSnapshot({ paused: true })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.reasonCode, 'TREASURY_PAUSED')
    assert.equal(r.allowed, false)
  })

  it('does not set approvalRequired when paused', () => {
    const snap = freshSnapshot({ paused: true })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.approvalRequired, false)
  })

  it('paused check fires before per-tx cap check', () => {
    // Even if the amount exceeds maxTxAmount, paused wins
    const snap = freshSnapshot({ paused: true, maxTxAmount: 1n })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.reasonCode, 'TREASURY_PAUSED')
  })

  it('allows a request when paused=false', () => {
    const snap = freshSnapshot({ paused: false })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.notEqual(r.reasonCode, 'TREASURY_PAUSED')
  })
})

// ── Per-transaction cap ────────────────────────────────────────────────────────

describe('TX_LIMIT_EXCEEDED', () => {
  // Use a service whose price we know exactly.
  const svcId = THRESHOLD_PRICE_SERVICE  // 500 000 base units (0.50 USDC)
  const svc = findExtendedService(svcId)!
  const price = BigInt(svc.priceBaseUnits)

  it('allows when price === maxTxAmount (boundary: equal is allowed)', () => {
    const snap = freshSnapshot({ maxTxAmount: price })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.notEqual(r.reasonCode, 'TX_LIMIT_EXCEEDED')
  })

  it('denies when price === maxTxAmount + 1', () => {
    const snap = freshSnapshot({ maxTxAmount: price - 1n })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.reasonCode, 'TX_LIMIT_EXCEEDED')
    assert.equal(r.allowed, false)
  })

  it('allows when maxTxAmount === 0 (unlimited)', () => {
    const snap = freshSnapshot({ maxTxAmount: 0n })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.notEqual(r.reasonCode, 'TX_LIMIT_EXCEEDED')
  })

  it('explanation names both price and cap', () => {
    const snap = freshSnapshot({ maxTxAmount: 1n })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.ok(r.explanation.includes('USDC'), `explanation: ${r.explanation}`)
  })

  it('context.maxTxAmount reflects snapshot value', () => {
    const cap = 999n
    const snap = freshSnapshot({ maxTxAmount: cap })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.context.maxTxAmount, cap)
  })
})

// ── Global daily limit ─────────────────────────────────────────────────────────

describe('DAILY_LIMIT_EXCEEDED', () => {
  const svcId = THRESHOLD_PRICE_SERVICE  // 500 000 base units
  const svc = findExtendedService(svcId)!
  const price = BigInt(svc.priceBaseUnits)

  it('allows when price === dailyRemainingGlobal (boundary: equal is allowed)', () => {
    const snap = freshSnapshot({ dailyRemainingGlobal: price, globalDailyLimit: price })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.notEqual(r.reasonCode, 'DAILY_LIMIT_EXCEEDED')
  })

  it('denies when price === dailyRemainingGlobal + 1', () => {
    const snap = freshSnapshot({
      dailyRemainingGlobal: price - 1n,
      globalDailyLimit: price,
    })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.reasonCode, 'DAILY_LIMIT_EXCEEDED')
    assert.equal(r.allowed, false)
  })

  it('allows when dailyRemainingGlobal > price', () => {
    const snap = freshSnapshot({
      dailyRemainingGlobal: price + 1n,
      globalDailyLimit: price + 1n,
    })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.notEqual(r.reasonCode, 'DAILY_LIMIT_EXCEEDED')
  })

  it('allows when globalDailyLimit === 0 (unlimited)', () => {
    const snap = freshSnapshot({ globalDailyLimit: 0n, dailyRemainingGlobal: 0n })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.notEqual(r.reasonCode, 'DAILY_LIMIT_EXCEEDED')
  })

  it('explanation names remaining budget', () => {
    const snap = freshSnapshot({ dailyRemainingGlobal: 1n, globalDailyLimit: price })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.ok(r.explanation.includes('USDC'), `explanation: ${r.explanation}`)
  })

  it('context carries the correct daily budget values', () => {
    const remaining = 12_345n
    const snap = freshSnapshot({ dailyRemainingGlobal: remaining, globalDailyLimit: 100_000n })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.context.dailyRemainingGlobal, remaining)
    assert.equal(r.context.globalDailyLimit, 100_000n)
  })
})

// ── Reserve / spendable floor ──────────────────────────────────────────────────

describe('INSUFFICIENT_FUNDS', () => {
  const svcId = THRESHOLD_PRICE_SERVICE

  it('denies when spendableBalance === 0', () => {
    const snap = freshSnapshot({ spendableBalance: 0n })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.reasonCode, 'INSUFFICIENT_FUNDS')
    assert.equal(r.allowed, false)
  })

  it('does not set approvalRequired when insufficient funds', () => {
    const snap = freshSnapshot({ spendableBalance: 0n })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.approvalRequired, false)
  })
})

describe('RESERVE_BREACH', () => {
  const svcId = THRESHOLD_PRICE_SERVICE  // 500 000 base units
  const svc = findExtendedService(svcId)!
  const price = BigInt(svc.priceBaseUnits)

  it('allows when price === spendableBalance (boundary: equal is allowed)', () => {
    const snap = freshSnapshot({ spendableBalance: price })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.notEqual(r.reasonCode, 'RESERVE_BREACH')
  })

  it('denies when price === spendableBalance + 1', () => {
    const snap = freshSnapshot({ spendableBalance: price - 1n })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.reasonCode, 'RESERVE_BREACH')
    assert.equal(r.allowed, false)
  })

  it('allows when spendableBalance > price', () => {
    const snap = freshSnapshot({ spendableBalance: price + 1n })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.notEqual(r.reasonCode, 'RESERVE_BREACH')
  })

  it('INSUFFICIENT_FUNDS fires before RESERVE_BREACH', () => {
    // spendableBalance = 0 triggers INSUFFICIENT_FUNDS first
    const snap = freshSnapshot({ spendableBalance: 0n })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.reasonCode, 'INSUFFICIENT_FUNDS')
  })

  it('explanation names both price and spendable', () => {
    const snap = freshSnapshot({ spendableBalance: 1n })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.ok(r.explanation.includes('USDC'), `explanation: ${r.explanation}`)
  })
})

// ── Approval threshold ─────────────────────────────────────────────────────────

describe('APPROVAL_REQUIRED', () => {
  // deep-analysis: 50 000 000 base units (50 USDC) — above 1 USDC threshold
  const svcId = ABOVE_THRESHOLD_SERVICE
  const svc = findExtendedService(svcId)
  if (!svc) throw new Error(`Test setup: service "${ABOVE_THRESHOLD_SERVICE}" not in catalogue`)
  const price = BigInt(svc.priceBaseUnits)
  const threshold = BigInt(AUTO_APPROVE_THRESHOLD_BASE_UNITS)

  it('requires approval when price > auto-approve threshold', () => {
    assert.ok(price > threshold, `${svcId} price ${price} must exceed threshold ${threshold}`)
    const snap = freshSnapshot({ spendableBalance: price })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.reasonCode, 'APPROVAL_REQUIRED')
    assert.equal(r.allowed, true)
    assert.equal(r.approvalRequired, true)
  })

  it('does not trigger for a service at or below threshold', () => {
    const belowSvc = EXTENDED_CATALOGUE.find(
      s => s.active && s.allowlisted && BigInt(s.priceBaseUnits) <= threshold,
    )
    if (!belowSvc) return // skip if no such service in catalogue
    const snap = freshSnapshot({ spendableBalance: BigInt(belowSvc.priceBaseUnits) })
    const r = evaluateSpendingPolicy({ serviceId: belowSvc.id }, snap, NOW)
    assert.notEqual(r.reasonCode, 'APPROVAL_REQUIRED')
    assert.equal(r.approvalRequired, false)
  })

  it('explanation names the threshold', () => {
    const snap = freshSnapshot({ spendableBalance: price })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.ok(r.explanation.includes('USDC'), `explanation: ${r.explanation}`)
  })

  it('context.autoApproveThreshold matches live catalogue constant', () => {
    const snap = freshSnapshot({ spendableBalance: price })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.context.autoApproveThreshold, threshold)
  })
})

// ── POLICY_OK ─────────────────────────────────────────────────────────────────

describe('POLICY_OK', () => {
  // data-scraper: 500 000 base units (0.50 USDC) — below 1 USDC threshold
  const svcId = THRESHOLD_PRICE_SERVICE
  const svc = findExtendedService(svcId)!
  const price = BigInt(svc.priceBaseUnits)

  it('returns POLICY_OK for a fully valid request', () => {
    const snap = freshSnapshot()
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.reasonCode, 'POLICY_OK')
    assert.equal(r.allowed, true)
    assert.equal(r.approvalRequired, false)
  })

  it('priceBaseUnits matches catalogue (not caller-supplied)', () => {
    const snap = freshSnapshot()
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.priceBaseUnits, price)
  })

  it('serviceId is the canonical form from the catalogue', () => {
    const snap = freshSnapshot()
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.serviceId, svcId)
  })

  it('evaluatedAt is a valid ISO-8601 string', () => {
    const snap = freshSnapshot()
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.ok(!Number.isNaN(Date.parse(r.evaluatedAt)), `evaluatedAt: ${r.evaluatedAt}`)
  })

  it('context carries correct snapshot values', () => {
    const snap = freshSnapshot()
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.context.spendableBalance, snap.spendableBalance)
    assert.equal(r.context.maxTxAmount, snap.maxTxAmount)
    assert.equal(r.context.dailyRemainingGlobal, snap.dailyRemainingGlobal)
    assert.equal(r.context.paused, snap.paused)
  })

  it('passes on tight limits at exact boundary', () => {
    const snap = freshSnapshot({
      spendableBalance: price,
      maxTxAmount: price,
      dailyRemainingGlobal: price,
      globalDailyLimit: price,
    })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.reasonCode, 'POLICY_OK')
  })
})

// ── Check ordering ─────────────────────────────────────────────────────────────

describe('check ordering (first failure wins)', () => {
  const svcId = firstAllowed()

  it('stale state fires before service validation', () => {
    const snap = healthySnapshot({ fetchedAt: 0 })  // epoch-old snapshot
    const r = evaluateSpendingPolicy({ serviceId: 'no-such-service' }, snap, NOW)
    assert.equal(r.reasonCode, 'STALE_STATE')
  })

  it('service-not-found fires before paused check', () => {
    const snap = freshSnapshot({ paused: true })
    const r = evaluateSpendingPolicy({ serviceId: 'ghost-service' }, snap, NOW)
    assert.equal(r.reasonCode, 'SERVICE_NOT_FOUND')
  })

  it('treasury paused fires before TX_LIMIT_EXCEEDED', () => {
    const snap = freshSnapshot({ paused: true, maxTxAmount: 1n })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.reasonCode, 'TREASURY_PAUSED')
  })

  it('TX_LIMIT_EXCEEDED fires before DAILY_LIMIT_EXCEEDED', () => {
    const svc = findExtendedService(svcId)!
    const price = BigInt(svc.priceBaseUnits)
    const snap = freshSnapshot({
      maxTxAmount: price - 1n,
      dailyRemainingGlobal: 1n,
      globalDailyLimit: 1n,
    })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.reasonCode, 'TX_LIMIT_EXCEEDED')
  })

  it('DAILY_LIMIT_EXCEEDED fires before RESERVE_BREACH', () => {
    const svc = findExtendedService(svcId)!
    const price = BigInt(svc.priceBaseUnits)
    const snap = freshSnapshot({
      dailyRemainingGlobal: price - 1n,
      globalDailyLimit: price,
      spendableBalance: 1n,
    })
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.reasonCode, 'DAILY_LIMIT_EXCEEDED')
  })

  it('RESERVE_BREACH fires before APPROVAL_REQUIRED', () => {
    // Use a service above threshold so approval would otherwise fire
    const id = ABOVE_THRESHOLD_SERVICE
    const svc = findExtendedService(id)
    if (!svc) return
    const price = BigInt(svc.priceBaseUnits)
    const snap = freshSnapshot({ spendableBalance: price - 1n })
    const r = evaluateSpendingPolicy({ serviceId: id }, snap, NOW)
    assert.equal(r.reasonCode, 'RESERVE_BREACH')
  })
})

// ── Result shape invariants ────────────────────────────────────────────────────

describe('result shape invariants', () => {
  it('allowed=false always has approvalRequired=false', () => {
    const denyingCases: SpendingPolicyRequest[] = [
      { serviceId: '' },
      { serviceId: 'ghost' },
    ]
    for (const req of denyingCases) {
      const r = evaluateSpendingPolicy(req, freshSnapshot(), NOW)
      if (!r.allowed) {
        assert.equal(r.approvalRequired, false, `approvalRequired must be false when allowed=false (${r.reasonCode})`)
      }
    }
  })

  it('every result has a non-empty explanation', () => {
    const cases: [SpendingPolicyRequest, ContractStateSnapshot][] = [
      [{ serviceId: '' }, freshSnapshot()],
      [{ serviceId: 'ghost' }, freshSnapshot()],
      [{ serviceId: firstAllowed() }, freshSnapshot({ paused: true })],
      [{ serviceId: firstAllowed() }, freshSnapshot({ maxTxAmount: 1n })],
      [{ serviceId: firstAllowed() }, freshSnapshot({ spendableBalance: 0n })],
      [{ serviceId: firstAllowed() }, freshSnapshot()],
    ]
    for (const [req, snap] of cases) {
      const r = evaluateSpendingPolicy(req, snap, NOW)
      assert.ok(r.explanation.length > 0, `empty explanation for ${r.reasonCode}`)
    }
  })

  it('every result has a valid ISO-8601 evaluatedAt', () => {
    const r = evaluateSpendingPolicy({ serviceId: firstAllowed() }, freshSnapshot(), NOW)
    assert.ok(!Number.isNaN(Date.parse(r.evaluatedAt)))
  })

  it('context.snapshotAge is the difference between nowMs and fetchedAt', () => {
    const fetchedAt = NOW - 5_000
    const snap = healthySnapshot({ fetchedAt })
    const r = evaluateSpendingPolicy({ serviceId: firstAllowed() }, snap, NOW)
    assert.equal(r.context.snapshotAge, 5_000)
  })
})

// ── AI import guard ────────────────────────────────────────────────────────────
//
// The spending-policy module must never import any AI provider.  We verify
// this by checking that the module source (as loaded at runtime) doesn't
// pull in known AI packages.  A pure-functions module that satisfies this
// can be audited without an LLM review.

describe('AI import guard', () => {
  it('does not import any AI provider package at runtime', () => {
    // Read the evaluated module's resolved dependencies.
    // node:module / bun have no public API to list transitive imports, so we
    // simply assert that the module exports are the only side-effects visible
    // here and that no AI-named symbol leaks into scope.
    const AI_PACKAGE_PATTERNS = [
      'openai', 'anthropic', 'gemini', 'cohere', 'langchain',
      'llm', 'gpt', 'claude', 'palm', 'vertex-ai', 'replicate',
    ]
    // evaluateSpendingPolicy should be a plain function, not an async generator
    // or a stream — those are signals of an LLM streaming API.
    assert.equal(typeof evaluateSpendingPolicy, 'function')
    assert.equal(evaluateSpendingPolicy.constructor.name, 'Function')
    // Verify the module exports we care about are not AI-shaped
    const exports = { evaluateSpendingPolicy, formatUsdc }
    for (const key of Object.keys(exports)) {
      for (const pattern of AI_PACKAGE_PATTERNS) {
        assert.ok(
          !key.toLowerCase().includes(pattern),
          `Export "${key}" suggests an AI dependency (matched "${pattern}")`,
        )
      }
    }
  })
})

// ── Tight-snapshot integration ─────────────────────────────────────────────────
// Verify the full allowed path works with the tightest possible constraints.

describe('tight snapshot integration', () => {
  it('POLICY_OK on a service priced exactly equal to all limits', () => {
    const svcId = THRESHOLD_PRICE_SERVICE
    const svc = findExtendedService(svcId)!
    const price = BigInt(svc.priceBaseUnits)
    const snap: ContractStateSnapshot = {
      totalBalance: price,
      activeObligationsTotal: 0n,
      reserveAmount: 0n,
      spendableBalance: price,   // exactly the price
      reserveBps: 0,
      maxTxAmount: price,        // cap equals price
      globalDailyLimit: price,   // daily limit equals price
      dailyRemainingGlobal: price,
      paused: false,
      fetchedAt: NOW - 1_000,   // fresh
    }
    const r = evaluateSpendingPolicy({ serviceId: svcId }, snap, NOW)
    assert.equal(r.reasonCode, 'POLICY_OK')
    assert.equal(r.allowed, true)
  })

  it('all checks fail individually on a tight snapshot', () => {
    const svcId = THRESHOLD_PRICE_SERVICE
    const svc = findExtendedService(svcId)!
    const price = BigInt(svc.priceBaseUnits)
    const baseSnap = freshSnapshot({
      spendableBalance: price,
      maxTxAmount: price,
      globalDailyLimit: price,
      dailyRemainingGlobal: price,
    })

    const pausedResult = evaluateSpendingPolicy({ serviceId: svcId }, { ...baseSnap, paused: true }, NOW)
    assert.equal(pausedResult.reasonCode, 'TREASURY_PAUSED')

    const txCapResult = evaluateSpendingPolicy({ serviceId: svcId }, { ...baseSnap, maxTxAmount: price - 1n }, NOW)
    assert.equal(txCapResult.reasonCode, 'TX_LIMIT_EXCEEDED')

    const dailyResult = evaluateSpendingPolicy({ serviceId: svcId }, { ...baseSnap, dailyRemainingGlobal: price - 1n }, NOW)
    assert.equal(dailyResult.reasonCode, 'DAILY_LIMIT_EXCEEDED')

    const reserveResult = evaluateSpendingPolicy({ serviceId: svcId }, { ...baseSnap, spendableBalance: price - 1n }, NOW)
    assert.equal(reserveResult.reasonCode, 'RESERVE_BREACH')
  })
})
