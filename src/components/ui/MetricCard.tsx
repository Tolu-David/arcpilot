import { type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

interface MetricCardProps {
  label: string
  value: ReactNode
  subtext?: ReactNode
  icon?: ReactNode
  accent?: boolean
  className?: string
  /** If true renders a skeleton shimmer instead of content */
  loading?: boolean
}

export function MetricCard({
  label,
  value,
  subtext,
  icon,
  accent = false,
  className,
  loading = false,
}: MetricCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1.0] }}
      className={cn(
        'relative rounded-xl border border-ap-border bg-ap-surface px-5 py-4 shadow-card',
        accent && 'border-ap-gold/30',
        className
      )}
    >
      {/* top-left label + icon row */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium uppercase tracking-caps text-ap-muted">{label}</span>
        {icon && (
          <span className={cn('text-ap-muted', accent && 'text-ap-gold')}>{icon}</span>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          <div className="h-7 w-32 rounded-md bg-ap-border/50 animate-pulse" />
          <div className="h-4 w-20 rounded-md bg-ap-border/30 animate-pulse" />
        </div>
      ) : (
        <>
          <div
            className={cn(
              'font-display font-semibold text-2xl tracking-display tabular-nums',
              accent ? 'text-ap-gold' : 'text-ap-text'
            )}
          >
            {value}
          </div>
          {subtext && (
            <div className="mt-1 text-xs text-ap-muted">{subtext}</div>
          )}
        </>
      )}
    </motion.div>
  )
}
