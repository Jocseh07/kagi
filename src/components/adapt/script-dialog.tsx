import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ChevronDown, Flag, FileText, Type } from 'lucide-react'

import { KeepPanelButton, LinesDialog, PanelImage, RedrawDialog } from '@/components/adapt/panel-tools'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend, FieldDescription } from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { beatPages, chapterLooks, pageSpan, panelCheckIssue, textLine } from '@/lib/adapt/flow'
import type { Frame } from '@/lib/adapt/layouts'
import { rewriteScript, setChapterOutfit } from '@/lib/adapt/pipeline'
import type { Adaptation, Character, MangaChapter, ScriptPanel } from '@/lib/adapt/store'
import { useChapterProgress } from '@/lib/adapt/use-adaptation'
import type { ChapterProgress } from '@/lib/adapt/use-adaptation'
import { describeError } from '@/lib/ui/describe-error'

const FRAME_SHAPES: Record<Frame, string> = {
  wide: 'aspect-[3/2]',
  inset: 'aspect-[3/2]',
  close: 'aspect-square',
  tall: 'aspect-[2/3]',
}

const FRAME_NAMES: Record<Frame, string> = { wide: 'Wide', inset: 'Inset', close: 'Close', tall: 'Tall' }

function Chevron() {
  return (
    <ChevronDown
      aria-hidden
      className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none"
    />
  )
}

