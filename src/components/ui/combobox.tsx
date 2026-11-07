import { useEffect, useId, useMemo, useState } from 'react'
import type {
  CSSProperties,
  ComponentProps,
  KeyboardEvent,
  ReactNode,
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, ChevronsUpDown, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { VirtualList } from '@/components/virtual-list'
import { cn } from '@/lib/utils'

/** One line of `text-sm` in a fixed-height row; rows are never measured. */
const ROW_HEIGHT = 32
/** 9 × 32px = 288px = --height-dropdown-list. */
const VISIBLE_ROWS = 9

export interface ComboboxOption {
  value: string
  /** Trigger text and the default row text. */
  label: string
  /** Extra text the search matches, e.g. a chapter's url key. */
  keywords?: string
  /** Row and trigger style; the font list previews each row in its own face. */
  style?: CSSProperties
  /** Replaces the row's label markup. Must truncate itself. */
  content?: ReactNode
  disabled?: boolean
}

type ComboboxListProps = {
  options: readonly ComboboxOption[]
  /** Names the listbox for assistive tech. */
  listLabel: string
  searchPlaceholder?: string
  emptyMessage?: string
  autoFocus?: boolean
  className?: string
} & (
  | { multiple?: false; value: string | null; onChange(value: string): void }
  | { multiple: true; value: readonly string[]; onChange(values: string[]): void }
)

/**
 * A search field over a virtualized listbox: every dropdown in the app, minus
 * the panel around it.
 *
 * Filtering, keyboard navigation and selection live here rather than in a
 * command palette, because those work by scoring items that are mounted — a
 * thousand-chapter series would draw a thousand rows into a panel that shows
 * nine. Only the visible rows exist, so a panel opens at the same speed
 * whatever the list length.
 *
 * Exported on its own for the two places that already are a panel: the reader's
 * chapter picker, which has its own toolbar trigger, and the category dialog.
 */
export function ComboboxList(props: ComboboxListProps) {
  const {
    options,
    listLabel,
    searchPlaceholder = 'Search',
    emptyMessage = 'Nothing matches.',
    autoFocus = false,
    className,
  } = props

  const listId = useId()
  const [query, setQuery] = useState('')
  // Which row Enter would take, moved by the arrow keys. Indexes the filtered
  // list, so it is reset whenever the term changes underneath it.
  const [activeIndex, setActiveIndex] = useState(0)
  // State, not a ref: a popover mounts its content after this render, and a ref
  // assignment would not tell the virtualizer its scroller had arrived — it
  // would measure `null` once and draw nothing.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null,
  )

  const selected = useMemo(() => {
    if (props.multiple) return new Set(props.value)
    return new Set(props.value == null ? [] : [props.value])
  }, [props.multiple, props.value])

  const matches = useMemo(() => {
    const needle = query.replace(/\s+/g, '').toLowerCase()
    if (!needle) return options
    return options.filter((option) =>
      `${option.label} ${option.keywords ?? ''}`
        .replace(/\s+/g, '')
        .toLowerCase()
        .includes(needle),
    )
  }, [options, query])

  const virtualizer = useVirtualizer<HTMLElement, Element>({
    count: matches.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => matches[index]?.value ?? index,
    overscan: 8,
  })

  const choose = (option: ComboboxOption) => {
    if (option.disabled) return
    if (props.multiple) {
      const on = !selected.has(option.value)
      props.onChange(
        options
          .filter((candidate) =>
            candidate.value === option.value ? on : selected.has(candidate.value),
          )
          .map((candidate) => candidate.value),
      )
      return
    }
    props.onChange(option.value)
  }

  /**
   * Opening lands on what is already chosen: with only the visible rows drawn,
   * scrolling there is the only thing that puts it on screen.
   *
   * Keyed on the scroller rather than on mount, because the scroller is what
   * arrives late — a popover mounts its content after the render that opens it.
   */
  useEffect(() => {
    if (!scrollElement) return
    const index = options.findIndex((option) => selected.has(option.value))
    const target = index < 0 ? 0 : index
    setActiveIndex(target)
    virtualizer.scrollToIndex(target, { align: 'center' })
    // Deliberately not re-run as the list is searched or scrolled: that would
    // drag it back to the chosen row.
  }, [scrollElement]) // eslint-disable-line react-hooks/exhaustive-deps

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
      const option = matches[activeIndex]
      if (!option) return
      event.preventDefault()
      choose(option)
    }
  }

  return (
    <div className={className} onKeyDown={handleKeyDown}>
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
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          role="combobox"
          aria-expanded={matches.length > 0}
          aria-controls={listId}
          aria-activedescendant={
            matches.length > 0 ? `${listId}-${activeIndex}` : undefined
          }
          className="pl-7"
        />
      </div>

      {matches.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      ) : (
        <div
          ref={setScrollElement}
          id={listId}
          role="listbox"
          aria-label={listLabel}
          aria-multiselectable={props.multiple || undefined}
          className={cn(
            'no-scrollbar mt-1 overflow-x-hidden overflow-y-auto',
            // Fixed once the full list outruns the panel, so typing never
            // resizes it; shrink-to-fit below that, so a three-option control
            // is not a tall empty box.
            options.length > VISIBLE_ROWS
              ? 'h-(--height-dropdown-list)'
              : 'max-h-(--height-dropdown-list)',
          )}
        >
          <VirtualList
            virtualizer={virtualizer}
            scrollMargin={0}
            measure={false}
            role="presentation"
            itemRole="presentation"
          >
            {(index) => {
              const option = matches[index]
              if (!option) return null
              const isSelected = selected.has(option.value)

              return (
                <button
                  type="button"
                  role="option"
                  id={`${listId}-${index}`}
                  aria-selected={isSelected}
                  disabled={option.disabled}
                  style={option.style}
                  className={cn(
                    'flex h-8 w-full cursor-default items-center gap-2 rounded-sm px-2 text-left text-sm outline-hidden disabled:opacity-50',
                    index === activeIndex && 'bg-muted text-foreground',
                  )}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => choose(option)}
                >
                  {props.multiple ? (
                    // A span, not `Checkbox`: that renders a button, and the
                    // row is already one.
                    <span
                      aria-hidden
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded-sm border border-input',
                        isSelected &&
                          'border-primary bg-primary text-primary-foreground',
                      )}
                    >
                      {isSelected ? <Check className="size-3" /> : null}
                    </span>
                  ) : (
                    <Check
                      aria-hidden
                      className={cn(
                        'size-4 shrink-0',
                        isSelected ? undefined : 'opacity-0',
                      )}
                    />
                  )}
                  {option.content ?? (
                    <span className="truncate">{option.label}</span>
                  )}
                </button>
              )
            }}
          </VirtualList>
        </div>
      )}
    </div>
  )
}

