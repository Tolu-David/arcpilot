/**
 * src/test/verifyTransaction.test.ts
 *
 * Tests for the pure transaction-receipt verifier.
 * No wagmi, no React, no network — all pure function calls.
 *
 * Covers:
 *  - Confirmed (all checks pass)
 *  - Reverted (EVM execution reverted)
 *  - Wrong chain / wrong contract address
 *  - PaymentExecuted event not found
 *  - Event found but requestId mismatch
 *  - Event found but recipient (to) mismatch
 *  - Event found but amount mismatch
 *  - ERC-20 Transfer log mismatch
 *  - Transfer log absent (not an error)
 *  - Receipt timeout (receiptTimeoutResult)
 *  - Unknown outcome
 *  - Boundary: amount exactly at edge values
 *  - Malformed log data (graceful degradation)
 *  - Multiple logs (correct one selected)
 *  - Mismatched chain retains tx hash
 */

import { describe, it, expect } from 'vitest'
import type { TransactionReceipt } from 'viem'
// Viem's Log generic has `blockHash: 0x... | null` in the pending-log variant;
// we always use mined logs (non-nullable) so cast via unknown.
type Log = Parameters<typeof verifyTransactionReceipt>[0]['logs'][number]
import type { PaymentPreparationReceipt } from '../../shared/types'
import {
  verifyTransactionReceipt,
  receiptTimeoutResult,
  PAYMENT_EXECUTED_TOPIC,
  ERC20_TRANSFER_TOPIC,
  normaliseAddr,
} from '../lib/verifyTransaction'

// ── Fixtures ──────────────────────────────────────────────────────────────────

// All test addresses must be exactly 42 chars (0x + 40 hex digits)
const CONTRACT   = '0xC0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C001' as `0x${string}`
const RECIPIENT  = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa01' as `0x${string}`
const TOKEN      = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb01' as `0x${string}`
const REQUEST_ID = ('0x' + 'ab'.repeat(32)) as `0x${string}` // valid bytes32
const TX_HASH    = ('0x' + 'cc'.repeat(32)) as `0x${string}`
const AMOUNT    = 500_000n   // 0.5 USDC
const BLOCK_NUM = 12345678n

/** Pad an address to a 32-byte (64 hex char) topic (ABI encoding for indexed address). */
function addrTopic(addr: string): `0x${string}` {
  const raw = addr.toLowerCase().replace(/^0x/, '')
  return `0x${'00'.repeat(12)}${raw}` as `0x${string}`
}

/** Encode a uint256 as 32-byte hex (ABI encoding). */
function uint256Hex(n: bigint): string {
  return n.toString(16).padStart(64, '0')
}

/** ABI-encode (uint256 amount, string memo). */
function encodeAmountMemo(amount: bigint, memo: string): `0x${string}` {
  const amountHex = uint256Hex(amount)
  const offsetHex = uint256Hex(64n)  // offset to memo bytes = 64 (0x40)
  const memoBytes = Buffer.from(memo, 'utf8')
  const memoLenHex = uint256Hex(BigInt(memoBytes.length))
  const memoPadded = Buffer.alloc(Math.ceil(memoBytes.length / 32) * 32)
  memoBytes.copy(memoPadded)
  const memoHex = memoPadded.toString('hex')
  return `0x${amountHex}${offsetHex}${memoLenHex}${memoHex}` as `0x${string}`
}

