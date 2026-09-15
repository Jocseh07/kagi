import type { ReactNode } from 'react'
import { CircleCheck, RefreshCw, TriangleAlert, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type {
  SkipCounts,
  UpdatePreview,
  UpdateRuntimeState,
  UpdateSummary,
} from '@/lib/updates/update-manager'

import { relativeTime } from './format'

export interface UpdateRunnerProps {
  runtime: UpdateRuntimeState
  disabled: boolean
  /** Shown instead of the idle line when the check cannot be started. */
  unavailable: string | null
  lastRunAt: number | null
  /** What the check would cover; `null` while it is being read. */
  preview: UpdatePreview | null
  /** The configured interval has elapsed since the last check. */
  due: boolean
  /** Control that picks which categories the check covers. */
  scope: ReactNode
  onRun(): void
  onCancel(): void
  onDismiss(): void
  /** Re-checks only the series that failed. */
  onRetry(mangaIds: readonly string[]): void
}

export function UpdateRunner({
  runtime,
  disabled,
  unavailable,
  lastRunAt,
  preview,
  due,
  scope,
  onRun,
  onCancel,
  onDismiss,
  onRetry,
}: UpdateRunnerProps) {
  const running = runtime.status === 'running'
  const nothingToCheck = preview !== null && preview.planned === 0

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">
            {running
              ? progressTitle(runtime)
              : due
                ? 'Check due'
                : 'Check favourites for new chapters'}
          </p>
          {!running && (
            <p className="text-xs text-muted-foreground">
              {unavailable ??
                (lastRunAt
                  ? `Last checked ${relativeTime(lastRunAt)}.`
                  : 'Never checked on this device.')}
            </p>
          )}
          {!running && !unavailable && preview && (
            <p className="text-xs text-muted-foreground">
              {previewLine(preview)}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!running && scope}
          {running ? (
            <Button variant="outline" size="sm" onClick={onCancel}>
              <X />
              Cancel
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={disabled || nothingToCheck}
              onClick={onRun}
            >
              <RefreshCw />
              Check for updates
            </Button>
          )}
        </div>
      </div>

      {running && <ProgressBar completed={runtime.completed} total={runtime.total} />}

      {running && runtime.current.length > 0 && (
        <p className="truncate text-xs text-muted-foreground">
          {inFlightLine(runtime.current)}
        </p>
      )}

      {running && runtime.newChapters > 0 && (
        <p className="text-xs text-muted-foreground">
          {chapterCount(runtime.newChapters)} so far.
        </p>
      )}

      {runtime.summary && !running && (
        <SummaryPanel
          summary={runtime.summary}
          onDismiss={onDismiss}
          onRetry={onRetry}
        />
      )}
    </section>
  )
}

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  // An indeterminate-looking sliver until the plan is known, rather than 0%.
  const ratio = total > 0 ? completed / total : 0

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total || 1}
      aria-valuenow={completed}
      className="h-1.5 w-full overflow-hidden rounded-4xl bg-secondary"
    >
      <div
        className="h-full rounded-4xl bg-primary transition-[width] duration-300"
        style={{ width: `${Math.min(100, Math.max(3, ratio * 100))}%` }}
      />
    </div>
  )
}

function SummaryPanel({
  summary,
  onDismiss,
  onRetry,
}: {
  summary: UpdateSummary
  onDismiss(): void
  onRetry(mangaIds: readonly string[]): void
}) {
  const retryable = failedIds(summary)
  const failed = retryable.length > 0
  const skipped = totalSkipped(summary.skipped)

  if (summary.error) {
    return (
      <Panel tone="error" onDismiss={onDismiss}>
        <p className="text-xs font-medium text-destructive">
          The check could not start
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {summary.error}
        </p>
      </Panel>
    )
  }

  return (
    <Panel tone={failed ? 'error' : 'neutral'} onDismiss={onDismiss}>
      <p className="text-xs font-medium">{headline(summary)}</p>

      {skipped > 0 && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {skipped} skipped by your rules ({skipReasons(summary.skipped)}).
        </p>
      )}

      {failed && (
        <>
          <ul className="space-y-1">
            {groupFailures(summary).map((group) => (
              <li key={group.key} className="text-xs leading-relaxed">
                <span className="text-destructive">{group.sourceName}</span>
                <span className="text-muted-foreground">
                  {' — '}
                  {group.message}
                  {group.count > 1 && ` (${group.count} series)`}
                  {group.count === 1 && `: ${group.titles[0]}`}
                </span>
              </li>
            ))}
          </ul>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onRetry(retryable)}
          >
            <RefreshCw />
            Retry {retryable.length} series
          </Button>
        </>
      )}
    </Panel>
  )
}

