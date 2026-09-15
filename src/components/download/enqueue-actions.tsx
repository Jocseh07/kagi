import { useRouter } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ListPlus } from 'lucide-react'

import {
  MangaActionButton,
  MangaActionSlot,
} from '@/components/manga/manga-action-row'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useDatabaseReady } from '@/lib/db/provider'
import type { Chapter } from '@/lib/db/schema'
import { supportsOfflineSave } from '@/lib/offline/types'
import { notify } from '@/lib/ui/toast'
import type { SChapter, SManga } from '@/lib/sources/types'

import { enqueueChaptersForManga, invalidateAfterEnqueue } from './queue-actions'

/** Batch sizes offered next to "all unread". */
const BATCH_SIZES = [10, 25, 50, 100] as const

export interface QueueUnreadButtonProps {
  sourceId: string
  manga: SManga
  /** Every chapter of the series, oldest first. */
  chapters: readonly SChapter[]
  /** Stored chapter rows keyed by source url, holding read and saved state. */
  rows: ReadonlyMap<string, Chapter>
  queuedUrls: ReadonlySet<string>
  /** Fired once chapters have actually joined the queue. */
  onQueued?: () => void
}

export function QueueUnreadButton({
  sourceId,
  manga,
  chapters,
  rows,
  queuedUrls,
  onQueued,
}: QueueUnreadButtonProps) {
  const ready = useDatabaseReady()
  const queryClient = useQueryClient()
  const router = useRouter()

  const candidates = chapters.filter((chapter) => {
    const row = rows.get(chapter.url)
    if (row?.read) return false
    if (row?.savedAt != null) return false
    return !queuedUrls.has(chapter.url)
  })

  const add = useMutation({
    mutationFn: (count: number) =>
      enqueueChaptersForManga(sourceId, manga, candidates.slice(0, count)),
    // The queue lives on another page, so the outcome is reported where the
    // tap happened and carries the way to go and watch it.
    onSuccess: (outcome) => {
      invalidateAfterEnqueue(queryClient, sourceId, manga.url)
      if (outcome.queued === 0) {
        notify.success('Nothing added', {
          description: 'Those chapters are already saved or queued.',
        })
        return
      }
      notify.success(
        `Queued ${outcome.queued} ${outcome.queued === 1 ? 'chapter' : 'chapters'}`,
        {
          description:
            outcome.skipped > 0
              ? `Skipped ${outcome.skipped} already saved or queued.`
              : undefined,
          action: {
            label: 'Downloads',
            onClick: () => void router.navigate({ to: '/downloads' }),
          },
        },
      )
      onQueued?.()
    },
    onError: (error) => notify.error('Could not queue those chapters', error),
  })

  if (!supportsOfflineSave()) return null

  return (
    <MangaActionSlot>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <MangaActionButton
            icon={ListPlus}
            label={add.isPending ? 'Adding…' : 'Download'}
            disabled={!ready || candidates.length === 0 || add.isPending}
            title={
              candidates.length === 0
                ? 'Every chapter is read, saved or already queued'
                : 'Add unread chapters to the download queue'
            }
          />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start">
          {BATCH_SIZES.filter((size) => size < candidates.length).map((size) => (
            <DropdownMenuItem key={size} onSelect={() => add.mutate(size)}>
              Next {size}
            </DropdownMenuItem>
          ))}

          <DropdownMenuItem onSelect={() => add.mutate(candidates.length)}>
            All unread ({candidates.length})
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </MangaActionSlot>
  )
}
