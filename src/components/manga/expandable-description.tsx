import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
 * A long synopsis printed in full pushes the chapter list below the fold, so
 * it is clamped to three lines with a More toggle underneath.
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
      <div className="flex flex-col items-start gap-1">
        <p
          className={cn(
            'text-base whitespace-pre-line text-foreground/80 sm:text-sm',
            !expanded && 'line-clamp-3',
          )}
        >
          {text}
        </p>
        <Button
          variant="link"
          size="sm"
          className="h-auto px-0"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? 'Less' : 'More'}
          <ChevronDown
            data-icon="inline-end"
            className={cn('transition-transform motion-reduce:transition-none', expanded && 'rotate-180')}
          />
        </Button>
      </div>

      {genres && genres.length > 0 && (
        <div
          className={cn(
            'flex gap-1.5',
            expanded ? 'flex-wrap' : '-mx-2 -mt-1 overflow-x-auto px-2 pt-1 pb-1',
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
