import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, ChevronsUpDown, Search } from 'lucide-react'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { VirtualList } from '@/components/virtual-list'
import { cn } from '@/lib/utils'
import type { SChapter } from '@/lib/sources/types'

import { ToolbarButton } from './ui'

/** The route param that identifies a chapter is the trailing url segment. */
export function chapterKeyOf(chapter: SChapter): string {
  return chapter.url.split('/').pop() ?? String(chapter.chapterNumber)
}

interface ChapterPickerProps {
  chapters: SChapter[]
  currentKey: string
  /**
   * The scanlation group these chapters are limited to, when they are limited
   * to one. Null both when the series has a single group and when the reader
   * is moving across all of them — in either case there is no narrowing to
   * account for.
   */
  groupLabel?: string | null
  disabled?: boolean
  onSelect(key: string): void
}

/** One line of truncated text inside `py-1.5`; measured on mount regardless. */
const ROW_HEIGHT = 32

/**
 * The chapter list, as a searchable combobox.
 *
 * A long series runs to hundreds of chapters, which is past the point a plain
 * dropdown is usable: the list is capped and scrolls, and the search box is the
 * real way in — you know the number you want. A `Select` cannot host that box,
 * since it owns the keyboard for its own typeahead, hence `Popover`.
 *
 * Filtering, keyboard navigation and selection are handled here rather than by
 * a command palette, because those all work by scoring items that are mounted:
 * a thousand-chapter series would draw a thousand rows into a panel that shows
 * eight. Only the visible rows are drawn, so the panel opens at the same speed
 * whatever the series length.
 *
 * Memoised because it hangs off the reader's floating bar, which re-renders on
 * every page the strip reports and every time the chrome comes and goes —
 * neither of which changes anything this shows. Its props all keep identity
 * across those renders, so the picker simply stops re-rendering while a
 * chapter is being scrolled.
 */
export const ChapterPicker = memo(function ChapterPicker({
  chapters,
  currentKey,
  groupLabel,
  disabled,
  onSelect,
}: ChapterPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Which row Enter would take, moved by the arrow keys. Indexes the filtered
  // list, so it is reset whenever the term changes underneath it.
  const [activeIndex, setActiveIndex] = useState(0)
  // State, not a ref: the popover mounts its content after this render, and a
  // ref assignment would not tell the virtualizer its scroller had arrived —
  // it would measure `null` once and draw nothing.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null,
  )

  // A linear scan with a string split per chapter, on a list that can run to a
  // thousand. It only moves when the chapter list or the open chapter does.
  const current = useMemo(
    () => chapters.find((chapter) => chapterKeyOf(chapter) === currentKey),
    [chapters, currentKey],
  )
  // The chapter being read stays named even before the list loads, or when the
  // source's premium filter hides it.
  const label = current?.name ?? `Chapter ${currentKey}`

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return chapters
    // Searchable by name and by the number in the url, since either is what a
    // reader reaches for.
    return chapters.filter((chapter) => {
      const key = chapterKeyOf(chapter)
      return (
        chapter.name.toLowerCase().includes(needle) ||
        key.toLowerCase().includes(needle)
      )
    })
  }, [chapters, query])

  const virtualizer = useVirtualizer<HTMLElement, Element>({
    count: matches.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: useCallback(
      (index: number) => {
        const chapter = matches[index]
        return chapter ? chapterKeyOf(chapter) : index
      },
      [matches],
    ),
    overscan: 8,
  })

  const choose = (key: string) => {
    setOpen(false)
    if (key !== currentKey) onSelect(key)
  }

  useEffect(() => {
    if (open) return
    setQuery('')
  }, [open])

  /**
   * Opening lands on the chapter being read: with only the visible rows drawn,
   * scrolling there is the only thing that puts it on screen.
   *
   * Keyed on the scroller rather than on `open`, because the scroller is what
   * arrives late — the effect for the render that flips `open` runs before the
   * popover has mounted anything to scroll.
   */
  useEffect(() => {
    if (!open || !scrollElement) return
    const index = chapters.findIndex(
      (chapter) => chapterKeyOf(chapter) === currentKey,
    )
    const target = index < 0 ? 0 : index
    setActiveIndex(target)
    virtualizer.scrollToIndex(target, { align: 'center' })
    // Deliberately not re-run as the list is searched or scrolled: that would
    // drag it back to the current chapter.
  }, [open, scrollElement]) // eslint-disable-line react-hooks/exhaustive-deps

  const move = (next: number) => {
    if (matches.length === 0) return
    const clamped = Math.max(0, Math.min(matches.length - 1, next))
    setActiveIndex(clamped)
    virtualizer.scrollToIndex(clamped)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(activeIndex + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(activeIndex - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      move(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      move(matches.length - 1)
    } else if (event.key === 'Enter') {
      const chapter = matches[activeIndex]
      if (!chapter) return
      event.preventDefault()
      choose(chapterKeyOf(chapter))
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ToolbarButton
          variant="solid"
          className="max-w-[14rem]"
          role="combobox"
          aria-expanded={open}
          aria-label={groupLabel ? `Chapter, ${groupLabel} only` : 'Chapter'}
          disabled={disabled || chapters.length === 0}
        >
          {/* Said once, here: the list behind this button is one group's, and
              nothing else in the reader accounts for the chapters missing from
              it. The name yields first — on a phone this bar is narrow, and a
              chapter you are already reading survives being cut short better
              than the group you would have no other way to check. */}
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate">{label}</span>
            {groupLabel && (
              <span className="max-w-24 shrink-0 truncate opacity-60">
                {groupLabel}
              </span>
            )}
          </span>
          <ChevronsUpDown aria-hidden className="size-4 shrink-0 opacity-60" />
        </ToolbarButton>
      </PopoverTrigger>

      <PopoverContent
        // Upward: the picker lives in a bar pinned to the bottom of the reader.
        side="top"
        className="w-72 p-1"
        // The reader closes the chapter on Escape. While this is open, Escape
        // belongs to it — stopping here keeps the reader from also exiting.
        onEscapeKeyDown={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 opacity-50" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
              virtualizer.scrollToIndex(0)
            }}
            placeholder="Search chapters…"
            aria-label="Search chapters"
            className="pl-7"
          />
        </div>

        {matches.length === 0 ? (
          <p className="py-6 text-center text-sm">No matching chapter.</p>
        ) : (
          <div
            ref={setScrollElement}
            className="no-scrollbar mt-1 max-h-72 overflow-x-hidden overflow-y-auto"
          >
            <VirtualList
              virtualizer={virtualizer}
              scrollMargin={0}
              role="list"
              itemRole="listitem"
            >
              {(index) => {
                const chapter = matches[index]
                if (!chapter) return null
                const key = chapterKeyOf(chapter)
                return (
                  <button
                    type="button"
                    aria-current={key === currentKey ? 'true' : undefined}
                    className={cn(
                      'flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden',
                      index === activeIndex && 'bg-muted text-foreground',
                    )}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => choose(key)}
                  >
                    <Check
                      aria-hidden
                      className={cn(
                        'size-4 shrink-0',
                        key === currentKey ? undefined : 'opacity-0',
                      )}
                    />
                    <span className="truncate">{chapter.name}</span>
                  </button>
                )
              }}
            </VirtualList>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
})
