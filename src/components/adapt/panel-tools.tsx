import { useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Check, RefreshCcw, Type } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { keepPanel, requestPanelRedraw, requestRedraw, updatePanelText } from '@/lib/adapt/pipeline'
import { panelKey } from '@/lib/adapt/keys'
import type { Adaptation, MangaChapter, TextItem } from '@/lib/adapt/store'
import { useBlobUrl } from '@/lib/adapt/use-adaptation'
import type { PanelState } from '@/lib/adapt/use-adaptation'
import { notify } from '@/lib/ui/toast'
import { cn } from '@/lib/utils'
import { describeError } from '@/lib/ui/describe-error'

/** A stored panel, or a placeholder that pulses while it is being drawn. */
export function PanelImage({
  adaptationId,
  chapter,
  page,
  panel,
  state,
  flagged = false,
  className,
}: {
  adaptationId: string
  chapter: number
  page: number
  panel: number
  state: PanelState
  flagged?: boolean
  className?: string
}) {
  const url = useBlobUrl(state === 'done' ? panelKey(adaptationId, chapter, page, panel) : null)
  return (
    <div
      className={cn(
        'overflow-hidden rounded-sm bg-muted',
        state === 'working' && 'ring-1 ring-foreground/40 motion-safe:animate-pulse',
        flagged ? 'ring-2 ring-destructive' : 'ring-1 ring-border',
        className,
      )}
    >
      {url ? <img src={url} alt={`Page ${page}, panel ${panel}`} className="size-full object-cover" /> : null}
    </div>
  )
}

function queuedFor(chapter: MangaChapter, page: number, panel?: number): boolean {
  return chapter.redraw.some((item) => item.page === page && (item.panel === undefined || item.panel === panel))
}

