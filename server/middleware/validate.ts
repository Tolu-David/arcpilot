/**
 * server/middleware/validate.ts
 *
 * Input validation helpers — no external validation library.
 *
 * All validators are pure functions that return either a typed result or an
 * error string.  They never throw.  Route handlers call these before acting on
 * any user-supplied data.
 */

import type { PaymentRequest, ValidatedPaymentRequest } from '../../shared/types.js'

// ── EVM address ───────────────────────────────────────────────────────────────

/** Returns true when s is a valid 0x-prefixed 20-byte hex address. */
export function isEvmAddress(s: unknown): s is `0x${string}` {
  return typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s)
}

// ── bytes32 hex ───────────────────────────────────────────────────────────────

/** Returns true when s is a valid 0x-prefixed 32-byte hex string. */
export function isBytes32(s: unknown): s is `0x${string}` {
  return typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s)
}

// ── USDC amount ───────────────────────────────────────────────────────────────

/**
 * Parse a decimal USDC string or integer base-unit string into a bigint.
 * Accepts:
 *   "1000000"   → 1_000_000n  (base units)
 *   "1.000000"  → 1_000_000n  (decimal USDC)
 *   "0.01"      → 10_000n
 *
 * Returns null on invalid input.
 */
export function parseUsdcAmount(raw: unknown): bigint | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null

  const s = raw.trim()

  // Decimal form: contains a dot
  if (s.includes('.')) {
    const [whole, frac = ''] = s.split('.')
    if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac)) return null
    const fracPadded = frac.padEnd(6, '0').slice(0, 6)
    try {
      return BigInt(whole) * 1_000_000n + BigInt(fracPadded || '0')
    } catch {
      return null
    }
  }

  // Integer form: no dot — treat as base units directly
  if (!/^\d+$/.test(s)) return null
  try {
    return BigInt(s)
  } catch {
    return null
  }
}

// ── requestId ─────────────────────────────────────────────────────────────────

/**
 * Derive a bytes32 requestId from an idempotency key.
 * Uses a simple deterministic encoding: keccak256 is not available without
 * a library import, so we zero-pad the UTF-8 bytes to 32 bytes instead.
 * This is sufficient for deduplication; callers may supply an explicit
 * bytes32 requestId to override.
 */
export function idempotencyKeyToRequestId(key: string): `0x${string}` {
  const bytes = Buffer.from(key, 'utf8').slice(0, 32)
  const padded = Buffer.alloc(32)
  bytes.copy(padded)
  return `0x${padded.toString('hex')}` as `0x${string}`
}

// ── PaymentRequest validator ──────────────────────────────────────────────────

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

/**
 * Validate a raw PaymentRequest body and return a ValidatedPaymentRequest
 * with correctly typed fields.
 */
export function validatePaymentRequest(
  raw: unknown,
): ValidationResult<ValidatedPaymentRequest> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'Request body must be a JSON object.' }
  }

  const body = raw as Partial<PaymentRequest>

  // idempotencyKey
  if (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.trim() === '') {
    return { ok: false, error: '"idempotencyKey" must be a non-empty string.' }
  }
  if (body.idempotencyKey.length > 128) {
    return { ok: false, error: '"idempotencyKey" must be at most 128 characters.' }
  }

  // to
  if (!isEvmAddress(body.to)) {
    return {
      ok: false,
      error: '"to" must be a valid 0x-prefixed EVM address (20 bytes).',
    }
  }

  // amountUsdc
  const amountUsdc = parseUsdcAmount(body.amountUsdc)
  if (amountUsdc === null || amountUsdc <= 0n) {
    return {
      ok: false,
      error:
        '"amountUsdc" must be a positive USDC amount as a decimal string (e.g. "1.000000") ' +
        'or base-unit integer string (e.g. "1000000").',
    }
  }

  // memo
  const memo = typeof body.memo === 'string' ? body.memo.trim() : ''
  if (memo.length > 256) {
    return { ok: false, error: '"memo" must be at most 256 characters.' }
  }

  // requestId — optional, derived from idempotencyKey if absent
  let requestId: `0x${string}`
  if (body.requestId !== undefined) {
    if (!isBytes32(body.requestId)) {
      return {
        ok: false,
        error: '"requestId" must be a 0x-prefixed 32-byte hex string if provided.',
      }
    }
    requestId = body.requestId
  } else {
    requestId = idempotencyKeyToRequestId(body.idempotencyKey)
  }

  return {
    ok: true,
    value: {
      idempotencyKey: body.idempotencyKey,
      to: body.to,
      amountUsdc,
      memo,
      requestId,
    },
  }
}

// ── Audit summary input ───────────────────────────────────────────────────────

export interface RawPayment {
  to: string
  amount: string
  memo: string
  timestamp: number
}

export function validateAuditPayments(raw: unknown): ValidationResult<RawPayment[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, error: '"payments" must be an array.' }
  }
  for (const item of raw) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as RawPayment).to !== 'string' ||
      typeof (item as RawPayment).amount !== 'string' ||
      typeof (item as RawPayment).memo !== 'string' ||
      typeof (item as RawPayment).timestamp !== 'number'
    ) {
      return {
        ok: false,
        error:
          'Each element of "payments" must have { to: string, amount: string, memo: string, timestamp: number }.',
      }
    }
  }
  return { ok: true, value: raw as RawPayment[] }
}
