/**
 * Local novels: EPUB and plain-text files in the same folder the local comic
 * source reads.
 *
 * This is the one novel source with no CORS gate, because there is no network:
 * most light-novel sites send no `Access-Control-Allow-Origin` at all and are
 * simply unreachable from a browser, so a folder on disk is the source that
 * cannot be taken away by a change of policy upstream.
 *
 * It deliberately shares `local`'s library root rather than asking for a second
 * folder. The two sources partition it by file type: `local` reads series
 * folders and comic archives and explicitly refuses EPUBs, which is exactly the
 * gap this fills.
 *
 * Identity is the file name — a novel is `/series/<file>` and a chapter is
 * `/series/<file>/chapter/<spine index>`. The spine index is stable for a given
 * file, which is what `url` has to be.
 */

import { coverUrls } from '../local/blob-urls'
import { getLibraryRoot, requireLibraryRoot } from '../local/library'
import { naturalCompare } from '../local/scan'
import { sanitizeChapterHtml } from '../../text/sanitize'
import type {
  ChapterText,
  FilterList,
  MangaUpdate,
  MangasPage,
  Page,
  SChapter,
  SManga,
  Source,
} from '../types'
import { readEpubChapter, readEpubCover, readEpubStructure } from './epub'
import type { EpubBook } from './epub'

export const LOCAL_NOVEL_SOURCE_ID = 'local-novel'

const PER_PAGE = 40

const SORT_TITLE = 0
const SORT_MODIFIED = 1
const SORT_VALUES = ['Title', 'Last modified']

/**
 * Structure of the books seen this page load.
 *
 * Reading a spine means inflating the package document, so the series screen,
 * the chapter list and every chapter opened from it would otherwise re-parse
 * the same file. Cleared only by a reload, matching the timestamp cache in
 * `local/library`.
 */
const structures = new Map<string, EpubBook>()

function isEpubName(name: string): boolean {
  return name.toLowerCase().endsWith('.epub')
}

function isTextName(name: string): boolean {
  return /\.(txt|text)$/i.test(name)
}

function isNovelName(name: string): boolean {
  return isEpubName(name) || isTextName(name)
}

/** A fresh object per call: query caches hold on to these. */
function emptyPage(): MangasPage {
  return { mangas: [], hasNextPage: false }
}

export class LocalNovelSource implements Source {
  readonly id = LOCAL_NOVEL_SOURCE_ID
  readonly name = 'Local novels'
  readonly lang = 'en'
  /** No web presence at all; nothing this source returns is addressable. */
  readonly baseUrl = ''
  readonly contentRating = 'safe'
  readonly versionCode = 1
  readonly contentKind = 'novel' as const
  readonly supportsLatest = true
  readonly isLocal = true
  readonly supportsFilterFetching = false
  readonly supportsRelatedMangas = false
  /** Read from disk, so there is no host budget to pace against. */
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
    const files = (await listNovelFiles(root)).filter(
      (file) => !needle || file.name.toLowerCase().includes(needle),
    )

    const sorted =
      sortIndex === SORT_MODIFIED
        ? await sortByModified(files, ascending)
        : sortByName(files, ascending)

    const start = (page - 1) * PER_PAGE
    const slice = sorted.slice(start, start + PER_PAGE)

