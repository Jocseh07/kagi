import { desc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { HIDDEN, encodeLabel } from '@/lib/sync/fact-kinds'
import { bumpChangeSignal } from './change-signal'
import { db, getDeviceId, transact } from './client'
import type { DbTransaction } from './client'
import { assertFacts, chapterKeysOf } from './facts'
import { chapters, history, manga } from './schema'

/** The stamp every history write carries, matching `repositories.ts`. */
interface HistoryStamp {
  updatedAt: number
  deviceId: string
}

/**
 * Moves a chapter's history entry to now, creating it if this is the first
 * time the chapter has been opened.
 *
 * One row per chapter rather than one per visit: `listHistory` collapses the
 * page to a single entry per series anyway, so repeat rows would only ever be
 * sync traffic nobody sees. There is no unique index backing this, so the
 * dedupe is done here, inside the caller's transaction.
 *
 * The fact carries the chapter's name and number. A device that has never
 * fetched this series has no chapter row to join against, and those two fields
 * are the difference between a readable history page and an empty one.
 */
export async function touchHistory(
  tx: DbTransaction,
  mangaId: string,
  chapterId: string,
  stamp: HistoryStamp,
): Promise<void> {
  const [existing] = await tx
    .select({ id: history.id })
    .from(history)
    .where(eq(history.chapterId, chapterId))
    .limit(1)

  if (existing) {
    await tx
      .update(history)
      .set({ readAt: stamp.updatedAt, ...stamp })
      .where(eq(history.id, existing.id))
  } else {
    await tx
      .insert(history)
      .values({ id: ulid(), mangaId, chapterId, readAt: stamp.updatedAt, ...stamp })
  }

  await tx
    .update(manga)
    .set({ lastRead: stamp.updatedAt, ...stamp })
    .where(eq(manga.id, mangaId))

  const [key] = await chapterKeysOf(tx, [chapterId])
  if (key) {
    await assertFacts(tx, [
      {
        kind: 'hist',
        key: key.key,
        val: stamp.updatedAt,
        payload: encodeLabel({ n: key.name, i: key.chapterNumber }),
      },
    ])
  }
}

/**
 * Records that a chapter was opened.
 *
 * Reading is reading whether or not the chapter is finished — someone who
 * opens a prologue to try a series should find it in their history without
 * having to add the series to their library first. Marking a chapter read
 * goes through `touchHistory` too, so finishing what was opened updates the
 * one entry instead of adding a second.
 */
export async function recordChapterOpened(chapterId: string): Promise<void> {
  const stamp: HistoryStamp = { updatedAt: Date.now(), deviceId: getDeviceId() }

  const recorded = await transact(async (tx) => {
    const [row] = await tx
      .select({ mangaId: chapters.mangaId })
      .from(chapters)
      .where(eq(chapters.id, chapterId))
      .limit(1)
    if (!row) return false

    await touchHistory(tx, row.mangaId, chapterId, stamp)
    return true
  })

  if (recorded) bumpChangeSignal()
}

/** One row of the reading history, flattened for rendering. */
export interface HistoryItem {
  id: string
  readAt: number
  mangaId: string
  sourceId: string
  mangaUrl: string
  mangaTitle: string
  thumbnailUrl: string | null
  mangaMemo: Record<string, unknown> | null
  chapterId: string
  chapterUrl: string
  chapterName: string
  chapterNumber: number
  /** The scanlation group, where the source named one. */
  scanlator: string | null
  lastPageRead: number
  pageCount: number
  read: boolean
}

/**
 * Newest first, one entry per series.
 *
 * Every chapter marked read appends a row, so a series read end to end would
 * otherwise fill the whole page with itself. The collapse is done here rather
 * than in SQL because the join makes a `GROUP BY` with bare columns harder to
 * read than the two lines it replaces.
 */
export async function listHistory(limit = 100): Promise<HistoryItem[]> {
  const rows = await db
    .select({
      id: history.id,
      readAt: history.readAt,
      mangaId: manga.id,
      sourceId: manga.sourceId,
      mangaUrl: manga.url,
      mangaTitle: manga.title,
      thumbnailUrl: manga.thumbnailUrl,
      mangaMemo: manga.memo,
      chapterId: chapters.id,
      chapterUrl: chapters.url,
      chapterName: chapters.name,
      chapterNumber: chapters.chapterNumber,
      scanlator: chapters.scanlator,
      lastPageRead: chapters.lastPageRead,
      pageCount: chapters.pageCount,
      read: chapters.read,
    })
    .from(history)
    .innerJoin(chapters, eq(chapters.id, history.chapterId))
    .innerJoin(manga, eq(manga.id, history.mangaId))
    .orderBy(desc(history.readAt))

  const seen = new Set<string>()
  const items: HistoryItem[] = []
  for (const row of rows) {
    if (seen.has(row.mangaId)) continue
    seen.add(row.mangaId)
    items.push(row)
    if (items.length >= limit) break
  }
  return items
}

/**
 * The scanlation group of the chapter most recently opened in a series, or
 * null when nothing has been opened or the source named no group. What the
 * series page follows when the reader has never picked a group by hand.
 */
export async function lastReadScanlator(mangaId: string): Promise<string | null> {
  const [row] = await db
    .select({ scanlator: chapters.scanlator })
    .from(history)
    .innerJoin(chapters, eq(chapters.id, history.chapterId))
    .where(eq(history.mangaId, mangaId))
    .orderBy(desc(history.readAt))
    .limit(1)
  return row ? (row.scanlator?.trim() || null) : null
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  await transact(async (tx) => {
    const [entry] = await tx
      .select({ chapterId: history.chapterId })
      .from(history)
      .where(eq(history.id, id))
      .limit(1)
    await tx.delete(history).where(eq(history.id, id))
    if (!entry) return

    // Hidden, not forgotten. The entry stays in the ledger saying it should not
    // be shown, which is the only way the removal reaches another device — and
    // the only way re-reading the chapter can undo it later.
    const keys = await chapterKeysOf(tx, [entry.chapterId])
    await assertFacts(
      tx,
      keys.map((key) => ({ kind: 'hist' as const, key: key.key, state: HIDDEN })),
    )
  })
  bumpChangeSignal()
}

/** Drops every entry. Chapter read state is deliberately left alone. */
export async function clearHistory(): Promise<void> {
  await transact(async (tx) => {
    const rows = await tx
      .select({ id: history.id, chapterId: history.chapterId })
      .from(history)
    if (rows.length === 0) return
    await tx.delete(history)

    const keys = await chapterKeysOf(
      tx,
      rows.map((row) => row.chapterId),
    )
    await assertFacts(
      tx,
      keys.map((key) => ({ kind: 'hist' as const, key: key.key, state: HIDDEN })),
    )
  })
  bumpChangeSignal()
}
