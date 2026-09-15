/**
 * Local source: a folder on this machine, read through the File System Access
 * API. Mirrors Mihon's local source, including its folder layout, and is the
 * only source in the app that needs no network at all.
 *
 * Identity is the folder name: a series is `/series/<folder>` and a chapter is
 * `/series/<folder>/chapter/<entry name>`. The app derives its route params
 * from the trailing segments (`mangaSlug`, `chapterKeyOf`), and the reader
 * rebuilds a stub series from the slug alone, so the name has to be enough to
 * find the files again — it is, since it is what they are called on disk.
 */

import type {
  FilterList,
  MangaUpdate,
  MangasPage,
  Page,
  SChapter,
  SManga,
  Source,
} from '../types'
import { coverUrls } from './blob-urls'
import type { ComicInfoChapter } from './comic-info'
import {
  cacheTimestamp,
  getCachedTimestamp,
  getLibraryRoot,
  requireLibraryRoot,
} from './library'
import { readLocalMetadata } from './metadata'
import { readArchivePages, readDirectoryPages, readFirstImage } from './pages'
import {
  findCoverFile,
  findSeries,
  isArchiveName,
  isImageName,
  isUnsupportedArchiveName,
  listChapterEntries,
  listDirectory,
  listSeries,
  naturalCompare,
  recognizeChapterNumber,
  unsupportedFormatLabel,
  unsupportedFormatMessage,
} from './scan'
import type { ChapterEntry, DirectoryListing, SeriesEntry } from './scan'

export const LOCAL_SOURCE_ID = 'local'

const PER_PAGE = 40

const SORT_TITLE = 0
const SORT_MODIFIED = 1
const SORT_VALUES = ['Title', 'Last modified']

/**
 * How many chapters at the end of a series are stat'd to date the folder.
 *
 * Directory handles carry no timestamp, so "last modified" has to come from the
 * files inside. The newest chapter sorts last by name in every layout this
 * source supports, so the tail is where the recent edits are.
 */
const TIMESTAMP_SAMPLE = 8

/** A fresh object per call: query caches hold on to these. */
function emptyPage(): MangasPage {
  return { mangas: [], hasNextPage: false }
}

export class LocalSource implements Source {
  readonly id = LOCAL_SOURCE_ID
  readonly name = 'Local files'
  readonly lang = 'en'
  /** No web presence at all; every url this source returns is a blob url. */
  readonly baseUrl = ''
  readonly contentRating = 'safe'
  readonly versionCode = 1
  readonly supportsLatest = true
  readonly isLocal = true
  readonly supportsFilterFetching = false
  readonly supportsRelatedMangas = false
  /** Pages are read from disk, so there is no host budget to pace against. */
  readonly pageFetchIntervalMs = 0

  // ------------------------------------------------------------- browsing --

  getPopularManga(page: number): Promise<MangasPage> {
    return this.list(page, '', SORT_TITLE, true)
  }

  getLatestUpdates(page: number): Promise<MangasPage> {
    return this.list(page, '', SORT_MODIFIED, false)
  }

  getSearchMangaList(
    page: number,
    query: string,
    filters: FilterList,
  ): Promise<MangasPage> {
    const sort = filters.find((filter) => filter.type === 'sort')
    return this.list(
      page,
      query,
      sort?.state.index ?? SORT_TITLE,
      sort?.state.ascending ?? true,
    )
  }

  /**
   * Browsing with no folder chosen is an empty shelf, not an error: the picker
   * in Browse is what the user needs to see, and an error panel would bury it.
   */
  private async list(
    page: number,
    query: string,
    sortIndex: number,
    ascending: boolean,
  ): Promise<MangasPage> {
    const root = await getLibraryRoot()
    if (!root) return emptyPage()

    const needle = query.trim().toLowerCase()
    const all = (await listSeries(root)).filter(
      (series) => !needle || series.name.toLowerCase().includes(needle),
    )

    const sorted =
      sortIndex === SORT_MODIFIED
        ? await sortByModified(all, ascending)
        : sortByName(all, ascending)

    const start = (page - 1) * PER_PAGE
    const slice = sorted.slice(start, start + PER_PAGE)

    return {
      mangas: await Promise.all(slice.map((series) => this.toSManga(series))),
      hasNextPage: start + PER_PAGE < sorted.length,
    }
  }

