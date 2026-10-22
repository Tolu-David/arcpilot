import { ConnectKitButton } from 'connectkit'
import { ShieldCheck } from 'lucide-react'

export function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-arc-navy/80 backdrop-blur-md">
      <div className="mx-auto max-w-6xl px-4 flex items-center justify-between h-14">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-arc-accent/20 flex items-center justify-center">
            <ShieldCheck size={15} className="text-arc-accent-light" />
          </div>
          <span className="font-display font-semibold text-white tracking-tight text-[15px]">
            ArcPilot
          </span>
          <span className="hidden sm:inline text-[11px] font-mono text-arc-muted uppercase tracking-caps ml-1 opacity-60">
            Treasury
          </span>
        </div>

        <ConnectKitButton />
      </div>
    </header>
  )
}
