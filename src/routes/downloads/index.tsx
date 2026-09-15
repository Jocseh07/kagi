import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download } from 'lucide-react'

import { OfflineSupportNotice } from '@/components/download/offline-support-notice'
import { QueueList } from '@/components/download/queue-list'
import { QueueSummaryBar } from '@/components/download/queue-summary-bar'
import { useQueueRuntime } from '@/components/download/use-queue-runtime'
import { PageContainer } from '@/components/page-container'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorPanel } from '@/components/ui/error-panel'
import { Skeleton } from '@/components/ui/skeleton'
import { useDatabase } from '@/lib/db/provider'
import { dbKeys } from '@/lib/db/query-keys'
import { queueManager } from '@/lib/download/queue-manager'
import {
  clearAll,
  clearFinished,
  getQueueSummary,
  listQueue,
  removeItem,
  reorderItem,
  retryItem,
} from '@/lib/download/queue-repository'
import type { QueueItem, QueueSummary } from '@/lib/download/queue-types'

export const Route = createFileRoute('/downloads/')({
  component: DownloadsPage,
  pendingComponent: DownloadsPending,
})

type BulkAction = 'pause' | 'resume' | 'clear-finished' | 'clear-all'

interface ItemAction {
  kind: 'retry' | 'remove' | 'move'
  item: QueueItem
  /** Target index in the whole queue; only used by `move`. */
  position: number
}

const EMPTY_SUMMARY: QueueSummary = {
  counts: { queued: 0, active: 0, paused: 0, done: 0, failed: 0, cancelled: 0 },
  total: 0,
  projectedBytes: 0,
}

function DownloadsPage() {
  const { status, error } = useDatabase()
  const ready = status === 'ready'
  const queryClient = useQueryClient()

  const queue = useQuery({
    queryKey: dbKeys.queue,
    queryFn: listQueue,
    enabled: ready,
    staleTime: 0,
  })

  const summaryQuery = useQuery({
    queryKey: dbKeys.queueSummary,
    queryFn: getQueueSummary,
    enabled: ready,
    staleTime: 0,
  })

  const summary = summaryQuery.data ?? EMPTY_SUMMARY

  // Mounting the hook starts the runtime; it is deliberately not stopped when
  // this page unmounts, so downloads continue while the user reads elsewhere.
  const runtime = useQueueRuntime(summary.counts.queued)

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: dbKeys.queue })
    void queryClient.invalidateQueries({ queryKey: dbKeys.queueSummary })
  }

  const bulk = useMutation({
    mutationFn: async (action: BulkAction) => {
      if (action === 'pause') {
        await queueManager.pause()
        return
      }
      if (action === 'resume') {
        await queueManager.resume()
        return
      }
      if (action === 'clear-finished') {
        await clearFinished()
        return
      }
      // Rows about to be deleted must not keep a save running behind them.
      queueManager.stop()
      await clearAll()
    },
    onSettled: invalidate,
  })

  const single = useMutation({
    mutationFn: async ({ kind, item, position }: ItemAction) => {
      if (kind === 'retry') {
        await retryItem(item.id)
        queueManager.nudge()
        return
      }
      if (kind === 'remove') {
        queueManager.cancelItem(item.id)
        await removeItem(item.id)
        return
      }
      await reorderItem(item.id, position)
    },
    onSettled: invalidate,
  })

  const items = queue.data ?? []
  const busyId = single.isPending ? single.variables.item.id : null

  return (
    <PageContainer>
      <h1 className="text-xl font-semibold tracking-tight">Downloads</h1>

      <OfflineSupportNotice />

      {status === 'error' ? (
        <ErrorPanel
          error={error ?? new Error('The library database is unavailable.')}
        />
      ) : queue.isError ? (
        <ErrorPanel error={queue.error} onRetry={() => void queue.refetch()} />
      ) : queue.isPending ? (
        <QueueSkeleton />
      ) : (
        <>
          <QueueSummaryBar
            summary={summary}
            runtime={runtime}
            busy={bulk.isPending}
            disabled={!ready}
            onPause={() => bulk.mutate('pause')}
            onResume={() => bulk.mutate('resume')}
            onClearFinished={() => bulk.mutate('clear-finished')}
            onClearAll={() => bulk.mutate('clear-all')}
          />

          {(bulk.isError || single.isError) && (
            <p className="text-xs text-destructive">
              Could not update the queue:{' '}
              {messageOf(bulk.error ?? single.error)}
            </p>
          )}

          {items.length === 0 ? (
            <EmptyQueue />
          ) : (
            <QueueList
              items={items}
              busyId={busyId}
              disabled={!ready}
              onRetry={(item) =>
                single.mutate({ kind: 'retry', item, position: 0 })
              }
              onRemove={(item) =>
                single.mutate({ kind: 'remove', item, position: 0 })
              }
              onMove={(item, index, direction) =>
                single.mutate({
                  kind: 'move',
                  item,
                  position: index + direction,
                })
              }
            />
          )}
        </>
      )}
    </PageContainer>
  )
}

function EmptyQueue() {
  return (
    <EmptyState
      icon={Download}
      title="Nothing queued"
      description="Add chapters from a series page and they are downloaded here, one source at a time, so nothing trips the site's rate limit."
      action={
        <Button asChild variant="outline" size="sm">
          <Link to="/library">Open library</Link>
        </Button>
      }
    />
  )
}

/** The route's shape while its chunk loads; the heading is a constant. */
function DownloadsPending() {
  return (
    <PageContainer>
      <h1 className="text-xl font-semibold tracking-tight">Downloads</h1>
      <QueueSkeleton />
    </PageContainer>
  )
}

function QueueSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-16 w-full rounded-lg" />
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} className="h-14 w-full rounded-lg" />
      ))}
    </div>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
