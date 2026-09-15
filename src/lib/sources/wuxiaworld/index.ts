import { DirectFetchTransport, RateLimiter } from '../../transport/direct-fetch'
import type { HttpTransport } from '../../transport/types'
import { sanitizeChapterHtml } from '../../text/sanitize'
import {
  message,
  unary,
  writeInt,
  writeIntValue,
  writeMessage,
  writeString,
  writeStringValue,
} from './grpc'
import type { Bytes } from './grpc'
import {
  NOVEL_STATUS,
  parseChapter,
  parseChapterList,
  parseGenres,
  parseNovel,
  parseSearchNovels,
  parseUnlockTerms,
} from './dto'
import type { ChapterDto, NovelDto, UnlockTermsDto } from './dto'
import type {
  ChapterText,
  Filter,
  FilterList,
  MangaStatus,
  MangaUpdate,
  MangasPage,
  Page,
  SChapter,
  SManga,
  Source,
} from '../types'

/** Where the site lives, and what "open in browser" must point at. */
const SITE_URL = 'https://www.wuxiaworld.com'

/**
 * Where requests go, and why there is no proxy in front of it.
 *
 * `api2.wuxiaworld.com` answers a preflight with `access-control-allow-origin:
 * *` and `access-control-allow-methods: POST`, so the browser may call it from
 * any origin and every reader reaches it from their own machine. The `www.` and
 * `api.` hosts do withhold CORS headers, which is what the earlier measurement
 * in docs/sources.md recorded; `api2` is a different deployment and it is open.
 *
 * Keeping the Worker out of the path is not only less code. A proxy would make
 * the site see one IP for every reader of this app, which is exactly the shape
 * its rate limiting exists to catch.
 */
const API_URL = 'https://api2.wuxiaworld.com'

const SEARCH_NOVELS = 'wuxiaworld.api.v2.Novels/SearchNovels'
const GET_NOVEL = 'wuxiaworld.api.v2.Novels/GetNovel'
const GET_CHAPTER_LIST = 'wuxiaworld.api.v2.Chapters/GetChapterList'
const GET_CHAPTER = 'wuxiaworld.api.v2.Chapters/GetChapter'
const GET_GENRES = 'wuxiaworld.api.v2.Genres/GetGenres'
const GET_ACTIVE_PRICING = 'wuxiaworld.api.v2.Pricing/GetActivePricing'

/**
 * Two requests a second.
 *
 * The API publishes no limit and served a burst of two dozen calls without
 * complaint, so this is restraint rather than a measured ceiling. A chapter list
 * is one request however long the novel is, so there is little here to pace.
 */
const RATE_LIMIT_PERMITS = 2
const RATE_LIMIT_PERIOD_MS = 1000

/** Enough to fill a shelf without asking for a page nobody scrolls to. */
const PER_PAGE = 24

/**
 * The most novels one request can return.
 *
 * `count` is capped server-side at 100 and the cap is silent: asking for 264
 * returns 100 with no error and no marker. `96` is the largest multiple of the
 * page size under it, so a walk forward lands on a page boundary every time.
 */
const MAX_COUNT = 96

/**
 * `SearchNovelsRequest.SortType`, verified against the live endpoint.
 *
 * The enum also has `None` and `Random`; neither belongs in a browse tab, where
 * an order that changes between pages would repeat and drop novels as the reader
 * scrolls.
 */
const SORT_VALUES = [
  ['Popular', 1],
  ['Newest', 2],
  ['Most chapters', 3],
  ['Top rated', 6],
  ['Trending', 7],
  ['Name', 4],
] as const

/**
 * `NovelItem.Status`. Note that `Any` is `-1` rather than absent: the field
 * defaults to `Finished`, so a request that omits it hides every ongoing novel.
 */
const STATUS_VALUES = [
  ['Any', NOVEL_STATUS.all],
  ['Ongoing', NOVEL_STATUS.active],
  ['Completed', NOVEL_STATUS.finished],
  ['On hiatus', NOVEL_STATUS.hiatus],
] as const

/**
 * The two languages the catalogue actually has: 154 novels translated from
 * Chinese and 92 from Korean, which is all 246 of them. Offering Japanese or
 * English would be a filter that always returns nothing.
 */
