import { Menu, Zap } from 'lucide-react'
import { ConnectKitButton } from 'connectkit'
import { Badge } from '@/components/ui/Badge'
import type { NavSection } from './Sidebar'

const SECTION_LABELS: Record<NavSection, string> = {
  'overview':       'Overview',
  'treasury':       'Treasury',
  'agent-services': 'Agent Services',
  'agent-activity': 'Agent Activity',
  'payments':       'Payments',
  'audit-log':      'Audit Log',
  'settings':       'Settings',
}

interface TopBarProps {
  active: NavSection
  paymentMode: 'simulation' | 'testnet'
  onMobileMenuOpen: () => void
}

export function TopBar({ active, paymentMode, onMobileMenuOpen }: TopBarProps) {
  return (
    <header
      className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-ap-border bg-ap-bg/90 backdrop-blur-md px-4 h-14"
      role="banner"
    >
      {/* Left: mobile hamburger + breadcrumb */}
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={onMobileMenuOpen}
          aria-label="Open navigation menu"
          className="lg:hidden rounded-lg p-1.5 text-ap-muted hover:text-ap-text hover:bg-ap-border/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ap-gold"
        >
          <Menu size={18} />
        </button>

        <div className="min-w-0">
          <h1 className="font-display font-semibold text-ap-text text-sm truncate">
            {SECTION_LABELS[active]}
          </h1>
        </div>
      </div>

      {/* Right: network, payment mode, wallet */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Payment mode pill */}
        <Badge
          variant={paymentMode === 'testnet' ? 'info' : 'neutral'}
          className="hidden sm:inline-flex items-center gap-1.5 cursor-default"
          dot
        >
          <Zap size={10} />
          {paymentMode === 'testnet' ? 'Testnet' : 'Simulation'}
        </Badge>

        {/* ConnectKit wallet button */}
        <div className="connectkit-topbar">
          <ConnectKitButton />
        </div>
      </div>
    </header>
  )
}
