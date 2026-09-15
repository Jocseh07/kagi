import { useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, ChevronDown, Download } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { UNGROUPED, UNGROUPED_LABEL } from '@/lib/chapters/filter-state'
import type { ScanlatorOption } from '@/lib/chapters/filter-state'

/**
 * Radix needs a non-empty value per item, and `UNGROUPED` is the empty string.
 * This stands in for it inside the menu alone; the state the rest of the app
 * sees is still the plain group name.
 */
const NO_GROUP = ' none'

/** Below this many groups the list is quicker to read than to search. */
const SEARCH_THRESHOLD = 8

/**
 * Picks the one scanlation group a series is read from.
 *
 * There is no "all": an aggregator's groups are parallel copies of the same
 * series, and reading across them hands over chapters already read in another
 * translation. The series page derives a group when none has been chosen, so
 * the control is only ever empty for the moment before that lands.
 *
 * A menu rather than a `Select` because it has to hold a text field: Radix's
 * Select owns the keyboard for its own typeahead and pulls focus onto items,
 * so an input inside it loses a race for every keystroke.
 */
export function ChapterGroupSelect({
  groups,
  value,
  onChange,
}: {
  groups: ScanlatorOption[]
  /** The followed group's name, or null until one is derived. */
  value: string | null
  onChange(next: string): void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const searchable = groups.length > SEARCH_THRESHOLD
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return groups
    return groups.filter((group) =>
      (group.name || UNGROUPED_LABEL).toLowerCase().includes(needle),
    )
  }, [groups, query])

  /**
   * Put the cursor in the search field once the menu is up.
   *
   * `autoFocus` alone loses: Radix focuses the first item after the content
   * mounts, so the field has to claim focus on the frame after that. There is
   * no `onOpenAutoFocus` on a dropdown's content to opt out of it.
   */
  useEffect(() => {
    if (!open || !searchable) return
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open, searchable])

  // One group is not a choice, and none means the source does not attribute
  // its chapters at all.
  if (groups.length < 2) return null

  const selected = value === null ? '' : toItemValue(value)

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // Reopening always starts clean rather than resuming a stale search.
        if (!next) setQuery('')
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="Scanlation group"
          className="w-36 shrink-0 justify-between sm:w-40"
        >
          <span className="truncate">
            {value === null ? 'Choose group' : value || UNGROUPED_LABEL}
          </span>
          <ChevronDown className="text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        {searchable && (
          <div className="p-1">
            <Input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search groups"
              aria-label="Search scanlation groups"
              className="h-8 text-base sm:text-sm"
              // Printable keys and Backspace belong to the field. Everything
              // else — arrows, Enter, Escape — keeps bubbling so the menu's own
              // navigation still works while the cursor sits here.
              onKeyDown={(event) => {
                if (event.key.length === 1 || event.key === 'Backspace') {
                  event.stopPropagation()
                }
              }}
            />
          </div>
        )}

        <div className="max-h-72 overflow-y-auto">
          <DropdownMenuRadioGroup
            value={selected}
            onValueChange={(next) => {
              onChange(fromItemValue(next))
              setOpen(false)
            }}
          >
            {matches.map((group) => (
              <DropdownMenuRadioItem
                key={group.name}
                value={toItemValue(group.name)}
                textValue={groupTextValue(group)}
              >
                <GroupRow group={group} />
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>

          {matches.length === 0 && (
            <p className="px-2 py-4 text-center text-sm text-muted-foreground">
              No groups match.
            </p>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function GroupRow({ group }: { group: ScanlatorOption }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="min-w-0 truncate">{group.name || UNGROUPED_LABEL}</span>

      {/* Not a checkmark: the item already carries one on its right edge for
          the current selection, and two ticks meaning different things in one
          row is worse than no signal at all. */}
      {group.readCount > 0 && (
        <BookOpen className="size-4 shrink-0 text-muted-foreground" />
      )}
      {group.downloadedCount > 0 && (
        <Download className="size-4 shrink-0 text-muted-foreground" />
      )}

      <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
        {group.count}
      </span>
    </span>
  )
}

/**
 * What a screen reader and the menu's typeahead get, since the row itself is
 * markup rather than text.
 */
function groupTextValue(group: ScanlatorOption): string {
  const name = group.name || UNGROUPED_LABEL
  const notes: string[] = [`${group.count} chapters`]
  if (group.readCount > 0) notes.push(`${group.readCount} read`)
  if (group.downloadedCount > 0) {
    notes.push(`${group.downloadedCount} downloaded`)
  }
  return `${name}, ${notes.join(', ')}`
}

function toItemValue(name: string): string {
  return name === UNGROUPED ? NO_GROUP : name
}

function fromItemValue(value: string): string {
  return value === NO_GROUP ? UNGROUPED : value
}
