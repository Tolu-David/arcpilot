/**
 * server/routes/payments.ts
 *
 * Payment history and audit endpoints.
 *
 * READ endpoints (no auth required in demo; gate in production):
 *   GET  /api/payments              — paginated off-chain log
 *   GET  /api/payments/:id          — single record
 *   GET  /api/payments/:id/audit    — full AuditRecord view
 *
 * WRITE endpoints (require X-ArcPilot-Token header):
 *   POST /api/payments/:id/submitted  — record tx hash; mark Submitted
 *   POST /api/payments/:id/confirmed  — record verification; mark Confirmed
 *   POST /api/payments/:id/reverted   — mark Reverted
 *   POST /api/payments/:id/unknown    — mark Unknown (retain tx hash)
 *   POST /api/payments/:id/delivery   — update service delivery status
 *
 * PRIVILEGED endpoints (require X-ArcPilot-Token):
 *   POST /api/payments/reconcile    — trigger a reconciliation pass
 *
 * Authorization:
 *   Write and privileged endpoints require the X-ArcPilot-Token header.
 *   In development (no ARCPILOT_WRITE_TOKEN set), any non-empty token passes.
 *   In production, set ARCPILOT_WRITE_TOKEN in the environment.
 */

import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import {
  listPayments,
  getPayment,
  markSubmitted,
  markConfirmed,
  markReverted,
  markUnknown,
  updatePayment,
  toAuditRecord,
  findByTxHash,
  findByRequestId,
} from '../payment-log.js'
import { runReconciliationPass } from '../reconciler.js'
import type { ServiceDeliveryStatus, VerifiedEventSummary, PaymentErrorCategory } from '../../shared/types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function str(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0] as string
  return null
}

// ── Auth middleware ───────────────────────────────────────────────────────────

const WRITE_TOKEN = process.env.ARCPILOT_WRITE_TOKEN ?? ''

function requireWriteToken(req: Request, res: Response, next: NextFunction): void {
  const provided = str(req.headers['x-arcpilot-token'])
  if (!provided) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Write endpoints require the X-ArcPilot-Token header.',
    })
    return
  }
  if (WRITE_TOKEN !== '' && provided !== WRITE_TOKEN) {
    res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Invalid X-ArcPilot-Token.',
    })
    return
  }
  next()
}

// ── Router ────────────────────────────────────────────────────────────────────

