/**
 * server/spending-policy.ts
 *
 * Deterministic ArcPilot spending-policy evaluator.
 *
 * Design invariants (enforced, not assumed):
 *  - Pure functions only — no I/O, no RPC calls, no AI imports.
 *  - All monetary arithmetic uses bigint to eliminate floating-point error.
 *  - Prices and recipient addresses come from the server catalogue only;
 *    the caller supplies only a service ID.
 *  - The contract is the final enforcement boundary.  A POLICY_OK result
 *    does not guarantee the on-chain transaction succeeds — state may change
 *    between evaluation and broadcast.
 *
 * Check order (first failure wins):
 *  1. Service ID validation
 *  2. Service active
 *  3. Caller on allowlist
 *  4. Treasury pause state
 *  5. Amount validity (positive integer string, exactly representable)
 *  6. Per-transaction cap
 *  7. Global daily budget
 *  8. Reserve / spendable floor
 *  9. Approval threshold
 * 10. POLICY_OK
 */

// No AI imports — this module must never depend on any AI/LLM provider.

import type {
  SpendingPolicyRequest,
  SpendingPolicyResult,
  SpendingPolicyReasonCode,
  SpendingPolicyContext,
  ContractStateSnapshot,
} from '../shared/types.js'
import {
  findExtendedService,
  AUTO_APPROVE_THRESHOLD_BASE_UNITS,
} from './catalogue.js'

// ── Staleness threshold ────────────────────────────────────────────────────────

/**
 * Maximum age (in milliseconds) for a contract state snapshot.
 * A snapshot older than this produces STALE_STATE rather than a policy decision.
 * Default: 60 seconds.  Override via SPENDING_POLICY_STALE_MS env var.
 */
export const STALE_STATE_THRESHOLD_MS: number = (() => {
  const raw = process.env.SPENDING_POLICY_STALE_MS
  if (!raw) return 60_000
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 60_000
})()

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Evaluate a payment request against the service catalogue and a fresh
 * contract state snapshot.
 *
 * @param request   The spending request (service ID only — no amount, no recipient).
 * @param snapshot  Fresh on-chain state fetched by the caller immediately before
 *                  this evaluation.  The evaluator does NOT fetch state itself.
 * @param nowMs     Current time in Unix ms.  Defaults to Date.now().  Override in
 *                  tests to keep snapshots from expiring.
 * @returns         A fully typed SpendingPolicyResult — never throws.
 */
