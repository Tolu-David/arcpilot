/**
 * src/hooks/usePaymentHistory.ts
 *
 * Fetches the off-chain payment log from GET /api/payments with pagination.
 *
 * Data provenance: this hook returns the server's view of payment state.
 * It is NOT a substitute for reading the contract's PaymentExecuted events.
 * The UI must display the provenanceNotice returned by the server.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PaymentHistoryPage, PaymentHistoryRecord } from '../../shared/types'

export const DEFAULT_PAGE_SIZE = 10

export const FALLBACK_PROVENANCE_NOTICE =
  'This log is maintained by the ArcPilot server process. ' +
  'It is NOT stored on-chain and is not tamper-evident. ' +
  "Use the contract's PaymentExecuted events for the authoritative, verifiable record."

export type PaymentHistoryStatus =
  | 'loading'
  | 'error'
  | 'server-unavailable' // fetch failed (server not running / network error)
  | 'success'
  | 'empty' // success but no records yet

export interface PaymentHistoryResult {
  status: PaymentHistoryStatus
  records: PaymentHistoryRecord[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  /** Provenance notice from the server — always shown to the user. */
  provenanceNotice: string
  errorMessage: string | null
  setPage: (p: number) => void
}

export function usePaymentHistory(pageSize = DEFAULT_PAGE_SIZE): PaymentHistoryResult {
  const [page, setPage] = useState(1)

  const { data, isLoading, isError, error } = useQuery<PaymentHistoryPage>({
    queryKey: ['payment-history', page, pageSize],
    queryFn: async () => {
      const res = await fetch(`/api/payments?page=${page}&pageSize=${pageSize}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string }
        throw new Error(body.message ?? `HTTP ${res.status}`)
      }
      return res.json() as Promise<PaymentHistoryPage>
    },
    staleTime: 15_000,
    retry: 1,
  })

  const stub = makeStub(setPage, pageSize)

  if (isLoading) return { ...stub, status: 'loading' }

  if (isError || !data) {
    const msg = (error as Error | null)?.message ?? 'Failed to load payment history.'
    const isNetworkErr =
      msg.toLowerCase().includes('failed to fetch') ||
      msg.toLowerCase().includes('networkerror')
    return {
      ...stub,
      status: isNetworkErr ? 'server-unavailable' : 'error',
      errorMessage: msg,
    }
  }

  if (data.total === 0) {
    return {
      ...stub,
      status: 'empty',
      total: 0,
      totalPages: 1,
      provenanceNotice: data.provenanceNotice,
    }
  }

  return {
    status: 'success',
    records: data.records,
    total: data.total,
    page: data.page,
    pageSize: data.pageSize,
    totalPages: data.totalPages,
    provenanceNotice: data.provenanceNotice,
    errorMessage: null,
    setPage,
  }
}

function makeStub(
  setPage: (p: number) => void,
  pageSize: number,
): PaymentHistoryResult {
  return {
    status: 'loading',
    records: [],
    total: 0,
    page: 1,
    pageSize,
    totalPages: 1,
    provenanceNotice: FALLBACK_PROVENANCE_NOTICE,
    errorMessage: null,
    setPage,
  }
}
