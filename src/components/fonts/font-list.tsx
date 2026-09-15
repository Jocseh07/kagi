import { useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, Search } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { VirtualList } from '@/components/virtual-list'
import { searchFonts, type FontOption } from '@/lib/fonts/catalog'
import { cn } from '@/lib/utils'

/** One line of `text-[15px]` inside `py-2`; the row is not measured after. */
const ROW_HEIGHT = 36

/** The stack the "no override" row previews in, and what an empty id means. */
export const INHERITED_STACK = 'var(--font-sans)'

interface FontListProps {
  /** A catalog id, or `''` for the inherit row. */
  value: string
  onChange(id: string): void
  /** What inheriting is called here — the app font, or the theme's. */
  defaultLabel: string
  /** Tailwind max-height for the scroller; short panels want less than the page. */
  listClassName?: string
  /** Only where the list *is* the panel; inline it would steal the caret. */
  autoFocus?: boolean
}

/**
 * The font list: search, then one flat virtualized column.
 *
 * Every row is set in the face it names, because that is the only way to choose
 * a typeface — a category heading is a word to read on the way to a decision
 * already made by eye, which is why the list is flat and unlabelled. Drawing
 * only the visible rows matters twice over: a browser fetches a woff2 only once
 * something on screen is painted with it, so an unmounted row costs no request,
 * and scrolling the catalog pulls fonts a handful at a time.
 *
 * Controlled and presentational, because the two callers own different
 * settings — the app's font and a novel's — and neither should have to be the
 * other. Selection does not dismiss anything: what is being judged is the text
 * behind the panel, and closing after every try would make comparing two faces
 * a matter of memory.
 */
export function FontList({
  value,
  onChange,
  defaultLabel,
  listClassName = 'max-h-72',
  autoFocus = false,
}: FontListProps) {
  const [query, setQuery] = useState('')
  // Which row Enter would take, moved by the arrow keys. Indexes the filtered
  // list, so it is reset whenever the term changes underneath it.
  const [activeIndex, setActiveIndex] = useState(0)
  // State, not a ref: a panel mounts its content after this render, and a ref
  // assignment would not tell the virtualizer its scroller had arrived — it
  // would measure `null` once and draw nothing.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)

  const matches = useMemo(
    () => [
      { id: '', name: defaultLabel, stack: INHERITED_STACK },
      ...searchFonts(query),
    ],
    [defaultLabel, query],
  )

  const virtualizer = useVirtualizer<HTMLElement, Element>({
    count: matches.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  })

  const move = (next: number) => {
    if (matches.length === 0) return
    const clamped = Math.max(0, Math.min(matches.length - 1, next))
    setActiveIndex(clamped)
    virtualizer.scrollToIndex(clamped)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    // The reader binds the arrow keys to page turning on `window`, and lets
    // anything typed into a field through untouched. A row is a button, not a
    // field, so navigating the list from one has to say so explicitly.
    const handled = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter']
    if (handled.includes(event.key)) event.stopPropagation()

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
      const font = matches[activeIndex]
      if (!font) return
      event.preventDefault()
      onChange(font.id)
    }
  }

  return (
    <div onKeyDown={handleKeyDown}>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 opacity-50" />
        <Input
          autoFocus={autoFocus}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveIndex(0)
            virtualizer.scrollToIndex(0)
          }}
          placeholder="Search fonts…"
          aria-label="Search fonts"
          className="h-8 pl-7 text-xs"
        />
      </div>

      {matches.length === 0 ? (
        <p className="py-6 text-center text-sm">No font by that name.</p>
      ) : (
        <div
          ref={setScrollElement}
          className={cn(
            'no-scrollbar mt-1 overflow-x-hidden overflow-y-auto',
            listClassName,
          )}
        >
          <VirtualList
            virtualizer={virtualizer}
            scrollMargin={0}
            role="list"
            itemRole="listitem"
          >
            {(index) => {
              const font: FontOption | undefined = matches[index]
              if (!font) return null
              const selected = font.id === value

              return (
                <button
                  type="button"
                  aria-current={selected ? 'true' : undefined}
                  className={cn(
                    'flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-2 text-left text-[15px] outline-hidden',
                    index === activeIndex && 'bg-muted text-foreground',
                  )}
                  style={{ fontFamily: font.stack }}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => onChange(font.id)}
                >
                  <Check
                    aria-hidden
                    className={cn('size-4 shrink-0', selected ? undefined : 'opacity-0')}
                  />
                  <span className="truncate">{font.name}</span>
                </button>
              )
            }}
          </VirtualList>
        </div>
      )}
    </div>
  )
}
