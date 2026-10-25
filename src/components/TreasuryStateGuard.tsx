/**
 * TreasuryStateGuard — renders the correct UI for every non-success state
 * returned by useTreasuryData. Import this in any view that reads treasury data.
 */
import { type ReactNode } from 'react'
import { AlertTriangle, Unplug, Wifi, WifiOff, FlaskConical } from 'lucide-react'
import { useChainSwitcher } from '@/hooks/useChainSwitcher'
import { type TreasuryStatus } from '@/hooks/useTreasuryData'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'

interface GuardProps {
  status: TreasuryStatus
  errorMessage: string | null
  children: ReactNode
  /** Optional: render a skeleton while loading instead of nothing */
  loadingFallback?: ReactNode
}

export function TreasuryStateGuard({
  status,
  errorMessage,
  children,
  loadingFallback,
}: GuardProps) {
  const { switchToArcTestnet, isSwitching } = useChainSwitcher()

  if (status === 'success' || status === 'dev') {
    return <>{children}</>
  }

  if (status === 'loading') {
    return <>{loadingFallback ?? <LoadingSkeleton />}</>
  }

  if (status === 'disconnected') {
    return (
      <EmptyState
        icon={<Unplug size={22} />}
        title="Wallet not connected"
        description="Connect your wallet to load live treasury data from the contract."
      />
    )
  }

  if (status === 'wrong-network') {
    return (
      <EmptyState
        icon={<Wifi size={22} />}
        title="Wrong network"
        description="This contract is deployed on Arc Testnet (chain ID 5042002). Switch networks to continue."
        action={
          <button
            onClick={switchToArcTestnet}
            disabled={isSwitching}
            className="rounded-lg bg-ap-gold/20 hover:bg-ap-gold/30 border border-ap-gold/40 text-ap-gold text-sm font-medium px-4 py-2 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ap-gold"
          >
            {isSwitching ? 'Switching…' : 'Switch to Arc Testnet'}
          </button>
        }
      />
    )
  }

  if (status === 'no-contract') {
    return (
      <EmptyState
        icon={<WifiOff size={22} />}
        title="No contract configured"
        description="Paste a deployed ArcPilotTreasury address, or check that VITE_ARCPILOT_CONTRACT is set."
      />
    )
  }

  // status === 'error'
  return (
    <EmptyState
      variant="error"
      icon={<AlertTriangle size={22} />}
      title="RPC error"
      description={errorMessage ?? 'Could not read from the contract. The RPC may be unavailable.'}
    />
  )
}

/** Shown in the TreasuryStateGuard before first data arrives */
function LoadingSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" data-testid="treasury-loading">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-24 rounded-xl bg-ap-surface border border-ap-border" />
        ))}
      </div>
      <div className="h-40 rounded-xl bg-ap-surface border border-ap-border" />
    </div>
  )
}

/** Small dev-mode banner — shown at the top of any page using the dev adapter */
export function DevModeBanner() {
  return (
    <div
      role="status"
      aria-label="Development data active"
      data-testid="dev-mode-banner"
      className="mb-4 rounded-lg border border-ap-warning/40 bg-ap-warning/10 px-4 py-2.5 flex items-center gap-2"
    >
      <FlaskConical size={14} className="text-ap-warning shrink-0" />
      <span className="text-xs text-ap-warning font-medium">
        Development data — not live onchain values.
      </span>
      <Badge variant="warning" className="ml-auto">DEV</Badge>
    </div>
  )
}
