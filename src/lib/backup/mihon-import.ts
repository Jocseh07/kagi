/**
 * Merging a Mihon backup into the local library.
 *
 * A merge, never a replace. The rule the whole file is built around: **an
 * import may only ever move progress forward.** A chapter already read stays
 * read, a further page position wins over a shorter one, and a local chapter
 * the backup does not mention is left untouched. Nothing is deleted, and saved
 * pages, downloads and queue rows are never involved.
 *
 * The one deliberate exception is a chapter with `progressResetAt` set: marking
 * something unread is an explicit instruction, so an import does not undo it.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { ulid } from 'ulid'

import { bumpChangeSignal } from '@/lib/db/change-signal'
import { getDeviceId, transact } from '@/lib/db/client'
import type { DbTransaction } from '@/lib/db/client'
import { assertFact, stateSeriesFacts } from '@/lib/db/facts'
import { CHUNK_SIZE, chunk } from '@/lib/db/repositories'
import { PRESENT, categoryKey } from '@/lib/sync/fact-kinds'
import {
  categories as categoriesTable,
  chapters as chaptersTable,
  history as historyTable,
  manga as mangaTable,
  mangaCategory,
} from '@/lib/db/schema'
import { getSource } from '@/lib/sources/registry'
import { kindOf } from '@/lib/sources/types'
import type { MappedManga, SupportedSourceId } from './mihon-mapping'
import type { MihonImportPlan } from './mihon-plan'

// ------------------------------------------------------------------- run --

export interface MihonImportResult {
  seriesAdded: number
  seriesMerged: number
  chaptersAdded: number
  /** Existing chapters whose read state or page position moved forward. */
  chaptersAdvanced: number
  historyEntries: number
  categoriesCreated: number
}

export interface ImportProgress {
  done: number
  total: number
  title: string
}

/**
 * Writes the plan. One transaction per series rather than one for the whole
 * backup: a 64-series import is thousands of rows, and holding a single
 * transaction across all of it would block every other reader of the database
 * worker for the duration, with nothing to show for it — the series are
 * independent, so a failure halfway leaves the ones before it correctly merged.
 */
export async function runMihonImport(
  plan: MihonImportPlan,
  onProgress?: (progress: ImportProgress) => void,
): Promise<MihonImportResult> {
  const result: MihonImportResult = {
    seriesAdded: 0,
    seriesMerged: 0,
    chaptersAdded: 0,
    chaptersAdvanced: 0,
    historyEntries: 0,
    categoriesCreated: 0,
  }

  const categoryIds = await ensureCategories(plan.categories, result)

  let done = 0
  for (const entry of plan.entries) {
    await importSeries(entry, categoryIds, result)
    done += 1
    onProgress?.({ done, total: plan.entries.length, title: entry.title })
  }

  bumpChangeSignal(plan.entries.length)
  return result
}

function stamp() {
  return { updatedAt: Date.now(), deviceId: getDeviceId() }
}

/**
 * Category names from the backup, resolved to ids and created where missing.
 * Matching is by name because that is all a backup category is; an existing
 * category of the same name is reused rather than duplicated.
 */
async function ensureCategories(
  names: readonly string[],
  result: MihonImportResult,
): Promise<Map<number, string>> {
  const wanted = names.map((name) => name.trim()).filter(Boolean)
  const ids = new Map<number, string>()
  if (wanted.length === 0) return ids

  await transact(async (tx) => {
    const existing = await tx
      .select({ id: categoriesTable.id, name: categoriesTable.name, order: categoriesTable.order })
      .from(categoriesTable)
    const byName = new Map(
      existing.map((row) => [row.name.trim().toLowerCase(), row.id]),
    )
    let nextOrder = existing.reduce((max, row) => Math.max(max, row.order), -1) + 1

    for (const [index, name] of wanted.entries()) {
      const key = name.toLowerCase()
      const found = byName.get(key)
      if (found) {
        ids.set(index, found)
        continue
      }
      const id = ulid()
      const order = nextOrder++
      await tx
        .insert(categoriesTable)
        .values({ id, ...stamp(), name, order })
      await assertFact(tx, {
        kind: 'cat',
        key: categoryKey(name),
        state: PRESENT,
        val: order,
        payload: name,
      })
      byName.set(key, id)
      ids.set(index, id)
      result.categoriesCreated += 1
    }
  })

  return ids
}

