import { useCallback, useEffect, useRef } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { Check, Download } from 'lucide-react'

import {
  MangaCover,
  VirtualMangaLayout,
  mangaSlug,
} from '@/components/manga-grid'
import { MangaListRow } from '@/components/manga-list-row'
import type { LibraryCard as LibraryCardEntry } from '@/lib/db/library'
import { cn } from '@/lib/utils'

export function LibraryGrid({
  entries,
  selected,
  compact,
  onSelect,
}: {
  entries: LibraryCardEntry[]
  selected: ReadonlySet<string>
  /** The reader's "compact list view" setting: rows instead of cover tiles. */
  compact: boolean
  /** `shiftKey` asks the page to extend from the previous selection anchor. */
  onSelect(index: number, shiftKey: boolean): void
}) {
  const selecting = selected.size > 0

  return (
    <VirtualMangaLayout
      items={entries}
      mode={compact ? 'list' : 'grid'}
      coverUrlOf={entryCoverUrl}
      // The index is the entry's place in the whole library, not in its row:
      // shift-select extends over that range.
      renderCard={(entry, index) => {
        const props = {
          entry,
          selected: selected.has(entry.id),
          selecting,
          onSelect: (shiftKey: boolean) => onSelect(index, shiftKey),
        }
        return compact ? (
          <LibraryListRow key={entry.id} {...props} />
        ) : (
          <LibraryCard key={entry.id} {...props} />
        )
      }}
    />
  )
}

interface LibraryItemProps {
  entry: LibraryCardEntry
  selected: boolean
  selecting: boolean
  onSelect(shiftKey: boolean): void
}

/** Stable identity: a new function each render would reset the warm set. */
function entryCoverUrl(entry: LibraryCardEntry): string | undefined {
  return entry.thumbnailUrl ?? undefined
}

function entrySlug(entry: LibraryCardEntry): string {
  return mangaSlug({
    url: entry.url,
    title: entry.title,
    status: entry.status,
    initialized: true,
    memo: entry.memo ?? undefined,
  })
}

function LibraryCard({ entry, selected, selecting, onSelect }: LibraryItemProps) {
  const selection = useSelectionGesture(selecting, onSelect)

  return (
    <Link
      to="/manga/$sourceId/$slug"
      params={{ sourceId: entry.sourceId, slug: entrySlug(entry) }}
      aria-pressed={selecting ? selected : undefined}
      className="group block select-none focus-visible:outline-none"
      {...selection}
    >
      <div className="relative">
        <MangaCover
          url={entry.thumbnailUrl ?? undefined}
          title={entry.title}
          className={cn(
            'transition-colors group-hover:border-primary/60 group-focus-visible:border-primary',
            selected && 'border-primary ring-2 ring-primary',
          )}
        />

        <div className="pointer-events-none absolute top-1 left-1 flex overflow-hidden rounded-md">
          {entry.unreadCount > 0 && (
            <span className="bg-primary px-1.5 py-0.5 text-[0.7rem] font-semibold text-primary-foreground">
              {entry.unreadCount}
            </span>
          )}
          {entry.downloadedCount > 0 && (
            <span className="flex items-center gap-0.5 bg-secondary px-1.5 py-0.5 text-[0.7rem] font-semibold text-secondary-foreground">
              <Download className="size-2.5" />
              {entry.downloadedCount}
            </span>
          )}
        </div>

        {selected && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-primary/25">
            <span className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Check className="size-4" />
            </span>
          </span>
        )}
      </div>

      <p className="mt-2 line-clamp-2 text-[0.8rem] leading-snug text-foreground/90 transition-colors group-hover:text-foreground">
        {entry.title}
      </p>
    </Link>
  )
}

/**
 * The same entry as one line.
 *
 * The counts move off the cover and into the second line: at this size a badge
 * over a 32px thumbnail would cover most of the art it sits on, and there is
 * room beside the title that the tile layout never had.
 */
function LibraryListRow({
  entry,
  selected,
  selecting,
  onSelect,
}: LibraryItemProps) {
  const selection = useSelectionGesture(selecting, onSelect)

  return (
    <Link
      to="/manga/$sourceId/$slug"
      params={{ sourceId: entry.sourceId, slug: entrySlug(entry) }}
      aria-pressed={selecting ? selected : undefined}
      className="group block select-none focus-visible:outline-none"
      {...selection}
    >
      <MangaListRow
        thumbnailUrl={entry.thumbnailUrl ?? undefined}
        title={entry.title}
        selected={selected}
        // Nothing to say means no second line at all: the title simply
        // centres in the row, rather than being padded out with filler.
        meta={
          selected || entry.unreadCount > 0 || entry.downloadedCount > 0 ? (
            <>
              {selected && (
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check className="size-2.5" />
                </span>
              )}
              {entry.unreadCount > 0 && (
                <span className="rounded-sm bg-primary px-1 py-px font-semibold text-primary-foreground tabular-nums">
                  {entry.unreadCount} unread
                </span>
              )}
              {entry.downloadedCount > 0 && (
                <span className="flex items-center gap-0.5 rounded-sm bg-secondary px-1 py-px font-semibold text-secondary-foreground tabular-nums">
                  <Download className="size-2.5" />
                  {entry.downloadedCount}
                </span>
              )}
            </>
          ) : undefined
        }
      />
    </Link>
  )
}

interface SelectionGesture {
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void
  onPointerUp(): void
  onPointerLeave(): void
  onPointerCancel(): void
  onContextMenu(event: ReactMouseEvent<HTMLElement>): void
  onClick(event: ReactMouseEvent<HTMLElement>): void
}

/**
 * Long press, right click and shift-click, spread onto whichever element the
 * layout uses for an entry. Scrolling fires pointercancel, which drops the
 * pending long press.
 */
function useSelectionGesture(
  selecting: boolean,
  onSelect: (shiftKey: boolean) => void,
): SelectionGesture {
  // Set when a long press has already claimed this gesture, so the click the
  // browser sends afterwards does not also navigate.
  const handled = useRef(false)

  const longPress = useLongPress(() => {
    handled.current = true
    onSelect(false)
  })

  return {
    onPointerDown(event) {
      handled.current = false
      longPress.onPointerDown(event)
    },
    onPointerUp: longPress.cancel,
    onPointerLeave: longPress.cancel,
    onPointerCancel: longPress.cancel,
    onContextMenu(event) {
      event.preventDefault()
      handled.current = true
      onSelect(false)
    },
    onClick(event) {
      if (handled.current) {
        handled.current = false
        event.preventDefault()
        return
      }
      if (selecting || event.shiftKey) {
        event.preventDefault()
        onSelect(event.shiftKey)
      }
    },
  }
}

interface LongPressHandlers {
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void
  cancel(): void
}

/** Touch has no right click, so a held press is how a selection starts. */
function useLongPress(onLongPress: () => void, delay = 450): LongPressHandlers {
  const timer = useRef<number | undefined>(undefined)
  const callback = useRef(onLongPress)

  useEffect(() => {
    callback.current = onLongPress
  })

  const cancel = useCallback(() => {
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    timer.current = undefined
  }, [])

  useEffect(() => cancel, [cancel])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // A right click is handled by the context menu path instead.
      if (event.pointerType === 'mouse' && event.button !== 0) return
      cancel()
      timer.current = window.setTimeout(() => {
        timer.current = undefined
        callback.current()
      }, delay)
    },
    [cancel, delay],
  )

  return { onPointerDown, cancel }
}
