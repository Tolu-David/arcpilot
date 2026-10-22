import { useState, useEffect } from 'react'
import { isAddress } from 'viem'
import { Search, ExternalLink, CheckCircle2 } from 'lucide-react'
import { getExplorerAddressUrl } from '@/lib/utils'
import { ARCPILOT_ADDRESS } from '@/config'

interface ContractInputProps {
  value: `0x${string}` | undefined
  onChange: (addr: `0x${string}` | undefined) => void
}

export function ContractInput({ value, onChange }: ContractInputProps) {
  const [raw, setRaw] = useState<string>(value ?? ARCPILOT_ADDRESS ?? '')
  const [error, setError] = useState('')

  // Auto-load the deployed address on mount
  useEffect(() => {
    if (!value && ARCPILOT_ADDRESS && isAddress(ARCPILOT_ADDRESS)) {
      onChange(ARCPILOT_ADDRESS)
      setRaw(String(ARCPILOT_ADDRESS))
    }
  }, [])

  function handleChange(v: string) {
    setRaw(v)
    setError('')
    if (v === '') {
      onChange(undefined)
      return
    }
    if (isAddress(v)) {
      onChange(v as `0x${string}`)
    } else if (v.length >= 42) {
      setError('Not a valid address.')
    }
  }

  const isDeployed = value?.toLowerCase() === ARCPILOT_ADDRESS?.toLowerCase()

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 px-5 py-4">
      <div className="flex items-center justify-between mb-2">
        <label className="text-[11px] text-arc-muted uppercase tracking-caps">
          ArcPilot Contract
        </label>
        {isDeployed && (
          <span className="flex items-center gap-1 text-[11px] text-emerald-400">
            <CheckCircle2 size={11} />
            Deployed on Arc Testnet
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-arc-muted" />
          <input
            value={raw}
            onChange={e => handleChange(e.target.value)}
            placeholder="0x... ArcPilot contract address"
            className="w-full bg-white/10 rounded-lg pl-9 pr-3 py-2 text-sm font-mono text-white placeholder:text-arc-muted border border-white/10 focus:outline-none focus:border-arc-accent"
          />
        </div>
        {value && (
          <a
            href={getExplorerAddressUrl(value)}
            target="_blank"
            rel="noopener noreferrer"
            className="p-2 hover:bg-white/10 rounded-lg transition-colors text-arc-muted hover:text-white"
            title="View on Arc Testnet explorer"
          >
            <ExternalLink size={14} />
          </a>
        )}
      </div>
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
      {!value && !error && (
        <p className="text-[11px] text-arc-muted mt-1.5">
          Paste a deployed ArcPilot contract address to load treasury data.
        </p>
      )}
    </div>
  )
}
