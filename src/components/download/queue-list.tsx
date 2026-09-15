import { useCallback, useMemo, useState } from 'react'

import { FoldRow } from '@/components/fold-row'
import { VirtualList } from '@/components/virtual-list'
import { TERMINAL_QUEUE_STATES } from '@/lib/download/queue-types'
import type { QueueItem } from '@/lib/download/queue-types'
import { usePageVirtualizer } from '@/lib/virtual/use-page-virtualizer'
import { cn } from '@/lib/utils'

import { QueueItemRow } from './queue-item-row'

export interface QueueListProps {
  /** In queue order, as `listQueue` returns them. */
  items: readonly QueueItem[]
  /** Item currently being mutated from the UI, so its controls can wait. */
  busyId: string | null
  disabled: boolean
  onRetry(item: QueueItem): void
  onRemove(item: QueueItem): void
  /** `index` is the item's place in the whole queue, which reorder works on. */
  onMove(item: QueueItem, index: number, direction: -1 | 1): void
}

interface Entry {
  item: QueueItem
  index: number
}

interface Group {
  mangaId: string
  title: string
  entries: Entry[]
}

/** A fold is only worth a click once it hides more rows than it adds. */
const MIN_DONE_RUN = 3

type Segment = {
  /** `done` runs fold away; `open` runs stay in view. */
  kind: 'done' | 'open'
  entries: Entry[]
}

/**
 * The whole list as one flat sequence of rows.
 *
 * Downloading a long series' backlog puts hundreds of rows here, so only what
 * is in view is drawn. That rules out a collapsible panel around the saved
 * runs — a virtualizer has to be able to index and measure every row — so a
 * fold is an ordinary row and the rows behind it are left out of the sequence
 * while it is shut. `first` and `last` are per group, and carry the card's
 * rounded corners now that the group is no longer a container.
 */
type QueueListRow =
  | { kind: 'heading'; key: string; title: string; detail: string; first: boolean }
  | { kind: 'fold'; key: string; count: number; range: string }
  | { kind: 'item'; key: string; entry: Entry }

/** Two lines of text inside `py-2.5`, plus a progress bar. Measured on mount. */
const ITEM_ROW_HEIGHT = 62
const FOLD_ROW_HEIGHT = 42
const HEADING_ROW_HEIGHT = 42
const FIRST_HEADING_ROW_HEIGHT = 26

function buildQueueRows(
  groups: readonly Group[],
  openFolds: ReadonlySet<string>,
): { rows: QueueListRow[]; corners: Map<string, 'first' | 'last' | 'only'> } {
  const rows: QueueListRow[] = []
  // Which rows sit at the top and bottom of their group's card. Only known
  // once the folds have decided what is in the sequence at all.
  const corners = new Map<string, 'first' | 'last' | 'only'>()

  groups.forEach((group, groupIndex) => {
    rows.push({
      kind: 'heading',
      key: `heading-${group.mangaId}`,
      title: group.title,
      detail: `${group.entries.length} ${
        group.entries.length === 1 ? 'chapter' : 'chapters'
      } · ${groupStatus(group.entries)}`,
      first: groupIndex === 0,
    })

    const start = rows.length

    segmentEntries(group.entries).forEach((segment, index) => {
      const foldKey = `fold-${group.mangaId}-${index}`
      if (segment.kind === 'done') {
        rows.push({
          kind: 'fold',
          key: foldKey,
          count: segment.entries.length,
          range: chapterRangeLabel(segment.entries),
        })
        if (!openFolds.has(foldKey)) return
      }
      for (const entry of segment.entries) {
        rows.push({ kind: 'item', key: entry.item.id, entry })
      }
    })

    const firstKey = rows[start]?.key
    const lastKey = rows[rows.length - 1]?.key
    if (!firstKey || !lastKey) return
    if (firstKey === lastKey) corners.set(firstKey, 'only')
    else {
      corners.set(firstKey, 'first')
      corners.set(lastKey, 'last')
    }
  })

  return { rows, corners }
}

