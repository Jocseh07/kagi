/**
 * The two database writes a source migration needs that nothing else does.
 *
 * Everything else a migration touches already has a repository call that emits
 * the right sync fact — `upsertManga`, `upsertChapters`, `setFavorite`,
 * `setCategoriesForManga`, `removeFromLibrary` — so a migration replays on
 * another device as the same decisions the reader made here, rather than as a
 * new kind of event the ledger would have to learn.
 *
 * Not to be confused with `migrate.ts`, which is the schema's own migrations.
 */

import { eq } from 'drizzle-orm'

import { HIDDEN, PRESENT } from '@/lib/sync/fact-kinds'
import { bumpChangeSignal } from './change-signal'
import { CHUNK_SIZE, chunk } from './chunk'
import { db, getDeviceId, transact } from './client'
import { assertFacts, chapterKeysOf } from './facts'
import { chapters, manga } from './schema'

/** One chapter's carried-over state, addressed by the new source's row id. */
export interface MigratedChapterState {
  chapterId: string
  read: boolean
  bookmarked: boolean
  /**
   * Resume point, in the unit the series' kind implies — a page index for a
   * comic, permille of the chapter for a novel. Only ever carried between two
   * series of the same kind, which is what makes it comparable at all.
   */
  lastPageRead: number
}

/**
 * Writes the old source's read state onto the new source's chapters.
 *
 * Shaped like `markChaptersRead`: update the rows, then state the `read` and
 * `pos` facts for them, so the other devices follow without being told a
 * migration happened. Each row is written on its own because the three values
 * differ per chapter; chunked so a two-thousand-chapter series does not build
 * one enormous statement.
 */
export async function applyMigratedChapters(
  entries: readonly MigratedChapterState[],
): Promise<number> {
  if (entries.length === 0) return 0
  const updatedAt = Date.now()
  const deviceId = getDeviceId()

  await transact(async (tx) => {
    for (const group of chunk([...entries], CHUNK_SIZE)) {
      for (const entry of group) {
        await tx
          .update(chapters)
          .set({
            read: entry.read,
            bookmarked: entry.bookmarked,
            lastPageRead: entry.lastPageRead,
            updatedAt,
            deviceId,
          })
          .where(eq(chapters.id, entry.chapterId))
      }
    }

    const keys = await chapterKeysOf(
      tx,
      entries.map((entry) => entry.chapterId),
    )
    const byId = new Map(entries.map((entry) => [entry.chapterId, entry]))

    await assertFacts(
      tx,
      keys.flatMap((key) => {
        const entry = byId.get(key.chapterId)
        if (!entry) return []
        return [
          {
            kind: 'read' as const,
            key: key.key,
            state: entry.read ? PRESENT : HIDDEN,
          },
          // Stated within the current generation, like an ordinary page turn:
          // the furthest position wins, and a migration has no business
          // rewinding a peer that is further along in the same series.
          { kind: 'pos' as const, key: key.key, val: entry.lastPageRead },
        ]
      }),
    )
  })

  bumpChangeSignal(entries.length)
  return entries.length
}

/**
 * Gives the new series the old one's place in the library.
 *
 * `dateAdded` orders the library under "Date added" and `lastRead` under "Last
 * read"; a migrated series that jumped to the top of both would be the reader
 * being told their own history is wrong. Neither is a sync fact of its own:
 * `dateAdded` travels as the `lib` fact's value, which `setFavorite` states
 * immediately after this runs.
 */
export async function adoptSeriesDates(
  mangaId: string,
  dates: { dateAdded: number | null; lastRead: number | null },
): Promise<void> {
  await transact(async (tx) => {
    await tx
      .update(manga)
      .set({
        dateAdded: dates.dateAdded,
        lastRead: dates.lastRead,
        updatedAt: Date.now(),
        deviceId: getDeviceId(),
      })
      .where(eq(manga.id, mangaId))
  })
}

/** The state worth carrying, for every chapter of the series being left. */
export async function readMigrationSource(mangaId: string): Promise<
  {
    chapterNumber: number
    read: boolean
    bookmarked: boolean
    lastPageRead: number
  }[]
> {
  return await db
    .select({
      chapterNumber: chapters.chapterNumber,
      read: chapters.read,
      bookmarked: chapters.bookmarked,
      lastPageRead: chapters.lastPageRead,
    })
    .from(chapters)
    .where(eq(chapters.mangaId, mangaId))
}
