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
  ChapterDetailResponse,
  ChapterDto,
  ChapterListResponse,
  GenresResponse,
  Meta,
  SeriesDetailResponse,
  SeriesDto,
  SeriesListResponse,
} from './dto'

const BASE_URL = 'https://asurascans.com'
const API_URL = 'https://api.asurascans.com/api'

/** Where covers and page images are served from. Sends no CORS at all. */
const CDN_URL = 'https://cdn.asurascans.com'

/**
 * Where requests actually go.
 *
 * Both Asura hosts are reached through this origin in a browser. The API is
 * the lesser reason — it reflects `Origin` and so would work read directly —
 * but the CDN sends no CORS headers under any request, and read directly its
 * images arrive opaque: unreadable to JavaScript, so no CBZ export, and charged
 * `OPAQUE_PADDING_BYTES` of quota each rather than what they weigh. The hop is
 * what makes an Asura chapter cost its real ~2.5 MB instead of a projected
 * ~105 MB.
 *
 * Outside a browser there is no CORS and no proxy to speak to, so the hosts are
 * addressed directly — which is what keeps `scripts/smoke-asura.ts` running
 * under Node with no arguments.
 */
function resolveApiBase(): string {
  if (typeof location === 'undefined') return API_URL
  return new URL('/asurascans/api', location.origin).toString()
}

function resolveCdnBase(): string {
  if (typeof location === 'undefined') return CDN_URL
  return new URL('/asuracdn', location.origin).toString()
}

/** Also the API's ceiling: `limit` above 50 is ignored and 20 used instead. */
const PER_PAGE = 20

/** Keiyoushi publishes extension icons on jsDelivr, which sends `ACAO: *`. */
const ICON_URL =
  'https://cdn.jsdelivr.net/gh/keiyoushi/extensions-source@main/src/en/asurascans/res/mipmap-xhdpi/ic_launcher.png'

/** The extension's budget: 2 requests per 2 seconds per IP, covers exempt. */
const RATE_LIMIT_PERMITS = 2
const RATE_LIMIT_PERIOD_MS = 2000

/**
 * Page images come from `cdn.asurascans.com`, a static file host that answers
 * a repeat request in tens of milliseconds and publishes no limit. The API's
 * pace was never the right budget for it, and pacing pages one at a time held
 * a chapter to under 1 MB/s on any connection.
 *
 * 150 ms holds the CDN to under seven request starts a second per host. The
 * worker fetches several pages at once (see `PAGE_FETCH_CONCURRENCY` in
 * `public/sw.js`), so this is the gap between starts, not between responses.
 */
const PAGE_FETCH_INTERVAL_MS = 150

const SORT_VALUES = [
  ['Latest Update', 'latest'],
  ['Popular', 'popular'],
  ['Rating', 'rating'],
  ['A-Z', 'title'],
  ['Newest', 'update'],
] as const

const STATUS_VALUES = [
  ['All', ''],
  ['Ongoing', 'ongoing'],
  ['Completed', 'completed'],
  ['Hiatus', 'hiatus'],
  ['Dropped', 'dropped'],
] as const

const TYPE_VALUES = [
  ['All', ''],
  ['Manhwa', 'manhwa'],
  ['Manhua', 'manhua'],
  ['Mangatoon', 'manga'],
] as const

export interface AsuraFilterData {
  genres: { label: string; value: string }[]
}

/**
 * Asura Scans.
 *
 * Unlike the Android extension this talks only to the JSON API. The site's HTML
 * is never read, so the Astro-prop scraping, randomised-slug retries and
 * page-token handshake the Kotlin source needs are all unnecessary here.
 *
 * Both hosts are reached through this origin in a browser — see
 * `resolveApiBase` above for why the CDN leaves no choice.
 */
export class AsuraScans implements Source {
  readonly id = 'asurascans'
  readonly name = 'Asura Scans'
  readonly lang = 'en'
  readonly baseUrl = BASE_URL
  readonly iconUrl = ICON_URL
  readonly contentRating = 'safe'
  readonly versionCode = 1
  readonly supportsLatest = true
  readonly isLocal = false
  readonly supportsFilterFetching = true
  readonly supportsRelatedMangas = true
  readonly pageFetchIntervalMs = PAGE_FETCH_INTERVAL_MS

  private readonly http: HttpTransport
  private readonly apiBase: string
  private readonly cdnBase: string

