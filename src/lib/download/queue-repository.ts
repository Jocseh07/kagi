/**
 * Persistence for the download queue.
 *
 * Multi-statement writes go through `transact()` — drizzle's sqlite-proxy
 * driver has no native transactions and emits BEGIN/COMMIT as ordinary
 * statements, so `db.transaction()` would interleave with other callers.
 */

import { and, asc, count, eq, inArray, isNotNull, max, sql, sum } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, getDeviceId, transact } from '@/lib/db/client'
import { CHUNK_SIZE, chunk } from '@/lib/db/chunk'
import { chapters, downloadQueue } from '@/lib/db/schema'
import { projectQuotaCost } from '@/lib/offline/types'
import { PENDING_QUEUE_STATES, TERMINAL_QUEUE_STATES } from './queue-types'
import type {
  EnqueueChapterInput,
  QueueCounts,
  QueueItem,
  QueueItemPatch,
  QueueState,
  QueueSummary,
} from './queue-types'

// The download queue is device-local by design and never syncs, so its writes
// carry no dirty flag and no tombstones — only the shared updatedAt/deviceId
// stamp every table has.

function stamp(): { updatedAt: number; deviceId: string } {
  return { updatedAt: Date.now(), deviceId: getDeviceId() }
}

function definedOnly<T extends object>(value: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry
  }
  return out as Partial<T>
}

/** Projection matching `QueueItem` exactly, so no row mapping is needed. */
const itemColumns = {
  id: downloadQueue.id,
  chapterId: downloadQueue.chapterId,
  mangaId: downloadQueue.mangaId,
  sourceId: downloadQueue.sourceId,
  mangaTitle: downloadQueue.mangaTitle,
  chapterName: downloadQueue.chapterName,
  chapterUrl: downloadQueue.chapterUrl,
  state: downloadQueue.state,
  position: downloadQueue.position,
  pagesCompleted: downloadQueue.pagesCompleted,
  pagesTotal: downloadQueue.pagesTotal,
  attempts: downloadQueue.attempts,
  lastError: downloadQueue.lastError,
  queuedAt: downloadQueue.queuedAt,
  startedAt: downloadQueue.startedAt,
  finishedAt: downloadQueue.finishedAt,
}

const idColumn = { id: downloadQueue.id }

// ------------------------------------------------------------------ writes --

/**
 * Appends chapters to the tail of the queue, skipping any that are already
 * queued (the unique index on `chapter_id` would reject them anyway) or already
 * saved offline. Returns only the rows that were actually inserted.
 */
export async function enqueueChapters(
  items: readonly EnqueueChapterInput[],
): Promise<QueueItem[]> {
  if (items.length === 0) return []

  // Last entry wins when one call repeats a chapter.
  const pending = new Map(items.map((item) => [item.chapterId, item]))
  const chapterIds = [...pending.keys()]
  const { updatedAt, deviceId } = stamp()

  // Every statement below is chunked: one bound parameter per id in the
  // lookups, thirteen per row in the insert, against SQLite's 999-parameter
  // limit. "All unread" on a long series would blow past it in one statement.
  const idGroups = chunk(chapterIds, CHUNK_SIZE)

  return await transact(async (tx) => {
    for (const ids of idGroups) {
      const queued = await tx
        .select({ chapterId: downloadQueue.chapterId })
        .from(downloadQueue)
        .where(inArray(downloadQueue.chapterId, ids))
      for (const row of queued) pending.delete(row.chapterId)
    }

    for (const ids of idGroups) {
      const saved = await tx
        .select({ id: chapters.id })
        .from(chapters)
        .where(and(inArray(chapters.id, ids), isNotNull(chapters.savedAt)))
      for (const row of saved) pending.delete(row.id)
    }

    const fresh = [...pending.values()]
    if (fresh.length === 0) return []

    const [tail] = await tx
      .select({ position: max(downloadQueue.position) })
      .from(downloadQueue)
    let position = Number(tail?.position ?? -1) + 1

    // Multi-row inserts: per-row inserts through the worker proxy are slow.
    const rows: QueueItem[] = []
    for (const group of chunk(fresh, CHUNK_SIZE)) {
      const inserted = await tx
        .insert(downloadQueue)
        .values(
          group.map((item) => ({
            id: ulid(),
            updatedAt,
            deviceId,
            chapterId: item.chapterId,
            mangaId: item.mangaId,
            sourceId: item.sourceId,
            mangaTitle: item.mangaTitle,
            chapterName: item.chapterName,
            chapterUrl: item.chapterUrl,
            state: 'queued' as const,
            position: position++,
            pagesTotal: item.pagesTotal ?? 0,
            queuedAt: updatedAt,
          })),
        )
        .returning(itemColumns)
      rows.push(...inserted)
    }

    return rows
  })
}

