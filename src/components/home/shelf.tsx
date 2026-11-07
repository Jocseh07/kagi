import type { ReactNode } from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/** A row of tiles: sideways on a phone, six across once its section is wide. */
export const SHELF =
  'bleed-page -my-1 flex gap-3 overflow-x-auto py-1 @xl:grid @xl:grid-cols-6 @xl:overflow-visible'
export const SHELF_ITEM = 'w-28 shrink-0 @xl:w-auto'

/** The same, for a narrow column: three across from 18rem. */
export const SHELF_NARROW =
  'bleed-page -my-1 flex gap-3 overflow-x-auto py-1 @2xs:grid @2xs:grid-cols-3 @2xs:overflow-visible @2xl:grid-cols-6'
export const SHELF_NARROW_ITEM = 'w-28 shrink-0 @2xs:w-auto'

export function ShelfHeader({
  id,
  title,
  meta,
  children,
}: {
  id: string
  title: string
  meta?: ReactNode
  children?: ReactNode
}) {
  return (
    <header className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <h2 id={id} className="text-base font-semibold tracking-tight">
          {title}
        </h2>
        {meta ? <p className="text-xs text-muted-foreground">{meta}</p> : null}
      </div>
      {children}
    </header>
  )
}

export function ShelfSkeleton({
  count = 6,
  narrow = false,
  className,
}: {
  count?: number
  narrow?: boolean
  className?: string
}) {
  return (
    <div
      aria-busy="true"
      className={cn(
        'flex gap-3 overflow-hidden',
        narrow ? '@2xs:grid @2xs:grid-cols-3 @2xl:grid-cols-6' : '@xl:grid @xl:grid-cols-6',
        className,
      )}
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className={narrow ? SHELF_NARROW_ITEM : SHELF_ITEM}>
          <Skeleton className="aspect-[2/3] w-full rounded-lg" />
          <Skeleton className="mt-2 h-3 w-3/4" />
          <Skeleton className="mt-1 h-3 w-1/2" />
        </div>
      ))}
    </div>
  )
}
