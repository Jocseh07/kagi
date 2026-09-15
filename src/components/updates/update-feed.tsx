import { useCallback, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { BellRing, ChevronRight, Download } from 'lucide-react'

import { MangaCover, mangaSlug } from '@/components/manga-grid'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { VirtualList } from '@/components/virtual-list'
import { groupBySeries } from '@/lib/db/updates'
import type { UpdateDay, UpdateEntry } from '@/lib/db/updates'
import { readPercent } from '@/lib/text/progress'
import { usePageVirtualizer } from '@/lib/virtual/use-page-virtualizer'
import { cn } from '@/lib/utils'

import { chapterKeyOf, dayLabel, relativeTime } from './format'

/**
 * The feed as one flat list of rows.
 *
 * A virtualizer needs a single sequence it can index into, so the day sections
 * are flattened and each row carries the chrome its section used to provide:
 * the card's side borders, and rounded corners on the first and last entry of
 * a day.
 *
 * A collapsed day drops its rows from the sequence entirely, so folding one
 * away costs the virtualizer nothing. A series with several new chapters is a
 * single row instead, and grows in place when expanded.
 */
type FeedRow =
  | {
      kind: 'day'
      key: string
      date: number
      count: number
      first: boolean
      collapsed: boolean
    }
  | { kind: 'entry'; key: string; entry: UpdateEntry; first: boolean; last: boolean }
  | {
      kind: 'group'
      key: string
      entries: UpdateEntry[]
      expanded: boolean
      first: boolean
      last: boolean
    }

function flattenDays(
  days: readonly UpdateDay[],
  collapsedDays: ReadonlySet<string>,
  expandedGroups: ReadonlySet<string>,
): FeedRow[] {
  return days.flatMap((day, dayIndex) => {
    const collapsed = collapsedDays.has(day.key)
    const header: FeedRow = {
      kind: 'day',
      key: day.key,
      date: day.date,
      count: day.entries.length,
      first: dayIndex === 0,
      collapsed,
    }
    if (collapsed) return [header]

    const groups = groupBySeries(day.entries)
    return [
      header,
      ...groups.map((group, index): FeedRow => {
        const first = index === 0
        const last = index === groups.length - 1
        // Keyed by series and day either way, so a row that gains a second
        // chapter mid-run grows in place instead of being replaced.
        const key = `${day.key}:${group.key}`
        const single = group.entries[0]
        if (group.entries.length === 1 && single) {
          return { kind: 'entry', key, entry: single, first, last }
        }
        return {
          kind: 'group',
          key,
          entries: group.entries,
          expanded: expandedGroups.has(key),
          first,
          last,
        }
      }),
    ]
  })
}

/** Heading with its `pt-4` section gap; the first one sits flush with the page. */
const DAY_ROW_HEIGHT = 40
const FIRST_DAY_ROW_HEIGHT = 24
/** A 40px cover at 2:3 plus the row's own padding. Measured for real on mount. */
const ENTRY_ROW_HEIGHT = 80
/** One line of chapter text plus its padding, inside an expanded series. */
const CHAPTER_ROW_HEIGHT = 52

export function UpdateFeed({ days }: { days: readonly UpdateDay[] }) {
  const [collapsedDays, setCollapsedDays] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  )

  const rows = useMemo(
    () => flattenDays(days, collapsedDays, expandedGroups),
    [days, collapsedDays, expandedGroups],
  )

  const { listRef, virtualizer, scrollMargin } = usePageVirtualizer({
    count: rows.length,
    estimateSize: useCallback(
      (index: number) => {
        const row = rows[index]
        if (!row) return ENTRY_ROW_HEIGHT
        if (row.kind === 'entry') return ENTRY_ROW_HEIGHT
        if (row.kind === 'group') {
          return row.expanded
            ? ENTRY_ROW_HEIGHT + row.entries.length * CHAPTER_ROW_HEIGHT
            : ENTRY_ROW_HEIGHT
        }
        return row.first ? FIRST_DAY_ROW_HEIGHT : DAY_ROW_HEIGHT
      },
      [rows],
    ),
    getItemKey: useCallback((index: number) => rows[index]?.key ?? index, [rows]),
  })

  return (
    <VirtualList
      virtualizer={virtualizer}
      listRef={listRef}
      scrollMargin={scrollMargin}
    >
      {(index) => {
        const row = rows[index]
        if (!row) return null

        if (row.kind === 'day') {
          return (
            <DayHeader
              date={row.date}
              count={row.count}
              first={row.first}
              collapsed={row.collapsed}
              onToggle={() => setCollapsedDays(toggled(row.key))}
            />
          )
        }

        return (
          <div
            className={cn(
              // `overflow-hidden` so a row's hover fill stays inside the
              // rounded corners the way the card's own clipping used to.
              'overflow-hidden border-x border-border bg-card',
              row.first && 'rounded-t-lg border-t',
              row.last ? 'rounded-b-lg border-b' : 'border-b',
            )}
          >
            {row.kind === 'entry' ? (
              <UpdateRow entry={row.entry} />
            ) : (
              <UpdateGroupRow
                entries={row.entries}
                expanded={row.expanded}
                onToggle={() => setExpandedGroups(toggled(row.key))}
              />
            )}
          </div>
        )
      }}
    </VirtualList>
  )
}

