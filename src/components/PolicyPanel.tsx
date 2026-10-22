import { useState } from 'react'
import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useAccount } from 'wagmi'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, Trash2, Edit3, CheckCircle, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react'
import { toast } from 'sonner'
import { ARCPILOT_ABI } from '@/lib/abi'
import { formatUSDC, parseUSDC, getExplorerTxUrl } from '@/lib/utils'
import { ARC_TESTNET_CHAIN_ID } from '@/config'

interface PolicyPanelProps {
  contractAddress: `0x${string}` | undefined
}

export function PolicyPanel({ contractAddress }: PolicyPanelProps) {
  const { address, chainId, isConnected } = useAccount()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'obligations' | 'reserve' | 'payees'>('obligations')

  const isOwner = !!contractAddress && !!address
  const wrongChain = chainId !== ARC_TESTNET_CHAIN_ID

  if (!contractAddress) return null

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5">
      <button
        className="w-full flex items-center justify-between px-6 py-4 text-left"
        onClick={() => setOpen(o => !o)}
      >
        <span className="font-display font-semibold text-white text-sm">Spending Policies</span>
        {open ? <ChevronUp size={16} className="text-arc-muted" /> : <ChevronDown size={16} className="text-arc-muted" />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            key="policy-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <div className="border-t border-white/10">
              {/* Tabs */}
              <div className="flex px-6 pt-4 gap-2">
                {(['obligations', 'reserve', 'payees'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`text-xs px-3 py-1.5 rounded-lg capitalize transition-colors ${
                      tab === t
                        ? 'bg-arc-accent text-white font-medium'
                        : 'text-arc-muted hover:text-white hover:bg-white/10'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>

              <div className="px-6 py-4">
                {wrongChain && isConnected && (
                  <p className="text-xs text-amber-400 mb-3">Switch to Arc Testnet to make changes.</p>
                )}
                {tab === 'obligations' && <ObligationsTab contractAddress={contractAddress} isOwner={isOwner} wrongChain={wrongChain} />}
                {tab === 'reserve' && <ReserveTab contractAddress={contractAddress} isOwner={isOwner} wrongChain={wrongChain} />}
                {tab === 'payees' && <PayeesTab contractAddress={contractAddress} isOwner={isOwner} wrongChain={wrongChain} />}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Obligations Tab ──────────────────────────────────────────────────────────

function ObligationsTab({ contractAddress, isOwner, wrongChain }: { contractAddress: `0x${string}`; isOwner: boolean; wrongChain: boolean }) {
  const [label, setLabel] = useState('')
  const [amount, setAmount] = useState('')
  const [editId, setEditId] = useState<number | null>(null)

  const { data: count, refetch } = useReadContract({
    address: contractAddress,
    abi: ARCPILOT_ABI,
    functionName: 'obligationCount',
    chainId: ARC_TESTNET_CHAIN_ID,
  })

  const { writeContract, data: hash, isPending } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  function submit() {
    if (!label || !amount) return
    const id = editId ?? Number(count ?? 0n)
    writeContract({
      address: contractAddress,
      abi: ARCPILOT_ABI,
      functionName: 'setObligation',
      args: [BigInt(id), label, parseUSDC(amount)],
      chainId: ARC_TESTNET_CHAIN_ID,
    })
  }

  function remove(id: number) {
    writeContract({
      address: contractAddress,
      abi: ARCPILOT_ABI,
      functionName: 'removeObligation',
      args: [BigInt(id)],
      chainId: ARC_TESTNET_CHAIN_ID,
    })
  }

  if (isSuccess) {
    toast.success('Obligation saved', {
      action: hash ? { label: 'View', onClick: () => window.open(getExplorerTxUrl(hash), '_blank') } : undefined,
    })
    setLabel(''); setAmount(''); setEditId(null)
    refetch()
  }

  const totalCount = Number(count ?? 0n)

  return (
    <div className="space-y-3">
      <ObligationList contractAddress={contractAddress} totalCount={totalCount} onEdit={(id, l, a) => { setEditId(id); setLabel(l); setAmount(a); }} onRemove={remove} disabled={!isOwner || wrongChain} />

      {isOwner && !wrongChain && (
        <div className="pt-2 border-t border-white/10">
          <p className="text-[11px] text-arc-muted mb-2 uppercase tracking-caps">{editId !== null ? `Editing obligation #${editId}` : 'Add obligation'}</p>
          <div className="flex gap-2 flex-wrap">
            <input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="Label (e.g. Payroll)"
              className="flex-1 min-w-[120px] bg-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-arc-muted border border-white/10 focus:outline-none focus:border-arc-accent"
            />
            <input
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="USDC amount"
              className="w-32 bg-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-arc-muted border border-white/10 focus:outline-none focus:border-arc-accent"
            />
            <button
              onClick={submit}
              disabled={isPending || isConfirming || !label || !amount}
              className="px-4 py-2 bg-arc-accent text-white text-sm rounded-lg hover:bg-arc-accent-light disabled:opacity-50 transition-colors flex items-center gap-1.5"
            >
              {isPending || isConfirming ? <RefreshSpinner /> : <Plus size={13} />}
              {editId !== null ? 'Update' : 'Add'}
            </button>
            {editId !== null && (
              <button onClick={() => { setEditId(null); setLabel(''); setAmount(''); }} className="px-3 py-2 text-sm text-arc-muted hover:text-white transition-colors">
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ObligationList({ contractAddress, totalCount, onEdit, onRemove, disabled }: {
  contractAddress: `0x${string}`
  totalCount: number
  onEdit: (id: number, label: string, amount: string) => void
  onRemove: (id: number) => void
  disabled: boolean
}) {
  const items = Array.from({ length: totalCount }, (_, i) => i)
  if (items.length === 0) return <p className="text-xs text-arc-muted">No obligations configured.</p>
  return (
    <div className="space-y-1.5">
      {items.map(id => (
        <ObligationRow
          key={id}
          id={id}
          contractAddress={contractAddress}
          onEdit={onEdit}
          onRemove={onRemove}
          disabled={disabled}
        />
      ))}
    </div>
  )
}

function ObligationRow({ id, contractAddress, onEdit, onRemove, disabled }: {
  id: number
  contractAddress: `0x${string}`
  onEdit: (id: number, label: string, amount: string) => void
  onRemove: (id: number) => void
  disabled: boolean
}) {
  const { data } = useReadContract({
    address: contractAddress,
    abi: ARCPILOT_ABI,
    functionName: 'obligations',
    args: [BigInt(id)],
    chainId: ARC_TESTNET_CHAIN_ID,
  })

  if (!data || !data[2]) return null // inactive

  const [label, amount] = data

  return (
    <div className="flex items-center justify-between bg-white/5 rounded-lg px-3 py-2">
      <div>
        <span className="text-sm text-white">{label}</span>
        <span className="text-xs text-arc-muted ml-2 tabular-nums">${formatUSDC(amount)}</span>
      </div>
      {!disabled && (
        <div className="flex gap-1">
          <button onClick={() => onEdit(id, label, (Number(amount) / 1e6).toString())} className="p-1.5 hover:bg-white/10 rounded transition-colors text-arc-muted hover:text-white">
            <Edit3 size={12} />
          </button>
          <button onClick={() => onRemove(id)} className="p-1.5 hover:bg-white/10 rounded transition-colors text-arc-muted hover:text-red-400">
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  )
}

// ── Reserve Tab ──────────────────────────────────────────────────────────────

function ReserveTab({ contractAddress, isOwner, wrongChain }: { contractAddress: `0x${string}`; isOwner: boolean; wrongChain: boolean }) {
  const { data: currentBps } = useReadContract({
    address: contractAddress,
    abi: ARCPILOT_ABI,
    functionName: 'reserveBps',
    chainId: ARC_TESTNET_CHAIN_ID,
  })
  const [bps, setBps] = useState('')
  const { writeContract, data: hash, isPending } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  if (isSuccess) {
    toast.success('Reserve policy updated')
    setBps('')
  }

  function submit() {
    const v = parseInt(bps)
    if (isNaN(v) || v < 0 || v > 10000) return
    writeContract({
      address: contractAddress,
      abi: ARCPILOT_ABI,
      functionName: 'setReserveBps',
      args: [v as number & { __brand: 'uint16' }],
      chainId: ARC_TESTNET_CHAIN_ID,
    })
  }

  return (
    <div className="space-y-3">
      <div className="bg-white/5 rounded-lg px-4 py-3">
        <p className="text-xs text-arc-muted">Current reserve</p>
        <p className="text-xl font-display font-semibold text-blue-300 tabular-nums">
          {currentBps !== undefined ? `${currentBps} bps (${(Number(currentBps) / 100).toFixed(2)}%)` : '—'}
        </p>
      </div>
      {isOwner && !wrongChain && (
        <div className="flex gap-2">
          <input
            value={bps}
            onChange={e => setBps(e.target.value)}
            placeholder="New bps (0–10000)"
            className="flex-1 bg-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-arc-muted border border-white/10 focus:outline-none focus:border-arc-accent"
          />
          <button
            onClick={submit}
            disabled={isPending || isConfirming || !bps}
            className="px-4 py-2 bg-arc-accent text-white text-sm rounded-lg hover:bg-arc-accent-light disabled:opacity-50 transition-colors"
          >
            {isPending || isConfirming ? <RefreshSpinner /> : 'Set'}
          </button>
        </div>
      )}
      <p className="text-[11px] text-arc-muted">1 bps = 0.01% of total treasury balance held as reserve.</p>
    </div>
  )
}

// ── Payees Tab ───────────────────────────────────────────────────────────────

function PayeesTab({ contractAddress, isOwner, wrongChain }: { contractAddress: `0x${string}`; isOwner: boolean; wrongChain: boolean }) {
  const [payeeAddr, setPayeeAddr] = useState('')
  const [payeeLabel, setPayeeLabel] = useState('')
  const [dailyLimit, setDailyLimit] = useState('')

  const { data: count, refetch } = useReadContract({
    address: contractAddress,
    abi: ARCPILOT_ABI,
    functionName: 'payeeCount',
    chainId: ARC_TESTNET_CHAIN_ID,
  })

  const { writeContract, data: hash, isPending } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  if (isSuccess) {
    toast.success('Payee policy saved')
    setPayeeAddr(''); setPayeeLabel(''); setDailyLimit('')
    refetch()
  }

  function add() {
    if (!payeeAddr || !payeeLabel) return
    writeContract({
      address: contractAddress,
      abi: ARCPILOT_ABI,
      functionName: 'setPayee',
      args: [payeeAddr as `0x${string}`, payeeLabel, dailyLimit ? parseUSDC(dailyLimit) : 0n],
      chainId: ARC_TESTNET_CHAIN_ID,
    })
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-arc-muted">{count !== undefined ? `${count} allowed payee(s)` : 'Loading...'}</p>

      {isOwner && !wrongChain && (
        <div className="pt-2 border-t border-white/10 space-y-2">
          <p className="text-[11px] text-arc-muted uppercase tracking-caps">Add / update payee</p>
          <input
            value={payeeAddr}
            onChange={e => setPayeeAddr(e.target.value)}
            placeholder="0x... payee address"
            className="w-full bg-white/10 rounded-lg px-3 py-2 text-sm font-mono text-white placeholder:text-arc-muted border border-white/10 focus:outline-none focus:border-arc-accent"
          />
          <div className="flex gap-2">
            <input
              value={payeeLabel}
              onChange={e => setPayeeLabel(e.target.value)}
              placeholder="Label"
              className="flex-1 bg-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-arc-muted border border-white/10 focus:outline-none focus:border-arc-accent"
            />
            <input
              value={dailyLimit}
              onChange={e => setDailyLimit(e.target.value)}
              placeholder="Daily limit USDC (0=none)"
              className="w-44 bg-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-arc-muted border border-white/10 focus:outline-none focus:border-arc-accent"
            />
          </div>
          <button
            onClick={add}
            disabled={isPending || isConfirming || !payeeAddr || !payeeLabel}
            className="px-4 py-2 bg-arc-accent text-white text-sm rounded-lg hover:bg-arc-accent-light disabled:opacity-50 transition-colors flex items-center gap-1.5"
          >
            {isPending || isConfirming ? <RefreshSpinner /> : <Plus size={13} />}
            Add Payee
          </button>
        </div>
      )}
    </div>
  )
}

function RefreshSpinner() {
  return (
    <motion.span animate={{ rotate: 360 }} transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}>
      <RefreshCw size={13} />
    </motion.span>
  )
}

// eslint-disable-next-line
import { RefreshCw } from 'lucide-react'
