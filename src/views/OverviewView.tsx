import { motion } from 'framer-motion'
import {
  Vault, ArrowLeftRight, Bot, ShieldCheck, RefreshCw,
  TrendingDown, Shield, Zap, Clock, AlertCircle,
} from 'lucide-react'
import { useReadContracts } from 'wagmi'
import { MetricCard } from '@/components/ui/MetricCard'
import { Badge } from '@/components/ui/Badge'
import { SectionHeader } from '@/components/shell/SectionHeader'
import { TreasuryStateGuard, DevModeBanner } from '@/components/TreasuryStateGuard'
import { useTreasuryData } from '@/hooks/useTreasuryData'
import { ARCPILOT_ABI } from '@/lib/abi'
import { ADAPTER_MODE, UINT256_MAX_STR } from '@/lib/treasury-adapter'
import { ARC_TESTNET_CHAIN_ID, ARCPILOT_ADDRESS, USDC_ADDRESS } from '@/config'
import { formatUSDC, formatPercent, getExplorerAddressUrl } from '@/lib/utils'
import type { NavSection } from '@/components/shell/Sidebar'
import { ExternalLink } from 'lucide-react'

const USDC_DECIMALS = 6

function fmtUsdc(val: bigint): string {
  return `$${formatUSDC(val, USDC_DECIMALS)}`
}

/** Format daily remaining — returns '∞' when uncapped */
function fmtRemaining(val: bigint): string {
  if (val.toString() === UINT256_MAX_STR) return '∞'
  return fmtUsdc(val)
}

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.22, delay, ease: [0.25, 0.1, 0.25, 1.0] as const },
})

interface OverviewViewProps {
  contractAddress: `0x${string}` | undefined
  onNav: (s: NavSection) => void
}

