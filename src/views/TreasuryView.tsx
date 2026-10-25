import { motion } from 'framer-motion'
import {
  RefreshCw, Vault, TrendingDown, Shield, Zap,
  Clock, AlertCircle, ExternalLink,
} from 'lucide-react'
import { SectionHeader } from '@/components/shell/SectionHeader'
import { TreasuryStateGuard, DevModeBanner } from '@/components/TreasuryStateGuard'
import { MetricCard } from '@/components/ui/MetricCard'
import { Badge } from '@/components/ui/Badge'
import { SkeletonCard } from '@/components/ui/Skeleton'
import { ContractInput } from '@/components/ContractInput'
import { DepositPanel } from '@/components/DepositPanel'
import { useTreasuryData } from '@/hooks/useTreasuryData'
import { UINT256_MAX_STR } from '@/lib/treasury-adapter'
import { ARCPILOT_ADDRESS } from '@/config'
import { formatUSDC, formatPercent, getExplorerAddressUrl } from '@/lib/utils'

interface TreasuryViewProps {
  contractAddress: `0x${string}` | undefined
  onContractChange: (addr: `0x${string}` | undefined) => void
}

const USDC_DECIMALS = 6

function fmtUsdc(val: bigint): string {
  return `$${formatUSDC(val, USDC_DECIMALS)}`
}
function fmtRemaining(val: bigint): string {
  return val.toString() === UINT256_MAX_STR ? '∞' : fmtUsdc(val)
}

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.22, delay, ease: [0.25, 0.1, 0.25, 1.0] as const },
})