  /** Listing entry: folder name plus its `cover.*`, if it has one. */
  private async toSManga(series: SeriesEntry): Promise<SManga> {
    const listing = await listDirectory(series.handle)
    return {
      url: seriesUrl(series.name),
      title: series.name,
      status: 'unknown',
      thumbnailUrl: await coverUrl(series.name, listing),
      initialized: false,
      memo: { slug: series.name },
    }
  }

  // -------------------------------------------------------------- details --

  async getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
  ): Promise<MangaUpdate> {
    const name = seriesNameOf(manga)
    const root = await requireLibraryRoot()
    const series = await findSeries(root, name)
    if (!series) {
      throw new Error(`"${name}" is no longer in the library folder.`)
    }

    const listing = await listDirectory(series)
    const entries = await listChapterEntries(series)

    const metadata = await readLocalMetadata(name, series, listing, entries, {
      details: opts.fetchDetails,
      chapters: opts.fetchChapters,
    })

    const chapters = opts.fetchChapters
      ? await Promise.all(
          entries.map((entry, index) =>
            toSChapter(name, entry, index, metadata.chapters.get(entry.entryName)),
          ),
        )
      : []

    if (!opts.fetchDetails) return { manga, chapters }

    const details = metadata.details
    const cover =
      (await coverUrl(name, listing)) ?? (await derivedCoverUrl(name, entries))

    return {
      manga: {
        url: seriesUrl(name),
        title: details.title ?? name,
        author: details.author,
        artist: details.artist,
        description: details.description,
        genre: details.genre,
        status: details.status ?? 'unknown',
        thumbnailUrl: cover,
        initialized: true,
        memo: { slug: name },
      },
      chapters,
    }
  }

  // ---------------------------------------------------------------- pages --

  async getPageList(manga: SManga, chapter: SChapter): Promise<Page[]> {
    const name = seriesNameOf(manga)
    const entryName = chapterEntryOf(chapter)
    const root = await requireLibraryRoot()

    const series = await findSeries(root, name)
    if (!series) {
      throw new Error(`"${name}" is no longer in the library folder.`)
    }

    const keyPrefix = `${name}/${entryName}`

    // A RAR, 7z or EPUB chapter is listed but cannot be opened, and the reader
    // shows what it is told here. Checked before the lookups below so it reads
    // as an unsupported file rather than a missing one.
    if (isUnsupportedArchiveName(entryName)) {
      throw new Error(unsupportedFormatMessage(entryName))
    }

    // The name decides which lookup is tried first, but both are tried: a
    // folder chapter is allowed to be called "Chapter 1.zip".
    const file = isArchiveName(entryName)
      ? await series.getFileHandle(entryName).catch(() => null)
      : null
    if (file) return readArchivePages(file, keyPrefix)

    const directory = await series.getDirectoryHandle(entryName).catch(() => null)
    if (directory) return readDirectoryPages(directory, keyPrefix)

    throw missingChapter(entryName)
  }

  // -------------------------------------------------------------- filters --

  getFilterList(): FilterList {
    return [
      {
        type: 'sort',
        name: 'Sort by',
        values: SORT_VALUES,
        state: { index: SORT_TITLE, ascending: true },
      },
    ]
  }

  // ----------------------------------------------------------------- urls --

  /**
   * There is no web page for a file on disk. The app's "Open in browser" link
   * is rendered from this, so it degrades to a link with an empty href.
   */
  getMangaWebUrl(): string {
    return ''
  }

  getChapterWebUrl(): string {
    return ''
  }
}

// ---------------------------------------------------------------- helpers --

function seriesUrl(name: string): string {
  return `/series/${name}`
}

