import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  className?: string
  variant?: 'default' | 'error'
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  variant = 'default',
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center py-12 px-6',
        'rounded-xl border border-dashed',
        variant === 'error'
          ? 'border-ap-danger/30 bg-ap-danger/5'
          : 'border-ap-border bg-ap-surface/40',
        className
      )}
    >
      {icon && (
        <div
          className={cn(
            'mb-4 rounded-xl p-3',
            variant === 'error' ? 'bg-ap-danger/10 text-ap-danger' : 'bg-ap-border/30 text-ap-muted'
          )}
          aria-hidden="true"
        >
          {icon}
        </div>
      )}
      <p
        className={cn(
          'font-display font-semibold text-sm',
          variant === 'error' ? 'text-ap-danger' : 'text-ap-text'
        )}
      >
        {title}
      </p>
      {description && (
        <p className="mt-1 text-xs text-ap-muted max-w-xs text-pretty">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
