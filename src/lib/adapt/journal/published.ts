import { inArray } from 'drizzle-orm'
import { transact } from '../../db/client'
import { chunk, CHUNK_SIZE } from '../../db/chunk'
import { getMangaByUrl, listChapters } from '../../db/repositories'
import { chapters } from '../../db/schema'
import { queueManager } from '../../download/queue-manager'
import { listQueue, removeItem } from '../../download/queue-repository'
import { unsaveChapter } from '../../offline/save-chapter'
import { ADAPTED_SOURCE_ID, adaptedSeriesUrl } from '../../sources/adapted'
import { coverUrls, pageUrls } from '../../sources/local/blob-urls'
import { listChapters as listAdaptationChapters } from '../store'
import { pageKey } from '../keys'

export async function invalidatePublishedAdaptation(adaptationId: string, affectedChapterNumbers: readonly number[]): Promise<void> {
  const affected = new Set(affectedChapterNumbers)
  for (const number of affected) pageUrls.dropPrefix(`${adaptationId}/page/${number}/`)
  if (affected.has(1)) coverUrls.drop(pageKey(adaptationId, 1, 1))
  const manga = await getMangaByUrl(ADAPTED_SOURCE_ID, adaptedSeriesUrl(adaptationId))
  if (!manga) return
  const current = new Set((await listAdaptationChapters(adaptationId)).map((chapter) => chapter.number))
  const published = await listChapters(manga.id)
  const obsolete = published.filter((chapter) => !current.has(chapter.chapterNumber))
  const invalid = published.filter((chapter) => affected.has(chapter.chapterNumber) || !current.has(chapter.chapterNumber))
  if (!invalid.length) return
  const ids = new Set(invalid.map((chapter) => chapter.id))
  const resume = queueManager.getSnapshot().status === 'running'
  await queueManager.stopAndDrain()
  try {
    for (const item of await listQueue()) if (ids.has(item.chapterId)) await removeItem(item.id)
    for (const chapter of invalid) {
      await unsaveChapter(chapter.id)
      pageUrls.dropPrefix(`${adaptationId}/page/${chapter.chapterNumber}/`)
    }
    await transact(async (tx) => {
      for (const group of chunk([...ids], CHUNK_SIZE)) await tx.update(chapters).set({ savedBytes: null }).where(inArray(chapters.id, group))
      for (const group of chunk(obsolete.map((chapter) => chapter.id), CHUNK_SIZE)) await tx.delete(chapters).where(inArray(chapters.id, group))
    })
  } finally {
    if (resume) queueManager.start()
  }
}
