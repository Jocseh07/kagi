import type { ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Download } from 'lucide-react'

import { DownloadRing } from '@/components/download/download-ring'
import {
  cancelQueuedChapter,
  retryQueuedChapter,
} from '@/components/download/queue-actions'
import type { QueueItem } from '@/lib/download/queue-types'
import { supportsOfflineSave } from '@/lib/offline/types'
import { notify } from '@/lib/ui/toast'

import { ToolbarButton } from './ui'

interface DownloadChapterButtonProps {
  /** Whether this chapter's pages are already on this device. */
  saved: boolean
  /** This chapter's download queue row, in any state, when it has one. */
  item: QueueItem | undefined
  /** Blocks the action while its prerequisites (the database) are unavailable. */
  disabled?: boolean
  /** Queues this chapter, at the head of the queue. */
  onDownload(): Promise<unknown>
  /** Drops the offline copy. */
  onRemove(): Promise<unknown>
  /** Called after the saved set or the queue changes, so the caller refetches. */
  onChanged(): void
}

/**
 * The reader's download control.
 *
 * Same states as the series page's button and the same queue behind it — only
 * the shell differs, because the reader carries its own palette. A chapter
 * queued from here goes to the front: it is the one being read.
 */
export function DownloadChapterButton({
  saved,
  item,
  disabled = false,
  onDownload,
  onRemove,
  onChanged,
}: DownloadChapterButtonProps) {
  const act = useMutation({
    mutationFn: async (action: Action) => {
      if (action === 'download') await onDownload()
      else if (action === 'remove') await onRemove()
      else if (item) {
        if (action === 'cancel') await cancelQueuedChapter(item.id)
        else await retryQueuedChapter(item.id)
      }
      return action
    },
    // The reader is the one place a failure had nowhere to go: its label
    // changed and the reason sat in a `title` no touch device can reach.
    onSuccess: (action) => {
      if (action === 'download') notify.success('Queued for download')
      else if (action === 'remove') notify.success('Removed the saved copy')
    },
    onError: (error, action) => notify.error(FAILURE[action], error),
    onSettled: onChanged,
  })

  if (!supportsOfflineSave()) return null

  const state = describe(saved, item)

  return (
    <ToolbarButton
      variant={state.variant}
      disabled={disabled || act.isPending}
      title={state.title}
      onClick={() => act.mutate(state.action)}
    >
      {state.ring}
      {state.label}
    </ToolbarButton>
  )
}

type Action = 'download' | 'cancel' | 'retry' | 'remove'

const FAILURE: Record<Action, string> = {
  download: 'Could not queue this chapter',
  cancel: 'Could not remove this download',
  retry: 'Could not restart this download',
  remove: 'Could not remove the saved copy',
}

interface Presentation {
  ring: ReactNode
  label: string
  title: string
  action: Action
  variant: 'solid' | 'ghost' | 'accent'
}

function describe(saved: boolean, item: QueueItem | undefined): Presentation {
  if (saved) {
    return {
      ring: null,
      label: 'Saved offline',
      title: 'This chapter is kept for offline reading — tap to remove it',
      action: 'remove',
      variant: 'accent',
    }
  }

  if (item?.state === 'active') {
    const total = item.pagesTotal
    const done = Math.min(item.pagesCompleted, total)
    const counted = total > 0
    const percent = `${Math.round((done / (total || 1)) * 100)}%`
    return {
      ring: (
        <DownloadRing
          value={done}
          max={total}
          indeterminate={!counted}
          stop
          label={counted ? `Downloading — ${percent}` : 'Fetching the page list'}
          className="size-4"
        />
      ),
      label: counted ? percent : 'Starting…',
      title: 'Downloading — tap to cancel',
      action: 'cancel',
      variant: 'solid',
    }
  }

  if (item?.state === 'queued' || item?.state === 'paused') {
    return {
      ring: <DownloadRing value={0} max={1} label="Waiting" className="size-4" />,
      label: item.state === 'paused' ? 'Paused' : 'Queued',
      title: 'Waiting in the download queue — tap to remove',
      action: 'cancel',
      variant: 'solid',
    }
  }

  if (item?.state === 'failed') {
    return {
      ring: null,
      label: 'Retry download',
      title: item.lastError ?? 'This download failed — tap to try again',
      action: 'retry',
      variant: 'solid',
    }
  }

  return {
    ring: <Download aria-hidden className="size-4" />,
    label: 'Download',
    title: 'Keep this chapter for offline reading',
    action: 'download',
    variant: 'solid',
  }
}