const LANGUAGE_VALUES = [
  ['Any', ''],
  ['Chinese', 'Chinese'],
  ['Korean', 'Korean'],
] as const

interface WuxiaWorldFilterData {
  genres: string[]
}

/** The search parameters one browse request is built from. */
interface Query {
  title: string
  language: string
  status: number
  sortType: number
  ascending: boolean
  genres: string[]
}

/**
 * WuxiaWorld.
 *
 * A gRPC-web source rather than a scrape or a REST client: the site is a Vite
 * SPA that renders everything from `api2.wuxiaworld.com`, a public
 * unauthenticated gRPC API. The message shapes come from the site's own
 * generated client and were each checked live; see ./dto.ts. The wire handling
 * is ./grpc.ts and knows nothing about this site.
 *
 * Two things about the site shape the code more than the endpoints do:
 *
 *  - **Most chapters cannot be read without paying.** Each novel opens with a
 *    free window, usually 50 chapters; past it a chapter needs karma, a VIP
 *    subscription, or a logged-in reader waiting out an unlock timer. Against
 *    the Gods lists 2203 chapters and serves 51. The whole list is still shown,
 *    with the real numbering, and a locked chapter reports what it would take to
 *    open it. See `lockedMessageFor`.
 *
 *  - **Listings page by cursor, not by page number.** `searchAfterId` takes the
 *    last novel of the previous page, and the app's `Source` API is
 *    page-numbered. See `browse`.
 */
export class WuxiaWorld implements Source {
  readonly id = 'wuxiaworld'
  readonly name = 'WuxiaWorld'
  readonly lang = 'en'
  readonly baseUrl = SITE_URL
  /**
   * `mixed`, not `safe`. The catalogue is licensed translation and carries no
   * adult section, but `Mature` is one of the site's own secondary genres and 18
   * of its 246 novels are tagged with it, which is the middle case this rating
   * exists for.
   */
  readonly contentRating = 'mixed'
  readonly versionCode = 1
  readonly contentKind = 'novel' as const
  readonly supportsLatest = true
  readonly isLocal = false
  readonly supportsFilterFetching = true
  readonly supportsRelatedMangas = false

  /**
   * Nothing to pace. This applies to page images, which the service worker
   * fetches outside the source's limiter; chapters are fetched here.
   */
  readonly pageFetchIntervalMs = 0

  private readonly http: HttpTransport
  private readonly apiBase: string

  /**
   * The cursor each listing page ended on, keyed by query and page number.
   *
   * `searchAfterId` is a position, not an index, so page 4 can only be asked for
   * in terms of where page 3 stopped. Browse pages in order, so the cursor is
   * always there by the time it is needed; a cold jump falls back to asking for
   * the whole run and slicing, which `browse` does rather than refusing.
   */
  private readonly cursors = new Map<string, number>()

  /** The locked-chapter message per novel, since its pricing costs a call. */
  private readonly lockedMessages = new Map<string, string>()

  constructor(transport?: HttpTransport, apiBase = API_URL) {
    this.apiBase = apiBase.replace(/\/$/, '')
    this.http =
      transport ??
      new DirectFetchTransport(
        new RateLimiter(RATE_LIMIT_PERMITS, RATE_LIMIT_PERIOD_MS),
      )
  }

  // ------------------------------------------------------------- browsing --

  getPopularManga(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.browse(queryOf([], 1), page, signal)
  }

  /**
   * The newest novels on the site.
   *
   * Not the most recently updated ones: `Updates/GetLatestUpdates` answers with
   * chapter rows, and a page of those collapses to a handful of distinct novels
   * because the busiest ones publish several chapters a day.
   */
  getLatestUpdates(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.browse(queryOf([], 2), page, signal)
  }

  async getSearchMangaList(
    page: number,
    query: string,
    filters: FilterList,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    return await this.browse(
      { ...queryOf(filters, 1), title: query.trim() },
      page,
      signal,
    )
  }