export function TreasuryView({ contractAddress, onContractChange }: TreasuryViewProps) {
  const addr = contractAddress ?? ARCPILOT_ADDRESS
  const { status, data, lastUpdated, errorMessage, refetch } = useTreasuryData(addr)
  const isDev = status === 'dev'
  const isLoading = status === 'loading'

  return (
    <div data-testid="treasury-view">
      {isDev && <DevModeBanner />}

      <SectionHeader
        title="Treasury"
        description={
          isDev
            ? 'Development data — connect a wallet on Arc Testnet for live values.'
            : 'Live USDC balance, reserve, obligations, and spending limits from the deployed contract.'
        }
        action={
          <div className="flex items-center gap-2">
            {data && lastUpdated && (
              <span className="text-xs text-ap-muted hidden sm:block">
                Updated {new Date(lastUpdated).toLocaleTimeString()}
              </span>
            )}
            {data?.paused && <Badge variant="danger" dot>Paused</Badge>}
            {data && !data.paused && status === 'success' && <Badge variant="success" dot>Active</Badge>}
            <button
              onClick={refetch}
              title="Refresh data"
              aria-label="Refresh treasury data"
              className="p-1.5 rounded-lg hover:bg-ap-elevated text-ap-muted hover:text-ap-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ap-gold"
            >
              <RefreshCw size={13} />
            </button>
          </div>
        }
      />

      {/* ── Contract selector ── */}
      <div className="mb-4">
        <ContractInput value={contractAddress} onChange={onContractChange} />
      </div>

      {/* ── Loading skeletons ── */}
      {isLoading && (
        <div className="space-y-4 mb-4" data-testid="treasury-loading">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            {[...Array(4)].map((_, i) => <SkeletonCard key={i} />)}
          </div>
          <SkeletonCard className="h-40" />
        </div>
      )}

      {/* ── All states rendered through the guard ── */}
      <TreasuryStateGuard status={status} errorMessage={errorMessage}>
        {data && (
          <div className="space-y-4">

            {/* Metric row */}
            <motion.div
              {...fadeUp(0)}
              className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3"
              data-testid="treasury-metrics"
            >
              <MetricCard
                label="Treasury Balance"
                value={fmtUsdc(data.totalBalance)}
                subtext={<>USDC · ERC-20 view{isDev && <span className="ml-1 text-ap-warning text-[10px]">[DEV]</span>}</>}
                icon={<Vault size={15} />}
                accent
                loading={isLoading}
              />
              <MetricCard
                label="Spendable"
                value={fmtUsdc(data.spendable)}
                subtext="After obligations &amp; reserve"
                icon={<Zap size={15} />}
                loading={isLoading}
              />
              <MetricCard
                label="Obligations"
                value={fmtUsdc(data.obligations)}
                subtext={
                  <span className="inline-flex items-center gap-1">
                    Configured obligations
                    <span className="text-ap-warning text-[10px]">[configured]</span>
                  </span>
                }
                icon={<TrendingDown size={15} />}
                loading={isLoading}
              />
              <MetricCard
                label="Reserve"
                value={fmtUsdc(data.reserve)}
                subtext={`${data.reserveBps / 100}% of balance (${data.reserveBps} bps)`}
                icon={<Shield size={15} />}
                loading={isLoading}
              />
            </motion.div>

            {/* Allocation bar */}
            {data.totalBalance > 0n && (
              <motion.div
                {...fadeUp(0.04)}
                className="rounded-xl border border-ap-border bg-ap-surface p-5"
                data-testid="allocation-breakdown"
              >
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs uppercase tracking-caps text-ap-muted">
                    Balance Allocation
                    {isDev && <span className="ml-2 text-ap-warning">[DEV DATA]</span>}
                  </p>
                  <span className="text-xs text-ap-muted tabular-nums">{fmtUsdc(data.totalBalance)} total</span>
                </div>

                {/* Segmented bar */}
                <div
                  className="h-3 rounded-full bg-ap-border/60 overflow-hidden flex mb-4"
                  role="img"
                  aria-label="Balance allocation: obligations, reserve, spendable"
                >
                  <div
                    className="bg-ap-danger/70 h-full transition-all duration-500"
                    style={{ width: `${formatPercent(data.obligations, data.totalBalance)}%` }}
                    title={`Obligations: ${fmtUsdc(data.obligations)}`}
                  />
                  <div
                    className="bg-ap-info/70 h-full transition-all duration-500"
                    style={{ width: `${formatPercent(data.reserve, data.totalBalance)}%` }}
                    title={`Reserve: ${fmtUsdc(data.reserve)}`}
                  />
                  <div
                    className="bg-ap-success/70 h-full transition-all duration-500"
                    style={{ width: `${formatPercent(data.spendable, data.totalBalance)}%` }}
                    title={`Spendable: ${fmtUsdc(data.spendable)}`}
                  />
                </div>

                {/* Legend */}
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <AllocationRow
                    dot="bg-ap-danger/70"
                    label="Obligations"
                    note="configured"
                    value={fmtUsdc(data.obligations)}
                    pct={formatPercent(data.obligations, data.totalBalance)}
                  />
                  <AllocationRow
                    dot="bg-ap-info/70"
                    label={`Reserve (${data.reserveBps / 100}%)`}
                    value={fmtUsdc(data.reserve)}
                    pct={formatPercent(data.reserve, data.totalBalance)}
                  />
                  <AllocationRow
                    dot="bg-ap-success/70"
                    label="Spendable"
                    value={fmtUsdc(data.spendable)}
                    pct={formatPercent(data.spendable, data.totalBalance)}
                  />
                </div>
              </motion.div>
            )}

            {/* Daily spending limits */}
            <motion.div
              {...fadeUp(0.07)}
              className="rounded-xl border border-ap-border bg-ap-surface p-5"
              data-testid="daily-limits"
            >
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs uppercase tracking-caps text-ap-muted flex items-center gap-1.5">
                  <Clock size={12} aria-hidden />
                  Daily Spending Limits
                  {isDev && <span className="text-ap-warning">[DEV DATA]</span>}
                </p>
                {data.globalDailyLimit === 0n && (
                  <Badge variant="neutral">No daily cap</Badge>
                )}
              </div>

              {data.globalDailyLimit > 0n ? (
                <>
                  <div className="mt-3 mb-1 flex justify-between text-xs text-ap-muted tabular-nums">
                    <span>{fmtUsdc(data.globalSpentToday)} spent today</span>
                    <span>{fmtRemaining(data.dailyRemaining)} remaining</span>
                  </div>
                  <div
                    className="h-2 rounded-full bg-ap-border/60 overflow-hidden"
                    role="progressbar"
                    aria-valuenow={Number(data.globalSpentToday)}
                    aria-valuemax={Number(data.globalDailyLimit)}
                    aria-label="Daily spending progress"
                  >
                    <div
                      className="h-full rounded-full bg-ap-gold transition-all duration-500"
                      style={{ width: `${formatPercent(data.globalSpentToday, data.globalDailyLimit)}%` }}
                    />
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
                    <LimitStat label="Limit" value={fmtUsdc(data.globalDailyLimit)} />
                    <LimitStat label="Spent" value={fmtUsdc(data.globalSpentToday)} dim />
                    <LimitStat label="Remaining" value={fmtRemaining(data.dailyRemaining)} gold />
                  </div>
                </>
              ) : (
                <p className="mt-2 text-xs text-ap-muted">
                  No global daily limit is configured. Individual payees may still have per-payee daily limits.
                </p>
              )}

              {/* Per-tx cap */}
              {data.maxTxAmount > 0n && (
                <div className="mt-3 pt-3 border-t border-ap-border flex items-center justify-between text-xs">
                  <span className="text-ap-muted">Per-transaction cap</span>
                  <span className="tabular-nums text-ap-text font-medium">{fmtUsdc(data.maxTxAmount)}</span>
                </div>
              )}
            </motion.div>

            {/* Paused warning */}
            {data.paused && (
              <motion.div
                {...fadeUp(0.08)}
                role="alert"
                className="flex items-start gap-2 rounded-xl border border-ap-danger/30 bg-ap-danger/5 p-4"
                data-testid="paused-banner"
              >
                <AlertCircle size={14} className="text-ap-danger mt-0.5 shrink-0" />
                <div className="text-xs">
                  <p className="font-semibold text-ap-danger">Contract is paused</p>
                  <p className="text-ap-muted mt-0.5">
                    Deposit, payment, and withdrawal functions are currently disabled.
                    Only the configured Pauser role can unpause.
                  </p>
                </div>
              </motion.div>
            )}

            {/* Contract info strip */}
            <motion.div
              {...fadeUp(0.1)}
              className="rounded-xl border border-ap-border bg-ap-surface/50 px-4 py-3 text-xs flex flex-wrap gap-x-5 gap-y-1.5"
            >
              <InfoPill label="Contract" value={addr} link={getExplorerAddressUrl(addr)} />
              <InfoPill label="Payments" value={String(data.paymentCount)} />
              <InfoPill label="Active payees" value={String(data.payeeCount)} />
              <InfoPill label="Network" value="Arc Testnet · 5042002" />
            </motion.div>

            {/* Deposit panel */}
            <motion.div {...fadeUp(0.12)}>
              <DepositPanel contractAddress={addr} />
            </motion.div>

          </div>
        )}
      </TreasuryStateGuard>

      {/* Wrong-network / error inline hint */}
      {(status === 'wrong-network' || status === 'error') && (
        <motion.div
          {...fadeUp(0.05)}
          className="mt-4 rounded-xl border border-ap-danger/30 bg-ap-danger/5 px-4 py-3 flex items-start gap-2"
          role="alert"
          data-testid="error-banner"
        >
          <AlertCircle size={14} className="text-ap-danger mt-0.5 shrink-0" />
          <p className="text-xs text-ap-danger">
            {status === 'wrong-network'
              ? 'Connected to the wrong network. Switch to Arc Testnet (chain ID 5042002) to load live data.'
              : (errorMessage ?? 'Contract read failed — check RPC connectivity.')}
          </p>
        </motion.div>
      )}
    </div>
  )
}

