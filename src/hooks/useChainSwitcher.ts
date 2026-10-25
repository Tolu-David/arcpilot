import { useState } from 'react'
import { useSwitchChain } from 'wagmi'
import { ARC_TESTNET_CHAIN_ID } from '@/config'

export function useChainSwitcher() {
  const { switchChainAsync } = useSwitchChain()
  const [isSwitching, setIsSwitching] = useState(false)

  async function switchToArcTestnet() {
    try {
      setIsSwitching(true)
      await switchChainAsync({ chainId: ARC_TESTNET_CHAIN_ID })
    } catch {
      // User rejected or unsupported — silently ignore
    } finally {
      setIsSwitching(false)
    }
  }

  return { switchToArcTestnet, isSwitching }
}
