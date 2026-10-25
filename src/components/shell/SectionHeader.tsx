import { type ReactNode } from 'react'
import { motion } from 'framer-motion'

interface SectionHeaderProps {
  title: string
  description?: string
  action?: ReactNode
}

export function SectionHeader({ title, description, action }: SectionHeaderProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1.0] }}
      className="flex items-start justify-between gap-4 mb-6"
    >
      <div>
        <h2 className="font-display font-semibold text-lg text-ap-text tracking-display">
          {title}
        </h2>
        {description && (
          <p className="mt-0.5 text-sm text-ap-muted text-pretty">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </motion.div>
  )
}
