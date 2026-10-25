/**
 * src/views/PaymentsView.tsx
 *
 * Payment History page.
 *
 * Shows the server-side off-chain payment log with full status detail:
 * request ID, service, recipient, amount, chain, contract, payment status,
 * tx hash + explorer link, policy decision, and service-delivery status.
 *
 * DATA PROVENANCE — prominently shown to the user:
 *   This data comes from the server's in-memory log, not the blockchain.
 *   It is NOT tamper-evident.  The contract's PaymentExecuted events are
 *   the authoritative record.
 *
 * A payment is only labelled "Confirmed" after the server verifies the
 * receipt AND checks that the logged to/amount match.  Unverifiable tx
 * hashes are labelled "Unknown".
 */

import { ExternalLink, AlertCircle, Info, ChevronLeft, ChevronRight } from 'lucide-react'
import { motion } from 'framer-motion'
import { SectionHeader } from '@/components/shell/SectionHeader'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { usePaymentHistory } from '@/hooks/usePaymentHistory'
import { getExplorerTxUrl, getExplorerAddressUrl, formatAddress } from '@/lib/utils'
import type {
  PaymentHistoryRecord,
  PaymentFlowState,
  ServiceDeliveryStatus,
} from '../../shared/types'

// ── Status metadata ────────────────────────────────────────────────────────────

type BadgeVariant = 'success' | 'danger' | 'warning' | 'info' | 'neutral' | 'gold'

interface StatusMeta {
  label: string
  variant: BadgeVariant
  dot: boolean
}

/**
 * Display metadata for every PaymentFlowState value.
 * Covers the full state machine: flow states, exception states, and Unknown.
 */
const PAYMENT_STATUS_META: Record<PaymentFlowState, StatusMeta> = {
  Draft:             { label: 'Draft',               variant: 'neutral',  dot: false },
  PolicyChecked:     { label: 'Policy checked',      variant: 'info',     dot: false },
  ApprovalRequired:  { label: 'Approval required',   variant: 'gold',     dot: true  },
  Ready:             { label: 'Ready',                variant: 'info',     dot: true  },
  Submitted:         { label: 'Submitted',            variant: 'neutral',  dot: true  },
  Confirmed:         { label: 'Confirmed',            variant: 'success',  dot: true  },
  Denied:            { label: 'Denied',               variant: 'danger',   dot: false },
  RejectedByWallet:  { label: 'Rejected by wallet',  variant: 'danger',   dot: false },
  Reverted:          { label: 'Reverted',             variant: 'danger',   dot: true  },
  Cancelled:         { label: 'Cancelled',            variant: 'neutral',  dot: false },
  Unknown:           { label: 'Unknown',              variant: 'warning',  dot: false },
}

/**
 * Display metadata for every ServiceDeliveryStatus value.
 * Delivery is tracked independently of payment flow state.
 */
const DELIVERY_STATUS_META: Record<ServiceDeliveryStatus, StatusMeta> = {
  'not-requested': { label: 'Not requested', variant: 'neutral', dot: false },
  'pending':       { label: 'Pending',       variant: 'warning', dot: true  },
  'succeeded':     { label: 'Succeeded',     variant: 'success', dot: true  },
  'failed':        { label: 'Failed',        variant: 'danger',  dot: false },
  'unknown':       { label: 'Unknown',       variant: 'warning', dot: false },
}

