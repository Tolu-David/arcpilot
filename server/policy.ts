/**
 * server/policy.ts
 *
 * Deterministic treasury policy engine.
 *
 * Rules:
 * - Pure functions only — no I/O, no external calls, no AI provider code.
 * - All monetary values are bigint in USDC base units (6 decimals).
 * - The same input always produces the same output.
 * - Tests can import this file directly without mocking anything.
 *
 * Thresholds are exported constants so tests and callers can reference them
 * without hardcoding magic numbers.
 */

import type {
  TreasurySnapshot,
  PolicyRecommendation,
  PolicyResult,
} from '../shared/types.js'

// ── Configurable thresholds (all in USDC base units unless noted) ─────────────

/** Warn when spendable balance falls below this amount (1 USDC). */
export const LOW_SPENDABLE_THRESHOLD = 1_000_000n  // 1 USDC

/**
 * Warn when obligations exceed this fraction of total balance.
 * Expressed as a numerator over 10_000 (basis points).  Default: 50 % = 5000.
 */
export const HIGH_OBLIGATION_RATIO_BPS = 5_000n

/**
 * Warn when reserve is above this fraction of total balance (over-reserved).
 * Basis points.  Default: 40 % = 4000.
 */
export const OVER_RESERVE_THRESHOLD_BPS = 4_000n

/**
 * Warn when reserve is set to zero — no buffer against unexpected obligations.
 */
export const ZERO_RESERVE_BPS = 0

// ── Policy engine ─────────────────────────────────────────────────────────────

/**
 * Evaluate a treasury snapshot against all policy rules and return a
 * PolicyResult.  Never throws — validation is the caller's responsibility.
 */
export function evaluatePolicy(snapshot: TreasurySnapshot): PolicyResult {
  const recommendations: PolicyRecommendation[] = []

  const {
    totalBalance,
    activeObligationsTotal,
    reserveAmount,
    spendableBalance,
    reserveBps,
  } = snapshot

  // ── Rule 1: Empty treasury ──────────────────────────────────────────────────
  if (totalBalance === 0n) {
    recommendations.push({
      code: 'EMPTY_TREASURY',
      message:
        'Treasury holds no USDC. Deposit funds before configuring policies or executing payments.',
      severity: 'critical',
    })
    // No further rules are meaningful with a zero balance.
    return result(false, recommendations)
  }

  // ── Rule 2: Low spendable balance ───────────────────────────────────────────
  if (spendableBalance < LOW_SPENDABLE_THRESHOLD) {
    recommendations.push({
      code: 'LOW_SPENDABLE',
      message:
        `Spendable balance is below ${formatUsdc(LOW_SPENDABLE_THRESHOLD)} USDC. ` +
        'Pause discretionary payments or reduce obligations until the treasury is replenished.',
      severity: spendableBalance === 0n ? 'critical' : 'warning',
    })
  }

  // ── Rule 3: Obligations exceed 50 % of balance ──────────────────────────────
  if (totalBalance > 0n) {
    const obligationRatioBps = (activeObligationsTotal * 10_000n) / totalBalance
    if (obligationRatioBps > HIGH_OBLIGATION_RATIO_BPS) {
      recommendations.push({
        code: 'HIGH_OBLIGATION_RATIO',
        message:
          `Configured obligations represent ${bpsToPercent(obligationRatioBps)}% of total balance. ` +
          'Review whether all obligations reflect real recurring costs.',
        severity: 'warning',
      })
    }
  }

  // ── Rule 4: Over-reserved ───────────────────────────────────────────────────
  if (totalBalance > 0n && reserveAmount > 0n) {
    const reserveRatioBps = (reserveAmount * 10_000n) / totalBalance
    if (reserveRatioBps > OVER_RESERVE_THRESHOLD_BPS) {
      recommendations.push({
        code: 'OVER_RESERVED',
        message:
          `Reserve is ${bpsToPercent(BigInt(reserveBps))}% of balance (${formatUsdc(reserveAmount)} USDC). ` +
          'Reducing reserve basis points by 5–10 % would free spendable capacity without materially increasing risk.',
        severity: 'info',
      })
    }
  }

  // ── Rule 5: Zero reserve ────────────────────────────────────────────────────
  if (reserveBps === ZERO_RESERVE_BPS) {
    recommendations.push({
      code: 'ZERO_RESERVE',
      message:
        'Reserve is set to 0 %. There is no buffer against unexpected obligations. ' +
        'Consider setting reserveBps to at least 500 (5 %).',
      severity: 'warning',
    })
  }

  // ── Rule 6: Obligations exceed spendable (would block payments) ─────────────
  if (activeObligationsTotal > spendableBalance + reserveAmount) {
    recommendations.push({
      code: 'OBLIGATIONS_BLOCK_PAYMENTS',
      message:
        'Obligation total plus reserve exceeds treasury balance. No payments can be executed. ' +
        'Either reduce obligations, lower reserve, or deposit more USDC.',
      severity: 'critical',
    })
  }

  const healthy = recommendations.every((r) => r.severity === 'info')
  return result(healthy, recommendations)
}

