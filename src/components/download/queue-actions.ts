import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'

import { useDatabaseReady } from '@/lib/db/provider'
import { dbKeys } from '@/lib/db/query-keys'
import { upsertChapters, upsertManga } from '@/lib/db/repositories'
import type { Chapter } from '@/lib/db/schema'
import { queueManager } from '@/lib/download/queue-manager'
import {
  enqueueChapters,
  listQueue,
  removeItem,
  reorderItem,
  retryItem,
} from '@/lib/download/queue-repository'
import {
  PENDING_QUEUE_STATES,
  TERMINAL_QUEUE_STATES,
} from '@/lib/download/queue-types'
import type { QueueItem } from '@/lib/download/queue-types'
import type { SChapter, SManga } from '@/lib/sources/types'

export interface EnqueueOutcome {
  queued: number
  /** Asked for but already saved, already waiting, or unrecordable. */
  skipped: number
}

const NO_ITEMS: ReadonlyMap<string, QueueItem> = new Map()

/**
 * Queue rows of one source, keyed by chapter url.
 *
 * Terminal rows are kept: a `failed` one is what the chapter's button turns
 * into to offer a retry, and a `done` one is retired on the way back in.
 *
 * The runtime invalidates `dbKeys.queue` on every tick and the root subscribes
 * to it, so a view holding this map re-renders as pages land — no polling.
 */
export function useQueueItemsByChapterUrl(
  sourceId: string,
): ReadonlyMap<string, QueueItem> {
  const ready = useDatabaseReady()

  const queue = useQuery({
    queryKey: dbKeys.queue,
    queryFn: listQueue,
    enabled: ready,
    staleTime: 0,
  })

  return useMemo(() => {
    if (!queue.data) return NO_ITEMS
    return new Map(
      queue.data
        .filter((item) => item.sourceId === sourceId)
        .map((item) => [item.chapterUrl, item]),
    )
  }, [queue.data, sourceId])
}

/** Chapter urls with outstanding work, for callers picking what to add next. */
export function pendingChapterUrls(
  items: ReadonlyMap<string, QueueItem>,
): ReadonlySet<string> {
  const urls = new Set<string>()
  for (const [url, item] of items) {
    if (PENDING_QUEUE_STATES.includes(item.state)) urls.add(url)
  }
  return urls
}

/** Drops the row, stopping the save behind it when one is already running. */
export async function cancelQueuedChapter(itemId: string): Promise<void> {
  queueManager.cancelItem(itemId)
  await removeItem(itemId)
}

export async function retryQueuedChapter(itemId: string): Promise<void> {
  await retryItem(itemId)
  queueManager.nudge()
}

/**
 * Records the chapters, then appends them to the queue.
 *
 * Both steps are needed: the queue keys on chapter row ids, and browsing a
 * series never creates those rows. `enqueueChapters` drops anything already
 * saved or already queued, so the count that comes back is what really landed.
 */
export async function enqueueChaptersForManga(
  sourceId: string,
  manga: SManga,
  chapters: readonly SChapter[],
): Promise<EnqueueOutcome> {
  if (chapters.length === 0) return { queued: 0, skipped: 0 }

  const mangaRow = await upsertManga(sourceId, manga)
  const rows = await upsertChapters(mangaRow.id, chapters)
  const byUrl = new Map(rows.map((row) => [row.url, row]))

  await dropCompletedRows(new Set(rows.map((row) => row.id)))

  const inserted = await enqueueChapters(
    chapters.flatMap((chapter) => {
      const row = byUrl.get(chapter.url)
      if (!row) return []
      return [
        {
          chapterId: row.id,
          mangaId: mangaRow.id,
          sourceId,
          mangaTitle: manga.title,
          chapterName: chapter.name,
          chapterUrl: chapter.url,
        },
      ]
    }),
  )

  queueManager.nudge()
  return { queued: inserted.length, skipped: chapters.length - inserted.length }
}

/**
 * Queues one chapter whose database row the caller already holds.
 *
 * The reader's path in: it resolves a chapter row anyway to track the reading
 * position, so going back through `enqueueChaptersForManga` would repeat that
 * work. `front` puts the chapter at the head of the queue, which is what a
 * reader asking for the chapter in front of them means.
 */
export async function enqueueChapterRow({
  sourceId,
  mangaTitle,
  row,
  front = false,
}: {
  sourceId: string
  mangaTitle: string
  row: Chapter
  front?: boolean
}): Promise<EnqueueOutcome> {
  await dropCompletedRows(new Set([row.id]))

  const inserted = await enqueueChapters([
    {
      chapterId: row.id,
      mangaId: row.mangaId,
      sourceId,
      mangaTitle,
      chapterName: row.name,
      chapterUrl: row.url,
    },
  ])

  const [item] = inserted
  if (item && front) await reorderItem(item.id, 0)

  queueManager.nudge()
  return { queued: inserted.length, skipped: 1 - inserted.length }
}

/**
 * A finished row keeps its chapter out of the queue for good — the unique
 * index is per chapter, not per attempt — so re-adding a chapter whose
 * download was removed or gave up has to retire the old row first.
 *
 * Every terminal state, not just `done`: a chapter that failed its attempts is
 * exactly the kind a user asks for again, and leaving the dead row behind would
 * make that request silently do nothing.
 */
async function dropCompletedRows(chapterIds: ReadonlySet<string>): Promise<void> {
  const existing = await listQueue()
  for (const row of existing) {
    if (TERMINAL_QUEUE_STATES.includes(row.state) && chapterIds.has(row.chapterId)) {
      await removeItem(row.id)
    }
  }
}

export function invalidateAfterEnqueue(
  queryClient: QueryClient,
  sourceId: string,
  mangaUrl: string,
): void {
  void queryClient.invalidateQueries({ queryKey: dbKeys.queue })
  void queryClient.invalidateQueries({ queryKey: dbKeys.queueSummary })
  void queryClient.invalidateQueries({
    queryKey: dbKeys.manga(sourceId, mangaUrl),
  })
  void queryClient.invalidateQueries({ queryKey: dbKeys.allChapters })
}
