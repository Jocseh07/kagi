import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { BookOpen, ChevronDown, Flag, Image } from 'lucide-react'

import { DrawRangeDialog, StopPointDialog } from '@/components/adapt/chapter-controls'
import { FlowSteps } from '@/components/adapt/flow-steps'
import { FixPanelButton, KeepPanelButton, PanelImage, RedrawDialog } from '@/components/adapt/panel-tools'
import { DEFAULT_JOURNAL_FILTER, ProgressJournal, useAdaptationJournal } from '@/components/adapt/progress-journal'
import { ScriptDialog } from '@/components/adapt/script-dialog'
import { StatusCard } from '@/components/adapt/status-card'
import { FoldRow } from '@/components/fold-row'
import type { JournalFilter } from '@/components/generations/journal-filters'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { caughtUp, chapterFlow, flaggedPanels, hasNoText, novelRange, planLimit, waitingDetail, waitsAtStopPoint } from '@/lib/adapt/flow'
import type { FlaggedPanel } from '@/lib/adapt/flow'
import { useAdaptActivity } from '@/lib/adapt/pipeline'
import type { AdaptActivity } from '@/lib/adapt/pipeline'
import type { Adaptation, Character, MangaChapter } from '@/lib/adapt/store'
import { useChapterProgress } from '@/lib/adapt/use-adaptation'
import type { ChapterProgress } from '@/lib/adapt/use-adaptation'
import { ADAPTED_SOURCE_ID } from '@/lib/sources/adapted'
import { sourceCatalog } from '@/lib/sources/catalog'

/** Shorter runs of drawn chapters stay unfolded, as on the Read tab. */
const MIN_DRAWN_RUN = 3
/** Page rows listed at once; a long chapter steps through its pages instead of mounting all of them. */
const PAGE_WINDOW = 20
const NO_PANELS: AdaptActivity['panels'] = { done: 0, total: 0 }

function Chevron() {
  return (
    <ChevronDown
      aria-hidden
      className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none"
    />
  )
}

