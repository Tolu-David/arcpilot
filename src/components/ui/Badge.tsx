import { cn } from '@/lib/utils'

type BadgeVariant = 'success' | 'danger' | 'warning' | 'info' | 'neutral' | 'gold'

interface BadgeProps {
  variant?: BadgeVariant
  children: React.ReactNode
  className?: string
  dot?: boolean
}

const variantStyles: Record<BadgeVariant, string> = {
  success: 'bg-ap-success/15 text-ap-success border-ap-success/30',
  danger:  'bg-ap-danger/15 text-ap-danger border-ap-danger/30',
  warning: 'bg-ap-warning/15 text-ap-warning border-ap-warning/30',
  info:    'bg-ap-info/15 text-ap-info border-ap-info/30',
  neutral: 'bg-ap-border/30 text-ap-muted border-ap-border',
  gold:    'bg-ap-gold/15 text-ap-gold border-ap-gold/30',
}

const dotStyles: Record<BadgeVariant, string> = {
  success: 'bg-ap-success',
  danger:  'bg-ap-danger',
  warning: 'bg-ap-warning',
  info:    'bg-ap-info',
  neutral: 'bg-ap-muted',
  gold:    'bg-ap-gold',
}

export function Badge({ variant = 'neutral', children, className, dot = false }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        variantStyles[variant],
        className
      )}
    >
      {dot && (
        <span
          className={cn('h-1.5 w-1.5 rounded-full flex-shrink-0', dotStyles[variant])}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  )
}
