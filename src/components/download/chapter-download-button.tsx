import { memo } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { CircleAlert, CircleCheck, Clock, Download } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useDatabaseReady } from '@/lib/db/provider'
import { dbKeys } from '@/lib/db/query-keys'
import { upsertChapters, upsertManga } from '@/lib/db/repositories'
import { unsaveChapter } from '@/lib/offline/save-chapter'
import { supportsOfflineSave } from '@/lib/offline/types'
import { notify } from '@/lib/ui/toast'
import type { QueueItem } from '@/lib/download/queue-types'
import type { SChapter, SManga } from '@/lib/sources/types'

import { DownloadRing } from './download-ring'
import {
  cancelQueuedChapter,
  enqueueChaptersForManga,
  invalidateAfterEnqueue,
  retryQueuedChapter,
} from './queue-actions'

export interface ChapterDownloadButtonProps {
  sourceId: string
  manga: SManga
  chapter: SChapter
  /** Whether the chapter's pages are already on this device. */
  saved: boolean
  /** This chapter's queue row, in any state, when it has one. */
  item: QueueItem | undefined
  /** Fired once a download has actually joined the queue, not on cancel. */
  onQueued?: () => void
}

/**
 * The one download affordance a chapter has.
 *
 * Every state of a chapter's download lives on this single button — waiting,
 * running, failed, done — because they are the same idea at different moments,
 * and the queue row plus the chapter's own `savedAt` already say which moment
 * it is. Nothing here saves a chapter directly: the tap only edits the queue,
 * and the runtime does the work.
 *
 * Memoized because it hangs off a virtualized chapter row, which re-renders on
 * every scroll frame; only the queue row it is handed actually changes.
 */
export const ChapterDownloadButton = memo(function ChapterDownloadButton({
  sourceId,
  manga,
  chapter,
  saved,
  item,
  onQueued,
}: ChapterDownloadButtonProps) {
  const ready = useDatabaseReady()
  const queryClient = useQueryClient()
  const router = useRouter()
  const openDownloads = () => void router.navigate({ to: '/downloads' })

  const act = useMutation({
    mutationFn: async (action: Action) => {
      if (action === 'download') {
        await enqueueChaptersForManga(sourceId, manga, [chapter])
        return action
      }
      if (action === 'remove') {
        await removeSavedChapter(sourceId, manga, chapter)
        return action
      }
      if (!item) return action
      if (action === 'cancel') {
        await cancelQueuedChapter(item.id)
        return action
      }
      await retryQueuedChapter(item.id)
      return action
    },
    // The button itself already shows queued, running and saved, so only the
    // two actions that leave no trace on it are worth a toast — plus the
    // failure, whose only other home is a `title` no touch device can show.
    onSuccess: (action) => {
      if (action === 'download') {
        notify.success('Queued for download', {
          description: chapter.name,
          action: { label: 'Downloads', onClick: openDownloads },
        })
        onQueued?.()
        return
      }
      if (action === 'remove') {
        notify.success('Removed the saved copy', { description: chapter.name })
      }
    },
    onError: (error, action) => {
      notify.error(FAILURE[action], error, { description: chapter.name })
    },
    onSettled: () => {
      invalidateAfterEnqueue(queryClient, sourceId, manga.url)
      void queryClient.invalidateQueries({ queryKey: dbKeys.savedChapters })
      void queryClient.invalidateQueries({ queryKey: dbKeys.storage })
      void queryClient.invalidateQueries({ queryKey: ['db', 'saved-chapter-ids'] })
      void queryClient.invalidateQueries({ queryKey: ['db', 'chapter-saved'] })
    },
  })

  if (!supportsOfflineSave()) return null

  const busy = !ready || act.isPending
  const state = describe(saved, item)

  return (
    <Button
      variant={state.variant}
      size="icon-sm"
      className="shrink-0 max-sm:size-8"
      disabled={busy}
      title={state.title}
      aria-label={state.title}
      onClick={() => act.mutate(state.action)}
    >
      {state.icon}
    </Button>
  )
})

type Action = 'download' | 'cancel' | 'retry' | 'remove'

const FAILURE: Record<Action, string> = {
  download: 'Could not queue that chapter',
  cancel: 'Could not remove that download',
  retry: 'Could not restart that download',
  remove: 'Could not remove the saved copy',
}

interface Presentation {
  icon: ReactNode
  title: string
  action: Action
  variant: 'ghost' | 'outline' | 'secondary' | 'destructive'
}

function describe(saved: boolean, item: QueueItem | undefined): Presentation {
  if (saved) {
    return {
      icon: <CircleCheck className="fill-primary/15 text-primary" />,
      title: 'Saved for offline reading — remove the copy',
      action: 'remove',
      variant: 'secondary',
    }
  }

  if (item?.state === 'active') {
    const total = item.pagesTotal
    const percent = `${Math.round((Math.min(item.pagesCompleted, total) / (total || 1)) * 100)}%`
    return {
      icon: (
        <DownloadRing
          value={item.pagesCompleted}
          max={total}
          // The page list is fetched before the pages themselves, so a fresh
          // row has nothing to divide by yet.
          indeterminate={total <= 0}
          stop
          label={
            total > 0 ? `Downloading — ${percent}` : 'Fetching the page list'
          }
          className="size-4"
        />
      ),
      title:
        total > 0
          ? `Downloading — ${percent} — tap to cancel`
          : 'Fetching the page list — tap to cancel',
      action: 'cancel',
      variant: 'secondary',
    }
  }

  if (item?.state === 'queued' || item?.state === 'paused') {
    return {
      icon: <Clock />,
      title:
        item.state === 'paused'
          ? 'Paused in the download queue — tap to remove'
          : 'Waiting in the download queue — tap to remove',
      action: 'cancel',
      variant: 'secondary',
    }
  }

  if (item?.state === 'failed') {
    return {
      icon: <CircleAlert />,
      title: `${item.lastError ?? 'This download failed'} — tap to try again`,
      action: 'retry',
      variant: 'destructive',
    }
  }

  return {
    icon: <Download />,
    title: 'Download for offline reading',
    action: 'download',
    variant: 'outline',
  }
}

/**
 * Removing needs the chapter's row id, and a saved chapter always has one —
 * but the series page holds source payloads, not rows, so it is resolved the
 * same way the download path resolves it.
 */
async function removeSavedChapter(
  sourceId: string,
  manga: SManga,
  chapter: SChapter,
): Promise<void> {
  const mangaRow = await upsertManga(sourceId, manga)
  const [row] = await upsertChapters(mangaRow.id, [chapter])
  if (!row) throw new Error('Could not find this chapter in the library database.')
  await unsaveChapter(row.id)
}
