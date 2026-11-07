import { pageKey } from '@/lib/adapt/keys'
import {
  getAdaptation,
  getBlob,
  getChapter,
  listAdaptations,
  listChapters,
} from '@/lib/adapt/store'
import type { Adaptation } from '@/lib/adapt/store'

import { sourceCatalog } from '../catalog'
import { coverUrls, pageUrls } from '../local/blob-urls'
import type { FilterList, MangaUpdate, MangasPage, Page, SChapter, SManga, Source } from '../types'

export const ADAPTED_SOURCE_ID = 'adapted'

const PER_PAGE = 40

export function adaptedSeriesUrl(adaptationId: string): string {
  return `/series/${adaptationId}`
}

function idOf(manga: SManga): string {
  const slug = manga.memo?.slug
  if (typeof slug === 'string' && slug) return slug
  return manga.url.replace(/^\/series\//, '').replace(/\/$/, '')
}

function numberOf(chapter: SChapter): number {
  return Number(chapter.url.split('/').pop())
}

// The novel's own cover first: a stored `blob:` URL would not survive a reload.
async function coverOf(adaptation: Adaptation): Promise<string | undefined> {
  if (adaptation.thumbnailUrl) return adaptation.thumbnailUrl
  const key = pageKey(adaptation.id, 1, 1)
  const cached = coverUrls.get(key)
  if (cached) return cached
  const blob = await getBlob(key)
  return blob ? coverUrls.put(key, blob) : undefined
}

export async function adaptedSeries(adaptation: Adaptation): Promise<SManga> {
  const sourceName = sourceCatalog.find((entry) => entry.id === adaptation.sourceId)?.name
  return {
    url: adaptedSeriesUrl(adaptation.id),
    title: adaptation.title,
    author: adaptation.author,
    description: sourceName ? `Adapted from the novel on ${sourceName}.` : undefined,
    status: 'ongoing',
    thumbnailUrl: await coverOf(adaptation),
    initialized: true,
    memo: { slug: adaptation.id },
  }
}

export async function adaptedChapters(adaptationId: string): Promise<SChapter[]> {
  const chapters = await listChapters(adaptationId)
  return chapters
    .filter((chapter) => chapter.status === 'drawn' || chapter.drawnAt !== null)
    .map((chapter) => ({
      url: `${adaptedSeriesUrl(adaptationId)}/chapter/${chapter.number}`,
      name: `Chapter ${chapter.number}: ${chapter.title}`,
      chapterNumber: chapter.number,
      dateUpload: chapter.drawnAt ?? undefined,
      memo: { slug: adaptationId },
    }))
}

export class AdaptedSource implements Source {
  readonly id = ADAPTED_SOURCE_ID
  readonly name = 'Adaptations'
  readonly lang = 'en'
  readonly baseUrl = ''
  readonly contentRating = 'safe'
  readonly versionCode = 1
  readonly supportsLatest = true
  readonly isLocal = true
  readonly supportsFilterFetching = false
  readonly supportsRelatedMangas = false
  readonly pageFetchIntervalMs = 0

  getPopularManga(page: number): Promise<MangasPage> {
    return this.list(page, '', false)
  }

  getLatestUpdates(page: number): Promise<MangasPage> {
    return this.list(page, '', true)
  }

  getSearchMangaList(page: number, query: string): Promise<MangasPage> {
    return this.list(page, query, false)
  }

  private async list(page: number, query: string, newestFirst: boolean): Promise<MangasPage> {
    const needle = query.trim().toLowerCase()
    const all = (await listAdaptations()).filter(
      (item) => !needle || item.title.toLowerCase().includes(needle),
    )
    const sorted = newestFirst ? [...all].reverse() : all
    const start = (page - 1) * PER_PAGE
    return {
      mangas: await Promise.all(sorted.slice(start, start + PER_PAGE).map(adaptedSeries)),
      hasNextPage: start + PER_PAGE < sorted.length,
    }
  }

  async getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
  ): Promise<MangaUpdate> {
    const adaptation = await getAdaptation(idOf(manga))
    if (!adaptation) throw new Error('This adaptation is not in this browser.')
    return {
      manga: opts.fetchDetails ? await adaptedSeries(adaptation) : manga,
      chapters: opts.fetchChapters ? await adaptedChapters(adaptation.id) : [],
    }
  }

  async getPageList(manga: SManga, chapter: SChapter): Promise<Page[]> {
    const adaptationId = idOf(manga)
    const number = numberOf(chapter)
    const stored = await getChapter(adaptationId, number)
    if (!stored || stored.pageCount === 0) throw new Error('This chapter has not been drawn yet.')

    const pages: Page[] = []
    for (let index = 1; index <= stored.pageCount; index++) {
      const key = pageKey(adaptationId, number, index)
      const blob = await getBlob(key)
      if (!blob) throw new Error(`Page ${index} is missing. Redraw it from the adaptation page.`)
      pages.push({ index: index - 1, imageUrl: pageUrls.put(`${key}@${blob.size}`, blob) })
    }
    return pages
  }

  getFilterList(): FilterList {
    return []
  }

  getMangaWebUrl(): string {
    return ''
  }

  getChapterWebUrl(): string {
    return ''
  }
}
