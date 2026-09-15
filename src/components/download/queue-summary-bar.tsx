import { useState } from 'react'
import { Pause, Play, Trash2, TriangleAlert } from 'lucide-react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import type { QueueRuntimeState } from '@/lib/download/queue-manager'
import { PENDING_QUEUE_STATES, TERMINAL_QUEUE_STATES } from '@/lib/download/queue-types'
import type { QueueSummary } from '@/lib/download/queue-types'

import { formatBytes } from './format'

export interface QueueSummaryBarProps {
  summary: QueueSummary
  runtime: QueueRuntimeState
  busy: boolean
  disabled: boolean
  onPause(): void
  onResume(): void
  onClearFinished(): void
  onClearAll(): void
}

export function QueueSummaryBar({
  summary,
  runtime,
  busy,
  disabled,
  onPause,
  onResume,
  onClearFinished,
  onClearAll,
}: QueueSummaryBarProps) {
  const [confirmingClearAll, setConfirmingClearAll] = useState(false)
  const { counts } = summary

  const pending = PENDING_QUEUE_STATES.reduce(
    (total, state) => total + counts[state],
    0,
  )
  const finished = TERMINAL_QUEUE_STATES.reduce(
    (total, state) => total + counts[state],
    0,
  )
  const running = counts.queued + counts.active > 0

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">{countsLine(summary)}</p>
          <p className="text-xs text-muted-foreground">
            {pending > 0
              ? `About ${formatBytes(summary.projectedBytes)} of storage once the ${pending === 1 ? 'chapter is' : `${pending} chapters are`} saved`
              : 'Nothing left to download.'}
            {' · '}
            {statusLine(runtime)}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {running && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || disabled}
              onClick={onPause}
            >
              <Pause />
              Pause all
            </Button>
          )}

          {(counts.paused > 0 || runtime.status === 'halted') && (
            <Button size="sm" disabled={busy || disabled} onClick={onResume}>
              <Play />
              Resume
            </Button>
          )}

          {finished > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || disabled}
              onClick={onClearFinished}
            >
              Clear finished
            </Button>
          )}

          {summary.total > 0 && (
            <Button
              variant="destructive"
              size="sm"
              disabled={busy || disabled}
              onClick={() => setConfirmingClearAll(true)}
            >
              <Trash2 />
              Clear all
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmingClearAll}
        onOpenChange={setConfirmingClearAll}
        title="Clear the download queue?"
        description={`All ${summary.total} items leave the queue, including the ones still downloading. Chapters already saved stay saved.`}
        confirmLabel="Clear all"
        onConfirm={() => {
          setConfirmingClearAll(false)
          onClearAll()
        }}
      />

      {runtime.halt && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0 space-y-0.5">
            <p className="text-xs font-medium text-destructive">
              {runtime.halt.reason === 'quota'
                ? 'Downloads stopped: out of storage'
                : 'Downloads stopped: the library database is unavailable'}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {runtime.halt.message}
              {runtime.halt.reason === 'quota' &&
                ' The rest of the queue was paused rather than run into the same wall — free some space, then resume.'}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function countsLine(summary: QueueSummary): string {
  if (summary.total === 0) return 'Queue empty'
  const { counts } = summary
  const parts = [
    counts.active > 0 ? `${counts.active} downloading` : null,
    counts.queued > 0 ? `${counts.queued} queued` : null,
    counts.paused > 0 ? `${counts.paused} paused` : null,
    counts.done > 0 ? `${counts.done} saved` : null,
    counts.failed > 0 ? `${counts.failed} failed` : null,
    counts.cancelled > 0 ? `${counts.cancelled} cancelled` : null,
  ].filter((part): part is string => part !== null)
  return parts.join(' · ')
}

function statusLine(runtime: QueueRuntimeState): string {
  if (runtime.status === 'halted') return 'Stopped'
  if (runtime.status === 'suspended') return 'Resuming'
  if (runtime.status === 'running') {
    return runtime.activeItemIds.length > 0 ? 'Running' : 'Waiting for work'
  }
  return 'Idle'
}