export function ScriptDialog({
  adaptation,
  characters,
  chapter,
}: {
  adaptation: Adaptation
  characters: readonly Character[]
  chapter: MangaChapter
}) {
  const [open, setOpen] = useState(false)
  const pages = chapter.script?.length ?? 0
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <FileText data-icon="inline-start" />
          Script
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-dvh flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="tabular-nums">Chapter {chapter.number} script</DialogTitle>
          <DialogDescription className="tabular-nums">
            {pages} pages · {chapter.panelsTotal} panels
          </DialogDescription>
        </DialogHeader>
        {open ? <ScriptBody adaptation={adaptation} characters={characters} chapter={chapter} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function ScriptBody({
  adaptation,
  characters,
  chapter,
}: {
  adaptation: Adaptation
  characters: readonly Character[]
  chapter: MangaChapter
}) {
  const progress = useChapterProgress(adaptation.id, chapter)
  const looks = chapterLooks(chapter, characters, adaptation)
  const script = chapter.script ?? []

  return (
    <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1 py-1">
      <div className="flex flex-wrap items-start gap-2">
        {chapter.summary ? <p className="min-w-0 flex-1 text-sm text-pretty text-muted-foreground">{chapter.summary}</p> : null}
        <RewriteScriptDialog adaptation={adaptation} chapter={chapter} />
      </div>
      <ul className="flex flex-wrap gap-1.5" aria-label="In this chapter">
        {[...looks.names, ...looks.places, ...looks.props].map((name) => (
          <li key={name}>
            <Badge variant="secondary">{name}</Badge>
          </li>
        ))}
      </ul>
      <Outfits adaptation={adaptation} characters={characters} chapter={chapter} />
      <Beats chapter={chapter} adaptation={adaptation} characters={characters} />
      <ol className="flex flex-col gap-2" aria-label={`Chapter ${chapter.number} pages`}>
        {script.map((page, index) => (
          <PageSection
            key={index}
            adaptation={adaptation}
            characters={characters}
            chapter={chapter}
            page={index + 1}
            panels={page.panels}
            progress={progress}
          />
        ))}
      </ol>
    </div>
  )
}

/** Characters this chapter shows who have more than one look to choose from. */
function outfitCast(chapter: MangaChapter, characters: readonly Character[]): Character[] {
  const shown = new Set([
    ...Object.keys(chapter.wearing ?? {}),
    ...(chapter.beats ?? []).flatMap((beat) => beat.cast),
    ...(chapter.script ?? []).flatMap((page) => page.panels.flatMap((panel) => panel.looks.map((id) => id.slice(0, id.indexOf('@'))))),
  ])
  return characters.filter((character) => shown.has(character.id) && character.looks.length > 1)
}

function Outfits({ adaptation, characters, chapter }: { adaptation: Adaptation; characters: readonly Character[]; chapter: MangaChapter }) {
  const choose = useMutation({
    mutationFn: ({ characterId, lookId }: { characterId: string; lookId: string | null }) =>
      setChapterOutfit(adaptation.id, chapter.number, characterId, lookId),
  })
  const cast = outfitCast(chapter, characters)
  if (!cast.length) return null

  return (
    <FieldSet disabled={choose.isPending} className="min-w-0">
      <FieldLegend variant="label">Outfits</FieldLegend>
      <FieldDescription>Each character wears this look all chapter. Changing one redraws their panels.</FieldDescription>
      <FieldGroup className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {cast.map((character) => {
          const id = `outfit-${chapter.number}-${character.id}`
          const pending = choose.isPending && choose.variables.characterId === character.id
          const value = pending ? (choose.variables.lookId ?? '') : (chapter.wearing?.[character.id] ?? '')
          return (
            <Field key={character.id}>
              <FieldLabel htmlFor={id}>
                {character.name}
                {pending ? <Spinner /> : null}
              </FieldLabel>
              <NativeSelect
                id={id}
                className="w-full"
                value={value}
                onChange={(event) => choose.mutate({ characterId: character.id, lookId: event.target.value || null })}
              >
                <NativeSelectOption value="">Any look</NativeSelectOption>
                {character.looks.map((look) => (
                  <NativeSelectOption key={look.id} value={look.id}>
                    {look.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          )
        })}
      </FieldGroup>
      {choose.isError ? <p className="text-sm text-destructive">Could not change the outfit. {describeError(choose.error)}</p> : null}
    </FieldSet>
  )
}

function Beats({ chapter, adaptation, characters }: { chapter: MangaChapter; adaptation: Adaptation; characters: readonly Character[] }) {
  const beats = chapter.beats
  if (!beats) {
    return chapter.script ? <p className="text-xs text-muted-foreground">Written before beats.</p> : null
  }
  const pages = beatPages(chapter)
  const key = beats.filter((beat) => beat.weight === 'key').length
  const missed = beats.filter((beat, index) => beat.weight === 'key' && chapter.script && !pages.has(index)).length
  const places = new Map((adaptation.places ?? []).map((place) => [place.id, place.name]))
  const names = new Map(characters.map((character) => [character.id, character.name]))
  const cut = chapter.cut ?? []

  return (
    <Collapsible className="rounded-lg ring-1 ring-border">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left outline-none hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring">
        <span className="text-sm font-medium">Beats</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground tabular-nums">
          {beats.length} beats · {key} key{missed ? ` · ${missed} key with no page` : ''}
          {cut.length ? ` · ${cut.length} lines cut` : ''}
        </span>
        <Chevron />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="flex flex-col divide-y border-t">
          {beats.map((beat, index) => (
            <li key={index} className="flex items-start gap-3 px-3 py-2">
              <span className="w-5 shrink-0 text-xs text-muted-foreground tabular-nums">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm">{beat.moment}</p>
                <p className="truncate text-xs text-muted-foreground tabular-nums">
                  {[
                    beat.place ? (places.get(beat.place) ?? beat.place) : null,
                    beat.cast.map((id) => names.get(id) ?? id).join(', ') || null,
                    `${beat.lines.length} ${beat.lines.length === 1 ? 'line' : 'lines'}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              {beat.weight === 'key' ? <Badge>Key</Badge> : null}
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {chapter.script ? pageSpan(pages.get(index) ?? []) : ''}
              </span>
            </li>
          ))}
        </ol>
        {cut.length ? (
          <div className="flex flex-col gap-1 border-t px-3 py-2">
            <p className="text-xs font-medium">Cut lines</p>
            <ul className="flex flex-col gap-0.5">
              {cut.map((line) => (
                <li key={line} className="text-xs text-muted-foreground">
                  “{line}”
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

function PageSection({
  adaptation,
  characters,
  chapter,
  page,
  panels,
  progress,
}: {
  adaptation: Adaptation
  characters: readonly Character[]
  chapter: MangaChapter
  page: number
  panels: readonly ScriptPanel[]
  progress: ChapterProgress
}) {
  const lettered = progress.pageDone(page)
  const working = progress.isWorking(page)
  const flagged = panels.filter((panel) => panel.check?.status === 'flagged' || panel.check?.status === 'unchecked').length
  const status = lettered ? 'Lettered' : working ? 'Drawing' : 'Waiting'

  return (
    <li>
      <Collapsible defaultOpen={flagged > 0 || working} className="rounded-lg ring-1 ring-border">
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left outline-none hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring">
          <span className="text-sm font-medium tabular-nums">Page {page}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground tabular-nums">
            {panels.length} panels · {status}
          </span>
          {flagged ? <Badge variant="destructive">{flagged} to check</Badge> : null}
          <Chevron />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ol className="flex flex-col divide-y border-t">
            {panels.map((panel, index) => (
              <PanelRow
                key={index}
                adaptation={adaptation}
                characters={characters}
                chapter={chapter}
                page={page}
                number={index + 1}
                panel={panel}
                progress={progress}
                editable={lettered && !working}
              />
            ))}
          </ol>
          {lettered && !working ? (
            <div className="flex justify-end border-t px-2 py-1">
              <RedrawDialog adaptation={adaptation} chapter={chapter} page={page} label="Redraw page" />
            </div>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

function PanelRow({
  adaptation,
  characters,
  chapter,
  page,
  number,
  panel,
  progress,
  editable,
}: {
  adaptation: Adaptation
  characters: readonly Character[]
  chapter: MangaChapter
  page: number
  number: number
  panel: ScriptPanel
  progress: ChapterProgress
  editable: boolean
}) {
  const place = panel.place ? adaptation.places?.find((item) => item.id === panel.place)?.name : undefined
  const cast = characters.filter((character) => character.looks.some((look) => panel.looks.includes(look.id))).map((character) => character.name)
  const flagged = panel.check?.status === 'flagged' || panel.check?.status === 'unchecked'
  const meta = [`Panel ${number}`, panel.frame ? FRAME_NAMES[panel.frame] : null, place ?? null, cast.join(', ') || null]
    .filter(Boolean)
    .join(' · ')

  return (
    <li className="flex items-start gap-3 px-3 py-2">
      <PanelImage
        adaptationId={adaptation.id}
        chapter={chapter.number}
        page={page}
        panel={number}
        state={progress.panelState(page, number)}
        flagged={flagged}
        className={`w-24 shrink-0 ${FRAME_SHAPES[panel.frame ?? 'wide']}`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="truncate text-xs text-muted-foreground tabular-nums">{meta}</p>
        <p className="line-clamp-2 text-sm">{panel.shot}</p>
        {panel.text.length ? (
          panel.text.map((item, index) => (
            <p key={index} className="line-clamp-2 text-sm text-muted-foreground">
              {textLine(item)}
            </p>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">No lines</p>
        )}
        {panel.check?.status === 'pending' ? (
          <p role="status" className="text-sm text-muted-foreground">
            {adaptation.status === 'active' ? 'Checking image…' : 'Image check pending'}
          </p>
        ) : null}
        {flagged ? (
          <p className="flex items-start gap-1.5 text-sm text-destructive">
            <Flag aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {panelCheckIssue(panel.check)}
              {panel.check?.tries ? ` Redrawn ${panel.check.tries} ${panel.check.tries === 1 ? 'time' : 'times'}.` : ''}
            </span>
          </p>
        ) : null}
        {editable ? (
          <div className="-ml-2 flex flex-wrap gap-1">
            <LinesDialog
              adaptation={adaptation}
              chapter={chapter}
              page={page}
              panel={number}
              trigger={(open) => (
                <Button variant="ghost" size="sm" onClick={open} disabled={!panel.text.length}>
                  <Type data-icon="inline-start" />
                  Edit lines
                </Button>
              )}
            />
            <RedrawDialog adaptation={adaptation} chapter={chapter} page={page} panel={number} />
            {flagged ? <KeepPanelButton adaptation={adaptation} chapter={chapter} page={page} panel={number} /> : null}
          </div>
        ) : null}
      </div>
    </li>
  )
}

function RewriteScriptDialog({ adaptation, chapter }: { adaptation: Adaptation; chapter: MangaChapter }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const rewrite = useMutation({
    mutationFn: () => rewriteScript(adaptation.id, chapter.number, note),
    onSuccess: () => {
      setOpen(false)
      setNote('')
    },
  })
  const pages = chapter.script?.length ?? 0

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <FileText data-icon="inline-start" />
        Rewrite script
      </Button>
      <Dialog open={open} onOpenChange={rewrite.isPending ? () => undefined : setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="tabular-nums">Rewrite chapter {chapter.number}</DialogTitle>
            <DialogDescription className="tabular-nums">
              The storyboard is written again from the same beats, then all {pages} pages are drawn again.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="What should change?"
            placeholder="More panels for the fight, fewer captions"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            disabled={rewrite.isPending}
            rows={3}
          />
          {rewrite.isError ? <p className="text-sm text-destructive">Could not queue the rewrite. {describeError(rewrite.error)}</p> : null}
          <DialogFooter>
            <Button variant="outline" disabled={rewrite.isPending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => rewrite.mutate()} disabled={rewrite.isPending}>
              {rewrite.isPending ? <Spinner data-icon="inline-start" /> : <FileText data-icon="inline-start" />}
              Rewrite and redraw
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
