/**
 * src/hooks/usePaymentExecution.ts
 *
 * Submits the `pay()` transaction using parameters from a validated
 * PaymentPreparationReceipt and tracks the full transaction lifecycle
 * through to verified confirmation.
 *
 * Lifecycle:
 *   idle → checking → awaiting-wallet → submitted → pending
 *     → confirmed  (receipt verified: event matches requestId/to/amount)
 *     → reverted   (tx mined but EVM execution reverted)
 *     → unknown    (receipt timeout; tx hash retained for reconciliation)
 *     → rejected   (wallet rejected; no tx broadcast)
 *     → error      (unexpected error)
 *
 * Security guarantees:
 *  - All transaction parameters come exclusively from the preparation receipt.
 *  - The browser never overrides `to`, `amount`, `requestId`, or `contractAddress`.
 *  - Chain ID is verified against the receipt before submission.
 *  - Wallet rejection sets flowState='RejectedByWallet' — no on-chain state change.
 *  - "Confirmed" is ONLY set after verifyTransactionReceipt() validates the
 *    PaymentExecuted event's requestId, recipient, and amount against the receipt.
 *  - Receipt timeout sets flowState='Unknown' and retains the tx hash for
 *    manual reconciliation.  No second payment is submitted automatically.
 *  - The AI recommendation is never consulted here; it is advisory only.
 *  - Private keys are never exposed; only the wagmi connector signs.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  useAccount,
  useChainId,
  useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi'
import type { PaymentPreparationReceipt, PaymentFlowState, TxVerificationResult } from '../../shared/types'
import { ARCPILOT_ABI } from '@/lib/abi'
import { verifyTransactionReceipt, receiptTimeoutResult } from '@/lib/verifyTransaction'

// ── Receipt watch timeout ─────────────────────────────────────────────────────
// How long (ms) to wait for a receipt before giving up and setting Unknown.
// A receipt timeout does NOT mean the tx failed — it may still be in the mempool.
// Retain the tx hash; do NOT resubmit.
const RECEIPT_TIMEOUT_MS = 120_000 // 2 minutes

// ── Execution state ───────────────────────────────────────────────────────────

export type ExecutionStatus =
  | 'idle'
  | 'checking'        // pre-flight checks running
  | 'awaiting-wallet' // waiting for wallet signature
  | 'submitted'       // tx hash received; waiting for block inclusion
  | 'pending'         // tx in mempool; receipt watch active
  | 'confirmed'       // receipt verified; PaymentExecuted event matches
  | 'rejected'        // wallet rejected (UserRejectedRequestError or similar)
  | 'reverted'        // tx mined but EVM execution reverted
  | 'unknown'         // receipt timeout or unresolvable outcome
  | 'error'           // unexpected error (not a wallet rejection)

export interface ExecutionState {
  status: ExecutionStatus
  /** The resulting flow state once execution settles. */
  flowState: Extract<
    PaymentFlowState,
    'Submitted' | 'Confirmed' | 'RejectedByWallet' | 'Reverted' | 'Unknown' | 'Ready'
  > | null
  /** Transaction hash (available once submitted — retained even on timeout). */
  txHash: `0x${string}` | null
  /** Full verification result (available once receipt is processed). */
  verification: TxVerificationResult | null
  /** Error message for non-rejection errors. */
  errorMessage: string | null
  /** Human-readable description of the current status. */
  statusLabel: string
}

export interface PreFlightError {
  code: PreFlightErrorCode
  message: string
}

export type PreFlightErrorCode =
  | 'WALLET_DISCONNECTED'
  | 'WRONG_NETWORK'
  | 'UNAUTHORIZED_WALLET'
  | 'INVALID_RECEIPT'

const STATUS_LABELS: Record<ExecutionStatus, string> = {
  idle:              'Ready to submit',
  checking:          'Checking wallet and network…',
  'awaiting-wallet': 'Waiting for wallet confirmation…',
  submitted:         'Transaction submitted — waiting for block inclusion…',
  pending:           'Transaction pending — verifying receipt…',
  confirmed:         'Payment confirmed and verified',
  rejected:          'Transaction rejected by wallet',
  reverted:          'Transaction reverted on-chain',
  unknown:           'Outcome unknown — transaction hash retained for reconciliation',
  error:             'An unexpected error occurred',
}

// ── Pre-flight validation ─────────────────────────────────────────────────────

/**
 * Run pre-flight checks against the connected wallet and a preparation receipt.
 * Returns null when all checks pass, or a PreFlightError describing the problem.
 */
