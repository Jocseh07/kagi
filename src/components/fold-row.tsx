import { ChevronDown } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * The row that folds a run of rows away.
 *
 * Stands in for a Radix accordion trigger in the virtualized lists. A
 * virtualizer needs one flat sequence of rows it can index and measure, which
 * a collapsible panel cannot be part of — so the fold becomes an ordinary row
 * and its contents are simply left out of the sequence while it is closed.
 *
 * `aria-expanded` carries the state. There is deliberately no `aria-controls`:
 * the rows this reveals are siblings in the virtual list rather than children
 * of one container, so there is no single id that would honestly name them.
 */
export function FoldRow({
  open,
  label,
  detail,
  className,
  onToggle,
}: {
  open: boolean
  label: string
  detail?: string
  className?: string
  onToggle(): void
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        'flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-3 focus-visible:ring-ring/50',
        className,
      )}
    >
      <span className="flex-1">{label}</span>
      {detail && (
        <span className="min-w-0 truncate text-xs font-normal">{detail}</span>
      )}
      <ChevronDown
        className={cn(
          'size-4 shrink-0 transition-transform duration-200',
          open && 'rotate-180',
        )}
      />
    </button>
  )
}
