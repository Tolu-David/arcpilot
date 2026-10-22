import { useState, useEffect } from 'react'
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
  useSwitchChain,
} from 'wagmi'
import { erc20Abi } from 'viem'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowDownToLine, AlertCircle, CheckCircle2, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react'
import { toast } from 'sonner'
import { ARCPILOT_ABI } from '@/lib/abi'
import { parseUSDC, formatUSDC, getExplorerTxUrl } from '@/lib/utils'
import { ARC_TESTNET_CHAIN_ID, USDC_ADDRESS } from '@/config'
import { TokenUSDC } from '@web3icons/react'

interface DepositPanelProps {
  contractAddress: `0x${string}`
}

type Step = 'idle' | 'approving' | 'approve-confirming' | 'approved' | 'depositing' | 'deposit-confirming' | 'done'

export function DepositPanel({ contractAddress }: DepositPanelProps) {
  const { address, chainId, isConnected } = useAccount()
  const { switchChain } = useSwitchChain()
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [step, setStep] = useState<Step>('idle')

  const wrongChain = chainId !== ARC_TESTNET_CHAIN_ID

  // Wallet USDC balance
  const { data: walletBalance, refetch: refetchBalance } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address!],
    chainId: ARC_TESTNET_CHAIN_ID,
    query: { enabled: !!address },
  })

  // Current allowance for the contract
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [address!, contractAddress],
    chainId: ARC_TESTNET_CHAIN_ID,
    query: { enabled: !!address },
  })

  // Step 1: Approve
  const {
    writeContract: approve,
    data: approveHash,
    isPending: approvePending,
    reset: resetApprove,
  } = useWriteContract()

  const { isLoading: approveConfirming, isSuccess: approveSuccess } =
    useWaitForTransactionReceipt({ hash: approveHash })

  // Step 2: Deposit
  const {
    writeContract: deposit,
    data: depositHash,
    isPending: depositPending,
    reset: resetDeposit,
  } = useWriteContract()

  const { isLoading: depositConfirming, isSuccess: depositSuccess } =
    useWaitForTransactionReceipt({ hash: depositHash })

  // Advance state machine
  useEffect(() => {
    if (approvePending) setStep('approving')
    else if (approveConfirming) setStep('approve-confirming')
    else if (approveSuccess && step === 'approve-confirming') {
      setStep('approved')
      refetchAllowance()
      toast.success('USDC approved — now confirm the deposit.')
    }
  }, [approvePending, approveConfirming, approveSuccess])

  useEffect(() => {
    if (depositPending) setStep('depositing')
    else if (depositConfirming) setStep('deposit-confirming')
    else if (depositSuccess && step === 'deposit-confirming') {
      setStep('done')
      refetchBalance()
      refetchAllowance()
      toast.success('Deposit confirmed!', {
        action: depositHash
          ? { label: 'View', onClick: () => window.open(getExplorerTxUrl(depositHash), '_blank') }
          : undefined,
      })
    }
  }, [depositPending, depositConfirming, depositSuccess])

  function reset() {
    setStep('idle')
    setAmount('')
    resetApprove()
    resetDeposit()
  }

  function handleApprove() {
    if (!amount || wrongChain) return
    const parsed = parseUSDC(amount)
    approve({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'approve',
      args: [contractAddress, parsed],
      chainId: ARC_TESTNET_CHAIN_ID,
    })
  }

  function handleDeposit() {
    if (!amount || wrongChain) return
    const parsed = parseUSDC(amount)
    deposit({
      address: contractAddress,
      abi: ARCPILOT_ABI,
      functionName: 'deposit',
      args: [parsed],
      chainId: ARC_TESTNET_CHAIN_ID,
    })
  }

  const parsed = amount ? parseUSDC(amount) : 0n
  const hasAllowance = (allowance ?? 0n) >= parsed && parsed > 0n
  const hasFunds = (walletBalance ?? 0n) >= parsed && parsed > 0n
  const walletBalanceStr = walletBalance !== undefined ? formatUSDC(walletBalance) : '—'

  const canProceed = isConnected && !wrongChain && parsed > 0n

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5">
      <button
        className="w-full flex items-center justify-between px-6 py-4 text-left"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2">
          <ArrowDownToLine size={14} className="text-arc-accent-light" />
          <span className="font-display font-semibold text-white text-sm">Deposit USDC</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-arc-muted hidden sm:inline">
            Wallet: <span className="text-white tabular-nums">${walletBalanceStr}</span>
          </span>
          {open
            ? <ChevronUp size={16} className="text-arc-muted" />
            : <ChevronDown size={16} className="text-arc-muted" />}
        </div>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            key="deposit-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <div className="border-t border-white/10 px-6 py-4 space-y-4">
              {step === 'done' ? (
                <div className="flex flex-col items-center gap-3 py-4">
                  <CheckCircle2 size={32} className="text-emerald-400" />
                  <p className="text-white font-semibold">Deposit successful</p>
                  {depositHash && (
                    <a
                      href={getExplorerTxUrl(depositHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs text-arc-accent-light hover:underline"
                    >
                      <ExternalLink size={12} />
                      View on explorer
                    </a>
                  )}
                  <button onClick={reset} className="text-xs text-arc-muted hover:text-white transition-colors mt-1">
                    Make another deposit
                  </button>
                </div>
              ) : (
                <>
                  {/* Amount input */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-[11px] text-arc-muted uppercase tracking-caps">Amount (USDC)</label>
                      <button
                        className="text-[11px] text-arc-accent-light hover:underline"
                        onClick={() => walletBalance && setAmount(formatUSDC(walletBalance))}
                      >
                        Max ${walletBalanceStr}
                      </button>
                    </div>
                    <div className="relative">
                      <div className="absolute left-3 top-1/2 -translate-y-1/2">
                        <TokenUSDC variant="branded" size={16} />
                      </div>
                      <input
                        value={amount}
                        onChange={e => { setAmount(e.target.value); setStep('idle') }}
                        placeholder="0.00"
                        disabled={step !== 'idle' && step !== 'approved'}
                        className="w-full bg-white/10 rounded-lg pl-9 pr-3 py-2.5 text-sm text-white tabular-nums placeholder:text-arc-muted border border-white/10 focus:outline-none focus:border-arc-accent disabled:opacity-50"
                      />
                    </div>
                    {!hasFunds && parsed > 0n && (
                      <p className="text-xs text-red-400 mt-1">Insufficient wallet balance.</p>
                    )}
                  </div>

                  {/* Two-step indicator */}
                  <div className="flex items-center gap-2 text-xs text-arc-muted">
                    <StepDot active={step === 'idle' || step === 'approving' || step === 'approve-confirming'} done={hasAllowance || step === 'approved' || step === 'depositing' || step === 'deposit-confirming'} />
                    <span className={hasAllowance || step !== 'idle' ? 'line-through opacity-50' : ''}>1. Approve USDC spend</span>
                    <span className="mx-1 opacity-30">→</span>
                    <StepDot active={step === 'depositing' || step === 'deposit-confirming'} done={false} />
                    <span>2. Deposit into treasury</span>
                  </div>

                  {/* Chain warning */}
                  {wrongChain && isConnected && (
                    <div className="flex items-center justify-between rounded-lg bg-amber-400/10 border border-amber-400/20 px-3 py-2">
                      <div className="flex items-center gap-2 text-amber-400 text-xs">
                        <AlertCircle size={13} />
                        Switch to Arc Testnet
                      </div>
                      <button
                        onClick={() => switchChain({ chainId: ARC_TESTNET_CHAIN_ID })}
                        className="text-xs text-amber-300 font-medium hover:underline"
                      >
                        Switch
                      </button>
                    </div>
                  )}

                  {/* CTA */}
                  {!hasAllowance ? (
                    <button
                      onClick={handleApprove}
                      disabled={!canProceed || !hasFunds || approvePending || approveConfirming}
                      className="w-full py-3 bg-arc-accent text-white font-semibold rounded-xl hover:bg-arc-accent-light disabled:opacity-40 transition-colors text-sm"
                    >
                      {approvePending
                        ? 'Confirm in wallet…'
                        : approveConfirming
                        ? 'Approving…'
                        : 'Approve USDC'}
                    </button>
                  ) : (
                    <button
                      onClick={handleDeposit}
                      disabled={!canProceed || !hasFunds || depositPending || depositConfirming}
                      className="w-full py-3 bg-emerald-600 text-white font-semibold rounded-xl hover:bg-emerald-500 disabled:opacity-40 transition-colors text-sm"
                    >
                      {depositPending
                        ? 'Confirm in wallet…'
                        : depositConfirming
                        ? 'Confirming deposit…'
                        : 'Deposit into Treasury'}
                    </button>
                  )}

                  <p className="text-[11px] text-arc-muted text-center">
                    Get test USDC from the <strong className="text-white">Get test USDC</strong> button in the Arc Studio sidebar.
                  </p>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function StepDot({ active, done }: { active: boolean; done: boolean }) {
  return (
    <div className={`w-3 h-3 rounded-full border flex-shrink-0 transition-colors ${
      done
        ? 'bg-emerald-500 border-emerald-500'
        : active
        ? 'border-arc-accent bg-arc-accent/30'
        : 'border-white/20 bg-transparent'
    }`} />
  )
}
