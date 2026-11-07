import { memo, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { ArrowRight, Check, History, RotateCcw } from 'lucide-react'

import { JournalFilters, filterRuns, formatDuration, journalMetrics, needsRetry, rangePhrase, useNow } from '@/components/generations/journal-filters'
import type { JournalFilter, JournalMetrics } from '@/components/generations/journal-filters'
import { stageLabels, targetLabel, useAdaptationRuns, useJournalSession } from '@/components/generations/journal-state'
import { ActionError, PendingLabel } from '@/components/generations/recording-controls'
import { ApplyConfirmation, replaySaved, useReplay } from '@/components/generations/retry-controls'
import { relativeTime } from '@/components/updates/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorPanel } from '@/components/ui/error-panel'
import { Skeleton } from '@/components/ui/skeleton'
import { summarize } from '@/lib/adapt/journal/helpers'
import type { GenerationSummary } from '@/lib/adapt/journal/types'

export const DEFAULT_JOURNAL_FILTER: JournalFilter = { range: '60', status: 'all', stage: 'all' }
/** Rows mounted at once; each keeps its own retry state, so the list never grows with the run count. */
const PAGE_SIZE = 20

export interface AdaptationJournal {
  runs: Pick<UseQueryResult<GenerationSummary[]>, 'isPending' | 'isError' | 'error' | 'refetch'>
  /** Every run for this adaptation. */
  all: GenerationSummary[]
  visible: GenerationSummary[]
  /** Ids of runs with a succeeded retry. */
  retried: Set<string | undefined>
  metrics: JournalMetrics
  /** Minute clock; each row re-renders only when its run or this changes, so times move once a minute. */
  now: number
}

/** This adaptation's journal, narrowed by the filter, with its metrics; the same object until one of them changes. */
export function useAdaptationJournal(adaptationId: string, filter: JournalFilter): AdaptationJournal {
  const { ready } = useJournalSession()
  const { data, isPending, isError, error, refetch } = useAdaptationRuns(adaptationId, ready)
  const now = useNow(60_000)
  return useMemo(() => {
    const all = data ?? []
    const visible = filterRuns(all, filter, now)
    const retried = new Set(all.filter((run) => run.parentId && run.status === 'succeeded').map((run) => run.parentId))
    return { runs: { isPending, isError, error, refetch }, all, visible, retried, metrics: journalMetrics(visible), now }
  }, [data, isPending, isError, error, refetch, filter, now])
}

export const ProgressJournal = memo(function ProgressJournal({
  journal,
  filter,
  onChange,
}: {
  journal: AdaptationJournal
  filter: JournalFilter
  onChange(patch: Partial<JournalFilter>): void
}) {
  const [application, setApplication] = useState<GenerationSummary | null>(null)
  const [paging, setPaging] = useState({ filter, page: 1 })
  const { runs, all, visible, retried, metrics, now } = journal
  const open = visible.filter((run) => needsRetry(run) && !retried.has(run.id))
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const page = Math.min(paging.filter === filter ? paging.page : 1, pages)
  const shown = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  return (
    <section id="progress-journal" aria-labelledby="progress-journal-title" className="flex min-w-0 scroll-mt-(--header-space) flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="progress-journal-title" className="text-base font-semibold">Journal</h2>
        <Button asChild variant="ghost" size="sm">
          <Link to="/generations">
            Open full journal
            <ArrowRight data-icon="inline-end" />
          </Link>
        </Button>
      </div>

      <JournalFilters id="progress-journal" filter={filter} onChange={onChange} />

      {runs.isPending ? (
        <div aria-busy="true" className="flex flex-col gap-2">
          <Skeleton className="h-5 w-2/3" />
          {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-16 w-full" />)}
        </div>
      ) : runs.isError ? (
        <ErrorPanel error={runs.error} onRetry={() => void runs.refetch()} />
      ) : all.length === 0 ? (
        <EmptyState icon={History} title="No generations yet" description="Each request shows here as drawing runs." />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={History}
          title={`Nothing${filter.chapter === undefined ? '' : ` for chapter ${filter.chapter}`} ${rangePhrase(filter.range)}`}
          description="Widen the time range or clear the filters."
          action={
            <Button type="button" variant="outline" onClick={() => onChange({ ...DEFAULT_JOURNAL_FILTER, chapter: undefined })}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
            {summary(metrics, filter)}
          </p>
          {open.length ? <RetryAll runs={open} onReview={setApplication} /> : null}
          <ol aria-label="Generations" className="flex flex-col divide-y rounded-lg border bg-card">
            {shown.map((run) => (
              <JournalRow key={run.id} run={run} retried={retried.has(run.id)} now={now} onReview={setApplication} />
            ))}
          </ol>
          {pages > 1 ? (
            <nav aria-label="Generation pages" className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
                {(page - 1) * PAGE_SIZE + 1}-{Math.min(page * PAGE_SIZE, visible.length)} of {visible.length}
              </p>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" disabled={page === 1} onClick={() => setPaging({ filter, page: page - 1 })}>
                  Previous page
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={page === pages} onClick={() => setPaging({ filter, page: page + 1 })}>
                  Next page
                </Button>
              </div>
            </nav>
          ) : null}
        </div>
      )}

      <ApplyConfirmation key={application?.id ?? 'closed'} run={application} onClose={() => setApplication(null)} />
    </section>
  )
})

function summary(metrics: JournalMetrics, filter: JournalFilter): string {
  const scope = filter.chapter === undefined ? '' : ` for chapter ${filter.chapter}`
  const parts = [`${metrics.done} done`, `${metrics.retry} failed`]
  if (metrics.running) parts.push(`${metrics.running} running`)
  return `${metrics.total}${scope} ${rangePhrase(filter.range)}: ${parts.join(', ')}`
}

/** Failures in a row before a batch retry stops; past this the cause is shared, not bad luck. */
const RETRY_FAILURE_LIMIT = 3

function RetryAll({ runs, onReview }: { runs: readonly GenerationSummary[]; onReview(run: GenerationSummary): void }) {
  const controller = useRef<AbortController | null>(null)
  const [progress, setProgress] = useState(0)
  const retry = useMutation({
    mutationFn: async (targets: readonly GenerationSummary[]) => {
      controller.current = new AbortController()
      const results: GenerationSummary[] = []
      let failuresInRow = 0
      try {
        for (const [index, run] of targets.entries()) {
          setProgress(index + 1)
          const result = summarize(await replaySaved({ run }, controller.current.signal))
          results.push(result)
          failuresInRow = result.status === 'succeeded' ? 0 : failuresInRow + 1
          if (failuresInRow >= RETRY_FAILURE_LIMIT) {
            throw new Error(`Stopped after ${RETRY_FAILURE_LIMIT} failures in a row: ${result.error ?? 'no reason given'}`)
          }
        }
      } finally {
        controller.current = null
      }
      return results
    },
  })
  const succeeded = retry.data?.filter((run) => run.status === 'succeeded') ?? []

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm tabular-nums">
          {runs.length} failed or interrupted. Retrying reuses the saved request.
        </p>
        {retry.isPending ? (
          <Button type="button" variant="outline" size="sm" onClick={() => controller.current?.abort()}>
            Cancel
          </Button>
        ) : null}
        <Button type="button" size="sm" disabled={retry.isPending} onClick={() => retry.mutate(runs)}>
          <RotateCcw data-icon="inline-start" />
          <span className="tabular-nums">{retry.isPending ? `Retrying ${progress} of ${retry.variables.length}` : 'Retry all'}</span>
        </Button>
      </div>
      <ActionError title="Retry stopped" error={retry.error} />
      {retry.isSuccess ? (
        <p role="status" className="text-sm tabular-nums">
          {succeeded.length} of {retry.data.length} retries succeeded.
          {succeeded.length ? ' Review each one to replace the original.' : ''}
        </p>
      ) : null}
      {succeeded.length === 1 ? (
        <div className="flex">
          <Button type="button" variant="outline" size="sm" onClick={() => onReview(succeeded[0])}>
            Review replacement
          </Button>
        </div>
      ) : null}
    </div>
  )
}

const JournalRow = memo(function JournalRow({ run, retried, now, onReview }: { run: GenerationSummary; retried: boolean; now: number; onReview(run: GenerationSummary): void }) {
  const { replay } = useReplay()
  const running = run.status === 'running'
  const failed = needsRetry(run)
  const finished = run.finishedAt ?? (running ? Math.max(now, run.updatedAt) : run.updatedAt)
  const meta = [
    run.model,
    run.attempts > 1 ? `${run.attempts} tries` : null,
    `${formatDuration(finished - run.createdAt)}${running ? ' so far' : ''}`,
  ]
    .filter(Boolean)
    .join(' · ')
  const reviewable = run.status === 'succeeded' && run.parentId && run.target && !run.appliedAt

  return (
    <li className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-start sm:gap-3">
      <time
        dateTime={new Date(run.createdAt).toISOString()}
        title={new Date(run.createdAt).toLocaleString()}
        className="shrink-0 text-xs text-muted-foreground tabular-nums sm:w-24 sm:pt-0.5"
      >
        {relativeTime(run.createdAt)}
      </time>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Link
          to="/generations/$generationId"
          params={{ generationId: run.id }}
          className="min-w-0 truncate text-sm underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span className="font-medium">{stageLabels[run.stage]}</span>{' '}
          <span className="text-muted-foreground tabular-nums">{targetLabel(run)}</span>
        </Link>
        <p className="truncate text-xs text-muted-foreground tabular-nums">{meta}</p>
        {failed && run.error ? <p className="text-sm text-pretty break-words text-destructive">{run.error}</p> : null}
        <ActionError title="Retry failed" error={replay.error} />
        {replay.isSuccess && replay.data.status !== 'succeeded' ? (
          <p role="status" className="text-sm text-destructive">The retry did not succeed. Open it to see why.</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end">
        {running ? (
          <span className="flex items-center gap-1.5 text-xs font-medium">
            <span aria-hidden className="size-2 rounded-full bg-primary motion-safe:animate-pulse" />
            Running
          </span>
        ) : failed ? (
          <Badge variant="destructive">{run.status === 'failed' ? 'Failed' : 'Interrupted'}</Badge>
        ) : run.status === 'succeeded' ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Check aria-hidden className="size-3.5" />
            {run.appliedAt ? 'Applied' : 'Done'}
          </span>
        ) : (
          <Badge variant="secondary">Cancelled</Badge>
        )}
        {failed && retried ? <span className="text-xs text-muted-foreground">Retried</span> : null}
        {failed && !retried ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={replay.isPending}
            onClick={() =>
              replay.mutate({ run }, { onSuccess: (result) => { if (result.status === 'succeeded') onReview(result) } })
            }
          >
            <RotateCcw data-icon="inline-start" />
            <PendingLabel pending={replay.isPending}>Retry</PendingLabel>
          </Button>
        ) : null}
        {reviewable ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onReview(run)}>
            Review
          </Button>
        ) : null}
      </div>
    </li>
  )
})
