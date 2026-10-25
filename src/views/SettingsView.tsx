import { SectionHeader } from '@/components/shell/SectionHeader'
import { Badge } from '@/components/ui/Badge'
import { motion } from 'framer-motion'
import { ARCPILOT_ADDRESS, ARC_TESTNET_CHAIN_ID, USDC_ADDRESS } from '@/config'
import { ExternalLink, ShieldCheck } from 'lucide-react'

interface Row {
  label: string
  value: string
  mono?: boolean
  link?: string
}

const CONTRACT_ROWS: Row[] = [
  { label: 'ArcPilotTreasury (v2)', value: ARCPILOT_ADDRESS, mono: true,
    link: `https://explorer.testnet.arc.io/address/${ARCPILOT_ADDRESS}` },
  { label: 'USDC Address', value: USDC_ADDRESS, mono: true },
  { label: 'Chain ID', value: String(ARC_TESTNET_CHAIN_ID) },
  { label: 'Network', value: 'Arc Testnet' },
  { label: 'RPC', value: 'https://rpc.testnet.arc.io' },
  { label: 'Explorer', value: 'https://explorer.testnet.arc.io',
    link: 'https://explorer.testnet.arc.io' },
]

const ENV_ROWS: Row[] = [
  { label: 'VITE_WALLETCONNECT_PROJECT_ID', value: 'Optional — enables WalletConnect QR modal' },
  { label: 'VITE_ARCPILOT_CONTRACT', value: 'Deployed contract address (auto-set after deploy)' },
  { label: 'CIRCLE_API_KEY', value: 'Server-only — Circle developer API key (never VITE_)' },
  { label: 'CIRCLE_ENTITY_SECRET', value: 'Server-only — one-time entity secret for dev-controlled wallets' },
  { label: 'SELLER_ADDRESS', value: 'Server-only — EVM address receiving agent payment USDC' },
  { label: 'PAYMENT_ADAPTER', value: '"sim" (default) or "gateway" (testnet live payments)' },
]

export function SettingsView() {
  const fadeUp = (delay = 0) => ({
    initial: { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.22, delay, ease: [0.25, 0.1, 0.25, 1.0] as const },
  })

  return (
    <div>
      <SectionHeader
        title="Settings"
        description="Network configuration, contract addresses, and environment variable reference."
        action={<Badge variant="neutral">Testnet</Badge>}
      />

      {/* Contract config */}
      <motion.section {...fadeUp(0)} className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <ShieldCheck size={14} className="text-ap-gold" />
          <h3 className="text-xs font-medium uppercase tracking-caps text-ap-muted">Contract Configuration</h3>
        </div>
        <div className="rounded-xl border border-ap-border bg-ap-surface overflow-hidden">
          {CONTRACT_ROWS.map((row, i) => (
            <div
              key={row.label}
              className={`flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 px-4 py-3 ${i < CONTRACT_ROWS.length - 1 ? 'border-b border-ap-border/50' : ''}`}
            >
              <span className="w-44 shrink-0 text-xs text-ap-muted">{row.label}</span>
              <span className={`text-xs text-ap-text flex-1 break-all ${row.mono ? 'font-mono' : ''}`}>
                {row.link ? (
                  <a
                    href={row.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 hover:text-ap-gold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ap-gold rounded"
                  >
                    {row.value}
                    <ExternalLink size={10} className="shrink-0" />
                  </a>
                ) : (
                  row.value
                )}
              </span>
            </div>
          ))}
        </div>
      </motion.section>

      {/* Env vars */}
      <motion.section {...fadeUp(0.06)}>
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-xs font-medium uppercase tracking-caps text-ap-muted">Environment Variables</h3>
        </div>
        <div className="rounded-xl border border-ap-border bg-ap-surface overflow-hidden mb-3">
          {ENV_ROWS.map((row, i) => (
            <div
              key={row.label}
              className={`flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4 px-4 py-3 ${i < ENV_ROWS.length - 1 ? 'border-b border-ap-border/50' : ''}`}
            >
              <code className="w-56 shrink-0 text-xs font-mono text-ap-gold break-all">{row.label}</code>
              <span className="text-xs text-ap-muted flex-1 text-pretty">{row.value}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-ap-muted text-pretty">
          Copy <code className="font-mono bg-ap-border/40 rounded px-1">env.example</code> to{' '}
          <code className="font-mono bg-ap-border/40 rounded px-1">.env</code> and fill in real values.
          Never commit <code className="font-mono bg-ap-border/40 rounded px-1">.env</code> — it is gitignored.
        </p>
      </motion.section>
    </div>
  )
}