/** Edits the lines of one panel, or of every panel on the page, and re-letters the page without a redraw. */
export function LinesDialog({
  adaptation,
  chapter,
  page,
  panel,
  trigger,
}: {
  adaptation: Adaptation
  chapter: MangaChapter
  page: number
  panel?: number
  trigger: (open: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const panels = chapter.script?.[page - 1]?.panels ?? []
  const numbers = panel ? [panel] : panels.map((_, index) => index + 1)
  const [drafts, setDrafts] = useState<Map<number, TextItem[]>>(new Map())

  const show = () => {
    setDrafts(new Map(numbers.map((number) => [number, panels[number - 1]?.text.map((item) => ({ ...item })) ?? []])))
    setOpen(true)
  }

  const save = useMutation({
    mutationFn: async () => {
      let result: 'relettered' | 'redrawing' | null = null
      for (const number of numbers) {
        const before = panels[number - 1]?.text ?? []
        const after = drafts.get(number) ?? before
        if (after.every((item, index) => item.line.trim() === before[index]?.line)) continue
        result = await updatePanelText(adaptation.id, chapter.number, page, number, after)
      }
      return result
    },
    onSuccess: (result) => {
      setOpen(false)
      if (result === 'relettered') notify.success(`Page ${page} re-lettered`)
      if (result === 'redrawing') notify.success(`Page ${page} queued for a redraw. It was drawn before panels were kept.`)
    },
  })

  const editable = numbers.filter((number) => (panels[number - 1]?.text.length ?? 0) > 0)

  return (
    <>
      {trigger(show)}
      <Dialog open={open} onOpenChange={save.isPending ? () => undefined : setOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="tabular-nums">
              {panel ? `Lines, page ${page} panel ${panel}` : `Lines, page ${page}`}
            </DialogTitle>
            <DialogDescription>Saved lines are lettered again on the same art. Clear a line to remove it.</DialogDescription>
          </DialogHeader>
          {editable.length ? (
            <fieldset disabled={save.isPending} className="min-w-0">
              <FieldGroup>
                {editable.map((number) =>
                  (drafts.get(number) ?? []).map((item, index) => {
                    const id = `line-${page}-${number}-${index}`
                    return (
                      <Field key={id}>
                        <FieldLabel htmlFor={id} className="tabular-nums">
                          {panel ? '' : `Panel ${number} · `}
                          {item.kind === 'caption' ? 'Caption' : item.kind === 'sfx' ? 'Sound' : (item.speaker ?? 'Line')}
                        </FieldLabel>
                        <Input
                          id={id}
                          value={item.line}
                          onChange={(event) =>
                            setDrafts((current) => {
                              const next = new Map(current)
                              const items = [...(next.get(number) ?? [])]
                              items[index] = { ...items[index], line: event.target.value }
                              next.set(number, items)
                              return next
                            })
                          }
                        />
                      </Field>
                    )
                  }),
                )}
              </FieldGroup>
            </fieldset>
          ) : (
            <p className="text-sm text-muted-foreground">{panel ? 'This panel has no lines.' : 'This page has no lines.'}</p>
          )}
          {save.isError ? <p className="text-sm text-destructive">Could not save the lines. {describeError(save.error)}</p> : null}
          <DialogFooter>
            <Button variant="outline" disabled={save.isPending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending || !editable.length}>
              {save.isPending ? <Spinner data-icon="inline-start" /> : <Type data-icon="inline-start" />}
              Save lines
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Queues a redraw of one panel, or the whole page when `panel` is absent, with an optional note. */
export function RedrawDialog({
  adaptation,
  chapter,
  page,
  panel,
  label = 'Redraw',
}: {
  adaptation: Adaptation
  chapter: MangaChapter
  page: number
  panel?: number
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const queued = queuedFor(chapter, page, panel)

  const redraw = useMutation({
    mutationFn: () =>
      panel
        ? requestPanelRedraw(adaptation.id, chapter.number, page, panel, note)
        : requestRedraw(adaptation.id, chapter.number, page, note),
    onSuccess: () => {
      setOpen(false)
      setNote('')
    },
  })

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} disabled={queued}>
        <RefreshCcw data-icon="inline-start" />
        {queued ? 'Queued' : label}
      </Button>
      <Dialog open={open} onOpenChange={redraw.isPending ? () => undefined : setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="tabular-nums">{panel ? `Redraw page ${page}, panel ${panel}` : `Redraw page ${page}`}</DialogTitle>
            <DialogDescription className="tabular-nums">
              Chapter {chapter.number}. The layout and lines stay.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="What should change?"
            placeholder="What should change?"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            disabled={redraw.isPending}
            rows={3}
          />
          {redraw.isError ? <p className="text-sm text-destructive">Could not queue the redraw. {describeError(redraw.error)}</p> : null}
          <DialogFooter>
            <Button variant="outline" disabled={redraw.isPending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => redraw.mutate()} disabled={redraw.isPending}>
              {redraw.isPending ? <Spinner data-icon="inline-start" /> : <RefreshCcw data-icon="inline-start" />}
              Redraw
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** One tap: redraws the flagged panel with the check's issue as the note. */
export function FixPanelButton({
  adaptation,
  chapter,
  page,
  panel,
  issue,
}: {
  adaptation: Adaptation
  chapter: MangaChapter
  page: number
  panel: number
  issue: string
}) {
  const queued = queuedFor(chapter, page, panel)
  const redraw = useMutation({ mutationFn: () => requestPanelRedraw(adaptation.id, chapter.number, page, panel, issue) })
  return (
    <Button size="sm" onClick={() => redraw.mutate()} disabled={queued || redraw.isPending}>
      {redraw.isPending ? <Spinner data-icon="inline-start" /> : <RefreshCcw data-icon="inline-start" />}
      {queued ? 'Queued' : 'Redraw'}
    </Button>
  )
}

export function KeepPanelButton({
  adaptation,
  chapter,
  page,
  panel,
}: {
  adaptation: Adaptation
  chapter: MangaChapter
  page: number
  panel: number
}) {
  const keep = useMutation({
    mutationFn: () => keepPanel(adaptation.id, chapter.number, page, panel),
    onError: (cause) => notify.error('Could not keep the panel', cause),
  })
  return (
    <Button variant="ghost" size="sm" onClick={() => keep.mutate()} disabled={keep.isPending}>
      {keep.isPending ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
      Keep it
    </Button>
  )
}