async function importSeries(
  entry: MappedManga,
  categoryIds: Map<number, string>,
  result: MihonImportResult,
): Promise<void> {
  await transact(async (tx) => {
    const mangaId = await upsertMangaRow(tx, entry, result)
    const chapterIds = await upsertChapterRows(tx, mangaId, entry, result)
    await writeHistory(tx, mangaId, entry, chapterIds, result)
    await linkCategories(tx, mangaId, entry, categoryIds)

    // Stated from the merged rows rather than from the backup. Every write
    // above is forward-only, so what is in the tables now is the union of what
    // the reader had and what the backup knew — and that union is the thing
    // worth telling the other devices about.
    await stateSeriesFacts(tx, mangaId)
  })
}

async function upsertMangaRow(
  tx: DbTransaction,
  entry: MappedManga,
  result: MihonImportResult,
): Promise<string> {
  const [existing] = await tx
    .select({
      id: mangaTable.id,
      favorite: mangaTable.favorite,
      dateAdded: mangaTable.dateAdded,
    })
    .from(mangaTable)
    .where(
      and(
        eq(mangaTable.sourceId, entry.sourceId),
        eq(mangaTable.url, entry.url),
      ),
    )
    .limit(1)

  if (existing) {
    result.seriesMerged += 1

    // Details are left exactly as they are: what is in the database came from
    // the live source, and the backup's copy is by definition older. Only the
    // two facts an import can legitimately add are written — that the series
    // belongs in the library, and that it was first added earlier than we knew.
    const favorite = existing.favorite || entry.favorite
    const dateAdded = earliest(existing.dateAdded, entry.dateAdded)
    const unchanged =
      favorite === existing.favorite && dateAdded === existing.dateAdded

    if (!unchanged) {
      await tx
        .update(mangaTable)
        .set({ favorite, dateAdded, ...stamp() })
        .where(eq(mangaTable.id, existing.id))
    }
    return existing.id
  }

  const id = ulid()
  await tx.insert(mangaTable).values({
    id,
    ...stamp(),
    sourceId: entry.sourceId,
    url: entry.url,
    title: entry.title,
    author: entry.author,
    artist: entry.artist,
    description: entry.description,
    genres: entry.genres,
    status: entry.status,
    thumbnailUrl: entry.thumbnailUrl,
    contentKind: contentKindOf(entry.sourceId),
    favorite: entry.favorite,
    dateAdded: entry.dateAdded,
  })
  result.seriesAdded += 1
  return id
}

