import type { ReactNode } from 'react'

import { MangaCover } from '@/components/manga-grid'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * A series as one line: thumbnail, title, and whatever the surface wants to
 * say underneath. Presentational — the caller supplies the link or button
 * around it, because the library rows carry a selection gesture the browse
 * rows do not.
 */
export function MangaListRow({
  thumbnailUrl,
  title,
  meta,
  selected = false,
  showCover = true,
  className,
}: {
  thumbnailUrl?: string
  title: string
  /** The second line. Omitted entirely rather than left blank. */
  meta?: ReactNode
  selected?: boolean
  /**
   * Whether to reserve the thumbnail column at all.
   *
   * False only for a source that publishes no covers anywhere, where the slot
   * would be the identical placeholder on every row — which reads as breakage
   * rather than as absence. The row then carries text alone, so it tightens to
   * match rather than keeping height sized for a cover that never arrives.
   */
  showCover?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 overflow-hidden rounded-md border border-border bg-card',
        showCover ? 'h-18 px-2' : 'h-14 px-3',
        // The same hover fill the chapter rows use, so the two dense surfaces
        // respond alike. A translucent primary tint marks a selection rather
        // than a solid fill, which would need its own foreground pairing.
        'transition-colors group-hover:bg-secondary group-focus-visible:border-primary',
        selected && 'border-primary bg-primary/10 ring-2 ring-primary',
        className,
      )}
    >
      {showCover ? (
        <MangaCover
          url={thumbnailUrl}
          title={title}
          className="h-14 w-auto shrink-0 rounded-sm"
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">{title}</p>
        {meta ? (
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            {meta}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Shaped like the rows it stands in for, at the same column count. */
export function MangaListSkeleton({
  count = 8,
  showCover = true,
}: {
  count?: number
  /** Matches `MangaListRow`, so the wait is shaped like what follows it. */
  showCover?: boolean
}) {
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className={cn(
            'flex items-center gap-2.5 rounded-md border border-border',
            showCover ? 'h-18 px-2' : 'h-14 px-3',
          )}
        >
          {showCover ? <Skeleton className="h-14 w-9 shrink-0 rounded-sm" /> : null}
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-1/4" />
          </div>
        </div>
      ))}
    </div>
  )
}