export const ChaptersTab = memo(function ChaptersTab({
  adaptation,
  characters,
  chapters,
  selected,
}: {
  adaptation: Adaptation
  characters: readonly Character[]
  chapters: readonly MangaChapter[]
  /** A chapter another tab asked to open. */
  selected: number | undefined
}) {
  const activity = useAdaptActivity(adaptation.id)
  const { reading, scripting, text, drawing, redrawing, cast } = activity
  // Rows never read the panel count, which ticks with every panel; leaving it out keeps them still while drawing.
  const rowActivity = useMemo<AdaptActivity>(
    () => ({ reading, scripting, text, drawing, redrawing, cast, panels: NO_PANELS }),
    [reading, scripting, text, drawing, redrawing, cast],
  )
  const [filter, setFilter] = useState<JournalFilter>(DEFAULT_JOURNAL_FILTER)
  const journal = useAdaptationJournal(adaptation.id, filter)
  const flagged = useMemo(() => flaggedPanels(chapters), [chapters])
  const sourceName = sourceCatalog.find((entry) => entry.id === adaptation.sourceId)?.name ?? adaptation.sourceId
  const remaining = adaptation.novelChapterCount - planLimit(adaptation)
  const stopPointLabel = remaining > 0 ? 'Keep going' : 'Stop point'
  const stopPoint = useMemo(
    () => <StopPointDialog adaptation={adaptation} chapters={chapters} label={stopPointLabel} />,
    [adaptation, chapters, stopPointLabel],
  )
  const waiting = waitsAtStopPoint(adaptation, chapters)
  const noText = caughtUp(adaptation, chapters) && hasNoText(adaptation, chapters)
  const firstOpen = chapters.findIndex((chapter) => chapter.status !== 'drawn')
  const drawnRun = firstOpen === -1 ? chapters.length : firstOpen
  const folded = drawnRun >= MIN_DRAWN_RUN ? chapters.slice(0, drawnRun) : []
  const rest = chapters.slice(folded.length)

  const showInJournal = useCallback((chapter: number) => {
    setFilter((current) => ({ ...current, chapter, range: 'all' }))
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.getElementById('progress-journal')?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  }, [])
  const changeFilter = useCallback((patch: Partial<JournalFilter>) => setFilter((current) => ({ ...current, ...patch })), [])
  const row = (chapter: MangaChapter) => (
    <ChapterRow
      key={chapter.id}
      adaptation={adaptation}
      characters={characters}
      chapter={chapter}
      activity={rowActivity}
      flagged={flagged.filter((item) => item.chapter.number === chapter.number).length}
      selected={chapter.number === selected}
      onShowInJournal={showInJournal}
    />
  )

  return (
    <div className="flex flex-col gap-4">
      <StatusCard
        adaptation={adaptation}
        chapters={chapters}
        averageMs={journal.metrics.averageMs}
        range={filter.range}
        keepGoing={stopPoint}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-7">
          <ProgressJournal journal={journal} filter={filter} onChange={changeFilter} />
        </div>

        <section
          aria-labelledby="progress-chapters-title"
          className="-m-1 flex min-w-0 flex-col gap-3 p-1 lg:sticky lg:top-(--header-space) lg:col-span-5 lg:max-h-(--panel-max-height) lg:self-start lg:overflow-y-auto"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="progress-chapters-title" className="text-base font-semibold">Chapters</h2>
            {chapters.length ? <DrawRangeDialog adaptation={adaptation} chapters={chapters} /> : null}
          </div>
          {adaptation.skipped.length ? (
            <p className="text-sm text-muted-foreground tabular-nums">Skipped novel chapters {adaptation.skipped.join(', ')}</p>
          ) : null}

          {flagged.length ? <ChecksList adaptation={adaptation} flagged={flagged} /> : null}

          {chapters.length ? (
            <ol aria-label="Manga chapters" className="flex flex-col divide-y overflow-hidden rounded-lg ring-1 ring-border">
              {folded.length ? (
                <DrawnFold chapters={folded} opened={folded.some((chapter) => chapter.number === selected)}>
                  {folded.map(row)}
                </DrawnFold>
              ) : null}
              {rest.map(row)}
            </ol>
          ) : (
            <EmptyState
              icon={BookOpen}
              title={noText ? 'Nothing to draw' : 'Nothing planned yet'}
              description={
                activity.reading
                  ? `Reading novel chapters ${activity.reading[0]} to ${activity.reading[1]}.`
                  : noText
                    ? 'No manga chapters were planned.'
                    : 'The first chapters are read when drawing starts.'
              }
            />
          )}

          {waiting ? null : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3 py-2 ring-1 ring-border">
              <div className="min-w-0 flex-1">
                <p className="text-sm tabular-nums">
                  {adaptation.stopAt === undefined ? 'Reads to the end of the novel' : `Stops at novel chapter ${adaptation.stopAt}`}
                </p>
                {remaining > 0 ? (
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {remaining} more {remaining === 1 ? 'chapter' : 'chapters'} on {sourceName}
                  </p>
                ) : null}
              </div>
              {stopPoint}
            </div>
          )}

          <StorySoFar adaptation={adaptation} />
        </section>
      </div>
    </div>
  )
})