/** The folder name, from whichever of the two identities the caller kept. */
function seriesNameOf(manga: SManga): string {
  const slug = manga.memo?.slug
  if (typeof slug === 'string' && slug) return slug
  return manga.url.replace(/^\/series\//, '').replace(/\/$/, '')
}

function chapterEntryOf(chapter: SChapter): string {
  return chapter.url.split('/').pop() ?? chapter.name
}

function missingChapter(entryName: string): Error {
  return new Error(`"${entryName}" is no longer in that series folder.`)
}

/**
 * A chapter, described by its `ComicInfo.xml` where it has one and by its file
 * name where it does not.
 *
 * The XML wins, as it does in Mihon: a folder synced from a phone shows the
 * same chapter titles and numbering here as it does there.
 *
 * An unsupported archive says so in the subtitle line the chapter list already
 * renders for the scanlator, since that is the one place a chapter can explain
 * itself before it is opened. `memo.kind` carries the same fact structurally.
 */
async function toSChapter(
  seriesName: string,
  entry: ChapterEntry,
  index: number,
  info: ComicInfoChapter | undefined,
): Promise<SChapter> {
  const unsupported = entry.kind === 'unsupported'

  return {
    url: `${seriesUrl(seriesName)}/chapter/${entry.entryName}`,
    name: info?.name ?? entry.name,
    chapterNumber: info?.chapterNumber ?? recognizeChapterNumber(entry.name, index + 1),
    dateUpload: await entryTimestamp(entry),
    scanlator: unsupported
      ? unsupportedFormatLabel(entry.entryName)
      : info?.scanlator,
    memo: { slug: seriesName, kind: entry.kind },
  }
}

/**
 * When a chapter last changed on disk.
 *
 * Only files are dated: reading a folder chapter's date means opening the
 * folder and stat'ing an image inside it, which is a directory scan per chapter
 * across a whole series listing.
 */
async function entryTimestamp(entry: ChapterEntry): Promise<number | undefined> {
  if (entry.kind === 'directory') return undefined
  try {
    return (await (entry.handle as FileSystemFileHandle).getFile()).lastModified
  } catch {
    return undefined
  }
}

async function firstImageTimestamp(
  handle: FileSystemDirectoryHandle,
): Promise<number | undefined> {
  try {
    const { files } = await listDirectory(handle)
    const first = [...files.keys()].find(isImageName)
    return first ? (await files.get(first)!.getFile()).lastModified : undefined
  } catch {
    return undefined
  }
}

async function coverUrl(
  seriesName: string,
  listing: DirectoryListing,
): Promise<string | undefined> {
  const key = `cover:${seriesName}`
  const cached = coverUrls.get(key)
  if (cached) return cached

  const handle = findCoverFile(listing)
  if (!handle) return undefined

  try {
    return coverUrls.put(key, await handle.getFile())
  } catch {
    return undefined
  }
}

/**
 * A cover taken from the first page of the first chapter.
 *
 * Only used on the series screen: doing this while listing a shelf would mean
 * opening an archive per card.
 */
async function derivedCoverUrl(
  seriesName: string,
  entries: ChapterEntry[],
): Promise<string | undefined> {
  // An unsupported archive cannot give up its first page, so the cover comes
  // from the first chapter that can.
  const first = entries.find((entry) => entry.kind !== 'unsupported')
  if (!first) return undefined

  const key = `first-page:${seriesName}`
  const cached = coverUrls.get(key)
  if (cached) return cached

  const blob = await readFirstImage(first.handle, first.kind)
  return blob ? coverUrls.put(key, blob) : undefined
}

function sortByName(series: SeriesEntry[], ascending: boolean): SeriesEntry[] {
  const sorted = [...series].sort((a, b) => naturalCompare(a.name, b.name))
  return ascending ? sorted : sorted.reverse()
}

async function sortByModified(
  series: SeriesEntry[],
  ascending: boolean,
): Promise<SeriesEntry[]> {
  const dated = await Promise.all(
    series.map(async (entry) => ({
      entry,
      at: await seriesTimestamp(entry),
    })),
  )

  dated.sort(
    (a, b) => (ascending ? a.at - b.at : b.at - a.at) || naturalCompare(a.entry.name, b.entry.name),
  )
  return dated.map((item) => item.entry)
}

/** Memoised per folder: the sort re-runs on every page of an infinite scroll. */
async function seriesTimestamp(series: SeriesEntry): Promise<number> {
  const cached = getCachedTimestamp(series.name)
  if (cached !== undefined) return cached

  let newest = 0
  try {
    const entries = await listChapterEntries(series.handle)
    for (const entry of entries.slice(-TIMESTAMP_SAMPLE)) {
      // The sample is small enough to afford opening a folder chapter, which
      // the per-chapter date deliberately does not do.
      const at =
        entry.kind === 'directory'
          ? await firstImageTimestamp(entry.handle as FileSystemDirectoryHandle)
          : await entryTimestamp(entry)
      if (at && at > newest) newest = at
    }
  } catch {
    // An unreadable folder sorts oldest rather than failing the whole shelf.
  }

  cacheTimestamp(series.name, newest)
  return newest
}
