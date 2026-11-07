import { eq } from 'drizzle-orm'
import { ZipWriter, Uint8ArrayReader, BlobWriter, configure } from '@zip.js/zip.js'
import { db, getDeviceId, transact } from '@/lib/db/client'
import * as repository from '@/lib/db/repositories'
import { chapters } from '@/lib/db/schema'
import type { Chapter, Manga } from '@/lib/db/schema'
import { recordChapterOpened } from '@/lib/db/history'
import { removeFromLibrary, markMangaRead } from '@/lib/db/library'
import { enqueueChapters } from '@/lib/download/queue-repository'
import { queueManager } from '@/lib/download/queue-manager'
import { deleteSavedAfterRead } from '@/lib/offline/delete-after-read'
import { isIncognito } from '@/lib/incognito/store'
import { getSource } from '@/lib/sources/registry'
import type { SManga, Source, Filter, FilterList } from '@/lib/sources/types'
import { isTextSource, isConfigurable } from '@/lib/sources/types'
import { loadSourcePrefs } from '@/lib/sources/preferences'
import type { Params } from '../protocol'
import { string, number } from '../protocol'
import { cacheSourceImage } from '../adapters/image-runtime'
import { saveComicOffset } from './reader-position'
import { atomicExport } from './files'

const encountered = new Map<string, SManga>()
const MAX_ENCOUNTERED = 500

export function rememberManga(sourceId: string, manga: SManga): void {
  const key = `${sourceId}\n${manga.url}`
  encountered.delete(key)
  encountered.set(key, manga)
  if (encountered.size > MAX_ENCOUNTERED) encountered.delete(encountered.keys().next().value!)
}

export async function sourceOf(id: string): Promise<Source> {
  const source = getSource(id)
  if (isConfigurable(source)) await loadSourcePrefs(source)
  return source
}

export function sourceManga(manga: Manga): SManga {
  return {
    url: manga.url, title: manga.title, status: manga.status, initialized: true,
    ...(manga.author ? { author: manga.author } : {}),
    ...(manga.artist ? { artist: manga.artist } : {}),
    ...(manga.description ? { description: manga.description } : {}),
    ...(manga.genres ? { genre: manga.genres } : {}),
    ...(manga.thumbnailUrl ? { thumbnailUrl: manga.thumbnailUrl } : {}),
    ...(manga.memo ? { memo: manga.memo } : {}),
  }
}

export function sourceChapter(chapter: Chapter) {
  return {
    url: chapter.url, name: chapter.name, chapterNumber: chapter.chapterNumber,
    ...(chapter.scanlator ? { scanlator: chapter.scanlator } : {}),
    ...(chapter.dateUpload ? { dateUpload: chapter.dateUpload } : {}),
  }
}

export async function mangaOf(p: Params): Promise<Manga> {
  const id = string(p.mangaId)
  if (id) {
    const manga = await repository.getManga(id)
    if (!manga) throw new Error('This series no longer exists. Open it from Browse again.')
    return manga
  }
  const sourceId = string(p.sourceId)
  const url = string(p.url)
  if (!sourceId || !url) throw new Error('Choose a series from your library or Browse.')
  const existing = await repository.getMangaByUrl(sourceId, url)
  if (existing) return existing
  const candidate = encountered.get(`${sourceId}\n${url}`)
  if (!candidate) throw new Error('This result expired. Search the source again.')
  return repository.upsertManga(sourceId, candidate)
}

export async function refreshManga(manga: Manga, signal?: AbortSignal): Promise<Manga> {
  const source = await sourceOf(manga.sourceId)
  const update = await source.getMangaUpdate(sourceManga(manga), { fetchDetails: true, fetchChapters: true }, signal)
  signal?.throwIfAborted()
  const stored = await repository.upsertManga(source.id, update.manga)
  await repository.upsertChapters(stored.id, update.chapters)
  return stored
}

export async function chapterOf(id: string): Promise<Chapter> {
  const [chapter] = await db.select().from(chapters).where(eq(chapters.id, id)).limit(1)
  if (!chapter) throw new Error('This chapter no longer exists. Refresh the series.')
  return chapter
}

export async function enqueue(mangaId: string, ids?: readonly string[]): Promise<number> {
  const manga = await mangaOf({ mangaId })
  const source = await sourceOf(manga.sourceId)
  if (source.isLocal) throw new Error('These chapters already live on this device.')
  const wanted = ids ? new Set(ids) : null
  const list = (await repository.listChapters(manga.id)).filter((chapter) => wanted ? wanted.has(chapter.id) : !chapter.read && !chapter.downloaded)
  const queued = await enqueueChapters(list.map((chapter) => ({
    chapterId: chapter.id, mangaId: manga.id, sourceId: manga.sourceId, mangaTitle: manga.title,
    chapterName: chapter.name, chapterUrl: chapter.url, pagesTotal: chapter.pageCount,
  })))
  queueManager.nudge()
  return queued.length
}