export function runPreFlightChecks(
  receipt: PaymentPreparationReceipt,
  connectedAddr: `0x${string}` | undefined,
  connectedChainId: number | undefined,
  ownerAddress: `0x${string}` | undefined,
): PreFlightError | null {
  // 1. Wallet must be connected
  if (!connectedAddr) {
    return {
      code: 'WALLET_DISCONNECTED',
      message: 'No wallet is connected. Please connect a wallet to continue.',
    }
  }

  // 2. Wallet must be on the expected chain
  if (connectedChainId !== receipt.chainId) {
    return {
      code: 'WRONG_NETWORK',
      message: `Your wallet is connected to chain ${connectedChainId ?? 'unknown'}, but this payment requires chain ${receipt.chainId} (${receipt.chain}). Switch networks before continuing.`,
    }
  }

  // 3. Connected wallet must be the authorised contract owner (pay() is onlyOwner)
  //    Block if ownerAddress is undefined — wait for the contract read to resolve
  if (!ownerAddress) {
    return {
      code: 'UNAUTHORIZED_WALLET',
      message: 'Contract owner address could not be determined. Please wait and try again.',
    }
  }
  if (connectedAddr.toLowerCase() !== ownerAddress.toLowerCase()) {
    return {
      code: 'UNAUTHORIZED_WALLET',
      message: `Only the contract owner (${ownerAddress.slice(0, 8)}…${ownerAddress.slice(-6)}) may submit payments. Your connected wallet is not authorised.`,
    }
  }

  // 4. Receipt structural check — requestId must be a valid bytes32 hex string
  if (!/^0x[0-9a-f]{64}$/i.test(receipt.requestId)) {
    return {
      code: 'INVALID_RECEIPT',
      message: 'The preparation receipt contains an invalid request ID. Please try again.',
    }
  }

  return null
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export interface UsePaymentExecutionReturn {
  state: ExecutionState
  preFlightError: PreFlightError | null
  /**
   * Submit the transaction.  Returns immediately; watch `state.status` for updates.
   * Receipt watch starts automatically once the tx hash is received.
   * If the receipt does not arrive within RECEIPT_TIMEOUT_MS, flowState becomes
   * 'Unknown' and the tx hash is retained — do NOT call execute() again.
   */
  execute: (receipt: PaymentPreparationReceipt, ownerAddress: `0x${string}` | undefined) => Promise<void>
  /** Reset to idle state. */
  reset: () => void
}

export function usePaymentExecution(): UsePaymentExecutionReturn {
  const { address: connectedAddr } = useAccount()
  const connectedChainId = useChainId()

  const [state, setState] = useState<ExecutionState>({
    status: 'idle',
    flowState: null,
    txHash: null,
    verification: null,
    errorMessage: null,
    statusLabel: STATUS_LABELS.idle,
  })
  const [preFlightError, setPreFlightError] = useState<PreFlightError | null>(null)

  // Refs to track the active submission without triggering re-renders
  const pendingTxHashRef     = useRef<`0x${string}` | null>(null)
  const pendingReceiptRef    = useRef<PaymentPreparationReceipt | null>(null)
  const receiptTimeoutRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const timeoutFiredRef      = useRef(false)

  const [watchHash, setWatchHash] = useState<`0x${string}` | undefined>(undefined)

  const { writeContractAsync } = useWriteContract()

  // ── Receipt watcher ───────────────────────────────────────────────────────
  const { data: txReceipt } = useWaitForTransactionReceipt({
    hash: watchHash,
    query: { enabled: !!watchHash },
  })

  // Process the receipt once it arrives
  useEffect(() => {
    if (
      !txReceipt ||
      !pendingTxHashRef.current ||
      !pendingReceiptRef.current ||
      state.status !== 'pending'
    ) return

    // Cancel the timeout — we got the receipt in time
    if (receiptTimeoutRef.current) {
      clearTimeout(receiptTimeoutRef.current)
      receiptTimeoutRef.current = null
    }

    const prepReceipt = pendingReceiptRef.current
    const result = verifyTransactionReceipt(txReceipt, prepReceipt)

    setState({
      status:       result.outcome === 'confirmed' ? 'confirmed'
                  : result.outcome === 'reverted'  ? 'reverted'
                  : 'unknown',
      flowState:    result.flowState,
      txHash:       result.txHash,
      verification: result,
      errorMessage: result.verified ? null : result.explanation,
      statusLabel:  STATUS_LABELS[
        result.outcome === 'confirmed' ? 'confirmed'
        : result.outcome === 'reverted' ? 'reverted'
        : 'unknown'
      ],
    })

    // Clean up refs
    pendingTxHashRef.current  = null
    pendingReceiptRef.current = null
    timeoutFiredRef.current   = false
  }, [txReceipt, state.status])

  // ── Execute ───────────────────────────────────────────────────────────────

  const execute = useCallback(async (
    receipt: PaymentPreparationReceipt,
    ownerAddress: `0x${string}` | undefined,
  ): Promise<void> => {
    // Pre-flight checks
    setState(s => ({ ...s, status: 'checking', statusLabel: STATUS_LABELS.checking }))
    setPreFlightError(null)

    const err = runPreFlightChecks(receipt, connectedAddr, connectedChainId, ownerAddress)
    if (err) {
      setPreFlightError(err)
      setState(s => ({ ...s, status: 'idle', statusLabel: STATUS_LABELS.idle }))
      return
    }

    // All parameters come exclusively from the server-produced receipt.
    // The browser never supplies `to`, `amount`, `requestId`, or `contractAddress`.
    const to        = receipt.recipient    as `0x${string}`
    const amount    = BigInt(receipt.amountBaseUnits)
    const requestId = receipt.requestId    as `0x${string}`
    const memo      = receipt.memo
    const contract  = receipt.contractAddress as `0x${string}`

    setState({
      status:       'awaiting-wallet',
      flowState:    null,
      txHash:       null,
      verification: null,
      errorMessage: null,
      statusLabel:  STATUS_LABELS['awaiting-wallet'],
    })

    try {
      const txHash = await writeContractAsync({
        address:      contract,
        abi:          ARCPILOT_ABI,
        functionName: 'pay',
        // Argument order must match the ABI: pay(to, amount, requestId, memo)
        args:         [to, amount, requestId, memo],
        chainId:      receipt.chainId as number,
      })

      // Tx hash received — record it and start watching for the receipt
      pendingTxHashRef.current  = txHash
      pendingReceiptRef.current = receipt
      timeoutFiredRef.current   = false

      setState({
        status:       'submitted',
        flowState:    'Submitted',
        txHash,
        verification: null,
        errorMessage: null,
        statusLabel:  STATUS_LABELS.submitted,
      })

      // Transition to 'pending' and start the receipt watcher
      setState(s => ({ ...s, status: 'pending', statusLabel: STATUS_LABELS.pending }))
      setWatchHash(txHash)

      // Start receipt timeout — if the receipt doesn't arrive, set Unknown
      receiptTimeoutRef.current = setTimeout(() => {
        // Only fire if still waiting (not already resolved by receipt)
        if (!timeoutFiredRef.current && pendingTxHashRef.current === txHash) {
          timeoutFiredRef.current   = true
          const result = receiptTimeoutResult(txHash)
          pendingTxHashRef.current  = null
          pendingReceiptRef.current = null

          setState({
            status:       'unknown',
            flowState:    'Unknown',
            txHash,
            verification: result,
            errorMessage: result.explanation,
            statusLabel:  STATUS_LABELS.unknown,
          })
        }
      }, RECEIPT_TIMEOUT_MS)

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)

      // Detect wallet rejection — do NOT mark the payment as failed on-chain.
      // The contract was never reached; no tx was broadcast.
      const isRejection =
        msg.includes('User rejected') ||
        msg.includes('user rejected') ||
        msg.includes('UserRejectedRequestError') ||
        msg.includes('ACTION_REJECTED') ||
        msg.includes('4001') // EIP-1193 user rejected error code

      setState({
        status:       isRejection ? 'rejected' : 'error',
        flowState:    isRejection ? 'RejectedByWallet' : null,
        txHash:       null,
        verification: null,
        errorMessage: isRejection
          ? 'You rejected the transaction in your wallet. No funds were moved.'
          : msg,
        statusLabel:  STATUS_LABELS[isRejection ? 'rejected' : 'error'],
      })
    }
  }, [connectedAddr, connectedChainId, writeContractAsync])

  // ── Reset ─────────────────────────────────────────────────────────────────

  const reset = useCallback(() => {
    if (receiptTimeoutRef.current) {
      clearTimeout(receiptTimeoutRef.current)
      receiptTimeoutRef.current = null
    }
    pendingTxHashRef.current  = null
    pendingReceiptRef.current = null
    timeoutFiredRef.current   = false
    setPreFlightError(null)
    setWatchHash(undefined)
    setState({
      status:       'idle',
      flowState:    null,
      txHash:       null,
      verification: null,
      errorMessage: null,
      statusLabel:  STATUS_LABELS.idle,
    })
  }, [])

  return { state, preFlightError, execute, reset }
}
