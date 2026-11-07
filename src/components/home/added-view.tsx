import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { findReadTarget } from '@/lib/db/home'
import type { LibraryGroups, LibraryProgress } from '@/lib/db/home'

import { seriesSlug } from './format'
import { ReadButton } from './read-button'
import { SeriesTile } from './series-tile'
import { ShelfHeader } from './shelf'
import { caughtUpLine, notStartedLine, pausedLine, pausedPercent } from './status-line'

export type AddedFilter = 'all' | 'not-started' | 'paused' | 'caught-up'

/** Tiles per group on the All view, before "Show all". */
const PREVIEW = 6

const GRID =
  'grid grid-cols-3 gap-x-3 gap-y-4 @md:grid-cols-4 @2xl:grid-cols-6 @5xl:grid-cols-8'

type GroupKind = Exclude<AddedFilter, 'all'>

const GROUPS: readonly {
  kind: GroupKind
  key: keyof LibraryGroups
  title: string
  hint: string
}[] = [
  { kind: 'not-started', key: 'notStarted', title: 'Not started', hint: 'Never opened. Newest first.' },
  { kind: 'paused', key: 'paused', title: 'Paused', hint: 'Not read for a month or more.' },
  { kind: 'caught-up', key: 'caughtUp', title: 'Caught up', hint: 'Every chapter read.' },
]

export function AddedView({
  groups,
  libraryCount,
  filter,
  onFilterChange,
}: {
  groups: LibraryGroups
  libraryCount: number
  filter: AddedFilter
  onFilterChange(next: AddedFilter): void
}) {
  const total = groups.notStarted.length + groups.paused.length + groups.caughtUp.length

  return (
    <section aria-labelledby="added-title" className="@container flex min-w-0 flex-col gap-4">
      <ShelfHeader
        id="added-title"
        title="Added, not on your reading list"
        meta={
          <>
            <span className="tabular-nums">{total}</span> of{' '}
            <span className="tabular-nums">{libraryCount}</span> series in your library
          </>
        }
      >
        <Button asChild variant="ghost" size="sm" className="-mr-2">
          <Link to="/library">Open library</Link>
        </Button>
      </ShelfHeader>

      <Tabs
        value={filter}
        onValueChange={(next) => onFilterChange(next as AddedFilter)}
        className="gap-4"
      >
        <div className="bleed-page -my-1 overflow-x-auto py-1">
          <TabsList aria-label="Filter added series">
            <FilterTab value="all" label="All" count={total} />
            {GROUPS.map((group) => (
              <FilterTab
                key={group.kind}
                value={group.kind}
                label={group.title}
                count={groups[group.key].length}
              />
            ))}
          </TabsList>
        </div>

        <TabsContent value="all" className="flex flex-col gap-6">
          {GROUPS.map((group) =>
            groups[group.key].length > 0 ? (
              <AddedGroup
                key={group.kind}
                kind={group.kind}
                title={group.title}
                hint={group.hint}
                items={groups[group.key].slice(0, PREVIEW)}
                count={groups[group.key].length}
                onShowAll={() => onFilterChange(group.kind)}
              />
            ) : null,
          )}
        </TabsContent>
        {GROUPS.map((group) => (
          <TabsContent key={group.kind} value={group.kind}>
            {groups[group.key].length > 0 ? (
              <AddedGroup
                kind={group.kind}
                title={group.title}
                hint={group.hint}
                items={groups[group.key]}
                count={groups[group.key].length}
              />
            ) : (
              <p className="rounded-lg bg-muted px-3 py-6 text-center text-sm text-muted-foreground">
                Nothing here.
              </p>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </section>
  )
}

function FilterTab({ value, label, count }: { value: AddedFilter; label: string; count: number }) {
  return (
    <TabsTrigger value={value}>
      <span>
        {label}
        <span className="ml-1 text-xs text-muted-foreground tabular-nums">{count}</span>
      </span>
    </TabsTrigger>
  )
}

function AddedGroup({
  kind,
  title,
  hint,
  items,
  count,
  onShowAll,
}: {
  kind: GroupKind
  title: string
  hint: string
  items: readonly LibraryProgress[]
  count: number
  onShowAll?: () => void
}) {
  const headingId = `added-${kind}`
  const more = onShowAll && count > items.length

  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <header className="mb-2 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 id={headingId} className="text-sm font-semibold">
            {title}
            <span className="ml-1.5 text-xs font-normal text-muted-foreground tabular-nums">
              {count}
            </span>
          </h3>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        {more ? (
          <Button variant="ghost" size="sm" className="-mr-2 text-muted-foreground" onClick={onShowAll}>
            Show all
            <ChevronRight data-icon="inline-end" />
          </Button>
        ) : null}
      </header>
      <ul className={GRID}>
        {items.map((item) => (
          <li key={item.id}>
            <LibraryTile item={item} kind={kind} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function LibraryTile({ item, kind }: { item: LibraryProgress; kind: GroupKind }) {
  const params = { sourceId: item.sourceId, slug: seriesSlug(item.url, item.title, item.memo) }
  const paused = kind === 'paused'
  const meta =
    kind === 'not-started' ? notStartedLine(item) : paused ? pausedLine(item) : caughtUpLine(item)
  const readable = kind !== 'caught-up' && item.total > 0

  return (
    <SeriesTile
      series={params}
      title={item.title}
      thumbnailUrl={item.thumbnailUrl}
      contentKind={item.contentKind}
      meta={meta}
      unread={paused ? item.unreadCount : 0}
      saved={item.downloadedCount}
      percent={paused ? pausedPercent(item) : null}
      action={
        readable ? (
          <ReadButton
            label={`${paused ? 'Resume' : 'Start'} ${item.title}`}
            series={params}
            resolve={() => findReadTarget(item.id, 'next')}
          />
        ) : null
      }
    />
  )
}