const POLICY_VERDICT_META: Record<'allowed' | 'approval-required' | 'denied', StatusMeta> = {
  'allowed':           { label: 'Allowed',           variant: 'success', dot: false },
  'approval-required': { label: 'Approval required', variant: 'gold',    dot: false },
  'denied':            { label: 'Denied',             variant: 'danger',  dot: false },
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PaymentsView() {
  const {
    status,
    records,
    total,
    page,
    totalPages,
    pageSize,
    provenanceNotice,
    errorMessage,
    setPage,
  } = usePaymentHistory(10)

  return (
    <div data-testid="payments-view">
      <SectionHeader
        title="Payment History"
        description="Off-chain server log of payment requests. See the Audit Log tab for verifiable on-chain events."
      />

      {/* Provenance notice — always visible */}
      <ProvenanceNotice message={provenanceNotice} />

      {/* Body */}
      {status === 'loading' && <HistoryTableSkeleton />}

      {(status === 'error' || status === 'server-unavailable') && (
        <div data-testid="payments-error">
          <EmptyState
            variant="error"
            icon={<AlertCircle size={22} />}
            title={status === 'server-unavailable' ? 'Server unavailable' : 'Failed to load history'}
            description={errorMessage ?? 'Could not reach the payment server. Start it with: bun run server'}
          />
        </div>
      )}

      {status === 'empty' && (
        <div data-testid="payments-empty">
          <EmptyState
            icon={<Info size={22} />}
            title="No payment records yet"
            description="Payments will appear here as they are submitted through the Agent Services page."
          />
        </div>
      )}

      {status === 'success' && (
        <>
          {/* Summary row */}
          <div className="flex items-center justify-between mb-3 text-xs text-ap-muted">
            <span data-testid="payments-total">{total} total record{total !== 1 ? 's' : ''}</span>
            <span>Page {page} of {totalPages}</span>
          </div>

          {/* Table */}
          <div
            className="rounded-xl border border-ap-border bg-ap-surface overflow-hidden"
            data-testid="payments-table"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm" role="table" aria-label="Payment history">
                <thead>
                  <tr className="border-b border-ap-border">
                    {['Request', 'Service', 'Recipient', 'Amount', 'Payment', 'Policy', 'Delivery', 'Tx'].map((h) => (
                      <th
                        key={h}
                        scope="col"
                        className="px-4 py-3 text-xs font-medium uppercase tracking-caps text-ap-muted text-left"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {records.map((rec) => (
                    <PaymentRow key={rec.id} record={rec} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <Pagination page={page} totalPages={totalPages} setPage={setPage} />
          )}
        </>
      )}
    </div>
  )
}

// ── Table row ──────────────────────────────────────────────────────────────────

function PaymentRow({ record: r }: { record: PaymentHistoryRecord }) {
  const payMeta  = PAYMENT_STATUS_META[r.flowState]  ?? PAYMENT_STATUS_META.Unknown
  const delMeta  = DELIVERY_STATUS_META[r.deliveryStatus] ?? DELIVERY_STATUS_META['not-requested']
  const polMeta  = POLICY_VERDICT_META[r.policyDecision.verdict]

  const ts = new Date(r.submittedAt)
  const dateStr = ts.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const timeStr = ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

  // Truncate requestId for display
  const reqDisplay = r.requestId.length > 10
    ? `${r.requestId.slice(0, 6)}…${r.requestId.slice(-4)}`
    : r.requestId

  return (
    <motion.tr
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18 }}
      className="border-b border-ap-border/50 last:border-0 hover:bg-ap-elevated/40 transition-colors duration-100"
      data-testid={`payment-row-${r.id}`}
    >
      {/* Request ID + timestamp */}
      <td className="px-4 py-3 min-w-[120px]">
        <span
          className="font-mono text-xs text-ap-text"
          title={r.requestId}
          data-testid="payment-request-id"
        >
          {reqDisplay}
        </span>
        <div className="text-[10px] text-ap-muted mt-0.5">
          {r.simulated && <span className="text-ap-warning mr-1">[sim]</span>}
          {dateStr} {timeStr}
        </div>
      </td>

      {/* Service */}
      <td className="px-4 py-3 min-w-[130px]">
        {r.serviceId ? (
          <span className="text-xs font-mono text-ap-text">{r.serviceId}</span>
        ) : (
          <span className="text-xs text-ap-muted italic">direct</span>
        )}
        <div className="text-[10px] text-ap-muted mt-0.5">{r.chain}</div>
      </td>

      {/* Recipient */}
      <td className="px-4 py-3 min-w-[120px]">
        <a
          href={getExplorerAddressUrl(r.to)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs text-ap-text hover:text-ap-gold transition-colors"
          title={r.to}
          data-testid="payment-recipient"
        >
          {formatAddress(r.to)}
        </a>
        <div className="text-[10px] text-ap-muted mt-0.5">{r.contractAddress ? formatAddress(r.contractAddress) : '—'}</div>
      </td>

      {/* Amount */}
      <td className="px-4 py-3 text-right tabular-nums min-w-[100px]">
        <span
          className="font-display font-semibold text-ap-text text-sm"
          data-testid="payment-amount"
        >
          {r.amountDisplay}
        </span>
        <div className="text-[10px] text-ap-muted mt-0.5">{r.token}</div>
      </td>

      {/* Payment status */}
      <td className="px-4 py-3 min-w-[110px]">
        <Badge variant={payMeta.variant} dot={payMeta.dot} data-testid="payment-status">
          {payMeta.label}
        </Badge>
        {r.flowState === 'Confirmed' && r.confirmedAt && (
          <div className="text-[10px] text-ap-muted mt-0.5">
            {new Date(r.confirmedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
      </td>

      {/* Policy decision */}
      <td className="px-4 py-3 min-w-[140px]">
        <Badge variant={polMeta.variant} data-testid="payment-policy">
          {polMeta.label}
        </Badge>
        <div
          className="text-[10px] text-ap-muted mt-0.5 max-w-[160px] truncate"
          title={`${r.policyDecision.code}: ${r.policyDecision.reason}`}
        >
          {r.policyDecision.code}
        </div>
      </td>

      {/* Delivery status */}
      <td className="px-4 py-3 min-w-[110px]">
        <Badge variant={delMeta.variant} dot={delMeta.dot} data-testid="payment-delivery">
          {delMeta.label}
        </Badge>
      </td>

      {/* Tx hash */}
      <td className="px-4 py-3 min-w-[80px]">
        {r.txHash ? (
          <a
            href={getExplorerTxUrl(r.txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-mono text-[11px] text-ap-gold hover:text-ap-gold/80 transition-colors"
            title={r.txHash}
            data-testid="payment-tx-link"
          >
            {r.txHash.slice(0, 6)}…{r.txHash.slice(-4)}
            <ExternalLink size={10} />
          </a>
        ) : (
          <span className="text-xs text-ap-muted" data-testid="payment-no-tx">—</span>
        )}
      </td>
    </motion.tr>
  )
}

// ── Provenance notice ──────────────────────────────────────────────────────────

function ProvenanceNotice({ message }: { message: string }) {
  return (
    <div
      role="note"
      aria-label="Data provenance"
      data-testid="provenance-notice"
      className="mb-4 rounded-lg border border-ap-info/30 bg-ap-info/8 px-4 py-2.5 flex items-start gap-2"
    >
      <Info size={14} className="text-ap-info shrink-0 mt-0.5" />
      <p className="text-xs text-ap-info leading-relaxed">{message}</p>
    </div>
  )
}

// ── Skeleton ───────────────────────────────────────────────────────────────────

const SKELETON_WIDTHS = ['w-28', 'w-20', 'w-24', 'w-16', 'w-20', 'w-24', 'w-20', 'w-16']

function HistoryTableSkeleton() {
  return (
    <div
      className="rounded-xl border border-ap-border bg-ap-surface overflow-hidden animate-pulse"
      data-testid="payments-loading"
    >
      <div className="border-b border-ap-border px-4 py-3 flex gap-6">
        {SKELETON_WIDTHS.map((w, i) => (
          <Skeleton key={i} className={`h-3 ${w}`} />
        ))}
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="border-b border-ap-border/50 px-4 py-3 flex gap-6 items-center">
          {SKELETON_WIDTHS.map((w, j) => (
            <Skeleton key={j} className={`h-4 ${w}`} />
          ))}
        </div>
      ))}
    </div>
  )
}

// ── Pagination ─────────────────────────────────────────────────────────────────

function Pagination({
  page,
  totalPages,
  setPage,
}: {
  page: number
  totalPages: number
  setPage: (p: number) => void
}) {
  return (
    <div
      className="flex items-center justify-between mt-3"
      data-testid="pagination"
    >
      <button
        onClick={() => setPage(Math.max(1, page - 1))}
        disabled={page <= 1}
        aria-label="Previous page"
        className="inline-flex items-center gap-1 rounded-lg border border-ap-border px-3 py-1.5 text-xs text-ap-muted hover:text-ap-text hover:bg-ap-border/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ap-gold"
      >
        <ChevronLeft size={13} /> Prev
      </button>

      <span className="text-xs text-ap-muted tabular-nums">
        {page} / {totalPages}
      </span>

      <button
        onClick={() => setPage(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
        aria-label="Next page"
        className="inline-flex items-center gap-1 rounded-lg border border-ap-border px-3 py-1.5 text-xs text-ap-muted hover:text-ap-text hover:bg-ap-border/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ap-gold"
      >
        Next <ChevronRight size={13} />
      </button>
    </div>
  )
}