/**
 * Build a policy recommendation from a free-text context string.
 * Used by the /api/agent/recommend-spend endpoint.
 * Returns a PolicyRecommendation (no snapshot needed — text-only path).
 */
export function recommendFromContext(context: string): PolicyRecommendation {
  const ctx = context.toLowerCase()

  if (ctx.includes('empty') || ctx.includes('zero balance')) {
    return {
      code: 'EMPTY_TREASURY',
      message:
        'Treasury appears empty. Deposit USDC before executing any payments.',
      severity: 'critical',
    }
  }
  if (ctx.includes('low') || ctx.includes('insufficient')) {
    return {
      code: 'LOW_SPENDABLE',
      message:
        'Treasury balance is low. Pause discretionary payments until reserves recover. ' +
        'Consider reviewing obligation amounts.',
      severity: 'warning',
    }
  }
  if (ctx.includes('over-reserved') || ctx.includes('too much reserve')) {
    return {
      code: 'OVER_RESERVED',
      message:
        'Reserve allocation is high relative to obligations. ' +
        'Reducing reserve basis points by 5–10 % would free spendable capacity without materially increasing risk.',
      severity: 'info',
    }
  }
  if (ctx.includes('payee') || ctx.includes('agent')) {
    return {
      code: 'PAYEE_CONFIG',
      message:
        'Add the AI agent wallet as a permitted payee with a conservative daily USDC limit before enabling autonomous payments.',
      severity: 'info',
    }
  }
  if (ctx.includes('obligation') || ctx.includes('recurring')) {
    return {
      code: 'OBLIGATION_REVIEW',
      message:
        'Ensure all active obligations reflect real recurring costs. ' +
        'Remove stale obligations to unlock spendable capacity.',
      severity: 'info',
    }
  }

  return {
    code: 'HEALTHY',
    message:
      'Treasury policy looks healthy. ' +
      'Ensure all active obligations reflect real recurring costs and that every payee has an appropriate daily cap.',
    severity: 'info',
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function result(healthy: boolean, recommendations: PolicyRecommendation[]): PolicyResult {
  return {
    healthy,
    recommendations,
    evaluatedAt: new Date().toISOString(),
  }
}

/** Format a bigint USDC base-unit amount as a decimal string, e.g. 1_000_000n → "1.000000" */
function formatUsdc(amount: bigint): string {
  const whole = amount / 1_000_000n
  const frac = amount % 1_000_000n
  return `${whole}.${frac.toString().padStart(6, '0')}`
}

/** Convert basis points to a human-readable percentage string, e.g. 5000n → "50.00" */
function bpsToPercent(bps: bigint): string {
  const whole = bps / 100n
  const frac = bps % 100n
  return `${whole}.${frac.toString().padStart(2, '0')}`
}
