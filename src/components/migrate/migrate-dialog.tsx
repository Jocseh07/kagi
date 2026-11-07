/**
 * The question asked once a replacement has been picked: what carries across,
 * and whether the old entry is being left behind or kept.
 *
 * The new source's chapter list is fetched here rather than by the caller, so
 * a source that cannot answer fails inside the dialog with nothing written —
 * and so the chapter counts either side are real numbers by the time the
 * reader decides.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'

import { MangaCover } from '@/components/manga-grid'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ErrorPanel } from '@/components/ui/error-panel'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import type { Manga } from '@/lib/db/schema'
import type { MigrateOptions } from '@/lib/migrate/migrate-series'
import type { SChapter, SManga, Source } from '@/lib/sources/types'

export interface MigrateChoice {
  toSource: Source
  toManga: SManga
  toChapters: readonly SChapter[]
  options: MigrateOptions
}

export function MigrateDialog({
  from,
  fromSourceName,
  target,
  open,
  onOpenChange,
  busy,
  error,
  onConfirm,
}: {
  from: Manga
  fromSourceName: string
  /** The picked entry. Null while nothing is picked, which keeps the dialog shut. */
  target: { source: Source; manga: SManga } | null
  open: boolean
  onOpenChange(open: boolean): void
  busy: boolean
  /** A failure from the migration itself, as opposed to from the fetch below. */
  error: unknown
  onConfirm(choice: MigrateChoice): void
}) {
  const [carryChapters, setCarryChapters] = useState(true)
  const [carryCategories, setCarryCategories] = useState(true)
  const [deleteDownloads, setDeleteDownloads] = useState(true)

  const detail = useQuery({
    queryKey: ['migrate-target', target?.source.id, target?.manga.url],
    queryFn: ({ signal }) =>
      target!.source.getMangaUpdate(
        target!.manga,
        { fetchDetails: true, fetchChapters: true },
        signal,
      ),
    enabled: Boolean(target) && open,
    staleTime: 5 * 60_000,
  })

  const chapters = detail.data?.chapters ?? []

  function confirm(removeOld: boolean) {
    if (!target || !detail.data) return
    onConfirm({
      toSource: target.source,
      toManga: detail.data.manga,
      toChapters: detail.data.chapters,
      options: {
        chapters: carryChapters,
        categories: carryCategories,
        removeOld,
        deleteDownloads: deleteDownloads,
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={busy ? () => undefined : onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Migrate series</DialogTitle>
          <DialogDescription>
            Chapters match by number, so a source that numbers differently
            carries less across.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-3">
          <SeriesSide
            title={from.title}
            sourceName={fromSourceName}
            cover={from.thumbnailUrl}
          />
          <ArrowRight className="size-4 shrink-0 self-center text-muted-foreground" />
          <SeriesSide
            title={target?.manga.title ?? ''}
            sourceName={target?.source.name ?? ''}
            cover={target?.manga.thumbnailUrl}
            note={
              detail.isPending
                ? 'Checking chapters'
                : `${chapters.length} chapter${chapters.length === 1 ? '' : 's'}`
            }
          />
        </div>

        {detail.isError ? (
          <ErrorPanel
            error={detail.error}
            onRetry={() => void detail.refetch()}
          />
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            <OptionRow
              id="migrate-chapters"
              label="Read progress and bookmarks"
              checked={carryChapters}
              disabled={busy}
              onChange={setCarryChapters}
            />
            <OptionRow
              id="migrate-categories"
              label="Categories"
              checked={carryCategories}
              disabled={busy}
              onChange={setCarryCategories}
            />
            <OptionRow
              id="migrate-downloads"
              label="Delete downloads from the old source"
              description="Kept if you copy instead."
              checked={deleteDownloads}
              disabled={busy}
              onChange={setDeleteDownloads}
            />
          </div>
        )}

        {Boolean(error) && <ErrorPanel error={error} />}

        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy || !detail.data}
            onClick={() => confirm(false)}
          >
            Copy
          </Button>
          <Button disabled={busy || !detail.data} onClick={() => confirm(true)}>
            {busy ? 'Migrating' : 'Migrate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SeriesSide({
  title,
  sourceName,
  cover,
  note,
}: {
  title: string
  sourceName: string
  cover?: string | null
  note?: string
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="w-16">
        {title ? (
          <MangaCover url={cover ?? undefined} />
        ) : (
          <Skeleton className="aspect-[2/3] w-full rounded-lg" />
        )}
      </div>
      <p className="mt-2 line-clamp-2 text-sm font-medium">{title}</p>
      <p className="truncate text-xs text-muted-foreground">{sourceName}</p>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  )
}

function OptionRow({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string
  label: string
  description?: string
  checked: boolean
  disabled: boolean
  onChange(next: boolean): void
}) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label htmlFor={id} className="font-normal">
          {label}
        </Label>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className="shrink-0"
      />
    </div>
  )
}
