/**
 * src/hooks/useServiceCatalogue.ts
 *
 * Fetches the server-controlled service catalogue from GET /api/catalogue.
 * Falls back to an empty list when the server is unreachable (e.g. dev mode
 * with no backend running).
 *
 * The hook uses TanStack Query for caching and background refresh.
 * Prices, recipients, and availability come exclusively from the server —
 * the browser never supplies or overrides them.
 */

import { useQuery } from '@tanstack/react-query'
import type { CatalogueService, ServiceRequestResult } from '../../shared/types'

// ── Types ─────────────────────────────────────────────────────────────────────

export type CatalogueStatus =
  | 'loading'
  | 'error'
  | 'success'
  | 'server-unavailable'

export interface CatalogueResult {
  status: CatalogueStatus
  services: CatalogueService[]
  autoApproveThresholdBaseUnits: number
  errorMessage?: string
  /** Initiate a validated service request. Returns the server's result. */
  requestService: (serviceId: string) => Promise<ServiceRequestResult>
  /** True while a request is in-flight */
  isRequesting: boolean
  /** The result of the most recent request */
  lastRequestResult: ServiceRequestResult | null
  /** Clear the last request result */
  clearLastResult: () => void
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function fetchCatalogue(): Promise<{
  services: CatalogueService[]
  autoApproveThresholdBaseUnits: number
}> {
  const res = await fetch('/api/catalogue')
  if (!res.ok) {
    throw new Error(`Catalogue fetch failed: ${res.status} ${res.statusText}`)
  }
  const json = await res.json() as {
    services?: CatalogueService[]
    autoApproveThresholdBaseUnits?: number
  }
  return {
    services: json.services ?? [],
    autoApproveThresholdBaseUnits: json.autoApproveThresholdBaseUnits ?? 1_000_000,
  }
}

async function postServiceRequest(serviceId: string): Promise<ServiceRequestResult> {
  // Validate the service ID format client-side before sending to prevent
  // obviously-malformed requests from reaching the server.
  if (!serviceId || typeof serviceId !== 'string' || !/^[a-z0-9-]+$/.test(serviceId)) {
    // Return a local denial — the server would reject it anyway.
    return {
      accepted: false,
      requestRef: 'local-' + Date.now(),
      serviceId,
      priceBaseUnits: 0,
      denialCode: 'INVALID_SERVICE',
      denialReason: `"${serviceId}" is not a valid service ID.`,
      timestamp: new Date().toISOString(),
    }
  }

  const res = await fetch(`/api/catalogue/request/${encodeURIComponent(serviceId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // No price or recipient — the server supplies those.
    body: JSON.stringify({}),
  })

  // Both accepted and denied results come as JSON (200 or 4xx).
  const json = await res.json() as ServiceRequestResult
  return json
}

// ── Hook ──────────────────────────────────────────────────────────────────────

import { useState, useCallback } from 'react'

export function useServiceCatalogue(): CatalogueResult {
  const [isRequesting, setIsRequesting] = useState(false)
  const [lastRequestResult, setLastRequestResult] = useState<ServiceRequestResult | null>(null)

  const { data, status, error } = useQuery({
    queryKey: ['service-catalogue'],
    queryFn: fetchCatalogue,
    // Retry once on failure; a missing backend should surface quickly.
    retry: 1,
    staleTime: 30_000,
  })

  const requestService = useCallback(async (serviceId: string): Promise<ServiceRequestResult> => {
    setIsRequesting(true)
    try {
      const result = await postServiceRequest(serviceId)
      setLastRequestResult(result)
      return result
    } finally {
      setIsRequesting(false)
    }
  }, [])

  const clearLastResult = useCallback(() => setLastRequestResult(null), [])

  if (status === 'pending') {
    return {
      status: 'loading',
      services: [],
      autoApproveThresholdBaseUnits: 1_000_000,
      requestService,
      isRequesting,
      lastRequestResult,
      clearLastResult,
    }
  }

  if (status === 'error') {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    // Distinguish "server not running" from a real error
    const isUnavailable = msg.includes('fetch') || msg.includes('Failed to fetch') || msg.includes('ECONNREFUSED')
    return {
      status: isUnavailable ? 'server-unavailable' : 'error',
      services: [],
      autoApproveThresholdBaseUnits: 1_000_000,
      errorMessage: msg,
      requestService,
      isRequesting,
      lastRequestResult,
      clearLastResult,
    }
  }

  return {
    status: 'success',
    services: data?.services ?? [],
    autoApproveThresholdBaseUnits: data?.autoApproveThresholdBaseUnits ?? 1_000_000,
    requestService,
    isRequesting,
    lastRequestResult,
    clearLastResult,
  }
}
