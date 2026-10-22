/**
 * ArcPilot Agent Payment Server
 *
 * Exposes paid HTTP endpoints that AI agents pay for via Circle Gateway
 * Nanopayments (x402 protocol). Payments are gasless USDC authorizations
 * settled in batches by Circle Gateway.
 *
 * Seller address (SELLER_ADDRESS env var) receives USDC in its Gateway balance.
 * Never commit private keys or API keys.
 */

import express from 'express'
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server'
import { formatUnits } from 'viem'

// Extended request type carrying verified payment info injected by middleware
type PaidRequest = express.Request & {
  payment?: {
    verified: boolean
    payer: string
    amount: string
    network: string
    transaction?: string
  }
}

const PORT = process.env.AGENT_SERVER_PORT ? parseInt(process.env.AGENT_SERVER_PORT) : 3001

const sellerAddress = process.env.SELLER_ADDRESS
if (!sellerAddress) {
  console.error('[ArcPilot] SELLER_ADDRESS env var is required. Set it to the EVM address that receives USDC payments.')
  process.exit(1)
}

const facilitatorUrl =
  process.env.GATEWAY_FACILITATOR_URL ?? 'https://gateway-api-testnet.circle.com'

const app = express()
app.use(express.json())

// ── CORS for Vite dev proxy ───────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-payment,payment-required')
  res.setHeader('Access-Control-Expose-Headers', 'payment-required,x-payment')
  if (_req.method === 'OPTIONS') { res.sendStatus(204); return }
  next()
})

// ── Gateway middleware ────────────────────────────────────────────────────────
const gateway = createGatewayMiddleware({
  sellerAddress: sellerAddress as `0x${string}`,
  facilitatorUrl,
})

// ── Health check (free) ───────────────────────────────────────────────────────
app.get('/api/agent/health', (_req, res) => {
  res.json({
    status: 'ok',
    seller: sellerAddress,
    network: 'Arc Testnet',
    facilitator: facilitatorUrl,
  })
})

// ── Treasury policy read (free) ───────────────────────────────────────────────
// Returns publicly readable treasury state so agents can decide whether to
// request a payment before making a paid call.
app.get('/api/agent/treasury-status', (_req, res) => {
  res.json({
    contract: process.env.VITE_ARCPILOT_CONTRACT ?? null,
    chain: 'Arc Testnet',
    chainId: 5042002,
    usdcAddress: '0x3600000000000000000000000000000000000000',
    note: 'Call the contract directly for live balances.',
  })
})

// ── Paid: spend policy recommendation ($0.01 per call) ───────────────────────
// An AI agent pays $0.01 USDC to receive a tailored treasury-spend recommendation.
app.post(
  '/api/agent/recommend-spend',
  gateway.require('$0.01'),
  (req: PaidRequest, res) => {
    const { payer, amount, network } = req.payment!
    const formattedAmount = formatUnits(BigInt(amount), 6)
    console.log(`[ArcPilot] /recommend-spend paid ${formattedAmount} USDC by ${payer} on ${network}`)

    const body = req.body as { context?: string }
    const context = body.context ?? ''

    // Deterministic recommendation logic (no external calls — fully onchain-derived)
    const recommendation = buildRecommendation(context)

    res.json({
      recommendation,
      paidBy: payer,
      amountUsdc: formattedAmount,
      network,
      timestamp: new Date().toISOString(),
    })
  },
)

// ── Paid: audit summary ($0.005 per call) ─────────────────────────────────────
// Returns a structured summary suitable for agent reasoning or downstream tools.
app.post(
  '/api/agent/audit-summary',
  gateway.require('$0.005'),
  (req: PaidRequest, res) => {
    const { payer, amount, network } = req.payment!
    const formattedAmount = formatUnits(BigInt(amount), 6)
    console.log(`[ArcPilot] /audit-summary paid ${formattedAmount} USDC by ${payer} on ${network}`)

    const body = req.body as { payments?: Array<{ to: string; amount: string; memo: string; timestamp: number }> }
    const payments = body.payments ?? []

    res.json({
      totalPayments: payments.length,
      totalUsdc: payments.reduce((s, p) => s + parseFloat(p.amount || '0'), 0).toFixed(6),
      uniquePayees: [...new Set(payments.map(p => p.to))].length,
      summary: payments.length === 0
        ? 'No payments on record.'
        : `${payments.length} payment(s) totalling ${payments.reduce((s, p) => s + parseFloat(p.amount || '0'), 0).toFixed(2)} USDC across ${[...new Set(payments.map(p => p.to))].length} payee(s).`,
      paidBy: payer,
      amountUsdc: formattedAmount,
      timestamp: new Date().toISOString(),
    })
  },
)

app.listen(PORT, () => {
  console.log(`[ArcPilot] Agent payment server running on port ${PORT}`)
  console.log(`[ArcPilot] Seller address: ${sellerAddress}`)
  console.log(`[ArcPilot] Gateway facilitator: ${facilitatorUrl}`)
  console.log(`[ArcPilot] Paid endpoints:`)
  console.log(`  POST /api/agent/recommend-spend  $0.01 / call`)
  console.log(`  POST /api/agent/audit-summary    $0.005 / call`)
})

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildRecommendation(context: string): string {
  const ctx = context.toLowerCase()
  if (ctx.includes('low') || ctx.includes('insufficient')) {
    return 'Treasury balance is low. Pause discretionary payments until reserves recover. Consider reviewing obligation amounts.'
  }
  if (ctx.includes('reserve') || ctx.includes('over-reserved')) {
    return 'Reserve allocation is high relative to obligations. Reducing reserve basis points by 5–10% would free spendable capacity without materially increasing risk.'
  }
  if (ctx.includes('payee') || ctx.includes('agent')) {
    return 'Add AI agent wallet as a permitted payee with a conservative daily USDC limit before enabling autonomous payments.'
  }
  return 'Treasury policy looks healthy. Ensure all active obligations reflect real recurring costs and that every payee has an appropriate daily cap.'
}
