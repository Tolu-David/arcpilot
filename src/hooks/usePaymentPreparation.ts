/**
 * src/hooks/usePaymentPreparation.ts
 *
 * Calls POST /api/prepare to obtain a server-authoritative PaymentPreparationReceipt.
 *
 * The browser supplies only: serviceId, idempotencyKey, memo.
 * ALL canonical values (recipient, amount, contractAddress, tokenAddress,
 * chainId, requestId) come from the server and are reflected back in the receipt.
 *
 * Security guarantees:
 *  - No price, recipient, or calldata is sent to the server.
 *  - The preparation receipt is the single source of truth for the Review Modal.
 *  - Repeated calls with the same idempotencyKey + same payload return the cached
 *    receipt (server enforced); a mismatched payload returns a 409 error.
 *  - Stale snapshots (>60 s) are rejected server-side; the hook surfaces the error.
 */

import { useState, useCallback } from 'react'
import type { PaymentPreparationReceipt } from '../../shared/types'
import type { SnapshotPayload } from './useRecommendation'

// ── State ─────────────────────────────────────────────────────────────────────

export type PrepareStatus = 'idle' | 'loading' | 'success' | 'error' | 'server-unavailable'

export interface PrepareState {
  status: PrepareStatus
  receipt: PaymentPreparationReceipt | null
  errorMessage: string | null
  /** HTTP status code from the last failed request, if available. */
  errorCode: number | null
}

export interface UsePaymentPreparationReturn extends PrepareState {
  /**
   * Fetch a preparation receipt for the given service.
   *
   * @param serviceId    Catalogue service ID (server resolves canonical values)
   * @param idempotencyKey  UUID v4 — stable key for this payment attempt
   * @param snapshot     Fresh contract state snapshot (bigints as decimal strings)
   * @param memo         Optional short memo (max 128 chars)
   */
  prepare: (
    serviceId: string,
    idempotencyKey: string,
    snapshot: SnapshotPayload,
    memo?: string,
  ) => Promise<void>
  /** Reset to idle, clearing the receipt and any error. */
  reset: () => void
}

// ── API call ──────────────────────────────────────────────────────────────────

interface PrepareApiError {
  status: number
  message: string
}

async function postPrepare(
  serviceId: string,
  idempotencyKey: string,
  snapshot: SnapshotPayload,
  memo: string | undefined,
): Promise<PaymentPreparationReceipt> {
  const res = await fetch('/api/prepare', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Forward the idempotency key as a header as well as in the body,
      // matching the convention used by the existing idempotency middleware.
      'x-idempotency-key': idempotencyKey,
    },
    // Never include `to`, `amount`, `contractAddress`, or any canonical value —
    // the server derives all of those from the catalogue.
    body: JSON.stringify({ serviceId, idempotencyKey, snapshot, memo }),
  })

  const json = await res.json().catch(() => ({})) as Record<string, unknown>

  if (!res.ok) {
    const err: PrepareApiError = {
      status: res.status,
      message: (json.message as string | undefined) ?? `Preparation failed: ${res.status} ${res.statusText}`,
    }
    throw err
  }

  return json as unknown as PaymentPreparationReceipt
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function usePaymentPreparation(): UsePaymentPreparationReturn {
  const [state, setState] = useState<PrepareState>({
    status: 'idle',
    receipt: null,
    errorMessage: null,
    errorCode: null,
  })

  const prepare = useCallback(async (
    serviceId: string,
    idempotencyKey: string,
    snapshot: SnapshotPayload,
    memo?: string,
  ): Promise<void> => {
    setState({ status: 'loading', receipt: null, errorMessage: null, errorCode: null })

    try {
      const receipt = await postPrepare(serviceId, idempotencyKey, snapshot, memo)
      setState({ status: 'success', receipt, errorMessage: null, errorCode: null })
    } catch (err: unknown) {
      // Typed API error from postPrepare
      if (err !== null && typeof err === 'object' && 'status' in err && 'message' in err) {
        const apiErr = err as PrepareApiError
        setState({
          status: 'error',
          receipt: null,
          errorMessage: apiErr.message,
          errorCode: apiErr.status,
        })
        return
      }
      // Network error (server unreachable)
      const msg = err instanceof Error ? err.message : String(err)
      const isUnavailable =
        msg.includes('fetch') ||
        msg.includes('Failed to fetch') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('NetworkError')
      setState({
        status: isUnavailable ? 'server-unavailable' : 'error',
        receipt: null,
        errorMessage: msg,
        errorCode: null,
      })
    }
  }, [])

  const reset = useCallback(() => {
    setState({ status: 'idle', receipt: null, errorMessage: null, errorCode: null })
  }, [])

  return { ...state, prepare, reset }
}
