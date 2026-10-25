import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SkeletonRow } from './Skeleton'
import { EmptyState } from './EmptyState'
import { TableIcon } from 'lucide-react'

export interface Column<T> {
  key: string
  header: string
  align?: 'left' | 'right' | 'center'
  className?: string
  render: (row: T, index: number) => ReactNode
}

interface DataTableProps<T> {
  columns: Column<T>[]
  rows: T[]
  getKey: (row: T, index: number) => string | number
  loading?: boolean
  skeletonRows?: number
  emptyTitle?: string
  emptyDescription?: string
  className?: string
}

export function DataTable<T>({
  columns,
  rows,
  getKey,
  loading = false,
  skeletonRows = 4,
  emptyTitle = 'No records',
  emptyDescription,
  className,
}: DataTableProps<T>) {
  return (
    <div className={cn('rounded-xl border border-ap-border bg-ap-surface overflow-hidden', className)}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" role="table">
          <thead>
            <tr className="border-b border-ap-border">
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  className={cn(
                    'px-4 py-3 text-xs font-medium uppercase tracking-caps text-ap-muted',
                    col.align === 'right' && 'text-right',
                    col.align === 'center' && 'text-center',
                    !col.align && 'text-left',
                    col.className
                  )}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: skeletonRows }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={columns.length} className="p-0">
                    <SkeletonRow cols={columns.length} />
                  </td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>
                  <EmptyState
                    icon={<TableIcon size={20} />}
                    title={emptyTitle}
                    description={emptyDescription}
                    className="rounded-none border-0 border-t-0 py-10"
                  />
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr
                  key={getKey(row, i)}
                  className="border-b border-ap-border/50 last:border-0 hover:bg-ap-elevated/50 transition-colors duration-100"
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn(
                        'px-4 py-3 text-ap-text',
                        col.align === 'right' && 'text-right tabular-nums',
                        col.align === 'center' && 'text-center',
                        col.className
                      )}
                    >
                      {col.render(row, i)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
