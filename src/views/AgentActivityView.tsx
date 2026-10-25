import { Bot, Clock } from 'lucide-react'
import { SectionHeader } from '@/components/shell/SectionHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { motion } from 'framer-motion'

export function AgentActivityView() {
  return (
    <div>
      <SectionHeader
        title="Agent Activity"
        description="Real-time log of AI agent payment requests and policy evaluations."
        action={
          <Badge variant="neutral" dot>
            Development
          </Badge>
        }
      />

      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22 }}
        className="rounded-xl border border-ap-border bg-ap-surface/40 px-4 py-3 mb-4 text-xs text-ap-muted"
      >
        <span className="font-medium text-ap-warning">Development note:</span> Agent activity streaming is wired to the server's
        live endpoint log. Start the payment server with{' '}
        <code className="font-mono bg-ap-border/40 rounded px-1 py-0.5">
          SELLER_ADDRESS=0x… bun run server
        </code>{' '}
        to begin receiving agent calls.
      </motion.div>

      <EmptyState
        icon={<Bot size={22} />}
        title="No agent activity yet"
        description="Agent calls will appear here once the payment server is running and an agent submits a request."
      />

      <div className="mt-4 rounded-xl border border-ap-border bg-ap-surface p-4">
        <div className="flex items-center gap-2 mb-3">
          <Clock size={14} className="text-ap-muted" />
          <span className="text-xs font-medium uppercase tracking-caps text-ap-muted">How it works</span>
        </div>
        <ol className="space-y-2 text-sm text-ap-muted list-decimal list-inside text-pretty">
          <li>An AI agent calls a paid endpoint (e.g. <code className="font-mono text-xs bg-ap-border/40 rounded px-1">POST /api/agent/recommend-spend</code>).</li>
          <li>The server responds HTTP 402 with a Circle Gateway payment requirement.</li>
          <li>The agent submits a USDC payment via <code className="font-mono text-xs bg-ap-border/40 rounded px-1">GatewayClient</code>.</li>
          <li>On settlement, the server fulfils the request and logs the call here.</li>
        </ol>
      </div>
    </div>
  )
}
