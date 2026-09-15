import { DirectFetchTransport, RateLimiter } from '../../transport/direct-fetch'
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
  BrowseResponse,
  ChapterDetailResponse,
  ChapterDto,
  LatestResponse,
  NextData,
  SeriesDetailResponse,
  SeriesDto,
} from './dto'

/** Where the site lives, and what "open in browser" must point at. */
const SITE_URL = 'https://flamecomics.xyz'

/** Covers and page images. Sends no CORS headers. */
const CDN_URL = 'https://cdn.flamecomics.xyz'

const ICON_URL =
  'https://cdn.jsdelivr.net/gh/keiyoushi/extensions-source@main/src/en/flamecomics/res/mipmap-xhdpi/ic_launcher.png'

/**
 * Where requests actually go.
 *
 * Neither host sends `Access-Control-Allow-Origin`, so in a browser the site
 * is reached under `/flamecomics` and the CDN under `/flamecdn`. Outside a
 * browser there is no CORS and no proxy, so both are addressed directly.
 */
function resolveApiBase(): string {
  if (typeof location === 'undefined') return SITE_URL
  return new URL('/flamecomics', location.origin).toString()
}

function resolveCdnBase(): string {
  if (typeof location === 'undefined') return CDN_URL
  return new URL('/flamecdn', location.origin).toString()
}

/**
 * How many series a browse page shows.
 *
 * The site hands back its whole catalogue in one document and pages it in the
 * browser, so this is a slice size rather than a request parameter.
 */
const PER_PAGE = 24

/** The extension's budget: two requests per two seconds, covers exempt. */
const RATE_LIMIT_PERMITS = 2
const RATE_LIMIT_PERIOD_MS = 2000

/** The gap between page-image fetch starts. See the other comic sources. */
const PAGE_FETCH_INTERVAL_MS = 150

const SORT_VALUES = [
  ['Popular', 'popular'],
  ['Latest', 'latest'],
  ['A → Z', 'title'],
] as const

const STATUS_VALUES = [
  ['All', ''],
  ['Ongoing', 'ongoing'],
  ['Completed', 'completed'],
  ['Hiatus', 'hiatus'],
  ['Dropped', 'dropped'],
  ['Cancelled', 'cancelled'],
  ['Coming soon', 'coming soon'],
] as const

const TYPE_VALUES = [
  ['All', ''],
  ['Manhwa', 'Manhwa'],
  ['Manhua', 'Manhua'],
  ['Manga', 'Manga'],
  ['Comic', 'Comic'],
] as const

/**
 * Series types this source will not list.
 *
 * They are prose, and a prose series read through `getPageList` would open to
 * an empty chapter. The site files them in the same catalogue; the app models
 * comics and novels as different sources, so they are dropped here.
 */
const NOVEL_TYPES = new Set(['novel', 'web novel'])

/**
 * Flame Comics.
 *
 * A Next.js site read through its own data routes, so the responses are JSON
 * rather than HTML. The catch is `buildId`: those routes are namespaced by the
 * build that produced them, the id changes on every deploy, and a request
 * carrying a stale one is answered with an HTML 404 that contains the current
 * id. So it is discovered once, cached, and re-read once on that 404 — which
 * is the same recovery the Kotlin extension performs in an interceptor.
 */
export class FlameComics implements Source {
  readonly id = 'flamecomics'
  readonly name = 'Flame Comics'
  readonly lang = 'en'
  readonly baseUrl = SITE_URL
  readonly iconUrl = ICON_URL
  readonly contentRating = 'safe'
  readonly versionCode = 1
  readonly supportsLatest = true
  readonly isLocal = false
  readonly supportsFilterFetching = false
  readonly supportsRelatedMangas = false
  readonly pageFetchIntervalMs = PAGE_FETCH_INTERVAL_MS

  private readonly http: HttpTransport
  private readonly apiBase: string
  private readonly cdnBase: string

  /** Discovered on the first data call and reused until a 404 says otherwise. */
  private buildId: string | null = null