/** Build a minimal valid PaymentExecuted log. */
function makePaymentExecutedLog(overrides?: {
  address?: string
  requestId?: string
  to?: string
  amount?: bigint
  memo?: string
}): Log {
  const rId    = overrides?.requestId ?? REQUEST_ID
  const to     = overrides?.to        ?? RECIPIENT
  const amount = overrides?.amount    ?? AMOUNT
  const memo   = overrides?.memo      ?? 'test memo'
  return {
    address:          (overrides?.address ?? CONTRACT) as `0x${string}`,
    topics: [
      PAYMENT_EXECUTED_TOPIC,
      addrTopic('0x0000000000000000000000000000000000000001'), // paymentId (indexed uint256 as padded)
      addrTopic(to),
      rId as `0x${string}`,
    ] as [`0x${string}`, ...`0x${string}`[]],
    data:             encodeAmountMemo(amount, memo),
    blockNumber:      BLOCK_NUM,
    transactionHash:  TX_HASH,
    transactionIndex: 0,
    blockHash:        `0x${'dd'.repeat(32)}` as `0x${string}`,
    logIndex:         0,
    removed:          false,
  } as unknown as Log
}

/** Build a minimal valid ERC-20 Transfer log. */
function makeTransferLog(overrides?: {
  tokenAddress?: string
  from?: string
  to?: string
  value?: bigint
}): Log {
  return {
    address:          (overrides?.tokenAddress ?? TOKEN) as `0x${string}`,
    topics: [
      ERC20_TRANSFER_TOPIC,
      addrTopic(overrides?.from ?? CONTRACT),
      addrTopic(overrides?.to  ?? RECIPIENT),
    ] as [`0x${string}`, ...`0x${string}`[]],
    data:             `0x${uint256Hex(overrides?.value ?? AMOUNT)}` as `0x${string}`,
    blockNumber:      BLOCK_NUM,
    transactionHash:  TX_HASH,
    transactionIndex: 0,
    blockHash:        `0x${'dd'.repeat(32)}` as `0x${string}`,
    logIndex:         1,
    removed:          false,
  } as unknown as Log
}

/** Build a minimal valid TransactionReceipt. */
function makeReceipt(overrides?: {
  status?: 'success' | 'reverted'
  to?: string
  logs?: Log[]
}): TransactionReceipt {
  return {
    transactionHash:   TX_HASH,
    transactionIndex:  0,
    blockHash:         '0x' + 'dd'.repeat(32) as `0x${string}`,
    blockNumber:       BLOCK_NUM,
    from:              '0x3333333333333333333333333333333333333306' as `0x${string}`,
    to:                (overrides?.to ?? CONTRACT) as `0x${string}`,
    cumulativeGasUsed: 100_000n,
    gasUsed:           50_000n,
    logs:              overrides?.logs ?? [makePaymentExecutedLog(), makeTransferLog()],
    logsBloom:         '0x' + '00'.repeat(256) as `0x${string}`,
    status:            overrides?.status ?? 'success',
    type:              'eip1559',
    contractAddress:   null,
    effectiveGasPrice: 1n,
  }
}

