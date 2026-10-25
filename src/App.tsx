import { useState } from 'react'
import { useAccount } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { motion } from 'framer-motion'
import { ShieldCheck } from 'lucide-react'

import { Sidebar, type NavSection } from '@/components/shell/Sidebar'
import { TopBar } from '@/components/shell/TopBar'

import { OverviewView }       from '@/views/OverviewView'
import { TreasuryView }       from '@/views/TreasuryView'
import { AgentServicesView }  from '@/views/AgentServicesView'
import { AgentActivityView }  from '@/views/AgentActivityView'
import { PaymentsView }       from '@/views/PaymentsView'
import { AuditLogView }       from '@/views/AuditLogView'
import { SettingsView }       from '@/views/SettingsView'

import { ARCPILOT_ADDRESS } from '@/config'
import { isAddress } from 'viem'

const DEFAULT_CONTRACT = isAddress(ARCPILOT_ADDRESS) ? ARCPILOT_ADDRESS : undefined

// Payment mode is a UI concept only — drives the TopBar badge.
// Real payment routing lives in server/payment/adapter.ts (controlled by PAYMENT_ADAPTER env var).
type PaymentMode = 'simulation' | 'testnet'

export default function App() {
  const { isConnected } = useAccount()
  const [active, setActive] = useState<NavSection>('overview')
  const [mobileOpen, setMobileOpen] = useState(false)
  const [contractAddress, setContractAddress] = useState<`0x${string}` | undefined>(DEFAULT_CONTRACT)
  const paymentMode: PaymentMode = 'testnet'

  // Not connected — show a focused landing screen
  if (!isConnected) {
    return (
      <div className="min-h-dvh bg-ap-bg font-body flex items-center justify-center p-6">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, ease: [0.25, 0.1, 0.25, 1.0] }}
          className="w-full max-w-sm"
        >
          {/* Logo */}
          <div className="flex items-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-xl bg-ap-gold/15 border border-ap-gold/25 flex items-center justify-center">
              <ShieldCheck size={20} className="text-ap-gold" />
            </div>
            <div>
              <span className="font-display font-bold text-ap-text text-lg leading-none">ArcPilot</span>
              <span className="block text-xs text-ap-muted uppercase tracking-caps leading-none mt-0.5">
                Treasury
              </span>
            </div>
          </div>

          {/* Hero card */}
          <div className="rounded-2xl border border-ap-border bg-ap-surface shadow-panel px-6 py-8 mb-4">
            <h1 className="font-display font-bold text-2xl text-ap-text tracking-display mb-2 text-balance">
              Security-first USDC treasury for institutions
            </h1>
            <p className="text-sm text-ap-muted mb-6 text-pretty max-w-xs">
              Deterministic spending policies, AI-agent payment endpoints, and a verifiable onchain audit log — on Arc Testnet.
            </p>
            <ConnectKitButton label="Connect Wallet" />
          </div>

          {/* Feature chips */}
          <div className="grid grid-cols-2 gap-2">
            {[
              'Reserve protection',
              'Per-payee daily limits',
              'Request ID deduplication',
              'HTTP 402 agent payments',
            ].map((f) => (
              <div
                key={f}
                className="rounded-lg border border-ap-border bg-ap-surface/50 px-3 py-2 text-xs text-ap-muted text-center"
              >
                {f}
              </div>
            ))}
          </div>

          <p className="mt-6 text-center text-xs text-ap-muted/60">
            Arc Testnet · Chain 5042002 · No real funds
          </p>
        </motion.div>
      </div>
    )
  }

  // Connected — full dashboard shell
  return (
    <div className="min-h-dvh bg-ap-bg font-body flex">
      {/* Sidebar */}
      <Sidebar
        active={active}
        onNav={setActive}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      {/* Main content column */}
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          active={active}
          paymentMode={paymentMode}
          onMobileMenuOpen={() => setMobileOpen(true)}
        />

        {/* Page content */}
        <main
          className="flex-1 px-4 sm:px-6 py-6 max-w-6xl w-full mx-auto"
          id="main-content"
          tabIndex={-1}
        >
          {active === 'overview' && (
            <OverviewView
              contractAddress={contractAddress}
              onNav={setActive}
            />
          )}
          {active === 'treasury' && (
            <TreasuryView
              contractAddress={contractAddress}
              onContractChange={setContractAddress}
            />
          )}
          {active === 'agent-services' && <AgentServicesView />}
          {active === 'agent-activity' && <AgentActivityView />}
          {active === 'payments' && <PaymentsView />}
          {active === 'audit-log' && (
            <AuditLogView contractAddress={contractAddress} />
          )}
          {active === 'settings' && <SettingsView />}
        </main>
      </div>
    </div>
  )
}