function earliest(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

function contentKindOf(sourceId: SupportedSourceId) {
  try {
    return kindOf(getSource(sourceId))
  } catch {
    return 'comic' as const
  }
}

/**
 * The forward-only merge for one progress column: keep the stored value when
 * the reader deliberately reset this chapter, otherwise take whichever of the
 * two is further along. Booleans are 0/1 in SQLite, so `max` works on them too.
 */
function forward(column: AnySQLiteColumn, excluded: SQL): SQL {
  return sql`case when ${chaptersTable.progressResetAt} > 0 then ${column} else max(${column}, ${excluded}) end`
}

/** Whether the incoming row moves any of the three progress fields forward. */
const CHAPTER_MOVED = sql`(
  ${chaptersTable.progressResetAt} = 0
  and (
    excluded.read > ${chaptersTable.read}
    or excluded.last_page_read > ${chaptersTable.lastPageRead}
    or excluded.bookmarked > ${chaptersTable.bookmarked}
  )
)`

/**
 * Writes the backup's chapters, and returns the row id of each by url so the
 * history pass can name them.
 *
 * The conflict clause is the forward-only rule in SQL. `max()` over the stored
 * and incoming values means a re-import is idempotent and an older backup
 * cannot walk a further reader backwards. Name, number and upload date are
 * *not* patched: the stored ones came from the live source and are newer, and
 * overwriting them is precisely the "override" this must not do.
 */
async function upsertChapterRows(
  tx: DbTransaction,
  mangaId: string,
  entry: MappedManga,
  result: MihonImportResult,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  if (entry.chapters.length === 0) return ids

  const before = await tx
    .select({
      url: chaptersTable.url,
      read: chaptersTable.read,
      lastPageRead: chaptersTable.lastPageRead,
      bookmarked: chaptersTable.bookmarked,
      progressResetAt: chaptersTable.progressResetAt,
    })
    .from(chaptersTable)
    .where(eq(chaptersTable.mangaId, mangaId))
  const known = new Map(before.map((row) => [row.url, row]))

  const { updatedAt, deviceId } = stamp()

  for (const group of chunk(entry.chapters, CHUNK_SIZE)) {
    const rows = await tx
      .insert(chaptersTable)
      .values(
        group.map((chapter) => ({
          id: ulid(),
          ...stamp(),
          mangaId,
          url: chapter.url,
          name: chapter.name,
          chapterNumber: chapter.chapterNumber,
          dateUpload: chapter.dateUpload,
          read: chapter.read,
          bookmarked: chapter.bookmarked,
          lastPageRead: chapter.lastPageRead,
        })),
      )
      .onConflictDoUpdate({
        target: [chaptersTable.mangaId, chaptersTable.url],
        set: {
          read: forward(chaptersTable.read, sql`excluded.read`),
          lastPageRead: forward(
            chaptersTable.lastPageRead,
            sql`excluded.last_page_read`,
          ),
          bookmarked: forward(chaptersTable.bookmarked, sql`excluded.bookmarked`),
          // A row whose values did not move is not a change to push.
          updatedAt: sql`case when ${CHAPTER_MOVED} then ${updatedAt} else ${chaptersTable.updatedAt} end`,
          deviceId: sql`case when ${CHAPTER_MOVED} then ${deviceId} else ${chaptersTable.deviceId} end`,
        },
      })
      .returning({ id: chaptersTable.id, url: chaptersTable.url })

    for (const row of rows) ids.set(row.url, row.id)
  }

  for (const chapter of entry.chapters) {
    const existing = known.get(chapter.url)
    if (!existing) {
      result.chaptersAdded += 1
      continue
    }
    if (existing.progressResetAt > 0) continue
    const moved =
      (chapter.read && !existing.read) ||
      (chapter.bookmarked && !existing.bookmarked) ||
      chapter.lastPageRead > existing.lastPageRead
    if (moved) result.chaptersAdvanced += 1
  }

  return ids
}

/**
 * History rows, one per chapter, keeping the later of the two timestamps — and
 * the series' `lastRead` with them, which is what orders the library by recency.
 */
async function writeHistory(
  tx: DbTransaction,
  mangaId: string,
  entry: MappedManga,
  chapterIds: Map<string, string>,
  result: MihonImportResult,
): Promise<void> {
  if (entry.history.size === 0) return

  const wanted = [...entry.history]
    .map(([url, readAt]) => ({ chapterId: chapterIds.get(url), readAt }))
    .filter((row): row is { chapterId: string; readAt: number } =>
      Boolean(row.chapterId),
    )
  if (wanted.length === 0) return

  const existing = new Map<string, { id: string; readAt: number }>()
  for (const group of chunk(wanted, CHUNK_SIZE)) {
    const rows = await tx
      .select({
        id: historyTable.id,
        chapterId: historyTable.chapterId,
        readAt: historyTable.readAt,
      })
      .from(historyTable)
      .where(
        inArray(
          historyTable.chapterId,
          group.map((row) => row.chapterId),
        ),
      )
    for (const row of rows) existing.set(row.chapterId, row)
  }

  const inserts: {
    id: string
    mangaId: string
    chapterId: string
    readAt: number
    updatedAt: number
    deviceId: string
  }[] = []

  for (const row of wanted) {
    const found = existing.get(row.chapterId)
    if (!found) {
      inserts.push({ id: ulid(), mangaId, ...row, ...stamp() })
      result.historyEntries += 1
      continue
    }
    if (found.readAt >= row.readAt) continue
    await tx
      .update(historyTable)
      .set({ readAt: row.readAt, ...stamp() })
      .where(eq(historyTable.id, found.id))
    result.historyEntries += 1
  }

  for (const group of chunk(inserts, CHUNK_SIZE)) {
    await tx.insert(historyTable).values(group)
  }

  const latest = Math.max(...wanted.map((row) => row.readAt))
  await tx
    .update(mangaTable)
    .set({ lastRead: latest, ...stamp() })
    .where(
      and(
        eq(mangaTable.id, mangaId),
        sql`coalesce(${mangaTable.lastRead}, 0) < ${latest}`,
      ),
    )
}

/** Adds the backup's category assignments without disturbing existing ones. */
async function linkCategories(
  tx: DbTransaction,
  mangaId: string,
  entry: MappedManga,
  categoryIds: Map<number, string>,
): Promise<void> {
  const wanted = entry.categoryOrders
    .map((order) => categoryIds.get(order))
    .filter((id): id is string => Boolean(id))
  if (wanted.length === 0) return

  const existing = await tx
    .select({ categoryId: mangaCategory.categoryId })
    .from(mangaCategory)
    .where(eq(mangaCategory.mangaId, mangaId))
  const known = new Set(existing.map((row) => row.categoryId))

  const missing = [...new Set(wanted)].filter((id) => !known.has(id))
  if (missing.length === 0) return

  await tx.insert(mangaCategory).values(
    missing.map((categoryId) => ({
      id: ulid(),
      ...stamp(),
      mangaId,
      categoryId,
    })),
  )
}

