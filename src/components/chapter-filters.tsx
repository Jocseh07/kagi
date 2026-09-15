import { useState } from 'react'
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Check,
  Minus,
  RotateCcw,
  SlidersHorizontal,
  X,
} from 'lucide-react'

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { defaultChapterFilters } from '@/lib/chapters/filter-state'
import type {
  ChapterFilterState,
  ChapterSortKey,
  ChapterTriState,
} from '@/lib/chapters/filter-state'
import { cn } from '@/lib/utils'

const TRISTATE_FILTERS = [
  { key: 'downloaded', label: 'Downloaded', only: 'Downloaded only', without: 'Not downloaded' },
  { key: 'unread', label: 'Unread', only: 'Unread only', without: 'Read only' },
  { key: 'bookmarked', label: 'Bookmarked', only: 'Bookmarked only', without: 'Not bookmarked' },
] as const satisfies readonly {
  key: keyof ChapterFilterState
  label: string
  only: string
  without: string
}[]

const SORT_OPTIONS: { key: ChapterSortKey; label: string }[] = [
  { key: 'number', label: 'By chapter number' },
  { key: 'uploadDate', label: 'By upload date' },
]

export function ChapterFilters({
  state,
  onChange,
}: {
  state: ChapterFilterState
  onChange(next: ChapterFilterState): void
}) {
  const [open, setOpen] = useState(false)
  const active = TRISTATE_FILTERS.filter((filter) => state[filter.key] !== 0).length

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <SlidersHorizontal />
          Filter
          {active > 0 && (
            <span className="ml-0.5 rounded-full bg-primary px-1.5 text-[0.7rem] font-semibold text-primary-foreground">
              {active}
            </span>
          )}
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Chapters</DialogTitle>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto">
          {/* Uncontrolled: the dialog unmounts on close, so every open starts
              back at the first section. */}
          <Accordion type="single" collapsible defaultValue="filter">
            <AccordionItem value="filter">
              <AccordionTrigger>
                <span className="flex-1">Filter</span>
                {active > 0 && (
                  <span className="text-xs font-normal text-muted-foreground">
                    {active}
                  </span>
                )}
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                {TRISTATE_FILTERS.map((filter) => (
                  <TriStateRow
                    key={filter.key}
                    label={filter.label}
                    only={filter.only}
                    without={filter.without}
                    value={state[filter.key]}
                    onChange={(value) =>
                      onChange({ ...state, [filter.key]: value })
                    }
                  />
                ))}
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="sort">
              <AccordionTrigger>
                <span className="flex-1">Sort</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {SORT_OPTIONS.find((option) => option.key === state.sort)?.label}
                </span>
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                {SORT_OPTIONS.map((option) => (
                  <SortRow
                    key={option.key}
                    label={option.label}
                    selected={state.sort === option.key}
                    ascending={state.ascending}
                    // Choosing the active key again flips the direction, which is
                    // where the hand already is.
                    onSelect={() =>
                      onChange(
                        state.sort === option.key
                          ? { ...state, ascending: !state.ascending }
                          : { ...state, sort: option.key },
                      )
                    }
                  />
                ))}
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          <Separator />

          <Button
            variant="outline"
            size="sm"
            className="mt-3 w-full"
            // The group is not a filter this dialog owns, so a reset keeps it.
            onClick={() =>
              onChange({ ...defaultChapterFilters(), scanlators: state.scanlators })
            }
          >
            <RotateCcw data-icon="inline-start" />
            Reset
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TriStateRow({
  label,
  only,
  without,
  value,
  onChange,
}: {
  label: string
  only: string
  without: string
  value: ChapterTriState
  onChange(value: ChapterTriState): void
}) {
  const Icon = value === 1 ? Check : value === 2 ? X : Minus

  return (
    <button
      type="button"
      onClick={() => onChange(((value + 1) % 3) as ChapterTriState)}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
          value === 0 && 'border-input text-muted-foreground',
          value === 1 && 'border-primary bg-primary text-primary-foreground',
          value === 2 && 'border-destructive bg-destructive/20 text-destructive',
        )}
      >
        <Icon className="size-3" />
      </span>
      <span className="flex-1">{label}</span>
      <span className="text-xs text-muted-foreground">
        {value === 1 ? only : value === 2 ? without : 'Any'}
      </span>
    </button>
  )
}

function SortRow({
  label,
  selected,
  ascending,
  onSelect,
}: {
  label: string
  selected: boolean
  ascending: boolean
  onSelect(): void
}) {
  const Arrow = ascending ? ArrowUpNarrowWide : ArrowDownWideNarrow
  const direction = ascending ? 'Ascending' : 'Descending'

  return (
    <button
      type="button"
      aria-pressed={selected}
      // The direction chip is the only cue for what a second press does, so
      // spell it out for screen readers too.
      aria-label={
        selected
          ? `Sort ${label}, currently ${direction.toLowerCase()}. Activate to sort ${ascending ? 'descending' : 'ascending'}.`
          : `Sort ${label}`
      }
      onClick={onSelect}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span className={cn('min-w-0 flex-1', !selected && 'text-muted-foreground')}>
        {label}
      </span>
      {selected && (
        <Badge variant="outline">
          <Arrow data-icon="inline-start" aria-hidden />
          {direction}
        </Badge>
      )}
    </button>
  )
}
