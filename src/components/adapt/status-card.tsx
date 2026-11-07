import { memo } from 'react'
import type { ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Pause, Play, RotateCcw } from 'lucide-react'

import { relativeTime } from '@/components/updates/format'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { caughtUp, hasNoText, waitsAtStopPoint } from '@/lib/adapt/flow'
import { formatDuration, rangePhrase } from '@/components/generations/journal-filters'
import type { TimeRange } from '@/components/generations/journal-filters'
import { useDrawingCount } from '@/lib/adapt/live'
import { isBusy, pauseAdaptation, resumeAdaptation, useAdaptActivity } from '@/lib/adapt/pipeline'
import type { AdaptActivity } from '@/lib/adapt/pipeline'
import type { Adaptation, MangaChapter } from '@/lib/adapt/store'
import { cn } from '@/lib/utils'

/** Expects ascending numbers, as the activity publishes them. */
function chapterLabel(numbers: readonly number[]): string {
  if (numbers.length === 1) return `chapter ${numbers[0]}`
  const first = numbers[0]
  const last = numbers[numbers.length - 1]
  if (last - first === numbers.length - 1) return `chapters ${first} to ${last}`
  return `chapters ${numbers.slice(0, -1).join(', ')} and ${last}`
}

/** One line per busy lane, most visible work first. */
function laneLines(activity: AdaptActivity): string[] {
  const lines: string[] = []
  if (activity.cast) lines.push(`Drawing sheets, ${activity.cast.done} of ${activity.cast.total}`)
  if (activity.redrawing.length) lines.push(`Redrawing pages in ${chapterLabel(activity.redrawing)}`)
  if (activity.drawing.length) lines.push(`Drawing ${chapterLabel(activity.drawing)}`)
  if (activity.scripting.length) {
    lines.push(
      activity.scripting.length > 1
        ? `Writing scripts for ${chapterLabel(activity.scripting)}`
        : `Writing the script for ${chapterLabel(activity.scripting)}`,
    )
  }
  if (activity.reading) lines.push(`Reading novel chapters ${activity.reading[0]} to ${activity.reading[1]}`)
  return lines
}

export const StatusCard = memo(function StatusCard({
  adaptation,
  chapters,
  averageMs,
  range,
  keepGoing,
}: {
  adaptation: Adaptation
  chapters: readonly MangaChapter[]
  /** Mean generation time over the journal filter. */
  averageMs: number | null
  range: TimeRange
  /** Moves the stop point; shown while drawing waits at it. */
  keepGoing?: ReactNode
}) {
  const activity = useAdaptActivity(adaptation.id)
  const drawingNow = useDrawingCount(adaptation.id)
  const pause = useMutation({ mutationFn: () => pauseAdaptation(adaptation.id) })
  const resume = useMutation({ mutationFn: () => resumeAdaptation(adaptation.id) })

  const strip = <Stats adaptation={adaptation} chapters={chapters} panels={activity.panels} averageMs={averageMs} range={range} />

  if (adaptation.status === 'stopped') {
    return (
      <Panel tone="error" title={stoppedTitle(chapters)} detail={adaptation.error ?? undefined}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/settings" search={{ tab: 'adapt', billing: undefined }}>
                Settings
              </Link>
            </Button>
            <Button onClick={() => resume.mutate()} disabled={resume.isPending}>
              <RotateCcw data-icon="inline-start" />
              Retry
            </Button>
          </>
        }
      >
        {strip}
      </Panel>
    )
  }

  if (adaptation.status === 'paused') {
    return (
      <Panel
        title="Paused"
        actions={
          <Button onClick={() => resume.mutate()} disabled={resume.isPending}>
            <Play data-icon="inline-start" />
            Resume
          </Button>
        }
      >
        {strip}
      </Panel>
    )
  }

  const pauseButton = (
    <Button variant="outline" onClick={() => pause.mutate()} disabled={pause.isPending}>
      <Pause data-icon="inline-start" />
      Pause
    </Button>
  )

  if (isBusy(activity)) {
    const [title, ...others] = laneLines(activity)
    const panels = activity.drawing.length > 0 || activity.redrawing.length > 0
    const { done, total } = activity.panels
    const progressLine = panels && total ? `${done} of ${total} panels · ${Math.max(0, total - done - drawingNow)} waiting` : null
    const detail = [progressLine, ...others].filter(Boolean).join(' · ') || undefined
    return (
      <Panel
        title={title}
        detail={detail}
        progress={panels && total ? Math.round((done / total) * 100) : null}
        live
        actions={pauseButton}
      >
        {strip}
      </Panel>
    )
  }

  const stopped = chapters.find((chapter) => chapter.status === 'stopped')
  if (stopped) {
    return (
      <Panel tone="error" title={stoppedTitle(chapters)} detail={stopped.error ?? undefined}
        actions={
          <Button onClick={() => resume.mutate()} disabled={resume.isPending}>
            <RotateCcw data-icon="inline-start" />
            Retry
          </Button>
        }
      >
        {strip}
      </Panel>
    )
  }

  if (waitsAtStopPoint(adaptation, chapters) && adaptation.stopAt !== undefined) {
    const left = adaptation.novelChapterCount - adaptation.stopAt
    return (
      <Panel
        title={`Stopped at chapter ${adaptation.stopAt}`}
        detail={`${left} more ${left === 1 ? 'chapter' : 'chapters'} in the novel`}
        actions={keepGoing}
      >
        {strip}
      </Panel>
    )
  }

  if (caughtUp(adaptation, chapters)) {
    if (hasNoText(adaptation, chapters)) {
      return (
        <Panel tone="error" title="No text to adapt" detail="Every chapter of this novel is empty. Import the file again with its text.">
          {strip}
        </Panel>
      )
    }
    return (
      <Panel title="Caught up with the novel" detail={`Checked ${relativeTime(adaptation.checkedAt)}`}>
        {strip}
      </Panel>
    )
  }

  return (
    <Panel title="Waiting to draw" actions={pauseButton}>
      {strip}
    </Panel>
  )
})

