import { useReadContract, useAccount } from 'wagmi'
import { erc20Abi } from 'viem'
import { motion } from 'framer-motion'
import { RefreshCw, TrendingDown, Shield, Zap } from 'lucide-react'
import { ARCPILOT_ABI } from '@/lib/abi'
import { formatUSDC, formatPercent } from '@/lib/utils'
import { ARC_TESTNET_CHAIN_ID, USDC_ADDRESS } from '@/config'
import { TokenUSDC } from '@web3icons/react'

interface TreasuryCardProps {
  contractAddress: `0x${string}` | undefined
}

export function TreasuryCard({ contractAddress }: TreasuryCardProps) {
  const { isConnected } = useAccount()

  const commonArgs = {
    address: contractAddress,
    abi: ARCPILOT_ABI,
    chainId: ARC_TESTNET_CHAIN_ID,
    query: { enabled: !!contractAddress },
  } as const

  const { data: totalBal, isLoading: l1, refetch: r1 } = useReadContract({ ...commonArgs, functionName: 'totalBalance' })
  const { data: obligations, isLoading: l2 } = useReadContract({ ...commonArgs, functionName: 'totalObligations' })
  const { data: reserve, isLoading: l3 } = useReadContract({ ...commonArgs, functionName: 'reserveAmount' })
  const { data: spendable, isLoading: l4 } = useReadContract({ ...commonArgs, functionName: 'spendableBalance' })
  const { data: reserveBps } = useReadContract({ ...commonArgs, functionName: 'reserveBps' })

  const isLoading = l1 || l2 || l3 || l4

  const total = totalBal ?? 0n
  const obls = obligations ?? 0n
  const rsv = reserve ?? 0n
  const spend = spendable ?? 0n

  const oblPct = formatPercent(obls, total)
  const rsvPct = formatPercent(rsv, total)
  const spendPct = formatPercent(spend, total)

  function refresh() { r1() }

  if (!contractAddress) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
        <p className="text-arc-muted text-sm">
          {isConnected
            ? 'Enter a deployed ArcPilot contract address below to load treasury data.'
            : 'Connect your wallet to get started.'}
        </p>
      </div>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-sm overflow-hidden"
    >
      {/* Hero balance */}
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <TokenUSDC variant="branded" size={18} />
              <span className="text-xs font-mono text-arc-muted uppercase tracking-caps">Treasury Balance</span>
            </div>
            {isLoading ? (
              <div className="h-10 w-48 rounded-lg bg-white/10 animate-pulse mt-1" />
            ) : (
              <div className="font-display font-bold text-4xl text-white tracking-display tabular-nums mt-1">
                ${formatUSDC(total)}
              </div>
            )}
            <p className="text-xs text-arc-muted mt-1">Arc Testnet · USDC</p>
          </div>
          <button
            onClick={refresh}
            className="p-2 rounded-lg hover:bg-white/10 transition-colors text-arc-muted hover:text-white"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* Bar */}
      {!isLoading && total > 0n && (
        <div className="px-6 pb-4">
          <div className="h-2 rounded-full bg-white/10 overflow-hidden flex">
            <div
              className="bg-red-400/70 h-full transition-all"
              style={{ width: `${oblPct}%` }}
            />
            <div
              className="bg-blue-400/70 h-full transition-all"
              style={{ width: `${rsvPct}%` }}
            />
            <div
              className="bg-emerald-400/70 h-full transition-all"
              style={{ width: `${spendPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Breakdown */}
      <div className="grid grid-cols-3 border-t border-white/10">
        <Bucket
          icon={<TrendingDown size={13} className="text-red-400" />}
          label="Obligations"
          value={obls}
          pct={oblPct}
          color="text-red-300"
          isLoading={isLoading}
        />
        <Bucket
          icon={<Shield size={13} className="text-blue-400" />}
          label={`Reserve (${reserveBps ?? 0}bps)`}
          value={rsv}
          pct={rsvPct}
          color="text-blue-300"
          isLoading={isLoading}
        />
        <Bucket
          icon={<Zap size={13} className="text-emerald-400" />}
          label="Spendable"
          value={spend}
          pct={spendPct}
          color="text-emerald-300"
          isLoading={isLoading}
        />
      </div>
    </motion.div>
  )
}

function Bucket({
  icon, label, value, pct, color, isLoading,
}: {
  icon: React.ReactNode
  label: string
  value: bigint
  pct: string
  color: string
  isLoading: boolean
}) {
  return (
    <div className="px-4 py-3 border-r last:border-r-0 border-white/10">
      <div className="flex items-center gap-1 mb-1">{icon}<span className="text-[10px] text-arc-muted truncate">{label}</span></div>
      {isLoading ? (
        <div className="h-5 w-20 rounded bg-white/10 animate-pulse" />
      ) : (
        <div className={`font-display font-semibold text-sm tabular-nums ${color}`}>
          ${formatUSDC(value)}
          <span className="text-xs text-arc-muted font-normal ml-1">({pct}%)</span>
        </div>
      )}
    </div>
  )
}
