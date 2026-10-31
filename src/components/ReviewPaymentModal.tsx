/**
 * src/components/ReviewPaymentModal.tsx
 *
 * Full Review Payment and wallet-confirmation flow.
 *
 * Displays before asking for wallet confirmation:
 *  1. Active chain and chain ID
 *  2. USDC token address
 *  3. Treasury contract address
 *  4. Recipient address and service name
 *  5. Exact amount in USDC
 *  6. Request ID (bytes32)
 *  7. Relevant policy limits (maxTx, dailyRemaining, spendable) and approval status
 *
 * Guards:
 *  - Checks connected wallet is on the expected network
 *  - Checks connected wallet is the authorised contract owner
 *  - Blocks submission and explains the problem clearly on any guard failure
 *
 * Invariants:
 *  - All transaction parameters come from the PaymentPreparationReceipt (server-authoritative)
 *  - The AI recommendation is never consulted here
 *  - Private keys are never exposed — only the wagmi connector signs
 *  - Payment mode cannot be silently switched
 *  - Wallet rejection does NOT mark the payment as failed on-chain
 *  - "Confirm Payment" calls ONLY the `pay()` function with validated params
 */

import { useEffect } from 'react'
import {
  useAccount,
  useChainId,
  useReadContract,
} from 'wagmi'
import {
  AlertTriangle,
  CheckCircle,
  XCircle,
  Loader2,
  ExternalLink,
  ShieldCheck,
  X,
} from 'lucide-react'
import type { PaymentPreparationReceipt } from '../../shared/types'
import { ARCPILOT_ABI } from '@/lib/abi'
import { usePaymentExecution, runPreFlightChecks } from '@/hooks/usePaymentExecution'

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatUsdc(baseUnits: string): string {
  try {
    const n = BigInt(baseUnits)
    const whole = n / 1_000_000n
    const frac  = n % 1_000_000n
    return `${whole}.${frac.toString().padStart(6, '0')}`
  } catch {
    return baseUnits
  }
}