export function buildPaymentsRouter(): Router {
  const router = Router()

  // ── GET /api/payments ──────────────────────────────────────────────────────
  router.get('/', (req, res) => {
    const page = parseInt(String(req.query['page'] ?? '1'), 10)
    const pageSize = parseInt(String(req.query['pageSize'] ?? '10'), 10)

    if (isNaN(page) || page < 1) {
      res.status(400).json({ error: 'INVALID_PAGE', message: 'page must be a positive integer.' })
      return
    }
    if (isNaN(pageSize) || pageSize < 1 || pageSize > 100) {
      res.status(400).json({
        error: 'INVALID_PAGE_SIZE',
        message: 'pageSize must be between 1 and 100.',
      })
      return
    }

    res.json(listPayments(page, pageSize))
  })

  // ── Lookup by txHash / requestId (must come before /:id routes) ───────────
  router.get('/by-tx/:txHash', (req, res) => {
    const p = req.params as Record<string, string>
    const record = findByTxHash(p['txHash'] ?? '')
    if (!record) {
      res.status(404).json({ error: 'RECORD_NOT_FOUND', message: `No record for tx ${p['txHash']}.` })
      return
    }
    res.json(record)
  })

  router.get('/by-request/:requestId', (req, res) => {
    const p = req.params as Record<string, string>
    const record = findByRequestId(p['requestId'] ?? '')
    if (!record) {
      res.status(404).json({ error: 'RECORD_NOT_FOUND', message: `No record for requestId ${p['requestId']}.` })
      return
    }
    res.json(record)
  })

  // ── POST /api/payments/reconcile ──────────────────────────────────────────
  router.post('/reconcile', requireWriteToken, async (_req, res) => {
    const stubFetcher = async (txHash: `0x${string}`) => {
      const { ReceiptFetchTimeoutError } = await import('../reconciler.js')
      throw new ReceiptFetchTimeoutError(txHash)
    }

    try {
      const result = await runReconciliationPass(stubFetcher)
      res.json(result)
    } catch (err) {
      res.status(500).json({
        error: 'RECONCILIATION_ERROR',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // ── GET /api/payments/:id ─────────────────────────────────────────────────
  router.get('/:id', (req, res) => {
    const id = (req.params as Record<string, string>)['id'] ?? ''
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'INVALID_ID', message: 'Payment ID must be a UUID.' })
      return
    }
    const record = getPayment(id)
    if (!record) {
      res.status(404).json({ error: 'RECORD_NOT_FOUND', message: `No payment record with id "${id}".` })
      return
    }
    res.json(record)
  })

  // ── GET /api/payments/:id/audit ────────────────────────────────────────────
  router.get('/:id/audit', (req, res) => {
    const id = (req.params as Record<string, string>)['id'] ?? ''
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'INVALID_ID', message: 'Payment ID must be a UUID.' })
      return
    }
    const record = getPayment(id)
    if (!record) {
      res.status(404).json({ error: 'RECORD_NOT_FOUND', message: `No payment record with id "${id}".` })
      return
    }
    res.json(toAuditRecord(record))
  })

  // ── POST /api/payments/:id/submitted ──────────────────────────────────────
  router.post('/:id/submitted', requireWriteToken, (req, res) => {
    const id = (req.params as Record<string, string>)['id'] ?? ''
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'INVALID_ID', message: 'Payment ID must be a UUID.' })
      return
    }

    const body = req.body as Record<string, unknown>
    const txHash = str(body['txHash'])
    const actorAddress = str(body['actorAddress']) ?? undefined

    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: '"txHash" must be a 0x-prefixed 64-hex-char bytes32 string.',
      })
      return
    }

    const existing = findByTxHash(txHash)
    if (existing && existing.id !== id) {
      res.status(409).json({
        error: 'DUPLICATE_TX_HASH',
        message: `Transaction hash ${txHash} is already recorded for payment ${existing.id}.`,
      })
      return
    }

    const ok = markSubmitted(id, txHash, actorAddress)
    if (!ok) {
      res.status(404).json({ error: 'RECORD_NOT_FOUND', message: `No payment record with id "${id}".` })
      return
    }
    res.json({ ok: true, id, flowState: 'Submitted' })
  })

  // ── POST /api/payments/:id/confirmed ──────────────────────────────────────
  router.post('/:id/confirmed', requireWriteToken, (req, res) => {
    const id = (req.params as Record<string, string>)['id'] ?? ''
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'INVALID_ID', message: 'Payment ID must be a UUID.' })
      return
    }

    const body = req.body as Record<string, unknown>
    const txHash               = str(body['txHash'])
    const blockNumber          = str(body['blockNumber'])
    const eventRecipient       = str(body['eventRecipient'])
    const eventAmountBaseUnits = str(body['eventAmountBaseUnits'])
    const eventRequestId       = str(body['eventRequestId'])
    const transferVerified     = body['transferVerified']
    const verifiedAt           = str(body['verifiedAt'])

    if (!txHash || !blockNumber || !eventRecipient || !eventAmountBaseUnits ||
        !eventRequestId || typeof transferVerified !== 'boolean' || !verifiedAt) {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'Body must be a VerifiedEventSummary with all required fields.',
      })
      return
    }

    const record = getPayment(id)
    if (!record) {
      res.status(404).json({ error: 'RECORD_NOT_FOUND', message: `No payment record with id "${id}".` })
      return
    }

    if (eventRequestId.toLowerCase() !== record.requestId.toLowerCase()) {
      res.status(422).json({
        error: 'REQUEST_ID_MISMATCH',
        message: `Event requestId ${eventRequestId} does not match record requestId ${record.requestId}.`,
      })
      return
    }

    const summary: VerifiedEventSummary = {
      txHash, blockNumber, eventRecipient, eventAmountBaseUnits,
      eventRequestId, transferVerified, verifiedAt,
    }

    const ok = markConfirmed(id, summary, blockNumber)
    if (!ok) {
      res.status(404).json({ error: 'RECORD_NOT_FOUND', message: `No payment record with id "${id}".` })
      return
    }
    res.json({ ok: true, id, flowState: 'Confirmed' })
  })

  // ── POST /api/payments/:id/reverted ───────────────────────────────────────
  router.post('/:id/reverted', requireWriteToken, (req, res) => {
    const id = (req.params as Record<string, string>)['id'] ?? ''
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'INVALID_ID', message: 'Payment ID must be a UUID.' })
      return
    }

    const body = req.body as Record<string, unknown>
    const txHash      = str(body['txHash'])
    const blockNumber = str(body['blockNumber'])

    if (!txHash || !blockNumber) {
      res.status(400).json({ error: 'INVALID_REQUEST', message: '"txHash" and "blockNumber" are required.' })
      return
    }

    const ok = markReverted(id, txHash, blockNumber)
    if (!ok) {
      res.status(404).json({ error: 'RECORD_NOT_FOUND', message: `No payment record with id "${id}".` })
      return
    }
    res.json({ ok: true, id, flowState: 'Reverted' })
  })

  // ── POST /api/payments/:id/unknown ────────────────────────────────────────
  router.post('/:id/unknown', requireWriteToken, (req, res) => {
    const id = (req.params as Record<string, string>)['id'] ?? ''
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'INVALID_ID', message: 'Payment ID must be a UUID.' })
      return
    }

    const body = req.body as Record<string, unknown>
    const txHash        = str(body['txHash'])
    const errorCategory = (str(body['errorCategory']) ?? 'unknown') as PaymentErrorCategory

    if (!txHash) {
      res.status(400).json({ error: 'INVALID_REQUEST', message: '"txHash" is required.' })
      return
    }

    const ok = markUnknown(id, txHash, errorCategory)
    if (!ok) {
      res.status(404).json({ error: 'RECORD_NOT_FOUND', message: `No payment record with id "${id}".` })
      return
    }
    res.json({ ok: true, id, flowState: 'Unknown', errorCategory })
  })

  // ── POST /api/payments/:id/delivery ───────────────────────────────────────
  router.post('/:id/delivery', requireWriteToken, (req, res) => {
    const id = (req.params as Record<string, string>)['id'] ?? ''
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'INVALID_ID', message: 'Payment ID must be a UUID.' })
      return
    }

    const body = req.body as Record<string, unknown>
    const deliveryStatus = str(body['deliveryStatus'])
    const valid: ServiceDeliveryStatus[] = ['not-requested', 'pending', 'succeeded', 'failed', 'unknown']

    if (!deliveryStatus || !valid.includes(deliveryStatus as ServiceDeliveryStatus)) {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: `"deliveryStatus" must be one of: ${valid.join(', ')}.`,
      })
      return
    }

    const ok = updatePayment(id, { deliveryStatus: deliveryStatus as ServiceDeliveryStatus })
    if (!ok) {
      res.status(404).json({ error: 'RECORD_NOT_FOUND', message: `No payment record with id "${id}".` })
      return
    }
    res.json({ ok: true, id, deliveryStatus })
  })

  return router
}
