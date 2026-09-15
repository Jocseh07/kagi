import { chapterKeyOf } from '@/components/reader/chapter-picker'
import {
  getChapterPages,
  getChapterText,
  getMangaByUrl,
  listChapters,
} from '@/lib/db/repositories'
import type { Chapter, Manga } from '@/lib/db/schema'
import { isTextSource } from '@/lib/sources/types'
import type {
  ChapterText,
  MangaUpdate,
  Page,
  SChapter,
  SManga,
  Source,
  TextSource,
} from '@/lib/sources/types'

/**
 * How a chapter's content is asked for.
 *
 * Shared rather than inline in the reader route so that prefetching a chapter
 * — from the reader as it nears the end of the current one, or from the
 * chapter list on hover — asks for it under exactly the key and with exactly
 * the fallbacks the reader itself will use. A prefetch that drifts from the
 * live query is a prefetch that never hits.
 *
 * It lives here rather than being exported from the route so that the chapter
 * list can reach it without pulling the whole reader into its own chunk.
 */

// AsuraScans resolves a series from `memo.slug` alone, so the reader does not
// have to wait on series details before it can ask for pages.
export function mangaStubOf(slug: string): SManga {
  return {
    url: `/series/${slug}`,
    title: slug,
    status: 'unknown',
    initialized: false,
    memo: { slug },
  }
}

export function chapterStubOf(slug: string, chapterKey: string): SChapter {
  const parsed = Number.parseFloat(chapterKey)
  return {
    url: `/series/${slug}/chapter/${chapterKey}`,
    name: `Chapter ${chapterKey}`,
    chapterNumber: Number.isFinite(parsed) ? parsed : 0,
    memo: { mangaSlug: slug },
  }
}

/**
 * The series as this device already holds it, or null if it holds nothing.
 *
 * Same shape the source would return, so the series page and the reader can
 * render it directly and swap in the fetched copy when one arrives. A stored
 * row exists for anything added to the library, which is the case that has to
 * keep working with no network: the description, the cover url and the whole
 * chapter list were written when it was added and have been kept up to date
 * by the library update ever since.
 *
 * `initialized: true` because a stored row is a series that *has* been
 * fetched — the flag means "details are filled in", not "details are fresh".
 *
 * A failure is reported as an absence, like `findStoredChapter` below: the
 * database can be held by another tab or still booting, and both callers have
 * the network path to fall back to.
 */
export function storedUpdateQueryOptions(sourceId: string, slug: string) {
  return {
    queryKey: ['db', 'stored-update', sourceId, slug] as const,
    queryFn: async (): Promise<MangaUpdate | null> => {
      try {
        const row = await getMangaByUrl(sourceId, mangaStubOf(slug).url)
        if (!row) return null
        const stored = await listChapters(row.id)
        return { manga: toSManga(row), chapters: stored.map(toSChapter) }
      } catch {
        return null
      }
    },
  }
}

/** A stored series row, in the shape a source would have returned it. */
function toSManga(row: Manga): SManga {
  return {
    url: row.url,
    title: row.title,
    author: row.author ?? undefined,
    artist: row.artist ?? undefined,
    description: row.description ?? undefined,
    genre: row.genres ?? undefined,
    status: row.status,
    thumbnailUrl: row.thumbnailUrl ?? undefined,
    initialized: true,
    memo: row.memo ?? undefined,
  }
}

/** A stored chapter row, likewise. Read state stays on the row, not here. */
function toSChapter(row: Chapter): SChapter {
  return {
    url: row.url,
    name: row.name,
    chapterNumber: row.chapterNumber,
    dateUpload: row.dateUpload ?? undefined,
    scanlator: row.scanlator ?? undefined,
  }
}

/** A comic chapter's page list. */
export function pagesQueryOptions(
  source: Source | null,
  sourceId: string,
  slug: string,
  chapterKey: string,
) {
  return {
    queryKey: ['reader', 'pages', sourceId, slug, chapterKey] as const,
    queryFn: async (): Promise<Page[]> => {
      const manga = mangaStubOf(slug)
      // A saved chapter keeps its page list in the database; the images
      // themselves are served from the cache by the service worker. Downloading
      // a chapter is a request for it to open from the device, so the stored
      // copy wins outright rather than only once the network has failed.
      const stored = await loadSavedPages(sourceId, manga.url, chapterKey)
      if (stored.length > 0) return stored
      return source!.getPageList(manga, chapterStubOf(slug, chapterKey))
    },
  }
}

/**
 * A novel chapter's prose.
 *
 * Same saved-first shape as the page list, and for once it needs no service
 * worker: a saved chapter's text lives in the database outright, so the stored
 * copy is the whole of the offline path — nothing else has to be cached.
 */
export function textQueryOptions(
  textSource: TextSource | null,
  sourceId: string,
  slug: string,
  chapterKey: string,
) {
  return {
    queryKey: ['reader', 'text', sourceId, slug, chapterKey] as const,
    queryFn: async (): Promise<ChapterText> => {
      const manga = mangaStubOf(slug)
      const stored = await loadSavedText(sourceId, manga.url, chapterKey)
      if (stored) return stored
      return textSource!.getChapterText(manga, chapterStubOf(slug, chapterKey))
    },
  }
}

/**
 * Whichever of the two a chapter of this source is made of.
 *
 * The only thing a prefetching caller needs: it is opening a chapter, and the
 * source decides whether that means pages or prose.
 */
export function chapterContentQueryOptions(
  source: Source,
  sourceId: string,
  slug: string,
  chapterKey: string,
): { queryKey: readonly unknown[]; queryFn: () => Promise<unknown> } {
  return isTextSource(source)
    ? textQueryOptions(source, sourceId, slug, chapterKey)
    : pagesQueryOptions(source, sourceId, slug, chapterKey)
}

/**
 * This chapter's stored row, or null if this browser has never recorded it.
 *
 * The one lookup behind every saved-copy path — prose, page list, and the
 * reader's resume point, which needs the same row and must not have to wait on
 * the network to find it.
 *
 * A failure is reported as an absence: the database can be held by another tab
 * or still booting, and every caller has a network path to fall back to.
 */
export async function findStoredChapter(
  sourceId: string,
  mangaUrl: string,
  chapterKey: string,
): Promise<Chapter | null> {
  try {
    const row = await getMangaByUrl(sourceId, mangaUrl)
    if (!row) return null
    return (
      (await listChapters(row.id)).find(
        (item) =>
          chapterKeyOf({
            url: item.url,
            name: item.name,
            chapterNumber: item.chapterNumber,
          }) === chapterKey,
      ) ?? null
    )
  } catch {
    return null
  }
}

/** Prose persisted when this chapter was saved, or null if it was not. */
async function loadSavedText(
  sourceId: string,
  mangaUrl: string,
  chapterKey: string,
): Promise<ChapterText | null> {
  const match = await findStoredChapter(sourceId, mangaUrl, chapterKey)
  if (!match) return null
  try {
    return await getChapterText(match.id)
  } catch {
    return null
  }
}

/** Page list persisted when this chapter was saved, or `[]` if it was not. */
async function loadSavedPages(
  sourceId: string,
  mangaUrl: string,
  chapterKey: string,
): Promise<Page[]> {
  const match = await findStoredChapter(sourceId, mangaUrl, chapterKey)
  if (!match) return []
  try {
    return await getChapterPages(match.id)
  } catch {
    return []
  }
}
