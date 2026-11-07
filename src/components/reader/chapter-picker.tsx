import { memo, useMemo, useState } from 'react'
import { ChevronsUpDown } from 'lucide-react'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { ComboboxList } from '@/components/ui/combobox'
import { chapterKeyOf } from '@/lib/reader/chapter-key'
import type { StoredChapterState } from '@/lib/reader/chapter-queries'
import type { SChapter } from '@/lib/sources/types'
import { permilleToPercent } from '@/lib/text/progress'
import { cn } from '@/lib/utils'

import { ToolbarButton } from './ui'

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
  /** Read state by chapter url, from the stored rows. Empty draws no marks. */
  states?: ReadonlyMap<string, StoredChapterState>
  /** Novels store a permille position, shown as a percent rather than pages. */
  novel?: boolean
  disabled?: boolean
  onSelect(key: string): void
}

/**
 * The chapter list, as a searchable combobox.
 *
 * A long series runs to hundreds of chapters, which is past the point a plain
 * dropdown is usable: the list is capped and scrolls, and the search box is
 * the real way in — you know the number you want. `ComboboxList` rather than
 * `Combobox`, because the trigger belongs to the reader's toolbar.
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
  states,
  novel = false,
  disabled,
  onSelect,
}: ChapterPickerProps) {
  const [open, setOpen] = useState(false)

  // A linear scan with a string split per chapter, on a list that can run to a
  // thousand. It only moves when the chapter list or the open chapter does.
  const current = useMemo(
    () => chapters.find((chapter) => chapterKeyOf(chapter) === currentKey),
    [chapters, currentKey],
  )
  // The chapter being read stays named even before the list loads, or when the
  // source's premium filter hides it.
  const label = current?.name ?? `Chapter ${currentKey}`

  // Searchable by name and by the number in the url, since either is what a
  // reader reaches for.
  const options = useMemo(
    () =>
      chapters.map((chapter) => {
        const key = chapterKeyOf(chapter)
        const state = states?.get(chapter.url)
        return {
          value: key,
          label: chapter.name,
          keywords: key,
          content: (
            <ChapterRow
              name={chapter.name}
              state={state}
              current={key === currentKey}
              novel={novel}
            />
          ),
        }
      }),
    [chapters, states, currentKey, novel],
  )

  const choose = (key: string) => {
    setOpen(false)
    if (key !== currentKey) onSelect(key)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ToolbarButton
          variant="solid"
          className="h-10 min-w-0 flex-1 justify-between"
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
              <span className="hidden max-w-24 shrink-0 truncate opacity-60 sm:inline">
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
        className="w-[min(24rem,calc(100vw-1.5rem))] p-1"
        // The reader closes the chapter on Escape. While this is open, Escape
        // belongs to it — stopping here keeps the reader from also exiting.
        onEscapeKeyDown={(event) => event.stopPropagation()}
      >
        <ComboboxList
          autoFocus
          listLabel="Chapters"
          options={options}
          value={currentKey}
          onChange={choose}
          searchPlaceholder="Search chapters"
          emptyMessage="No matching chapter."
        />
      </PopoverContent>
    </Popover>
  )
})

/**
 * One chapter in the list: unread ones carry a dot, the open one its page,
 * read ones are dimmed. Nothing is said for a chapter this device has no row
 * for, since nothing is known about it.
 */
function ChapterRow({
  name,
  state,
  current,
  novel,
}: {
  name: string
  state: StoredChapterState | undefined
  current: boolean
  novel: boolean
}) {
  const read = state?.read ?? false
  const page =
    !current || !state || read || state.pageCount <= 0
      ? null
      : novel
        ? `${permilleToPercent(state.lastPageRead)}%`
        : `${Math.min(state.lastPageRead + 1, state.pageCount)}/${state.pageCount}`

  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span
        aria-hidden
        className={cn('size-1.5 shrink-0 rounded-full', state && !read && 'bg-primary')}
      />
      <span className={cn('min-w-0 flex-1 truncate', read && 'text-muted-foreground', current && 'font-medium')}>
        {name}
      </span>
      {page ? (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{page}</span>
      ) : read ? (
        <span className="shrink-0 text-xs text-muted-foreground">Read</span>
      ) : null}
    </span>
  )
}
