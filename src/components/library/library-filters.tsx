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
import type {
  LibraryFilters,
  LibrarySort,
  LibrarySortKey,
  LibraryTriState,
} from '@/lib/db/library'
import { cn } from '@/lib/utils'

const FILTER_ROWS = [
  {
    key: 'downloaded',
    label: 'Downloaded',
    only: 'Downloaded only',
    without: 'Not downloaded',
  },
  { key: 'unread', label: 'Unread', only: 'Unread only', without: 'Fully read' },
  { key: 'started', label: 'Started', only: 'Started only', without: 'Not started' },
  {
    key: 'bookmarked',
    label: 'Bookmarked',
    only: 'Bookmarked only',
    without: 'Not bookmarked',
  },
  {
    key: 'completed',
    label: 'Completed',
    only: 'Completed only',
    without: 'Not completed',
  },
] as const satisfies readonly {
  key: keyof LibraryFilters
  label: string
  only: string
  without: string
}[]

const SORT_ROWS: { key: LibrarySortKey; label: string }[] = [
  { key: 'alphabetical', label: 'Alphabetically' },
  { key: 'lastRead', label: 'Last read' },
  { key: 'lastChecked', label: 'Last checked' },
  { key: 'unreadCount', label: 'Unread count' },
  { key: 'totalChapters', label: 'Total chapters' },
  { key: 'latestChapter', label: 'Latest chapter' },
  { key: 'dateAdded', label: 'Date added' },
  { key: 'random', label: 'Random' },
]

export function LibraryFilterDialog({
  filters,
  sort,
  onFiltersChange,
  onSortChange,
  onReset,
}: {
  filters: LibraryFilters
  sort: LibrarySort
  onFiltersChange(next: LibraryFilters): void
  onSortChange(next: LibrarySort): void
  /** Filters and sort at once, so one press is one change to undo. */
  onReset(): void
}) {
  const [open, setOpen] = useState(false)
  const active = FILTER_ROWS.filter((row) => filters[row.key] !== 0).length

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
          <DialogTitle>Library</DialogTitle>
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
                {FILTER_ROWS.map((row) => (
                  <TriStateRow
                    key={row.key}
                    label={row.label}
                    only={row.only}
                    without={row.without}
                    value={filters[row.key]}
                    onChange={(value) =>
                      onFiltersChange({ ...filters, [row.key]: value })
                    }
                  />
                ))}
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="sort">
              <AccordionTrigger>
                <span className="flex-1">Sort</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {SORT_ROWS.find((row) => row.key === sort.key)?.label}
                </span>
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                {SORT_ROWS.map((row) => (
                  <SortRow
                    key={row.key}
                    label={row.label}
                    selected={sort.key === row.key}
                    ascending={sort.ascending}
                    // Choosing the active key again flips the direction, which is
                    // where the hand already is.
                    onSelect={() =>
                      onSortChange(
                        sort.key === row.key
                          ? { ...sort, ascending: !sort.ascending }
                          : { key: row.key, ascending: sort.ascending },
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
            onClick={onReset}
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
  value: LibraryTriState
  onChange(value: LibraryTriState): void
}) {
  const Icon = value === 1 ? Check : value === 2 ? X : Minus

  return (
    <button
      type="button"
      onClick={() => onChange(((value + 1) % 3) as LibraryTriState)}
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