    return {
      mangas: slice.map((file) => ({
        url: seriesUrl(file.name),
        title: displayTitle(file.name),
        status: 'unknown' as const,
        initialized: false,
        memo: { slug: file.name },
      })),
      hasNextPage: start + PER_PAGE < sorted.length,
    }
  }

  // -------------------------------------------------------------- details --

  async getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
  ): Promise<MangaUpdate> {
    const fileName = fileNameOf(manga)
    const handle = await this.findFile(fileName)
    const file = await handle.getFile()

    if (isTextName(fileName)) {
      const chapters = opts.fetchChapters
        ? [textChapter(fileName, file.lastModified)]
        : []
      if (!opts.fetchDetails) return { manga, chapters }
      return {
        manga: {
          url: seriesUrl(fileName),
          title: displayTitle(fileName),
          status: 'completed',
          initialized: true,
          memo: { slug: fileName },
        },
        chapters,
      }
    }

    const book = await this.structureOf(fileName, file)

    const chapters = opts.fetchChapters
      ? book.chapters.map((chapter, index) => ({
          url: chapterUrl(fileName, index),
          name: chapter.title?.trim() || `Chapter ${index + 1}`,
          chapterNumber: index + 1,
          dateUpload: file.lastModified,
          memo: { slug: fileName },
        }))
      : []

    if (!opts.fetchDetails) return { manga, chapters }

    return {
      manga: {
        url: seriesUrl(fileName),
        title: book.title?.trim() || displayTitle(fileName),
        author: book.author,
        description: book.description,
        // A file on disk is not being serialised; nothing more is coming.
        status: 'completed',
        thumbnailUrl: await this.coverUrl(fileName, file, book),
        initialized: true,
        memo: { slug: fileName },
      },
      chapters,
    }
  }

  // ----------------------------------------------------------------- text --

  getPageList(): Promise<Page[]> {
    return Promise.reject(
      new Error('Local novels are read as text, not as pages.'),
    )
  }

  async getChapterText(
    manga: SManga,
    chapter: SChapter,
  ): Promise<ChapterText> {
    const fileName = fileNameOf(manga)
    const handle = await this.findFile(fileName)
    const file = await handle.getFile()

    if (isTextName(fileName)) {
      return sanitizeChapterHtml(paragraphsFrom(await file.text()))
    }

    const book = await this.structureOf(fileName, file)
    const index = Number(chapter.url.split('/').pop())
    const entry = book.chapters[index]
    if (!entry) {
      throw new Error(`"${displayTitle(fileName)}" has no chapter ${index + 1}.`)
    }

    return await readEpubChapter(file, entry.href)
  }

  // -------------------------------------------------------------- helpers --

  private async findFile(fileName: string): Promise<FileSystemFileHandle> {
    const root = await requireLibraryRoot()
    const handle = await root.getFileHandle(fileName).catch(() => null)
    if (!handle) {
      throw new Error(`"${fileName}" is no longer in the library folder.`)
    }
    return handle
  }

  private async structureOf(fileName: string, file: File): Promise<EpubBook> {
    const cached = structures.get(fileName)
    if (cached) return cached
    const book = await readEpubStructure(file)
    structures.set(fileName, book)
    return book
  }

  private async coverUrl(
    fileName: string,
    file: File,
    book: EpubBook,
  ): Promise<string | undefined> {
    if (!book.coverHref) return undefined

    const key = `novel-cover:${fileName}`
    const cached = coverUrls.get(key)
    if (cached) return cached

    const blob = await readEpubCover(file, book.coverHref)
    return blob ? coverUrls.put(key, blob) : undefined
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

  getMangaWebUrl(): string {
    return ''
  }

  getChapterWebUrl(): string {
    return ''
  }
}

// ---------------------------------------------------------------- helpers --

interface NovelFile {
  name: string
  handle: FileSystemFileHandle
}

async function listNovelFiles(
  root: FileSystemDirectoryHandle,
): Promise<NovelFile[]> {
  const files: NovelFile[] = []
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== 'file' || !isNovelName(name)) continue
    files.push({ name, handle: handle as FileSystemFileHandle })
  }
  return files
}

function seriesUrl(fileName: string): string {
  return `/series/${fileName}`
}

function chapterUrl(fileName: string, index: number): string {
  return `${seriesUrl(fileName)}/chapter/${index}`
}

/** The file name, from whichever of the two identities the caller kept. */
function fileNameOf(manga: SManga): string {
  const slug = manga.memo?.slug
  if (typeof slug === 'string' && slug) return slug
  return manga.url.replace(/^\/series\//, '').replace(/\/$/, '')
}

/** Shelf title before the book itself has been opened: its name, less the extension. */
function displayTitle(fileName: string): string {
  return fileName.replace(/\.(epub|txt|text)$/i, '')
}

/** A plain-text file is one chapter; there is no structure to split it on. */
function textChapter(fileName: string, lastModified: number): SChapter {
  return {
    url: chapterUrl(fileName, 0),
    name: displayTitle(fileName),
    chapterNumber: 1,
    dateUpload: lastModified,
    memo: { slug: fileName },
  }
}

/**
 * Plain text as paragraphs.
 *
 * Blank lines separate paragraphs, which is the convention every plain-text
 * book follows. Escaping happens in the sanitiser this feeds, so the text is
 * wrapped and not otherwise touched.
 */
function paragraphsFrom(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${block.replace(/\n/g, '<br>')}</p>`)
    .join('')
}

function sortByName(files: NovelFile[], ascending: boolean): NovelFile[] {
  const sorted = [...files].sort((a, b) => naturalCompare(a.name, b.name))
  return ascending ? sorted : sorted.reverse()
}

async function sortByModified(
  files: NovelFile[],
  ascending: boolean,
): Promise<NovelFile[]> {
  const dated = await Promise.all(
    files.map(async (file) => ({
      file,
      at: await lastModified(file.handle),
    })),
  )

  dated.sort(
    (a, b) =>
      (ascending ? a.at - b.at : b.at - a.at) ||
      naturalCompare(a.file.name, b.file.name),
  )
  return dated.map((entry) => entry.file)
}

async function lastModified(handle: FileSystemFileHandle): Promise<number> {
  try {
    return (await handle.getFile()).lastModified
  } catch {
    // An unreadable file sorts oldest rather than failing the whole shelf.
    return 0
  }
}