  /** Genre label to the slug the API filters by. */
  private genreValues = new Map<string, string>()

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
          // Everything the CDN serves, covers included. These are static files
          // on a host the budget above does not govern; spending the API's
          // permits on them stalls the calls that actually need them.
          url.pathname.includes('/asura-images/'),
        ),
      )
  }

  // ------------------------------------------------------------- browsing --

  getPopularManga(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.getSearchMangaList(page, '', [sortFilter('popular')], signal)
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
    const offset = (page - 1) * PER_PAGE
    const url = new URL(`${this.apiBase}/series`)
    url.searchParams.set('offset', String(offset))
    url.searchParams.set('limit', String(PER_PAGE))
    if (query.trim()) url.searchParams.set('search', query.trim())
    applyFilters(url, filters, this.genreValues)

    const res = await this.http.fetch({ url: url.toString(), signal })
    const body = await res.json<SeriesListResponse>()
    const data = body.data ?? []

    return {
      mangas: data.map((dto) => toSManga(dto, this.image)),
      hasNextPage: hasMore(body.meta, offset, data.length),
    }
  }

  // -------------------------------------------------------------- details --

  async getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
    signal?: AbortSignal,
  ): Promise<MangaUpdate> {
    const slug = slugOf(manga)
    const [details, chapters] = await Promise.all([
      opts.fetchDetails ? this.fetchDetails(slug, signal) : Promise.resolve(manga),
      opts.fetchChapters ? this.fetchChapters(slug, signal) : Promise.resolve([]),
    ])
    return { manga: details, chapters }
  }

  private async fetchDetails(
    slug: string,
    signal?: AbortSignal,
  ): Promise<SManga> {
    const res = await this.http.fetch({
      url: `${this.apiBase}/series/${slug}`,
      signal,
    })
    const body = await res.json<SeriesDetailResponse>()
    return toSManga(body.series, this.image)
  }

  private async fetchChapters(
    slug: string,
    signal?: AbortSignal,
  ): Promise<SChapter[]> {
    const res = await this.http.fetch({
      url: `${this.apiBase}/series/${slug}/chapters`,
      signal,
    })
    const body = await res.json<ChapterListResponse>()

    // Chapters behind a subscription are never readable here, so they are
    // always left out rather than listed as something that cannot open.
    return (body.data ?? [])
      .filter((c) => !isLocked(c))
      .map((c) => toSChapter(c, slug))
  }

  async getRelatedMangaList(manga: SManga): Promise<SManga[]> {
    const res = await this.http.fetch({
      url: `${this.apiBase}/series/${slugOf(manga)}`,
    })
    const body = await res.json<SeriesDetailResponse>()
    return (body.recommended_series ?? []).map((dto) =>
      toSManga(dto, this.image),
    )
  }

  // ---------------------------------------------------------------- pages --

  async getPageList(
    manga: SManga,
    chapter: SChapter,
    signal?: AbortSignal,
  ): Promise<Page[]> {
    const slug = slugOf(manga)
    const number = chapter.url.split('/').pop()!

    const res = await this.http.fetch({
      url: `${this.apiBase}/series/${slug}/chapters/${number}`,
      signal,
    })
    const body = await res.json<ChapterDetailResponse>()

    if (body.data?.is_locked) {
      throw new Error(
        'This chapter is locked behind an Asura Scans subscription.',
      )
    }

    // Pages carry a url and nothing else. The Kotlin extension's tile
    // descrambling has no counterpart here: the API serves whole images, so
    // `Page.descramble` is left unset rather than guessed at.
    return (body.data?.chapter?.pages ?? []).map((p, index) => ({
      index,
      imageUrl: this.image(p.url),
    }))
  }

  // -------------------------------------------------------------- filters --

  async fetchFilterData(): Promise<AsuraFilterData> {
    const genres = await this.fetchGenres()
    this.rememberGenres(genres)
    return { genres }
  }

  /**
   * The site's live genre list, falling back to a snapshot of it.
   *
   * The snapshot is stale by definition — it was five genres short of the live
   * list when this was written — but a filter sheet missing a few options beats
   * one that will not open because the endpoint blipped.
   */
  private async fetchGenres(): Promise<AsuraFilterData['genres']> {
    try {
      const res = await this.http.fetch({ url: `${this.apiBase}/genres` })
      const body = await res.json<GenresResponse>()
      const genres = (body.data ?? [])
        .filter((g) => g.name && g.slug)
        .map((g) => ({ label: g.name, value: g.slug }))
      if (genres.length) return genres
    } catch {
      // Fall through to the snapshot.
    }
    return STATIC_GENRES.map(([label, value]) => ({ label, value }))
  }

  getFilterList(data?: unknown): FilterList {
    const genres = (data as AsuraFilterData | undefined)?.genres ?? []
    // Search reads the instance map rather than this argument, which the app
    // does not thread back into `getSearchMangaList`.
    if (genres.length) this.rememberGenres(genres)

    return [
      sortFilter(),
      selectFilter('Status', STATUS_VALUES),
      selectFilter('Type', TYPE_VALUES),
      {
        type: 'group',
        name: 'Genres',
        state: genres.map((g) => ({
          type: 'checkbox' as const,
          name: g.label,
          state: false,
        })),
      },
      { type: 'text', name: 'Min Chapters', state: '' },
    ]
  }

  private rememberGenres(genres: AsuraFilterData['genres']): void {
    for (const genre of genres) this.genreValues.set(genre.label, genre.value)
  }

  // --------------------------------------------------------------- images --

  /**
   * A cover or page image, pointed at wherever we are actually fetching.
   *
   * The API returns these as absolute urls on `cdn.asurascans.com`, so it is
   * not enough to prefix relative paths as the other proxied sources do: an
   * absolute one has to be re-pointed too, or the bytes come back opaque and
   * export and sizing are lost again. Under Node `cdnBase` *is* the CDN, so
   * this is the identity function there.
   *
   * An arrow property rather than a method: it is handed to `toSManga` as a
   * callback, and a plain method would arrive unbound.
   */
  private readonly image = (url: string): string => {
    if (url.startsWith(CDN_URL)) {
      return `${this.cdnBase}${url.slice(CDN_URL.length)}`
    }
    if (/^https?:\/\//i.test(url)) return url
    return `${this.cdnBase}${url.startsWith('/') ? url : `/${url}`}`
  }

  // ----------------------------------------------------------------- urls --

  /**
   * `public_url` is site-relative and carries a suffix that cannot be derived
   * from the slug (`/comics/shadow-slave-b60d532c`), so it is resolved against
   * the site rather than used as-is — a bare path here becomes a link to *this*
   * app. Without a memo the fallback still works: the site redirects the
   * unsuffixed slug to the real page, at the cost of one redirect.
   */
  getMangaWebUrl(manga: SManga): string {
    const publicUrl = manga.memo?.publicUrl
    if (typeof publicUrl === 'string' && publicUrl) {
      return new URL(publicUrl, BASE_URL).toString()
    }
    return `${BASE_URL}/comics/${slugOf(manga)}`
  }

  getChapterWebUrl(manga: SManga, chapter: SChapter): string {
    const number = chapter.url.split('/').pop()!
    return `${this.getMangaWebUrl(manga)}/chapter/${number}`
  }
}

