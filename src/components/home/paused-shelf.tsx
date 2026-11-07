import { ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { findReadTarget } from '@/lib/db/home'
import type { LibraryProgress } from '@/lib/db/home'
import { cn } from '@/lib/utils'

import { seriesSlug } from './format'
import { ReadButton } from './read-button'
import { SeriesTile } from './series-tile'
import { SHELF, SHELF_ITEM, ShelfHeader } from './shelf'
import { pausedLine, pausedPercent } from './status-line'

const SHOWN = 6

/** Series started and set down, most recently read first. */
export function PausedShelf({
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
      aria-labelledby="paused-title"
      className={cn('@container flex min-w-0 flex-col gap-3', className)}
    >
      <ShelfHeader
        id="paused-title"
        title="Paused"
        meta={
          <>
            <span className="tabular-nums">{series.length}</span> series · not read for a month or
            more
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
                meta={pausedLine(item)}
                unread={item.unreadCount}
                saved={item.downloadedCount}
                percent={pausedPercent(item)}
                action={
                  <ReadButton
                    label={`Resume ${item.title}`}
                    series={params}
                    resolve={() => findReadTarget(item.id, 'next')}
                  />
                }
              />
            </li>
          )
        })}
      </ul>
    </section>
  )
}
