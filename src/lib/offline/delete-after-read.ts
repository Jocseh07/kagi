/**
 * Opt-in cleanup: a chapter that has been read gives its storage back.
 *
 * Strictly opt in, and never retroactive — switching it on writes a setting and
 * nothing else, so chapters read before then keep their downloads. Only what is
 * read from that point on is dropped.
 */

import { getFlag, listSavedChapters } from '@/lib/db/repositories'
import { unsaveChapter } from './save-chapter'
import { SETTING_DELETE_AFTER_READ } from './types'

export async function isDeleteAfterReadEnabled(): Promise<boolean> {
  return await getFlag(SETTING_DELETE_AFTER_READ)
}

/**
 * Drops the downloads of chapters that were just marked read.
 *
 * The saved list is read once and intersected rather than asking per chapter:
 * marking a backlog read hands this hundreds of ids at a time. Removals are
 * sequential — each one talks to the service worker and then the database — and
 * every failure is swallowed, since a chapter that could not be freed is not a
 * reason to fail the read that triggered it.
 */
export async function deleteSavedAfterRead(
  chapterIds: readonly string[],
): Promise<void> {
  if (chapterIds.length === 0) return
  if (!(await isDeleteAfterReadEnabled())) return

  try {
    const saved = new Set(
      (await listSavedChapters()).map((entry) => entry.chapterId),
    )
    for (const chapterId of chapterIds) {
      if (!saved.has(chapterId)) continue
      await unsaveChapter(chapterId).catch(() => undefined)
    }
  } catch {
    // A failed lookup leaves the downloads in place, which is the safe way out.
  }
}
