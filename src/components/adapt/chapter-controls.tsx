import { useId, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Flag, Layers } from 'lucide-react'

import { StopPointFields } from '@/components/adapt/stop-point'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { drawnThrough, resolveStop, stopChoiceFor } from '@/lib/adapt/flow'
import { setDrawRange, setStopAt } from '@/lib/adapt/pipeline'
import type { Adaptation, DrawRange, MangaChapter } from '@/lib/adapt/store'
import { describeError } from '@/lib/ui/describe-error'

function undrawnIn(chapters: readonly MangaChapter[], drawRange: DrawRange): boolean {
  return chapters.some(
    (chapter) => chapter.number >= drawRange.from && chapter.number <= drawRange.to && chapter.status !== 'drawn',
  )
}

export function DrawRangeDialog({ adaptation, chapters }: { adaptation: Adaptation; chapters: readonly MangaChapter[] }) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Layers data-icon="inline-start" />
          Draw a range
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Draw a range</DialogTitle>
          <DialogDescription>These chapters go to the front of the queue.</DialogDescription>
        </DialogHeader>
        <DrawRangeForm adaptation={adaptation} chapters={chapters} onSaved={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

function DrawRangeForm({
  adaptation,
  chapters,
  onSaved,
}: {
  adaptation: Adaptation
  chapters: readonly MangaChapter[]
  onSaved(): void
}) {
  const fromId = useId()
  const toId = useId()
  const last = chapters.at(-1)?.number ?? 1
  const [from, setFrom] = useState(String(chapters.find((chapter) => chapter.status !== 'drawn')?.number ?? 1))
  const [to, setTo] = useState(String(last))
  const save = useMutation({
    mutationFn: (next: DrawRange | undefined) => setDrawRange(adaptation.id, next),
    onSuccess: onSaved,
  })

  const wanted = { from: Number(from), to: Number(to) }
  const valid =
    Number.isInteger(wanted.from) &&
    Number.isInteger(wanted.to) &&
    wanted.from >= 1 &&
    wanted.to <= last &&
    wanted.from <= wanted.to &&
    undrawnIn(chapters, wanted)
  const current = adaptation.drawRange && undrawnIn(chapters, adaptation.drawRange) ? adaptation.drawRange : null

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid) save.mutate(wanted)
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={fromId}>From</Label>
          <Input
            id={fromId}
            name="from"
            type="number"
            inputMode="numeric"
            min={1}
            max={last}
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="tabular-nums"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={toId}>To</Label>
          <Input
            id={toId}
            name="to"
            type="number"
            inputMode="numeric"
            min={1}
            max={last}
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="tabular-nums"
          />
        </div>
      </div>
      {current ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground tabular-nums">
            {current.from === current.to ? `Chapter ${current.from}` : `Chapters ${current.from} to ${current.to}`} first
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={() => save.mutate(undefined)} disabled={save.isPending}>
            Clear
          </Button>
        </div>
      ) : null}
      <Button type="submit" disabled={!valid || save.isPending}>
        <Layers data-icon="inline-start" />
        Draw range
      </Button>
      {save.isError ? <p className="text-xs text-destructive">Could not save the range. {describeError(save.error)}</p> : null}
    </form>
  )
}

export function StopPointDialog({
  adaptation,
  chapters,
  label = 'Stop point',
}: {
  adaptation: Adaptation
  chapters: readonly MangaChapter[]
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const base = drawnThrough(chapters)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Flag data-icon="inline-start" />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Stop point</DialogTitle>
          <DialogDescription>
            {base ? `Next counts from novel chapter ${base}, the last one drawn.` : 'Next counts from the start.'}
          </DialogDescription>
        </DialogHeader>
        <StopPointForm adaptation={adaptation} chapters={chapters} onSaved={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

function StopPointForm({
  adaptation,
  chapters,
  onSaved,
}: {
  adaptation: Adaptation
  chapters: readonly MangaChapter[]
  onSaved(): void
}) {
  const base = drawnThrough(chapters)
  const [choice, setChoice] = useState(() => stopChoiceFor(adaptation.stopAt, base))
  const stopAt = resolveStop(choice, base)
  const save = useMutation({
    mutationFn: (next: number | undefined) => setStopAt(adaptation.id, next),
    onSuccess: onSaved,
  })

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (stopAt !== null) save.mutate(stopAt)
      }}
    >
      <StopPointFields base={base} total={adaptation.novelChapterCount} value={choice} onChange={setChoice} />
      <Button type="submit" disabled={stopAt === null || save.isPending}>
        <Flag data-icon="inline-start" />
        Save stop point
      </Button>
      {save.isError ? <p className="text-xs text-destructive">Could not save the stop point. {describeError(save.error)}</p> : null}
    </form>
  )
}