export async function bookmarkChapter(chapterId: string, bookmarked: boolean): Promise<void> {
  await transact(async (tx) => {
    await tx.update(chapters).set({ bookmarked, updatedAt: Date.now(), deviceId: getDeviceId() }).where(eq(chapters.id, chapterId))
  })
}

export async function openChapter(chapterId: string): Promise<Chapter> {
  const chapter = await chapterOf(chapterId)
  if (!isIncognito()) await recordChapterOpened(chapter.id)
  return chapter
}

export async function recordProgress(p: Params): Promise<void> {
  if (isIncognito()) return
  const chapter = await chapterOf(string(p.chapterId))
  const manga = await mangaOf({ mangaId: chapter.mangaId })
  const total = Math.max(1, Math.trunc(number(p.pageCount, chapter.pageCount || 1)))
  const last = manga.contentKind === 'novel' ? total : Math.max(0, total - 1)
  const position = Math.max(0, Math.min(last, Math.trunc(number(p.position))))
  if (chapter.pageCount !== total) await repository.setChapterPageCount(chapter.id, total)
  if (chapter.lastPageRead !== position) await repository.setLastPageRead(chapter.id, position)
  if (manga.contentKind === 'comic') await saveComicOffset(chapter.id, position, number(p.offset))
  if (!chapter.read && position >= last && (manga.contentKind !== 'novel' || position > 0)) {
    await repository.markChapterRead(chapter.id, true)
    await deleteSavedAfterRead([chapter.id])
  }
}

export async function adjacentChapter(chapterId: string, direction: number): Promise<Chapter | null> {
  const chapter = await chapterOf(chapterId)
  const list = await repository.listChapters(chapter.mangaId)
  const group = list.filter((entry) => (entry.scanlator ?? '') === (chapter.scanlator ?? ''))
    .sort((a, b) => a.chapterNumber - b.chapterNumber || a.name.localeCompare(b.name))
  const at = group.findIndex((entry) => entry.id === chapter.id)
  if (!isIncognito() && direction > 0 && chapter.pageCount > 0 && chapter.lastPageRead / chapter.pageCount >= 0.7) {
    await repository.markChapterRead(chapter.id, true)
    await deleteSavedAfterRead([chapter.id])
  }
  return group[at + (direction < 0 ? -1 : 1)] ?? null
}

export async function exportChapter(chapterId: string, destination: string, signal?: AbortSignal): Promise<void> {
  if (!destination) throw new Error('Choose where to save the chapter.')
  const chapter = await chapterOf(chapterId)
  const manga = await mangaOf({ mangaId: chapter.mangaId })
  const source = await sourceOf(manga.sourceId)
  if (isTextSource(source)) {
    const saved = await repository.getChapterText(chapter.id)
    const text = saved ?? await source.getChapterText(sourceManga(manga), sourceChapter(chapter), signal)
    await atomicExport(destination, text.html)
    return
  }
  const savedPages = await repository.getChapterPages(chapter.id)
  const pages = savedPages.length ? savedPages : await source.getPageList(sourceManga(manga), sourceChapter(chapter), signal)
  if (!pages.length) throw new Error('This chapter has no pages to export.')
  configure({ useWebWorkers: false })
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'))
  for (const [index, page] of pages.entries()) {
    signal?.throwIfAborted()
    const image = await cacheSourceImage(source.id, page, signal)
    await writer.add(`${String(index + 1).padStart(4, '0')}.png`, new Uint8ArrayReader(new Uint8Array(await Bun.file(image.path).arrayBuffer())), { level: 0 })
  }
  await atomicExport(destination, await writer.close())
}

export function applyFilters(filters: FilterList, values: Record<string, string>, prefix = 'filter'): FilterList {
  return filters.map((filter, index): Filter => {
    const key = `${prefix}.${index}`
    if (filter.type === 'group') return { ...filter, state: applyFilters(filter.state, values, key) }
    const value = values[key]
    if (value === undefined || filter.type === 'header' || filter.type === 'separator') return filter
    switch (filter.type) {
      case 'text': return { ...filter, state: value }
      case 'checkbox': return { ...filter, state: value === 'true' }
      case 'select': return { ...filter, state: Math.max(0, Math.min(filter.values.length - 1, Number(value) || 0)) }
      case 'tristate': return { ...filter, state: value === '1' ? 1 : value === '2' ? 2 : 0 }
      case 'sort': return { ...filter, state: { index: Math.max(0, Math.min(filter.values.length - 1, Number(value) || 0)), ascending: values[`${key}.ascending`] === 'true' } }
    }
  })
}

export const librarySelection = new Set<string>()

export async function applyLibrarySelection(operation: 'read' | 'unread' | 'remove'): Promise<void> {
  const ids = [...librarySelection]
  if (operation === 'remove') await removeFromLibrary(ids)
  else await markMangaRead(ids, operation === 'read')
  librarySelection.clear()
}
