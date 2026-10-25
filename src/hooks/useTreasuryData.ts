/**
 * useTreasuryData — single hook for all treasury contract reads.
 *
 * Handles:
 *  - chain ID guard (only reads from Arc Testnet)
 *  - disconnected wallet state
 *  - loading / error / stale states
 *  - dev adapter bypass when ADAPTER_MODE === 'dev'
 *  - bigint-safe arithmetic (no floating-point balance math)
 */

import { useAccount, useChainId, useReadContracts } from 'wagmi'
import { ARCPILOT_ABI } from '@/lib/abi'
import { ARC_TESTNET_CHAIN_ID } from '@/config'
import {
  ADAPTER_MODE,
  DEV_FIXTURE,
  type TreasurySnapshot,
} from '@/lib/treasury-adapter'

export type TreasuryStatus =
  | 'dev'           // dev adapter active — data is a fixture, not live
  | 'disconnected'  // wallet not connected
  | 'wrong-network' // connected but not on Arc Testnet
  | 'no-contract'   // no contract address provided
  | 'loading'       // initial fetch in flight
  | 'error'         // RPC error or all reads failed
  | 'success'       // data is fresh from chain

export interface TreasuryDataResult {
  status: TreasuryStatus
  data: TreasurySnapshot | null
  /** ISO timestamp of last successful fetch; null when loading/error */
  lastUpdated: string | null
  /** raw error message when status === 'error' */
  errorMessage: string | null
  refetch: () => void
}

const UINT256_MAX = 2n ** 256n - 1n

export function useTreasuryData(
  contractAddress: `0x${string}` | undefined
): TreasuryDataResult {
  const { isConnected } = useAccount()
  const chainId = useChainId()

  // ── Dev adapter bypass ─────────────────────────────────────────────────────
  const devMode = ADAPTER_MODE === 'dev'

  // Determine if we're on the right chain
  const onCorrectChain = chainId === ARC_TESTNET_CHAIN_ID

  const shouldFetch =
    !devMode && isConnected && onCorrectChain && !!contractAddress

  // ── Batch all reads in one multicall ──────────────────────────────────────
  const base = {
    address: contractAddress as `0x${string}`,
    abi: ARCPILOT_ABI,
    chainId: ARC_TESTNET_CHAIN_ID,
  } as const

  const { data, isLoading, isError, error, dataUpdatedAt, refetch } = useReadContracts({
    contracts: [
      { ...base, functionName: 'totalBalance' },
      { ...base, functionName: 'totalObligations' },
      { ...base, functionName: 'reserveAmount' },
      { ...base, functionName: 'spendableBalance' },
      { ...base, functionName: 'reserveBps' },
      { ...base, functionName: 'maxTxAmount' },
      { ...base, functionName: 'globalDailyLimit' },
      { ...base, functionName: 'globalSpentToday' },
      { ...base, functionName: 'dailyRemainingGlobal' },
      { ...base, functionName: 'paymentCount' },
      { ...base, functionName: 'payeeCount' },
      { ...base, functionName: 'paused' },
    ],
    query: {
      enabled: shouldFetch,
      refetchInterval: 15_000, // poll every 15 s
      staleTime: 10_000,
    },
  })

  // ── Dev adapter ────────────────────────────────────────────────────────────
  if (devMode) {
    return {
      status: 'dev',
      data: DEV_FIXTURE,
      lastUpdated: new Date().toISOString(),
      errorMessage: null,
      refetch: () => {},
    }
  }

  // ── Guard states ──────────────────────────────────────────────────────────
  if (!isConnected) {
    return noData('disconnected', refetch)
  }
  if (!onCorrectChain) {
    return noData('wrong-network', refetch)
  }
  if (!contractAddress) {
    return noData('no-contract', refetch)
  }
  if (isLoading) {
    return noData('loading', refetch)
  }

  // ── Error: all results failed ─────────────────────────────────────────────
  const anySuccess = data?.some((r) => r.status === 'success')
  if (isError || !data || !anySuccess) {
    return {
      status: 'error',
      data: null,
      lastUpdated: null,
      errorMessage:
        (error as Error | null)?.message ??
        'Failed to read contract. Check RPC connectivity.',
      refetch,
    }
  }

  // ── Extract results — treat individual failures as 0/false ───────────────
  function bigResult(i: number): bigint {
    const r = data![i]
    return r.status === 'success' ? (r.result as bigint) : 0n
  }
  function numResult(i: number): number {
    const r = data![i]
    return r.status === 'success' ? Number(r.result as number) : 0
  }
  function boolResult(i: number): boolean {
    const r = data![i]
    return r.status === 'success' ? (r.result as boolean) : false
  }

  const totalBalance     = bigResult(0)
  const obligations      = bigResult(1)
  const reserve          = bigResult(2)
  const spendable        = bigResult(3)
  const reserveBps       = numResult(4)
  const maxTxAmount      = bigResult(5)
  const globalDailyLimit = bigResult(6)
  const globalSpentToday = bigResult(7)
  // dailyRemainingGlobal can return uint256.max when uncapped — cap the display
  const rawRemaining     = bigResult(8)
  const dailyRemaining   = rawRemaining === UINT256_MAX ? UINT256_MAX : rawRemaining
  const paymentCount     = bigResult(9)
  const payeeCount       = bigResult(10)
  const paused           = boolResult(11)

  const snapshot: TreasurySnapshot = {
    totalBalance,
    obligations,
    reserve,
    spendable,
    reserveBps,
    maxTxAmount,
    globalDailyLimit,
    globalSpentToday,
    dailyRemaining,
    paymentCount,
    payeeCount,
    paused,
  }

  return {
    status: 'success',
    data: snapshot,
    lastUpdated: dataUpdatedAt ? new Date(dataUpdatedAt).toISOString() : null,
    errorMessage: null,
    refetch,
  }
}

function noData(
  status: TreasuryStatus,
  refetch: () => void
): TreasuryDataResult {
  return { status, data: null, lastUpdated: null, errorMessage: null, refetch }
}
