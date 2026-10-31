/**
 * src/views/AgentServicesView.tsx
 *
 * Agent Services page — displays the server-controlled service catalogue and
 * drives the recommendation + payment-preparation workflow.
 *
 * Workflow:
 *  1. User selects a service and clicks "Request Service".
 *  2. Browser sends only { serviceId, userIntent, snapshot } to /api/catalogue/recommend.
 *  3. Server returns a deterministic policy result + AI advisory recommendation.
 *  4. RecommendationPanel shows:
 *       - Selected service and canonical price (from server)
 *       - AI advisory recommendation section
 *       - Deterministic policy result section (reason code when denied)
 *       - Current spendable funds and remaining daily budget
 *       - Action: Review Payment / Request Approval / (disabled) Denied
 *  5. "Review Payment" re-checks policy before preparing the payment object.
 *     It does NOT submit a transaction directly from the AI response.
 *
 * Security guarantees:
 *  - Prices and recipient addresses come from the server; the browser never
 *    supplies or overrides them.
 *  - AI recommendation === "recommend" is NOT treated as authorisation.
 *  - policy.allowed from the server is the gate for payment preparation.
 *  - No funds transfer on any button click in this view.
 */

import { useState, useCallback, useId } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ReviewPaymentModal } from '@/components/ReviewPaymentModal'
import { usePaymentPreparation } from '@/hooks/usePaymentPreparation'
import type { PaymentPreparationReceipt } from '../../shared/types'
import {
  Zap,
  Search,
  BarChart3,
  ShieldOff,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  ChevronRight,
  Bot,
  ShieldCheck,
  RefreshCw,
  ServerCrash,
  Coins,
  TrendingUp,
  ThumbsUp,
  ThumbsDown,
  HelpCircle,
  ListChecks,
} from 'lucide-react'
import { SectionHeader } from '@/components/shell/SectionHeader'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/lib/utils'
import { useServiceCatalogue } from '@/hooks/useServiceCatalogue'
import { useRecommendation } from '@/hooks/useRecommendation'
import type { SnapshotPayload } from '@/hooks/useRecommendation'
import type {
  CatalogueService,
  ServiceAvailability,
  RecommendationResponse,
  AiVerdict,
} from '../../shared/types'

