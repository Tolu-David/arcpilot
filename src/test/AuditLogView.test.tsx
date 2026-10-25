/**
 * AuditLogView.test.tsx
 *
 * Tests for the on-chain payment event viewer.
 * Covers: no-contract, loading, error, empty, success (table, rows, badges),
 * pagination absence, and provenance notices.
 *
 * useReadContract is mocked to return controlled values. We use a single
 * file-level mock that can be overridden per-test to avoid the first-test-in-
 * describe stale-DOM issue seen with sequential mockReturnValueOnce queues.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import React from 'react'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('framer-motion', () => {
  function pt(tag: string) {
    return function C({
      children,
      initial: _i,
      animate: _a,
      exit: _e,
      transition: _t,
      ...rest
    }: Record<string, unknown> & { children?: React.ReactNode }) {
      return React.createElement(
        tag as keyof React.JSX.IntrinsicElements,
        rest as Record<string, unknown>,
        children,
      )
    }
  }
  const h: ProxyHandler<Record<string, unknown>> = { get: (_t, tag: string) => pt(tag) }
  return {
    motion: new Proxy({}, h),
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useAnimation: () => ({}),
    useMotionValue: () => ({}),
    LayoutGroup: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  }
})

vi.mock('wagmi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('wagmi')>()
  return {
    ...actual,
    useReadContracts: vi.fn(() => ({ data: undefined })),
    useReadContract: vi.fn(() => ({ data: undefined, isLoading: false, isError: false })),
    useAccount: vi.fn(() => ({ isConnected: true, address: '0x1234' as `0x${string}` })),
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

import { useReadContract } from 'wagmi'
import { AuditLogView } from '@/views/AuditLogView'

const mockRead = vi.mocked(useReadContract)

// Cleanup after every test
afterEach(() => {
  cleanup()
  mockRead.mockReset()
})

// arc-studio-allow-onchain-literal
const CONTRACT = '0x28a05d2996207b3db64b5ad171a2db5d71c9a8f3' as `0x${string}`
// arc-studio-allow-onchain-literal
const DEMO_TO = '0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA' as `0x${string}`
const DEMO_RECORD = {
  to: DEMO_TO,
  amount: 500000n,
  timestamp: BigInt(Math.floor(Date.now() / 1000) - 3600),
  memo: 'Test payment memo',
}

// Set the mock to return `count` for paymentCount and `records` for getPayments.
// Uses mockImplementation so it never gets consumed and doesn't depend on call order.
function setMock({
  count = 0,
  records = [] as typeof DEMO_RECORD[],
  countLoading = false,
  recLoading = false,
  countError = false,
  recError = false,
}: {
  count?: number
  records?: typeof DEMO_RECORD[]
  countLoading?: boolean
  recLoading?: boolean
  countError?: boolean
  recError?: boolean
} = {}) {
  mockRead.mockImplementation((args) => {
    const functionName = (args as { functionName?: string } | undefined)?.functionName
    if (functionName === 'paymentCount') {
      return {
        data: countError ? undefined : BigInt(count),
        isLoading: countLoading,
        isError: countError,
      } as ReturnType<typeof useReadContract>
    }
    return {
      data: recError ? undefined : records,
      isLoading: recLoading,
      isError: recError,
    } as ReturnType<typeof useReadContract>
  })
}

function renderView(contractAddress: `0x${string}` | undefined = CONTRACT) {
  render(<AuditLogView contractAddress={contractAddress} />)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

// Use a single flat describe so no test is ever "first in a new describe"
// after a describe with a different mock configuration. Each test sets its own
// mock configuration inline.

describe('AuditLogView', () => {
  it('renders the audit-log-view wrapper', () => {
    setMock()
    renderView()
    expect(screen.getByTestId('audit-log-view')).toBeInTheDocument()
  })

  it('always shows the on-chain notice (no contract)', () => {
    setMock()
    renderView(undefined)
    expect(screen.getAllByTestId('onchain-notice').length).toBeGreaterThanOrEqual(1)
  })

  it('always shows the off-chain disclaimer (no contract)', () => {
    setMock()
    renderView(undefined)
    expect(screen.getAllByTestId('offchain-notice').length).toBeGreaterThanOrEqual(1)
  })

  it('does not show the audit table when no contract is set', () => {
    setMock()
    renderView(undefined)
    expect(screen.queryByTestId('audit-table')).not.toBeInTheDocument()
  })

  it('no-contract state: no audit rows visible', () => {
    setMock()
    renderView(undefined)
    expect(screen.queryAllByTestId('audit-recipient').length).toBe(0)
  })

  it('always shows the on-chain notice when contract is set', () => {
    setMock()
    renderView()
    expect(screen.getAllByTestId('onchain-notice').length).toBeGreaterThanOrEqual(1)
  })

  it('shows the loading skeleton while paymentCount is loading', () => {
    setMock({ countLoading: true })
    renderView()
    expect(screen.getByTestId('audit-loading')).toBeInTheDocument()
  })

  it('shows provenance notices while loading', () => {
    setMock({ countLoading: true })
    renderView()
    expect(screen.getByTestId('onchain-notice')).toBeInTheDocument()
    expect(screen.getByTestId('offchain-notice')).toBeInTheDocument()
  })

  it('does not show the audit table when paymentCount errors', () => {
    setMock({ countError: true })
    renderView()
    expect(screen.queryByTestId('audit-table')).not.toBeInTheDocument()
  })

  it('does not show the total count badge when errored', () => {
    setMock({ countError: true })
    renderView()
    expect(screen.queryByTestId('audit-total')).not.toBeInTheDocument()
  })

  it('does not show the audit table when errored', () => {
    setMock({ countError: true })
    renderView()
    expect(screen.queryByTestId('audit-table')).not.toBeInTheDocument()
  })

  it('shows empty state when paymentCount is 0', () => {
    setMock({ count: 0 })
    renderView()
    expect(screen.getAllByText(/No on-chain payments yet/i).length).toBeGreaterThanOrEqual(1)
  })

  it('renders the audit table when payments exist', () => {
    setMock({ count: 1, records: [DEMO_RECORD] })
    renderView()
    expect(screen.getByTestId('audit-table')).toBeInTheDocument()
  })

  it('shows the total payment count', () => {
    setMock({ count: 1, records: [DEMO_RECORD] })
    renderView()
    expect(screen.getAllByText(/1 on-chain payment/).length).toBeGreaterThanOrEqual(1)
  })

  it('shows the On-chain badge', () => {
    setMock({ count: 1, records: [DEMO_RECORD] })
    renderView()
    expect(screen.getAllByText('On-chain').length).toBeGreaterThanOrEqual(1)
  })

  it('renders a row for each payment', () => {
    const two = [DEMO_RECORD, { ...DEMO_RECORD, amount: 1000000n, memo: 'Second' }]
    setMock({ count: 2, records: two })
    renderView()
    expect(screen.getAllByTestId('audit-recipient').length).toBe(2)
  })

  it('shows recipient address links', () => {
    setMock({ count: 1, records: [DEMO_RECORD] })
    renderView()
    expect(screen.getByTestId('audit-recipient')).toBeInTheDocument()
  })

  it('shows the amount for each record', () => {
    setMock({ count: 1, records: [DEMO_RECORD] })
    renderView()
    expect(screen.getByTestId('audit-amount')).toBeInTheDocument()
  })

  it('shows the memo', () => {
    setMock({ count: 1, records: [DEMO_RECORD] })
    renderView()
    expect(screen.getAllByText('Test payment memo').length).toBeGreaterThanOrEqual(1)
  })

  it('shows the "See logs" note (tx hash not in contract storage)', () => {
    setMock({ count: 1, records: [DEMO_RECORD] })
    renderView()
    expect(screen.getAllByTestId('audit-no-tx-note').length).toBeGreaterThanOrEqual(1)
  })

  it('does not show pagination for a single page', () => {
    setMock({ count: 5, records: [DEMO_RECORD] })
    renderView()
    expect(screen.queryByTestId('audit-pagination')).not.toBeInTheDocument()
  })
})