  constructor(
    transport?: HttpTransport,
    apiBase = resolveApiBase(),
    cdnBase = resolveCdnBase(),
  ) {
    this.apiBase = apiBase.replace(/\/$/, '')
    this.cdnBase = cdnBase.replace(/\/$/, '')
    this.http =
      transport ??
      new DirectFetchTransport(
        new RateLimiter(RATE_LIMIT_PERMITS, RATE_LIMIT_PERIOD_MS, (url) =>
          url.pathname.startsWith('/flamecdn') || url.host === new URL(CDN_URL).host,
        ),
      )
  }

  // ------------------------------------------------------------- browsing --

  getPopularManga(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.getSearchMangaList(page, '', [sortFilter('popular')], signal)
  }

  /**
   * The home page's "latest" block, which is a fixed set the site curates.
   * It is not paged, so page 2 is never offered.
   */
  async getLatestUpdates(
    page: number,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    if (page > 1) return { mangas: [], hasNextPage: false }

    const body = await this.data<LatestResponse>('index.json', {}, signal)
    const series = (body.pageProps.latestEntries?.blocks ?? []).flatMap(
      (block) => block.series ?? [],
    )

    return {
      mangas: listable(series).map((dto) => this.toSManga(dto)),
      hasNextPage: false,
    }
  }

  /**
   * Search and filtering both happen here rather than upstream: the browse
   * route answers with the entire catalogue and the site's own page filters it
   * in the browser. Matching that keeps one request per browse instead of one
   * per keystroke, and is the only way to search at all.
   */
  async getSearchMangaList(
    page: number,
    query: string,
    filters: FilterList,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const body = await this.data<BrowseResponse>('browse.json', {}, signal)
    let series = listable(body.pageProps.series)

    const term = normalize(query)
    if (term) {
      series = series.filter((dto) =>
        [dto.title, ...(dto.altTitles ?? [])].some((title) =>
          normalize(title).includes(term),
        ),
      )
    }

    series = applyFilters(series, filters)

    const start = (page - 1) * PER_PAGE
    const slice = series.slice(start, start + PER_PAGE)

    return {
      mangas: slice.map((dto) => this.toSManga(dto)),
      hasNextPage: start + slice.length < series.length,
    }
  }

  // -------------------------------------------------------------- details --

