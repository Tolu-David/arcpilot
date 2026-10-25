/**
 * PaymentsView.test.tsx
 *
 * Tests for:
 * - Loading skeleton
 * - Provenance notice always displayed
 * - All payment statuses (submitted, pending, confirmed, reverted, denied, unknown)
 * - No-tx-hash path (shows "—")
 * - Payment-confirmed + service-failed combination
 * - Policy decision and reason code display
 * - Pagination controls
 * - Empty state
 * - Server-unavailable / error state
 * - Simulated flag rendering
 *
 * usePaymentHistory is mocked — no real fetch calls.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'
import type { PaymentHistoryResult } from '@/hooks/usePaymentHistory'
import type { PaymentHistoryRecord } from '../../shared/types'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('framer-motion', () => {
  function pt(tag: string) {
    return function C({ children, initial: _i, animate: _a, exit: _e, transition: _t, ...rest }: Record<string, unknown> & { children?: React.ReactNode }) {
      return React.createElement(tag as keyof React.JSX.IntrinsicElements, rest as Record<string, unknown>, children)
    }
  }
  const h: ProxyHandler<Record<string, unknown>> = { get: (_t, tag: string) => pt(tag) }
  return {
    motion: new Proxy({}, h),
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    useAnimation: () => ({}),
    useMotionValue: () => ({}),
    LayoutGroup: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  }
})

vi.mock('wagmi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('wagmi')>()
  return {
    ...actual,
    useReadContracts: vi.fn(() => ({ data: undefined })),
    useReadContract: vi.fn(() => ({ data: undefined, isLoading: false })),
    useAccount: vi.fn(() => ({ isConnected: false, address: undefined })),
    useChainId: vi.fn(() => 5042002),
    useWriteContract: vi.fn(() => ({ writeContractAsync: vi.fn(), isPending: false })),
    useWaitForTransactionReceipt: vi.fn(() => ({ isLoading: false, isSuccess: false })),
    useSwitchChain: vi.fn(() => ({ switchChainAsync: vi.fn() })),
  }
})
vi.mock('connectkit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('connectkit')>()
  return { ...actual, ConnectKitButton: () => null }
})
vi.mock('@/hooks/usePaymentHistory', () => ({ usePaymentHistory: vi.fn() }))
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: vi.fn(() => ({ data: undefined, isLoading: false, isError: false, error: null })) }
})

import { usePaymentHistory } from '@/hooks/usePaymentHistory'
import { PaymentsView } from '@/views/PaymentsView'

const mockHook = vi.mocked(usePaymentHistory)
afterEach(() => { cleanup() })

const PROVENANCE = 'This log is maintained by the ArcPilot server process.'

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<PaymentHistoryRecord> = {}): PaymentHistoryRecord {
  return {
    id: 'rec-1',
    idempotencyKey: 'idem-1',
    requestId: '0xaabb000000000000000000000000000000000000000000000000000000001234',
    serviceId: 'data-scraper',
    to: '0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA',
    amountUsdc: '500000',
    amountDisplay: '0.50',
    memo: 'Test payment',
    chain: 'Arc Testnet',
    chainId: 5042002,
    contractAddress: '0x28a05d2996207b3db64b5ad171a2db5d71c9a8f3',
    token: 'USDC',
    flowState: 'Confirmed',
    status: 'Confirmed',
    txHash: '0xabababababababababababababababababababababababababababababababababab',
    policyDecision: { verdict: 'allowed', code: 'POLICY_OK', reason: 'Within daily limit.' },
    deliveryStatus: 'succeeded',
    submittedAt: new Date(Date.now() - 3600_000).toISOString(),
    confirmedAt: new Date(Date.now() - 3540_000).toISOString(),
    simulated: false,
    ...overrides,
  }
}

function successResult(records: PaymentHistoryRecord[] = [makeRecord()]): PaymentHistoryResult {
  return {
    status: 'success',
    records,
    total: records.length,
    page: 1,
    pageSize: 10,
    totalPages: 1,
    provenanceNotice: PROVENANCE,
    errorMessage: null,
    setPage: vi.fn(),
  }
}

function stub(partial: Partial<PaymentHistoryResult> = {}): PaymentHistoryResult {
  return {
    status: 'loading',
    records: [],
    total: 0,
    page: 1,
    pageSize: 10,
    totalPages: 1,
    provenanceNotice: PROVENANCE,
    errorMessage: null,
    setPage: vi.fn(),
    ...partial,
  }
}

function renderView() {
  render(<PaymentsView />)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('PaymentsView — loading', () => {
  it('renders the view wrapper', () => {
    mockHook.mockReturnValue(stub())
    renderView()
    expect(screen.getByTestId('payments-view')).toBeInTheDocument()
  })

  it('shows the loading skeleton', () => {
    mockHook.mockReturnValue(stub())
    renderView()
    expect(screen.getByTestId('payments-loading')).toBeInTheDocument()
  })

  it('always shows the provenance notice', () => {
    mockHook.mockReturnValue(stub())
    renderView()
    expect(screen.getByTestId('provenance-notice')).toBeInTheDocument()
  })
})

describe('PaymentsView — empty', () => {
  it('shows empty state', () => {
    mockHook.mockReturnValue(stub({ status: 'empty' }))
    renderView()
    expect(screen.getByTestId('payments-empty')).toBeInTheDocument()
  })

  it('still shows provenance notice', () => {
    mockHook.mockReturnValue(stub({ status: 'empty' }))
    renderView()
    expect(screen.getByTestId('provenance-notice')).toBeInTheDocument()
  })
})

describe('PaymentsView — server-unavailable', () => {
  it('shows error state', () => {
    mockHook.mockReturnValue(stub({ status: 'server-unavailable', errorMessage: 'Failed to fetch' }))
    renderView()
    expect(screen.getByTestId('payments-error')).toBeInTheDocument()
  })

  it('shows the error message', () => {
    mockHook.mockReturnValue(stub({ status: 'server-unavailable', errorMessage: 'Failed to fetch' }))
    renderView()
    expect(screen.getAllByText(/Failed to fetch/).length).toBeGreaterThanOrEqual(1)
  })
})

describe('PaymentsView — success / confirmed + delivered', () => {
  it('renders the payments table', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getByTestId('payments-table')).toBeInTheDocument()
  })

  it('shows the total count', () => {
    mockHook.mockReturnValue(successResult([makeRecord(), makeRecord({ id: 'rec-2', idempotencyKey: 'idem-2' })]))
    renderView()
    expect(screen.getAllByText(/2 total record/).length).toBeGreaterThanOrEqual(1)
  })

  it('shows the request ID (truncated)', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getByTestId('payment-request-id')).toBeInTheDocument()
  })

  it('shows the recipient address (truncated)', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getByTestId('payment-recipient')).toBeInTheDocument()
  })

  it('shows the amount', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getByTestId('payment-amount')).toHaveTextContent('0.50')
  })

  it('shows Confirmed payment status badge', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getAllByText('Confirmed').length).toBeGreaterThanOrEqual(1)
  })

  it('shows Succeeded delivery status badge', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getAllByText('Succeeded').length).toBeGreaterThanOrEqual(1)
  })

  it('shows Allowed policy badge', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getAllByText('Allowed').length).toBeGreaterThanOrEqual(1)
  })

  it('shows tx hash explorer link when available', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getByTestId('payment-tx-link')).toBeInTheDocument()
  })

  it('shows the policy reason code', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getAllByText('POLICY_OK').length).toBeGreaterThanOrEqual(1)
  })
})

describe('PaymentsView — confirmed + service failed (key scenario)', () => {
  it('shows Confirmed flow state AND Failed delivery status simultaneously', () => {
    mockHook.mockReturnValue(successResult([makeRecord({ deliveryStatus: 'failed' })]))
    renderView()
    expect(screen.getAllByText('Confirmed').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Failed').length).toBeGreaterThanOrEqual(1)
  })
})

describe('PaymentsView — Submitted flow state', () => {
  it('shows Submitted payment badge', () => {
    mockHook.mockReturnValue(successResult([makeRecord({
      flowState: 'Submitted', status: 'Submitted',
      txHash: '0xcd'.padEnd(66, 'c'), confirmedAt: null, deliveryStatus: 'not-requested',
    })]))
    renderView()
    expect(screen.getAllByText('Submitted').length).toBeGreaterThanOrEqual(1)
  })
})

describe('PaymentsView — ApprovalRequired flow state', () => {
  it('shows Approval required payment badge', () => {
    mockHook.mockReturnValue(successResult([makeRecord({
      flowState: 'ApprovalRequired', status: 'ApprovalRequired',
      txHash: null, confirmedAt: null, deliveryStatus: 'not-requested',
      policyDecision: { verdict: 'approval-required', code: 'OVER_AUTO_APPROVE_THRESHOLD', reason: 'Too large.' },
    })]))
    renderView()
    // 'Approval required' appears in both payment-status badge and policy badge
    expect(screen.getAllByText('Approval required').length).toBeGreaterThanOrEqual(1)
  })
})

describe('PaymentsView — Denied flow state', () => {
  it('shows Denied payment badge', () => {
    mockHook.mockReturnValue(successResult([makeRecord({
      flowState: 'Denied', status: 'Denied',
      txHash: null, confirmedAt: null,
      deliveryStatus: 'not-requested',
      policyDecision: { verdict: 'denied', code: 'SERVICE_UNAVAILABLE', reason: 'Not allowlisted.' },
    })]))
    renderView()
    expect(screen.getAllByText('Denied').length).toBeGreaterThanOrEqual(1)
  })

  it('shows Not requested delivery status for denied payment', () => {
    mockHook.mockReturnValue(successResult([makeRecord({
      flowState: 'Denied', status: 'Denied',
      txHash: null, confirmedAt: null,
      deliveryStatus: 'not-requested',
      policyDecision: { verdict: 'denied', code: 'SERVICE_UNAVAILABLE', reason: 'Not allowlisted.' },
    })]))
    renderView()
    expect(screen.getAllByText('Not requested').length).toBeGreaterThanOrEqual(1)
  })
})

describe('PaymentsView — Reverted flow state', () => {
  it('shows Reverted payment badge', () => {
    mockHook.mockReturnValue(successResult([makeRecord({
      flowState: 'Reverted', status: 'Reverted',
      txHash: '0xfafa'.padEnd(66, 'f'),
      deliveryStatus: 'not-requested',
    })]))
    renderView()
    expect(screen.getAllByText('Reverted').length).toBeGreaterThanOrEqual(1)
  })
})

describe('PaymentsView — RejectedByWallet flow state', () => {
  it('shows Rejected by wallet badge', () => {
    mockHook.mockReturnValue(successResult([makeRecord({
      flowState: 'RejectedByWallet', status: 'RejectedByWallet',
      txHash: null, confirmedAt: null, deliveryStatus: 'not-requested',
    })]))
    renderView()
    expect(screen.getAllByText('Rejected by wallet').length).toBeGreaterThanOrEqual(1)
  })
})

describe('PaymentsView — Cancelled flow state', () => {
  it('shows Cancelled badge', () => {
    mockHook.mockReturnValue(successResult([makeRecord({
      flowState: 'Cancelled', status: 'Cancelled',
      txHash: null, confirmedAt: null, deliveryStatus: 'not-requested',
    })]))
    renderView()
    expect(screen.getAllByText('Cancelled').length).toBeGreaterThanOrEqual(1)
  })
})

describe('PaymentsView — Unknown flow state', () => {
  it('shows Unknown payment badge', () => {
    mockHook.mockReturnValue(successResult([makeRecord({
      flowState: 'Unknown', status: 'Unknown',
      txHash: '0x1212'.padEnd(66, '1'),
      deliveryStatus: 'unknown',
    })]))
    renderView()
    expect(screen.getAllByText('Unknown').length).toBeGreaterThanOrEqual(1)
  })
})

describe('PaymentsView — missing tx hash', () => {
  it('shows em dash when no tx hash', () => {
    mockHook.mockReturnValue(successResult([makeRecord({
      flowState: 'Submitted', status: 'Submitted',
      txHash: null, confirmedAt: null, deliveryStatus: 'not-requested',
    })]))
    renderView()
    expect(screen.getByTestId('payment-no-tx')).toBeInTheDocument()
  })

  it('does not render an explorer link', () => {
    mockHook.mockReturnValue(successResult([makeRecord({
      flowState: 'Submitted', status: 'Submitted',
      txHash: null, confirmedAt: null, deliveryStatus: 'not-requested',
    })]))
    renderView()
    expect(screen.queryByTestId('payment-tx-link')).not.toBeInTheDocument()
  })
})

describe('PaymentsView — approval-required policy verdict', () => {
  it('shows Approval required policy badge', () => {
    mockHook.mockReturnValue(successResult([makeRecord({
      policyDecision: {
        verdict: 'approval-required',
        code: 'OVER_AUTO_APPROVE_THRESHOLD',
        reason: 'Amount exceeds auto-approve limit.',
      },
    })]))
    renderView()
    expect(screen.getAllByText('Approval required').length).toBeGreaterThanOrEqual(1)
  })
})

describe('PaymentsView — simulated flag', () => {
  it('shows [sim] label for simulated payments', () => {
    mockHook.mockReturnValue(successResult([makeRecord({ simulated: true })]))
    renderView()
    expect(screen.getAllByText(/\[sim\]/).length).toBeGreaterThanOrEqual(1)
  })

  it('does not show [sim] label for real payments', () => {
    mockHook.mockReturnValue(successResult([makeRecord({ simulated: false })]))
    renderView()
    expect(screen.queryByText(/\[sim\]/)).not.toBeInTheDocument()
  })
})

describe('PaymentsView — pagination', () => {
  const mockSetPage = vi.fn()

  it('shows pagination controls when totalPages > 1', () => {
    mockHook.mockReturnValue({
      ...successResult(),
      total: 25,
      page: 1,
      totalPages: 3,
      setPage: mockSetPage,
    })
    renderView()
    expect(screen.getByTestId('pagination')).toBeInTheDocument()
  })

  it('hides pagination when only one page', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.queryByTestId('pagination')).not.toBeInTheDocument()
  })

  it('previous button is disabled on page 1', () => {
    mockHook.mockReturnValue({
      ...successResult(),
      total: 25,
      page: 1,
      totalPages: 3,
      setPage: mockSetPage,
    })
    renderView()
    const prev = screen.getByRole('button', { name: /previous page/i })
    expect(prev).toBeDisabled()
  })

  it('next button is disabled on last page', () => {
    mockHook.mockReturnValue({
      ...successResult(),
      total: 25,
      page: 3,
      totalPages: 3,
      setPage: mockSetPage,
    })
    renderView()
    const next = screen.getByRole('button', { name: /next page/i })
    expect(next).toBeDisabled()
  })

  it('clicking next calls setPage with page + 1', () => {
    const setPage = vi.fn()
    mockHook.mockReturnValue({
      ...successResult(),
      total: 25,
      page: 1,
      totalPages: 3,
      setPage,
    })
    renderView()
    fireEvent.click(screen.getByRole('button', { name: /next page/i }))
    expect(setPage).toHaveBeenCalledWith(2)
  })

  it('clicking prev calls setPage with page - 1', () => {
    const setPage = vi.fn()
    mockHook.mockReturnValue({
      ...successResult(),
      total: 25,
      page: 2,
      totalPages: 3,
      setPage,
    })
    renderView()
    fireEvent.click(screen.getByRole('button', { name: /previous page/i }))
    expect(setPage).toHaveBeenCalledWith(1)
  })
})