/** Set updater that flips one key's membership. */
function toggled(key: string) {
  return (current: ReadonlySet<string>): ReadonlySet<string> => {
    const next = new Set(current)
    if (!next.delete(key)) next.add(key)
    return next
  }
}

function DayHeader({
  date,
  count,
  first,
  collapsed,
  onToggle,
}: {
  date: number
  count: number
  first: boolean
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <h2 className={cn('pb-2', !first && 'pt-4')}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            'size-3.5 transition-transform',
            !collapsed && 'rotate-90',
          )}
          aria-hidden
        />
        {dayLabel(date)}
        <span className="font-normal normal-case opacity-70">({count})</span>
      </button>
    </h2>
  )
}

/**
 * Several new chapters of one series, as one row that opens to list them.
 *
 * The trigger repeats the shape of `UpdateRow` so a folded series and a series
 * with a single new chapter read as the same kind of thing.
 */
function UpdateGroupRow({
  entries,
  expanded,
  onToggle,
}: {
  entries: readonly UpdateEntry[]
  expanded: boolean
  onToggle: () => void
}) {
  const newest = entries[0]
  if (!newest) return null

  const unread = entries.filter((entry) => !entry.read).length
  const slug = seriesSlug(newest)

  return (
    <Collapsible open={expanded} onOpenChange={onToggle}>
      <div
        className={cn(
          'flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-secondary',
          unread === 0 && 'opacity-55',
        )}
      >
        <Link
          to="/manga/$sourceId/$slug"
          params={{ sourceId: newest.sourceId, slug }}
          className="w-10 shrink-0"
          aria-label={newest.mangaTitle}
        >
          <MangaCover
            url={newest.thumbnailUrl ?? undefined}
            title={newest.mangaTitle}
          />
        </Link>

        <CollapsibleTrigger className="min-w-0 flex-1 text-left">
          <p
            className={cn(
              'truncate text-sm',
              unread === 0 ? 'font-normal' : 'font-medium',
            )}
          >
            {newest.mangaTitle}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {entries.length} new chapters
            {unread > 0 ? ` · ${unread} unread` : ''}
          </p>
          <p className="text-xs text-muted-foreground">
            {relativeTime(newest.dateUpload ?? newest.addedAt)}
          </p>
        </CollapsibleTrigger>

        <CollapsibleTrigger
          aria-label={expanded ? 'Hide chapters' : 'Show chapters'}
          className="flex shrink-0 items-center gap-2 text-muted-foreground"
        >
          {unread > 0 && (
            <span className="size-2 rounded-full bg-primary" aria-hidden />
          )}
          <ChevronRight
            className={cn('size-4 transition-transform', expanded && 'rotate-90')}
            aria-hidden
          />
        </CollapsibleTrigger>
      </div>

      <CollapsibleContent>
        <ul className="border-t border-border/60">
          {entries.map((entry) => (
            <li key={entry.chapterId}>
              <ChapterRow entry={entry} slug={slug} />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** One chapter inside an expanded series, indented past the cover above it. */
function ChapterRow({ entry, slug }: { entry: UpdateEntry; slug: string }) {
  const progress = progressLabel(entry)

  return (
    <Link
      to="/reader/$sourceId/$slug/$chapter"
      params={{
        sourceId: entry.sourceId,
        slug,
        chapter: chapterKeyOf(entry.chapterUrl, entry.chapterNumber),
      }}
      className={cn(
        'flex items-center gap-3 py-2 pr-3 pl-16 transition-colors hover:bg-secondary',
        entry.read && 'opacity-55',
      )}
    >
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-sm',
            entry.read ? 'font-normal' : 'font-medium',
          )}
        >
          {entry.chapterName}
          {progress ? ` · ${progress}` : ''}
        </span>
        <span className="block text-xs text-muted-foreground">
          {relativeTime(entry.dateUpload ?? entry.addedAt)}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-2">
        {entry.downloaded && (
          <Download
            className="size-3.5 text-muted-foreground"
            aria-label="Saved offline"
          />
        )}
        {!entry.read && (
          <span
            className="size-2 rounded-full bg-primary"
            aria-label="Unread"
            role="img"
          />
        )}
      </span>
    </Link>
  )
}

function seriesSlug(entry: UpdateEntry): string {
  return mangaSlug({
    url: entry.mangaUrl,
    title: entry.mangaTitle,
    status: 'unknown',
    initialized: true,
    memo: entry.mangaMemo ?? undefined,
  })
}

function UpdateRow({ entry }: { entry: UpdateEntry }) {
  const progress = progressLabel(entry)
  const slug = seriesSlug(entry)

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-secondary',
        entry.read && 'opacity-55',
      )}
    >
      <Link
        to="/manga/$sourceId/$slug"
        params={{ sourceId: entry.sourceId, slug }}
        className="w-10 shrink-0"
        aria-label={entry.mangaTitle}
      >
        <MangaCover
          url={entry.thumbnailUrl ?? undefined}
          title={entry.mangaTitle}
        />
      </Link>

      <Link
        to="/reader/$sourceId/$slug/$chapter"
        params={{
          sourceId: entry.sourceId,
          slug,
          chapter: chapterKeyOf(entry.chapterUrl, entry.chapterNumber),
        }}
        className="min-w-0 flex-1"
      >
        <p
          className={cn(
            'truncate text-sm',
            entry.read ? 'font-normal' : 'font-medium',
          )}
        >
          {entry.mangaTitle}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {entry.chapterName}
          {progress ? ` · ${progress}` : ''}
        </p>
        <p className="text-xs text-muted-foreground">
          {relativeTime(entry.dateUpload ?? entry.addedAt)}
        </p>
      </Link>

      <div className="flex shrink-0 items-center gap-2">
        {entry.downloaded && (
          <Download
            className="size-3.5 text-muted-foreground"
            aria-label="Saved offline"
          />
        )}
        {!entry.read && (
          <span
            className="size-2 rounded-full bg-primary"
            aria-label="Unread"
            role="img"
          />
        )}
      </div>
    </div>
  )
}

/** Only meaningful mid-chapter; a finished chapter already reads as read. */
function progressLabel(entry: UpdateEntry): string | null {
  if (entry.read || entry.lastPageRead <= 0) return null
  const percent = readPercent(entry.lastPageRead, entry.pageCount)
  return percent === null ? `page ${entry.lastPageRead + 1}` : `${percent}%`
}

export function EmptyUpdates({ hasFavorites }: { hasFavorites: boolean }) {
  return (
    <EmptyState
      icon={BellRing}
      title={hasFavorites ? 'Nothing new' : 'Your library is empty'}
      description={
        hasFavorites
          ? 'Chapters that turn up in your favourites appear here. Run a check to look for them now.'
          : 'Add a series to your library and its new chapters will show up here.'
      }
      action={
        hasFavorites ? undefined : (
          <Button asChild variant="outline" size="sm">
            <Link to="/browse">Browse sources</Link>
          </Button>
        )
      }
    />
  )
}

export function UpdateFeedSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-3 w-24" />
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="aspect-[2/3] w-10 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}
