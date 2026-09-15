import { ChevronDown, ChevronUp, RotateCcw, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { MAX_ATTEMPTS, TERMINAL_QUEUE_STATES } from '@/lib/download/queue-types'
import type { QueueItem } from '@/lib/download/queue-types'
import { cn } from '@/lib/utils'

import {
  QUEUE_STATE_LABELS,
  QUEUE_STATE_VARIANTS,
  pageLabel,
  progressRatio,
} from './format'

export interface QueueItemRowProps {
  item: QueueItem
  /** Place in the whole queue, not within the group. */
  index: number
  isFirst: boolean
  isLast: boolean
  busy: boolean
  disabled: boolean
  onRetry(): void
  onRemove(): void
  onMove(direction: -1 | 1): void
}

export function QueueItemRow({
  item,
  index,
  isFirst,
  isLast,
  busy,
  disabled,
  onRetry,
  onRemove,
  onMove,
}: QueueItemRowProps) {
  const meta = [pageLabel(item), attemptsLabel(item)].filter(
    (part): part is string => part !== null,
  )
  const retryable = item.state === 'failed' || item.state === 'cancelled'
  const showProgress = item.state === 'active' && item.pagesTotal > 0
  // A row that will never be picked up again has nothing to be ahead of.
  const reorderable = !TERMINAL_QUEUE_STATES.includes(item.state)

  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5">
      <span className="w-6 shrink-0 text-xs tabular-nums text-muted-foreground">
        {index + 1}
      </span>

      <div className="min-w-0 flex-1 space-y-1">
        <p
          className={cn(
            'truncate text-sm',
            item.state === 'done' && 'text-muted-foreground',
          )}
        >
          {item.chapterName}
        </p>

        {meta.length > 0 && (
          <p className="truncate text-xs text-muted-foreground">
            {meta.join(' · ')}
          </p>
        )}

        {showProgress && (
          <Progress
            value={progressRatio(item) * 100}
            aria-label={`Downloading ${item.chapterName}`}
            className="bg-secondary"
          />
        )}

        {item.lastError && item.state !== 'done' && (
          <p className="text-xs leading-relaxed text-destructive">
            {item.lastError}
          </p>
        )}
      </div>

      <Badge variant={QUEUE_STATE_VARIANTS[item.state]} className="shrink-0">
        {QUEUE_STATE_LABELS[item.state]}
      </Badge>

      <div className="flex shrink-0 items-center">
        {reorderable && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={disabled || busy || isFirst}
              title="Move up in the queue"
              aria-label={`Move ${item.chapterName} up in the queue`}
              onClick={() => onMove(-1)}
            >
              <ChevronUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={disabled || busy || isLast}
              title="Move down in the queue"
              aria-label={`Move ${item.chapterName} down in the queue`}
              onClick={() => onMove(1)}
            >
              <ChevronDown />
            </Button>
          </>
        )}

        {retryable && (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={disabled || busy}
            title="Try this chapter again"
            aria-label={`Retry ${item.chapterName}`}
            onClick={onRetry}
          >
            <RotateCcw />
          </Button>
        )}

        <Button
          variant="ghost"
          size="icon-sm"
          disabled={disabled || busy}
          title="Remove from the queue"
          aria-label={`Remove ${item.chapterName} from the queue`}
          onClick={onRemove}
        >
          <X />
        </Button>
      </div>
    </div>
  )
}

/** Only interesting once something has gone wrong at least once. */
function attemptsLabel(item: QueueItem): string | null {
  if (item.attempts <= 0) return null
  if (item.state === 'done') return null
  return `attempt ${Math.min(item.attempts + 1, MAX_ATTEMPTS)} of ${MAX_ATTEMPTS}`
}
