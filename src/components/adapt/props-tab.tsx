import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Box, Car, House, PawPrint, Pencil, RefreshCcw } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { AppearsIn } from '@/components/adapt/cast-tab'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { updatePlace, updateProp } from '@/lib/adapt/pipeline'
import type { MangaChapter, Place, Prop, PropKind } from '@/lib/adapt/store'
import { useBlobUrl } from '@/lib/adapt/use-adaptation'
import { cn } from '@/lib/utils'
import { describeError } from '@/lib/ui/describe-error'

const KINDS: Record<PropKind, { label: string; icon: LucideIcon }> = {
  vehicle: { label: 'Vehicle', icon: Car },
  object: { label: 'Object', icon: Box },
  creature: { label: 'Creature', icon: PawPrint },
}

type Design = { type: 'place'; item: Place } | { type: 'prop'; item: Prop }

function keyOf(design: Design): string {
  return `${design.type}:${design.item.id}`
}

function labelOf(design: Design): string {
  return design.type === 'place' ? 'Place' : KINDS[design.item.kind].label
}

/** A design's sheet, or its kind's icon until a chapter uses it. */
function DesignSheet({ design, className }: { design: Design; className?: string }) {
  const url = useBlobUrl(design.item.sheetKey)
  const Icon = design.type === 'place' ? House : KINDS[design.item.kind].icon
  return url ? (
    <img src={url} alt={design.item.name} className={className} />
  ) : (
    <div className={cn('flex items-center justify-center bg-muted text-muted-foreground', className)}>
      <Icon aria-hidden className="size-6" />
    </div>
  )
}

function chaptersShowing(design: Design, chapters: readonly MangaChapter[]): { chapter: MangaChapter; panels: number }[] {
  return chapters.flatMap((chapter) => {
    const panels = (chapter.script ?? [])
      .flatMap((page) => page.panels)
      .filter((panel) => (design.type === 'place' ? panel.place === design.item.id : panel.props?.includes(design.item.id))).length
    return panels ? [{ chapter, panels }] : []
  })
}