export function QueueList({
  items,
  busyId,
  disabled,
  onRetry,
  onRemove,
  onMove,
}: QueueListProps) {
  const groups = useMemo(() => groupByManga(items), [items])
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )

  const { rows, corners } = useMemo(
    () => buildQueueRows(groups, openFolds),
    [groups, openFolds],
  )

  const toggleFold = useCallback((key: string) => {
    setOpenFolds((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  const { listRef, virtualizer, scrollMargin } = usePageVirtualizer({
    count: rows.length,
    estimateSize: useCallback(
      (index: number) => {
        const row = rows[index]
        if (row?.kind === 'fold') return FOLD_ROW_HEIGHT
        if (row?.kind === 'heading') {
          return row.first ? FIRST_HEADING_ROW_HEIGHT : HEADING_ROW_HEIGHT
        }
        return ITEM_ROW_HEIGHT
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

        if (row.kind === 'heading') {
          return (
            <h2
              className={cn(
                'flex flex-wrap items-baseline gap-x-2 px-1 pb-1.5 text-sm font-semibold',
                !row.first && 'pt-4',
              )}
            >
              <span className="min-w-0 truncate">{row.title}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {row.detail}
              </span>
            </h2>
          )
        }

        const corner = corners.get(row.key)
        // The card chrome that the group's container used to draw, spread over
        // the rows it used to hold.
        const card = cn(
          'overflow-hidden border-x border-b border-border bg-card',
          (corner === 'first' || corner === 'only') && 'rounded-t-lg border-t',
          (corner === 'last' || corner === 'only') && 'rounded-b-lg',
        )

        if (row.kind === 'fold') {
          return (
            <FoldRow
              open={openFolds.has(row.key)}
              label={`${row.count} saved`}
              detail={row.range}
              className={card}
              onToggle={() => toggleFold(row.key)}
            />
          )
        }

        const { item, index: position } = row.entry
        return (
          <div className={card}>
            <QueueItemRow
              item={item}
              index={position}
              isFirst={position === 0}
              isLast={position === items.length - 1}
              busy={busyId === item.id}
              disabled={disabled}
              onRetry={() => onRetry(item)}
              onRemove={() => onRemove(item)}
              onMove={(direction) => onMove(item, position, direction)}
            />
          </div>
        )
      }}
    </VirtualList>
  )
}

/**
 * Groups by series while keeping queue order: a group appears where its first
 * chapter sits, so the reorder controls still read top to bottom.
 */
function groupByManga(items: readonly QueueItem[]): Group[] {
  const groups: Group[] = []
  const byManga = new Map<string, Group>()

  for (const [index, item] of items.entries()) {
    let group = byManga.get(item.mangaId)
    if (!group) {
      group = { mangaId: item.mangaId, title: item.mangaTitle, entries: [] }
      byManga.set(item.mangaId, group)
      groups.push(group)
    }
    group.entries.push({ item, index })
  }

  return groups
}

/**
 * Splits a group's rows into runs of saved chapters and everything else, in
 * queue order, so a finished batch folds behind one row while the chapters
 * still waiting, running or failed stay in view.
 *
 * Runs rather than a partition, because the queue order is what the reorder
 * controls act on and moving rows around to tidy the display would break it.
 * Only `done` folds: a failed or cancelled row is exactly the one the user
 * needs to see.
 */
function segmentEntries(entries: Entry[]): Segment[] {
  const segments: Segment[] = []
  let run: Entry[] = []
  let runDone = false

  function flush() {
    if (run.length === 0) return
    const kind = runDone && run.length >= MIN_DONE_RUN ? 'done' : 'open'
    const previous = segments.at(-1)
    // A stray saved chapter stays inline, which means merging it into the rows
    // around it instead of opening a second visible segment.
    if (kind === 'open' && previous?.kind === 'open') {
      previous.entries.push(...run)
    } else {
      segments.push({ kind, entries: run })
    }
    run = []
  }

  for (const entry of entries) {
    const done = entry.item.state === 'done'
    if (run.length > 0 && done !== runDone) flush()
    runDone = done
    run.push(entry)
  }
  flush()

  return segments
}

/** The one thing worth saying about a group beside its chapter count. */
function groupStatus(entries: Entry[]): string {
  const active = entries.filter((entry) => entry.item.state === 'active').length
  if (active > 0) return `${active} downloading`

  const failed = entries.filter((entry) => entry.item.state === 'failed').length
  if (failed > 0) return `${failed} failed`

  if (entries.every((entry) => entry.item.state === 'done')) return 'all saved'

  const paused = entries.filter((entry) => entry.item.state === 'paused').length
  if (paused === entries.length) return 'paused'

  const finished = entries.filter((entry) =>
    TERMINAL_QUEUE_STATES.includes(entry.item.state),
  ).length
  return `${finished} of ${entries.length} finished`
}

function chapterRangeLabel(entries: Entry[]): string {
  const first = entries[0]
  const last = entries[entries.length - 1]
  if (!first || !last) return ''
  const start = first.item.chapterName
  const end = last.item.chapterName
  return start === end ? start : `${start} – ${end}`
}
