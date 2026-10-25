/**
 * src/views/AuditLogView.tsx
 *
 * Audit Log page — two-pane view:
 *
 * 1. On-chain events (authoritative): reads PaymentExecuted events from the
 *    ArcPilotTreasury contract via wagmi's useReadContract / getPayments.
 *    These are verifiable by any RPC caller.  Shown with a "On-chain" badge.
 *
 * 2. Off-chain server log (operational metadata): links to the PaymentsView
 *    for status detail, policy decisions, and service delivery.  Shown with
 *    a clear disclaimer that this data is NOT tamper-evident.
 *
 * A payment is only shown in the on-chain pane after it appears in the
 * contract's storage — not before.  There is no fake "pending" row here.
 */

import { useState } from 'react'
import { useReadContract } from 'wagmi'
import { motion } from 'framer-motion'
import {
  ShieldCheck,
  ExternalLink,
  AlertTriangle,
  Database,
  Info,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { ARCPILOT_ABI } from '@/lib/abi'
import { ARC_TESTNET_CHAIN_ID } from '@/config'
import { formatUSDC, formatAddress, getExplorerTxUrl, getExplorerAddressUrl } from '@/lib/utils'
import { SectionHeader } from '@/components/shell/SectionHeader'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'

const PAGE_SIZE = 10

interface AuditLogViewProps {
  contractAddress: `0x${string}` | undefined
}

interface OnChainPayment {
  to: `0x${string}`
  amount: bigint
  timestamp: bigint
  memo: string
}

export function AuditLogView({ contractAddress }: AuditLogViewProps) {
  const [page, setPage] = useState(1)

  // ── Total payment count ────────────────────────────────────────────────────
  const { data: paymentCount, isLoading: countLoading } = useReadContract({
    address: contractAddress,
    abi: ARCPILOT_ABI,
    functionName: 'paymentCount',
    chainId: ARC_TESTNET_CHAIN_ID,
    query: { enabled: !!contractAddress, staleTime: 15_000 },
  })

  const total = Number(paymentCount ?? 0n)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // Most-recent-first: offset = total - (page * PAGE_SIZE), clamped to 0
  const offset = Math.max(0, total - page * PAGE_SIZE)
  const limit = Math.min(PAGE_SIZE, total - offset)

  const { data: rawRecords, isLoading: recLoading, isError } = useReadContract({
    address: contractAddress,
    abi: ARCPILOT_ABI,
    functionName: 'getPayments',
    args: [BigInt(offset), BigInt(limit)],
    chainId: ARC_TESTNET_CHAIN_ID,
    query: {
      enabled: !!contractAddress && total > 0,
      staleTime: 15_000,
    },
  })

  const isLoading = countLoading || recLoading
  // Reverse so the newest record appears first within the page
  const records: OnChainPayment[] = rawRecords ? [...rawRecords].reverse() : []

  return (
    <div data-testid="audit-log-view">
      <SectionHeader
        title="Audit Log"
        description="On-chain payment events from the ArcPilotTreasury contract."
      />

      {/* Authoritative-source notice */}
      <div
        role="note"
        aria-label="On-chain data source"
        data-testid="onchain-notice"
        className="mb-4 rounded-lg border border-ap-success/30 bg-ap-success/8 px-4 py-2.5 flex items-start gap-2"
      >
        <ShieldCheck size={14} className="text-ap-success shrink-0 mt-0.5" />
        <p className="text-xs text-ap-success leading-relaxed">
          These records are read directly from the ArcPilotTreasury contract on Arc Testnet.
          They are verifiable by any RPC caller and cannot be altered without a new on-chain
          transaction. Contract:{' '}
          {contractAddress ? (
            <a
              href={getExplorerAddressUrl(contractAddress)}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:no-underline"
            >
              {formatAddress(contractAddress)}
            </a>
          ) : (
            'not configured'
          )}
        </p>
      </div>

      {/* Off-chain log notice */}
      <div
        role="note"
        data-testid="offchain-notice"
        className="mb-6 rounded-lg border border-ap-warning/30 bg-ap-warning/8 px-4 py-2.5 flex items-start gap-2"
      >
        <Database size={14} className="text-ap-warning shrink-0 mt-0.5" />
        <p className="text-xs text-ap-warning leading-relaxed">
          Policy decisions, service-delivery status, and request metadata are stored in the
          server&apos;s off-chain log. That log is{' '}
          <strong>not tamper-evident</strong> and is lost if the server restarts. See the{' '}
          <strong>Payment History</strong> tab for this operational metadata.
        </p>
      </div>

      {/* No contract configured */}
      {!contractAddress && (
        <div data-testid="audit-no-contract">
          <EmptyState
            icon={<AlertTriangle size={22} />}
            title="No contract configured"
            description="Paste a deployed ArcPilotTreasury address in the Treasury section first."
          />
        </div>
      )}

      {/* Loading */}
      {contractAddress && isLoading && <AuditSkeleton />}

      {/* Error */}
      {contractAddress && isError && !isLoading && (
        <div data-testid="audit-error">
          <EmptyState
            variant="error"
            icon={<AlertTriangle size={22} />}
            title="RPC error"
            description="Could not read payment events from the contract. Check RPC connectivity."
          />
        </div>
      )}

      {/* Empty */}
      {contractAddress && !isLoading && !isError && total === 0 && (
        <div data-testid="audit-empty">
          <EmptyState
            icon={<Info size={22} />}
            title="No on-chain payments yet"
            description="Execute a payment through the treasury contract to see it appear here."
          />
        </div>
      )}

      {/* Table */}
      {contractAddress && !isLoading && !isError && total > 0 && (
        <>
          <div className="flex items-center justify-between mb-3 text-xs text-ap-muted">
            <span data-testid="audit-total">
              {total} on-chain payment{total !== 1 ? 's' : ''}
            </span>
            <Badge variant="success" className="text-[10px]">
              <ShieldCheck size={10} className="mr-1" />
              On-chain
            </Badge>
          </div>

          <div
            className="rounded-xl border border-ap-border bg-ap-surface overflow-hidden"
            data-testid="audit-table"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm" role="table" aria-label="On-chain audit log">
                <thead>
                  <tr className="border-b border-ap-border">
                    {['#', 'Recipient', 'Amount', 'Memo', 'Timestamp', 'Explorer'].map((h) => (
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
                  {records.map((rec, i) => {
                    // Global index: newest page = highest IDs
                    const globalIdx = total - 1 - ((page - 1) * PAGE_SIZE + i)
                    return (
                      <AuditRow
                        key={`${page}-${i}`}
                        record={rec}
                        index={globalIdx}
                      />
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {totalPages > 1 && (
            <AuditPagination page={page} totalPages={totalPages} setPage={setPage} />
          )}
        </>
      )}
    </div>
  )
}

// ── Table row ──────────────────────────────────────────────────────────────────

function AuditRow({ record: r, index }: { record: OnChainPayment; index: number }) {
  const ts = new Date(Number(r.timestamp) * 1000)
  const dateStr = ts.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const timeStr = ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

  return (
    <motion.tr
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18 }}
      className="border-b border-ap-border/50 last:border-0 hover:bg-ap-elevated/40 transition-colors duration-100"
      data-testid={`audit-row-${index}`}
    >
      {/* Index */}
      <td className="px-4 py-3 w-12">
        <span className="font-mono text-xs text-ap-muted">#{index}</span>
      </td>

      {/* Recipient */}
      <td className="px-4 py-3 min-w-[120px]">
        <a
          href={getExplorerAddressUrl(r.to)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs text-ap-text hover:text-ap-gold transition-colors"
          title={r.to}
          data-testid="audit-recipient"
        >
          {formatAddress(r.to)}
        </a>
      </td>

      {/* Amount */}
      <td className="px-4 py-3 text-right tabular-nums min-w-[100px]">
        <span
          className="font-display font-semibold text-ap-text text-sm"
          data-testid="audit-amount"
        >
          {formatUSDC(r.amount)}
        </span>
        <div className="text-[10px] text-ap-muted">USDC</div>
      </td>

      {/* Memo */}
      <td className="px-4 py-3 max-w-[200px]">
        <span
          className="text-xs text-ap-muted truncate block"
          title={r.memo || '—'}
          data-testid="audit-memo"
        >
          {r.memo || <span className="italic">—</span>}
        </span>
      </td>

      {/* Timestamp */}
      <td className="px-4 py-3 min-w-[130px]">
        <span className="text-xs text-ap-text">{dateStr}</span>
        <div className="text-[10px] text-ap-muted">{timeStr}</div>
      </td>

      {/* Explorer link — no tx hash in contract storage; link to block if needed */}
      <td className="px-4 py-3">
        <span
          className="text-xs text-ap-muted"
          title="Tx hash not stored in contract state. Find this event by querying PaymentExecuted logs."
          data-testid="audit-no-tx-note"
        >
          <Info size={12} className="inline-block mr-1 text-ap-muted/60" />
          See logs
        </span>
      </td>
    </motion.tr>
  )
}

// ── Skeleton ───────────────────────────────────────────────────────────────────

function AuditSkeleton() {
  return (
    <div
      className="rounded-xl border border-ap-border bg-ap-surface overflow-hidden animate-pulse"
      data-testid="audit-loading"
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="border-b border-ap-border/50 px-4 py-3 flex gap-6 items-center">
          <Skeleton className="h-4 w-8" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  )
}

// ── Pagination ─────────────────────────────────────────────────────────────────

function AuditPagination({
  page,
  totalPages,
  setPage,
}: {
  page: number
  totalPages: number
  setPage: (p: number) => void
}) {
  return (
    <div className="flex items-center justify-between mt-3" data-testid="audit-pagination">
      <button
        onClick={() => setPage(Math.max(1, page - 1))}
        disabled={page <= 1}
        aria-label="Previous page"
        className="inline-flex items-center gap-1 rounded-lg border border-ap-border px-3 py-1.5 text-xs text-ap-muted hover:text-ap-text hover:bg-ap-border/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ap-gold"
      >
        <ChevronLeft size={13} /> Prev
      </button>
      <span className="text-xs text-ap-muted tabular-nums">{page} / {totalPages}</span>
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