export function OverviewView({ contractAddress, onNav }: OverviewViewProps) {
  const addr = contractAddress ?? ARCPILOT_ADDRESS
  const { status, data, lastUpdated, errorMessage, refetch } = useTreasuryData(addr)

  // Recent payments — separate paginated read (offset 0, limit 5)
  const { data: recentPaymentsResult } = useReadContracts({
    contracts: [{
      address: addr,
      abi: ARCPILOT_ABI,
      chainId: ARC_TESTNET_CHAIN_ID,
      functionName: 'getPayments',
      args: [0n, 5n],
    }],
    query: { enabled: status === 'success', staleTime: 10_000 },
  })

  const recentPayments = (recentPaymentsResult?.[0]?.status === 'success'
    ? recentPaymentsResult[0].result
    : []) as Array<{ to: string; amount: bigint; timestamp: bigint; requestId: `0x${string}`; memo: string }>

  const isLoading = status === 'loading'
  const isDev = status === 'dev'

  return (
    <div data-testid="overview-view">
      {isDev && <DevModeBanner />}

      <SectionHeader
        title="Overview"
        description={
          isDev
            ? 'Development data — connect a wallet and switch to Arc Testnet for live values.'
            : 'Live treasury state from the deployed ArcPilotTreasury contract on Arc Testnet.'
        }
        action={
          <div className="flex items-center gap-2">
            {data && (
              <span className="text-xs text-ap-muted">
                {lastUpdated ? `Updated ${new Date(lastUpdated).toLocaleTimeString()}` : ''}
              </span>
            )}
            {data?.paused && <Badge variant="danger" dot>Paused</Badge>}
            {data && !data.paused && <Badge variant="success" dot>Active</Badge>}
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

      {/* ── Metric cards row ── */}
      <TreasuryStateGuard status={status} errorMessage={errorMessage}>
        {data && (
          <motion.div
            {...fadeUp(0)}
            className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 mb-4"
            data-testid="metrics-grid"
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
              subtext="After reserve &amp; obligations"
              icon={<Zap size={15} />}
              loading={isLoading}
            />
            <MetricCard
              label="Locked — Obligations"
              value={fmtUsdc(data.obligations)}
              subtext={`Reserve: ${fmtUsdc(data.reserve)} (${data.reserveBps / 100}%)`}
              icon={<TrendingDown size={15} />}
              loading={isLoading}
            />
            <MetricCard
              label="Daily Remaining"
              value={fmtRemaining(data.dailyRemaining)}
              subtext={
                data.globalDailyLimit === 0n
                  ? 'No daily cap configured'
                  : `${fmtUsdc(data.globalSpentToday)} spent today`
              }
              icon={<Clock size={15} />}
              loading={isLoading}
            />
          </motion.div>
        )}
      </TreasuryStateGuard>

      {/* ── Allocation bar + breakdown ── */}
      {data && data.totalBalance > 0n && (
        <motion.div
          {...fadeUp(0.05)}
          className="mb-4 rounded-xl border border-ap-border bg-ap-surface p-5"
          data-testid="allocation-bar"
        >
          <p className="text-xs uppercase tracking-caps text-ap-muted mb-3">
            Allocation
            {isDev && <span className="ml-2 text-ap-warning">[DEV DATA]</span>}
          </p>
          {/* Bar */}
          <div className="h-2.5 rounded-full bg-ap-border/60 overflow-hidden flex mb-4" role="img" aria-label="Balance allocation bar">
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
          <div className="grid grid-cols-3 gap-2 text-xs">
            <LegendItem color="bg-ap-danger/70" label="Obligations" value={fmtUsdc(data.obligations)} pct={formatPercent(data.obligations, data.totalBalance)} />
            <LegendItem color="bg-ap-info/70" label={`Reserve (${data.reserveBps / 100}%)`} value={fmtUsdc(data.reserve)} pct={formatPercent(data.reserve, data.totalBalance)} />
            <LegendItem color="bg-ap-success/70" label="Spendable" value={fmtUsdc(data.spendable)} pct={formatPercent(data.spendable, data.totalBalance)} />
          </div>
        </motion.div>
      )}

      {/* ── Daily spending ── */}
      {data && data.globalDailyLimit > 0n && (
        <motion.div
          {...fadeUp(0.08)}
          className="mb-4 rounded-xl border border-ap-border bg-ap-surface p-5"
          data-testid="daily-spending"
        >
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs uppercase tracking-caps text-ap-muted">
              Daily Spending
              {isDev && <span className="ml-2 text-ap-warning">[DEV DATA]</span>}
            </p>
            <span className="text-xs text-ap-muted tabular-nums">
              {fmtUsdc(data.globalSpentToday)} / {fmtUsdc(data.globalDailyLimit)}
            </span>
          </div>
          <div className="h-2 rounded-full bg-ap-border/60 overflow-hidden" role="img" aria-label="Daily spending progress">
            <div
              className="h-full rounded-full bg-ap-gold transition-all duration-500"
              style={{
                width: `${formatPercent(data.globalSpentToday, data.globalDailyLimit)}%`,
              }}
            />
          </div>
          <div className="mt-2 flex justify-between text-xs text-ap-muted">
            <span>{fmtUsdc(data.globalSpentToday)} spent</span>
            <span>{fmtRemaining(data.dailyRemaining)} remaining</span>
          </div>
        </motion.div>
      )}

      {/* ── Recent payments ── */}
      {status === 'success' && (
        <motion.div
          {...fadeUp(0.1)}
          className="mb-4 rounded-xl border border-ap-border bg-ap-surface overflow-hidden"
          data-testid="recent-payments"
        >
          <div className="px-5 py-3 border-b border-ap-border flex items-center justify-between">
            <p className="text-xs uppercase tracking-caps text-ap-muted">Recent Payments</p>
            <button
              onClick={() => onNav('audit-log')}
              className="text-xs text-ap-gold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ap-gold rounded"
            >
              View all
            </button>
          </div>
          {recentPayments.length === 0 ? (
            <div className="px-5 py-6 text-center text-xs text-ap-muted">
              No payments recorded yet.
            </div>
          ) : (
            <div className="divide-y divide-ap-border">
              {recentPayments.map((p, i) => (
                <div key={i} className="flex items-center gap-3 px-5 py-3 text-xs">
                  <ArrowLeftRight size={13} className="text-ap-muted shrink-0" />
                  <span className="font-mono text-ap-muted truncate flex-1">
                    {p.to.slice(0, 10)}…{p.to.slice(-6)}
                  </span>
                  <span className="tabular-nums text-ap-text font-medium">
                    {fmtUsdc(p.amount)}
                  </span>
                  <span className="text-ap-muted tabular-nums ml-auto">
                    {p.memo.length > 0 ? p.memo : '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      )}

      {/* ── Quick actions ── */}
      <motion.div {...fadeUp(0.12)} className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        {[
          {
            nav: 'treasury' as NavSection,
            icon: <Vault size={18} className="text-ap-gold" />,
            title: 'Manage Treasury',
            desc: 'Deposit USDC, set reserve fraction, and view the allocation breakdown.',
          },
          {
            nav: 'payments' as NavSection,
            icon: <ArrowLeftRight size={18} className="text-ap-info" />,
            title: 'Execute Payment',
            desc: 'Send USDC to an allowlisted payee with a unique request ID.',
          },
          {
            nav: 'agent-services' as NavSection,
            icon: <Bot size={18} className="text-ap-success" />,
            title: 'Agent Services',
            desc: 'HTTP 402 pay-per-call endpoints for AI agents.',
          },
        ].map(({ nav, icon, title, desc }) => (
          <button
            key={nav}
            onClick={() => onNav(nav)}
            className="text-left rounded-xl border border-ap-border bg-ap-surface px-4 py-4 hover:bg-ap-elevated transition-colors duration-150 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ap-gold"
          >
            <div className="mb-3 w-8 h-8 rounded-lg bg-ap-border/40 flex items-center justify-center group-hover:bg-ap-border/60 transition-colors">
              {icon}
            </div>
            <p className="font-display font-semibold text-sm text-ap-text">{title}</p>
            <p className="mt-1 text-xs text-ap-muted text-pretty">{desc}</p>
          </button>
        ))}
      </motion.div>

      {/* ── Contract info strip ── */}
      <motion.div
        {...fadeUp(0.15)}
        className="rounded-xl border border-ap-border bg-ap-surface/50 px-4 py-3"
        data-testid="contract-info"
      >
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
          <InfoPill label="Contract" value={addr} mono link={getExplorerAddressUrl(addr)} />
          <InfoPill label="USDC" value={USDC_ADDRESS} mono link={getExplorerAddressUrl(USDC_ADDRESS)} />
          <InfoPill label="Network" value="Arc Testnet · 5042002" />
          {data?.paymentCount !== undefined && (
            <InfoPill label="Payments" value={String(data.paymentCount)} />
          )}
          {data?.payeeCount !== undefined && (
            <InfoPill label="Payees" value={String(data.payeeCount)} />
          )}
          <ShieldCheck size={12} className="text-ap-gold ml-auto" aria-hidden />
        </div>
      </motion.div>

      {/* ── Wrong-network / error inline hints ── */}
      {(status === 'wrong-network' || status === 'error') && (
        <motion.div
          {...fadeUp(0.05)}
          className="mt-4 rounded-xl border border-ap-danger/30 bg-ap-danger/5 px-4 py-3 flex items-start gap-2"
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

function LegendItem({ color, label, value, pct }: { color: string; label: string; value: string; pct: string }) {
  return (
    <div className="flex items-start gap-1.5">
      <span className={`w-2 h-2 rounded-sm mt-0.5 shrink-0 ${color}`} aria-hidden />
      <div>
        <p className="text-ap-muted">{label}</p>
        <p className="text-ap-text tabular-nums font-medium">{value} <span className="text-ap-muted font-normal">({pct}%)</span></p>
      </div>
    </div>
  )
}

function InfoPill({ label, value, mono = false, link }: { label: string; value: string; mono?: boolean; link?: string }) {
  const content = (
    <span className={mono ? 'font-mono text-ap-text' : 'text-ap-text'}>
      {mono && value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value}
    </span>
  )
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-ap-muted uppercase tracking-caps">{label}</span>
      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 hover:text-ap-gold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ap-gold rounded"
          aria-label={`Open ${label} on explorer`}
        >
          {content}
          <ExternalLink size={10} className="text-ap-muted" aria-hidden />
        </a>
      ) : content}
    </span>
  )
}