export async function setItemState(
  id: string,
  state: QueueState,
  patch: QueueItemPatch = {},
): Promise<QueueItem | null> {
  const { updatedAt, deviceId } = stamp()
  const changes = definedOnly(patch)

  return await transact(async (tx) => {
    const [row] = await tx
      .update(downloadQueue)
      .set({ ...changes, state, updatedAt, deviceId })
      .where(eq(downloadQueue.id, id))
      .returning(itemColumns)
    return row ?? null
  })
}

/**
 * Called as pages land, so the runtime should throttle it: every call is a
 * transaction.
 */
export async function updateItemProgress(
  id: string,
  pagesCompleted: number,
  pagesTotal: number,
): Promise<void> {
  const { updatedAt, deviceId } = stamp()
  await transact(async (tx) => {
    await tx
      .update(downloadQueue)
      .set({ pagesCompleted, pagesTotal, updatedAt, deviceId })
      .where(eq(downloadQueue.id, id))
  })
}

export async function removeItem(id: string): Promise<boolean> {
  return await transact(async (tx) => {
    const rows = await tx
      .delete(downloadQueue)
      .where(eq(downloadQueue.id, id))
      .returning(idColumn)
    return rows.length > 0
  })
}

/** Drops every `done`, `failed` and `cancelled` row. Returns how many went. */
export async function clearFinished(): Promise<number> {
  return await transact(async (tx) => {
    const rows = await tx
      .delete(downloadQueue)
      .where(inArray(downloadQueue.state, [...TERMINAL_QUEUE_STATES]))
      .returning(idColumn)
    return rows.length
  })
}

export async function clearAll(): Promise<number> {
  return await transact(async (tx) => {
    const rows = await tx.delete(downloadQueue).returning(idColumn)
    return rows.length
  })
}

/**
 * Moves a row to `newPosition`, treated as an index into the current order.
 *
 * Positions go sparse as rows are removed, so the whole queue is renumbered
 * contiguously and only the rows whose index actually changed are written —
 * as a single CASE update rather than one statement per row.
 */
export async function reorderItem(
  id: string,
  newPosition: number,
): Promise<void> {
  const { updatedAt, deviceId } = stamp()

  await transact(async (tx) => {
    const rows = await tx
      .select({ id: downloadQueue.id, position: downloadQueue.position })
      .from(downloadQueue)
      .orderBy(asc(downloadQueue.position))

    const from = rows.findIndex((row) => row.id === id)
    if (from === -1) return

    const to = Math.min(Math.max(Math.trunc(newPosition), 0), rows.length - 1)
    if (to === from) return

    const order = rows.map((row) => row.id)
    const [moved] = order.splice(from, 1)
    if (!moved) return
    order.splice(to, 0, moved)

    const current = new Map(rows.map((row) => [row.id, row.position]))
    const changed = order
      .map((rowId, index) => ({ id: rowId, position: index }))
      .filter((entry) => current.get(entry.id) !== entry.position)
    if (changed.length === 0) return

    // No ELSE branch: the WHERE clause below restricts the update to exactly
    // the ids the CASE enumerates, so every row matches a branch.
    const branches = sql.join(
      changed.map(
        (entry) => sql`when ${downloadQueue.id} = ${entry.id} then ${entry.position}`,
      ),
      sql` `,
    )

    await tx
      .update(downloadQueue)
      .set({ position: sql`case ${branches} end`, updatedAt, deviceId })
      .where(
        inArray(
          downloadQueue.id,
          changed.map((entry) => entry.id),
        ),
      )
  })
}