export function PropsTab({
  adaptationId,
  places,
  props,
  chapters,
  selected,
  onSelect,
  onOpenChapter,
}: {
  adaptationId: string
  places: readonly Place[]
  props: readonly Prop[]
  chapters: readonly MangaChapter[]
  selected: string | undefined
  onSelect(key: string): void
  onOpenChapter(chapter: number): void
}) {
  const designs: Design[] = [
    ...places.map((item): Design => ({ type: 'place', item })),
    ...props.map((item): Design => ({ type: 'prop', item })),
  ]
  if (!designs.length) {
    return <EmptyState icon={Box} title="No places or props yet" description="They appear once the first chapters are read." />
  }
  const current = designs.find((design) => keyOf(design) === selected) ?? designs[0]

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      <div className="flex min-w-0 flex-col gap-4 lg:col-span-5">
        {(['place', 'prop'] as const).map((type) => {
          const list = designs.filter((design) => design.type === type)
          if (!list.length) return null
          return (
            <section key={type} className="flex flex-col gap-2" aria-labelledby={`${type}-title`}>
              <h2 id={`${type}-title`} className="text-sm font-medium">
                {type === 'place' ? 'Places' : 'Props'} <span className="text-muted-foreground tabular-nums">{list.length}</span>
              </h2>
              <ul className="flex flex-col divide-y overflow-hidden rounded-lg ring-1 ring-border">
                {list.map((design) => {
                  const shown = chaptersShowing(design, chapters).length
                  const active = keyOf(design) === keyOf(current)
                  return (
                    <li key={keyOf(design)}>
                      <button
                        type="button"
                        aria-pressed={active}
                        onClick={() => onSelect(keyOf(design))}
                        className={cn(
                          'flex w-full items-center gap-3 px-3 py-2 text-left outline-none hover:bg-muted/50 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring',
                          active && 'bg-muted',
                        )}
                      >
                        <DesignSheet design={design} className="aspect-[3/2] w-16 shrink-0 rounded-sm object-cover" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{design.item.name}</span>
                          <span className="block truncate text-xs text-muted-foreground tabular-nums">
                            {labelOf(design)} · {shown} {shown === 1 ? 'chapter' : 'chapters'}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
      <div className="min-w-0 lg:col-span-7">
        <DesignDetail key={keyOf(current)} adaptationId={adaptationId} design={current} chapters={chapters} onOpenChapter={onOpenChapter} />
      </div>
    </div>
  )
}

function DesignDetail({
  adaptationId,
  design,
  chapters,
  onOpenChapter,
}: {
  adaptationId: string
  design: Design
  chapters: readonly MangaChapter[]
  onOpenChapter(chapter: number): void
}) {
  const [open, setOpen] = useState(false)
  const redraw = useMutation({
    mutationFn: () =>
      design.type === 'place' ? updatePlace(adaptationId, design.item, true) : updateProp(adaptationId, design.item, true),
  })
  const shown = chaptersShowing(design, chapters)

  return (
    <article className="flex flex-col gap-3" aria-labelledby={`design-${design.item.id}`}>
      <header className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 id={`design-${design.item.id}`} className="text-lg font-semibold tracking-tight">
            {design.item.name}
          </h2>
          <p className="text-sm text-muted-foreground">{labelOf(design)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <Pencil data-icon="inline-start" />
            Edit
          </Button>
          {design.item.sheetKey ? (
            <Button variant="ghost" size="sm" onClick={() => redraw.mutate()} disabled={redraw.isPending}>
              {redraw.isPending ? <Spinner data-icon="inline-start" /> : <RefreshCcw data-icon="inline-start" />}
              Redraw sheet
            </Button>
          ) : (
            <Badge variant="outline">Drawn when first used</Badge>
          )}
        </div>
      </header>
      <DesignSheet design={design} className="aspect-[3/2] w-full rounded-md object-cover ring-1 ring-border" />
      {redraw.isError ? <p className="text-sm text-destructive">Could not redraw the sheet. {describeError(redraw.error)}</p> : null}
      <p className="text-sm text-pretty">{design.item.description}</p>
      <AppearsIn
        items={shown.map(({ chapter, panels }) => ({
          chapter,
          detail: `${panels} ${panels === 1 ? 'panel' : 'panels'}`,
        }))}
        onOpenChapter={onOpenChapter}
      />
      <DesignDialog key={design.item.description} adaptationId={adaptationId} design={design} open={open} onOpenChange={setOpen} />
    </article>
  )
}

function DesignDialog({
  adaptationId,
  design,
  open,
  onOpenChange,
}: {
  adaptationId: string
  design: Design
  open: boolean
  onOpenChange(open: boolean): void
}) {
  const [description, setDescription] = useState(design.item.description)
  const next = description.trim()
  const edited = next !== design.item.description

  const save = useMutation({
    mutationFn: (redraw: boolean) =>
      design.type === 'place'
        ? updatePlace(adaptationId, { ...design.item, description: next }, redraw)
        : updateProp(adaptationId, { ...design.item, description: next }, redraw),
    onSuccess: () => onOpenChange(false),
  })

  return (
    <Dialog open={open} onOpenChange={save.isPending ? () => undefined : onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit {design.item.name}</DialogTitle>
          <DialogDescription>{labelOf(design)}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`design-${design.item.id}-text`}>Design</Label>
          <Textarea
            id={`design-${design.item.id}-text`}
            rows={4}
            value={description}
            disabled={save.isPending}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        {save.isError ? <p className="text-sm text-destructive">Could not save. {describeError(save.error)}</p> : null}

        <DialogFooter>
          <Button variant="outline" disabled={save.isPending || !edited || !next} onClick={() => save.mutate(false)}>
            Save
          </Button>
          <Button disabled={save.isPending || !next || (!edited && !design.item.sheetKey)} onClick={() => save.mutate(true)}>
            {save.isPending ? <Spinner data-icon="inline-start" /> : <RefreshCcw data-icon="inline-start" />}
            {edited ? 'Save and redraw' : 'Redraw'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
