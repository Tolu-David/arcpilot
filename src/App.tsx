import { useState } from 'react'
import { useAccount } from 'wagmi'
import { Header } from '@/components/Header'
import { TreasuryCard } from '@/components/TreasuryCard'
import { PolicyPanel } from '@/components/PolicyPanel'
import { PayPanel } from '@/components/PayPanel'
import { AuditLog } from '@/components/AuditLog'
import { ContractInput } from '@/components/ContractInput'
import { ConnectKitButton } from 'connectkit'
import { ShieldCheck } from 'lucide-react'

export default function App() {
  const { isConnected } = useAccount()
  const [contractAddress, setContractAddress] = useState<`0x${string}` | undefined>(undefined)

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
              Onchain USDC treasury management with deterministic spending policies, permitted payees, and a verifiable audit log — on Arc Testnet.
            </p>
            <ConnectKitButton label="Connect Wallet to Start" />
          </div>
        )}

        {/* Contract address input */}
        {isConnected && (
          <ContractInput value={contractAddress} onChange={setContractAddress} />
        )}

        {/* Treasury overview */}
        {isConnected && (
          <TreasuryCard contractAddress={contractAddress} />
        )}

        {/* Two-column: Pay + Policies */}
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

        {/* Deploy CTA */}
        {isConnected && !contractAddress && (
          <div className="rounded-2xl border border-dashed border-white/20 bg-white/[0.02] px-6 py-5 text-center">
            <p className="text-sm text-arc-muted mb-2">
              No contract connected yet.
            </p>
            <p className="text-xs text-arc-muted">
              Ask Arc Studio to <strong className="text-white">deploy the ArcPilot contract</strong>, then paste its address above.
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
