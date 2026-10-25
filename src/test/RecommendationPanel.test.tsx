/**
 * src/test/RecommendationPanel.test.tsx
 *
 * Tests for the AgentServicesView recommendation workflow:
 *  - Loading state while recommendation is in-flight
 *  - AI unavailable — policy still enforced
 *  - Policy denied — Review Payment disabled, reason code visible
 *  - Policy approval-required — Request Approval shown, Review Payment hidden
 *  - Policy eligible — Review Payment enabled, no AI required
 *  - AI recommend verdict shown with reasoning
 *  - AI reject verdict shown
 *  - AI request-approval verdict shown
 *  - AI choose_alternative with alternatives list
 *  - AI warnings rendered
 *  - Budget section shows spendable + daily remaining
 *  - Canonical price from server (never browser-supplied)
 *  - Review Payment opens review panel; no transaction submitted
 *  - Review panel shows policy-recheck notice
 *  - Closing recommendation clears the panel
 *
 * Both useServiceCatalogue and useRecommendation are mocked.
 * No real fetch calls are made.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import React from 'react'
import type { CatalogueResult } from '@/hooks/useServiceCatalogue'
import type { UseRecommendationReturn } from '@/hooks/useRecommendation'
import type {
  CatalogueService,
  ServiceRequestResult,
  RecommendationResponse,
  AiRecommendationOutput,
} from '../../shared/types'

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

vi.mock('@/hooks/usePaymentPreparation', () => ({
  usePaymentPreparation: vi.fn(),
}))

// ReviewPaymentModal uses wagmi hooks — stub them out for these tests
vi.mock('wagmi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('wagmi')>()
  return {
    ...actual,
    useAccount:   () => ({ address: '0xOwner000000000000000000000000000001' as `0x${string}`, isConnected: true }),
    useChainId:   () => 5042002,
    useReadContract: (opts: { functionName: string }) => {
      if (opts.functionName === 'owner') return { data: '0xOwner000000000000000000000000000001' as `0x${string}`, isLoading: false, isError: false }
      return { data: undefined, isLoading: false, isError: false }
    },
    useWriteContract:             () => ({ writeContractAsync: vi.fn() }),
    useWaitForTransactionReceipt: () => ({ data: undefined }),
    useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
    createConfig:   actual.createConfig,
    http:           actual.http,
  }
})

vi.mock('connectkit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('connectkit')>()
  return {
    ...actual,
    ConnectKitButton: () => React.createElement('button', null, 'Connect'),
    ConnectKitProvider: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  }
})

import { useServiceCatalogue } from '@/hooks/useServiceCatalogue'
import { useRecommendation } from '@/hooks/useRecommendation'
import { usePaymentPreparation } from '@/hooks/usePaymentPreparation'
import { AgentServicesView } from '@/views/AgentServicesView'

const mockCatalogue = vi.mocked(useServiceCatalogue)
const mockRec = vi.mocked(useRecommendation)
const mockPrep = vi.mocked(usePaymentPreparation)

// Default preparation mock — returns idle state, prepare is a no-op
function makeDefaultPrepResult() {
  return {
    status: 'idle' as const,
    receipt: null,
    errorMessage: null,
    errorCode: null,
    prepare: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
  }
}

import { beforeEach } from 'vitest'

beforeEach(() => {
  // Default preparation mock — idle, prepare is a no-op.
  // Tests that exercise the preparation flow override this.
  mockPrep.mockReturnValue(makeDefaultPrepResult())
})

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

/** Build a minimal RecommendationResponse. */
function recResponse(overrides: {
  allowed?: boolean
  approvalRequired?: boolean
  reasonCode?: string
  explanation?: string
  ai?: AiRecommendationOutput | null
  aiError?: string | null
  spendable?: string
  dailyRemaining?: string
  priceBaseUnits?: string
} = {}): RecommendationResponse {
  return {
    serviceId: 'data-scraper',
    priceBaseUnits: overrides.priceBaseUnits ?? '500000',
    policy: {
      allowed: overrides.allowed ?? true,
      approvalRequired: overrides.approvalRequired ?? false,
      reasonCode: (overrides.reasonCode ?? 'POLICY_OK') as RecommendationResponse['policy']['reasonCode'],
      explanation: overrides.explanation ?? 'All checks passed.',
      evaluatedAt: new Date().toISOString(),
    },
    spendable: overrides.spendable ?? '4500000000',
    dailyRemaining: overrides.dailyRemaining ?? '50000000000',
    aiRecommendation: overrides.ai !== undefined ? overrides.ai : {
      recommendation: 'recommend',
      serviceId: 'data-scraper',
      reasoning: 'The service cost is within budget.',
      warnings: [],
      alternatives: [],
    },
    aiError: overrides.aiError ?? null,
    evaluatedAt: new Date().toISOString(),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RecommendationPanel — loading state', () => {
  it('shows the loading skeleton while recommendation is in-flight', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'loading' }))
    render(<AgentServicesView />)
    expect(screen.getByTestId('recommendation-loading')).toBeInTheDocument()
  })

  it('hides the recommendation panel while loading', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'loading' }))
    render(<AgentServicesView />)
    expect(screen.queryByTestId('recommendation-panel')).not.toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('RecommendationPanel — AI unavailable', () => {
  it('shows the recommendation panel when AI is unavailable but policy succeeded', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({ ai: null, aiError: 'AI_STUDIO_KEY_MISSING: API key not set.' }),
    }))
    render(<AgentServicesView />)
    // Simulate a service being selected so recommendation panel is visible
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    expect(screen.getAllByTestId('recommendation-panel').length).toBeGreaterThanOrEqual(1)
  })

  it('shows AI unavailable notice when aiRecommendation is null', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({ ai: null, aiError: 'AI timed out.' }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    expect(screen.getAllByTestId('rec-ai-unavailable').length).toBeGreaterThanOrEqual(1)
  })

  it('still shows Review Payment when policy allows despite AI being unavailable', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({ allowed: true, approvalRequired: false, ai: null, aiError: 'Timeout' }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    expect(screen.getAllByTestId('rec-review-payment-btn').length).toBeGreaterThanOrEqual(1)
  })

  it('still shows denied state when policy denies despite AI being unavailable', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({
        allowed: false,
        approvalRequired: false,
        reasonCode: 'TREASURY_PAUSED',
        explanation: 'The treasury is paused.',
        ai: null,
        aiError: 'Timeout',
      }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    expect(screen.getAllByTestId('rec-denied-btn').length).toBeGreaterThanOrEqual(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('RecommendationPanel — policy denied', () => {
  it('shows the policy section with "Denied" verdict', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({
        allowed: false,
        approvalRequired: false,
        reasonCode: 'TX_LIMIT_EXCEEDED',
        explanation: 'Amount exceeds the per-transaction cap.',
      }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    const policyVerdicts = screen.getAllByTestId('rec-policy-verdict')
    expect(policyVerdicts.some((el) => el.textContent?.includes('Denied'))).toBe(true)
  })

  it('shows the reason code when policy is denied', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({
        allowed: false,
        approvalRequired: false,
        reasonCode: 'TX_LIMIT_EXCEEDED',
        explanation: 'Amount exceeds the per-transaction cap.',
      }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    const codes = screen.getAllByTestId('rec-policy-reason-code')
    expect(codes.some((el) => el.textContent?.includes('TX_LIMIT_EXCEEDED'))).toBe(true)
  })

  it('disables payment preparation when policy is denied', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({
        allowed: false,
        approvalRequired: false,
        reasonCode: 'TREASURY_PAUSED',
        explanation: 'Contract is paused.',
      }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    const deniedBtns = screen.getAllByTestId('rec-denied-btn')
    expect(deniedBtns.every((btn) => (btn as HTMLButtonElement).disabled)).toBe(true)
  })

  it('does NOT show Review Payment when policy is denied', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({ allowed: false, approvalRequired: false, reasonCode: 'RESERVE_BREACH' }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    expect(screen.queryByTestId('rec-review-payment-btn')).not.toBeInTheDocument()
  })

  it('does NOT show Request Approval when policy is denied (not approval-required)', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({ allowed: false, approvalRequired: false, reasonCode: 'INSUFFICIENT_FUNDS' }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    expect(screen.queryByTestId('rec-approval-btn')).not.toBeInTheDocument()
  })

  it('AI recommend verdict does NOT override a policy denial', () => {
    // AI says "recommend" but policy says "denied" — payment prep must remain disabled.
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({
        allowed: false,
        approvalRequired: false,
        reasonCode: 'DAILY_LIMIT_EXCEEDED',
        ai: {
          recommendation: 'recommend',
          serviceId: 'data-scraper',
          reasoning: 'Looks fine to me.',
          warnings: [],
          alternatives: [],
        },
      }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    // AI verdict shown (advisory)
    const verdicts = screen.getAllByTestId('rec-ai-verdict')
    expect(verdicts.some((el) => el.textContent?.includes('Proceed'))).toBe(true)
    // But payment is still disabled
    expect(screen.queryByTestId('rec-review-payment-btn')).not.toBeInTheDocument()
    const deniedBtns = screen.getAllByTestId('rec-denied-btn')
    expect(deniedBtns.length).toBeGreaterThanOrEqual(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('RecommendationPanel — approval required', () => {
  it('shows "Approval required" in the policy section', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: {
        ...recResponse({ allowed: false, approvalRequired: true, reasonCode: 'APPROVAL_REQUIRED' }),
        serviceId: 'deep-analysis',
      },
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-deep-analysis'))
    const verdicts = screen.getAllByTestId('rec-policy-verdict')
    expect(verdicts.some((el) => el.textContent?.includes('Approval required'))).toBe(true)
  })

  it('shows the Request Approval button when approval is required', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: {
        ...recResponse({ allowed: false, approvalRequired: true, reasonCode: 'APPROVAL_REQUIRED' }),
        serviceId: 'deep-analysis',
      },
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-deep-analysis'))
    expect(screen.getAllByTestId('rec-approval-btn').length).toBeGreaterThanOrEqual(1)
  })

  it('does NOT show Review Payment when approval is required', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: {
        ...recResponse({ allowed: false, approvalRequired: true, reasonCode: 'APPROVAL_REQUIRED' }),
        serviceId: 'deep-analysis',
      },
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-deep-analysis'))
    expect(screen.queryByTestId('rec-review-payment-btn')).not.toBeInTheDocument()
  })

  it('shows the APPROVAL_REQUIRED reason code', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: {
        ...recResponse({ allowed: false, approvalRequired: true, reasonCode: 'APPROVAL_REQUIRED' }),
        serviceId: 'deep-analysis',
      },
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-deep-analysis'))
    const codes = screen.getAllByTestId('rec-policy-approval-code')
    expect(codes.some((el) => el.textContent?.includes('APPROVAL_REQUIRED'))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('RecommendationPanel — eligible request', () => {
  it('shows "Eligible" in the policy section', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({ allowed: true, approvalRequired: false }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    const verdicts = screen.getAllByTestId('rec-policy-verdict')
    expect(verdicts.some((el) => el.textContent?.includes('Eligible'))).toBe(true)
  })

  it('shows the Review Payment button when eligible', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({ allowed: true, approvalRequired: false }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    expect(screen.getAllByTestId('rec-review-payment-btn').length).toBeGreaterThanOrEqual(1)
  })

  it('does NOT show denied button when eligible', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({ allowed: true, approvalRequired: false }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    expect(screen.queryByTestId('rec-denied-btn')).not.toBeInTheDocument()
  })

  it('clicking Review Payment triggers payment preparation (calls prepare)', async () => {
    const prepareSpy = vi.fn().mockResolvedValue(undefined)
    mockPrep.mockReturnValue({ ...makeDefaultPrepResult(), prepare: prepareSpy })
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({ allowed: true, approvalRequired: false }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('rec-review-payment-btn')[0])
    })
    // prepare() must be called with the correct serviceId
    expect(prepareSpy).toHaveBeenCalledTimes(1)
    expect(prepareSpy.mock.calls[0][0]).toBe('data-scraper')
  })

  it('review modal shows the canonical amount from server receipt (amountBaseUnits)', async () => {
    // When preparation succeeds, the full ReviewPaymentModal opens.
    // Simulate success by returning a receipt from usePaymentPreparation.
    const mockReceipt = {
      prepId: 'prep-001', idempotencyKey: 'ik-001',
      requestId: `0x${'ab'.repeat(32)}`,
      cached: false,
      serviceId: 'data-scraper',
      recipient: '0xRecipient0000000000000000000000000001',
      amountBaseUnits: '500000',  // 0.50 USDC
      amountDisplay: '0.50',
      memo: '',
      chain: 'Arc Testnet', chainId: 5042002,
      contractAddress: '0xContract000000000000000000000000000001',
      tokenAddress: '0x3600000000000000000000000000000000000000',
      flowState: 'PolicyChecked' as const,
      policy: { allowed: true, approvalRequired: false, reasonCode: 'POLICY_OK' as const, explanation: 'OK', evaluatedAt: new Date().toISOString() },
      spendableAtCheck: '4500000000',
      dailyRemainingAtCheck: '50000000000',
      preparedAt: new Date().toISOString(),
    }
    mockPrep.mockReturnValue({
      status: 'success' as const,
      receipt: mockReceipt,
      errorMessage: null,
      errorCode: null,
      prepare: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn(),
    })
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({ allowed: true, approvalRequired: false, priceBaseUnits: '500000' }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('rec-review-payment-btn')[0])
    })
    // ReviewPaymentModal shows modal-amount using receipt.amountBaseUnits
    const amountEls = screen.getAllByTestId('modal-amount')
    expect(amountEls.some((el) => el.textContent?.includes('0.500000'))).toBe(true)
  })

  it('review modal shows policy-recheck notice', async () => {
    const mockReceipt = {
      prepId: 'prep-002', idempotencyKey: 'ik-002',
      requestId: `0x${'cd'.repeat(32)}`,
      cached: false,
      serviceId: 'data-scraper',
      recipient: '0xRecipient0000000000000000000000000002',
      amountBaseUnits: '500000',
      amountDisplay: '0.50',
      memo: '',
      chain: 'Arc Testnet', chainId: 5042002,
      contractAddress: '0xContract000000000000000000000000000002',
      tokenAddress: '0x3600000000000000000000000000000000000000',
      flowState: 'PolicyChecked' as const,
      policy: { allowed: true, approvalRequired: false, reasonCode: 'POLICY_OK' as const, explanation: 'OK', evaluatedAt: new Date().toISOString() },
      spendableAtCheck: '4500000000',
      dailyRemainingAtCheck: '50000000000',
      preparedAt: new Date().toISOString(),
    }
    mockPrep.mockReturnValue({
      status: 'success' as const,
      receipt: mockReceipt,
      errorMessage: null,
      errorCode: null,
      prepare: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn(),
    })
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({ allowed: true, approvalRequired: false }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('rec-review-payment-btn')[0])
    })
    // ReviewPaymentModal shows modal-recheck-notice
    expect(screen.getAllByText(/Policy will be rechecked/i).length).toBeGreaterThanOrEqual(1)
  })

  it('no transaction is submitted directly from the Review Payment button', async () => {
    const requestSpy = vi.fn()
    mockCatalogue.mockReturnValue(makeCatalogueResult({
      status: 'success',
      services: THREE_SERVICES,
      requestService: requestSpy,
    }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({ allowed: true, approvalRequired: false }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('rec-review-payment-btn')[0])
    })
    // requestService is the payment-adapter entrypoint; it must NOT be called here
    expect(requestSpy).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('RecommendationPanel — AI verdict display', () => {
  it('shows "Proceed" label for recommend verdict', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({
        ai: { recommendation: 'recommend', serviceId: 'data-scraper', reasoning: 'Good call.', warnings: [], alternatives: [] },
      }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    const verdicts = screen.getAllByTestId('rec-ai-verdict')
    expect(verdicts.some((el) => el.textContent?.includes('Proceed'))).toBe(true)
  })

  it('shows "Advises against" label for reject verdict', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({
        ai: { recommendation: 'reject', serviceId: 'data-scraper', reasoning: 'Too costly.', warnings: [], alternatives: [] },
      }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    const verdicts = screen.getAllByTestId('rec-ai-verdict')
    expect(verdicts.some((el) => el.textContent?.includes('Advises against'))).toBe(true)
  })

  it('shows "Seek approval" label for request-approval verdict', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({
        ai: { recommendation: 'request-approval', serviceId: 'data-scraper', reasoning: 'High spend.', warnings: [], alternatives: [] },
      }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    const verdicts = screen.getAllByTestId('rec-ai-verdict')
    expect(verdicts.some((el) => el.textContent?.includes('Seek approval'))).toBe(true)
  })

  it('shows the AI reasoning text', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({
        ai: { recommendation: 'recommend', serviceId: 'data-scraper', reasoning: 'The service cost is within budget.', warnings: [], alternatives: [] },
      }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    const reasonings = screen.getAllByTestId('rec-ai-reasoning')
    expect(reasonings.some((el) => el.textContent?.includes('within budget'))).toBe(true)
  })

  it('shows AI warnings list when warnings are present', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({
        ai: {
          recommendation: 'recommend',
          serviceId: 'data-scraper',
          reasoning: 'Proceed with caution.',
          warnings: ['Daily budget is at 80%.', 'Reserve is near minimum.'],
          alternatives: [],
        },
      }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    const warningLists = screen.getAllByTestId('rec-ai-warnings')
    expect(warningLists.length).toBeGreaterThanOrEqual(1)
    expect(warningLists[0].textContent).toContain('Daily budget is at 80%')
    expect(warningLists[0].textContent).toContain('Reserve is near minimum')
  })

  it('shows choose_alternative label and alternatives list', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({
        ai: {
          recommendation: 'choose_alternative',
          serviceId: 'data-scraper',
          reasoning: 'A cheaper option is available.',
          warnings: [],
          alternatives: ['deep-analysis'],
        },
      }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    const verdicts = screen.getAllByTestId('rec-ai-verdict')
    expect(verdicts.some((el) => el.textContent?.includes('Try alternative'))).toBe(true)
    const altSections = screen.getAllByTestId('rec-ai-alternatives')
    expect(altSections.some((el) => el.textContent?.includes('deep-analysis'))).toBe(true)
  })

  it('advisory notice is shown below AI reasoning', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse(),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    expect(screen.getAllByText(/advisory note only/i).length).toBeGreaterThanOrEqual(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('RecommendationPanel — budget section', () => {
  it('shows spendable funds from server context', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({ spendable: '4500000000', dailyRemaining: '50000000000' }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    const spendableEls = screen.getAllByTestId('rec-spendable')
    // 4500000000 base units = 4500.00 USDC
    expect(spendableEls.some((el) => el.textContent?.includes('4,500.00'))).toBe(true)
  })

  it('shows daily remaining from server context', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({ spendable: '4500000000', dailyRemaining: '25000000000' }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    const dailyEls = screen.getAllByTestId('rec-daily-remaining')
    // 25000000000 base units = 25000.00 USDC
    expect(dailyEls.some((el) => el.textContent?.includes('25,000.00'))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('RecommendationPanel — canonical price authority', () => {
  it('canonical price comes from server priceBaseUnits, not service.priceDisplay', () => {
    // The server returns priceBaseUnits = 750000 (0.75 USDC)
    // The service fixture has priceDisplay = "0.50" — these differ intentionally
    // to verify the panel uses the server's priceBaseUnits, not the local fixture.
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse({ priceBaseUnits: '750000' }),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    const priceEls = screen.getAllByTestId('rec-canonical-price')
    expect(priceEls.some((el) => el.textContent?.includes('0.75'))).toBe(true)
  })

  it('canonical price label states it is server-authoritative', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse(),
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    const priceEls = screen.getAllByTestId('rec-canonical-price')
    expect(priceEls.some((el) => el.textContent?.includes('server-authoritative'))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('RecommendationPanel — close / dismiss', () => {
  it('clicking the close button calls clear()', async () => {
    const clearSpy = vi.fn()
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'success',
      result: recResponse(),
      clear: clearSpy,
    }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    await act(async () => {
      const closeBtns = screen.getAllByTestId('rec-close-btn')
      fireEvent.click(closeBtns[0])
    })
    expect(clearSpy).toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('RecommendationPanel — server error states', () => {
  it('shows error banner when recommendation fails with a server error', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'error',
      errorMessage: 'HTTP 500 Internal Server Error',
    }))
    render(<AgentServicesView />)
    expect(screen.getAllByTestId('recommendation-error').length).toBeGreaterThanOrEqual(1)
  })

  it('shows server-unavailable error banner when backend is unreachable', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({
      status: 'server-unavailable',
      errorMessage: 'Failed to fetch',
    }))
    render(<AgentServicesView />)
    expect(screen.getAllByText(/Recommendation server unavailable/i).length).toBeGreaterThanOrEqual(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('RecommendationPanel — intent input', () => {
  it('shows the intent input field when an allowed service is selected', () => {
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle' }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    expect(screen.getAllByTestId('intent-input').length).toBeGreaterThanOrEqual(1)
  })

  it('clicking Get Recommendation calls fetchRecommendation', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(undefined)
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle', fetchRecommendation: fetchSpy }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    await act(async () => {
      const btns = screen.getAllByTestId('get-recommendation-btn')
      fireEvent.click(btns[0])
    })
    expect(fetchSpy).toHaveBeenCalled()
  })

  it('fetchRecommendation is called with only serviceId, intent, and snapshot (no price or address)', async () => {
    let capturedArgs: unknown[] = []
    const fetchSpy = vi.fn((...args: unknown[]) => {
      capturedArgs = args
      return Promise.resolve(undefined)
    })
    mockCatalogue.mockReturnValue(makeCatalogueResult({ status: 'success', services: THREE_SERVICES }))
    mockRec.mockReturnValue(makeRecResult({ status: 'idle', fetchRecommendation: fetchSpy }))
    render(<AgentServicesView />)
    fireEvent.click(screen.getByTestId('service-card-data-scraper'))
    await act(async () => {
      const btns = screen.getAllByTestId('get-recommendation-btn')
      fireEvent.click(btns[0])
    })
    expect(capturedArgs[0]).toBe('data-scraper')
    // args[1] is intent (string), args[2] is snapshot (object) — never contains price or address
    expect(typeof capturedArgs[1]).toBe('string')
    expect(typeof capturedArgs[2]).toBe('object')
    // Snapshot must not contain recipient address or price override
    const snap = capturedArgs[2] as Record<string, unknown>
    expect(snap).not.toHaveProperty('recipient')
    expect(snap).not.toHaveProperty('price')
  })
})