  /**
   * One page of a listing, over a cursor-paged endpoint.
   *
   * Page 1 sends no cursor, and every request records the id each page boundary
   * inside it ended on, so browsing in order costs exactly one call per page.
   * A page asked for out of order walks forward to it first; see `seekCursor`.
   */
  private async browse(
    query: Query,
    page: number,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const signature = JSON.stringify(query)
    const cursor = await this.seekCursor(signature, query, page, signal)

    // The walk ran out of novels before reaching this page, so there is nothing
    // here to show and nothing past it either.
    if (page > 1 && cursor === undefined) return { mangas: [], hasNextPage: false }

    const { novels, total } = await this.fetchNovels(query, PER_PAGE, cursor, signal)
    this.rememberCursors(signature, page - 1, novels)

    return {
      mangas: novels.map((novel) => this.toSManga(novel)),
      // The catalogue size is authoritative; a full page is not, since a
      // result set whose size is a multiple of the page size ends on one.
      // Counted from the page number, because a cursored request returns this
      // page alone and knows nothing of the ones before it.
      hasNextPage: (page - 1) * PER_PAGE + novels.length < total,
    }
  }

  /**
   * The cursor page `page - 1` ended on, fetching whatever it takes to learn it.
   *
   * `searchAfterId` is a position rather than an index, so there is no way to
   * ask for page 7 without knowing where page 6 stopped. Browse pages in order
   * and the cursor is already recorded; a reader who lands mid-list, or a query
   * whose earlier pages fell out of the cache, walks forward from the furthest
   * cursor known.
   *
   * The walk moves in the largest run the API will serve rather than a page at a
   * time, which puts the whole 246-novel catalogue three requests away at worst.
   */
  private async seekCursor(
    signature: string,
    query: Query,
    page: number,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    if (page <= 1) return undefined

    let reached = 0
    let cursor: number | undefined
    for (let earlier = page - 1; earlier >= 1; earlier -= 1) {
      const known = this.cursors.get(`${signature}#${earlier}`)
      if (known === undefined) continue
      reached = earlier
      cursor = known
      break
    }

    while (reached < page - 1) {
      const wanted = Math.min(MAX_COUNT, (page - 1 - reached) * PER_PAGE)
      const { novels } = await this.fetchNovels(query, wanted, cursor, signal)

      this.rememberCursors(signature, reached, novels)

      // A run too short to complete another page is the end of the list, and
      // advancing nothing would spin here forever.
      const pagesRead = Math.floor(novels.length / PER_PAGE)
      if (pagesRead === 0) return undefined

      reached += pagesRead
      cursor = this.cursors.get(`${signature}#${reached}`)
      if (novels.length < wanted) break
    }

    return cursor
  }

  private async fetchNovels(
    query: Query,
    count: number,
    cursor: number | undefined,
    signal?: AbortSignal,
  ) {
    return parseSearchNovels(
      await unary(
        this.http,
        this.apiBase,
        SEARCH_NOVELS,
        searchRequest(query, count, cursor),
        signal,
      ),
    )
  }

  /** Where each page boundary in a run of novels falls, `after` pages in. */
  private rememberCursors(
    signature: string,
    after: number,
    novels: readonly { id: number }[],
  ): void {
    for (let boundary = PER_PAGE; boundary <= novels.length; boundary += PER_PAGE) {
      const last = novels[boundary - 1]
      if (last) {
        this.cursors.set(`${signature}#${after + boundary / PER_PAGE}`, last.id)
      }
    }
  }

  // -------------------------------------------------------------- details --