interface PanelProps {
  options: readonly ComboboxOption[]
  /** aria-label on the trigger, and the listbox's name. */
  label: string
  /** Trigger text when nothing is chosen. */
  placeholder?: string
  searchPlaceholder?: string
  emptyMessage?: string
  id?: string
  disabled?: boolean
  /** Trigger classes; panel width is fixed by `panel`. */
  className?: string
  panel?: 'default' | 'narrow'
  side?: ComponentProps<typeof PopoverContent>['side']
  align?: ComponentProps<typeof PopoverContent>['align']
}

interface ComboboxProps extends PanelProps {
  value: string | null
  onChange(value: string): void
  /** False keeps the panel up across picks, for comparing options by eye. */
  closeOnSelect?: boolean
}

/**
 * The app's dropdown: a trigger, a fixed-width panel, a search field and a
 * virtualized list.
 *
 * Not `Select`: that owns the keyboard for its own typeahead, so it cannot host
 * a search field, and it mounts every option into a panel that grows with the
 * list.
 */
export function Combobox({
  options,
  value,
  onChange,
  label,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  id,
  disabled,
  className,
  panel,
  side,
  align,
  closeOnSelect = true,
}: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const selected = options.find((option) => option.value === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          disabled={disabled}
          className={cn('justify-between font-normal', className)}
        >
          <span className="truncate" style={selected?.style}>
            {selected?.label ?? placeholder}
          </span>
          <ChevronsUpDown aria-hidden className="size-4 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        side={side}
        align={align}
        className={cn(
          'p-1 max-w-[calc(100vw-1.5rem)]',
          panel === 'narrow' ? 'w-dropdown-narrow' : 'w-dropdown',
        )}
        // The innermost open layer owns Escape: the reader closes the chapter
        // on it, and a dialog behind a picker closes itself.
        onEscapeKeyDown={(event) => event.stopPropagation()}
      >
        <ComboboxList
          autoFocus
          options={options}
          value={value}
          onChange={(next) => {
            onChange(next)
            if (closeOnSelect) setOpen(false)
          }}
          listLabel={label}
          searchPlaceholder={searchPlaceholder}
          emptyMessage={emptyMessage}
        />
      </PopoverContent>
    </Popover>
  )
}

interface MultiComboboxProps extends PanelProps {
  value: readonly string[]
  onChange(values: string[]): void
}

/** `Combobox` with checkboxes; picking never dismisses the panel. */
export function MultiCombobox({
  options,
  value,
  onChange,
  label,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  id,
  disabled,
  className,
  panel,
  side,
  align,
}: MultiComboboxProps) {
  const [open, setOpen] = useState(false)
  const first = options.find((option) => value.includes(option.value))
  const text =
    value.length === 0
      ? placeholder
      : value.length === 1
        ? (first?.label ?? placeholder)
        : `${value.length} selected`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          disabled={disabled}
          className={cn('justify-between font-normal', className)}
        >
          <span className="truncate">{text}</span>
          <ChevronsUpDown aria-hidden className="size-4 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        side={side}
        align={align}
        className={cn(
          'p-1 max-w-[calc(100vw-1.5rem)]',
          panel === 'narrow' ? 'w-dropdown-narrow' : 'w-dropdown',
        )}
        onEscapeKeyDown={(event) => event.stopPropagation()}
      >
        <ComboboxList
          multiple
          autoFocus
          options={options}
          value={value}
          onChange={onChange}
          listLabel={label}
          searchPlaceholder={searchPlaceholder}
          emptyMessage={emptyMessage}
        />
      </PopoverContent>
    </Popover>
  )
}
