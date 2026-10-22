import { useState } from 'react'
import { useAccount } from 'wagmi'
import { Header } from '@/components/Header'
import { TreasuryCard } from '@/components/TreasuryCard'
import { PolicyPanel } from '@/components/PolicyPanel'
import { PayPanel } from '@/components/PayPanel'
import { AuditLog } from '@/components/AuditLog'
import { ContractInput } from '@/components/ContractInput'
import { AgentPayPanel } from '@/components/AgentPayPanel'
import { DepositPanel } from '@/components/DepositPanel'
import { ConnectKitButton } from 'connectkit'
import { ShieldCheck } from 'lucide-react'
import { ARCPILOT_ADDRESS } from '@/config'
import { isAddress } from 'viem'

// Initialise with the deployed address if it's a valid address
const DEFAULT_CONTRACT = isAddress(ARCPILOT_ADDRESS) ? ARCPILOT_ADDRESS : undefined

export default function App() {
  const { isConnected } = useAccount()
  const [contractAddress, setContractAddress] = useState<`0x${string}` | undefined>(DEFAULT_CONTRACT)

  return (
    <div className="min-h-dvh bg-arc-navy font-body">
      <Header />

      <main className="mx-auto max-w-2xl px-4 py-8 space-y-4">

        {/* Hero: not connected */}
        {!isConnected && (
          <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-arc-navy-light to-arc-blue/30 px-6 py-10 text-center">
            <div className="w-12 h-12 rounded-2xl bg-arc-accent/20 flex items-center justify-center mx-auto mb-4">
              <ShieldCheck size={22} className="text-arc-accent-light" />
            </div>
            <h1 className="font-display font-bold text-2xl text-white tracking-display mb-2">
              ArcPilot Treasury
            </h1>
            <p className="text-arc-muted text-sm max-w-xs mx-auto mb-6 text-pretty">
              Security-first onchain USDC treasury with deterministic spending policies, AI-agent payment endpoints, and a verifiable audit log — on Arc Testnet.
            </p>
            <ConnectKitButton label="Connect Wallet to Start" />
          </div>
        )}

        {/* Contract address — auto-loads deployed address */}
        {isConnected && (
          <ContractInput value={contractAddress} onChange={setContractAddress} />
        )}

        {/* Treasury overview */}
        {isConnected && (
          <TreasuryCard contractAddress={contractAddress} />
        )}

        {/* Deposit flow */}
        {isConnected && contractAddress && (
          <DepositPanel contractAddress={contractAddress} />
        )}

        {/* Execute payment + Spending policies */}
        {isConnected && contractAddress && (
          <div className="grid grid-cols-1 gap-4">
            <PayPanel contractAddress={contractAddress} />
            <PolicyPanel contractAddress={contractAddress} />
          </div>
        )}

        {/* Audit history */}
        {isConnected && contractAddress && (
          <AuditLog contractAddress={contractAddress} />
        )}

        {/* Agent payment endpoints */}
        {isConnected && (
          <AgentPayPanel />
        )}

        {/* No contract fallback */}
        {isConnected && !contractAddress && (
          <div className="rounded-2xl border border-dashed border-white/20 bg-white/[0.02] px-6 py-5 text-center">
            <p className="text-sm text-arc-muted mb-1">No contract connected.</p>
            <p className="text-xs text-arc-muted">
              Paste a deployed ArcPilot address above, or ask Arc Studio to deploy one.
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
