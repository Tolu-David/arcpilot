/**
 * server/payment/sim.ts
 *
 * Development simulation adapter.
 *
 * Rules:
 * - NEVER calls a blockchain, Circle API, or any external service.
 * - Always sets simulated=true in the result.
 * - Returns a deterministic fake receipt based on the request contents.
 * - The requirePayment middleware is a no-op pass-through that injects a
 *   clearly-labelled fake payment context — no real authorization happens.
 *
 * This adapter is selected when PAYMENT_ADAPTER is unset or "sim".
 * It exists so the full server flow can be exercised locally without
 * credentials, real wallets, or network access.
 */

import type { Request, Response, NextFunction } from 'express'
import type { PaymentAdapter } from './adapter.js'
import type { PaymentResult, ValidatedPaymentRequest } from '../../shared/types.js'
import { createHash } from 'crypto'

/** Placeholder payer used in simulation receipts only — not a real wallet. */
const SIM_PAYER_PLACEHOLDER = process.env.SIM_PAYER_ADDRESS ?? 'sim-payer-not-configured' // arc-studio-allow-onchain-literal

export class SimAdapter implements PaymentAdapter {
  readonly mode = 'sim' as const

  async execute(request: ValidatedPaymentRequest): Promise<PaymentResult> {
    // Deterministic fake receipt: sha256 of requestId + to + amount
    const hash = createHash('sha256')
      .update(request.requestId + request.to + request.amountUsdc.toString())
      .digest('hex')
      .slice(0, 40)

    return {
      mode: 'sim',
      success: true,
      receiptId: `sim-${hash}`,
      amountUsdc: request.amountUsdc.toString(),
      timestamp: Math.floor(Date.now() / 1000),
      message: `[SIMULATED] Payment of ${request.amountUsdc} USDC base units to ${request.to}. No funds moved.`,
      simulated: true,
    }
  }

  requirePayment(priceUsdcDecimal: string) {
    return (req: Request, _res: Response, next: NextFunction): void => {
      // Inject a fake payment context so route handlers can reference req.payment
      // in the same way they would on testnet. Clearly labelled as simulated.
      ;(req as Request & { payment: unknown }).payment = {
        verified: true,
        payer: SIM_PAYER_PLACEHOLDER,
        amount: usdcDecimalToBaseUnits(priceUsdcDecimal).toString(),
        network: 'sim',
        transaction: undefined,
        simulated: true,
      }
      next()
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a decimal USDC string like "0.010000" to base units (bigint). */
function usdcDecimalToBaseUnits(decimal: string): bigint {
  const [whole, frac = ''] = decimal.split('.')
  const fracPadded = frac.padEnd(6, '0').slice(0, 6)
  return BigInt(whole) * 1_000_000n + BigInt(fracPadded)
}
