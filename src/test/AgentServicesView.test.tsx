/**
 * AgentServicesView.test.tsx
 *
 * Covers the catalogue rendering and service card layer.
 * Recommendation workflow (RecommendationPanel) is covered separately
 * in RecommendationPanel.test.tsx.
 *
 *  - Loading state while catalogue fetch is in-flight
 *  - Server unavailable state
 *  - Empty catalogue
 *  - Successful catalogue render with three demo services
 *  - Service selection (card click → detail panel)
 *  - Unavailable service: request button disabled, detail notice shown
 *  - Approval-required service: button enabled, detail approval notice shown
 *  - Price authority: view shows whatever price the hook (server) returns
 *  - Request button submits only the service ID (triggers recommendation, not requestService)
 *
 * Both useServiceCatalogue and useRecommendation are mocked — no real fetch calls.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import React from 'react'
import type { CatalogueResult } from '@/hooks/useServiceCatalogue'
import type { UseRecommendationReturn, SnapshotPayload } from '@/hooks/useRecommendation'
import type { CatalogueService, ServiceRequestResult } from '../../shared/types'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('framer-motion', () => {
  function passthrough(tag: string) {
    return function Component({
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
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (_t, tag: string) => passthrough(tag),
  }
  return {
    motion: new Proxy({}, handler),
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useAnimation: () => ({}),
    useMotionValue: () => ({}),
    LayoutGroup: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  }
})

vi.mock('@/hooks/useServiceCatalogue', () => ({
  useServiceCatalogue: vi.fn(),
}))

vi.mock('@/hooks/useRecommendation', () => ({
  useRecommendation: vi.fn(),
}))

import { useServiceCatalogue } from '@/hooks/useServiceCatalogue'
import { useRecommendation } from '@/hooks/useRecommendation'
import { AgentServicesView } from '@/views/AgentServicesView'

const mockHook = vi.mocked(useServiceCatalogue)
const mockRec  = vi.mocked(useRecommendation)

afterEach(() => { cleanup() })

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SCRAPER: CatalogueService = {
  id: 'data-scraper',
  name: 'Data Scraper',
  description: 'Fetches and structures publicly available data for AI agent consumption.',
  priceBaseUnits: 500_000,
  priceDisplay: '0.50',
  recipientAddress: '0x5B12Ce46C7194aD57d143bC22847224047b1Ef42',
  active: true,
  allowlisted: true,
  availability: 'allowed',
  method: 'POST',
  path: '/api/agent/data-scraper',
  requiresPayment: true,
}

const DEEP_ANALYSIS: CatalogueService = {
  id: 'deep-analysis',
  name: 'Deep Analysis',
  description: 'Runs a comprehensive multi-pass analysis over a treasury snapshot.',
  priceBaseUnits: 50_000_000,
  priceDisplay: '50.00',
  recipientAddress: '0x5B12Ce46C7194aD57d143bC22847224047b1Ef42',
  active: true,
  allowlisted: true,
  availability: 'approval-required',
  method: 'POST',
  path: '/api/agent/deep-analysis',
  requiresPayment: true,
}

const PROHIBITED: CatalogueService = {
  id: 'prohibited-endpoint',
  name: 'Prohibited Endpoint',
  description: 'Demonstrates a service restricted to a specific allowlist.',
  priceBaseUnits: 150_000_000,
  priceDisplay: '150.00',
  recipientAddress: '0x5B12Ce46C7194aD57d143bC22847224047b1Ef42',
  active: true,
  allowlisted: false,
  availability: 'unavailable',
  method: 'POST',
  path: '/api/agent/prohibited-endpoint',
  requiresPayment: true,
}

const THREE_SERVICES = [SCRAPER, DEEP_ANALYSIS, PROHIBITED]

function makeCatalogueResult(
  partial: Partial<CatalogueResult> & { status: CatalogueResult['status'] },
): CatalogueResult {
  return {
    services: [],
    autoApproveThresholdBaseUnits: 1_000_000,
    requestService: vi.fn().mockResolvedValue({} as ServiceRequestResult),
    isRequesting: false,
    lastRequestResult: null,
    clearLastResult: vi.fn(),
    ...partial,
  }
}

function makeRecResult(
  partial: Partial<UseRecommendationReturn> & { status: UseRecommendationReturn['status'] },
): UseRecommendationReturn {
  return {
    result: null,
    errorMessage: null,
    fetchRecommendation: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn(),
    ...partial,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentServicesView — loading', () => {
  it('renders loading skeletons while catalogue is fetching', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'loading' }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    expect(screen.getByTestId('catalogue-loading')).toBeInTheDocument()
  })

  it('does not render the service grid while loading', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'loading' }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    expect(screen.queryByTestId('service-catalogue-grid')).not.toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('AgentServicesView — server unavailable', () => {
  it('shows a server-offline message when the backend is unreachable', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'server-unavailable' }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    expect(screen.getAllByText(/Agent server offline/i).length).toBeGreaterThanOrEqual(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('AgentServicesView — empty catalogue', () => {
  it('shows an empty-state message when no services are returned', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'success', services: [] }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    expect(screen.getAllByText(/No services available/i).length).toBeGreaterThanOrEqual(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('AgentServicesView — three demo services rendered', () => {
  it('renders all three service cards', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    expect(screen.getByTestId('service-card-data-scraper')).toBeInTheDocument()
    expect(screen.getByTestId('service-card-deep-analysis')).toBeInTheDocument()
    expect(screen.getByTestId('service-card-prohibited-endpoint')).toBeInTheDocument()
  })

  it('shows correct price for Data Scraper (0.50 USDC)', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    expect(screen.getByTestId('service-price-data-scraper').textContent).toContain('0.50 USDC')
  })

  it('shows correct price for Deep Analysis (50.00 USDC)', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    expect(screen.getByTestId('service-price-deep-analysis').textContent).toContain('50.00 USDC')
  })

  it('shows correct price for Prohibited Endpoint (150.00 USDC)', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    expect(screen.getByTestId('service-price-prohibited-endpoint').textContent).toContain('150.00 USDC')
  })

  it('shows allowed badge for Data Scraper', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    const card = screen.getByTestId('service-card-data-scraper')
    expect(card.textContent).toContain('Allowed')
  })

  it('shows approval-required badge for Deep Analysis', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    const card = screen.getByTestId('service-card-deep-analysis')
    expect(card.textContent).toContain('Approval required')
  })

  it('shows unavailable badge for Prohibited Endpoint', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    const card = screen.getByTestId('service-card-prohibited-endpoint')
    expect(card.textContent).toContain('Unavailable')
  })

  it('shows service counts in the header action', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    expect(screen.getByTestId('count-allowed').textContent).toContain('1')
    expect(screen.getByTestId('count-approval').textContent).toContain('1')
    expect(screen.getByTestId('count-unavailable').textContent).toContain('1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('AgentServicesView — service selection', () => {
  it('shows the detail panel when a service card is clicked', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    expect(screen.getByTestId('service-detail-panel')).toBeInTheDocument()
  })

  it('detail panel shows the selected service name', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    const panel = screen.getByTestId('service-detail-panel')
    expect(panel.textContent).toContain('Data Scraper')
  })

  it('detail panel shows the canonical price', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    const priceEl = screen.getByTestId('detail-price')
    expect(priceEl.textContent).toContain('0.50 USDC')
  })

  it('switches detail panel when a different card is selected', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    fireEvent.click(screen.getByTestId('service-card-deep-analysis'))
    const panel = screen.getByTestId('service-detail-panel')
    expect(panel.textContent).toContain('Deep Analysis')
    expect(panel.textContent).not.toContain('Fetches and structures')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('AgentServicesView — unavailable service', () => {
  it('disables the Request button for Prohibited Endpoint', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    const btn = screen.getByTestId('request-btn-prohibited-endpoint')
    expect(btn).toBeDisabled()
  })

  it('shows the allowlist notice in the detail panel for Prohibited Endpoint', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-prohibited-endpoint'))
    expect(screen.getByTestId('detail-unavailable-notice')).toBeInTheDocument()
  })

  it('detail panel shows "Service unavailable" label for Prohibited Endpoint', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-prohibited-endpoint'))
    const detailBtn = screen.getByTestId('detail-request-btn')
    expect(detailBtn).toBeDisabled()
    expect(detailBtn.textContent).toContain('Service unavailable')
  })

  it('does not call requestService or fetchRecommendation when disabled button is clicked', () => {
    const requestSpy = vi.fn()
    const fetchSpy   = vi.fn()
    mockHook.mockReturnValue(
      makeCatalogueResult({ status: 'success', services: THREE_SERVICES, requestService: requestSpy }),
    )
    mockRec.mockReturnValue(makeRecResult({ status: 'idle', fetchRecommendation: fetchSpy }))
    render(<AgentServicesView />)
    const btn = screen.getByTestId('request-btn-prohibited-endpoint')
    fireEvent.click(btn)
    expect(requestSpy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('AgentServicesView — approval-required service', () => {
  it('shows approval-required notice in detail panel for Deep Analysis', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-deep-analysis'))
    expect(screen.getByTestId('detail-approval-notice')).toBeInTheDocument()
  })

  it('Request button is NOT disabled for approval-required service', () => {
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    const btn = screen.getByTestId('request-btn-deep-analysis')
    expect(btn).not.toBeDisabled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('AgentServicesView — request button triggers recommendation, not direct payment', () => {
  it('clicking Request calls fetchRecommendation (not requestService)', async () => {
    const requestSpy = vi.fn()
    const fetchSpy   = vi.fn().mockResolvedValue(undefined)
    mockHook.mockReturnValue(
      makeCatalogueResult({ status: 'success', services: THREE_SERVICES, requestService: requestSpy }),
    )
    mockRec.mockReturnValue(makeRecResult({ status: 'idle', fetchRecommendation: fetchSpy }))
    render(<AgentServicesView />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('request-btn-data-scraper'))
    })
    expect(fetchSpy).toHaveBeenCalled()
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it('fetchRecommendation is called with serviceId as the first argument', async () => {
    let capturedId = ''
    const fetchSpy = vi.fn((id: string) => {
      capturedId = id
      return Promise.resolve(undefined)
    })
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle', fetchRecommendation: fetchSpy }))
    render(<AgentServicesView />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('request-btn-data-scraper'))
    })
    expect(capturedId).toBe('data-scraper')
  })

  it('the snapshot sent to fetchRecommendation does not contain recipient or price override', async () => {
    let capturedSnap: SnapshotPayload | null = null
    const fetchSpy = vi.fn((_id: string, _intent: string, snap: SnapshotPayload) => {
      capturedSnap = snap
      return Promise.resolve(undefined)
    })
    mockHook.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle', fetchRecommendation: fetchSpy }))
    render(<AgentServicesView />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('request-btn-data-scraper'))
    })
    expect(capturedSnap).not.toBeNull()
    expect(capturedSnap).not.toHaveProperty('recipient')
    expect(capturedSnap).not.toHaveProperty('price')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('AgentServicesView — server-side price authority', () => {
  it('renders price from server hook data, not from any browser-local constant', () => {
    // Server returns a non-standard price (99.99) — the view must show it.
    const customService: CatalogueService = {
      ...SCRAPER,
      priceDisplay: '99.99',
      priceBaseUnits: 99_990_000,
    }
    mockHook.mockReturnValue(
      makeCatalogueResult({ status: 'success', services: [customService] }),
    )
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    expect(screen.getByTestId('service-price-data-scraper').textContent).toContain('99.99 USDC')
  })
})
