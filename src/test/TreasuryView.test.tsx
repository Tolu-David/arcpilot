/**
 * TreasuryView.test.tsx
 * Tests for loading, success, empty, wrong-network, RPC-error, and paused states.
 * Mock return value is set inside each it() body to avoid cross-describe state leakage.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import React from 'react'
import type { TreasuryDataResult } from '@/hooks/useTreasuryData'
import { DEV_FIXTURE } from '@/lib/treasury-adapter'

vi.mock('framer-motion', () => {
  function passthrough(tag: string) {
    return function Component({ children, initial: _i, animate: _a, exit: _e, transition: _t, ...rest }: Record<string, unknown> & { children?: React.ReactNode }) {
      return React.createElement(tag as keyof React.JSX.IntrinsicElements, rest as Record<string, unknown>, children)
    }
  }
  const handler: ProxyHandler<Record<string, unknown>> = { get: (_t, tag: string) => passthrough(tag) }
  return {
    motion: new Proxy({}, handler),
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
    useAccount: vi.fn(() => ({ isConnected: true, address: '0xabc' })),
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
vi.mock('@/hooks/useTreasuryData', () => ({ useTreasuryData: vi.fn() }))
vi.mock('@/hooks/useChainSwitcher', () => ({
  useChainSwitcher: vi.fn(() => ({ switchToArcTestnet: vi.fn(), isSwitching: false })),
}))

import { useTreasuryData } from '@/hooks/useTreasuryData'
import { TreasuryView } from '@/views/TreasuryView'

const mockHook = vi.mocked(useTreasuryData)

// Ensure DOM cleanup after every test
afterEach(() => { cleanup() })

function mockResult(partial: Partial<TreasuryDataResult>): TreasuryDataResult {
  return { status: 'disconnected', data: null, lastUpdated: null, errorMessage: null, refetch: vi.fn(), ...partial }
}

const CONTRACT = '0x28a05d2996207b3db64b5ad171a2db5d71c9a8f3' as `0x${string}`
const renderView = () => render(<TreasuryView contractAddress={CONTRACT} onContractChange={vi.fn()} />)

// ── Loading ───────────────────────────────────────────────────────────────

describe('TreasuryView — loading', () => {
  it('renders the treasury view wrapper', () => {
    mockHook.mockReturnValue(mockResult({ status: 'loading' }))
    renderView()
    expect(screen.getByTestId('treasury-view')).toBeInTheDocument()
  })

  it('shows loading skeletons', () => {
    mockHook.mockReturnValue(mockResult({ status: 'loading' }))
    renderView()
    // TreasuryView has an explicit skeleton div AND TreasuryStateGuard also renders one
    expect(screen.getAllByTestId('treasury-loading').length).toBeGreaterThanOrEqual(1)
  })

  it('does not show treasury metrics', () => {
    mockHook.mockReturnValue(mockResult({ status: 'loading' }))
    renderView()
    expect(screen.queryByTestId('treasury-metrics')).not.toBeInTheDocument()
  })
})

// ── Success ───────────────────────────────────────────────────────────────

describe('TreasuryView — success', () => {
  const successResult = () => mockResult({ status: 'success', data: DEV_FIXTURE, lastUpdated: new Date().toISOString() })

  it('renders treasury metrics', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getByTestId('treasury-metrics')).toBeInTheDocument()
  })

  it('shows Treasury Balance label', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getByText('Treasury Balance')).toBeInTheDocument()
  })

  it('shows at least one Obligations label', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getAllByText(/Obligations/i).length).toBeGreaterThanOrEqual(1)
  })

  it('shows [configured] annotation', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getAllByText('[configured]').length).toBeGreaterThanOrEqual(1)
  })

  it('shows Reserve metric label', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getByText('Reserve')).toBeInTheDocument()
  })

  it('shows at least one Spendable label', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getAllByText(/Spendable/i).length).toBeGreaterThanOrEqual(1)
  })

  it('shows allocation breakdown when balance > 0', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getByTestId('allocation-breakdown')).toBeInTheDocument()
  })

  it('shows daily limits section', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getByTestId('daily-limits')).toBeInTheDocument()
  })

  it('does not show error banner', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.queryByTestId('error-banner')).not.toBeInTheDocument()
  })

  it('does not show paused banner when not paused', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.queryByTestId('paused-banner')).not.toBeInTheDocument()
  })
})

// ── Paused ────────────────────────────────────────────────────────────────

describe('TreasuryView — paused', () => {
  it('shows paused banner', () => {
    mockHook.mockReturnValue(mockResult({ status: 'success', data: { ...DEV_FIXTURE, paused: true }, lastUpdated: new Date().toISOString() }))
    renderView()
    expect(screen.getByTestId('paused-banner')).toBeInTheDocument()
  })

  it('contains the paused message', () => {
    mockHook.mockReturnValue(mockResult({ status: 'success', data: { ...DEV_FIXTURE, paused: true }, lastUpdated: new Date().toISOString() }))
    renderView()
    expect(screen.getByText(/Contract is paused/i)).toBeInTheDocument()
  })
})

// ── Empty ─────────────────────────────────────────────────────────────────

describe('TreasuryView — empty treasury', () => {
  const zeroResult = () => mockResult({
    status: 'success',
    data: { ...DEV_FIXTURE, totalBalance: 0n, obligations: 0n, reserve: 0n, spendable: 0n },
    lastUpdated: new Date().toISOString(),
  })

  it('renders metrics (zeros are valid)', () => {
    mockHook.mockReturnValue(zeroResult())
    renderView()
    expect(screen.getByTestId('treasury-metrics')).toBeInTheDocument()
  })

  it('hides allocation breakdown when balance is zero', () => {
    mockHook.mockReturnValue(zeroResult())
    renderView()
    expect(screen.queryByTestId('allocation-breakdown')).not.toBeInTheDocument()
  })
})

// ── Disconnected ──────────────────────────────────────────────────────────

describe('TreasuryView — disconnected', () => {
  it('shows wallet-not-connected state', () => {
    mockHook.mockReturnValue(mockResult({ status: 'disconnected' }))
    renderView()
    expect(screen.getByText(/Wallet not connected/i)).toBeInTheDocument()
  })

  it('does not show metrics', () => {
    mockHook.mockReturnValue(mockResult({ status: 'disconnected' }))
    renderView()
    expect(screen.queryByTestId('treasury-metrics')).not.toBeInTheDocument()
  })
})

// ── Wrong network ─────────────────────────────────────────────────────────

describe('TreasuryView — wrong-network', () => {
  it('shows wrong-network label', () => {
    mockHook.mockReturnValue(mockResult({ status: 'wrong-network' }))
    renderView()
    expect(screen.getAllByText(/Wrong network/i).length).toBeGreaterThanOrEqual(1)
  })

  it('mentions chain ID 5042002', () => {
    mockHook.mockReturnValue(mockResult({ status: 'wrong-network' }))
    renderView()
    expect(screen.getAllByText(/5042002/).length).toBeGreaterThanOrEqual(1)
  })
})

// ── RPC error ─────────────────────────────────────────────────────────────

describe('TreasuryView — RPC error', () => {
  const ERR = 'Failed to read contract. RPC timeout.'

  it('shows RPC error label', () => {
    mockHook.mockReturnValue(mockResult({ status: 'error', errorMessage: ERR }))
    renderView()
    expect(screen.getByText(/RPC error/i)).toBeInTheDocument()
  })

  it('shows the inline error banner', () => {
    mockHook.mockReturnValue(mockResult({ status: 'error', errorMessage: ERR }))
    renderView()
    expect(screen.getByTestId('error-banner')).toBeInTheDocument()
  })

  it('shows the error message text', () => {
    mockHook.mockReturnValue(mockResult({ status: 'error', errorMessage: ERR }))
    renderView()
    expect(screen.getAllByText(ERR).length).toBeGreaterThanOrEqual(1)
  })
})