export function evaluateSpendingPolicy(
  request: SpendingPolicyRequest,
  snapshot: ContractStateSnapshot,
  nowMs: number = Date.now(),
): SpendingPolicyResult {
  // ── Guard: stale snapshot ────────────────────────────────────────────────────
  const snapshotAge = nowMs - snapshot.fetchedAt
  if (snapshotAge > STALE_STATE_THRESHOLD_MS) {
    return deny('STALE_STATE', request.serviceId, 0n, snapshot, snapshotAge,
      `Contract state snapshot is ${Math.round(snapshotAge / 1000)}s old ` +
      `(max ${Math.round(STALE_STATE_THRESHOLD_MS / 1000)}s). ` +
      'Fetch a fresh snapshot and re-evaluate before submitting a payment.',
    )
  }

  // ── Check 1: service ID format ───────────────────────────────────────────────
  const { serviceId } = request
  if (!serviceId || typeof serviceId !== 'string' || !/^[a-z0-9-]+$/.test(serviceId)) {
    return deny('SERVICE_NOT_FOUND', serviceId ?? '', 0n, snapshot, snapshotAge,
      `"${serviceId}" is not a valid service ID. ` +
      'Service IDs are lowercase alphanumeric with hyphens.',
    )
  }

  // ── Check 2: service exists ──────────────────────────────────────────────────
  const service = findExtendedService(serviceId)
  if (!service) {
    return deny('SERVICE_NOT_FOUND', serviceId, 0n, snapshot, snapshotAge,
      `No service with id "${serviceId}" in the catalogue. ` +
      'Fetch GET /api/catalogue for the current list.',
    )
  }

  const price = BigInt(service.priceBaseUnits)

  // ── Check 3: service active ──────────────────────────────────────────────────
  if (!service.active) {
    return deny('SERVICE_UNAVAILABLE', serviceId, price, snapshot, snapshotAge,
      `Service "${serviceId}" is not currently active.`,
    )
  }

  // ── Check 4: caller on allowlist ─────────────────────────────────────────────
  if (!service.allowlisted) {
    return deny('SERVICE_NOT_ALLOWLISTED', serviceId, price, snapshot, snapshotAge,
      `Caller is not on the allowlist for service "${serviceId}". ` +
      'Contact the treasury owner to request access.',
    )
  }

  // ── Check 5: treasury pause state ────────────────────────────────────────────
  if (snapshot.paused) {
    return deny('TREASURY_PAUSED', serviceId, price, snapshot, snapshotAge,
      'The treasury contract is currently paused. ' +
      'No payments can be executed until the pauser unpauses the contract.',
    )
  }

  // ── Check 6: amount validity ─────────────────────────────────────────────────
  // The price comes from the catalogue (server-authoritative bigint).
  // We still validate it is positive and representable as a safe integer.
  if (price <= 0n) {
    return deny('INVALID_AMOUNT', serviceId, price, snapshot, snapshotAge,
      `Service "${serviceId}" has a zero or negative price in the catalogue. ` +
      'This indicates a catalogue configuration error — contact the operator.',
    )
  }

  // ── Check 7: per-transaction cap ─────────────────────────────────────────────
  if (snapshot.maxTxAmount > 0n && price > snapshot.maxTxAmount) {
    return deny('TX_LIMIT_EXCEEDED', serviceId, price, snapshot, snapshotAge,
      `Service price ${formatUsdc(price)} USDC exceeds the per-transaction cap ` +
      `of ${formatUsdc(snapshot.maxTxAmount)} USDC. ` +
      'The treasury owner must raise maxTxAmount or choose a lower-priced service.',
    )
  }

  // ── Check 8: global daily budget ─────────────────────────────────────────────
  if (snapshot.globalDailyLimit > 0n && price > snapshot.dailyRemainingGlobal) {
    return deny('DAILY_LIMIT_EXCEEDED', serviceId, price, snapshot, snapshotAge,
      `Service price ${formatUsdc(price)} USDC exceeds the remaining daily budget ` +
      `of ${formatUsdc(snapshot.dailyRemainingGlobal)} USDC ` +
      `(global daily limit: ${formatUsdc(snapshot.globalDailyLimit)} USDC). ` +
      'Wait for the daily window to reset or ask the owner to raise the global daily limit.',
    )
  }

  // ── Check 9: reserve / spendable floor ───────────────────────────────────────
  if (snapshot.spendableBalance === 0n) {
    return deny('INSUFFICIENT_FUNDS', serviceId, price, snapshot, snapshotAge,
      'The treasury has no spendable balance. ' +
      'All funds are locked in obligations or the reserve. ' +
      'Deposit more USDC or reduce obligations.',
    )
  }

  if (price > snapshot.spendableBalance) {
    return deny('RESERVE_BREACH', serviceId, price, snapshot, snapshotAge,
      `Service price ${formatUsdc(price)} USDC exceeds spendable balance ` +
      `of ${formatUsdc(snapshot.spendableBalance)} USDC. ` +
      'Executing this payment would breach the reserve floor. ' +
      'Deposit more USDC, reduce obligations, or lower the reserve basis points.',
    )
  }

  // ── Check 10: approval threshold ─────────────────────────────────────────────
  const autoApproveThreshold = BigInt(AUTO_APPROVE_THRESHOLD_BASE_UNITS)
  if (price > autoApproveThreshold) {
    const ctx = buildContext(serviceId, price, autoApproveThreshold, snapshot, snapshotAge)
    return {
      allowed: true,
      approvalRequired: true,
      reasonCode: 'APPROVAL_REQUIRED',
      explanation:
        `Service price ${formatUsdc(price)} USDC exceeds the auto-approve threshold ` +
        `of ${formatUsdc(autoApproveThreshold)} USDC. ` +
        'The treasury owner must manually approve this payment before funds move.',
      serviceId,
      priceBaseUnits: price,
      context: ctx,
      evaluatedAt: new Date().toISOString(),
    }
  }

  // ── All checks passed ─────────────────────────────────────────────────────────
  const ctx = buildContext(serviceId, price, autoApproveThreshold, snapshot, snapshotAge)
  return {
    allowed: true,
    approvalRequired: false,
    reasonCode: 'POLICY_OK',
    explanation:
      `Payment of ${formatUsdc(price)} USDC to service "${serviceId}" is within ` +
      'all policy limits. The contract remains the final enforcement boundary.',
    serviceId,
    priceBaseUnits: price,
    context: ctx,
    evaluatedAt: new Date().toISOString(),
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function deny(
  reasonCode: SpendingPolicyReasonCode,
  serviceId: string,
  priceBaseUnits: bigint,
  snapshot: ContractStateSnapshot,
  snapshotAge: number,
  explanation: string,
): SpendingPolicyResult {
  const autoApproveThreshold = BigInt(AUTO_APPROVE_THRESHOLD_BASE_UNITS)
  return {
    allowed: false,
    approvalRequired: false,
    reasonCode,
    explanation,
    serviceId,
    priceBaseUnits,
    context: buildContext(serviceId, priceBaseUnits, autoApproveThreshold, snapshot, snapshotAge),
    evaluatedAt: new Date().toISOString(),
  }
}

function buildContext(
  serviceId: string,
  priceBaseUnits: bigint,
  autoApproveThreshold: bigint,
  snapshot: ContractStateSnapshot,
  snapshotAge: number,
): SpendingPolicyContext {
  const service = findExtendedService(serviceId)
  return {
    serviceId,
    priceBaseUnits,
    priceDisplay: service?.priceDisplay ?? formatUsdc(priceBaseUnits),
    autoApproveThreshold,
    maxTxAmount: snapshot.maxTxAmount,
    globalDailyLimit: snapshot.globalDailyLimit,
    dailyRemainingGlobal: snapshot.dailyRemainingGlobal,
    spendableBalance: snapshot.spendableBalance,
    paused: snapshot.paused,
    snapshotAge,
  }
}

/** Format a bigint USDC base-unit amount as a decimal string, e.g. 1_000_000n → "1.000000" */
export function formatUsdc(amount: bigint): string {
  const abs = amount < 0n ? -amount : amount
  const sign = amount < 0n ? '-' : ''
  const whole = abs / 1_000_000n
  const frac = abs % 1_000_000n
  return `${sign}${whole}.${frac.toString().padStart(6, '0')}`
}
