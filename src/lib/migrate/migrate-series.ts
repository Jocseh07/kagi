/**
 * Moving a series from one source to another, the way Mihon does it.
 *
 * The reader's decisions are the thing being migrated, not the rows: which
 * chapters they have read, how far into the current one they are, which
 * bookmarks they set, which categories the series sits in, and when they added
 * it. Everything the source itself owns — the description, the cover, the
 * chapter list — is refetched from the new source, because that is the point
 * of moving.
 *
 * Copy and Migrate are the same transfer. Migrate is the one that also lets
 * the old entry go, which is the only destructive thing in here and the only
 * thing gated behind its own flag.
 */

import { getMangaCategories, setMangaCategories } from '@/lib/db/categories'
import { removeFromLibrary } from '@/lib/db/library'
import {
  getSavedChapterIds,
  setFavorite,
  upsertChapters,
  upsertManga,
} from '@/lib/db/repositories'
import {
  adoptSeriesDates,
  applyMigratedChapters,
  readMigrationSource,
} from '@/lib/db/series-migration'
import type { MigratedChapterState } from '@/lib/db/series-migration'
import { queueManager } from '@/lib/download/queue-manager'
import { listQueue, removeItem } from '@/lib/download/queue-repository'
import { unsaveChapter } from '@/lib/offline/save-chapter'
import type { Manga } from '@/lib/db/schema'
import type { SChapter, SManga } from '@/lib/sources/types'

/** What the reader chose to carry across, matching Mihon's migration flags. */
export interface MigrateOptions {
  /** Read state, bookmarks and the resume point, per matching chapter. */
  chapters: boolean
  categories: boolean
  /**
   * Whether the old entry is left behind. False is Mihon's "Copy": both
   * entries stay in the library, which is how you compare before committing.
   */
  removeOld: boolean
  /** Only consulted when `removeOld`. Deletes what the old source had saved. */
  deleteDownloads: boolean
}

export interface MigrateRequest {
  /** The stored row being left. Its source id and url address the old copy. */
  from: Manga
  toSourceId: string
  toManga: SManga
  /** The new source's chapter list, already fetched so a failure precedes any write. */
  toChapters: readonly SChapter[]
  options: MigrateOptions
}

export interface MigrateResult {
  /** Row id of the series now in the library, for routing to it afterwards. */
  mangaId: string
  /** How many chapters found a counterpart by number. */
  chaptersMatched: number
  downloadsDeleted: number
}

/**
 * A chapter number of `-1` is the schema's "unnumbered", not chapter minus
 * one, so it matches nothing. Numbers are compared at two decimals because
 * sources disagree about how they write a `.5` special.
 */
function matchKey(chapterNumber: number): string | null {
  if (chapterNumber < 0) return null
  return chapterNumber.toFixed(2)
}

export async function migrateSeries({
  from,
  toSourceId,
  toManga,
  toChapters,
  options,
}: MigrateRequest): Promise<MigrateResult> {
  // The new series first, and in the order the library expects: the row, its
  // chapters, then the favourite flag — a fresh entry whose chapters have not
  // landed yet shows in the library as empty.
  const target = await upsertManga(toSourceId, toManga)
  const savedChapters =
    toChapters.length > 0 ? await upsertChapters(target.id, toChapters) : []

  let chaptersMatched = 0

  if (options.chapters && savedChapters.length > 0) {
    const previous = await readMigrationSource(from.id)
    const byNumber = new Map<string, (typeof previous)[number]>()
    for (const row of previous) {
      const key = matchKey(row.chapterNumber)
      // First writer wins: a source that lists the same number twice (two
      // scanlation groups) would otherwise have the later row silently decide.
      if (key && !byNumber.has(key)) byNumber.set(key, row)
    }

    const carried: MigratedChapterState[] = []
    for (const chapter of savedChapters) {
      const key = matchKey(chapter.chapterNumber)
      const match = key ? byNumber.get(key) : undefined
      if (!match) continue
      // Nothing to say about a chapter that was untouched on the old source,
      // and stating it would queue a fact per chapter of an unread backlog.
      if (!match.read && !match.bookmarked && match.lastPageRead === 0) continue
      carried.push({
        chapterId: chapter.id,
        read: match.read,
        bookmarked: match.bookmarked,
        lastPageRead: match.lastPageRead,
      })
    }

    chaptersMatched = await applyMigratedChapters(carried)
  }

  await adoptSeriesDates(target.id, {
    dateAdded: from.dateAdded,
    lastRead: from.lastRead,
  })
  await setFavorite(target.id, true)

  if (options.categories) {
    const categoryIds = await getMangaCategories(from.id)
    if (categoryIds.length > 0) await setMangaCategories(target.id, categoryIds)
  }

  let downloadsDeleted = 0

  if (options.removeOld) {
    if (options.deleteDownloads) {
      downloadsDeleted = await discardOldDownloads(from.id)
    }
    // Last, so a failure anywhere above leaves the reader with both entries
    // rather than with neither.
    await removeFromLibrary([from.id])
  }

  return { mangaId: target.id, chaptersMatched, downloadsDeleted }
}

/**
 * Clears what the old source had saved, and stops what it still had queued.
 *
 * Queued work goes first: a save that lands after its chapter had been
 * unsaved would write the images back and leave the series showing as
 * downloaded on a source the reader has just left.
 */
async function discardOldDownloads(mangaId: string): Promise<number> {
  const queued = await listQueue()
  for (const item of queued) {
    if (item.mangaId !== mangaId) continue
    // The same two steps `cancelQueuedChapter` takes: stop the save that may
    // already be running, then drop the row it was running from.
    queueManager.cancelItem(item.id)
    await removeItem(item.id).catch(() => undefined)
  }

  const saved = await getSavedChapterIds(mangaId)
  let deleted = 0
  // Sequential: each removal talks to the service worker and then to the
  // database, and running them at once only contends for both.
  for (const chapterId of saved) {
    try {
      await unsaveChapter(chapterId)
      deleted += 1
    } catch {
      // A chapter whose images could not be dropped stays marked as saved, so
      // Settings → Storage still offers it. Better than losing the row and
      // stranding the bytes with nothing naming them.
    }
  }
  return deleted
}
