/**
 * server/routes/agent.ts
 *
 * Route handlers for /api/agent/* endpoints.
 *
 * - Free endpoints: health, treasury-status
 * - Paid endpoints: recommend-spend, audit-summary
 *
 * Payment gating is applied per-route via the adapter's requirePayment()
 * middleware.  Route handlers never call blockchain methods directly — all
 * chain-derived data is either read from env vars or returned as static
 * references for the caller to resolve onchain.
 */

import { Router } from 'express'
import type { Request } from 'express'
import { getAdapter } from '../payment/adapter.js'
import { recommendFromContext } from '../policy.js'
import { CATALOGUE } from '../catalogue.js'
import { validateAuditPayments } from '../middleware/validate.js'

// Extended request carrying payment context injected by the adapter middleware.
type PaidRequest = Request & {
  payment?: {
    verified: boolean
    payer: string
    amount: string
    network: string
    transaction?: string
    simulated?: boolean
  }
}

export async function buildAgentRouter(): Promise<Router> {
  const router = Router()
  const adapter = await getAdapter()

  // ── GET /api/agent/health (free) ──────────────────────────────────────────
  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      adapterMode: adapter.mode,
      sellerAddress: process.env.SELLER_ADDRESS ?? null,
      network: adapter.mode === 'sim' ? 'simulation' : `Arc ${adapter.mode}`,
      catalogueSize: CATALOGUE.length,
    })
  })

  // ── GET /api/agent/treasury-status (free) ────────────────────────────────
  router.get('/treasury-status', (_req, res) => {
    res.json({
      contract: process.env.VITE_ARCPILOT_CONTRACT ?? null,
      chain: 'Arc Testnet',
      chainId: 5042002,
      usdcAddress: '0x3600000000000000000000000000000000000000', // arc-studio-allow-onchain-literal
      note: 'Call the contract directly for live balances. This endpoint returns static configuration only.',
    })
  })

  // ── POST /api/agent/recommend-spend (paid) ───────────────────────────────
  const recommendService = CATALOGUE.find(s => s.id === 'recommend-spend')!
  router.post(
    '/recommend-spend',
    adapter.requirePayment(recommendService.priceUsdc),
    (req: PaidRequest, res) => {
      const { payer = 'unknown', amount = '0', network = adapter.mode, simulated = false } =
        req.payment ?? {}

      const body = req.body as { context?: unknown }
      const context = typeof body.context === 'string' ? body.context : ''

      const recommendation = recommendFromContext(context)

      res.json({
        recommendation,
        paidBy: payer,
        amountBaseUnits: amount,
        network,
        simulated,
        timestamp: new Date().toISOString(),
      })
    },
  )

  // ── POST /api/agent/audit-summary (paid) ─────────────────────────────────
  const auditService = CATALOGUE.find(s => s.id === 'audit-summary')!
  router.post(
    '/audit-summary',
    adapter.requirePayment(auditService.priceUsdc),
    (req: PaidRequest, res) => {
      const { payer = 'unknown', amount = '0', network = adapter.mode, simulated = false } =
        req.payment ?? {}

      const body = req.body as { payments?: unknown }
      const validation = validateAuditPayments(body.payments ?? [])

      if (!validation.ok) {
        res.status(400).json({ error: 'INVALID_INPUT', message: validation.error })
        return
      }

      const payments = validation.value
      const totalBaseUnits = payments.reduce(
        (sum, p) => sum + (parseUsdcBaseUnits(p.amount) ?? 0n),
        0n,
      )
      const uniquePayees = new Set(payments.map(p => p.to)).size

      res.json({
        totalPayments: payments.length,
        totalUsdc: formatUsdc(totalBaseUnits),
        uniquePayees,
        summary:
          payments.length === 0
            ? 'No payments on record.'
            : `${payments.length} payment(s) totalling ${formatUsdc(totalBaseUnits)} USDC across ${uniquePayees} payee(s).`,
        paidBy: payer,
        amountBaseUnits: amount,
        network,
        simulated,
        timestamp: new Date().toISOString(),
      })
    },
  )

  return router
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseUsdcBaseUnits(s: string): bigint | null {
  try { return BigInt(s) } catch { return null }
}

function formatUsdc(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n
  const frac = baseUnits % 1_000_000n
  return `${whole}.${frac.toString().padStart(6, '0')}`
}