  async getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
    signal?: AbortSignal,
  ): Promise<MangaUpdate> {
    const id = seriesId(manga.url)
    if (!id) throw new Error('This series has no Flame Comics path.')

    // Details and chapters arrive in the same document, so one call answers
    // both no matter which the caller asked for.
    const body = await this.data<SeriesDetailResponse>(
      `series/${id}.json`,
      { id },
      signal,
    )

    return {
      manga: opts.fetchDetails ? this.toSManga(body.pageProps.series) : manga,
      chapters: opts.fetchChapters
        ? (body.pageProps.chapters ?? []).map(toSChapter)
        : [],
    }
  }

  // ---------------------------------------------------------------- pages --

  async getPageList(
    _manga: SManga,
    chapter: SChapter,
    signal?: AbortSignal,
  ): Promise<Page[]> {
    const [id, token] = chapterParts(chapter.url)
    if (!id || !token) throw new Error('This chapter has no Flame Comics path.')

    const body = await this.data<ChapterDetailResponse>(
      `series/${id}/${token}.json`,
      { id, token },
      signal,
    )
    const detail = body.pageProps.chapter

    // `images` is an object keyed by index-as-string. Object key order is not
    // a contract for numeric-looking keys in every engine, so it is sorted
    // numerically rather than trusted.
    const names = Object.entries(detail.images ?? {})
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, image]) => image.name)

    if (names.length === 0) {
      throw new Error('This chapter has no pages on Flame Comics.')
    }

    // Whole images, nothing tiled, so `Page.descramble` stays unset.
    return names.map((name, index) => ({
      index,
      imageUrl: `${this.cdnBase}/uploads/images/series/${detail.series_id}/${detail.token}/${encodeURIComponent(name)}?${detail.release_date}`,
    }))
  }

  // -------------------------------------------------------------- filters --

  getFilterList(): FilterList {
    return [
      sortFilter(),
      selectFilter('Status', STATUS_VALUES),
      selectFilter('Type', TYPE_VALUES),
    ]
  }

  // ----------------------------------------------------------------- urls --

  getMangaWebUrl(manga: SManga): string {
    return `${SITE_URL}/series/${seriesId(manga.url) ?? ''}`
  }

  getChapterWebUrl(_manga: SManga, chapter: SChapter): string {
    const [id, token] = chapterParts(chapter.url)
    return `${SITE_URL}/series/${id ?? ''}/${token ?? ''}`
  }

  // ------------------------------------------------------------ transport --

  /**
   * One data-route call, retried once against a freshly read build id.
   *
   * A stale id is answered with the site's HTML 404 page, not with JSON, so the
   * failure shows up as a parse error rather than a status. Both are treated
   * the same: read the id off the home page and try once more. A second failure
   * is the caller's to report.
   */
  private async data<T>(
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await this.fetchData<T>(
        await this.currentBuildId(signal),
        path,
        params,
        signal,
      )
    } catch (error) {
      // A cancelled call is not a failed one. Retrying it would put the
      // request the caller walked away from back on the wire.
      if (signal?.aborted || isAbortError(error)) throw error

      this.buildId = null
      return await this.fetchData<T>(
        await this.currentBuildId(signal),
        path,
        params,
        signal,
      )
    }
  }

  private async fetchData<T>(
    buildId: string,
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = new URL(`${this.apiBase}/_next/data/${buildId}/${path}`)
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
    const res = await this.http.fetch({ url: url.toString(), signal })
    return await res.json<T>()
  }

  private async currentBuildId(signal?: AbortSignal): Promise<string> {
    if (this.buildId) return this.buildId

    const res = await this.http.fetch({ url: `${this.apiBase}/`, signal })
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html')
    const raw = doc.querySelector('script#__NEXT_DATA__')?.textContent
    if (!raw) throw new Error('Flame Comics did not serve a readable home page.')

    const buildId = (JSON.parse(raw) as NextData).buildId
    if (!buildId) throw new Error('Flame Comics served no build id.')

    this.buildId = buildId
    return buildId
  }

  // -------------------------------------------------------------- mapping --

  private toSManga(dto: SeriesDto): SManga {
    const genre = [
      ...(dto.type ? [dto.type] : []),
      ...(dto.categories ?? []),
      ...(dto.tags ?? []),
    ]

    return {
      url: `/series/${dto.series_id}`,
      title: dto.title,
      author: dto.author?.join(', ') || undefined,
      artist: dto.artist?.join(', ') || undefined,
      description: buildDescription(dto),
      genre: genre.length > 0 ? genre : undefined,
      status: toStatus(dto.status),
      thumbnailUrl: dto.cover
        ? `${this.cdnBase}/uploads/images/series/${dto.series_id}/${dto.cover}?${dto.last_edit ?? ''}`
        : undefined,
      // The browse payload already carries author, status and description, so
      // a listed series is as complete as a fetched one.
      initialized: Boolean(dto.description || dto.author?.length),
    }
  }
}

// ------------------------------------------------------------- conversion --

/** `DOMException` is not reliably `instanceof Error` everywhere; match by name. */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

/** Rows a reader can actually open: real ids, comics rather than prose. */
function listable(series: SeriesDto[]): SeriesDto[] {
  return series.filter(
    (dto) =>
      dto.series_id !== null &&
      dto.series_id !== undefined &&
      !NOVEL_TYPES.has((dto.type ?? '').toLowerCase()),
  )
}

/**
 * The app addresses every source through `/series/<slug>` and
 * `/series/<slug>/chapter/<key>`, and rebuilds both from route parameters
 * alone — see `MangaDetailView` in the series route and `chapterStubOf` in
 * the reader. Both segments therefore have to carry everything needed to
 * re-address the work, and neither may contain a slash.
 */
