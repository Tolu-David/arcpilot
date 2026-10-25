/**
 * server/routes/prepare.ts
 *
 * POST /api/prepare — payment preparation endpoint.
 *
 * Accepts a service ID and idempotency key, runs the full preparation
 * pipeline, and returns a PaymentPreparationReceipt.
 *
 * Security notes:
 *  - Only `serviceId`, `idempotencyKey`, and `memo` are accepted from the
 *    caller.  All monetary values, recipient addresses, and network parameters
 *    are resolved server-side.
 *  - The snapshot fields in the request body are provided by the caller
 *    (fetched from the chain in the browser/agent) and are validated before
 *    use.  The server rejects snapshots older than 60 seconds.
 *  - Body size is limited to 16 KB at the router level.
 */

import { Router } from 'express'
import { preparePayment } from '../payment-prepare.js'
import type { ContractStateSnapshot } from '../../shared/types.js'

// ── Snapshot validation ───────────────────────────────────────────────────────

/**
 * Validate and coerce the snapshot fields from the request body.
 *
 * All monetary fields arrive as decimal strings (JSON cannot represent bigint).
 * Returns null with a descriptive error string on validation failure.
 */
function parseSnapshot(raw: unknown): { snapshot: ContractStateSnapshot } | { error: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { error: '"snapshot" must be a JSON object.' }
  }
  const s = raw as Record<string, unknown>

  function parseBigIntField(name: string): bigint | null {
    const v = s[name]
    if (typeof v !== 'string' || !/^\d+$/.test(v)) return null
    try { return BigInt(v) } catch { return null }
  }

  function parseNumberField(name: string): number | null {
    const v = s[name]
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    return v
  }

  function parseBoolField(name: string): boolean | null {
    const v = s[name]
    return typeof v === 'boolean' ? v : null
  }

  const totalBalance = parseBigIntField('totalBalance')
  const activeObligationsTotal = parseBigIntField('activeObligationsTotal')
  const reserveAmount = parseBigIntField('reserveAmount')
  const spendableBalance = parseBigIntField('spendableBalance')
  const reserveBps = parseNumberField('reserveBps')
  const maxTxAmount = parseBigIntField('maxTxAmount')
  const globalDailyLimit = parseBigIntField('globalDailyLimit')
  const dailyRemainingGlobal = parseBigIntField('dailyRemainingGlobal')
  const paused = parseBoolField('paused')
  const fetchedAt = parseNumberField('fetchedAt')

  const missing = [
    totalBalance === null && 'totalBalance',
    activeObligationsTotal === null && 'activeObligationsTotal',
    reserveAmount === null && 'reserveAmount',
    spendableBalance === null && 'spendableBalance',
    reserveBps === null && 'reserveBps',
    maxTxAmount === null && 'maxTxAmount',
    globalDailyLimit === null && 'globalDailyLimit',
    dailyRemainingGlobal === null && 'dailyRemainingGlobal',
    paused === null && 'paused',
    fetchedAt === null && 'fetchedAt',
  ].filter(Boolean)

  if (missing.length > 0) {
    return {
      error:
        `"snapshot" is missing or has invalid fields: ${missing.join(', ')}. ` +
        'All monetary fields must be decimal integer strings; ' +
        'reserveBps and fetchedAt must be numbers; paused must be boolean.',
    }
  }

  return {
    snapshot: {
      totalBalance: totalBalance!,
      activeObligationsTotal: activeObligationsTotal!,
      reserveAmount: reserveAmount!,
      spendableBalance: spendableBalance!,
      reserveBps: reserveBps!,
      maxTxAmount: maxTxAmount!,
      globalDailyLimit: globalDailyLimit!,
      dailyRemainingGlobal: dailyRemainingGlobal!,
      paused: paused!,
      fetchedAt: fetchedAt!,
    },
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

export function buildPrepareRouter(): Router {
  const router = Router()

  // Tighter body limit for this route — preparation requests are small.
  router.use(express.json({ limit: '16kb' }))

  /**
   * POST /api/prepare
   *
   * Body: {
   *   serviceId:      string          (required)
   *   idempotencyKey: string          (required, max 128 chars)
   *   memo?:          string          (optional, max 128 chars)
   *   snapshot: {                     (required — fresh chain state)
   *     totalBalance:            string  (bigint as decimal string)
   *     activeObligationsTotal:  string
   *     reserveAmount:           string
   *     spendableBalance:        string
   *     reserveBps:              number
   *     maxTxAmount:             string
   *     globalDailyLimit:        string
   *     dailyRemainingGlobal:    string
   *     paused:                  boolean
   *     fetchedAt:               number  (Unix ms)
   *   }
   * }
   *
   * Returns:
   *   200  PaymentPreparationReceipt   (or cached receipt with `cached: true`)
   *   400  INVALID_REQUEST             (schema error, malformed snapshot, stale state)
   *   404  SERVICE_NOT_FOUND
   *   409  IDEMPOTENCY_KEY_CONFLICT    (key reused with different payload)
   *   422  POLICY_DENIED               (deterministic policy rejection)
   */
  router.post('/', (req, res): void => {
    const body = req.body as Record<string, unknown>

    // ── Validate top-level required fields ──────────────────────────────────
    if (typeof body.serviceId !== 'string' || body.serviceId.trim() === '') {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: '"serviceId" is required and must be a non-empty string.',
      })
      return
    }

    if (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.trim() === '') {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: '"idempotencyKey" is required and must be a non-empty string.',
      })
      return
    }

    // ── Validate and coerce snapshot ────────────────────────────────────────
    const snapshotResult = parseSnapshot(body.snapshot)
    if ('error' in snapshotResult) {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: snapshotResult.error,
      })
      return
    }

    // ── Run the preparation pipeline ────────────────────────────────────────
    const outcome = preparePayment(
      {
        serviceId: body.serviceId as string,
        idempotencyKey: body.idempotencyKey as string,
        memo: typeof body.memo === 'string' ? body.memo : undefined,
      },
      snapshotResult.snapshot,
    )

    if (!outcome.ok) {
      const httpStatus = httpStatusForCode(outcome.code)
      res.status(httpStatus).json({
        error: outcome.code,
        message: outcome.message,
        ...(outcome.details ? { details: outcome.details } : {}),
      })
      return
    }

    res.status(200).json(outcome.receipt)
  })

  return router
}

// Import express here to access the json body-parser for the route-level limit.
import express from 'express'

function httpStatusForCode(code: string): number {
  switch (code) {
    case 'INVALID_REQUEST':
    case 'STALE_STATE':      return 400
    case 'SERVICE_NOT_FOUND': return 404
    case 'IDEMPOTENCY_KEY_CONFLICT': return 409
    case 'POLICY_DENIED':    return 422
    default:                 return 500
  }
}
