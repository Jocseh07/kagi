import { useId, useState } from 'react'
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
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import type { Filter, FilterList } from '@/lib/sources/types'
import { cn } from '@/lib/utils'

export function FilterDialog({
  filters,
  defaults,
  onApply,
  loading = false,
}: {
  filters: FilterList
  /** Pristine list from `source.getFilterList()`, used by Reset. */
  defaults: FilterList
  onApply: (filters: FilterList) => void
  loading?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<FilterList>(filters)

  function handleOpenChange(next: boolean) {
    if (next) setDraft(structuredClone(filters))
    setOpen(next)
  }

  function apply() {
    onApply(draft)
    setOpen(false)
  }

  const activeCount = countActive(filters)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <SlidersHorizontal />
          Filters
          {activeCount > 0 && (
            <span className="ml-0.5 rounded-full bg-primary px-1.5 text-[0.7rem] font-semibold text-primary-foreground">
              {activeCount}
            </span>
          )}
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Filters</DialogTitle>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto">
          {loading ? (
            <FilterSkeleton />
          ) : draft.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This source exposes no filters.
            </p>
          ) : (
            // Uncontrolled and with no default value: every open starts with
            // all groups collapsed, and opening one closes the last.
            <Accordion type="single" collapsible className="space-y-4">
              {draft.map((filter, index) => (
                <FilterControl
                  key={`${filter.type}-${index}`}
                  filter={filter}
                  value={`filter-${index}`}
                  onChange={(next) => setDraft(replaceAt(draft, index, next))}
                />
              ))}
            </Accordion>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setDraft(structuredClone(defaults))}
          >
            <RotateCcw data-icon="inline-start" />
            Reset
          </Button>
          <Button onClick={apply}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FilterControl({
  filter,
  value,
  onChange,
}: {
  filter: Filter
  /** Accordion item id, used only by `group` filters. */
  value: string
  onChange: (next: Filter) => void
}) {
  const id = useId()

  switch (filter.type) {
    case 'header':
      return (
        <h3 className="pt-2 text-sm font-semibold text-foreground">
          {filter.name}
        </h3>
      )

    case 'separator':
      return <Separator />

    case 'text':
      return (
        <div className="space-y-1.5">
          <Label htmlFor={id}>{filter.name}</Label>
          <Input
            id={id}
            value={filter.state}
            onChange={(event) =>
              onChange({ ...filter, state: event.target.value })
            }
          />
        </div>
      )

    case 'select':
      return (
        <div className="space-y-1.5">
          <Label htmlFor={id}>{filter.name}</Label>
          <Select
            value={String(filter.state)}
            onValueChange={(value) =>
              onChange({ ...filter, state: Number(value) })
            }
          >
            <SelectTrigger id={id} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {filter.values.map((value, index) => (
                <SelectItem key={value} value={String(index)}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )

    case 'checkbox':
      return (
        <div className="flex items-center gap-2.5">
          <Checkbox
            id={id}
            checked={filter.state}
            onCheckedChange={(checked) =>
              onChange({ ...filter, state: checked === true })
            }
          />
          <Label htmlFor={id} className="font-normal">
            {filter.name}
          </Label>
        </div>
      )

    case 'tristate':
      return (
        <TristateControl
          filter={filter}
          onChange={(state) => onChange({ ...filter, state })}
        />
      )

    case 'group':
      return (
        <GroupControl
          filter={filter}
          value={value}
          onChange={(state) => onChange({ ...filter, state })}
        />
      )

    case 'sort':
      return (
        <div className="space-y-1.5">
          <Label htmlFor={id}>{filter.name}</Label>
          <div className="flex gap-2">
            <Select
              value={String(filter.state.index)}
              onValueChange={(value) =>
                onChange({
                  ...filter,
                  state: { ...filter.state, index: Number(value) },
                })
              }
            >
              <SelectTrigger id={id} className="flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {filter.values.map((value, index) => (
                  <SelectItem key={value} value={String(index)}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              aria-label={
                filter.state.ascending
                  ? 'Sorting ascending, switch to descending'
                  : 'Sorting descending, switch to ascending'
              }
              onClick={() =>
                onChange({
                  ...filter,
                  state: {
                    ...filter.state,
                    ascending: !filter.state.ascending,
                  },
                })
              }
            >
              {filter.state.ascending ? (
                <ArrowUpNarrowWide />
              ) : (
                <ArrowDownWideNarrow />
              )}
            </Button>
          </div>
        </div>
      )
  }
}

const TRISTATE_LABELS = ['Ignored', 'Included', 'Excluded'] as const

function TristateControl({
  filter,
  onChange,
}: {
  filter: Extract<Filter, { type: 'tristate' }>
  onChange: (state: 0 | 1 | 2) => void
}) {
  const Icon = filter.state === 1 ? Check : filter.state === 2 ? X : Minus

  return (
    <button
      type="button"
      onClick={() => onChange(((filter.state + 1) % 3) as 0 | 1 | 2)}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
          filter.state === 0 && 'border-input text-muted-foreground',
          filter.state === 1 && 'border-primary bg-primary text-primary-foreground',
          filter.state === 2 &&
            'border-destructive bg-destructive/20 text-destructive',
        )}
      >
        <Icon className="size-3" />
      </span>
      <span className="flex-1">{filter.name}</span>
      <span className="text-xs text-muted-foreground">
        {TRISTATE_LABELS[filter.state]}
      </span>
    </button>
  )
}

function GroupControl({
  filter,
  value,
  onChange,
}: {
  filter: Extract<Filter, { type: 'group' }>
  value: string
  onChange: (state: Filter[]) => void
}) {
  const active = countActive(filter.state)

  return (
    <AccordionItem
      value={value}
      className="rounded-lg border border-border last:border-b"
    >
      <AccordionTrigger className="px-3 py-2.5 hover:no-underline">
        <span className="flex-1">{filter.name}</span>
        {active > 0 && (
          <span className="text-xs font-normal text-muted-foreground">
            {active}
          </span>
        )}
      </AccordionTrigger>
      <AccordionContent className="px-3 pb-3">
        {/* Nested groups get their own single-open scope. */}
        <Accordion type="single" collapsible className="space-y-2.5">
          {filter.state.map((child, index) => (
            <FilterControl
              key={`${child.type}-${index}`}
              filter={child}
              value={`${value}-${index}`}
              onChange={(next) => onChange(replaceAt(filter.state, index, next))}
            />
          ))}
        </Accordion>
      </AccordionContent>
    </AccordionItem>
  )
}

function FilterSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="space-y-1.5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-8 w-full" />
        </div>
      ))}
    </div>
  )
}

function replaceAt(list: FilterList, index: number, next: Filter): FilterList {
  return list.map((filter, i) => (i === index ? next : filter))
}

/** Counts filters the user has moved off their default, for the trigger badge. */
function countActive(filters: FilterList): number {
  let count = 0
  for (const filter of filters) {
    switch (filter.type) {
      case 'text':
        if (filter.state.trim()) count += 1
        break
      case 'select':
        if (filter.state !== 0) count += 1
        break
      case 'checkbox':
        if (filter.state) count += 1
        break
      case 'tristate':
        if (filter.state !== 0) count += 1
        break
      case 'group':
        count += countActive(filter.state)
        break
      case 'sort':
        if (filter.state.index !== 0 || filter.state.ascending) count += 1
        break
      case 'header':
      case 'separator':
        break
    }
  }
  return count
}
