/**
 * server/index.ts
 *
 * ArcPilot API server entry point.
 *
 * Mounts all route modules and applies shared middleware.  Business logic
 * lives in routes/, catalogue.ts, policy.ts, and payment/ — not here.
 *
 * Start:  bun run server
 * Env:    see env.example for all supported variables
 */

import express from 'express'
import { buildAgentRouter } from './routes/agent.js'
import { buildCatalogueRouter } from './routes/catalogue.js'
import { buildPaymentsRouter } from './routes/payments.js'
import { buildPrepareRouter } from './routes/prepare.js'
import { seedDemoPayments } from './payment-log.js'

const PORT = process.env.AGENT_SERVER_PORT ? parseInt(process.env.AGENT_SERVER_PORT) : 3001

async function main() {
  const app = express()

  // ── Body parsing ──────────────────────────────────────────────────────────
  app.use(express.json({ limit: '64kb' }))

  // ── CORS ──────────────────────────────────────────────────────────────────
  // [security fix H-3] Restrict to a specific origin rather than wildcard '*'.
  // Set ALLOWED_ORIGIN in your environment for production deployments.
  // Use ALLOWED_ORIGIN=* only when running behind a trusted API gateway that
  // enforces its own origin policy.
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? 'http://localhost:5173'
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
    res.setHeader(
      'Access-Control-Allow-Headers',
      'content-type,x-payment,payment-required,x-idempotency-key,x-arcpilot-token',
    )
    res.setHeader(
      'Access-Control-Expose-Headers',
      'payment-required,x-payment,x-idempotency-key',
    )
    if (_req.method === 'OPTIONS') {
      res.sendStatus(204)
      return
    }
    next()
  })

  // ── Request logging (minimal, no PII) ────────────────────────────────────
  app.use((req, _res, next) => {
    console.log(`[ArcPilot] ${req.method} ${req.path}`)
    next()
  })

  // ── Routes ────────────────────────────────────────────────────────────────
  // Catalogue is built synchronously; agent router is async (adapter init).
  app.use('/api/catalogue', buildCatalogueRouter())
  app.use('/api/agent', await buildAgentRouter())
  app.use('/api/payments', buildPaymentsRouter())
  app.use('/api/prepare', buildPrepareRouter())

  // Seed demo records in development so the payment history UI is never blank.
  if (process.env.NODE_ENV !== 'production') {
    const contract = process.env.VITE_ARCPILOT_CONTRACT ?? 'unknown-contract'
    seedDemoPayments(contract)
  }

  // ── 404 handler ───────────────────────────────────────────────────────────
  app.use((req, res) => {
    res.status(404).json({
      error: 'NOT_FOUND',
      message: `${req.method} ${req.path} is not a recognised endpoint. GET /api/catalogue for available services.`,
    })
  })

  // ── Error handler ─────────────────────────────────────────────────────────
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[ArcPilot] Unhandled error:', err)
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    })
  })

  app.listen(PORT, () => {
    const adapterMode = process.env.PAYMENT_ADAPTER ?? 'sim'
    console.log(`[ArcPilot] Server listening on port ${PORT}`)
    console.log(`[ArcPilot] Payment adapter: ${adapterMode}`)
    console.log(`[ArcPilot] GET http://localhost:${PORT}/api/catalogue  for available services`)
  })
}

main().catch((err) => {
  console.error('[ArcPilot] Fatal startup error:', err)
  process.exit(1)
})