  async getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
    signal?: AbortSignal,
  ): Promise<MangaUpdate> {
    const slug = slugOf(manga)

    // The chapter list is keyed on the novel's numeric id, so a series rebuilt
    // from its slug alone has to be looked up before its chapters can be.
    const needsNovel =
      opts.fetchDetails || (opts.fetchChapters && novelIdOf(manga) === undefined)
    const novel = needsNovel ? await this.fetchNovel(slug, signal) : null

    const novelId = novel?.id ?? novelIdOf(manga)
    const chapters =
      opts.fetchChapters && novelId !== undefined
        ? await this.fetchChapters(novelId, slug, signal)
        : []

    return {
      manga: novel && opts.fetchDetails ? this.toSManga(novel) : manga,
      chapters,
    }
  }

  private async fetchNovel(
    slug: string,
    signal?: AbortSignal,
  ): Promise<NovelDto> {
    return parseNovel(
      await unary(
        this.http,
        this.apiBase,
        GET_NOVEL,
        writeString(2, slug),
        signal,
      ),
    )
  }

  /**
   * The whole chapter list in one request.
   *
   * The endpoint takes no paging parameters and returns every volume group
   * however long the novel is — 21 groups and 2203 chapters for Against the
   * Gods, 244 KB — in reading order, which is the order this hands back.
   */
  private async fetchChapters(
    novelId: number,
    slug: string,
    signal?: AbortSignal,
  ): Promise<SChapter[]> {
    const { chapters, translator } = parseChapterList(
      await unary(
        this.http,
        this.apiBase,
        GET_CHAPTER_LIST,
        writeInt(1, novelId),
        signal,
      ),
    )

    return chapters
      .filter((chapter) => chapter.visible && chapter.slug)
      .map((chapter, index) => toSChapter(chapter, slug, index, translator))
  }

  // ----------------------------------------------------------------- text --

  getPageList(): Promise<Page[]> {
    // `contentKind` is 'novel', so nothing should reach this. Throwing beats
    // returning [] silently, which would show as an empty chapter.
    return Promise.reject(
      new Error('WuxiaWorld serves novels; chapters are read as text, not pages.'),
    )
  }

  /**
   * One chapter's prose.
   *
   * Addressed by novel and chapter slug rather than by the numeric chapter id,
   * because the reader rebuilds a chapter from its route key alone and the slug
   * is what that key holds. Both selectors resolve to the same chapter.
   *
   * There is deliberately no `chapterTextUrl`/`parseChapterText` pair: a gRPC
   * call is a POST with a binary body, which Background Fetch cannot express.
   * The download queue checks for those two halves and falls back to this
   * method, so a saved chapter works and simply does not survive a locked
   * screen.
   */
  async getChapterText(
    manga: SManga,
    chapter: SChapter,
    signal?: AbortSignal,
  ): Promise<ChapterText> {
    const slug = slugOf(manga)
    const chapterSlug = chapterSlugOf(chapter)

    const dto = parseChapter(
      await unary(
        this.http,
        this.apiBase,
        GET_CHAPTER,
        writeMessage(
          1,
          writeMessage(2, message(writeString(1, slug), writeString(2, chapterSlug))),
        ),
        signal,
      ),
    )

    // A locked chapter is not an error to the API. It answers with the whole
    // record and either omits the body or returns the opening paragraphs marked
    // as a teaser, which stop mid-sentence and would otherwise read as a very
    // short chapter.
    if (dto.content === undefined || dto.isTeaser) {
      throw new Error(await this.lockedMessageFor(manga, signal))
    }

    const text = sanitizeChapterHtml(withThoughts(dto))
    if (!text.html.trim()) {
      throw new Error('WuxiaWorld returned a chapter with no readable text.')
    }
    return text
  }

  /**
   * What it would take to read this novel past its free window.
   *
   * Costs one call, sometimes two, and only ever on a locked chapter — so it is
   * remembered per novel. A failure here degrades to the message that names no
   * numbers rather than replacing a locked chapter with a network error.
   */
  private async lockedMessageFor(
    manga: SManga,
    signal?: AbortSignal,
  ): Promise<string> {
    const slug = slugOf(manga)
    const cached = this.lockedMessages.get(slug)
    if (cached) return cached

    let terms: UnlockTermsDto = {}
    try {
      const seriesId =
        seriesIdOf(manga) ?? (await this.fetchNovel(slug, signal)).seriesId
      if (seriesId !== undefined) {
        terms = parseUnlockTerms(
          await unary(
            this.http,
            this.apiBase,
            GET_ACTIVE_PRICING,
            writeInt(1, seriesId),
            signal,
          ),
        )
      }
    } catch (error) {
      // A cancelled read is not a locked chapter; everything else falls
      // through to the message that states no numbers.
      if (signal?.aborted) throw error
    }

    const text = lockedMessage(terms)
    this.lockedMessages.set(slug, text)
    return text
  }

  // -------------------------------------------------------------- filters --

  /**
   * The genre taxonomy, both of its levels.
   *
   * Level 0 is the eleven primary genres the site's own browse page leads with
   * and level 1 the twenty-two secondary ones — `Xianxia`, `Cooking`,
   * `Mature`. The filter takes names rather than ids, so nothing has to be
   * remembered between building the sheet and running the search.
   */
  async fetchFilterData(): Promise<WuxiaWorldFilterData> {
    try {
      const levels = await Promise.all([
        this.fetchGenres(0),
        this.fetchGenres(1),
      ])
      return { genres: [...new Set(levels.flat())] }
    } catch {
      // A filter sheet without genres still sorts and filters by status.
      return { genres: [] }
    }
  }

  private async fetchGenres(level: number): Promise<string[]> {
    return parseGenres(
      await unary(this.http, this.apiBase, GET_GENRES, writeInt(1, level)),
    )
  }

  getFilterList(data?: unknown): FilterList {
    const genres = (data as WuxiaWorldFilterData | undefined)?.genres ?? []

    return [
      {
        type: 'sort',
        name: 'Order',
        values: SORT_VALUES.map(([label]) => label),
        state: { index: 0, ascending: false },
      },
      selectFilter('Status', STATUS_VALUES),
      selectFilter('Language', LANGUAGE_VALUES),
      {
        type: 'group',
        name: 'Genres',
        state: genres.map((genre) => ({
          type: 'checkbox' as const,
          name: genre,
          state: false,
        })),
      },
    ]
  }

  // ----------------------------------------------------------------- urls --

  getMangaWebUrl(manga: SManga): string {
    return `${SITE_URL}/novel/${slugOf(manga)}`
  }

  getChapterWebUrl(manga: SManga, chapter: SChapter): string {
    return `${SITE_URL}/novel/${slugOf(manga)}/${chapterSlugOf(chapter)}`
  }

  // -------------------------------------------------------------- helpers --

  private toSManga(novel: NovelDto): SManga {
    return {
      // `/series/<slug>` rather than the site's own `/novel/<slug>`: the app's
      // route params are the trailing segments of these urls, and the reader
      // rebuilds a series from the slug alone, so every source uses this shape.
      url: `/series/${novel.slug}`,
      title: novel.name,
      author: novel.authorName?.trim() || undefined,
      description: htmlToText(novel.synopsis ?? novel.description ?? '') || undefined,
      genre: novel.genres,
      status: toStatus(novel.status),
      thumbnailUrl: novel.coverUrl?.trim() || undefined,
      // Search and detail return the same message, so a card arrives complete
      // and the app has no reason to re-fetch it.
      initialized: true,
      memo: { slug: novel.slug, id: novel.id, seriesId: novel.seriesId },
    }
  }
}

