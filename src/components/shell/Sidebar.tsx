import { type ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  LayoutDashboard,
  Vault,
  Bot,
  Activity,
  ArrowLeftRight,
  ScrollText,
  Settings,
  X,
  ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export type NavSection =
  | 'overview'
  | 'treasury'
  | 'agent-services'
  | 'agent-activity'
  | 'payments'
  | 'audit-log'
  | 'settings'

interface NavItem {
  id: NavSection
  label: string
  icon: ReactNode
}

const NAV_ITEMS: NavItem[] = [
  { id: 'overview',        label: 'Overview',        icon: <LayoutDashboard size={16} /> },
  { id: 'treasury',        label: 'Treasury',         icon: <Vault size={16} /> },
  { id: 'agent-services',  label: 'Agent Services',   icon: <Bot size={16} /> },
  { id: 'agent-activity',  label: 'Agent Activity',   icon: <Activity size={16} /> },
  { id: 'payments',        label: 'Payments',         icon: <ArrowLeftRight size={16} /> },
  { id: 'audit-log',       label: 'Audit Log',        icon: <ScrollText size={16} /> },
  { id: 'settings',        label: 'Settings',         icon: <Settings size={16} /> },
]

interface SidebarProps {
  active: NavSection
  onNav: (s: NavSection) => void
  /** Mobile-only overlay open state */
  mobileOpen: boolean
  onMobileClose: () => void
}

function SidebarContent({
  active,
  onNav,
  onClose,
}: {
  active: NavSection
  onNav: (s: NavSection) => void
  onClose?: () => void
}) {
  return (
    <div className="flex flex-col h-full">
      {/* Logo mark */}
      <div className="flex items-center justify-between px-4 pt-5 pb-6">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-ap-gold/20 flex items-center justify-center flex-shrink-0">
            <ShieldCheck size={16} className="text-ap-gold" />
          </div>
          <div>
            <span className="font-display font-semibold text-ap-text text-sm leading-none">
              ArcPilot
            </span>
            <span className="block text-[10px] text-ap-muted uppercase tracking-caps leading-none mt-0.5">
              Treasury
            </span>
          </div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close navigation"
            className="rounded-lg p-1.5 text-ap-muted hover:text-ap-text hover:bg-ap-border/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ap-gold"
          >
            <X size={15} />
          </button>
        )}
      </div>

      {/* Section label */}
      <p className="px-4 mb-2 text-[10px] font-medium uppercase tracking-caps text-ap-muted/60 select-none">
        Navigation
      </p>

      {/* Nav items */}
      <nav aria-label="Primary navigation" className="flex-1 px-2 space-y-0.5">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => {
              onNav(item.id)
              onClose?.()
            }}
            aria-current={active === item.id ? 'page' : undefined}
            className={cn(
              'nav-item w-full text-left',
              active === item.id && 'active'
            )}
          >
            <span className="flex-shrink-0">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>

      {/* Bottom: network badge */}
      <div className="px-4 py-5 border-t border-ap-border/50">
        <div className="rounded-lg bg-ap-bg/60 border border-ap-border px-3 py-2">
          <p className="text-[10px] uppercase tracking-caps text-ap-muted mb-0.5">Network</p>
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-ap-success flex-shrink-0" />
            <span className="text-xs font-medium text-ap-text">Arc Testnet</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function Sidebar({ active, onNav, mobileOpen, onMobileClose }: SidebarProps) {
  return (
    <>
      {/* Desktop sidebar — always visible ≥ lg */}
      <aside
        className="hidden lg:flex flex-col w-56 shrink-0 h-screen sticky top-0 border-r border-ap-border bg-ap-surface"
        aria-label="Sidebar navigation"
      >
        <SidebarContent active={active} onNav={onNav} />
      </aside>

      {/* Mobile sidebar — slide-in overlay */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            {/* Backdrop */}
            <motion.div
              key="mobile-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="fixed inset-0 z-30 bg-ap-bg/80 backdrop-blur-sm lg:hidden"
              aria-hidden="true"
              onClick={onMobileClose}
            />
            {/* Drawer */}
            <motion.aside
              key="mobile-sidebar"
              initial={{ x: -224 }}
              animate={{ x: 0 }}
              exit={{ x: -224 }}
              transition={{ type: 'spring', stiffness: 400, damping: 36 }}
              className="fixed inset-y-0 left-0 z-40 w-56 border-r border-ap-border bg-ap-surface shadow-panel lg:hidden"
              aria-label="Mobile sidebar navigation"
            >
              <SidebarContent active={active} onNav={onNav} onClose={onMobileClose} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  )
}