/** Build a minimal valid PaymentPreparationReceipt. */
function makePrep(overrides?: Partial<PaymentPreparationReceipt>): PaymentPreparationReceipt {
  return {
    prepId:               'prep-001',
    idempotencyKey:       'idem-001',
    requestId:            REQUEST_ID,
    cached:               false,
    serviceId:            'data-scraper',
    recipient:            RECIPIENT,
    amountBaseUnits:      String(AMOUNT),
    amountDisplay:        '0.500000',
    memo:                 'test memo',
    chain:                'Arc Testnet',
    chainId:              5042002,
    contractAddress:      CONTRACT,
    tokenAddress:         TOKEN,
    flowState:            'PolicyChecked',
    policy: {
      allowed:          true,
      approvalRequired: false,
      reasonCode:       'POLICY_OK',
      explanation:      'All checks passed.',
      evaluatedAt:      new Date().toISOString(),
    },
    spendableAtCheck:     '10000000',
    dailyRemainingAtCheck:'10000000',
    preparedAt:           new Date().toISOString(),
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('verifyTransactionReceipt — confirmed (happy path)', () => {
  it('returns outcome=confirmed when all checks pass', () => {
    const result = verifyTransactionReceipt(makeReceipt(), makePrep())
    expect(result.outcome).toBe('confirmed')
    expect(result.verified).toBe(true)
    expect(result.flowState).toBe('Confirmed')
  })

  it('returns the correct txHash', () => {
    const result = verifyTransactionReceipt(makeReceipt(), makePrep())
    expect(result.txHash).toBe(TX_HASH)
  })

  it('returns the block number', () => {
    const result = verifyTransactionReceipt(makeReceipt(), makePrep())
    expect(result.blockNumber).toBe(BLOCK_NUM)
  })

  it('populates decodedEvent with matching fields', () => {
    const result = verifyTransactionReceipt(makeReceipt(), makePrep())
    expect(result.decodedEvent).not.toBeNull()
    expect(result.decodedEvent?.amount).toBe(AMOUNT)
    expect(normaliseAddr(result.decodedEvent!.to)).toBe(normaliseAddr(RECIPIENT))
  })

  it('confirmed with a zero-length memo', () => {
    const log  = makePaymentExecutedLog({ memo: '' })
    const r    = makeReceipt({ logs: [log] })
    const result = verifyTransactionReceipt(r, makePrep({ memo: '' }))
    expect(result.outcome).toBe('confirmed')
  })

  it('confirmed when Transfer log is absent (not an error)', () => {
    const r = makeReceipt({ logs: [makePaymentExecutedLog()] }) // no Transfer
    const result = verifyTransactionReceipt(r, makePrep())
    expect(result.outcome).toBe('confirmed')
    expect(result.verified).toBe(true)
  })

  it('confirmed with multiple unrelated logs before the PaymentExecuted log', () => {
    const noise: Log = {
      address: '0xDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd99' as `0x${string}`,
      topics: ['0x' + 'ff'.repeat(32) as `0x${string}`],
      data: '0x',
      blockNumber: BLOCK_NUM,
      transactionHash: TX_HASH,
      transactionIndex: 0,
      blockHash: '0x' + 'dd'.repeat(32) as `0x${string}`,
      logIndex: 0,
      removed: false,
    }
    const r = makeReceipt({ logs: [noise, makePaymentExecutedLog(), makeTransferLog()] })
    expect(verifyTransactionReceipt(r, makePrep()).outcome).toBe('confirmed')
  })

  it('explanation mentions requestId and recipient', () => {
    const result = verifyTransactionReceipt(makeReceipt(), makePrep())
    expect(result.explanation).toMatch(/requestId/i)
    expect(result.explanation.toLowerCase()).toContain('recipient')
  })
})

describe('verifyTransactionReceipt — reverted', () => {
  it('returns outcome=reverted when status is reverted', () => {
    const r = makeReceipt({ status: 'reverted' })
    const result = verifyTransactionReceipt(r, makePrep())
    expect(result.outcome).toBe('reverted')
    expect(result.verified).toBe(false)
    expect(result.flowState).toBe('Reverted')
  })

  it('retains the txHash on revert', () => {
    const r = makeReceipt({ status: 'reverted' })
    expect(verifyTransactionReceipt(r, makePrep()).txHash).toBe(TX_HASH)
  })

  it('decodedEvent is null on revert (check halts before event parse)', () => {
    const r = makeReceipt({ status: 'reverted' })
    expect(verifyTransactionReceipt(r, makePrep()).decodedEvent).toBeNull()
  })
})

describe('verifyTransactionReceipt — wrong chain / contract', () => {
  it('returns outcome=wrong-chain when receipt.to is a different contract', () => {
    const r = makeReceipt({ to: '0xEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEe02' })
    const result = verifyTransactionReceipt(r, makePrep())
    expect(result.outcome).toBe('wrong-chain')
    expect(result.flowState).toBe('Unknown')
  })

  it('retains txHash on wrong-chain', () => {
    const r = makeReceipt({ to: '0xEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEe02' })
    expect(verifyTransactionReceipt(r, makePrep()).txHash).toBe(TX_HASH)
  })

  it('does not return wrong-chain when receipt.to is null (contract creation)', () => {
    // receipt.to = null means a contract creation — don't flag as wrong-chain
    const r = { ...makeReceipt(), to: null } as TransactionReceipt
    // It will fall through to event-not-found or confirmed depending on logs
    const result = verifyTransactionReceipt(r, makePrep())
    expect(result.outcome).not.toBe('wrong-chain')
  })
})

describe('verifyTransactionReceipt — event not found', () => {
  it('returns event-not-found when no PaymentExecuted log exists', () => {
    const r = makeReceipt({ logs: [makeTransferLog()] })
    const result = verifyTransactionReceipt(r, makePrep())
    expect(result.outcome).toBe('event-not-found')
    expect(result.flowState).toBe('Unknown')
  })

  it('returns event-not-found for empty logs array', () => {
    const r = makeReceipt({ logs: [] })
    expect(verifyTransactionReceipt(r, makePrep()).outcome).toBe('event-not-found')
  })

  it('returns event-not-found when PaymentExecuted is from wrong contract', () => {
    const log = makePaymentExecutedLog({ address: '0xEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEe02' })
    const r = makeReceipt({ logs: [log] })
    expect(verifyTransactionReceipt(r, makePrep()).outcome).toBe('event-not-found')
  })
})

describe('verifyTransactionReceipt — event mismatch: requestId', () => {
  it('returns event-mismatch when requestId does not match', () => {
    const wrongId = ('0x' + 'ff'.repeat(32)) as `0x${string}`
    const log = makePaymentExecutedLog({ requestId: wrongId })
    const r = makeReceipt({ logs: [log] })
    const result = verifyTransactionReceipt(r, makePrep())
    expect(result.outcome).toBe('event-mismatch')
    expect(result.verified).toBe(false)
  })

  it('populates decodedEvent even on requestId mismatch (for logging)', () => {
    const wrongId = ('0x' + 'ff'.repeat(32)) as `0x${string}`
    const log = makePaymentExecutedLog({ requestId: wrongId })
    const r = makeReceipt({ logs: [log] })
    const result = verifyTransactionReceipt(r, makePrep())
    expect(result.decodedEvent).not.toBeNull()
  })

  it('explanation mentions requestId mismatch', () => {
    const wrongId = ('0x' + 'ff'.repeat(32)) as `0x${string}`
    const log = makePaymentExecutedLog({ requestId: wrongId })
    const r = makeReceipt({ logs: [log] })
    const result = verifyTransactionReceipt(r, makePrep())
    expect(result.explanation.toLowerCase()).toContain('requestid')
  })
})

describe('verifyTransactionReceipt — event mismatch: recipient', () => {
  it('returns event-mismatch when to address does not match', () => {
    const wrongTo = '0xFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFf03' as `0x${string}`
    const log = makePaymentExecutedLog({ to: wrongTo })
    const r = makeReceipt({ logs: [log] })
    expect(verifyTransactionReceipt(r, makePrep()).outcome).toBe('event-mismatch')
  })

  it('comparison is case-insensitive', () => {
    // Uppercase RECIPIENT should match lowercase in prep
    const upperRecipient = RECIPIENT.toUpperCase() as `0x${string}`
    const log = makePaymentExecutedLog({ to: upperRecipient })
    const r = makeReceipt({ logs: [log] })
    // normalisation makes them equal — should confirm, not mismatch
    const result = verifyTransactionReceipt(r, makePrep())
    expect(result.outcome).toBe('confirmed')
  })
})

describe('verifyTransactionReceipt — event mismatch: amount', () => {
  it('returns event-mismatch when amount does not match', () => {
    const log = makePaymentExecutedLog({ amount: AMOUNT + 1n })
    const r = makeReceipt({ logs: [log] })
    expect(verifyTransactionReceipt(r, makePrep()).outcome).toBe('event-mismatch')
  })

  it('returns event-mismatch when amount is zero in event but non-zero in prep', () => {
    const log = makePaymentExecutedLog({ amount: 0n })
    const r = makeReceipt({ logs: [log] })
    expect(verifyTransactionReceipt(r, makePrep()).outcome).toBe('event-mismatch')
  })

  it('confirmed when amount exactly matches (boundary: 1 base unit)', () => {
    const oneUnit = 1n
    const log = makePaymentExecutedLog({ amount: oneUnit })
    const r = makeReceipt({ logs: [log] })
    expect(
      verifyTransactionReceipt(r, makePrep({ amountBaseUnits: '1' })).outcome
    ).toBe('confirmed')
  })

  it('event-mismatch when amount is 1 off (boundary: amount - 1)', () => {
    const log = makePaymentExecutedLog({ amount: AMOUNT - 1n })
    const r = makeReceipt({ logs: [log] })
    expect(verifyTransactionReceipt(r, makePrep()).outcome).toBe('event-mismatch')
  })
})

describe('verifyTransactionReceipt — Transfer log mismatch', () => {
  it('returns transfer-mismatch when Transfer log has wrong `to`', () => {
    const wrongTo = '0xFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFf03' as `0x${string}`
    const transfer = makeTransferLog({ to: wrongTo })
    const r = makeReceipt({ logs: [makePaymentExecutedLog(), transfer] })
    expect(verifyTransactionReceipt(r, makePrep()).outcome).toBe('transfer-mismatch')
  })

  it('returns transfer-mismatch when Transfer log has wrong `from`', () => {
    const wrongFrom = '0x1111111111111111111111111111111111111104' as `0x${string}`
    const transfer = makeTransferLog({ from: wrongFrom })
    const r = makeReceipt({ logs: [makePaymentExecutedLog(), transfer] })
    expect(verifyTransactionReceipt(r, makePrep()).outcome).toBe('transfer-mismatch')
  })

  it('confirmed when Transfer log is absent (best-effort check)', () => {
    const r = makeReceipt({ logs: [makePaymentExecutedLog()] })
    expect(verifyTransactionReceipt(r, makePrep()).outcome).toBe('confirmed')
  })

  it('confirmed when Transfer log is from a different token address (not our token)', () => {
    // Different token address → our finder skips it (no match for our token)
    const otherToken = makeTransferLog({ tokenAddress: '0x2222222222222222222222222222222222222205' as `0x${string}` })
    const r = makeReceipt({ logs: [makePaymentExecutedLog(), otherToken] })
    expect(verifyTransactionReceipt(r, makePrep()).outcome).toBe('confirmed')
  })
})

describe('verifyTransactionReceipt — malformed log data', () => {
  it('returns event-mismatch when log data is too short to decode', () => {
    const log = makePaymentExecutedLog()
    // Corrupt the data field
    const badLog = { ...log, data: '0x1234' as `0x${string}` }
    const r = makeReceipt({ logs: [badLog] })
    expect(verifyTransactionReceipt(r, makePrep()).outcome).toBe('event-mismatch')
  })

  it('returns event-mismatch when log is missing topics', () => {
    const log = makePaymentExecutedLog()
    const badLog = { ...log, topics: [PAYMENT_EXECUTED_TOPIC] as [`0x${string}`] }
    const r = makeReceipt({ logs: [badLog] })
    expect(verifyTransactionReceipt(r, makePrep()).outcome).toBe('event-mismatch')
  })

  it('retains txHash even on malformed log data', () => {
    const log = makePaymentExecutedLog()
    const badLog = { ...log, data: '0x1234' as `0x${string}` }
    const r = makeReceipt({ logs: [badLog] })
    expect(verifyTransactionReceipt(r, makePrep()).txHash).toBe(TX_HASH)
  })
})

describe('receiptTimeoutResult', () => {
  const hash = '0x' + 'aa'.repeat(32) as `0x${string}`

  it('returns outcome=receipt-timeout', () => {
    expect(receiptTimeoutResult(hash).outcome).toBe('receipt-timeout')
  })

  it('returns flowState=Unknown', () => {
    expect(receiptTimeoutResult(hash).flowState).toBe('Unknown')
  })

  it('verified is false', () => {
    expect(receiptTimeoutResult(hash).verified).toBe(false)
  })

  it('retains the txHash', () => {
    expect(receiptTimeoutResult(hash).txHash).toBe(hash)
  })

  it('blockNumber is null (receipt never arrived)', () => {
    expect(receiptTimeoutResult(hash).blockNumber).toBeNull()
  })

  it('decodedEvent is null', () => {
    expect(receiptTimeoutResult(hash).decodedEvent).toBeNull()
  })

  it('explanation says do not resubmit', () => {
    expect(receiptTimeoutResult(hash).explanation).toMatch(/do not resubmit/i)
  })

  it('explanation contains the tx hash', () => {
    expect(receiptTimeoutResult(hash).explanation).toContain(hash)
  })
})

describe('normaliseAddr helper', () => {
  it('lowercases addresses', () => {
    expect(normaliseAddr('0xABCDEF')).toBe('0xabcdef')
  })
  it('handles already-lowercase', () => {
    expect(normaliseAddr('0xabcdef')).toBe('0xabcdef')
  })
})

describe('flowState mapping', () => {
  it('confirmed → Confirmed', () => {
    expect(verifyTransactionReceipt(makeReceipt(), makePrep()).flowState).toBe('Confirmed')
  })
  it('reverted → Reverted', () => {
    const r = makeReceipt({ status: 'reverted' })
    expect(verifyTransactionReceipt(r, makePrep()).flowState).toBe('Reverted')
  })
  it('wrong-chain → Unknown', () => {
    const r = makeReceipt({ to: '0xEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEe02' })
    expect(verifyTransactionReceipt(r, makePrep()).flowState).toBe('Unknown')
  })
  it('event-not-found → Unknown', () => {
    const r = makeReceipt({ logs: [] })
    expect(verifyTransactionReceipt(r, makePrep()).flowState).toBe('Unknown')
  })
  it('event-mismatch → Unknown', () => {
    const wrongId = ('0x' + 'ff'.repeat(32)) as `0x${string}`
    const r = makeReceipt({ logs: [makePaymentExecutedLog({ requestId: wrongId })] })
    expect(verifyTransactionReceipt(r, makePrep()).flowState).toBe('Unknown')
  })
  it('transfer-mismatch → Unknown', () => {
    const wrongTo = '0xFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFf03' as `0x${string}`
    const r = makeReceipt({ logs: [makePaymentExecutedLog(), makeTransferLog({ to: wrongTo })] })
    expect(verifyTransactionReceipt(r, makePrep()).flowState).toBe('Unknown')
  })
})

describe('txHash always retained', () => {
  const cases: Array<[string, TransactionReceipt]> = [
    ['confirmed',       makeReceipt()],
    ['reverted',        makeReceipt({ status: 'reverted' })],
    ['wrong-chain',     makeReceipt({ to: '0xEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEe02' })],
    ['event-not-found', makeReceipt({ logs: [] })],
    ['event-mismatch',  makeReceipt({ logs: [makePaymentExecutedLog({ requestId: '0x' + 'ff'.repeat(32) as `0x${string}` })] })],
  ]
  for (const [label, receipt] of cases) {
    it(`retains txHash for outcome: ${label}`, () => {
      expect(verifyTransactionReceipt(receipt, makePrep()).txHash).toBe(TX_HASH)
    })
  }
})

describe('explorer link policy (tested via TxVerificationResult.txHash)', () => {
  it('txHash is always present so the caller can build a link for the configured chain only', () => {
    // The verifier itself does not build explorer links — it returns the txHash
    // and the caller (ReviewPaymentModal) builds the link only for chainId === 5042002.
    // This test documents that contract.
    const result = verifyTransactionReceipt(makeReceipt(), makePrep())
    expect(typeof result.txHash).toBe('string')
    expect(result.txHash).toMatch(/^0x/)
  })
})