function Panel({
  tone,
  onDismiss,
  children,
}: {
  tone: 'neutral' | 'error'
  onDismiss(): void
  children: ReactNode
}) {
  return (
    <div
      className={
        tone === 'error'
          ? 'flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5'
          : 'flex items-start gap-2 rounded-lg border border-border bg-background p-2.5'
      }
    >
      {tone === 'error' ? (
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      ) : (
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-primary" />
      )}
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
      >
        Dismiss
      </button>
    </div>
  )
}

function previewLine(preview: UpdatePreview): string {
  const skipped = totalSkipped(preview.skipped)
  if (preview.planned === 0) {
    return skipped > 0
      ? `Nothing to check: ${skipped} skipped by your rules.`
      : 'Nothing to check.'
  }
  const series = `${preview.planned} series to check`
  return skipped > 0
    ? `${series}, ${skipped} skipped by your rules.`
    : `${series}.`
}

/**
 * What is being checked right now.
 *
 * Several series move at once — the run checks each source in parallel — so the
 * count alone makes a working sweep look stuck on one number. Two titles and a
 * remainder, because the full list churns faster than it can be read.
 */
function inFlightLine(current: readonly string[]): string {
  const shown = current.slice(0, 2).join(', ')
  const rest = current.length - 2
  return rest > 0 ? `${shown} and ${rest} more` : shown
}

/** One entry per series, deduplicated: a retry checks each series once. */
function failedIds(summary: UpdateSummary): string[] {
  return [...new Set(summary.failures.map((failure) => failure.mangaId))]
}

function progressTitle(runtime: UpdateRuntimeState): string {
  if (runtime.total === 0) return 'Checking for updates…'
  const position = Math.min(runtime.completed + 1, runtime.total)
  return `Checking ${position} of ${runtime.total}…`
}

function headline(summary: UpdateSummary): string {
  const parts = [
    `${summary.checked} series checked`,
    summary.newChapters > 0
      ? `${chapterCount(summary.newChapters)} in ${summary.seriesUpdated} series`
      : 'no new chapters',
  ]
  if (summary.failures.length > 0) parts.push(`${summary.failures.length} failed`)

  const line = parts.join(', ')
  return summary.cancelled ? `Cancelled — ${line}` : line
}

function chapterCount(count: number): string {
  return `${count} new chapter${count === 1 ? '' : 's'}`
}

function totalSkipped(skipped: SkipCounts): number {
  return skipped.unread + skipped['not-started'] + skipped.completed
}

function skipReasons(skipped: SkipCounts): string {
  const parts = [
    skipped.unread > 0 ? `${skipped.unread} with unread chapters` : null,
    skipped['not-started'] > 0 ? `${skipped['not-started']} not started` : null,
    skipped.completed > 0 ? `${skipped.completed} completed` : null,
  ].filter((part): part is string => part !== null)
  return parts.join(', ')
}

interface FailureGroup {
  key: string
  sourceName: string
  message: string
  count: number
  titles: string[]
}

/**
 * One line per source and reason. A source that is down fails every one of its
 * series with the same message, and a list of forty identical lines tells the
 * reader less than one line saying so.
 */
function groupFailures(summary: UpdateSummary): FailureGroup[] {
  const groups = new Map<string, FailureGroup>()

  for (const failure of summary.failures) {
    const key = `${failure.sourceName} ${failure.message}`
    const existing = groups.get(key)
    if (existing) {
      existing.count += 1
      existing.titles.push(failure.title)
      continue
    }
    groups.set(key, {
      key,
      sourceName: failure.sourceName,
      message: failure.message,
      count: 1,
      titles: [failure.title],
    })
  }

  return [...groups.values()]
}
