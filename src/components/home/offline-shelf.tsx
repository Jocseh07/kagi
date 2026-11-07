import { Link } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import { findReadTarget } from '@/lib/db/home'
import type { SavedSeries } from '@/lib/db/home'
import type { ContentKind } from '@/lib/sources/types'
import { cn } from '@/lib/utils'

import { seriesSlug } from './format'
import { ReadButton } from './read-button'
import { SeriesTile } from './series-tile'
import { SHELF_NARROW, SHELF_NARROW_ITEM, ShelfHeader } from './shelf'

export function OfflineShelf({
  series,
  kindOf,
  className,
}: {
  series: readonly SavedSeries[]
  /** Content kind by manga id, where the library knows it. */
  kindOf: ReadonlyMap<string, ContentKind>
  className?: string
}) {
  if (series.length === 0) return null
  const chapters = series.reduce((sum, item) => sum + item.savedCount, 0)

  return (
    <section
      aria-labelledby="offline-title"
      className={cn('@container flex min-w-0 flex-col gap-3', className)}
    >
      <ShelfHeader
        id="offline-title"
        title="Ready offline"
        meta={
          <>
            <span className="tabular-nums">{chapters}</span> saved{' '}
            {chapters === 1 ? 'chapter' : 'chapters'}
          </>
        }
      >
        <Button asChild variant="ghost" size="sm" className="-mr-2">
          <Link to="/downloads">Downloads</Link>
        </Button>
      </ShelfHeader>
      <ul className={SHELF_NARROW}>
        {series.map((item) => {
          const params = { sourceId: item.sourceId, slug: seriesSlug(item.url, item.title, item.memo) }
          return (
            <li key={item.mangaId} className={SHELF_NARROW_ITEM}>
              <SeriesTile
                series={params}
                title={item.title}
                thumbnailUrl={item.thumbnailUrl}
                contentKind={kindOf.get(item.mangaId) ?? 'comic'}
                unread={0}
                saved={item.savedCount}
                action={
                  <ReadButton
                    label={`Read ${item.title} offline`}
                    icon="saved"
                    series={params}
                    resolve={() => findReadTarget(item.mangaId, 'saved')}
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
