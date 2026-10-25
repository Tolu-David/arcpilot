/**
 * server/payment/gateway.ts
 *
 * Arc Testnet (and mainnet) adapter using Circle Gateway Nanopayments
 * (@circle-fin/x402-batching).
 *
 * Selected when PAYMENT_ADAPTER=testnet or PAYMENT_ADAPTER=mainnet.
 * The mainnet path additionally requires MAINNET_CONFIRMED=true — see adapter.ts.
 *
 * This adapter does NOT execute contract pay() calls directly.  It exposes the
 * x402 middleware that enforces payment before a route handler runs (Gateway
 * collects and settles the USDC authorization).  The execute() method is
 * reserved for future programmatic payment dispatch (e.g., agent-to-agent) and
 * currently returns an unsupported error to prevent accidental use.
 */

import type { Request, Response, NextFunction } from 'express'
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server'
import type { PaymentAdapter } from './adapter.js'
import type { PaymentAdapterMode, PaymentResult, ValidatedPaymentRequest } from '../../shared/types.js'

const FACILITATOR_URLS: Record<'testnet' | 'mainnet', string> = {
  testnet: process.env.GATEWAY_FACILITATOR_URL ?? 'https://gateway-api-testnet.circle.com',
  mainnet: process.env.GATEWAY_FACILITATOR_URL_MAINNET ?? 'https://gateway-api.circle.com',
}

export class GatewayAdapter implements PaymentAdapter {
  readonly mode: PaymentAdapterMode
  private readonly middleware: ReturnType<typeof createGatewayMiddleware>

  constructor(network: 'testnet' | 'mainnet') {
    this.mode = network

    const sellerAddress = process.env.SELLER_ADDRESS
    if (!sellerAddress) {
      throw new Error(
        '[GatewayAdapter] SELLER_ADDRESS env var is required. ' +
        'Set it to the EVM address that receives USDC Gateway payments.',
      )
    }

    this.middleware = createGatewayMiddleware({
      sellerAddress: sellerAddress as `0x${string}`,
      facilitatorUrl: FACILITATOR_URLS[network],
    })
  }

  /**
   * Programmatic payment execution is not yet implemented for the Gateway
   * adapter.  Route handlers are gated by requirePayment() middleware instead —
   * the Gateway settles payments server-to-server after the client's x402
   * authorization is verified.
   */
  async execute(_request: ValidatedPaymentRequest): Promise<PaymentResult> {
    throw new Error(
      '[GatewayAdapter] execute() is not supported in this version. ' +
      'Use requirePayment() middleware to gate route handlers instead.',
    )
  }

  requirePayment(priceUsdcDecimal: string) {
    // createGatewayMiddleware returns a function compatible with Express middleware.
    // Cast through unknown because the library types differ slightly from Express's
    // RequestHandler signature, but the runtime behaviour is identical.
    return this.middleware.require(priceUsdcDecimal) as unknown as (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => void
  }
}
