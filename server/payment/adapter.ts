/**
 * server/payment/adapter.ts
 *
 * Payment adapter boundary.
 *
 * This module is the ONLY place in the server that knows which payment runtime
 * is active.  All route handlers import `getAdapter()` from here and call the
 * returned interface — they never import sim.ts or gateway.ts directly.
 *
 * Adapter selection:
 *   PAYMENT_ADAPTER=sim      → sim.ts  (default when unset or in development)
 *   PAYMENT_ADAPTER=testnet  → gateway.ts targeting Arc Testnet
 *   PAYMENT_ADAPTER=mainnet  → gateway.ts targeting Arc Mainnet
 *                              (requires explicit PAYMENT_ADAPTER=mainnet AND
 *                               MAINNET_CONFIRMED=true to prevent accidental use)
 *
 * Adding a new adapter: implement PaymentAdapter, place it in this directory,
 * and add a case to the switch below.  No other file changes required.
 */

import type { PaymentAdapterMode, PaymentResult, ValidatedPaymentRequest } from '../../shared/types.js'

// ── Adapter interface ─────────────────────────────────────────────────────────

/**
 * Every adapter must implement this interface.
 * No adapter may return simulated=false for a non-onchain execution.
 */
export interface PaymentAdapter {
  readonly mode: PaymentAdapterMode

  /**
   * Execute a validated payment request.
   * Must be idempotent for the same requestId — the middleware layer handles
   * idempotency keys, but adapters should treat a repeated requestId as a no-op
   * and return the original result where possible.
   */
  execute(request: ValidatedPaymentRequest): Promise<PaymentResult>

  /**
   * Return the middleware function that enforces x402 payment before a route
   * handler runs.  For sim mode this is a pass-through that injects a fake
   * payment context.
   */
  requirePayment(priceUsdcDecimal: string): (
    req: import('express').Request,
    res: import('express').Response,
    next: import('express').NextFunction,
  ) => void
}

// ── Adapter registry ──────────────────────────────────────────────────────────

let _adapter: PaymentAdapter | null = null

export async function getAdapter(): Promise<PaymentAdapter> {
  if (_adapter) return _adapter

  const mode = (process.env.PAYMENT_ADAPTER ?? 'sim') as PaymentAdapterMode

  switch (mode) {
    case 'sim': {
      const { SimAdapter } = await import('./sim.js')
      _adapter = new SimAdapter()
      break
    }
    case 'testnet': {
      const { GatewayAdapter } = await import('./gateway.js')
      _adapter = new GatewayAdapter('testnet')
      break
    }
    case 'mainnet': {
      if (process.env.MAINNET_CONFIRMED !== 'true') {
        throw new Error(
          'PAYMENT_ADAPTER=mainnet requires MAINNET_CONFIRMED=true. ' +
          'Set both env vars only after completing an independent security review. ' +
          'This guard prevents accidental mainnet use.',
        )
      }
      const { GatewayAdapter } = await import('./gateway.js')
      _adapter = new GatewayAdapter('mainnet')
      break
    }
    default:
      throw new Error(
        `Unknown PAYMENT_ADAPTER value "${mode}". Valid values: sim | testnet | mainnet`,
      )
  }

  console.log(`[ArcPilot] Payment adapter: ${_adapter.mode}`)
  return _adapter
}

/** Reset the cached adapter (test helper — not for production use). */
export function _resetAdapter(): void {
  _adapter = null
}
