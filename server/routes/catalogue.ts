/**
 * server/routes/catalogue.ts
 *
 * Read-only service catalogue endpoints plus the service request workflow.
 *
 * GET  /api/catalogue            — full extended catalogue
 * GET  /api/catalogue/:id        — single service by id
 * POST /api/catalogue/request/:id — initiate a validated service request
 *
 * The catalogue is the authoritative source for endpoint paths, prices,
 * recipient addresses, and availability.  Clients must always read from here;
 * they must never supply or override prices or recipients.
 */

import { Router } from 'express'
import { randomUUID } from 'crypto'
import {
  EXTENDED_CATALOGUE,
  findExtendedService,
  validateServiceRequest,
  AUTO_APPROVE_THRESHOLD_BASE_UNITS,
} from '../catalogue.js'
import { evaluateSpendingPolicy } from '../spending-policy.js'
import {
  getAiRecommendation,
  buildRecommendationResponse,
  AiUnavailableError,
  MAX_INTENT_CHARS,
} from '../ai-recommend.js'
import type {
  ServiceRequestResult,
  SpendingPolicyRequest,
  ContractStateSnapshot,
} from '../../shared/types.js'
import { validateSnapshotPlausibility } from '../snapshot-validation.js'

export function buildCatalogueRouter(): Router {
  const router = Router()

  // ── GET /api/catalogue ─────────────────────────────────────────────────────
  router.get('/', (_req, res) => {
    res.json({
      services: EXTENDED_CATALOGUE,
      count: EXTENDED_CATALOGUE.length,
      autoApproveThresholdBaseUnits: AUTO_APPROVE_THRESHOLD_BASE_UNITS,
    })
  })

  // ── GET /api/catalogue/:id ─────────────────────────────────────────────────
  // Must be declared BEFORE /request/:id to avoid ambiguous routing.
  router.get('/:id', (req, res) => {
    // Guard: don't accidentally match "request" as an ID for GET
    if (req.params.id === 'request') {
      res.status(404).json({ error: 'SERVICE_NOT_FOUND', message: 'Use POST /api/catalogue/request/:id.' })
      return
    }
    const service = findExtendedService(req.params.id)
    if (!service) {
      res.status(404).json({
        error: 'SERVICE_NOT_FOUND',
        message: `No service with id "${req.params.id}". GET /api/catalogue for the full list.`,
      })
      return
    }
    res.json(service)
  })

  // ── POST /api/catalogue/request/:id ───────────────────────────────────────
  //
  // Validates a service request server-side and returns a ServiceRequestResult.
  // The server controls price and recipient — the browser supplies only the
  // service ID and an optional caller context string.
  //
  // This endpoint does NOT transfer funds.  It validates policy and returns an
  // accepted/denied result the frontend uses to drive its UI.  Actual payment
  // would happen via the adapter layer in a separate follow-up call.
  router.post('/request/:id', (req, res) => {
    const serviceId = req.params.id as string

    const validation = validateServiceRequest(serviceId)

    if (!validation.ok) {
      const denied: ServiceRequestResult = {
        accepted: false,
        requestRef: randomUUID(),
        serviceId,
        priceBaseUnits: 0,
        denialReason: validation.reason,
        denialCode: validation.code,
        timestamp: new Date().toISOString(),
      }
      const status = validation.code === 'INVALID_SERVICE' ? 400 : 403
      res.status(status).json(denied)
      return
    }

    const { service } = validation

    // Approval-required: accepted but not auto-executable
    const accepted = service.availability !== 'unavailable'

    const result: ServiceRequestResult = {
      accepted,
      requestRef: randomUUID(),
      serviceId: service.id,
      priceBaseUnits: service.priceBaseUnits,
      ...(service.availability === 'approval-required'
        ? {
            denialCode: 'APPROVAL_REQUIRED',
            denialReason:
              `This service costs ${service.priceDisplay} USDC, which exceeds the ` +
              `auto-approve threshold. Owner approval is required before funds move.`,
          }
        : {}),
      timestamp: new Date().toISOString(),
    }

    res.json(result)
  })

  // ── POST /api/catalogue/evaluate ──────────────────────────────────────────
  //
  // Deterministic spending-policy evaluation.
  //
  // Request body:
  //   { serviceId: string, snapshot: ContractStateSnapshot }
  //
  // The caller must supply a fresh ContractStateSnapshot fetched directly
  // from the RPC before calling this endpoint.  The server validates the
  // snapshot age and evaluates all policy checks server-side.
  //
  // The browser must NEVER supply a price or recipient — those are resolved
  // from the server catalogue using only the serviceId.
  //
  // Monetary values in the snapshot are transmitted as decimal strings (JSON
  // cannot represent bigint natively) and coerced to bigint here.
  router.post('/evaluate', (req, res) => {
    const { serviceId, snapshot: rawSnapshot } = req.body as {
      serviceId?: unknown
      snapshot?: Record<string, unknown>
    }

    // Validate serviceId type
    if (typeof serviceId !== 'string') {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'Body must include { serviceId: string, snapshot: ContractStateSnapshot }.',
      })
      return
    }

    // Validate snapshot presence
    if (!rawSnapshot || typeof rawSnapshot !== 'object') {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'Body must include a snapshot object with fresh contract state.',
      })
      return
    }

    // Coerce snapshot monetary fields from decimal strings to bigint.
    // Reject any field that cannot be parsed as a non-negative integer string.
    let snapshot: ContractStateSnapshot
    try {
      const bigintField = (key: string): bigint => {
        const v = rawSnapshot[key]
        if (v === undefined || v === null) throw new Error(`Missing snapshot field: ${key}`)
        const s = String(v)
        if (!/^\d+$/.test(s)) throw new Error(`snapshot.${key} must be a non-negative integer string, got: ${s}`)
        return BigInt(s)
      }
      const numField = (key: string): number => {
        const v = rawSnapshot[key]
        const n = Number(v)
        if (!Number.isFinite(n)) throw new Error(`snapshot.${key} must be a finite number`)
        return n
      }
      const boolField = (key: string): boolean => {
        const v = rawSnapshot[key]
        if (typeof v !== 'boolean') throw new Error(`snapshot.${key} must be a boolean`)
        return v
      }

      snapshot = {
        totalBalance:           bigintField('totalBalance'),
        activeObligationsTotal: bigintField('activeObligationsTotal'),
        reserveAmount:          bigintField('reserveAmount'),
        spendableBalance:       bigintField('spendableBalance'),
        reserveBps:             numField('reserveBps'),
        maxTxAmount:            bigintField('maxTxAmount'),
        globalDailyLimit:       bigintField('globalDailyLimit'),
        dailyRemainingGlobal:   bigintField('dailyRemainingGlobal'),
        paused:                 boolField('paused'),
        fetchedAt:              numField('fetchedAt'),
      }
    } catch (err: unknown) {
      res.status(400).json({
        error: 'INVALID_SNAPSHOT',
        message: err instanceof Error ? err.message : 'snapshot fields are malformed.',
      })
      return
    }

    // [security fix M-4] Reject implausible snapshot values.
    const plausibilityErr = validateSnapshotPlausibility(snapshot)
    if (plausibilityErr) {
      res.status(400).json({ error: 'IMPLAUSIBLE_SNAPSHOT', message: plausibilityErr.message })
      return
    }

    const policyRequest: SpendingPolicyRequest = { serviceId }
    const result = evaluateSpendingPolicy(policyRequest, snapshot)

    // Serialise bigint fields as decimal strings for JSON transport.
    res.json({
      ...result,
      priceBaseUnits: result.priceBaseUnits.toString(),
      context: {
        ...result.context,
        priceBaseUnits:       result.context.priceBaseUnits.toString(),
        autoApproveThreshold: result.context.autoApproveThreshold.toString(),
        maxTxAmount:          result.context.maxTxAmount.toString(),
        globalDailyLimit:     result.context.globalDailyLimit.toString(),
        dailyRemainingGlobal: result.context.dailyRemainingGlobal.toString(),
        spendableBalance:     result.context.spendableBalance.toString(),
      },
    })
  })

  // ── POST /api/catalogue/recommend ─────────────────────────────────────────
  //
  // Returns a deterministic spending-policy result plus an AI advisory
  // recommendation for a proposed payment.
  //
  // Security contract:
  //  - serviceId is validated against the server catalogue.
  //  - Price and recipient are resolved server-side — never from the request body.
  //  - userIntent is treated as UNTRUSTED DATA: length-capped and passed to the
  //    AI model labelled as untrusted.  It is never used to set policy values.
  //  - The AI recommendation is ADVISORY ONLY.  A policy denial is never overridden.
  //  - When AI is unavailable the deterministic policy result is returned unchanged
  //    with aiRecommendation=null and a typed aiError.
  //
  // Request body: { serviceId: string, userIntent: string, snapshot: ContractStateSnapshot }
  // Response:     RecommendationResponse (bigints as decimal strings)
  router.post('/recommend', async (req, res) => {
    const { serviceId, userIntent, snapshot: rawSnapshot } = req.body as {
      serviceId?: unknown
      userIntent?: unknown
      snapshot?: Record<string, unknown>
    }

    // ── Validate serviceId ───────────────────────────────────────────────────
    if (typeof serviceId !== 'string' || !/^[a-z0-9-]+$/.test(serviceId)) {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'serviceId must be a lowercase alphanumeric-with-hyphens string.',
      })
      return
    }

    if (!findExtendedService(serviceId)) {
      res.status(404).json({
        error: 'SERVICE_NOT_FOUND',
        message: `No service with id "${serviceId}". GET /api/catalogue for the full list.`,
      })
      return
    }

    // ── Validate userIntent ──────────────────────────────────────────────────
    if (typeof userIntent !== 'string') {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'userIntent must be a string.',
      })
      return
    }
    if (userIntent.length > MAX_INTENT_CHARS) {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: `userIntent must be at most ${MAX_INTENT_CHARS} characters.`,
      })
      return
    }

    // ── Validate snapshot ────────────────────────────────────────────────────
    if (!rawSnapshot || typeof rawSnapshot !== 'object') {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'snapshot must be an object containing fresh contract state.',
      })
      return
    }

    let snapshot: ContractStateSnapshot
    try {
      const bigintField = (key: string): bigint => {
        const v = rawSnapshot[key]
        if (v === undefined || v === null) throw new Error(`Missing snapshot field: ${key}`)
        const s = String(v)
        if (!/^\d+$/.test(s)) throw new Error(`snapshot.${key} must be a non-negative integer string`)
        return BigInt(s)
      }
      const numField = (key: string): number => {
        const v = rawSnapshot[key]
        const n = Number(v)
        if (!Number.isFinite(n)) throw new Error(`snapshot.${key} must be a finite number`)
        return n
      }
      const boolField = (key: string): boolean => {
        const v = rawSnapshot[key]
        if (typeof v !== 'boolean') throw new Error(`snapshot.${key} must be a boolean`)
        return v
      }
      snapshot = {
        totalBalance:           bigintField('totalBalance'),
        activeObligationsTotal: bigintField('activeObligationsTotal'),
        reserveAmount:          bigintField('reserveAmount'),
        spendableBalance:       bigintField('spendableBalance'),
        reserveBps:             numField('reserveBps'),
        maxTxAmount:            bigintField('maxTxAmount'),
        globalDailyLimit:       bigintField('globalDailyLimit'),
        dailyRemainingGlobal:   bigintField('dailyRemainingGlobal'),
        paused:                 boolField('paused'),
        fetchedAt:              numField('fetchedAt'),
      }
    } catch (err: unknown) {
      res.status(400).json({
        error: 'INVALID_SNAPSHOT',
        message: err instanceof Error ? err.message : 'snapshot fields are malformed.',
      })
      return
    }

    // [security fix M-4] Reject implausible snapshot values.
    const plausibilityErrR = validateSnapshotPlausibility(snapshot)
    if (plausibilityErrR) {
      res.status(400).json({ error: 'IMPLAUSIBLE_SNAPSHOT', message: plausibilityErrR.message })
      return
    }

    // ── Deterministic policy evaluation (always runs, never skipped) ─────────
    const policyRequest: SpendingPolicyRequest = { serviceId }
    const policyResult = evaluateSpendingPolicy(policyRequest, snapshot)

    // ── AI advisory recommendation (best-effort, never gates policy) ─────────
    let aiResult: Awaited<ReturnType<typeof getAiRecommendation>> | AiUnavailableError
    try {
      aiResult = await getAiRecommendation(serviceId, String(userIntent), policyResult)
    } catch (err: unknown) {
      aiResult = err instanceof AiUnavailableError
        ? err
        : new AiUnavailableError('AI_PROVIDER_ERROR', err instanceof Error ? err.message : String(err))
    }

    // ── Build and serialise response ─────────────────────────────────────────
    const response = buildRecommendationResponse(serviceId, policyResult, aiResult)

    res.json({
      ...response,
      // policy bigints are already strings inside buildRecommendationResponse,
      // but priceBaseUnits is already a string there too.
    })
  })

  return router
}