function seriesId(url: string): string | null {
  return /^\/series\/(\d+)/.exec(url)?.[1] ?? null
}

function chapterParts(url: string): [string | null, string | null] {
  const match = /^\/series\/(\d+)\/chapter\/([A-Za-z0-9]+)$/.exec(url)
  return [match?.[1] ?? null, match?.[2] ?? null]
}

function toSChapter(dto: ChapterDto): SChapter {
  const number = Number(dto.chapter)
  const label = dto.chapter.replace(/\.0+$/, '')
  const title = dto.title?.trim()

  return {
    url: `/series/${dto.series_id}/chapter/${dto.token}`,
    name: title ? `Chapter ${label} - ${title}` : `Chapter ${label}`,
    chapterNumber: Number.isFinite(number) ? number : -1,
    dateUpload: dto.release_date > 0 ? dto.release_date * 1000 : undefined,
  }
}

/**
 * The synopsis, with alternative titles appended.
 *
 * Descriptions arrive as HTML fragments, so they are flattened to text rather
 * than handed to the UI, which renders this field as plain prose.
 */
function buildDescription(dto: SeriesDto): string | undefined {
  const parts: string[] = []

  if (dto.description) {
    const text = new DOMParser()
      .parseFromString(dto.description, 'text/html')
      .body.textContent?.trim()
    if (text) parts.push(text)
  }

  const alternatives = (dto.altTitles ?? []).map((t) => t.trim()).filter(Boolean)
  if (alternatives.length > 0) {
    parts.push(`Alternative titles:\n${alternatives.map((t) => `- ${t}`).join('\n')}`)
  }

  return parts.length > 0 ? parts.join('\n\n') : undefined
}

function toStatus(raw?: string | null): MangaStatus {
  switch (raw?.toLowerCase()) {
    case 'ongoing':
      return 'ongoing'
    case 'completed':
      return 'completed'
    case 'hiatus':
      return 'on_hiatus'
    case 'dropped':
    case 'cancelled':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

/** Titles are matched on letters and digits alone, as the site's own search is. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// ---------------------------------------------------------------- filters --

function sortFilter(defaultValue?: string): Filter {
  const index = SORT_VALUES.findIndex(([, v]) => v === defaultValue)
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

function applyFilters(series: SeriesDto[], filters: FilterList): SeriesDto[] {
  let result = series
  let sort: (typeof SORT_VALUES)[number][1] = 'popular'
  let ascending = false

  for (const filter of filters) {
    switch (filter.type) {
      case 'sort':
        sort = SORT_VALUES[filter.state.index]![1]
        ascending = filter.state.ascending
        break
      case 'select': {
        const table = filter.name === 'Status' ? STATUS_VALUES : TYPE_VALUES
        const value = table[filter.state]?.[1]
        if (!value) break
        result = result.filter((dto) =>
          filter.name === 'Status'
            ? (dto.status ?? '').toLowerCase() === value
            : (dto.type ?? '') === value,
        )
        break
      }
    }
  }

  const sorted = [...result].sort((a, b) => compare(a, b, sort))
  return ascending ? sorted.reverse() : sorted
}

/**
 * Ordering for the default, descending direction of each sort.
 *
 * `popularityRank` counts up from 1, so "most popular first" is ascending by
 * that number. A row without one sorts last rather than first, which is what
 * keeps drafts and new series out of the top of the popular tab.
 */
function compare(a: SeriesDto, b: SeriesDto, sort: string): number {
  switch (sort) {
    case 'latest':
      return (b.last_edit ?? 0) - (a.last_edit ?? 0)
    case 'title':
      return a.title.localeCompare(b.title)
    default:
      return (
        (a.popularityRank ?? Number.MAX_SAFE_INTEGER) -
        (b.popularityRank ?? Number.MAX_SAFE_INTEGER)
      )
  }
}
