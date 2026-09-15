import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

/**
 * The synopsis, folded to a few lines, with the series' tags underneath.
 *
 * A long synopsis printed in full pushes the chapter list — the reason anyone
 * opened the page — below the fold. Mihon shows roughly three lines behind a
 * gradient scrim and lets the whole block be tapped to open, which is what
 * this reproduces.
 *
 * The tags follow the same state: one swipeable line while the synopsis is
 * shut, wrapped into rows once it is open. Collapsed, they are a reminder of
 * what the series is; expanded, they are a list you are meant to read.
 */
export function ExpandableDescription({
  description,
  genres,
  onBrowseTag,
  onCopyTag,
  className,
}: {
  description?: string
  genres?: readonly string[]
  /** Opens the source filtered by this genre, not a text search for it. */
  onBrowseTag(tag: string): void
  onCopyTag(tag: string): void
  className?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const text = description?.trim() || 'No description.'

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        className="relative w-full cursor-pointer text-left"
      >
        <p
          className={cn(
            'text-base whitespace-pre-line text-foreground/80 sm:text-sm',
            !expanded && 'line-clamp-3',
          )}
        >
          {text}
        </p>

        {/* The scrim sits over the last line while shut, and out of the way of
            the text once open, so the caret is always the thing you aim at. */}
        <span
          className={cn(
            'flex h-6 items-end justify-center',
            !expanded &&
              'absolute inset-x-0 bottom-0 bg-linear-to-b from-transparent to-background',
          )}
        >
          <ChevronDown
            className={cn(
              'size-4 text-muted-foreground',
              expanded && 'rotate-180',
            )}
          />
          <span className="sr-only">
            {expanded ? 'Collapse description' : 'Expand description'}
          </span>
        </span>
      </button>

      {genres && genres.length > 0 && (
        <div
          className={cn(
            'flex gap-1.5',
            expanded ? 'flex-wrap' : '-mx-2 overflow-x-auto px-2 pb-1',
          )}
        >
          {genres.map((genre) => (
            <TagChip
              key={genre}
              tag={genre}
              onBrowse={() => onBrowseTag(genre)}
              onCopy={() => onCopyTag(genre)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function TagChip({
  tag,
  onBrowse,
  onCopy,
}: {
  tag: string
  onBrowse(): void
  onCopy(): void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Badge
          asChild
          variant="secondary"
          className="h-6 shrink-0 cursor-pointer hover:bg-secondary/80"
        >
          <button type="button">{tag}</button>
        </Badge>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={onBrowse}>Browse this source</DropdownMenuItem>
        <DropdownMenuItem onSelect={onCopy}>Copy to clipboard</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
