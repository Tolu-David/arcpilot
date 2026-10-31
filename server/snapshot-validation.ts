/**
 * server/snapshot-validation.ts
 *
 * [security fix M-4] Plausibility checks for caller-supplied ContractStateSnapshot.
 *
 * The snapshot is provided by the browser and cannot be trusted for authorisation,
 * but we can reject obviously impossible values before running policy evaluation.
 * This prevents crafted snapshots from producing misleading policy results.
 *
 * Rules:
 *  1. spendableBalance <= totalBalance
 *     (can't have more spendable than the total treasury balance)
 *  2. dailyRemainingGlobal <= globalDailyLimit (or globalDailyLimit == 0 = unlimited)
 *     (remaining budget can't exceed the configured limit)
 *  3. reserveAmount <= totalBalance
 *     (reserve is derived from the balance — can't exceed it)
 *  4. activeObligationsTotal <= totalBalance
 *     (obligations are tracked amounts — can't exceed the balance in a valid state)
 *
 * Note: these are sanity guards, not a replacement for fetching authoritative
 * state from the RPC. The contract itself enforces all limits at execution time.
 */

import type { ContractStateSnapshot } from '../shared/types.js'

export interface SnapshotPlausibilityError {
  field: string
  message: string
}

/**
 * Validate snapshot plausibility.
 * Returns null if the snapshot is plausible, or an error object if not.
 */
export function validateSnapshotPlausibility(
  s: ContractStateSnapshot,
): SnapshotPlausibilityError | null {
  // Rule 1: spendableBalance <= totalBalance
  if (s.spendableBalance > s.totalBalance) {
    return {
      field: 'spendableBalance',
      message:
        `snapshot.spendableBalance (${s.spendableBalance}) exceeds snapshot.totalBalance (${s.totalBalance}). ` +
        'Fetch a fresh snapshot directly from the RPC.',
    }
  }

  // Rule 2: dailyRemainingGlobal <= globalDailyLimit (when limit is non-zero)
  if (s.globalDailyLimit > 0n && s.dailyRemainingGlobal > s.globalDailyLimit) {
    return {
      field: 'dailyRemainingGlobal',
      message:
        `snapshot.dailyRemainingGlobal (${s.dailyRemainingGlobal}) exceeds snapshot.globalDailyLimit (${s.globalDailyLimit}). ` +
        'Fetch a fresh snapshot directly from the RPC.',
    }
  }

  // Rule 3: reserveAmount <= totalBalance
  if (s.reserveAmount > s.totalBalance) {
    return {
      field: 'reserveAmount',
      message:
        `snapshot.reserveAmount (${s.reserveAmount}) exceeds snapshot.totalBalance (${s.totalBalance}). ` +
        'Fetch a fresh snapshot directly from the RPC.',
    }
  }

  // Rule 4: activeObligationsTotal <= totalBalance
  if (s.activeObligationsTotal > s.totalBalance) {
    return {
      field: 'activeObligationsTotal',
      message:
        `snapshot.activeObligationsTotal (${s.activeObligationsTotal}) exceeds snapshot.totalBalance (${s.totalBalance}). ` +
        'Fetch a fresh snapshot directly from the RPC.',
    }
  }

  return null
}
