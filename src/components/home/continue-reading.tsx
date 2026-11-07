import { Link } from '@tanstack/react-router'
import { Check } from 'lucide-react'

import { CoverBadges } from '@/components/library/cover-badges'
import { MangaCover } from '@/components/manga-grid'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { chapterKeyOf, relativeTime } from '@/components/updates/format'
import type { ContinueItem } from '@/lib/db/home'
import { sourceCatalog } from '@/lib/sources/catalog'
import { permilleToPercent, readPercent } from '@/lib/text/progress'
import { cn } from '@/lib/utils'

import { NovelBadge } from './novel-badge'
import { seriesSlug } from './format'
import { ReadButton } from './read-button'
import { SeriesTile } from './series-tile'
import { SHELF, SHELF_ITEM } from './shelf'

/** A series' Library badge counts, keyed by manga id. */
export type BadgeCounts = ReadonlyMap<string, { unread: number; saved: number }>

const NO_BADGES = { unread: 0, saved: 0 }

interface Position {
  label: string
  percent: number | null
}

/** Where the resume point sits, worded for a comic's pages or a novel's scroll. */
function positionOf({ history, target, contentKind }: ContinueItem): Position {
  if (target.url !== history.chapterUrl) return { label: 'Next chapter', percent: null }
  if (contentKind === 'novel') {
    const percent = target.pageCount > 0 ? permilleToPercent(target.lastPageRead) : 0
    return { label: `${percent}%`, percent }
  }
  const page = target.lastPageRead + 1
  if (target.pageCount <= 0) return { label: `Page ${page}`, percent: null }
  return {
    label: `Page ${page} of ${target.pageCount}`,
    percent: readPercent(target.lastPageRead, target.pageCount),
  }
}

function linksOf(item: ContinueItem) {
  const { history, target } = item
  const slug = seriesSlug(history.mangaUrl, history.mangaTitle, history.mangaMemo)
  return {
    series: { sourceId: history.sourceId, slug },
    reader: {
      sourceId: history.sourceId,
      slug,
      chapter: chapterKeyOf(target.url, target.chapterNumber),
    },
  }
}

function sourceName(id: string): string {
  return sourceCatalog.find((entry) => entry.id === id)?.name ?? id
}

export function ContinueReading({
  items,
  counts,
  className,
}: {
  items: readonly ContinueItem[]
  counts: BadgeCounts
  className?: string
}) {
  const [hero, ...rest] = items
  if (!hero) return null

  return (
    <section
      aria-labelledby="continue-title"
      className={cn('@container grid min-w-0 grid-cols-1 gap-4 @5xl:grid-cols-12 @5xl:gap-6', className)}
    >
      <h2 id="continue-title" className="sr-only">
        Continue reading
      </h2>
      <ContinueHero
        item={hero}
        badges={counts.get(hero.history.mangaId) ?? NO_BADGES}
        className="@5xl:col-span-5"
      />

      <div className="@container flex min-w-0 flex-col gap-3 @5xl:col-span-7">
        {/* History is not a phone tab, so this link is its way in either way. */}
        <header className="flex items-center justify-between gap-3">
          {rest.length > 0 ? <h3 className="text-sm font-semibold">Also reading</h3> : null}
          <Button asChild variant="ghost" size="sm" className="-mr-2 ml-auto text-muted-foreground">
            <Link to="/history">History</Link>
          </Button>
        </header>
        {rest.length > 0 ? (
          <ul className={SHELF}>
            {rest.map((item) => {
              const links = linksOf(item)
              const position = positionOf(item)
              const badges = counts.get(item.history.mangaId) ?? NO_BADGES
              return (
                <li key={item.history.mangaId} className={SHELF_ITEM}>
                  <SeriesTile
                    series={links.series}
                    title={item.history.mangaTitle}
                    thumbnailUrl={item.history.thumbnailUrl}
                    contentKind={item.contentKind}
                    meta={`${item.target.name} · ${relativeTime(item.history.readAt)}`}
                    unread={badges.unread}
                    saved={badges.saved}
                    percent={position.percent}
                    action={
                      <ReadButton
                        label={`Resume ${item.history.mangaTitle}`}
                        series={links.series}
                        link={{ chapter: links.reader.chapter }}
                      />
                    }
                  />
                </li>
              )
            })}
          </ul>
        ) : null}
      </div>
    </section>
  )
}

function ContinueHero({
  item,
  badges,
  className,
}: {
  item: ContinueItem
  badges: { unread: number; saved: number }
  className?: string
}) {
  const { history, target } = item
  const position = positionOf(item)
  const links = linksOf(item)

  return (
    <article
      className={cn(
        'relative isolate overflow-hidden rounded-lg border border-border bg-card text-card-foreground',
        className,
      )}
    >
      {history.thumbnailUrl ? (
        <img
          src={history.thumbnailUrl}
          alt=""
          aria-hidden
          referrerPolicy="no-referrer"
          className="absolute inset-0 -z-10 size-full scale-125 object-cover opacity-30 blur-3xl"
        />
      ) : null}
      <div className="flex gap-4 p-3 md:gap-6 md:p-5">
        <Link
          to="/manga/$sourceId/$slug"
          params={links.series}
          className="relative w-24 shrink-0 @md:w-32 @2xl:w-40"
          tabIndex={-1}
          aria-hidden
        >
          <MangaCover url={history.thumbnailUrl ?? undefined} className="shadow-lg" />
          <CoverBadges unread={badges.unread} saved={badges.saved} />
        </Link>

        <div className="flex min-w-0 flex-1 flex-col">
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{sourceName(history.sourceId)}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{relativeTime(history.readAt)}</span>
            {item.contentKind === 'novel' ? <NovelBadge /> : null}
          </p>
          <h3 className="mt-1 line-clamp-2 text-lg font-semibold tracking-tight text-balance @md:text-2xl">
            {history.mangaTitle}
          </h3>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">{target.name}</p>

          <div className="mt-auto pt-3">
            <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
              <span className="tabular-nums">{position.label}</span>
              {position.percent !== null && item.contentKind !== 'novel' ? (
                <span className="tabular-nums">{position.percent}%</span>
              ) : null}
            </div>
            {position.percent !== null ? (
              <Progress
                value={position.percent}
                aria-label={`${target.name} progress`}
                className="mt-1.5 h-1.5"
              />
            ) : null}
            {target.nextSaved ? (
              <p className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <Check aria-hidden className="size-3.5 shrink-0" />
                <span className="truncate">Next: {target.nextSaved.name}, saved offline</span>
              </p>
            ) : null}
            <div className="mt-3 flex gap-2">
              <Button asChild size="lg" className="flex-1 @md:flex-none @md:px-6">
                <Link to="/reader/$sourceId/$slug/$chapter" params={links.reader}>
                  Resume
                </Link>
              </Button>
              <Button asChild size="lg" variant="ghost" className="text-muted-foreground">
                <Link to="/manga/$sourceId/$slug" params={links.series}>
                  Series
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </article>
  )
}
