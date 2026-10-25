import { useState } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract } from 'wagmi'
import { motion } from 'framer-motion'
import { Send, AlertCircle, CheckCircle2, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { ARCPILOT_ABI } from '@/lib/abi'
import { parseUSDC, formatUSDC, getExplorerTxUrl, formatAddress } from '@/lib/utils'
import { ARC_TESTNET_CHAIN_ID } from '@/config'
import { TokenUSDC } from '@web3icons/react'

interface PayPanelProps {
  contractAddress: `0x${string}` | undefined
}

export function PayPanel({ contractAddress }: PayPanelProps) {
  const { address, chainId, isConnected } = useAccount()
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')

  const wrongChain = chainId !== ARC_TESTNET_CHAIN_ID

  const { data: spendable } = useReadContract({
    address: contractAddress,
    abi: ARCPILOT_ABI,
    functionName: 'spendableBalance',
    chainId: ARC_TESTNET_CHAIN_ID,
    query: { enabled: !!contractAddress },
  })

  const { data: payeeInfo } = useReadContract({
    address: contractAddress,
    abi: ARCPILOT_ABI,
    functionName: 'payees',
    args: [to as `0x${string}`],
    chainId: ARC_TESTNET_CHAIN_ID,
    query: { enabled: !!contractAddress && to.length === 42 },
  })

  const { writeContract, data: hash, isPending, isError, error, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  if (!contractAddress) return null

  if (isSuccess && hash) {
    toast.success(`Payment sent!`, {
      action: { label: 'View', onClick: () => window.open(getExplorerTxUrl(hash), '_blank') },
    })
    setTo(''); setAmount(''); setMemo(''); reset()
  }

  function handlePay() {
    if (!to || !amount) return
    if (wrongChain) return
    const parsed = parseUSDC(amount)
    // Derive a unique bytes32 requestId for this direct-pay attempt.
    // Uses the current timestamp and sender address so each submission gets
    // a distinct nonce — satisfies the contract's duplicate-prevention check.
    // The preparation-flow (ReviewPaymentModal) derives requestId server-side;
    // this panel is the legacy direct-pay path and generates it client-side.
    const nonce = `${Date.now()}-${address ?? ''}-${to}`
    const requestId = `0x${nonce
      .split('')
      .reduce((acc, c) => acc + c.charCodeAt(0).toString(16).padStart(2, '0'), '')
      .slice(0, 64)
      .padEnd(64, '0')}` as `0x${string}`
    writeContract({
      address: contractAddress!,
      abi: ARCPILOT_ABI,
      functionName: 'pay',
      args: [to as `0x${string}`, parsed, requestId, memo],
      chainId: ARC_TESTNET_CHAIN_ID,
    })
  }

  const payeeAllowed = payeeInfo?.[4] === true
  const payeeLabel = payeeInfo?.[0]
  const spendableStr = spendable ? formatUSDC(spendable) : '—'

  const isReady = to.length === 42 && parseFloat(amount || '0') > 0 && !wrongChain && isConnected

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.1 }}
      className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-sm"
    >
      <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Send size={14} className="text-arc-accent-light" />
          <span className="font-display font-semibold text-white text-sm">Execute Payment</span>
        </div>
        <span className="text-[11px] text-arc-muted">
          Spendable: <span className="text-emerald-300 tabular-nums">${spendableStr}</span>
        </span>
      </div>

      <div className="px-6 py-4 space-y-3">
        {/* Recipient */}
        <div>
          <label className="text-[11px] text-arc-muted uppercase tracking-caps mb-1.5 block">Recipient</label>
          <input
            value={to}
            onChange={e => setTo(e.target.value)}
            placeholder="0x... payee address"
            className="w-full bg-white/10 rounded-lg px-3 py-2.5 text-sm font-mono text-white placeholder:text-arc-muted border border-white/10 focus:outline-none focus:border-arc-accent"
          />
          {to.length === 42 && payeeInfo && (
            <p className={`text-xs mt-1 ${payeeAllowed ? 'text-emerald-400' : 'text-red-400'}`}>
              {payeeAllowed
                ? `Allowed payee${payeeLabel ? `: ${payeeLabel}` : ''}`
                : 'Not an allowed payee. Add them in Spending Policies.'}
            </p>
          )}
        </div>

        {/* Amount */}
        <div>
          <label className="text-[11px] text-arc-muted uppercase tracking-caps mb-1.5 block">Amount (USDC)</label>
          <div className="relative">
            <div className="absolute left-3 top-1/2 -translate-y-1/2">
              <TokenUSDC variant="branded" size={16} />
            </div>
            <input
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full bg-white/10 rounded-lg pl-9 pr-3 py-2.5 text-sm text-white tabular-nums placeholder:text-arc-muted border border-white/10 focus:outline-none focus:border-arc-accent"
            />
          </div>
        </div>

        {/* Memo */}
        <div>
          <label className="text-[11px] text-arc-muted uppercase tracking-caps mb-1.5 block">Memo (optional)</label>
          <input
            value={memo}
            onChange={e => setMemo(e.target.value)}
            placeholder="e.g. Q4 contractor invoice"
            className="w-full bg-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-arc-muted border border-white/10 focus:outline-none focus:border-arc-accent"
          />
        </div>

        {/* Chain warning */}
        {wrongChain && isConnected && (
          <div className="flex items-center gap-2 text-amber-400 text-xs">
            <AlertCircle size={13} />
            Switch wallet to Arc Testnet to send payments.
          </div>
        )}

        {/* Error */}
        {isError && (
          <div className="flex items-start gap-2 text-red-400 text-xs">
            <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
            {error?.message?.includes('user rejected') ? 'Transaction cancelled.' : 'Payment failed. Check payee, amount, and chain.'}
          </div>
        )}

        {/* CTA */}
        <button
          onClick={handlePay}
          disabled={!isReady || isPending || isConfirming || !payeeAllowed}
          className="w-full py-3 bg-arc-accent text-white font-semibold rounded-xl hover:bg-arc-accent-light disabled:opacity-40 transition-colors flex items-center justify-center gap-2"
        >
          {isPending ? (
            <span className="text-sm">Confirm in wallet…</span>
          ) : isConfirming ? (
            <span className="text-sm">Confirming…</span>
          ) : (
            <>
              <Send size={15} />
              <span className="text-sm">Send Payment</span>
            </>
          )}
        </button>
      </div>
    </motion.div>
  )
}
