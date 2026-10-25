/**
 * OverviewView.test.tsx
 * Tests for loading, success, empty, wrong-network, and RPC-error states.
 * useTreasuryData is mocked — no wagmi/RPC calls are made.
 * Mock return value is set inside each it() body to avoid cross-describe state leakage.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import React from 'react'
import type { TreasuryDataResult } from '@/hooks/useTreasuryData'
import { DEV_FIXTURE } from '@/lib/treasury-adapter'

// framer-motion: passthrough with no animation
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
    useAccount: vi.fn(() => ({ isConnected: false, address: undefined })),
    useChainId: vi.fn(() => 1),
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
import { OverviewView } from '@/views/OverviewView'

const mockHook = vi.mocked(useTreasuryData)

// Ensure DOM cleanup after every test
afterEach(() => { cleanup() })

function mockResult(partial: Partial<TreasuryDataResult>): TreasuryDataResult {
  return { status: 'disconnected', data: null, lastUpdated: null, errorMessage: null, refetch: vi.fn(), ...partial }
}

const CONTRACT = '0xc10f1f2e659a61ef484c06ecbf161160f929e868' as `0x${string}`
const renderView = () => render(<OverviewView contractAddress={CONTRACT} onNav={vi.fn()} />)

// ── Loading ───────────────────────────────────────────────────────────────

describe('OverviewView — loading', () => {
  it('renders the wrapper', () => {
    mockHook.mockReturnValue(mockResult({ status: 'loading' }))
    renderView()
    expect(screen.getByTestId('overview-view')).toBeInTheDocument()
  })

  it('does not render metric cards', () => {
    mockHook.mockReturnValue(mockResult({ status: 'loading' }))
    renderView()
    expect(screen.queryByTestId('metrics-grid')).not.toBeInTheDocument()
  })

  it('shows the loading skeleton', () => {
    mockHook.mockReturnValue(mockResult({ status: 'loading' }))
    renderView()
    expect(screen.getByTestId('treasury-loading')).toBeInTheDocument()
  })
})

// ── Success ───────────────────────────────────────────────────────────────

describe('OverviewView — success', () => {
  const successResult = () => mockResult({ status: 'success', data: DEV_FIXTURE, lastUpdated: new Date().toISOString() })

  it('renders the metrics grid', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getByTestId('metrics-grid')).toBeInTheDocument()
  })

  it('shows Treasury Balance metric label', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getByText('Treasury Balance')).toBeInTheDocument()
  })

  it('shows at least one Spendable label', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getAllByText(/Spendable/i).length).toBeGreaterThanOrEqual(1)
  })

  it('shows Daily Remaining metric', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getByText('Daily Remaining')).toBeInTheDocument()
  })

  it('shows allocation bar when balance > 0', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getByTestId('allocation-bar')).toBeInTheDocument()
  })

  it('shows daily spending section when globalDailyLimit > 0', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getByTestId('daily-spending')).toBeInTheDocument()
  })

  it('shows contract info strip', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.getByTestId('contract-info')).toBeInTheDocument()
  })

  it('does not show the dev banner', () => {
    mockHook.mockReturnValue(successResult())
    renderView()
    expect(screen.queryByTestId('dev-mode-banner')).not.toBeInTheDocument()
  })
})

// ── Dev adapter ───────────────────────────────────────────────────────────

describe('OverviewView — dev adapter', () => {
  const devResult = () => mockResult({ status: 'dev', data: DEV_FIXTURE, lastUpdated: new Date().toISOString() })

  it('shows the dev mode banner', () => {
    mockHook.mockReturnValue(devResult())
    renderView()
    expect(screen.getByTestId('dev-mode-banner')).toBeInTheDocument()
  })

  it('renders metric cards (dev data shown)', () => {
    mockHook.mockReturnValue(devResult())
    renderView()
    expect(screen.getByTestId('metrics-grid')).toBeInTheDocument()
  })

  it('description contains "Development data"', () => {
    mockHook.mockReturnValue(devResult())
    renderView()
    // SectionHeader description and/or banner both contain "Development data"
    expect(screen.getAllByText(/Development data/i).length).toBeGreaterThanOrEqual(1)
  })
})

// ── Disconnected ──────────────────────────────────────────────────────────

describe('OverviewView — disconnected', () => {
  it('does not render metrics', () => {
    mockHook.mockReturnValue(mockResult({ status: 'disconnected' }))
    renderView()
    expect(screen.queryByTestId('metrics-grid')).not.toBeInTheDocument()
  })

  it('shows wallet-not-connected state', () => {
    mockHook.mockReturnValue(mockResult({ status: 'disconnected' }))
    renderView()
    expect(screen.getByText(/Wallet not connected/i)).toBeInTheDocument()
  })
})

// ── Wrong network ─────────────────────────────────────────────────────────

describe('OverviewView — wrong-network', () => {
  it('shows wrong-network text', () => {
    mockHook.mockReturnValue(mockResult({ status: 'wrong-network' }))
    renderView()
    // The EmptyState title is a <p>; the inline hint also mentions the wrong network
    expect(screen.getAllByText(/Wrong network/i).length).toBeGreaterThanOrEqual(1)
  })

  it('mentions chain ID 5042002', () => {
    mockHook.mockReturnValue(mockResult({ status: 'wrong-network' }))
    renderView()
    expect(screen.getAllByText(/5042002/).length).toBeGreaterThanOrEqual(1)
  })

  it('does not render metrics', () => {
    mockHook.mockReturnValue(mockResult({ status: 'wrong-network' }))
    renderView()
    expect(screen.queryByTestId('metrics-grid')).not.toBeInTheDocument()
  })
})

// ── RPC error ─────────────────────────────────────────────────────────────

describe('OverviewView — RPC error', () => {
  const ERR = 'eth_call reverted: getCode failed'

  it('shows error state', () => {
    mockHook.mockReturnValue(mockResult({ status: 'error', errorMessage: ERR }))
    renderView()
    expect(screen.getByText(/RPC error/i)).toBeInTheDocument()
  })

  it('displays the error message', () => {
    mockHook.mockReturnValue(mockResult({ status: 'error', errorMessage: ERR }))
    renderView()
    expect(screen.getAllByText(ERR).length).toBeGreaterThanOrEqual(1)
  })

  it('does not render metrics', () => {
    mockHook.mockReturnValue(mockResult({ status: 'error', errorMessage: ERR }))
    renderView()
    expect(screen.queryByTestId('metrics-grid')).not.toBeInTheDocument()
  })
})

// ── Empty (zero balance) ──────────────────────────────────────────────────

describe('OverviewView — empty treasury', () => {
  const zeroResult = () => mockResult({
    status: 'success',
    data: { ...DEV_FIXTURE, totalBalance: 0n, obligations: 0n, reserve: 0n, spendable: 0n, globalSpentToday: 0n },
    lastUpdated: new Date().toISOString(),
  })

  it('renders metrics (zeros are valid)', () => {
    mockHook.mockReturnValue(zeroResult())
    renderView()
    expect(screen.getByTestId('metrics-grid')).toBeInTheDocument()
  })

  it('hides allocation bar when balance is zero', () => {
    mockHook.mockReturnValue(zeroResult())
    renderView()
    expect(screen.queryByTestId('allocation-bar')).not.toBeInTheDocument()
  })
})