function stoppedTitle(chapters: readonly MangaChapter[]): string {
  const stopped = chapters.find((chapter) => chapter.status === 'stopped')
  return stopped ? `Drawing stopped on chapter ${stopped.number}` : 'Drawing stopped'
}

function Panel({
  title,
  detail,
  tone = 'default',
  live = false,
  progress = null,
  actions,
  children,
}: {
  title: string
  detail?: string
  tone?: 'default' | 'error'
  live?: boolean
  progress?: number | null
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <section
      className={cn(
        '@container flex flex-col gap-4 rounded-lg border p-4',
        tone === 'error' ? 'border-destructive/40 bg-destructive/10' : 'border-border bg-card',
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div role={tone === 'error' ? 'alert' : 'status'} className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            {live ? <span aria-hidden className="size-2 shrink-0 rounded-full bg-foreground motion-safe:animate-pulse" /> : null}
            {title}
          </h2>
          {detail ? <p className="mt-1 text-sm text-pretty text-muted-foreground tabular-nums">{detail}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {progress !== null ? <Progress value={progress} aria-label="Panels drawn" /> : null}
      {children}
    </section>
  )
}

const Stats = memo(function Stats({
  adaptation,
  chapters,
  panels,
  averageMs,
  range,
}: {
  adaptation: Adaptation
  chapters: readonly MangaChapter[]
  panels: AdaptActivity['panels']
  averageMs: number | null
  range: TimeRange
}) {
  const { done, total } = panels
  const drawn = chapters.filter((chapter) => chapter.status === 'drawn').length
  return (
    <dl className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
      <Stat label="Panels">
        {total ? <>{done} of {total} <Muted>· {total - done} to go</Muted></> : <Muted>None drawing</Muted>}
      </Stat>
      <Stat label="Chapters drawn">{drawn} of {chapters.length}</Stat>
      <Stat label="Novel read">
        {Math.min(adaptation.readThrough, adaptation.novelChapterCount)} of {adaptation.novelChapterCount} <Muted>chapters</Muted>
      </Stat>
      <Stat label="Average time">
        {averageMs === null ? <Muted>None {rangePhrase(range)}</Muted> : <>{formatDuration(averageMs)} <Muted>{rangePhrase(range)}</Muted></>}
      </Stat>
    </dl>
  )
})

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">{children}</dd>
    </div>
  )
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="font-normal text-muted-foreground">{children}</span>
}