function shortAddr(addr: string): string {
  if (addr.length < 12) return addr
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`
}

// Explorer link is ONLY provided for the configured Arc Testnet.
// Any other chain ID gets no link to prevent pointing at the wrong explorer.
const ARC_TESTNET_CHAIN_ID = 5042002
const EXPLORER_BASE        = 'https://explorer.testnet.arc.io'

function explorerTxLink(txHash: string, chainId: number): string | null {
  return chainId === ARC_TESTNET_CHAIN_ID
    ? `${EXPLORER_BASE}/tx/${txHash}`
    : null
}

function explorerAddrLink(address: string, chainId: number): string | undefined {
  return chainId === ARC_TESTNET_CHAIN_ID
    ? `${EXPLORER_BASE}/address/${address}`
    : undefined
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DataRow({
  label,
  value,
  mono = false,
  link,
  testid,
}: {
  label: string
  value: string
  mono?: boolean
  link?: string
  testid?: string
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-ap-border/50 last:border-0">
      <span className="text-xs text-ap-muted flex-shrink-0 min-w-[140px]">{label}</span>
      <span
        className={`text-xs text-ap-text text-right break-all ${mono ? 'font-mono' : ''}`}
        data-testid={testid}
      >
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="text-ap-gold hover:underline flex items-center gap-1 justify-end"
          >
            {value}
            <ExternalLink size={10} />
          </a>
        ) : value}
      </span>
    </div>
  )
}

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10px] font-semibold uppercase tracking-caps text-ap-muted mb-1 mt-4 first:mt-0">
      {children}
    </h3>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export interface ReviewPaymentModalProps {
  /** Server-produced preparation receipt — the ONLY source of transaction params */
  receipt: PaymentPreparationReceipt
  /** Called when the user closes the modal without confirming */
  onClose: () => void
  /** Called when the transaction is confirmed (txHash provided) */
  onConfirmed?: (txHash: `0x${string}`) => void
}

export function ReviewPaymentModal({ receipt, onClose, onConfirmed }: ReviewPaymentModalProps) {
  const { address: connectedAddr } = useAccount()
  const connectedChainId = useChainId()

  // Read the current owner from the contract (needed for authorization check)
  const { data: ownerAddress } = useReadContract({
    address: receipt.contractAddress as `0x${string}`,
    abi: ARCPILOT_ABI,
    functionName: 'owner',
    query: { enabled: !!receipt.contractAddress },
  }) as { data: `0x${string}` | undefined }

  const { state, preFlightError, execute, reset } = usePaymentExecution()

  // Run pre-flight checks (derived, no state needed — just display)
  const currentPreFlightErr = runPreFlightChecks(
    receipt,
    connectedAddr,
    connectedChainId,
    ownerAddress,
  )

  // Notify parent on confirmation
  useEffect(() => {
    if (state.status === 'confirmed' && state.txHash && onConfirmed) {
      onConfirmed(state.txHash)
    }
  }, [state.status, state.txHash, onConfirmed])

  const isTerminal = (
    state.status === 'confirmed' ||
    state.status === 'reverted'  ||
    state.status === 'unknown'
  )
  const isInFlight = (
    state.status === 'awaiting-wallet' ||
    state.status === 'submitted'       ||
    state.status === 'pending'
  )
  // All pre-flight errors are hard blocks — UNAUTHORIZED_WALLET included.
  // pay() is onlyOwner; an unmatched or unloaded owner address blocks submission
  // here rather than producing an on-chain revert that still burns gas.
  const canSubmit  = !isInFlight && !isTerminal && !currentPreFlightErr

  const usdcAmount = formatUsdc(receipt.amountBaseUnits)
  const txExplorer = state.txHash
    ? explorerTxLink(state.txHash, receipt.chainId)
    : null

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Review Payment"
      data-testid="review-payment-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget && !isInFlight) onClose() }}
    >
      <div className="w-full max-w-md rounded-2xl border border-ap-border bg-ap-surface shadow-panel overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-ap-border">
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} className="text-ap-gold" />
            <span className="font-display font-semibold text-sm text-ap-text">
              Review Payment
            </span>
          </div>
          {!isInFlight && (
            <button
              onClick={onClose}
              aria-label="Close"
              data-testid="modal-close"
              className="p-1 rounded-md text-ap-muted hover:text-ap-text hover:bg-ap-hover transition-colors"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div className="px-6 py-4 max-h-[70vh] overflow-y-auto">

          {/* ── Network and contract ─────────────────────────────────────── */}
          <SectionHead>Network &amp; Contract</SectionHead>

          <DataRow
            label="Chain"
            value={`${receipt.chain} (${receipt.chainId})`}
            testid="modal-chain"
          />
          <DataRow
            label="Chain ID"
            value={String(receipt.chainId)}
            testid="modal-chain-id"
          />
          <DataRow
            label="USDC token"
            value={shortAddr(receipt.tokenAddress)}
            mono
            link={explorerAddrLink(receipt.tokenAddress, receipt.chainId)}
            testid="modal-token-address"
          />
          <DataRow
            label="Treasury contract"
            value={shortAddr(receipt.contractAddress)}
            mono
            link={explorerAddrLink(receipt.contractAddress, receipt.chainId)}
            testid="modal-contract-address"
          />

          {/* ── Payment details ──────────────────────────────────────────── */}
          <SectionHead>Payment Details</SectionHead>

          <DataRow
            label="Service"
            value={receipt.serviceId}
            testid="modal-service-id"
          />
          <DataRow
            label="Recipient"
            value={shortAddr(receipt.recipient)}
            mono
            link={explorerAddrLink(receipt.recipient, receipt.chainId)}
            testid="modal-recipient"
          />
          <DataRow
            label="Amount (USDC)"
            value={usdcAmount}
            testid="modal-amount"
          />
          <DataRow
            label="Request ID"
            value={`${receipt.requestId.slice(0, 10)}…${receipt.requestId.slice(-8)}`}
            mono
            testid="modal-request-id"
          />
          <DataRow
            label="Memo"
            value={receipt.memo || '(none)'}
            testid="modal-memo"
          />

          {/* ── Policy context ───────────────────────────────────────────── */}
          <SectionHead>Policy Context (at preparation time)</SectionHead>

          <DataRow
            label="Spendable balance"
            value={`${formatUsdc(receipt.spendableAtCheck)} USDC`}
            testid="modal-spendable"
          />
          <DataRow
            label="Daily budget remaining"
            value={`${formatUsdc(receipt.dailyRemainingAtCheck)} USDC`}
            testid="modal-daily-remaining"
          />
          <DataRow
            label="Policy result"
            value={receipt.policy.reasonCode}
            testid="modal-policy-code"
          />
          <DataRow
            label="Approval required"
            value={receipt.policy.approvalRequired ? 'Yes' : 'No'}
            testid="modal-approval-required"
          />

          {/* ── Pre-flight error ─────────────────────────────────────────── */}
          {currentPreFlightErr && (
            <div
              role="alert"
              data-testid="modal-preflight-error"
              className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 flex gap-2"
            >
              <AlertTriangle size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium text-amber-300">
                  {preFlightErrorTitle(currentPreFlightErr.code)}
                </p>
                <p className="text-xs text-amber-200/80 mt-0.5">
                  {currentPreFlightErr.message}
                </p>
                <p
                  className="text-[11px] text-amber-200/60 mt-1"
                  data-testid={`preflight-code-${currentPreFlightErr.code}`}
                >
                  Code: {currentPreFlightErr.code}
                </p>
              </div>
            </div>
          )}

          {/* ── Execution state feedback ─────────────────────────────────── */}
          {state.status === 'awaiting-wallet' && (
            <div data-testid="modal-awaiting-wallet" className="mt-4 rounded-lg border border-ap-border bg-ap-bg/60 p-3 flex gap-2 items-center">
              <Loader2 size={14} className="text-ap-gold animate-spin flex-shrink-0" />
              <p className="text-xs text-ap-text">Waiting for wallet confirmation…</p>
            </div>
          )}

          {(state.status === 'submitted' || state.status === 'pending') && (
            <div data-testid="modal-submitted" className="mt-4 rounded-lg border border-blue-500/30 bg-blue-500/10 p-3 flex gap-2 items-center">
              <Loader2 size={14} className="text-blue-400 animate-spin flex-shrink-0" />
              <div>
                <p className="text-xs text-blue-300">
                  {state.status === 'pending'
                    ? 'Transaction pending — verifying receipt and event logs…'
                    : 'Transaction submitted — waiting for block inclusion…'}
                </p>
                {state.txHash && txExplorer && (
                  <a
                    href={txExplorer}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="modal-tx-link"
                    className="text-[11px] text-blue-400 hover:underline flex items-center gap-1 mt-1"
                  >
                    View on explorer <ExternalLink size={9} />
                  </a>
                )}
              </div>
            </div>
          )}

          {state.status === 'confirmed' && (
            <div data-testid="modal-confirmed" className="mt-4 rounded-lg border border-green-500/30 bg-green-500/10 p-3 flex gap-2 items-start">
              <CheckCircle size={14} className="text-green-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium text-green-300">Payment confirmed</p>
                {txExplorer && (
                  <a
                    href={txExplorer}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="modal-confirmed-tx-link"
                    className="text-[11px] text-green-400 hover:underline flex items-center gap-1 mt-1"
                  >
                    View transaction <ExternalLink size={9} />
                  </a>
                )}
              </div>
            </div>
          )}

          {state.status === 'rejected' && (
            <div data-testid="modal-rejected" className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 flex gap-2 items-start">
              <XCircle size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium text-amber-300">Transaction rejected</p>
                <p className="text-xs text-amber-200/80 mt-0.5">
                  You rejected the transaction in your wallet. No funds were moved and no on-chain state was changed.
                </p>
              </div>
            </div>
          )}

          {state.status === 'reverted' && (
            <div data-testid="modal-reverted" className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 flex gap-2 items-start">
              <XCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium text-red-300">Transaction reverted</p>
                <p className="text-xs text-red-200/80 mt-0.5">
                  The transaction was mined but execution reverted. Check the contract audit log for details.
                </p>
              </div>
            </div>
          )}

          {state.status === 'unknown' && (
            <div data-testid="modal-unknown" className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 flex gap-2 items-start">
              <AlertTriangle size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium text-amber-300">Outcome unknown</p>
                <p className="text-xs text-amber-200/80 mt-0.5">
                  The receipt could not be fetched in time. Your transaction hash has been
                  retained. Do not resubmit — the transaction may have been included in a
                  block. Check the explorer to determine the outcome.
                </p>
                {state.txHash && txExplorer && (
                  <a
                    href={txExplorer}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="modal-unknown-tx-link"
                    className="text-[11px] text-amber-400 hover:underline flex items-center gap-1 mt-1"
                  >
                    Check on explorer <ExternalLink size={9} />
                  </a>
                )}
                {state.verification?.explanation && (
                  <p className="text-[11px] text-amber-200/60 mt-1">
                    {state.verification.explanation}
                  </p>
                )}
              </div>
            </div>
          )}

          {state.status === 'error' && state.errorMessage && (
            <div data-testid="modal-exec-error" className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 flex gap-2 items-start">
              <AlertTriangle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium text-red-300">Submission error</p>
                <p className="text-xs text-red-200/80 mt-0.5">{state.errorMessage}</p>
              </div>
            </div>
          )}

          {/* ── Notice ───────────────────────────────────────────────────── */}
          <p className="mt-4 text-[11px] text-ap-muted/70 leading-relaxed" data-testid="modal-recheck-notice">
            Policy will be rechecked by the contract at execution time against
            fresh on-chain state. This review does not reserve funds or guarantee
            the transaction will succeed.
          </p>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-ap-border flex gap-3">
          {isTerminal ? (
            <button
              onClick={() => { reset(); onClose() }}
              data-testid="modal-done-btn"
              className="flex-1 py-2 px-4 rounded-lg text-sm font-medium bg-ap-surface border border-ap-border text-ap-text hover:bg-ap-hover transition-colors"
            >
              Done
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                disabled={isInFlight}
                data-testid="modal-cancel-btn"
                className="flex-1 py-2 px-4 rounded-lg text-sm font-medium border border-ap-border text-ap-muted hover:text-ap-text hover:bg-ap-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>

              <button
                onClick={() => execute(receipt, ownerAddress)}
                disabled={!canSubmit}
                data-testid="modal-confirm-btn"
                aria-label="Confirm Payment"
                className="flex-1 py-2 px-4 rounded-lg text-sm font-semibold bg-ap-gold text-black hover:bg-ap-gold/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isInFlight && <Loader2 size={13} className="animate-spin" />}
                {state.status === 'awaiting-wallet' ? 'Confirm in wallet…' : 'Confirm Payment'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function preFlightErrorTitle(code: string): string {
  switch (code) {
    case 'WALLET_DISCONNECTED': return 'Wallet not connected'
    case 'WRONG_NETWORK':       return 'Wrong network'
    case 'UNAUTHORIZED_WALLET': return 'Wallet not authorised'
    case 'INVALID_RECEIPT':     return 'Invalid preparation receipt'
    default:                    return 'Pre-flight check failed'
  }
}