// ------------------------------------------------------------- conversion --

function slugOf(manga: SManga): string {
  const memoSlug = manga.memo?.slug
  if (typeof memoSlug === 'string' && memoSlug) return memoSlug
  return manga.url.replace(/^\/series\//, '').replace(/\/$/, '')
}

/** The numeric novel id, when a previous call left one behind. */
function novelIdOf(manga: SManga): number | undefined {
  const memoId = manga.memo?.id
  return typeof memoId === 'number' && Number.isInteger(memoId) ? memoId : undefined
}

/** The pricing entity id, which is the novel's own id on every novel seen. */
function seriesIdOf(manga: SManga): number | undefined {
  const memoId = manga.memo?.seriesId
  return typeof memoId === 'number' && Number.isInteger(memoId) ? memoId : undefined
}

function chapterSlugOf(chapter: SChapter): string {
  const memoSlug = chapter.memo?.chapterSlug
  if (typeof memoSlug === 'string' && memoSlug) return memoSlug

  const key = chapter.url.split('/').pop() ?? ''
  if (!key) throw new Error(`Not a WuxiaWorld chapter url: ${chapter.url}`)
  return key
}

function toSChapter(
  chapter: ChapterDto,
  slug: string,
  index: number,
  translator?: string,
): SChapter {
  return {
    url: `/series/${slug}/chapter/${chapter.slug}`,
    // The site hides a title that would spoil the chapter, and shows its number
    // instead. Carrying the title through anyway would undo that.
    name: chapter.spoilerTitle
      ? `Chapter ${chapter.number || index + 1}`
      : chapter.name.trim() || `Chapter ${chapter.number || index + 1}`,
    // The site's own numbering is what a tracker expects to see; position in the
    // list is the fallback, for a prologue or a bulk import numbered 0.
    chapterNumber: chapter.number && chapter.number > 0 ? chapter.number : index + 1,
    dateUpload: chapter.publishedAt,
    // Who translated the novel. `scanlator` is the field the app already shows
    // for "who produced this chapter", which is what a translation is here.
    scanlator: translator?.trim() || undefined,
    memo: { chapterSlug: chapter.slug, id: chapter.entityId, slug },
  }
}

function toStatus(status: number): MangaStatus {
  switch (status) {
    case NOVEL_STATUS.active:
      return 'ongoing'
    case NOVEL_STATUS.finished:
      return 'completed'
    case NOVEL_STATUS.hiatus:
      return 'on_hiatus'
    default:
      return 'unknown'
  }
}

// ------------------------------------------------------------ chapter text --

/** The chapter, with the translator's closing note kept as one when it has one. */
function withThoughts(chapter: ChapterDto): string {
  const body = chapter.content ?? ''
  const thoughts = chapter.translatorThoughts?.trim()
  if (!thoughts) return body

  return `${body}<hr><blockquote><p><strong>Translator's thoughts</strong></p>${thoughts}</blockquote>`
}

/**
 * Why a chapter would not open, in the site's own numbers when they are known.
 *
 * Nothing here is a workaround and nothing pretends the chapter is broken: the
 * reader is told what the novel costs past its free window and left to decide.
 */
function lockedMessage(terms: UnlockTermsDto): string {
  const { freeChapters, waitSeconds, unlocksPerWait } = terms

  if (freeChapters && waitSeconds && unlocksPerWait) {
    return (
      `Locked on WuxiaWorld. Only the first ${freeChapters} chapters are free. ` +
      `An account unlocks ${unlocksPerWait} more every ${formatWait(waitSeconds)}.`
    )
  }
  if (freeChapters) {
    return `Locked on WuxiaWorld. Only the first ${freeChapters} chapters are free; the rest need a paid account.`
  }
  return 'Locked on WuxiaWorld. This chapter needs a paid account there.'
}

function formatWait(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600
    return hours === 1 ? '1 hour' : `${hours} hours`
  }
  const minutes = Math.max(1, Math.round(seconds / 60))
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

/**
 * An HTML fragment reduced to the plain text the series page renders.
 *
 * Synopses arrive as markup but are shown in a `whitespace-pre-line` paragraph,
 * so block boundaries become newlines and everything else goes.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    // Last, so an escaped entity in the source does not decode twice.
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------------------------------------------------------------- filters --

function selectFilter(
  name: string,
  values: readonly (readonly [string, string | number])[],
): Filter {
  return { type: 'select', name, values: values.map(([label]) => label), state: 0 }
}

/**
 * The query a filter sheet describes, with the listing's own sort as the
 * default for the tabs that have no sheet.
 */
function queryOf(filters: FilterList, sortType: number): Query {
  const query: Query = {
    title: '',
    language: '',
    status: NOVEL_STATUS.all,
    sortType,
    ascending: false,
    genres: [],
  }

  for (const filter of filters) {
    if (filter.type === 'sort' && filter.name === 'Order') {
      query.sortType = SORT_VALUES[filter.state.index]?.[1] ?? sortType
      query.ascending = filter.state.ascending
      continue
    }

    if (filter.type === 'select' && filter.name === 'Status') {
      query.status = STATUS_VALUES[filter.state]?.[1] ?? NOVEL_STATUS.all
      continue
    }

    if (filter.type === 'select' && filter.name === 'Language') {
      query.language = LANGUAGE_VALUES[filter.state]?.[1] ?? ''
      continue
    }

    if (filter.type === 'group' && filter.name === 'Genres') {
      for (const child of filter.state) {
        if (child.type === 'checkbox' && child.state) query.genres.push(child.name)
      }
    }
  }

  return query
}

function searchRequest(query: Query, count: number, cursor?: number): Bytes {
  return message(
    ...(query.title ? [writeStringValue(1, query.title)] : []),
    ...(query.language ? [writeStringValue(2, query.language)] : []),
    writeInt(3, query.status),
    writeInt(4, query.sortType),
    // `ASC` is 0 and `DESC` is 1. A sort filter defaults to descending, which is
    // what "most popular first" means.
    writeInt(5, query.ascending ? 0 : 1),
    ...(cursor === undefined ? [] : [writeIntValue(6, cursor)]),
    writeInt(7, count),
    // Genres are matched by name, and the filter's default operator is `And`.
    ...(query.genres.length === 0
      ? []
      : [writeMessage(10, message(...query.genres.map((name) => writeString(1, name))))]),
  )
}
