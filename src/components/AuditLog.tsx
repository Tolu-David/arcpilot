import { useReadContract } from 'wagmi'
import { motion } from 'framer-motion'
import { ClipboardList, ExternalLink } from 'lucide-react'
import { ARCPILOT_ABI } from '@/lib/abi'
import { formatUSDC, formatAddress, getExplorerTxUrl, getExplorerAddressUrl } from '@/lib/utils'
import { ARC_TESTNET_CHAIN_ID } from '@/config'

interface AuditLogProps {
  contractAddress: `0x${string}` | undefined
}

export function AuditLog({ contractAddress }: AuditLogProps) {
  const { data: paymentCount } = useReadContract({
    address: contractAddress,
    abi: ARCPILOT_ABI,
    functionName: 'paymentCount',
    chainId: ARC_TESTNET_CHAIN_ID,
    query: { enabled: !!contractAddress },
  })

  const total = Number(paymentCount ?? 0n)

  // Fetch last 20 payments
  const offset = Math.max(0, total - 20)
  const limit = Math.min(20, total)

  const { data: records, isLoading } = useReadContract({
    address: contractAddress,
    abi: ARCPILOT_ABI,
    functionName: 'getPayments',
    args: [BigInt(offset), BigInt(limit)],
    chainId: ARC_TESTNET_CHAIN_ID,
    query: { enabled: !!contractAddress && total > 0 },
  })

  if (!contractAddress) return null

  const payments = records ? [...records].reverse() : []

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.15 }}
      className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-sm"
    >
      <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ClipboardList size={14} className="text-arc-accent-light" />
          <span className="font-display font-semibold text-white text-sm">Payment History</span>
        </div>
        <span className="text-[11px] text-arc-muted tabular-nums">
          {total} total payment{total !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="divide-y divide-white/5">
        {isLoading && (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="px-6 py-3">
              <div className="h-4 w-3/4 rounded bg-white/10 animate-pulse mb-1.5" />
              <div className="h-3 w-1/2 rounded bg-white/10 animate-pulse" />
            </div>
          ))
        )}

        {!isLoading && payments.length === 0 && (
          <div className="px-6 py-6 text-center text-arc-muted text-sm">
            No payments yet. Execute the first one above.
          </div>
        )}

        {payments.map((p, i) => (
          <PaymentRow key={i} payment={p} index={total - 1 - i} />
        ))}
      </div>
    </motion.div>
  )
}

interface PaymentRecord {
  to: `0x${string}`
  amount: bigint
  timestamp: bigint
  memo: string
}

function PaymentRow({ payment, index }: { payment: PaymentRecord; index: number }) {
  const date = new Date(Number(payment.timestamp) * 1000)
  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="px-6 py-3 flex items-start justify-between hover:bg-white/5 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[10px] font-mono text-arc-muted">#{index}</span>
          <a
            href={getExplorerAddressUrl(payment.to)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-mono text-white/80 hover:text-arc-accent-light transition-colors truncate"
          >
            {formatAddress(payment.to)}
          </a>
          {payment.memo && (
            <span className="text-xs text-arc-muted truncate max-w-[150px]">{payment.memo}</span>
          )}
        </div>
        <p className="text-[11px] text-arc-muted">{dateStr} · {timeStr}</p>
      </div>
      <div className="text-right ml-4 flex-shrink-0">
        <p className="text-sm font-display font-semibold text-white tabular-nums">
          −${formatUSDC(payment.amount)}
        </p>
        <p className="text-[10px] text-arc-muted">USDC</p>
      </div>
    </div>
  )
}