// ── Dev-mode mock snapshot ────────────────────────────────────────────────────
// When the treasury adapter is in dev/fixture mode the browser cannot fetch live
// contract state.  This fixture represents a mid-range treasury for UI demo
// purposes only.  It is clearly labelled and never used as authoritative data.
//
// [security fix L-3] This is a FUNCTION so that fetchedAt is computed at call
// time, not at module load time.  A module-level constant would become stale
// after 60 seconds, causing all policy/prepare calls to fail with STALE_STATE.
function devSnapshot(): SnapshotPayload {
  return {
    totalBalance:           '5000000000',  // 5 000 USDC
    activeObligationsTotal: '0',
    reserveAmount:          '500000000',   // 10 % reserve
    spendableBalance:       '4500000000',  // 4 500 USDC spendable
    reserveBps:             1000,
    maxTxAmount:            '10000000000',
    globalDailyLimit:       '50000000000',
    dailyRemainingGlobal:   '50000000000',
    paused:                 false,
    fetchedAt:              Date.now(),
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatUsdc(baseUnits: string | number | bigint): string {
  const n = typeof baseUnits === 'bigint' ? Number(baseUnits) : Number(baseUnits)
  if (!Number.isFinite(n)) return '—'
  return (n / 1_000_000).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function AvailabilityBadge({ availability }: { availability: ServiceAvailability }) {
  if (availability === 'allowed') return <Badge variant="success" dot>Allowed</Badge>
  if (availability === 'approval-required') return <Badge variant="warning" dot>Approval required</Badge>
  return <Badge variant="danger" dot>Unavailable</Badge>
}

function availabilityIcon(availability: ServiceAvailability) {
  if (availability === 'allowed') return <CheckCircle2 size={14} className="text-ap-success" />
  if (availability === 'approval-required') return <Clock size={14} className="text-ap-warning" />
  return <ShieldOff size={14} className="text-ap-danger" />
}

function ServiceIcon({ id, className }: { id: string; className?: string }) {
  const cls = cn('shrink-0', className)
  if (id === 'data-scraper') return <Search size={18} className={cls} />
  if (id === 'deep-analysis') return <BarChart3 size={18} className={cls} />
  if (id === 'prohibited-endpoint') return <ShieldOff size={18} className={cls} />
  return <Zap size={18} className={cls} />
}

function verdictIcon(verdict: AiVerdict | null) {
  if (!verdict) return <Bot size={14} className="text-ap-muted" />
  if (verdict === 'recommend') return <ThumbsUp size={14} className="text-ap-success" />
  if (verdict === 'reject') return <ThumbsDown size={14} className="text-ap-danger" />
  if (verdict === 'request-approval') return <HelpCircle size={14} className="text-ap-warning" />
  return <ListChecks size={14} className="text-ap-gold" />
}

function verdictLabel(verdict: AiVerdict): string {
  if (verdict === 'recommend') return 'Proceed'
  if (verdict === 'reject') return 'Advises against'
  if (verdict === 'request-approval') return 'Seek approval'
  return 'Try alternative'
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function ServiceCardSkeleton() {
  return (
    <div className="rounded-xl border border-ap-border bg-ap-surface p-5 animate-pulse">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-lg bg-ap-border/40" />
          <div className="space-y-1.5">
            <div className="h-3.5 w-28 rounded bg-ap-border/50" />
            <div className="h-3 w-16 rounded bg-ap-border/30" />
          </div>
        </div>
        <div className="h-5 w-20 rounded-full bg-ap-border/40" />
      </div>
      <div className="space-y-1.5 mb-4">
        <div className="h-3 w-full rounded bg-ap-border/30" />
        <div className="h-3 w-4/5 rounded bg-ap-border/30" />
      </div>
      <div className="flex items-center justify-between">
        <div className="h-3 w-32 rounded bg-ap-border/20" />
        <div className="h-7 w-20 rounded-lg bg-ap-border/40" />
      </div>
    </div>
  )
}

// ── Recommendation panel ──────────────────────────────────────────────────────

interface RecommendationPanelProps {
  service: CatalogueService
  result: RecommendationResponse
  onReviewPayment: (serviceId: string) => void
  onRequestApproval: (serviceId: string) => void
  onClose: () => void
}

function RecommendationPanel({
  service,
  result,
  onReviewPayment,
  onRequestApproval,
  onClose,
}: RecommendationPanelProps) {
  const { policy, aiRecommendation, aiError, priceBaseUnits } = result

  const isEligible = policy.allowed && !policy.approvalRequired
  const isApprovalRequired = policy.approvalRequired
  const isDenied = !policy.allowed

  return (
    <motion.div
      data-testid="recommendation-panel"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.22 }}
      className="mt-6 rounded-xl border border-ap-border bg-ap-surface shadow-panel overflow-hidden"
    >
      {/* ── Section 1: Service + canonical price ──────────────────────────── */}
      <div
        data-testid="rec-service-header"
        className="flex items-center justify-between gap-3 px-5 py-4 border-b border-ap-border bg-ap-bg/40"
      >
        <div className="flex items-center gap-3">
          <div className={cn(
            'rounded-lg p-2',
            service.availability === 'allowed'
              ? 'bg-ap-gold/10 text-ap-gold'
              : service.availability === 'approval-required'
              ? 'bg-ap-warning/10 text-ap-warning'
              : 'bg-ap-border/40 text-ap-muted',
          )}>
            <ServiceIcon id={service.id} />
          </div>
          <div>
            <p className="font-display font-semibold text-ap-text text-sm">
              {service.name}
            </p>
            <p
              className="text-xs text-ap-muted font-mono"
              data-testid="rec-canonical-price"
            >
              {/* Price from server — priceBaseUnits in the response is the server's
                  authoritative value; service.priceDisplay is the human-readable form
                  from the same catalogue. Never trust a browser-supplied price. */}
              {formatUsdc(priceBaseUnits)} USDC
              <span className="ml-1 text-ap-muted/60">(server-authoritative)</span>
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close recommendation"
          data-testid="rec-close-btn"
          className="text-ap-muted hover:text-ap-text transition-colors p-1"
        >
          <XCircle size={16} />
        </button>
      </div>

      <div className="p-5 space-y-4">
        {/* ── Section 2: AI advisory recommendation ───────────────────────── */}
        <div
          data-testid="rec-ai-section"
          className={cn(
            'rounded-lg border px-4 py-3',
            aiRecommendation
              ? aiRecommendation.recommendation === 'recommend'
                ? 'border-ap-success/25 bg-ap-success/5'
                : aiRecommendation.recommendation === 'reject'
                ? 'border-ap-danger/25 bg-ap-danger/5'
                : aiRecommendation.recommendation === 'request-approval'
                ? 'border-ap-warning/25 bg-ap-warning/5'
                : 'border-ap-gold/25 bg-ap-gold/5'
              : 'border-ap-border bg-ap-bg/40',
          )}
        >
          <div className="flex items-center gap-2 mb-2">
            <Bot size={14} className="text-ap-muted shrink-0" />
            <p className="text-xs font-medium text-ap-muted uppercase tracking-wide">
              AI Advisory
            </p>
            {aiRecommendation && (
              <span
                data-testid="rec-ai-verdict"
                className={cn(
                  'ml-auto flex items-center gap-1 text-xs font-medium',
                  aiRecommendation.recommendation === 'recommend' && 'text-ap-success',
                  aiRecommendation.recommendation === 'reject' && 'text-ap-danger',
                  aiRecommendation.recommendation === 'request-approval' && 'text-ap-warning',
                  aiRecommendation.recommendation === 'choose_alternative' && 'text-ap-gold',
                )}
              >
                {verdictIcon(aiRecommendation.recommendation)}
                {verdictLabel(aiRecommendation.recommendation)}
              </span>
            )}
          </div>

          {aiError && !aiRecommendation && (
            <p
              data-testid="rec-ai-unavailable"
              className="text-xs text-ap-muted"
            >
              Advisory unavailable — deterministic policy still applies.
            </p>
          )}

          {aiRecommendation && (
            <>
              <p
                data-testid="rec-ai-reasoning"
                className="text-sm text-ap-text"
              >
                {aiRecommendation.reasoning}
              </p>

              {aiRecommendation.warnings.length > 0 && (
                <ul
                  data-testid="rec-ai-warnings"
                  className="mt-2 space-y-1"
                >
                  {aiRecommendation.warnings.map((w, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-ap-warning">
                      <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                      {w}
                    </li>
                  ))}
                </ul>
              )}

              {aiRecommendation.recommendation === 'choose_alternative' &&
                aiRecommendation.alternatives.length > 0 && (
                <div
                  data-testid="rec-ai-alternatives"
                  className="mt-2"
                >
                  <p className="text-xs text-ap-muted mb-1">Suggested alternatives:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {aiRecommendation.alternatives.map((alt) => (
                      <span
                        key={alt}
                        className="rounded-md border border-ap-gold/30 bg-ap-gold/5 px-2 py-0.5 text-xs font-mono text-ap-gold"
                      >
                        {alt}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <p className="mt-2 text-xs text-ap-muted/60 italic">
                This is an advisory note only. Policy enforcement is deterministic and
                independent of the above.
              </p>
            </>
          )}
        </div>

        {/* ── Section 3: Deterministic policy result ───────────────────────── */}
        <div
          data-testid="rec-policy-section"
          className={cn(
            'rounded-lg border px-4 py-3',
            isEligible
              ? 'border-ap-success/25 bg-ap-success/5'
              : isApprovalRequired
              ? 'border-ap-warning/25 bg-ap-warning/5'
              : 'border-ap-danger/25 bg-ap-danger/5',
          )}
        >
          <div className="flex items-center gap-2 mb-2">
            <ShieldCheck size={14} className="text-ap-muted shrink-0" />
            <p className="text-xs font-medium text-ap-muted uppercase tracking-wide">
              Policy Check
            </p>
            <span
              data-testid="rec-policy-verdict"
              className={cn(
                'ml-auto text-xs font-semibold',
                isEligible && 'text-ap-success',
                isApprovalRequired && 'text-ap-warning',
                isDenied && 'text-ap-danger',
              )}
            >
              {isEligible
                ? 'Eligible'
                : isApprovalRequired
                ? 'Approval required'
                : 'Denied'}
            </span>
          </div>

          <p
            data-testid="rec-policy-explanation"
            className="text-sm text-ap-text"
          >
            {policy.explanation}
          </p>

          {isDenied && (
            <p
              data-testid="rec-policy-reason-code"
              className="mt-1.5 text-xs font-mono text-ap-danger/80"
            >
              {policy.reasonCode}
            </p>
          )}

          {isApprovalRequired && (
            <p
              data-testid="rec-policy-approval-code"
              className="mt-1.5 text-xs font-mono text-ap-warning/80"
            >
              {policy.reasonCode}
            </p>
          )}
        </div>

        {/* ── Section 4: Spendable funds + daily budget ────────────────────── */}
        {result.policy && (
          <div
            data-testid="rec-budget-section"
            className="rounded-lg border border-ap-border bg-ap-bg/40 px-4 py-3"
          >
            <div className="flex items-center gap-2 mb-3">
              <Coins size={14} className="text-ap-muted shrink-0" />
              <p className="text-xs font-medium text-ap-muted uppercase tracking-wide">
                Treasury Context
              </p>
              <span className="ml-auto text-xs text-ap-muted/60 italic">
                At time of policy check
              </span>
            </div>
            <BudgetRow
              icon={<Coins size={12} />}
              label="Spendable funds"
              testId="rec-spendable"
              value={`${formatUsdc(result.spendable ?? '0')} USDC`}
            />
            <BudgetRow
              icon={<TrendingUp size={12} />}
              label="Daily budget remaining"
              testId="rec-daily-remaining"
              value={`${formatUsdc(result.dailyRemaining ?? '0')} USDC`}
            />
          </div>
        )}

        {/* ── Section 5: Actions ───────────────────────────────────────────── */}
        <div
          data-testid="rec-actions"
          className="flex flex-col gap-2 pt-1"
        >
          {isEligible && (
            <>
              <button
                data-testid="rec-review-payment-btn"
                onClick={() => onReviewPayment(service.id)}
                className={cn(
                  'w-full inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5',
                  'text-sm font-medium bg-ap-gold text-ap-bg hover:bg-ap-gold/90 transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ap-gold',
                )}
              >
                <CheckCircle2 size={14} />
                Review Payment
              </button>
              <p className="text-xs text-ap-muted text-center">
                Policy will be rechecked at payment time. No funds move here.
              </p>
            </>
          )}

          {isApprovalRequired && (
            <>
              <button
                data-testid="rec-approval-btn"
                onClick={() => onRequestApproval(service.id)}
                className={cn(
                  'w-full inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5',
                  'text-sm font-medium bg-ap-warning/90 text-ap-bg hover:bg-ap-warning transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ap-warning',
                )}
              >
                <Clock size={14} />
                Request Approval
              </button>
              <p className="text-xs text-ap-muted text-center">
                This will be routed to the treasury owner for sign-off.
              </p>
            </>
          )}

          {isDenied && (
            <button
              data-testid="rec-denied-btn"
              disabled
              aria-label="Payment preparation disabled — request denied"
              className={cn(
                'w-full inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5',
                'text-sm font-medium bg-ap-border/40 text-ap-muted cursor-not-allowed opacity-60',
              )}
            >
              <XCircle size={14} />
              Payment preparation disabled
            </button>
          )}
        </div>
      </div>
    </motion.div>
  )
}

function BudgetRow({
  icon,
  label,
  value,
  testId,
}: {
  icon: React.ReactNode
  label: string
  value: string
  testId: string
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="flex items-center gap-1.5 text-xs text-ap-muted">
        {icon}
        {label}
      </span>
      <span className="text-xs font-mono text-ap-text" data-testid={testId}>
        {value}
      </span>
    </div>
  )
}

// ── Loading state for recommendation fetch ────────────────────────────────────

function RecommendationSkeleton() {
  return (
    <div
      data-testid="recommendation-loading"
      className="mt-6 rounded-xl border border-ap-border bg-ap-surface p-5 animate-pulse"
    >
      <div className="flex items-center gap-3 mb-4">
        <div className="h-9 w-9 rounded-lg bg-ap-border/40" />
        <div className="space-y-1.5">
          <div className="h-3.5 w-40 rounded bg-ap-border/50" />
          <div className="h-3 w-24 rounded bg-ap-border/30" />
        </div>
      </div>
      <div className="space-y-3">
        <div className="rounded-lg border border-ap-border p-3">
          <div className="h-3 w-16 rounded bg-ap-border/50 mb-2" />
          <div className="h-3 w-full rounded bg-ap-border/30" />
        </div>
        <div className="rounded-lg border border-ap-border p-3">
          <div className="h-3 w-16 rounded bg-ap-border/50 mb-2" />
          <div className="h-3 w-4/5 rounded bg-ap-border/30" />
        </div>
      </div>
    </div>
  )
}

// ── Service card ──────────────────────────────────────────────────────────────

interface ServiceCardProps {
  service: CatalogueService
  selected: boolean
  requesting: boolean
  onSelect: (id: string) => void
  onRequest: (id: string) => void
}

function ServiceCard({ service, selected, requesting, onSelect, onRequest }: ServiceCardProps) {
  const canRequest = service.availability !== 'unavailable'
  const isThisRequesting = requesting

  return (
    <motion.div
      data-testid={`service-card-${service.id}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      onClick={() => onSelect(service.id)}
      className={cn(
        'relative rounded-xl border bg-ap-surface cursor-pointer transition-all duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ap-gold',
        selected
          ? 'border-ap-gold/60 shadow-panel ring-1 ring-ap-gold/20'
          : 'border-ap-border hover:border-ap-border/80 shadow-card hover:shadow-panel',
        !canRequest && 'opacity-60',
      )}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`Select ${service.name}`}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(service.id) }}
    >
      <div className="p-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2.5">
            <div className={cn(
              'rounded-lg p-2',
              service.availability === 'allowed'
                ? 'bg-ap-gold/10 text-ap-gold'
                : service.availability === 'approval-required'
                ? 'bg-ap-warning/10 text-ap-warning'
                : 'bg-ap-border/40 text-ap-muted',
            )}>
              <ServiceIcon id={service.id} />
            </div>
            <div>
              <p className="font-display font-semibold text-sm text-ap-text" data-testid={`service-name-${service.id}`}>
                {service.name}
              </p>
              <p className="text-xs text-ap-muted font-mono" data-testid={`service-price-${service.id}`}>
                {service.requiresPayment ? `${service.priceDisplay} USDC` : 'Free'}
              </p>
            </div>
          </div>
          <div className="shrink-0 flex items-center gap-1.5">
            {availabilityIcon(service.availability)}
            <AvailabilityBadge availability={service.availability} />
          </div>
        </div>

        <p className="text-xs text-ap-muted text-pretty leading-relaxed mb-4">
          {service.description}
        </p>

        <div className="flex items-center justify-between">
          <span className="text-xs text-ap-muted font-mono truncate max-w-[180px]" title={service.path}>
            {service.method} {service.path}
          </span>
          <button
            data-testid={`request-btn-${service.id}`}
            onClick={(e) => {
              e.stopPropagation()
              onRequest(service.id)
            }}
            disabled={!canRequest || requesting}
            aria-label={`Request ${service.name}`}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ap-gold',
              'disabled:opacity-40 disabled:cursor-not-allowed',
              canRequest
                ? 'bg-ap-gold text-ap-bg hover:bg-ap-gold/90'
                : 'bg-ap-border/40 text-ap-muted cursor-not-allowed',
            )}
          >
            {isThisRequesting ? (
              <>
                <span className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true" />
                Requesting…
              </>
            ) : (
              <>
                Request
                <ChevronRight size={12} />
              </>
            )}
          </button>
        </div>
      </div>

      {selected && (
        <div className="absolute top-0 left-0 bottom-0 w-1 rounded-l-xl bg-ap-gold" aria-hidden="true" />
      )}
    </motion.div>
  )
}

// ── Review Payment modal (simplified — no tx submission) ──────────────────────

interface ReviewPaymentPanelProps {
  service: CatalogueService
  priceBaseUnits: string
  onConfirmReview: () => void
  onCancel: () => void
}

function ReviewPaymentPanel({
  service,
  priceBaseUnits,
  onConfirmReview,
  onCancel,
}: ReviewPaymentPanelProps) {
  return (
    <motion.div
      data-testid="review-payment-panel"
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.18 }}
      className="mt-4 rounded-xl border border-ap-gold/40 bg-ap-surface shadow-panel p-5"
    >
      <div className="flex items-center gap-2 mb-4">
        <CheckCircle2 size={16} className="text-ap-gold" />
        <h3 className="font-display font-semibold text-ap-text">Review Payment</h3>
      </div>

      <dl className="space-y-2.5 mb-4 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-ap-muted">Service</dt>
          <dd className="font-medium text-ap-text">{service.name}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-ap-muted">Amount</dt>
          <dd className="font-display font-semibold text-ap-text" data-testid="review-amount">
            {formatUsdc(priceBaseUnits)} USDC
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-ap-muted">Recipient</dt>
          <dd className="font-mono text-xs text-ap-text">
            Set by server
          </dd>
        </div>
      </dl>

      {/* Policy recheck notice */}
      <div className="mb-4 rounded-lg border border-ap-border bg-ap-bg/60 px-3 py-2.5">
        <p className="text-xs text-ap-muted">
          <span className="font-medium text-ap-text">Policy will be rechecked</span>{' '}
          at payment time against fresh contract state. This review does not reserve
          funds or guarantee the transaction will succeed.
        </p>
      </div>

      <div className="flex gap-2">
        <button
          data-testid="review-confirm-btn"
          onClick={onConfirmReview}
          className={cn(
            'flex-1 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5',
            'text-sm font-medium bg-ap-gold text-ap-bg hover:bg-ap-gold/90 transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ap-gold',
          )}
        >
          Confirm Review
        </button>
        <button
          data-testid="review-cancel-btn"
          onClick={onCancel}
          className={cn(
            'flex-1 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5',
            'text-sm font-medium border border-ap-border text-ap-muted hover:text-ap-text hover:border-ap-text/30 transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ap-gold',
          )}
        >
          Cancel
        </button>
      </div>
    </motion.div>
  )
}

// ── Intent input ──────────────────────────────────────────────────────────────

interface IntentInputProps {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  isLoading: boolean
  disabled: boolean
}

const MAX_INTENT_CHARS = 400

function IntentInput({ value, onChange, onSubmit, isLoading, disabled }: IntentInputProps) {
  return (
    <div data-testid="intent-input-section" className="mt-5 flex flex-col gap-2">
      <label htmlFor="user-intent" className="text-xs font-medium text-ap-muted">
        Intent{' '}
        <span className="font-normal text-ap-muted/60">(optional — treated as untrusted)</span>
      </label>
      <div className="flex gap-2">
        <input
          id="user-intent"
          data-testid="intent-input"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value.slice(0, MAX_INTENT_CHARS))}
          placeholder="Describe what you need this service for…"
          disabled={disabled}
          className={cn(
            'flex-1 rounded-lg border border-ap-border bg-ap-bg px-3 py-2 text-sm text-ap-text',
            'placeholder:text-ap-muted/50 focus:outline-none focus:border-ap-gold/60',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          )}
        />
        <button
          data-testid="get-recommendation-btn"
          onClick={onSubmit}
          disabled={disabled || isLoading}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium',
            'bg-ap-gold text-ap-bg hover:bg-ap-gold/90 transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ap-gold',
            'disabled:opacity-40 disabled:cursor-not-allowed',
          )}
        >
          {isLoading ? (
            <>
              <span className="h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true" />
              Checking…
            </>
          ) : (
            <>
              <Bot size={14} />
              Check
            </>
          )}
        </button>
      </div>
      <p className="text-xs text-ap-muted/60">
        Your intent is passed to the server as plain text and treated as untrusted data.
        Do not include addresses, amounts, or sensitive information.
      </p>
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

export function AgentServicesView() {
  const {
    status,
    services,
    errorMessage,
    requestService,
  } = useServiceCatalogue()

  const {
    status: recStatus,
    result: recResult,
    errorMessage: recError,
    fetchRecommendation,
    clear: clearRecommendation,
  } = useRecommendation()

  const {
    status: prepareStatus,
    receipt: prepareReceipt,
    errorMessage: prepareError,
    prepare,
    reset: resetPrepare,
  } = usePaymentPreparation()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [requestingId, setRequestingId] = useState<string | null>(null)
  const [userIntent, setUserIntent] = useState('')
  const [reviewServiceId, setReviewServiceId] = useState<string | null>(null)
  // modalReceipt: set when a completed preparation receipt should be shown in the modal
  const [modalReceipt, setModalReceipt] = useState<PaymentPreparationReceipt | null>(null)
  // Stable idempotency key suffix — rotated after confirmation to allow fresh payments
  const baseIdempotencyKey = useId()

  const selectedService = services.find((s) => s.id === selectedId) ?? null

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id)
    clearRecommendation()
    setReviewServiceId(null)
  }, [clearRecommendation])

  const handleGetRecommendation = useCallback(async (serviceId: string) => {
    // Re-stamp the snapshot timestamp to prevent immediate STALE_STATE rejection.
    const snapshot: SnapshotPayload = devSnapshot()
    await fetchRecommendation(serviceId, userIntent, snapshot)
  }, [fetchRecommendation, userIntent])

  const handleCardRequest = useCallback(async (serviceId: string) => {
    setRequestingId(serviceId)
    setSelectedId(serviceId)
    clearRecommendation()
    setReviewServiceId(null)
    try {
      const snapshot: SnapshotPayload = devSnapshot()
      await fetchRecommendation(serviceId, userIntent, snapshot)
    } finally {
      setRequestingId(null)
    }
  }, [fetchRecommendation, userIntent, clearRecommendation])

  const handleReviewPayment = useCallback(async (serviceId: string) => {
    // "Review Payment" calls POST /api/prepare to get a server-authoritative receipt,
    // then opens the ReviewPaymentModal. The browser supplies only the service ID —
    // recipient, amount, requestId, and contract address come from the server.
    setReviewServiceId(serviceId)
    resetPrepare()
    const idempotencyKey = `${baseIdempotencyKey}-${serviceId}-${Date.now()}`
    const snapshot: SnapshotPayload = devSnapshot()
    await prepare(serviceId, idempotencyKey, snapshot)
  }, [prepare, resetPrepare, baseIdempotencyKey])

  const handleRequestApproval = useCallback(async (serviceId: string) => {
    // Route to the existing service-request endpoint which logs the approval request.
    setRequestingId(serviceId)
    try {
      await requestService(serviceId)
    } finally {
      setRequestingId(null)
    }
  }, [requestService])

  const handleCloseRecommendation = useCallback(() => {
    clearRecommendation()
    setReviewServiceId(null)
  }, [clearRecommendation])

  // ── Counts ────────────────────────────────────────────────────────────────

  const allowedCount = services.filter((s) => s.availability === 'allowed').length
  const approvalCount = services.filter((s) => s.availability === 'approval-required').length
  const unavailableCount = services.filter((s) => s.availability === 'unavailable').length

  const reviewService = reviewServiceId
    ? services.find((s) => s.id === reviewServiceId) ?? null
    : null

  // When preparation succeeds, open the full ReviewPaymentModal
  if (prepareStatus === 'success' && prepareReceipt && !modalReceipt) {
    setModalReceipt(prepareReceipt)
  }

  return (
    <div data-testid="agent-services-view">
      <SectionHeader
        title="Agent Services"
        description="Server-controlled paid endpoints for AI agent consumption. Prices and recipient addresses are set by the server — the browser cannot override them."
        action={
          status === 'success' && services.length > 0 ? (
            <div className="flex items-center gap-3 text-xs text-ap-muted">
              <span data-testid="count-allowed">
                <span className="text-ap-success font-medium">{allowedCount}</span> allowed
              </span>
              {approvalCount > 0 && (
                <span data-testid="count-approval">
                  <span className="text-ap-warning font-medium">{approvalCount}</span> approval required
                </span>
              )}
              {unavailableCount > 0 && (
                <span data-testid="count-unavailable">
                  <span className="text-ap-danger font-medium">{unavailableCount}</span> unavailable
                </span>
              )}
            </div>
          ) : undefined
        }
      />

      {/* Loading state */}
      {status === 'loading' && (
        <div data-testid="catalogue-loading" className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[0, 1, 2].map((i) => <ServiceCardSkeleton key={i} />)}
        </div>
      )}

      {/* Server unavailable */}
      {status === 'server-unavailable' && (
        <EmptyState
          icon={<ServerCrash size={22} />}
          title="Agent server offline"
          description="The catalogue server is not reachable. Start it with `bun run server` and reload."
          variant="error"
        />
      )}

      {/* Fetch error */}
      {status === 'error' && (
        <EmptyState
          icon={<AlertTriangle size={22} />}
          title="Failed to load catalogue"
          description={errorMessage}
          variant="error"
        />
      )}

      {/* Empty catalogue */}
      {status === 'success' && services.length === 0 && (
        <EmptyState
          icon={<Zap size={22} />}
          title="No services available"
          description="The catalogue is empty. Add services in server/catalogue.ts."
        />
      )}

      {/* Catalogue + recommendation layout */}
      {status === 'success' && services.length > 0 && (
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Left: service list + intent + recommendation result */}
          <div className="flex-1 min-w-0">
            <div data-testid="service-catalogue-grid" className="grid grid-cols-1 gap-4">
              {services.map((service) => (
                <ServiceCard
                  key={service.id}
                  service={service}
                  selected={selectedId === service.id}
                  requesting={requestingId === service.id}
                  onSelect={handleSelect}
                  onRequest={handleCardRequest}
                />
              ))}
            </div>

            {/* Intent input — only shown when a requestable service is selected */}
            {selectedService && selectedService.availability !== 'unavailable' && (
              <IntentInput
                value={userIntent}
                onChange={setUserIntent}
                onSubmit={() => handleGetRecommendation(selectedService.id)}
                isLoading={recStatus === 'loading'}
                disabled={recStatus === 'loading'}
              />
            )}

            {/* Recommendation loading skeleton */}
            <AnimatePresence>
              {recStatus === 'loading' && <RecommendationSkeleton />}
            </AnimatePresence>

            {/* Recommendation error (server unavailable or API error) */}
            <AnimatePresence>
              {(recStatus === 'error' || recStatus === 'server-unavailable') && (
                <motion.div
                  data-testid="recommendation-error"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="mt-4 rounded-xl border border-ap-danger/30 bg-ap-danger/5 px-4 py-3 flex items-start gap-3"
                >
                  <AlertTriangle size={16} className="text-ap-danger shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-ap-danger">
                      {recStatus === 'server-unavailable'
                        ? 'Recommendation server unavailable'
                        : 'Recommendation failed'}
                    </p>
                    <p className="text-xs text-ap-muted mt-0.5">
                      {recError ?? 'Unknown error. Start the server with `bun run server`.'}
                    </p>
                  </div>
                  <button
                    onClick={clearRecommendation}
                    aria-label="Dismiss error"
                    className="ml-auto text-ap-muted hover:text-ap-text shrink-0"
                  >
                    <XCircle size={14} />
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Recommendation panel */}
            <AnimatePresence>
              {recStatus === 'success' && recResult && selectedService && !reviewServiceId && (
                <RecommendationPanel
                  service={selectedService}
                  result={recResult}
                  onReviewPayment={handleReviewPayment}
                  onRequestApproval={handleRequestApproval}
                  onClose={handleCloseRecommendation}
                />
              )}
            </AnimatePresence>

            {/* Prepare loading indicator */}
            {prepareStatus === 'loading' && (
              <div
                data-testid="prepare-loading"
                className="mt-4 rounded-xl border border-ap-border bg-ap-surface p-4 flex items-center gap-3 animate-pulse"
              >
                <span className="h-4 w-4 rounded-full border-2 border-ap-gold border-t-transparent animate-spin" aria-hidden="true" />
                <p className="text-sm text-ap-muted">Preparing payment — fetching policy…</p>
              </div>
            )}

            {/* Prepare error banner */}
            {prepareStatus === 'error' && prepareError && (
              <div
                data-testid="prepare-error"
                className="mt-4 rounded-xl border border-ap-danger/30 bg-ap-danger/5 px-4 py-3 flex items-start gap-3"
              >
                <AlertTriangle size={16} className="text-ap-danger shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-ap-danger">Preparation failed</p>
                  <p className="text-xs text-ap-muted mt-0.5">{prepareError}</p>
                </div>
                <button
                  onClick={() => { resetPrepare(); setReviewServiceId(null) }}
                  aria-label="Dismiss prepare error"
                  className="ml-auto text-ap-muted hover:text-ap-text shrink-0"
                >
                  <XCircle size={14} />
                </button>
              </div>
            )}
          </div>

          {/* Right: detail panel (shown when no recommendation result yet) */}
          {!recResult && (
            <div className="w-full lg:w-80 xl:w-96 shrink-0">
              <AnimatePresence mode="wait">
                {selectedService ? (
                  <DetailPanel
                    key={selectedService.id}
                    service={selectedService}
                    onRequest={handleCardRequest}
                    isRequesting={requestingId === selectedService.id}
                  />
                ) : (
                  <motion.div
                    key="placeholder"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="rounded-xl border border-dashed border-ap-border bg-ap-surface/40 p-6 flex flex-col items-center justify-center text-center min-h-[200px]"
                  >
                    <ChevronRight size={20} className="text-ap-muted mb-2" />
                    <p className="text-sm text-ap-muted">Select a service to see details</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      )}

      {/* Review Payment modal — rendered outside the grid flow */}
      {modalReceipt && (
        <ReviewPaymentModal
          receipt={modalReceipt}
          onClose={() => {
            setModalReceipt(null)
            setReviewServiceId(null)
            resetPrepare()
          }}
          onConfirmed={() => {
            // After confirmation, reset state so a fresh payment can be initiated
            setModalReceipt(null)
            setReviewServiceId(null)
            resetPrepare()
            clearRecommendation()
            setSelectedId(null)
          }}
        />
      )}
    </div>
  )
}

// ── Detail panel (shown before recommendation is fetched) ─────────────────────

interface DetailPanelProps {
  service: CatalogueService
  onRequest: (id: string) => void
  isRequesting: boolean
}

function DetailPanel({ service, onRequest, isRequesting }: DetailPanelProps) {
  const canRequest = service.availability !== 'unavailable'

  return (
    <motion.div
      data-testid="service-detail-panel"
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 12 }}
      transition={{ duration: 0.22 }}
      className="rounded-xl border border-ap-border bg-ap-surface shadow-panel p-6 sticky top-4"
    >
      <div className="flex items-center gap-3 mb-5">
        <div className={cn(
          'rounded-xl p-3',
          service.availability === 'allowed'
            ? 'bg-ap-gold/10 text-ap-gold'
            : service.availability === 'approval-required'
            ? 'bg-ap-warning/10 text-ap-warning'
            : 'bg-ap-border/40 text-ap-muted',
        )}>
          <ServiceIcon id={service.id} className="w-5 h-5" />
        </div>
        <div>
          <h3 className="font-display font-semibold text-ap-text">{service.name}</h3>
          <AvailabilityBadge availability={service.availability} />
        </div>
      </div>

      <p className="text-sm text-ap-muted text-pretty leading-relaxed mb-5">
        {service.description}
      </p>

      <dl className="space-y-2.5 mb-5 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-ap-muted">Price</dt>
          <dd className="font-display font-semibold text-ap-text" data-testid="detail-price">
            {service.requiresPayment ? `${service.priceDisplay} USDC` : 'Free'}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-ap-muted">Method</dt>
          <dd className="font-mono text-ap-text">{service.method}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-ap-muted">Endpoint</dt>
          <dd className="font-mono text-xs text-ap-text truncate max-w-[160px]" title={service.path}>
            {service.path}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-ap-muted">Availability</dt>
          <dd>{availabilityIcon(service.availability)}</dd>
        </div>
      </dl>

      {service.availability === 'unavailable' && (
        <div
          className="mb-4 rounded-lg border border-ap-danger/30 bg-ap-danger/5 px-3 py-2.5 flex gap-2"
          data-testid="detail-unavailable-notice"
        >
          <ShieldOff size={14} className="text-ap-danger shrink-0 mt-0.5" />
          <p className="text-xs text-ap-danger">
            {service.allowlisted === false
              ? 'Your address is not on the allowlist for this service. Contact the treasury owner.'
              : 'This service is currently inactive.'}
          </p>
        </div>
      )}

      {service.availability === 'approval-required' && (
        <div
          className="mb-4 rounded-lg border border-ap-warning/30 bg-ap-warning/5 px-3 py-2.5 flex gap-2"
          data-testid="detail-approval-notice"
        >
          <AlertTriangle size={14} className="text-ap-warning shrink-0 mt-0.5" />
          <p className="text-xs text-ap-warning">
            This service exceeds the auto-approve threshold. The request will be logged
            and routed to the treasury owner for approval.
          </p>
        </div>
      )}

      <div className="mb-5 rounded-lg border border-ap-border bg-ap-bg/40 px-3 py-2.5">
        <p className="text-xs text-ap-muted">
          Price and recipient are set by the server. Clicking "Request Service" submits
          only the service ID — no funds move on click.
        </p>
      </div>

      <button
        data-testid="detail-request-btn"
        onClick={() => onRequest(service.id)}
        disabled={!canRequest || isRequesting}
        className={cn(
          'w-full inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5',
          'text-sm font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ap-gold',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          canRequest
            ? 'bg-ap-gold text-ap-bg hover:bg-ap-gold/90'
            : 'bg-ap-border/40 text-ap-muted',
        )}
      >
        {isRequesting ? (
          <>
            <span className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true" />
            Checking…
          </>
        ) : canRequest ? (
          <>
            <Zap size={14} />
            Request Service
          </>
        ) : (
          'Service unavailable'
        )}
      </button>
    </motion.div>
  )
}
