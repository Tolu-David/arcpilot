import { createConfig, http } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { getDefaultConfig } from 'connectkit'
import { arcTestnet } from 'viem/chains'

// Arc Testnet chain ID: 5042002
export const ARC_TESTNET_CHAIN_ID = 5042002

// USDC on Arc (ERC-20 view, 6 decimals) — same address on mainnet and testnet
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const

export const config = createConfig(
  getDefaultConfig({
    chains: [arcTestnet, mainnet],
    transports: {
      [arcTestnet.id]: http('https://rpc.testnet.arc.io'),
      [mainnet.id]: http(),
    },
    walletConnectProjectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '',
    appName: 'ArcPilot',
    appDescription: 'Onchain USDC treasury management with deterministic spending policies',
    appUrl: 'https://arcpilot.app',
  }),
)
