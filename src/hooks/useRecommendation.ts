/**
 * src/hooks/useRecommendation.ts
 *
 * Fetches an AI + deterministic-policy recommendation from
 * POST /api/catalogue/recommend.
 *
 * Security guarantees:
 *  - The browser sends only { serviceId, userIntent, snapshot }.
 *  - Price and recipient are resolved server-side from the catalogue.
 *  - The AI recommendation is advisory only — policy.allowed drives UI gates.
 *  - An AI error does NOT block the deterministic policy result.
 *  - No amounts, addresses, or calldata are accepted from the AI response.
 */

import { useState, useCallback } from 'react'
import type { RecommendationResponse } from '../../shared/types'

// ── Snapshot shape sent to the server ────────────────────────────────────────
// All bigint fields serialised as decimal strings for JSON transport.
export interface SnapshotPayload {
  totalBalance: string
  activeObligationsTotal: string
  reserveAmount: string
  spendableBalance: string
  reserveBps: number
  maxTxAmount: string
  globalDailyLimit: string
  dailyRemainingGlobal: string
  paused: boolean
  fetchedAt: number
}

// ── Hook state ────────────────────────────────────────────────────────────────

export type RecommendationStatus =
  | 'idle'
  | 'loading'
  | 'success'
  | 'error'
  | 'server-unavailable'

export interface RecommendationState {
  status: RecommendationStatus
  result: RecommendationResponse | null
  errorMessage: string | null
}

export interface UseRecommendationReturn extends RecommendationState {
  /** Fetch a recommendation for `serviceId` with the given user intent and snapshot. */
  fetchRecommendation: (
    serviceId: string,
    userIntent: string,
    snapshot: SnapshotPayload,
  ) => Promise<void>
  /** Clear the current result and return to idle. */
  clear: () => void
}

// ── API helper ────────────────────────────────────────────────────────────────

const MAX_INTENT_CHARS = 400

async function postRecommendation(
  serviceId: string,
  userIntent: string,
  snapshot: SnapshotPayload,
): Promise<RecommendationResponse> {
  // Sanitise intent client-side before sending (server also sanitises)
  const safeIntent = userIntent.slice(0, MAX_INTENT_CHARS)

  const res = await fetch('/api/catalogue/recommend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Never send price, recipient, or calldata — the server resolves those.
    body: JSON.stringify({ serviceId, userIntent: safeIntent, snapshot }),
  })

  if (!res.ok) {
    const json = await res.json().catch(() => ({})) as { message?: string }
    throw new Error(json.message ?? `Recommendation failed: ${res.status} ${res.statusText}`)
  }

  return res.json() as Promise<RecommendationResponse>
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useRecommendation(): UseRecommendationReturn {
  const [state, setState] = useState<RecommendationState>({
    status: 'idle',
    result: null,
    errorMessage: null,
  })

  const fetchRecommendation = useCallback(async (
    serviceId: string,
    userIntent: string,
    snapshot: SnapshotPayload,
  ): Promise<void> => {
    setState({ status: 'loading', result: null, errorMessage: null })

    try {
      const result = await postRecommendation(serviceId, userIntent, snapshot)
      setState({ status: 'success', result, errorMessage: null })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const isUnavailable =
        msg.includes('fetch') || msg.includes('Failed to fetch') || msg.includes('ECONNREFUSED')
      setState({
        status: isUnavailable ? 'server-unavailable' : 'error',
        result: null,
        errorMessage: msg,
      })
    }
  }, [])

  const clear = useCallback(() => {
    setState({ status: 'idle', result: null, errorMessage: null })
  }, [])

  return { ...state, fetchRecommendation, clear }
}
