import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Pencil, Plus, RefreshCcw, Users } from 'lucide-react'

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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { flaggedPanels } from '@/lib/adapt/flow'
import { updateCharacter } from '@/lib/adapt/pipeline'
import { isMainLook, slug } from '@/lib/adapt/prompts'
import type { Character, Look, MangaChapter } from '@/lib/adapt/store'
import { useBlobUrl } from '@/lib/adapt/use-adaptation'
import { cn } from '@/lib/utils'
import { describeError } from '@/lib/ui/describe-error'

export function CastTab({
  characters,
  chapters,
  selected,
  onSelect,
  onOpenChapter,
}: {
  characters: readonly Character[]
  chapters: readonly MangaChapter[]
  selected: string | undefined
  onSelect(who: string): void
  onOpenChapter(chapter: number): void
}) {
  if (!characters.length) {
    return <EmptyState icon={Users} title="No cast yet" description="The cast appears here once the first chapters are read." />
  }
  const current = characters.find((character) => character.id === selected) ?? characters[0]
  const looks = characters.reduce((sum, character) => sum + character.looks.length, 0)

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      <div className="flex min-w-0 flex-col gap-2 lg:col-span-5">
        <p className="text-sm text-muted-foreground tabular-nums">
          {characters.length} {characters.length === 1 ? 'person' : 'people'}, {looks} {looks === 1 ? 'look' : 'looks'}
        </p>
        <ul className="flex flex-col divide-y overflow-hidden rounded-lg ring-1 ring-border">
          {characters.map((character) => {
            const main = character.looks.find(isMainLook)
            return (
              <li key={character.id}>
                <button
                  type="button"
                  aria-pressed={character.id === current.id}
                  onClick={() => onSelect(character.id)}
                  className={cn(
                    'flex w-full items-center gap-3 px-3 py-2 text-left outline-none hover:bg-muted/50 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring',
                    character.id === current.id && 'bg-muted',
                  )}
                >
                  <SheetImage look={main} name={character.name} className="aspect-[3/2] w-16 shrink-0 rounded-sm object-cover" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{character.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{character.looks.map((look) => look.name).join(' · ')}</span>
                    {character.now ? <span className="block truncate text-xs text-muted-foreground">Now: {character.now}</span> : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
      <div className="min-w-0 lg:col-span-7">
        <CharacterDetail key={current.id} character={current} chapters={chapters} onOpenChapter={onOpenChapter} />
      </div>
    </div>
  )
}

export function SheetImage({ look, name, className }: { look: Look | undefined; name: string; className?: string }) {
  const url = useBlobUrl(look?.sheetKey)
  return url ? (
    <img src={url} alt={`${name}, ${look?.name}`} className={className} />
  ) : (
    <Skeleton className={className} />
  )
}

function CharacterDetail({
  character,
  chapters,
  onOpenChapter,
}: {
  character: Character
  chapters: readonly MangaChapter[]
  onOpenChapter(chapter: number): void
}) {
  const [open, setOpen] = useState(false)
  const redraw = useMutation({ mutationFn: (lookId: string) => updateCharacter(character, [lookId]) })
  const lookIds = new Set(character.looks.map((look) => look.id))
  const flagged = flaggedPanels(chapters)
  const appears = chapters.flatMap((chapter) => {
    const panels = (chapter.script ?? []).flatMap((page) => page.panels).filter((panel) => panel.looks.some((id) => lookIds.has(id))).length
    return panels ? [{ chapter, panels, toCheck: flagged.filter((item) => item.chapter.number === chapter.number).length }] : []
  })

  return (
    <article className="flex flex-col gap-3" aria-labelledby={`cast-${character.id}`}>
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 id={`cast-${character.id}`} className="text-lg font-semibold tracking-tight">
            {character.name}
          </h2>
          <p className="text-sm text-muted-foreground tabular-nums">
            {[character.role, `first in novel chapter ${character.firstNovelChapter}`].filter(Boolean).join(' · ')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Pencil data-icon="inline-start" />
          Edit look
        </Button>
      </header>
      <p className="text-sm text-pretty">{character.appearance}</p>
      {character.now ? (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Now:</span> {character.now}
        </p>
      ) : null}
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label="Looks">
        {character.looks.map((look) => (
          <li key={look.id} className="flex flex-col gap-1">
            <SheetImage look={look} name={character.name} className="aspect-[3/2] w-full rounded-sm object-cover ring-1 ring-border" />
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm">{look.change ? `${look.name}: ${look.change}` : look.name}</span>
              {look.sheetKey ? (
                <Button variant="ghost" size="sm" disabled={redraw.isPending} onClick={() => redraw.mutate(look.id)}>
                  {redraw.isPending && redraw.variables === look.id ? <Spinner data-icon="inline-start" /> : <RefreshCcw data-icon="inline-start" />}
                  Redraw sheet
                </Button>
              ) : (
                <Badge variant="outline">Drawn when first used</Badge>
              )}
            </div>
          </li>
        ))}
      </ul>
      {redraw.isError ? <p className="text-sm text-destructive">Could not redraw the sheet. {describeError(redraw.error)}</p> : null}
      <AppearsIn
        items={appears.map(({ chapter, panels, toCheck }) => ({
          chapter,
          detail: toCheck ? `${toCheck} to check` : `${panels} ${panels === 1 ? 'panel' : 'panels'}`,
          alert: toCheck > 0,
        }))}
        onOpenChapter={onOpenChapter}
      />
      <CharacterDialog character={character} open={open} onOpenChange={setOpen} />
    </article>
  )
}

export function AppearsIn({
  items,
  onOpenChapter,
}: {
  items: readonly { chapter: MangaChapter; detail: string; alert?: boolean }[]
  onOpenChapter(chapter: number): void
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground">Appears in</p>
      {items.length ? (
        <ul className="flex flex-col divide-y overflow-hidden rounded-lg ring-1 ring-border">
          {items.map(({ chapter, detail, alert }) => (
            <li key={chapter.id}>
              <button
                type="button"
                onClick={() => onOpenChapter(chapter.number)}
                className="flex w-full items-center gap-3 px-3 py-2 text-left outline-none hover:bg-muted/50 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="w-6 shrink-0 text-sm text-muted-foreground tabular-nums">{chapter.number}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{chapter.title}</span>
                <span className={cn('shrink-0 text-xs tabular-nums', alert ? 'text-destructive' : 'text-muted-foreground')}>{detail}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No storyboard uses it yet.</p>
      )}
    </div>
  )
}

function CharacterDialog({
  character,
  open,
  onOpenChange,
}: {
  character: Character
  open: boolean
  onOpenChange(open: boolean): void
}) {
  const [appearance, setAppearance] = useState(character.appearance)
  const [lookName, setLookName] = useState('')
  const [lookChange, setLookChange] = useState('')

  const save = useMutation({
    mutationFn: ({ next, redraw }: { next: Character; redraw: string[] }) => updateCharacter(next, redraw),
  })

  const lookId = `${character.id}@${slug(lookName)}`
  const canAdd = lookName.trim() && lookChange.trim() && !character.looks.some((look) => look.id === lookId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit {character.name}</DialogTitle>
          <DialogDescription>{character.role}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`appearance-${character.id}`}>Appearance</Label>
          <Textarea
            id={`appearance-${character.id}`}
            rows={4}
            value={appearance}
            onChange={(event) => setAppearance(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Looks</p>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {character.looks.map((look) => (
              <li key={look.id} className="flex items-center gap-3 p-2">
                <SheetImage look={look} name={character.name} className="aspect-[3/2] w-20 shrink-0 rounded-sm object-cover" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{look.name}</p>
                  {look.change ? <p className="line-clamp-2 text-xs text-muted-foreground">{look.change}</p> : null}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!look.sheetKey || save.isPending}
                  onClick={() => save.mutate({ next: character, redraw: [look.id] })}
                >
                  <RefreshCcw data-icon="inline-start" />
                  Redraw
                </Button>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <p className="text-sm font-medium">Add a look</p>
          <Input aria-label="Look name" placeholder="Tournament robes" value={lookName} onChange={(event) => setLookName(event.target.value)} />
          <Input
            aria-label="What changes"
            placeholder="White silk robes, silver sash, white boots"
            value={lookChange}
            onChange={(event) => setLookChange(event.target.value)}
          />
          <Button
            variant="outline"
            disabled={!canAdd || save.isPending}
            onClick={() => {
              save.mutate({
                next: {
                  ...character,
                  looks: [...character.looks, { id: lookId, name: lookName.trim(), change: lookChange.trim(), sheetKey: null }],
                },
                redraw: [],
              })
              setLookName('')
              setLookChange('')
            }}
          >
            <Plus data-icon="inline-start" />
            Add look
          </Button>
        </div>

        {save.isError ? <p className="text-sm text-destructive">Could not save. {describeError(save.error)}</p> : null}

        <DialogFooter>
          <Button
            variant="outline"
            disabled={save.isPending || appearance.trim() === character.appearance}
            onClick={() => save.mutate({ next: { ...character, appearance: appearance.trim() }, redraw: [] })}
          >
            Save
          </Button>
          <Button
            disabled={save.isPending || appearance.trim() === character.appearance}
            onClick={() =>
              save.mutate({
                next: { ...character, appearance: appearance.trim() },
                redraw: character.looks.map((look) => look.id),
              })
            }
          >
            <RefreshCcw data-icon="inline-start" />
            Save and redraw
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
