import {
  DirectFetchTransport,
  RateLimiter,
} from '../../transport/direct-fetch'
import type { HttpTransport } from '../../transport/types'
import type {
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
import type {
  ChapterImagesResponse,
  ChapterListEntry,
  MangaDetailResponse,
  MangaSummaryDto,
  SearchResponse,
} from './dto'

/** Where the site lives, and what "open in browser" must point at. */
const SITE_URL = 'https://mangadot.net'

/**
 * Where requests actually go.
 *
 * Mangadot sends no `Access-Control-Allow-Origin` on anything — not the API,
 * not the page images. A browser therefore cannot read a single response from
 * it directly, so in a browser everything is routed through the app's own
 * origin under `/mangadot`, which the dev server proxies (see vite.config.ts).
 * Outside a browser — the smoke script — there is no such restriction and no
 * proxy to speak to, so the site is addressed directly.
 */
function resolveApiBase(): string {
  if (typeof location === 'undefined') return SITE_URL
  return new URL('/mangadot', location.origin).toString()
}

const PER_PAGE = 24

/**
 * The site's own logo, served from the same origin as everything else.
 *
 * The PWA icon rather than `/mangadotnet-purple.svg`: that path now answers a
 * Cloudflare managed challenge, which the proxy correctly turns into a 503 and
 * the browser draws as a broken image.
 */
const ICON_PATH = '/icon-192.png'

/**
 * Mangadot publishes no rate limit. Two requests a second is well under what
 * the site's own reader spends opening a chapter, and slow enough to stay a
 * guest rather than a load source.
 */
const RATE_LIMIT_PERMITS = 2
const RATE_LIMIT_PERIOD_MS = 1000

/**
 * Same reasoning as the Asura source: the image host is a static CDN, not the
 * rate-limited API, and this is the gap between fetch starts while the worker
 * keeps several pages in flight.
 */
const PAGE_FETCH_INTERVAL_MS = 150

const SORT_VALUES = [
  ['Latest', 'latest'],
  ['Most tracked', 'tracked'],
  ['Most viewed', 'views'],
  ['Top rated', 'rating'],
  ['Chapters', 'chapters'],
  ['A → Z', 'alphabetical'],
  ['Relevance', 'relevance'],
] as const

/**
 * Values are sent verbatim and the API matches them case-sensitively —
 * `status=ongoing` is silently ignored where `status=Ongoing` filters.
 */
const STATUS_VALUES = [
  ['All', ''],
  ['Ongoing', 'Ongoing'],
  ['Completed', 'Completed'],
] as const

const ORIGIN_VALUES = [
  ['All', ''],
  ['Korea', 'KR'],
  ['Japan', 'JP'],
  ['China', 'CN'],
  ['English', 'EN'],
] as const

const CONTENT_RATING_VALUES = [
  ['All', ''],
  ['Safe', 'safe'],
  ['Suggestive', 'suggestive'],
  ['Erotica', 'erotica'],
  ['Pornographic', 'pornographic'],
] as const

export interface MangadotFilterData {
  genres: string[]
}

/**
 * Mangadot.
 *
 * An aggregator rather than a scanlation group: a series carries chapters from
 * several groups at once. Every group's chapters are returned, each tagged
 * with its `scanlator`, and choosing between them is left to the chapter
 * filter — the groups a series actually has are only knowable from its chapter
 * list, and differ from one series to the next.
 *
 * Rated `mixed` on its own evidence rather than upstream's, which does not
 * carry this site: its genre facet offers Adult and Ecchi (`STATIC_GENRES`
 * below is the snapshot of it), so the catalogue holds adult work.
 */
export class Mangadot implements Source {
  readonly id = 'mangadot'
  readonly name = 'Mangadot'
  readonly lang = 'en'
  readonly baseUrl = SITE_URL
  readonly contentRating = 'mixed'
  readonly versionCode = 1
  readonly supportsLatest = true
  readonly isLocal = false
  readonly supportsFilterFetching = true
  /** No endpoint on the site offers related or recommended series. */
  readonly supportsRelatedMangas = false
  readonly pageFetchIntervalMs = PAGE_FETCH_INTERVAL_MS

  readonly iconUrl: string

  private readonly http: HttpTransport
  private readonly apiBase: string

  constructor(transport?: HttpTransport, apiBase = resolveApiBase()) {
    this.apiBase = apiBase.replace(/\/$/, '')
    this.iconUrl = `${this.apiBase}${ICON_PATH}`
    this.http =
      transport ??
      new DirectFetchTransport(
        new RateLimiter(
          RATE_LIMIT_PERMITS,
          RATE_LIMIT_PERIOD_MS,
          // Covers and page images are static files, not API calls; spending
          // the API budget on them would stall the reader behind its own art.
          (url) =>
            url.pathname.includes('/uploads/') ||
            url.pathname.includes('/chapters/'),
        ),
      )
  }

  // ------------------------------------------------------------- browsing --

  getPopularManga(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.getSearchMangaList(page, '', [sortFilter('tracked')], signal)
  }

  getLatestUpdates(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.getSearchMangaList(page, '', [sortFilter('latest')], signal)
  }

  async getSearchMangaList(
    page: number,
    query: string,
    filters: FilterList,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const url = new URL(`${this.apiBase}/api/search`)
    url.searchParams.set('page', String(page))
    url.searchParams.set('limit', String(PER_PAGE))
    if (query.trim()) url.searchParams.set('search', query.trim())
    applyFilters(url, filters)

    const res = await this.http.fetch({ url: url.toString(), signal })
    const body = await res.json<SearchResponse>()

    return {
      mangas: (body.manga_list ?? []).map((dto) => this.toSManga(dto)),
      hasNextPage: hasMore(body, page),
    }
  }

  // -------------------------------------------------------------- details --

  async getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
    signal?: AbortSignal,
  ): Promise<MangaUpdate> {
    const id = idOf(manga)
    const [details, chapters] = await Promise.all([
      opts.fetchDetails ? this.fetchDetails(id, signal) : Promise.resolve(manga),
      opts.fetchChapters ? this.fetchChapters(id, signal) : Promise.resolve([]),
    ])
    return { manga: details, chapters }
  }

  private async fetchDetails(
    id: number,
    signal?: AbortSignal,
  ): Promise<SManga> {
    const res = await this.http.fetch({
      url: `${this.apiBase}/api/manga/${id}`,
      signal,
    })
    const body = await res.json<MangaDetailResponse>()
    const manga = this.toSManga(body.manga)

    return {
      ...manga,
      author: joinNames(body.manga.authors),
      artist: joinNames(body.manga.artists),
      initialized: true,
    }
  }

  private async fetchChapters(
    id: number,
    signal?: AbortSignal,
  ): Promise<SChapter[]> {
    // Every group's chapters, unfiltered. The endpoint takes a `group_id`, but
    // narrowing here would hide from the chapter filter the very groups it
    // exists to offer.
    const res = await this.http.fetch({
      url: `${this.apiBase}/api/manga/${id}/chapters/list`,
      signal,
    })
    // This endpoint answers with a bare array rather than an envelope.
    const entries = await res.json<ChapterListEntry[]>()
    // The endpoint returns no meaningful order — an aggregator interleaves
    // several groups' uploads — so newest-first is imposed here rather than
    // assumed, with the upload date breaking ties between duplicate numbers.
    return (entries ?? [])
      .map((entry) => toSChapter(entry, id))
      .sort(
        (a, b) =>
          b.chapterNumber - a.chapterNumber ||
          (b.dateUpload ?? 0) - (a.dateUpload ?? 0),
      )
  }

  // ---------------------------------------------------------------- pages --

  async getPageList(
    manga: SManga,
    chapter: SChapter,
    signal?: AbortSignal,
  ): Promise<Page[]> {
    const { id, source } = chapterRef(chapter)
    // Uploads and scraped chapters live in separate tables, each with its own
    // id space, and are served by separate endpoints.
    const collection = source === 'scraper' ? 'chapters' : 'uploads'

    const res = await this.http.fetch({
      url: `${this.apiBase}/api/${collection}/${id}/images`,
      signal,
    })
    const body = await res.json<ChapterImagesResponse>()

    // Because the id spaces overlap, reading the wrong table answers 200 with
    // a real chapter of some other series rather than failing. Confirming the
    // series turns that into an error instead of a silently wrong chapter.
    const servedFor = body.manga?.id
    const expected = idOf(manga)
    if (typeof servedFor === 'number' && servedFor !== expected) {
      throw new Error(
        `Mangadot served chapter ${id} of series ${servedFor}, expected series ${expected}.`,
      )
    }

    const images = body.images ?? []

    if (images.length === 0) {
      throw new Error('This chapter has no pages on Mangadot.')
    }

    // Images are whole files at site-relative paths. Nothing is tiled or
    // signed here — `/api/token/generate` answers with empty strings — so
    // `Page.descramble` is left unset.
    return images.map((image, index) => ({
      index,
      imageUrl: this.resolve(image.url),
    }))
  }

  // -------------------------------------------------------------- filters --

  /**
   * Genres come from the search endpoint's own facets rather than
   * `/api/manga/tags`, which returns 140 KB of tag taxonomy to answer a
   * question the facets answer in a few hundred bytes — and returns the genre
   * strings in exactly the spelling the `genres` parameter expects.
   */
  async fetchFilterData(): Promise<MangadotFilterData> {
    try {
      const res = await this.http.fetch({
        url: `${this.apiBase}/api/search?facets=1&limit=1`,
      })
      const body = await res.json<SearchResponse>()
      const genres = (body.facets?.genres ?? [])
        .map((bucket) => bucket.key)
        .filter(Boolean)
      if (genres.length) return { genres }
    } catch {
      // Fall through to the snapshot.
    }
    return { genres: [...STATIC_GENRES] }
  }

  getFilterList(data?: unknown): FilterList {
    const genres = (data as MangadotFilterData | undefined)?.genres ?? []

    return [
      sortFilter(),
      selectFilter('Status', STATUS_VALUES),
      selectFilter('Origin', ORIGIN_VALUES),
      selectFilter('Content rating', CONTENT_RATING_VALUES),
      {
        type: 'group',
        name: 'Genres',
        state: genres.map((name) => ({
          type: 'checkbox' as const,
          name,
          state: false,
        })),
      },
      { type: 'text', name: 'Min Chapters', state: '' },
    ]
  }

  // ----------------------------------------------------------------- urls --

  /** Site-relative path to something fetchable from wherever we are running. */
  private resolve(path: string): string {
    if (/^https?:\/\//.test(path)) return path
    return `${this.apiBase}${path.startsWith('/') ? path : `/${path}`}`
  }

  private toSManga(dto: MangaSummaryDto): SManga {
    return {
      // `/series/<id>` rather than the site's own `/manga/<id>`: the app's
      // route params are the trailing segments of these urls, and the reader
      // rebuilds a series from the slug alone, so every source uses this shape.
      url: `/series/${dto.id}`,
      title: dto.title,
      description: dto.description?.trim() || undefined,
      genre: dto.genres ?? [],
      status: toStatus(dto.status, dto.hiatus),
      thumbnailUrl: dto.photo ? this.resolve(dto.photo) : undefined,
      initialized: Boolean(dto.description),
      memo: { id: dto.id },
    }
  }

  getMangaWebUrl(manga: SManga): string {
    return `${SITE_URL}/manga/${idOf(manga)}`
  }

  /**
   * User uploads and scraped chapters read at the same path but the reader
   * needs `?source=user` to look in the right table, matching the site's own
   * link builder.
   */
  getChapterWebUrl(_manga: SManga, chapter: SChapter): string {
    const { id, source } = chapterRef(chapter)
    const suffix = source === 'user' ? '?source=user' : ''
    return `${SITE_URL}/chapter/${id}${suffix}`
  }
}

// ------------------------------------------------------------- conversion --

/**
 * The series id, from the memo when there is one and from the url otherwise.
 *
 * The reader builds its series stub from the route slug alone and so has no
 * memo to offer, which is why the url has to remain sufficient on its own.
 */
function idOf(manga: SManga): number {
  const memoId = manga.memo?.id
  if (typeof memoId === 'number') return memoId
  const memoSlug = manga.memo?.slug
  const raw =
    typeof memoSlug === 'string' && memoSlug
      ? memoSlug
      : manga.url.replace(/^\/series\//, '').split('/')[0]
  const parsed = Number(raw)
  if (!Number.isInteger(parsed)) {
    throw new Error(`Not a Mangadot manga url: ${manga.url}`)
  }
  return parsed
}

/**
 * Chapter ids are only unique *within* a collection: `/api/uploads/120079` and
 * `/api/chapters/120079` are different chapters of different series. So which
 * collection a chapter came from is part of its identity, and has to survive
 * into the route key — the reader reconstructs a chapter from that key and
 * nothing else, and guessing wrong would quietly serve another series' pages.
 */
const CHAPTER_KEY_REGEX = /^(\d+)-(user|scraper)$/

function chapterRef(chapter: SChapter): { id: number; source: ChapterSource } {
  const memoId = chapter.memo?.id
  const memoSource = chapter.memo?.source
  if (typeof memoId === 'number' && isChapterSource(memoSource)) {
    return { id: memoId, source: memoSource }
  }

  const key = chapter.url.split('/').pop() ?? ''
  const match = CHAPTER_KEY_REGEX.exec(key)
  if (!match) {
    throw new Error(`Not a Mangadot chapter url: ${chapter.url}`)
  }
  return { id: Number(match[1]), source: match[2] as ChapterSource }
}

type ChapterSource = 'user' | 'scraper'

function isChapterSource(value: unknown): value is ChapterSource {
  return value === 'user' || value === 'scraper'
}

function toSChapter(entry: ChapterListEntry, mangaId: number): SChapter {
  const source: ChapterSource = entry.source === 'scraper' ? 'scraper' : 'user'
  return {
    url: `/series/${mangaId}/chapter/${entry.id}-${source}`,
    name: chapterName(entry),
    chapterNumber: entry.chapter_number,
    dateUpload: entry.date_added ? parseDate(entry.date_added) : undefined,
    scanlator: entry.scanlator_name ?? entry.group_name ?? undefined,
    memo: { id: entry.id, source: entry.source ?? 'user' },
  }
}

function chapterName(entry: ChapterListEntry): string {
  const parts: string[] = []
  if (entry.volume_number != null) parts.push(`Vol. ${entry.volume_number}`)
  parts.push(`Chapter ${entry.chapter_number}`)
  const name = parts.join(' ')
  const title = entry.chapter_title?.trim()
  if (!title || restatesNumber(title, entry.chapter_number)) return name
  return `${name} - ${title}`
}

/**
 * Uploaders here routinely fill the title in with the chapter number they were
 * already given — `Chapter 4`, `Ep. 4`, or a bare `4` — which would render as
 * "Chapter 4 - Chapter 4". Only a title that says something the number does not
 * is worth appending.
 */
const RESTATED_NUMBER_REGEX =
  /^(?:ch(?:apter)?|ep(?:isode)?)?\s*\.?\s*0*(\d+(?:\.\d+)?)$/i

function restatesNumber(title: string, chapterNumber: number): boolean {
  const match = RESTATED_NUMBER_REGEX.exec(title)
  return match ? Number(match[1]) === chapterNumber : false
}

/**
 * Timestamps arrive as `2026-08-25 09:20:17.19611+00`, which is ISO 8601 in
 * two places short of being parseable: a space where the `T` belongs, and a
 * two-digit UTC offset where the standard wants `+00:00`. Every engine returns
 * NaN for the offset as sent, so both have to be repaired or the whole chapter
 * list dates to 1970.
 */
function parseDate(raw: string): number | undefined {
  const normalised = raw
    .replace(' ', 'T')
    .replace(/([+-]\d{2})$/, '$1:00')
  const parsed = Date.parse(normalised)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * `authors` and `artists` are arrays that were JSON-encoded a second time
 * before being put on the wire, so the field holds the *string* `["YUJU"]`.
 */
function joinNames(raw?: string): string | undefined {
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      const names = parsed.filter(
        (name): name is string => typeof name === 'string' && name.length > 0,
      )
      return names.length ? names.join(', ') : undefined
    }
  } catch {
    // Not JSON after all — treat it as the plain name it appears to be.
  }
  return raw.trim() || undefined
}

/**
 * `status` never says "hiatus"; that lives in its own `Yes`/`No` column, and a
 * series on hiatus is still listed as Ongoing. Checking it first is what makes
 * the distinction survive.
 */
function toStatus(status?: string, hiatus?: string): MangaStatus {
  if (hiatus?.toLowerCase() === 'yes') return 'on_hiatus'
  switch (status?.toLowerCase()) {
    case 'ongoing':
      return 'ongoing'
    case 'completed':
      return 'completed'
    case 'cancelled':
    case 'dropped':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

// ---------------------------------------------------------------- filters --

function sortFilter(defaultValue?: string): Filter {
  const index = SORT_VALUES.findIndex(([, value]) => value === defaultValue)
  return {
    type: 'sort',
    name: 'Sort By',
    values: SORT_VALUES.map(([label]) => label),
    state: { index: index === -1 ? 0 : index, ascending: false },
  }
}

function selectFilter(
  name: string,
  values: readonly (readonly [string, string])[],
): Filter {
  return { type: 'select', name, values: values.map(([l]) => l), state: 0 }
}

/**
 * Whether another page exists.
 *
 * `pagination` carries `total_pages` outright, so unlike Asura there is
 * nothing to infer — the only uncertainty is the endpoint omitting the block,
 * in which case a short page is the end and a full one might not be.
 */
function hasMore(body: SearchResponse, page: number): boolean {
  const pagination = body.pagination
  if (pagination && typeof pagination.total_pages === 'number') {
    return page < pagination.total_pages
  }
  return (body.manga_list?.length ?? 0) >= PER_PAGE
}

const SELECT_PARAMS: Record<
  string,
  { param: string; table: readonly (readonly [string, string])[] }
> = {
  Status: { param: 'status', table: STATUS_VALUES },
  Origin: { param: 'origin', table: ORIGIN_VALUES },
  'Content rating': { param: 'content_rating', table: CONTENT_RATING_VALUES },
}

function applyFilters(url: URL, filters: FilterList): void {
  for (const filter of filters) {
    switch (filter.type) {
      case 'sort': {
        url.searchParams.set('sortBy', SORT_VALUES[filter.state.index][1])
        url.searchParams.set('sortOrder', filter.state.ascending ? 'asc' : 'desc')
        break
      }
      case 'select': {
        const mapping = SELECT_PARAMS[filter.name]
        if (!mapping) break
        const value = mapping.table[filter.state]?.[1]
        if (value) url.searchParams.set(mapping.param, value)
        break
      }
      case 'group': {
        if (filter.name !== 'Genres') break
        // Repeating `genres` widens the result set; one comma-joined value
        // narrows it, which is what checking two boxes is asking for.
        const checked = filter.state
          .filter((f) => f.type === 'checkbox' && f.state)
          .map((f) => (f as { name: string }).name)
        if (checked.length) url.searchParams.set('genres', checked.join(','))
        break
      }
      case 'text': {
        if (filter.name === 'Min Chapters' && filter.state.trim()) {
          url.searchParams.set('min_chapters', filter.state.trim())
        }
        break
      }
    }
  }
}

/** Snapshot of the genre facet, used only when that call fails. */
const STATIC_GENRES: string[] = [
  'Action',
  'Adult',
  'Adventure',
  'Boys Love',
  'Comedy',
  'Drama',
  'Ecchi',
  'Fantasy',
  'Girls Love',
  'Harem',
  'Historical',
  'Horror',
  'Isekai',
  'Josei',
  'Martial Arts',
  'Mecha',
  'Mystery',
  'Psychological',
  'Romance',
  'School Life',
  'Sci-Fi',
  'Seinen',
  'Shoujo',
  'Shounen',
  'Slice of Life',
  'Sports',
  'Supernatural',
  'Thriller',
  'Tragedy',
]
