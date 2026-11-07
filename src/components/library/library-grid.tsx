import { useCallback, useEffect, useRef } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { Check, Download, Sparkles } from 'lucide-react'

import {
  MangaCover,
  VirtualMangaLayout,
  mangaSlug,
} from '@/components/manga-grid'
import { MangaListRow } from '@/components/manga-list-row'
import { CoverBadges } from '@/components/library/cover-badges'
import { adaptedNovelKey, useAdaptedNovels } from '@/lib/adapt/use-adaptation'
import type { LibraryCard as LibraryCardEntry } from '@/lib/db/library'
import { sourceNameOf } from '@/lib/sources/catalog'
import { displayTitle } from '@/lib/sources/display-title'
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
  const adaptedNovels = useAdaptedNovels()

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
          adapted: adaptedNovels.has(adaptedNovelKey(entry.sourceId, entry.url)),
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
  adapted: boolean
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

function LibraryCard({ entry, selected, adapted, selecting, onSelect }: LibraryItemProps) {
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
          className={cn(
            'transition-colors group-hover:border-primary/60 group-focus-visible:border-primary',
            selected && 'border-primary ring-2 ring-primary',
          )}
        />

        <CoverBadges unread={entry.unreadCount} saved={entry.downloadedCount} />

        {adapted && (
          <span className="pointer-events-none absolute top-1 right-1 flex items-center rounded-sm bg-secondary px-1.5 py-0.5 text-secondary-foreground">
            <Sparkles className="size-2.5" />
            <span className="sr-only">Adapted</span>
          </span>
        )}

        {selected && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-primary/25">
            <span className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Check className="size-4" />
            </span>
          </span>
        )}
      </div>

      <p className="mt-2 line-clamp-2 text-tile leading-snug text-foreground/90 transition-colors group-hover:text-foreground">
        {displayTitle(entry.title, entrySlug(entry))}
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
  adapted,
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
        title={displayTitle(entry.title, entrySlug(entry))}
        selected={selected}
        meta={
          <>
            {selected && (
              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Check className="size-2.5" />
              </span>
            )}
            {entry.unreadCount > 0 && (
              <span className="shrink-0 rounded-sm bg-primary px-1 py-px font-semibold text-primary-foreground tabular-nums">
                {entry.unreadCount} unread
              </span>
            )}
            {entry.downloadedCount > 0 && (
              <span className="flex shrink-0 items-center gap-0.5 rounded-sm bg-secondary px-1 py-px font-semibold text-secondary-foreground tabular-nums">
                <Download className="size-2.5" />
                {entry.downloadedCount}
              </span>
            )}
            {adapted && (
              <span className="flex shrink-0 items-center gap-0.5 rounded-sm bg-secondary px-1 py-px font-semibold text-secondary-foreground">
                <Sparkles className="size-2.5" />
                Adapted
              </span>
            )}
            <span className="min-w-0 truncate">{sourceNameOf(entry.sourceId)}</span>
          </>
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
