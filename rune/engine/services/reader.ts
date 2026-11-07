import { getChapterPages, getChapterText, listChapters } from '@/lib/db/repositories'
import { sanitizeChapterHtml } from '@/lib/text/sanitize'
import { markWordStarts } from '@/lib/text/word-starts'
import { isTextSource } from '@/lib/sources/types'
import type { Params, Reader } from '../protocol'
import { string, number } from '../protocol'
import { mangaOf, openChapter, chapterOf, sourceOf, sourceManga, sourceChapter } from './library'
import { readReaderPreferences } from './settings'
import { readerFontFamily } from './fonts'
import { parseProse } from './prose'
import { comicOffset } from './reader-position'
import { offlinePagePath } from '../adapters/offline'
import { imageInfo } from '../adapters/image-runtime'

export async function readerContent(p: Params, signal: AbortSignal, notify?: (message: string) => void): Promise<Reader> {
  const manga = await mangaOf(p)
  let chapterId = string(p.chapterId)
  if (!chapterId) {
    const list = await listChapters(manga.id)
    const url = string(p.chapterUrl)
    const chapter = url ? list.find((entry) => entry.url === url) : list.find((entry) => !entry.read) ?? list[0]
    if (!chapter) throw new Error('No chapter is available. Refresh the series first.')
    chapterId = chapter.id
  }
  const chapter = p.refresh === true ? await chapterOf(chapterId) : await openChapter(chapterId)
  if (chapter.mangaId !== manga.id) throw new Error('This chapter belongs to another series.')
  const [source, preferences] = await Promise.all([sourceOf(manga.sourceId), readReaderPreferences(manga.id)])
  let position = chapter.lastPageRead
  if (manga.contentKind === 'comic') position += await comicOffset(chapter.id, chapter.lastPageRead)
  if (p.transientPosition !== undefined) position = number(p.transientPosition)
  if (p.restart === true || (preferences.resume === 'restart' && p.refresh !== true)) position = 0
  else if (preferences.resume === 'notify' && position > 0 && p.refresh !== true) notify?.('Continued at your saved position. Chapter controls can restart it.')
  const base: Reader = {
    seriesId: manga.id, chapterId: chapter.id, kind: manga.contentKind, mode: preferences.mode, position,
    fit: preferences.fit, gap: preferences.gap, continuousStyle: preferences.continuousStyle,
    surface: preferences.surface, dimIdle: preferences.dimIdle,
  }
  if (isTextSource(source)) {
    const fontFamily = await readerFontFamily(preferences.text.font)
    const saved = await getChapterText(chapter.id)
    const content = saved ?? await source.getChapterText(sourceManga(manga), sourceChapter(chapter), signal)
    signal.throwIfAborted()
    if (!content.html.trim()) throw new Error('This chapter has no readable content. Retry the source.')
    const sanitized = sanitizeChapterHtml(content.html)
    const html = preferences.wordStarts.enabled ? markWordStarts(sanitized.html, preferences.wordStarts.strength) : sanitized.html
    const baseUrl = source.isLocal ? undefined : source.getChapterWebUrl(sourceManga(manga), sourceChapter(chapter))
    const blocks = parseProse(html, source.id, baseUrl || undefined)
    if (!blocks.length) throw new Error('This chapter has no readable content. Retry the source.')
    return {
      ...base, kind: 'novel', blocks, ...(fontFamily ? { fontFamily } : {}),
      fontSize: preferences.text.fontSize, lineHeight: preferences.text.lineHeight,
      measure: preferences.text.width, justify: preferences.text.justify,
      wordStarts: preferences.wordStarts.enabled ? preferences.wordStarts.strength : 'off',
    }
  }
  const savedPages = await getChapterPages(chapter.id)
  const pages = savedPages.length ? savedPages : await source.getPageList(sourceManga(manga), sourceChapter(chapter), signal)
  signal.throwIfAborted()
  if (!pages.length) throw new Error('This chapter has no pages. Refresh the series and retry.')
  const readyPages: NonNullable<Reader['pages']> = []
  for (const page of pages) {
    const cached = offlinePagePath(chapter.id, page.index)
    if (cached) readyPages.push({ path: cached, ...await imageInfo(cached) })
    else readyPages.push({ imageRef: { sourceId: source.id, url: page.imageUrl, index: page.index, ...(page.descramble ? { descramble: page.descramble } : {}) } })
  }
  return { ...base, pages: readyPages }
}
