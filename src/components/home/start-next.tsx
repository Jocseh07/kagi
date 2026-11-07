import { ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { findReadTarget } from '@/lib/db/home'
import type { LibraryProgress } from '@/lib/db/home'
import { cn } from '@/lib/utils'

import { seriesSlug } from './format'
import { ReadButton } from './read-button'
import { SeriesTile } from './series-tile'
import { SHELF, SHELF_ITEM, ShelfHeader } from './shelf'
import { notStartedLine } from './status-line'

const SHOWN = 6

/** The newest series added and never opened: the way into the Added tab. */
export function StartNext({
  series,
  onSeeAll,
  className,
}: {
  series: readonly LibraryProgress[]
  onSeeAll(): void
  className?: string
}) {
  if (series.length === 0) return null

  return (
    <section
      aria-labelledby="start-title"
      className={cn('@container flex min-w-0 flex-col gap-3', className)}
    >
      <ShelfHeader
        id="start-title"
        title="Added, not started"
        meta={
          <>
            <span className="tabular-nums">{series.length}</span> waiting · newest first
          </>
        }
      >
        <Button variant="ghost" size="sm" className="-mr-2" onClick={onSeeAll}>
          See all
          <ChevronRight data-icon="inline-end" />
        </Button>
      </ShelfHeader>
      <ul className={SHELF}>
        {series.slice(0, SHOWN).map((item) => {
          const params = { sourceId: item.sourceId, slug: seriesSlug(item.url, item.title, item.memo) }
          return (
            <li key={item.id} className={SHELF_ITEM}>
              <SeriesTile
                series={params}
                title={item.title}
                thumbnailUrl={item.thumbnailUrl}
                contentKind={item.contentKind}
                meta={notStartedLine(item)}
                unread={0}
                saved={item.downloadedCount}
                action={
                  item.total > 0 ? (
                    <ReadButton
                      label={`Start ${item.title}`}
                      series={params}
                      resolve={() => findReadTarget(item.id, 'next')}
                    />
                  ) : null
                }
              />
            </li>
          )
        })}
      </ul>
    </section>
  )
}