function DrawnFold({ chapters, opened, children }: { chapters: readonly MangaChapter[]; opened: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(opened)
  const [wasOpened, setWasOpened] = useState(opened)
  if (wasOpened !== opened) {
    setWasOpened(opened)
    if (opened) setOpen(true)
  }
  const first = chapters[0].number
  const last = chapters[chapters.length - 1].number
  const pages = chapters.reduce((sum, chapter) => sum + chapter.pageCount, 0)
  return (
    <li>
      <FoldRow
        open={open}
        label={`Chapters ${first} to ${last}`}
        detail={`${chapters.length} drawn · ${pages} pages`}
        className="tabular-nums"
        onToggle={() => setOpen(!open)}
      />
      {open ? <ol className="flex flex-col divide-y border-t">{children}</ol> : null}
    </li>
  )
}

function sameFlags(a: readonly FlaggedPanel[], b: readonly FlaggedPanel[]): boolean {
  return a.length === b.length && a.every((item, index) => {
    const other = b[index]
    return item.chapter === other.chapter && item.page === other.page && item.panel === other.panel && item.issue === other.issue && item.tries === other.tries
  })
}

/** Re-renders only when its own panels change, not whenever any chapter does. */
const ChecksList = memo(function ChecksList({ adaptation, flagged }: { adaptation: Adaptation; flagged: readonly FlaggedPanel[] }) {
  return (
    <Collapsible defaultOpen className="rounded-lg ring-1 ring-border">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left outline-none hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring">
        <Flag aria-hidden className="size-4 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1 text-sm font-medium">Panels to check</span>
        <Badge variant="destructive">{flagged.length}</Badge>
        <Chevron />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col divide-y border-t">
          {flagged.map((item) => (
            <li key={`${item.chapter.number}-${item.page}-${item.panel}`} className="flex min-w-0 flex-col gap-1 px-3 py-2">
              <p className="text-xs text-muted-foreground tabular-nums">
                Chapter {item.chapter.number} · page {item.page} · panel {item.panel}
              </p>
              <p className="text-sm text-pretty">{item.issue}</p>
              <div className="-ml-2 flex flex-wrap gap-1">
                <ViewPanelDialog adaptation={adaptation} item={item} />
                <FixPanelButton adaptation={adaptation} chapter={item.chapter} page={item.page} panel={item.panel} issue={item.issue} />
                <RedrawDialog adaptation={adaptation} chapter={item.chapter} page={item.page} panel={item.panel} label="With note" />
                <KeepPanelButton adaptation={adaptation} chapter={item.chapter} page={item.page} panel={item.panel} />
              </div>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}, (previous, next) => previous.adaptation === next.adaptation && sameFlags(previous.flagged, next.flagged))

function ViewPanelDialog({ adaptation, item }: { adaptation: Adaptation; item: FlaggedPanel }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Image data-icon="inline-start" />
          View panel
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="tabular-nums">
            Chapter {item.chapter.number} · page {item.page} · panel {item.panel}
          </DialogTitle>
          <DialogDescription>{item.issue}</DialogDescription>
        </DialogHeader>
        <PanelImage
          adaptationId={adaptation.id}
          chapter={item.chapter.number}
          page={item.page}
          panel={item.panel}
          state="done"
          flagged
          className="aspect-[3/2] w-full"
        />
      </DialogContent>
    </Dialog>
  )
}

const ChapterRow = memo(function ChapterRow({
  adaptation,
  characters,
  chapter,
  activity,
  flagged,
  selected,
  onShowInJournal,
}: {
  adaptation: Adaptation
  characters: readonly Character[]
  chapter: MangaChapter
  activity: AdaptActivity
  flagged: number
  selected: boolean
  onShowInJournal(chapter: number): void
}) {
  const progress = useChapterProgress(adaptation.id, chapter)
  const flow = chapterFlow(chapter, characters, adaptation, activity, progress.panelsDone)
  const drawn = chapter.status === 'drawn'
  const meta = drawn
    ? `${chapter.pageCount} pages`
    : (waitingDetail(chapter, activity, adaptation) ??
      (chapter.script ? `${chapter.script.length} pages · ${chapter.panelsTotal} panels` : null))
  const [open, setOpen] = useState(!drawn || selected)
  const [wasSelected, setWasSelected] = useState(selected)
  if (wasSelected !== selected) {
    setWasSelected(selected)
    if (selected) setOpen(true)
  }
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (!selected) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ref.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' })
  }, [selected])

  return (
    <li ref={ref}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left outline-none hover:bg-muted/50 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring">
          <span className="w-6 shrink-0 text-sm text-muted-foreground tabular-nums">{chapter.number}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{chapter.title}</span>
            <span className="block truncate text-xs text-muted-foreground tabular-nums">
              Novel {novelRange(chapter)}
              {meta ? ` · ${meta}` : ''}
            </span>
          </span>
          {flagged ? <Badge variant="destructive">{flagged} to check</Badge> : null}
          <span className="shrink-0">
            <FlowSteps flow={flow} live={adaptation.status === 'active'} />
          </span>
          <Chevron />
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-2 border-t px-3 py-2">
          {chapter.status === 'stopped' && chapter.error ? <p className="text-sm text-destructive">{chapter.error}</p> : null}
          {chapter.script && !drawn ? <PageLines chapter={chapter} progress={progress} /> : null}
          <div className="-ml-2 flex flex-wrap gap-1">
            {drawn ? (
              <Button variant="ghost" size="sm" asChild>
                <Link
                  to="/reader/$sourceId/$slug/$chapter"
                  params={{ sourceId: ADAPTED_SOURCE_ID, slug: adaptation.id, chapter: String(chapter.number) }}
                >
                  <BookOpen data-icon="inline-start" />
                  Read
                </Link>
              </Button>
            ) : null}
            {chapter.script ? <ScriptDialog adaptation={adaptation} characters={characters} chapter={chapter} /> : null}
            <Button type="button" variant="ghost" size="sm" onClick={() => onShowInJournal(chapter.number)}>
              Show in journal
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
})

function PageLines({ chapter, progress }: { chapter: MangaChapter; progress: ChapterProgress }) {
  const script = chapter.script ?? []
  const groups = Math.max(1, Math.ceil(script.length / PAGE_WINDOW))
  const [chosen, setChosen] = useState<number | null>(null)
  const working = script.findIndex((_, index) => !progress.pageDone(index + 1))
  const group = Math.min(chosen ?? Math.floor(Math.max(working, 0) / PAGE_WINDOW), groups - 1)
  const start = group * PAGE_WINDOW
  return (
    <>
      <ol className="flex flex-col gap-1" aria-label={`Chapter ${chapter.number} pages`}>
        {script.slice(start, start + PAGE_WINDOW).map((page, offset) => {
          const number = start + offset + 1
          const total = page.panels.length
          const done = page.panels.filter((_, panel) => progress.panelState(number, panel + 1) === 'done').length
          const toCheck = page.panels.filter((panel) => panel.check?.status === 'flagged' || panel.check?.status === 'unchecked').length
          const status = progress.pageDone(number)
            ? 'Lettered'
            : progress.isWorking(number) || done > 0
              ? `Drawing, ${done} of ${total}`
              : 'Waiting'
          return (
            <li key={number} className="flex items-center gap-2 text-sm">
              <span className="w-14 shrink-0 tabular-nums">Page {number}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground tabular-nums">
                {total} panels · {status}
              </span>
              {toCheck ? <Badge variant="destructive">{toCheck} to check</Badge> : null}
            </li>
          )
        })}
      </ol>
      {groups > 1 ? (
        <nav aria-label={`Chapter ${chapter.number} page groups`} className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground tabular-nums">
            Pages {start + 1}-{Math.min(start + PAGE_WINDOW, script.length)} of {script.length}
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={group === 0} onClick={() => setChosen(group - 1)}>
              Previous pages
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={group === groups - 1} onClick={() => setChosen(group + 1)}>
              Next pages
            </Button>
          </div>
        </nav>
      ) : null}
    </>
  )
}

function StorySoFar({ adaptation }: { adaptation: Adaptation }) {
  const memory = adaptation.memory
  if (!memory) return null
  return (
    <Collapsible className="rounded-lg ring-1 ring-border">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left outline-none hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring">
        <span className="text-sm font-medium">Story so far</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground tabular-nums">Through novel {memory.updatedThrough}</span>
        <Chevron />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 border-t px-3 py-2">
        <p className="text-sm text-pretty">{memory.summary}</p>
        {memory.threads.length ? (
          <>
            <p className="text-xs font-medium">Open threads</p>
            <ul className="flex list-disc flex-col gap-0.5 pl-4 text-sm text-muted-foreground">
              {memory.threads.map((thread) => (
                <li key={thread}>{thread}</li>
              ))}
            </ul>
          </>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}
