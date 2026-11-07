import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { CoverBadges } from '@/components/library/cover-badges'
import { MangaCover } from '@/components/manga-grid'
import type { ContentKind } from '@/lib/sources/types'

import { NovelBadge } from './novel-badge'
import type { SeriesParams } from './read-button'

/**
 * One series as a cover tile. The whole tile opens the series, as in the
 * Library; `action` (a `ReadButton`) sits on the cover above that link.
 */
export function SeriesTile({
  series,
  title,
  thumbnailUrl,
  contentKind,
  meta,
  unread,
  saved,
  percent,
  action,
}: {
  series: SeriesParams
  title: string
  thumbnailUrl: string | null
  contentKind: ContentKind
  meta?: string
  unread: number
  saved: number
  percent?: number | null
  action?: ReactNode
}) {
  return (
    <div className="group/tile relative min-w-0">
      <div className="relative">
        <MangaCover
          url={thumbnailUrl ?? undefined}
          className="transition-colors group-hover/tile:border-primary/60"
        />
        <CoverBadges unread={unread} saved={saved} />
        {percent != null ? (
          <div
            role="progressbar"
            aria-label={`${title} progress`}
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className="absolute inset-x-px bottom-px h-1 overflow-hidden rounded-b-lg bg-background/60"
          >
            <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
        ) : null}
        {action}
      </div>
      <Link
        to="/manga/$sourceId/$slug"
        params={series}
        className="mt-2 block outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring"
      >
        <span className="line-clamp-2 text-tile leading-snug text-foreground/90 transition-colors group-hover/tile:text-foreground">
          {title}
        </span>
        {meta || contentKind === 'novel' ? (
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            {contentKind === 'novel' ? <NovelBadge /> : null}
            {meta ? <span className="truncate">{meta}</span> : null}
          </span>
        ) : null}
      </Link>
    </div>
  )
}
