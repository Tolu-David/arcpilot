import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export function formatUSDC(raw: bigint, decimals = 6): string {
  const divisor = BigInt(10 ** decimals)
  const whole = raw / divisor
  const frac = raw % divisor
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, 2)
  return `${whole.toLocaleString('en-US')}.${fracStr}`
}

export function parseUSDC(value: string): bigint {
  const [whole, frac = ''] = value.split('.')
  const fracPadded = (frac + '000000').slice(0, 6)
  return BigInt(whole.replace(/,/g, '') || '0') * BigInt(1_000_000) + BigInt(fracPadded)
}

export function formatPercent(numerator: bigint, denominator: bigint): string {
  if (denominator === 0n) return '0'
  return ((Number(numerator) / Number(denominator)) * 100).toFixed(1)
}

export function getExplorerTxUrl(hash: string): string {
  return `https://explorer.testnet.arc.io/tx/${hash}`
}

export function getExplorerAddressUrl(address: string): string {
  return `https://explorer.testnet.arc.io/address/${address}`
}
