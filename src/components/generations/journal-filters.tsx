import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

import { stageLabels, statusLabels } from '@/components/generations/journal-state'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { GenerationSummary } from '@/lib/adapt/journal/types'

export const TIME_RANGES = ['5', '15', '60', '1440', 'all'] as const
export type TimeRange = (typeof TIME_RANGES)[number]

const rangeLabels: Record<TimeRange, string> = { '5': '5 min', '15': '15 min', '60': '1 hour', '1440': '24 hours', all: 'All' }

const rangePhrases: Record<TimeRange, string> = {
  '5': 'in the last 5 minutes',
  '15': 'in the last 15 minutes',
  '60': 'in the last hour',
  '1440': 'in the last 24 hours',
  all: 'in total',
}

export function rangePhrase(range: TimeRange): string {
  return rangePhrases[range]
}

export interface JournalFilter {
  range: TimeRange
  /** A `GenerationStatus`, `retry` for failed or interrupted, `proposals`, or `all`. */
  status: string
  stage: string
  chapter?: number
  adaptationId?: string
}

export function needsRetry(run: GenerationSummary): boolean {
  return run.status === 'failed' || run.status === 'interrupted'
}

export function filterRuns<T extends GenerationSummary>(runs: readonly T[], filter: JournalFilter, now: number): T[] {
  const since = filter.range === 'all' ? -Infinity : now - Number(filter.range) * 60_000
  return runs.filter((run) =>
    run.createdAt >= since &&
    (filter.status === 'all' ||
      run.status === filter.status ||
      (filter.status === 'retry' && needsRetry(run)) ||
      (filter.status === 'proposals' && run.applicationRequested && !run.appliedAt)) &&
    (filter.stage === 'all' || run.stage === filter.stage) &&
    (filter.chapter === undefined || run.target?.chapter === filter.chapter) &&
    (filter.adaptationId === undefined || run.target?.adaptationId === filter.adaptationId),
  )
}

export interface JournalMetrics {
  total: number
  done: number
  retry: number
  running: number
  /** Mean duration of succeeded runs, or null when none finished. */
  averageMs: number | null
}

export function journalMetrics(runs: readonly GenerationSummary[]): JournalMetrics {
  let done = 0
  let retry = 0
  let running = 0
  let spent = 0
  for (const run of runs) {
    if (run.status === 'running') running++
    else if (needsRetry(run)) retry++
    else if (run.status === 'succeeded') {
      done++
      spent += (run.finishedAt ?? run.updatedAt) - run.createdAt
    }
  }
  return { total: runs.length, done, retry, running, averageMs: done ? spent / done : null }
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

export function JournalFilters({
  id,
  filter,
  onChange,
}: {
  id: string
  filter: JournalFilter
  onChange(patch: Partial<JournalFilter>): void
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="-m-1 overflow-x-auto p-1">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-label="Time range"
          value={filter.range}
          onValueChange={(value) => {
            if (value) onChange({ range: value as TimeRange })
          }}
        >
          {TIME_RANGES.map((range) => (
            <ToggleGroupItem key={range} value={range}>
              {rangeLabels[range]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-2">
        <Field>
          <FieldLabel htmlFor={`${id}-status`} className="sr-only">Status</FieldLabel>
          <NativeSelect id={`${id}-status`} name={`${id}-status`} value={filter.status} onChange={(event) => onChange({ status: event.target.value })}>
            <NativeSelectOption value="all">All statuses</NativeSelectOption>
            <NativeSelectOption value="retry">Needs a retry</NativeSelectOption>
            {Object.entries(statusLabels).map(([value, label]) => (
              <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>
            ))}
            <NativeSelectOption value="proposals">Awaiting approval</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-stage`} className="sr-only">Stage</FieldLabel>
          <NativeSelect id={`${id}-stage`} name={`${id}-stage`} value={filter.stage} onChange={(event) => onChange({ stage: event.target.value })}>
            <NativeSelectOption value="all">All stages</NativeSelectOption>
            {Object.entries(stageLabels).map(([value, label]) => (
              <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>
      {filter.chapter !== undefined ? (
        <div className="flex">
          <Button type="button" variant="outline" size="sm" aria-label={`Clear chapter ${filter.chapter} filter`} onClick={() => onChange({ chapter: undefined })}>
            <span className="tabular-nums">Chapter {filter.chapter}</span>
            <X data-icon="inline-end" />
          </Button>
        </div>
      ) : null}
    </div>
  )
}