// ------------------------------------------------------------- conversion --

function slugOf(manga: SManga): string {
  const memoSlug = manga.memo?.slug
  if (typeof memoSlug === 'string' && memoSlug) return memoSlug
  return manga.url.replace(/^\/series\//, '').replace(/\/$/, '')
}

function toSManga(dto: SeriesDto, image: (url: string) => string): SManga {
  const cover = dto.cover ?? dto.cover_url
  return {
    url: `/series/${dto.slug}`,
    title: dto.title,
    author: dto.author,
    artist: dto.artist,
    description: stripHtml(dto.description),
    genre: (dto.genres ?? []).map((g) => g.name ?? g.slug).filter(Boolean),
    status: toStatus(dto.status),
    thumbnailUrl: cover ? image(cover) : undefined,
    initialized: Boolean(dto.description ?? dto.author),
    memo: { slug: dto.slug, publicUrl: dto.public_url },
  }
}

/**
 * A chapter is unreadable while it is premium, and also while it sits inside
 * an early-access window that has not elapsed yet — the second case carries no
 * `is_premium` flag of its own.
 */
function isLocked(dto: ChapterDto): boolean {
  if (dto.is_premium) return true
  if (!dto.early_access_until) return false
  const until = Date.parse(dto.early_access_until)
  return Number.isFinite(until) && until > Date.now()
}

function toSChapter(dto: ChapterDto, mangaSlug: string): SChapter {
  const published = dto.published_at ?? dto.created_at
  const title = dto.title?.trim()
  return {
    url: `/series/${mangaSlug}/chapter/${dto.number}`,
    name: title ? `Chapter ${dto.number} - ${title}` : `Chapter ${dto.number}`,
    chapterNumber: dto.number,
    dateUpload: published ? Date.parse(published) : undefined,
    memo: { mangaSlug, isPremium: dto.is_premium ?? false },
  }
}

function toStatus(raw?: string): MangaStatus {
  switch (raw?.toLowerCase()) {
    case 'ongoing':
      return 'ongoing'
    case 'completed':
      return 'completed'
    case 'hiatus':
      return 'on_hiatus'
    case 'dropped':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

/** Descriptions arrive as HTML fragments. */
function stripHtml(html?: string): string | undefined {
  if (!html) return undefined
  return new DOMParser().parseFromString(html, 'text/html').body.textContent
    ?.trim()
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

/**
 * Whether another page exists.
 *
 * `has_more` is the direct answer but is omitted rather than sent as `false`,
 * so its absence carries no information. The obvious fallback — a full page
 * means there is more — is wrong for exactly the case that matters: a list
 * whose length is a multiple of the page size ends *on* a full page, and the
 * reader is then offered one more that comes back empty. `total` is always
 * present and settles it.
 */
function hasMore(meta: Meta | undefined, offset: number, count: number): boolean {
  if (meta?.has_more !== undefined) return meta.has_more
  if (typeof meta?.total === 'number') return offset + count < meta.total
  return count >= PER_PAGE
}

function applyFilters(
  url: URL,
  filters: FilterList,
  genreValues: Map<string, string>,
): void {
  for (const filter of filters) {
    switch (filter.type) {
      case 'sort': {
        url.searchParams.set('sort', SORT_VALUES[filter.state.index][1])
        url.searchParams.set('order', filter.state.ascending ? 'asc' : 'desc')
        break
      }
      case 'select': {
        const table =
          filter.name === 'Status'
            ? STATUS_VALUES
            : filter.name === 'Type'
              ? TYPE_VALUES
              : null
        if (!table) break
        const value = table[filter.state]?.[1]
        if (value) url.searchParams.set(filter.name.toLowerCase(), value)
        break
      }
      case 'group': {
        if (filter.name !== 'Genres') break
        // The API filters by slug, and a slug is not reliably derivable from
        // its label, so a genre the map has never seen is dropped rather than
        // guessed at — a wrong slug comes back as a silently unfiltered page.
        const checked = filter.state
          .filter((f) => f.type === 'checkbox' && f.state)
          .map((f) => genreValues.get((f as { name: string }).name))
          .filter((value): value is string => Boolean(value))
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

/** Snapshot of `/api/genres`, used only when that call fails. */
const STATIC_GENRES: [string, string][] = [
  ['Action', 'action'],
  ['Adventure', 'adventure'],
  ['Comedy', 'comedy'],
  ['Crazy MC', 'crazy-mc'],
  ['Dark Fantasy', 'dark-fantasy'],
  ['Demon', 'demon'],
  ['Drama', 'drama'],
  ['Dungeons', 'dungeons'],
  ['Fantasy', 'fantasy'],
  ['Game', 'game'],
  ['Genius MC', 'genius-mc'],
  ['Isekai', 'isekai'],
  ['Kuchikuchi', 'kuchikuchi'],
  ['Magic', 'magic'],
  ['Martial Arts', 'martial-arts'],
  ['Murim', 'murim'],
  ['Mystery', 'mystery'],
  ['Necromancer', 'necromancer'],
  ['Overpowered', 'overpowered'],
  ['Psychological', 'psychological'],
  ['Regression', 'regression'],
  ['Reincarnation', 'reincarnation'],
  ['Revenge', 'revenge'],
  ['Romance', 'romance'],
  ['School Life', 'school-life'],
  ['Sci-fi', 'sci-fi'],
  ['Shoujo', 'shoujo'],
  ['Shounen', 'shounen'],
  ['System', 'system'],
  ['Tower', 'tower'],
  ['Tragedy', 'tragedy'],
  ['Villain', 'villain'],
  ['Violence', 'violence'],
]
