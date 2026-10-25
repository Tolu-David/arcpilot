/**
 * utils.test.ts
 * Tests integer/base-unit-safe USDC formatting helpers.
 * All values use bigint base units (6 decimals). No floating-point arithmetic.
 */
import { describe, it, expect } from 'vitest'
import { formatUSDC, parseUSDC, formatPercent } from '@/lib/utils'

describe('formatUSDC', () => {
  it('formats zero', () => {
    expect(formatUSDC(0n)).toBe('0.00')
  })

  it('formats 1 base unit (0.000001 USDC)', () => {
    expect(formatUSDC(1n)).toBe('0.00')
  })

  it('formats 100 base units (0.000100 USDC) — truncates to 2 decimal places', () => {
    expect(formatUSDC(100n)).toBe('0.00')
  })

  it('formats exactly 1 USDC (1_000_000 base units)', () => {
    expect(formatUSDC(1_000_000n)).toBe('1.00')
  })

  it('formats 10 USDC', () => {
    expect(formatUSDC(10_000_000n)).toBe('10.00')
  })

  it('formats 1,000 USDC with comma separator', () => {
    expect(formatUSDC(1_000_000_000n)).toBe('1,000.00')
  })

  it('formats 10,000 USDC', () => {
    expect(formatUSDC(10_000_000_000n)).toBe('10,000.00')
  })

  it('formats 1,250.50 USDC', () => {
    expect(formatUSDC(1_250_500_000n)).toBe('1,250.50')
  })

  it('never loses precision on large values (no floating-point)', () => {
    // 999,999,999 USDC — near uint256 practical max for display
    expect(formatUSDC(999_999_999_000_000n)).toBe('999,999,999.00')
  })

  it('handles fractional cents correctly', () => {
    // 1.99 USDC
    expect(formatUSDC(1_990_000n)).toBe('1.99')
  })
})

describe('parseUSDC', () => {
  it('parses "0" to 0n', () => {
    expect(parseUSDC('0')).toBe(0n)
  })

  it('parses "1" to 1_000_000n', () => {
    expect(parseUSDC('1')).toBe(1_000_000n)
  })

  it('parses "1.5" to 1_500_000n', () => {
    expect(parseUSDC('1.5')).toBe(1_500_000n)
  })

  it('parses "1000.00" to 1_000_000_000n', () => {
    expect(parseUSDC('1000.00')).toBe(1_000_000_000n)
  })

  it('round-trips formatUSDC → parseUSDC for whole amounts', () => {
    const amounts = [0n, 1_000_000n, 5_000_000n, 100_000_000n, 1_000_000_000_000n]
    for (const a of amounts) {
      const formatted = formatUSDC(a)
      const reparsed = parseUSDC(formatted)
      // Allow up to 1 cent of rounding error (formatUSDC truncates to 2dp)
      const diff = a - reparsed
      expect(diff >= 0n && diff < 10_000n).toBe(true)
    }
  })
})

describe('formatPercent', () => {
  it('returns "0" when denominator is 0', () => {
    expect(formatPercent(0n, 0n)).toBe('0')
  })

  it('returns "0.0" for 0 of 1000', () => {
    expect(formatPercent(0n, 1000n)).toBe('0.0')
  })

  it('returns "100.0" for 1000 of 1000', () => {
    expect(formatPercent(1000n, 1000n)).toBe('100.0')
  })

  it('returns "50.0" for 500 of 1000', () => {
    expect(formatPercent(500n, 1000n)).toBe('50.0')
  })

  it('returns "10.0" for 100 of 1000', () => {
    expect(formatPercent(100n, 1000n)).toBe('10.0')
  })

  it('returns "33.3" for 1 of 3', () => {
    expect(formatPercent(1n, 3n)).toBe('33.3')
  })
})
