import type { ReactNode } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'

import { cn } from '@/lib/utils'

interface VirtualListProps {
  virtualizer: Virtualizer<HTMLElement, Element>
  /** Only needed when the list shares a scroller with content above it. */
  listRef?: (node: HTMLDivElement | null) => void
  scrollMargin: number
  className?: string
  /** Set both together to keep list semantics the markup used to carry. */
  role?: 'list'
  itemRole?: 'listitem'
  /**
   * Whether rows are measured after mount. Leave on for rows whose height
   * depends on content; turn off when every row is drawn at a fixed height
   * and the estimates are exact, which spares a ResizeObserver and a layout
   * read per row while scrolling.
   */
  measure?: boolean
  children(index: number): ReactNode
}

/**
 * Draws the rows a virtualizer says are in view.
 *
 * The container is held at the full height of the list so the scrollbar tells
 * the truth, and each row is positioned absolutely within it. Row offsets come
 * back measured from the top of the scrolled content, hence the `scrollMargin`
 * subtraction: the list itself starts further down.
 *
 * Rows carry `data-index` and the virtualizer's `measureElement` ref, which is
 * what lets a row that turns out taller than its estimate — a two-line title,
 * an image that has just loaded — correct itself.
 */
export function VirtualList({
  virtualizer,
  listRef,
  scrollMargin,
  className,
  role,
  itemRole,
  measure = true,
  children,
}: VirtualListProps) {
  return (
    <div
      ref={listRef}
      role={role}
      className={cn('relative w-full', className)}
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((row) => (
        <div
          key={row.key}
          data-index={row.index}
          role={itemRole}
          ref={measure ? virtualizer.measureElement : undefined}
          className="absolute top-0 left-0 w-full"
          style={{ transform: `translateY(${row.start - scrollMargin}px)` }}
        >
          {children(row.index)}
        </div>
      ))}
    </div>
  )
}