function AllocationRow({
  dot, label, note, value, pct,
}: {
  dot: string; label: string; note?: string; value: string; pct: string
}) {
  return (
    <div className="flex items-start gap-1.5">
      <span className={`w-2 h-2 rounded-sm mt-0.5 shrink-0 ${dot}`} aria-hidden />
      <div>
        <p className="text-ap-muted">
          {label}
          {note && <span className="ml-1 text-ap-warning text-[10px]">[{note}]</span>}
        </p>
        <p className="text-ap-text tabular-nums font-medium">
          {value} <span className="text-ap-muted font-normal">({pct}%)</span>
        </p>
      </div>
    </div>
  )
}

function LimitStat({ label, value, dim, gold }: { label: string; value: string; dim?: boolean; gold?: boolean }) {
  return (
    <div>
      <p className="text-ap-muted">{label}</p>
      <p className={`tabular-nums font-medium ${gold ? 'text-ap-gold' : dim ? 'text-ap-muted' : 'text-ap-text'}`}>
        {value}
      </p>
    </div>
  )
}

function InfoPill({ label, value, link }: { label: string; value: string; link?: string }) {
  const text = value.startsWith('0x') && value.length > 20
    ? `${value.slice(0, 8)}…${value.slice(-6)}`
    : value
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-ap-muted uppercase tracking-caps">{label}</span>
      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 font-mono text-ap-text hover:text-ap-gold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ap-gold rounded"
          aria-label={`Open ${label} on explorer`}
        >
          {text}
          <ExternalLink size={10} className="text-ap-muted" aria-hidden />
        </a>
      ) : (
        <span className="text-ap-text">{text}</span>
      )}
    </span>
  )
}