/**
 * Holds the queue. `active` rows are paused alongside `queued` ones so the
 * runtime sees the flip and aborts whatever is in flight.
 */
export async function pauseAll(): Promise<number> {
  const { updatedAt, deviceId } = stamp()
  return await transact(async (tx) => {
    const rows = await tx
      .update(downloadQueue)
      .set({ state: 'paused', updatedAt, deviceId })
      .where(inArray(downloadQueue.state, ['queued', 'active']))
      .returning(idColumn)
    return rows.length
  })
}

export async function resumeAll(): Promise<number> {
  const { updatedAt, deviceId } = stamp()
  return await transact(async (tx) => {
    const rows = await tx
      .update(downloadQueue)
      .set({ state: 'queued', updatedAt, deviceId })
      .where(eq(downloadQueue.state, 'paused'))
      .returning(idColumn)
    return rows.length
  })
}

/**
 * Puts a failed row back in line with a clean slate. Page progress resets too:
 * a save restarts from the first page, so a stale count would only misreport.
 */
export async function retryItem(id: string): Promise<QueueItem | null> {
  const { updatedAt, deviceId } = stamp()
  return await transact(async (tx) => {
    const [row] = await tx
      .update(downloadQueue)
      .set({
        state: 'queued',
        attempts: 0,
        lastError: null,
        pagesCompleted: 0,
        startedAt: null,
        finishedAt: null,
        updatedAt,
        deviceId,
      })
      .where(eq(downloadQueue.id, id))
      .returning(itemColumns)
    return row ?? null
  })
}

/**
 * Clears `active` rows left behind by a previous session.
 *
 * Nothing is fetching for them any more — the tab that was is gone — and their
 * pages were never verified, so an `active` row on boot is not work in
 * progress, it is work that was interrupted. Back to `queued` for a fresh run.
 */
export async function rehydrateOnBoot(): Promise<number> {
  const { updatedAt, deviceId } = stamp()
  return await transact(async (tx) => {
    const rows = await tx
      .update(downloadQueue)
      .set({
        state: 'queued',
        pagesCompleted: 0,
        startedAt: null,
        updatedAt,
        deviceId,
      })
      .where(eq(downloadQueue.state, 'active'))
      .returning(idColumn)
    return rows.length
  })
}

// ------------------------------------------------------------------- reads --

export function listQueue(): Promise<QueueItem[]> {
  return db
    .select(itemColumns)
    .from(downloadQueue)
    .orderBy(asc(downloadQueue.position))
}

/** The next rows to work on, oldest position first. */
export function nextQueued(limit: number): Promise<QueueItem[]> {
  return db
    .select(itemColumns)
    .from(downloadQueue)
    .where(eq(downloadQueue.state, 'queued'))
    .orderBy(asc(downloadQueue.position))
    .limit(limit)
}

export async function getQueueSummary(): Promise<QueueSummary> {
  const rows = await db
    .select({
      state: downloadQueue.state,
      items: count(),
      pages: sum(downloadQueue.pagesTotal),
    })
    .from(downloadQueue)
    .groupBy(downloadQueue.state)

  const counts: QueueCounts = {
    queued: 0,
    active: 0,
    paused: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  }
  let total = 0
  let pendingPages = 0

  for (const row of rows) {
    counts[row.state] = row.items
    total += row.items
    // `sum` comes back as a string from the driver.
    if (PENDING_QUEUE_STATES.includes(row.state)) {
      pendingPages += Number(row.pages ?? 0)
    }
  }

  return { counts, total, projectedBytes: projectQuotaCost(pendingPages) }
}
