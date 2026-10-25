import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  loading?: boolean
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  loading = false,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  // Trap focus on open; close on Escape
  useEffect(() => {
    if (!open) return
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-40 bg-ap-bg/80 backdrop-blur-sm"
            aria-hidden="true"
            onClick={onClose}
          />
          {/* Dialog */}
          <motion.div
            key="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            aria-describedby={description ? 'dialog-desc' : undefined}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1.0] }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
          >
            <div className="w-full max-w-md rounded-2xl border border-ap-border bg-ap-surface shadow-panel">
              {/* Header */}
              <div className="flex items-start gap-3 p-5 pb-4">
                {danger && (
                  <div className="mt-0.5 rounded-lg bg-ap-danger/15 p-2 text-ap-danger flex-shrink-0">
                    <AlertTriangle size={16} />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <h2
                    id="dialog-title"
                    className="font-display font-semibold text-ap-text"
                  >
                    {title}
                  </h2>
                  {description && (
                    <p id="dialog-desc" className="mt-1 text-sm text-ap-muted text-pretty">
                      {description}
                    </p>
                  )}
                </div>
                <button
                  onClick={onClose}
                  aria-label="Close dialog"
                  className="rounded-lg p-1 text-ap-muted hover:text-ap-text hover:bg-ap-border/40 transition-colors flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ap-gold"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Footer */}
              <div className="flex justify-end gap-2 px-5 pb-5">
                <button
                  ref={cancelRef}
                  onClick={onClose}
                  disabled={loading}
                  className="rounded-lg border border-ap-border bg-transparent px-4 py-2 text-sm text-ap-muted hover:text-ap-text hover:bg-ap-border/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ap-gold disabled:opacity-50"
                >
                  {cancelLabel}
                </button>
                <button
                  onClick={onConfirm}
                  disabled={loading}
                  className={cn(
                    'rounded-lg px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ap-gold disabled:opacity-50',
                    danger
                      ? 'bg-ap-danger text-white hover:bg-ap-danger/90'
                      : 'bg-ap-gold text-ap-bg hover:bg-ap-gold/90'
                  )}
                >
                  {loading ? (
                    <span className="flex items-center gap-2">
                      <span className="h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                      {confirmLabel}
                    </span>
                  ) : (
                    confirmLabel
                  )}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
