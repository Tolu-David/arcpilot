/**
 * treasury-adapter.test.ts
 * Tests the TreasuryAdapter boundary — fixture shape, UINT256_MAX_STR, AdapterMode type.
 */
import { describe, it, expect } from 'vitest'
import {
  DEV_FIXTURE,
  UINT256_MAX_STR,
  ADAPTER_MODE,
  type TreasurySnapshot,
} from '@/lib/treasury-adapter'

describe('DEV_FIXTURE', () => {
  it('has all required TreasurySnapshot fields', () => {
    const keys: (keyof TreasurySnapshot)[] = [
      'totalBalance', 'obligations', 'reserve', 'spendable',
      'reserveBps', 'maxTxAmount', 'globalDailyLimit',
      'globalSpentToday', 'dailyRemaining', 'paymentCount',
      'payeeCount', 'paused',
    ]
    for (const k of keys) {
      expect(DEV_FIXTURE).toHaveProperty(k)
    }
  })

  it('uses bigint for all monetary values', () => {
    expect(typeof DEV_FIXTURE.totalBalance).toBe('bigint')
    expect(typeof DEV_FIXTURE.obligations).toBe('bigint')
    expect(typeof DEV_FIXTURE.reserve).toBe('bigint')
    expect(typeof DEV_FIXTURE.spendable).toBe('bigint')
    expect(typeof DEV_FIXTURE.maxTxAmount).toBe('bigint')
    expect(typeof DEV_FIXTURE.globalDailyLimit).toBe('bigint')
    expect(typeof DEV_FIXTURE.globalSpentToday).toBe('bigint')
    expect(typeof DEV_FIXTURE.dailyRemaining).toBe('bigint')
    expect(typeof DEV_FIXTURE.paymentCount).toBe('bigint')
    expect(typeof DEV_FIXTURE.payeeCount).toBe('bigint')
  })

  it('spendable + obligations + reserve equals totalBalance (fixture invariant)', () => {
    const { totalBalance, spendable, obligations, reserve } = DEV_FIXTURE
    expect(spendable + obligations + reserve).toBe(totalBalance)
  })

  it('globalSpentToday < globalDailyLimit', () => {
    expect(DEV_FIXTURE.globalSpentToday).toBeLessThan(DEV_FIXTURE.globalDailyLimit)
  })

  it('dailyRemaining = globalDailyLimit - globalSpentToday', () => {
    const { globalDailyLimit, globalSpentToday, dailyRemaining } = DEV_FIXTURE
    expect(dailyRemaining).toBe(globalDailyLimit - globalSpentToday)
  })

  it('is not paused', () => {
    expect(DEV_FIXTURE.paused).toBe(false)
  })
})

describe('UINT256_MAX_STR', () => {
  it('equals (2^256 - 1).toString()', () => {
    expect(UINT256_MAX_STR).toBe((2n ** 256n - 1n).toString())
  })

  it('is a non-empty string', () => {
    expect(typeof UINT256_MAX_STR).toBe('string')
    expect(UINT256_MAX_STR.length).toBeGreaterThan(0)
  })
})

describe('ADAPTER_MODE', () => {
  it('defaults to "live" when env var is not set', () => {
    // In test env VITE_TREASURY_ADAPTER is not set, so should be 'live'
    expect(ADAPTER_MODE).toBe('live')
  })
})
