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
  ChapterDto,
  ChapterResponse,
  GraphqlResponse,
  MangaDto,
  MangaResponse,
  PageManifest,
  SearchResponse,
  SearchRowDto,
} from './dto'

/**
 * Where the site lives, and what "open in browser" must point at.
 *
 * Not `mangakakalot.gg`, and not `natomanga.com`. Both serve their homepage
 * and answer every deeper path with a Cloudflare interstitial — measured from
 * curl, from Node and from workerd, which is the runtime this app's own proxy
 * runs on, so there is no hop that gets past it. `mangakakalot.fun` carries
 * the same brand over MangaHub's catalogue and answers all three.
 */
const SITE_URL = 'https://mangakakalot.fun'

/** The API, for the Node path only. In a browser this is a same-origin route. */
const API_URL = 'https://api.mghcdn.com/graphql'

/** Which MangaHub property the API should answer as. From the site's bundle. */
const SOURCE_KEY = 'mn01'

const COVER_URL = 'https://thumb.mghcdn.com'
const PAGE_IMAGE_URL = 'https://imgx.mghcdn.com'

const ICON_URL =
  'https://cdn.jsdelivr.net/gh/keiyoushi/extensions-source@main/src/en/mangakakalot/res/mipmap-xhdpi/ic_launcher.png'

/**
 * Where requests actually go.
 *
 * The API refuses any `Origin` but the site's own and requires an access key
 * the site only hands out as a cookie, so the browser cannot call it at all —
 * neither gate is one a page can satisfy. `/mangakakalot/graphql` adds both
 * server-side; see src/server/mangahub.ts.
 *
 * Outside a browser the upstream is addressed directly, which means the Node
 * path carries no access key and this source runs in a browser only.
 */
function resolveApiBase(): string {
  if (typeof location === 'undefined') return API_URL
  return new URL('/mangakakalot/graphql', location.origin).toString()
}

/** The site publishes no limit. Two a second, matching the other scrapers. */
const RATE_LIMIT_PERMITS = 2
const RATE_LIMIT_PERIOD_MS = 1000

/** The gap between page-image fetch starts. See the other comic sources. */
const PAGE_FETCH_INTERVAL_MS = 150

/** What the search endpoint returns per call, and what it pages by. */
const PER_PAGE = 30

const SORT_VALUES = [
  ['Popular', 'POPULAR'],
  ['Latest', 'LATEST'],
  ['A-Z', 'ALPHABET'],
  ['Completed', 'COMPLETED'],
] as const

/**
 * The site's genres, label and slug. Fixed rather than fetched: they are a
 * closed list the site renders into its own directory page, and fetching them
 * would cost a request before the filter sheet could draw.
 */
const GENRE_VALUES = [
  ['All', 'all'],
  ['Action', 'action'],
  ['Adaptation', 'adaptation'],
  ['Adventure', 'adventure'],
  ['Aliens', 'aliens'],
  ['Animals', 'animals'],
  ['Award winning', 'award-winning'],
  ['Comedy', 'comedy'],
  ['Crime', 'crime'],
  ['Crossdressing', 'crossdressing'],
  ['Delinquents', 'delinquents'],
  ['Demons', 'demons'],
  ['Drama', 'drama'],
  ['Fantasy', 'fantasy'],
  ['Full color', 'full-color'],
  ['Ghosts', 'ghosts'],
  ['Girls love', 'girls-love'],
  ['Gore', 'gore'],
  ['Harem', 'harem'],
  ['Historical', 'historical'],
  ['Horror', 'horror'],
  ['Isekai', 'isekai'],
  ['Long strip', 'long-strip'],
  ['Magic', 'magic'],
  ['Manhua', 'manhua'],
  ['Manhwa', 'manhwa'],
  ['Martial arts', 'martial-arts'],
  ['Mature', 'mature'],
  ['Military', 'military'],
  ['Monster girls', 'monster-girls'],
  ['Monsters', 'monsters'],
  ['Mystery', 'mystery'],
  ['Post apocalyptic', 'post-apocalyptic'],
  ['Psychological', 'psychological'],
  ['Reincarnation', 'reincarnation'],
  ['Romance', 'romance'],
  ['Safe', 'safe'],
  ['School life', 'school-life'],
  ['Sci-Fi', 'sci-fi'],
  ['Seinen', 'seinen'],
  ['Sexual violence', 'sexual-violence'],
  ['Shounen', 'shounen'],
  ['Slice of life', 'slice-of-life'],
  ['Sports', 'sports'],
  ['Suggestive', 'suggestive'],
  ['Superhero', 'superhero'],
  ['Supernatural', 'supernatural'],
  ['Survival', 'survival'],
  ['Thriller', 'thriller'],
  ['Time travel', 'time-travel'],
  ['Tragedy', 'tragedy'],
  ['Web comic', 'web-comic'],
  ['Webtoons', 'webtoons'],
  ['Wuxia', 'wuxia'],
] as const

/**
 * Mangakakalot.
 *
 * A JSON source, not a scraper, and deliberately so: the site's own chapter
 * HTML carries only the first handful of images — six of the twenty-four a
 * chapter of Naruto actually has — while the API returns the full list. A
 * scraper would silently drop most of every chapter.
 *
 * Page images are the good case: `imgx.mghcdn.com` reflects the request
 * origin, so they are fetched directly and their bytes are readable, which is
 * what makes offline saves cost their real size rather than the padding an
 * opaque response is charged.
 */
export class Mangakakalot implements Source {
  readonly id = 'mangakakalot'
  readonly name = 'Mangakakalot'
  readonly lang = 'en'
  readonly baseUrl = SITE_URL
  readonly iconUrl = ICON_URL
  readonly contentRating = 'mixed'
  readonly versionCode = 1
  readonly supportsLatest = true
  readonly isLocal = false
  readonly supportsFilterFetching = false
  readonly supportsRelatedMangas = false
  readonly pageFetchIntervalMs = PAGE_FETCH_INTERVAL_MS

  private readonly http: HttpTransport
  private readonly apiBase: string

  constructor(transport?: HttpTransport, apiBase = resolveApiBase()) {
    this.apiBase = apiBase
    // Every call this source makes is the one API endpoint, so the limiter
    // needs no exclusion: covers and pages are fetched by the app, not here.
    this.http =
      transport ??
      new DirectFetchTransport(
        new RateLimiter(RATE_LIMIT_PERMITS, RATE_LIMIT_PERIOD_MS),
      )
  }

  // ------------------------------------------------------------- browsing --

  getPopularManga(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.browse(page, '', 'POPULAR', 'all', signal)
  }

  getLatestUpdates(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.browse(page, '', 'LATEST', 'all', signal)
  }

  getSearchMangaList(
    page: number,
    query: string,
    filters: FilterList,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    return this.browse(
      page,
      query.trim(),
      readSort(filters),
      readGenre(filters),
      signal,
    )
  }

  private async browse(
    page: number,
    term: string,
    sort: string,
    genre: string,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const offset = (page - 1) * PER_PAGE
    const body = await this.query<SearchResponse>(
      `{search(x:${SOURCE_KEY},q:"${escape(term)}",genre:"${escape(genre)}",` +
        `mod:${sort},count:true,offset:${offset},limit:${PER_PAGE})` +
        `{rows{title,slug,image,author,genres,status},count}}`,
      signal,
    )

    const rows = body.search?.rows ?? []
    const count = body.search?.count

    return {
      mangas: rows.map((row) => this.toSManga(row)),
      // `count` is the whole match count rather than this page's, so it says
      // outright whether anything follows. Without it, a list whose length is
      // a multiple of the page size would look like it ended on a full page.
      hasNextPage:
        typeof count === 'number'
          ? offset + rows.length < count
          : rows.length >= PER_PAGE,
    }
  }

  private toSManga(row: SearchRowDto): SManga {
    return {
      url: `/series/${row.slug}`,
      title: row.title,
      author: row.author?.trim() || undefined,
      genre: splitGenres(row.genres),
      status: toStatus(row.status),
      thumbnailUrl: coverUrl(row.image),
      initialized: false,
    }
  }

  // -------------------------------------------------------------- details --

  async getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
    signal?: AbortSignal,
  ): Promise<MangaUpdate> {
    const slug = seriesSlug(manga.url)
    if (!slug) throw new Error('This series has no Mangakakalot slug.')

    // Details and the whole chapter list are one record, so one request
    // answers both however few of them were asked for.
    const fields = [
      ...(opts.fetchDetails
        ? [
            'title,slug,status,image,author,artist,genres,description',
            'alternativeTitle',
          ]
        : []),
      ...(opts.fetchChapters ? ['chapters{number,title,date}'] : []),
    ].join(',')

    const body = await this.query<MangaResponse>(
      `{manga(x:${SOURCE_KEY},slug:"${escape(slug)}"){${fields}}}`,
      signal,
    )
    const data = body.manga
    if (!data) throw new Error('Mangakakalot served no details for this series.')

    return {
      manga: opts.fetchDetails ? readDetails(data, manga) : manga,
      chapters: opts.fetchChapters ? readChapters(data.chapters, manga.url) : [],
    }
  }

  // ---------------------------------------------------------------- pages --

  async getPageList(
    _manga: SManga,
    chapter: SChapter,
    signal?: AbortSignal,
  ): Promise<Page[]> {
    const parts = chapterParts(chapter.url)
    if (!parts) throw new Error('This chapter has no Mangakakalot path.')

    const body = await this.query<ChapterResponse>(
      `{chapter(x:${SOURCE_KEY},slug:"${escape(parts.slug)}",` +
        `number:${parts.number}){pages,s}}`,
      signal,
    )

    const files = readManifest(body.chapter?.pages)
    if (files.length === 0) {
      throw new Error('This chapter has no pages on Mangakakalot.')
    }

    const token = body.chapter?.s?.trim()
    const suffix = token ? `?x=${encodeURIComponent(token)}` : ''

    // Whole images, nothing tiled, so `Page.descramble` stays unset.
    return files.map((file, index) => ({
      index,
      imageUrl: `${PAGE_IMAGE_URL}/${file}${suffix}`,
    }))
  }

  // -------------------------------------------------------------- filters --

  getFilterList(): FilterList {
    return [sortFilter(), selectFilter('Genre', GENRE_VALUES)]
  }

  // ----------------------------------------------------------------- urls --

  getMangaWebUrl(manga: SManga): string {
    return `${SITE_URL}/manga/${seriesSlug(manga.url) ?? ''}`
  }

  getChapterWebUrl(_manga: SManga, chapter: SChapter): string {
    const parts = chapterParts(chapter.url)
    if (!parts) return SITE_URL
    return `${SITE_URL}/chapter/${parts.slug}/chapter-${parts.number}`
  }

  // ------------------------------------------------------------ transport --

  private async query<T>(query: string, signal?: AbortSignal): Promise<T> {
    const res = await this.http.fetch({
      url: this.apiBase,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal,
    })

    const body = await res.json<GraphqlResponse<T>>()
    // A GraphQL error arrives with HTTP 200, so the transport's status check
    // never sees it. Reporting the first message keeps a schema change
    // readable instead of surfacing as "no results".
    const failure = body.errors?.[0]?.message
    if (failure) throw new Error(`Mangakakalot rejected the request: ${failure}`)
    if (!body.data) throw new Error('Mangakakalot returned no data.')

    return body.data
  }
}

// ------------------------------------------------------------- conversion --

/**
 * The app addresses every source through `/series/<slug>` and
 * `/series/<slug>/chapter/<key>`, and rebuilds both from route parameters
 * alone — see `MangaDetailView` in the series route and `chapterStubOf` in
 * the reader. Both segments therefore have to carry everything needed to
 * re-address the work, and neither may contain a slash.
 */
function seriesSlug(url: string): string | null {
  return /^\/series\/([^/?#]+)/.exec(url)?.[1] ?? null
}

/**
 * A chapter url read back into what the API addresses a chapter by.
 *
 * The key is the chapter *number*, not the site's chapter slug. The API keys
 * chapters by number, returns an empty slug for a good share of them, and
 * takes decimals — `700.5` is an ordinary chapter, not an edge case.
 */
function chapterParts(url: string): { slug: string; number: string } | null {
  const match = /^\/series\/([^/?#]+)\/chapter\/([\d.]+)$/.exec(url)
  return match ? { slug: match[1]!, number: match[2]! } : null
}

function readDetails(data: MangaDto, manga: SManga): SManga {
  return {
    ...manga,
    title: data.title?.trim() || manga.title,
    author: data.author?.trim() || undefined,
    artist: data.artist?.trim() || undefined,
    description: buildDescription(data),
    genre: splitGenres(data.genres) ?? manga.genre,
    status: toStatus(data.status),
    thumbnailUrl: coverUrl(data.image) ?? manga.thumbnailUrl,
    initialized: true,
  }
}

/**
 * The synopsis, with the series' other titles above it.
 *
 * They arrive as one `alternativeTitle` string and there is no field on
 * `SManga` for them, so they go where a reader looking for a romanised title
 * will actually find them.
 */
function buildDescription(data: MangaDto): string | undefined {
  const description = data.description?.trim()
  const alternatives = data.alternativeTitle?.trim()

  if (!alternatives) return description || undefined
  const header = `Also known as: ${alternatives}`
  return description ? `${header}\n\n${description}` : header
}

/**
 * Every chapter, newest first, one per number.
 *
 * The list arrives oldest-first and occasionally holds two entries for one
 * number — an alternate upload of the same chapter. Our identity is the
 * number, so the duplicates would collide; the first one seen wins, which is
 * also the one the API's own `chapter(number:)` lookup resolves to.
 */
function readChapters(
  chapters: ChapterDto[] | null | undefined,
  mangaUrl: string,
): SChapter[] {
  const seen = new Set<number>()
  const out: SChapter[] = []

  for (const chapter of chapters ?? []) {
    if (typeof chapter.number !== 'number' || seen.has(chapter.number)) continue
    seen.add(chapter.number)

    out.push({
      url: `${mangaUrl}/chapter/${chapter.number}`,
      name: chapterName(chapter),
      chapterNumber: chapter.number,
      dateUpload: parseDate(chapter.date),
    })
  }

  return out.reverse()
}

function chapterName(chapter: ChapterDto): string {
  const base = `Chapter ${chapter.number}`
  const title = chapter.title?.trim()
  // The site titles most chapters after their own number, and repeating that
  // back as "Chapter 909: Chapter 909" says nothing twice.
  if (!title || title === base) return base
  return `${base}: ${title}`
}

/** ISO 8601, the only shape the API sends. */
function parseDate(raw?: string | null): number | undefined {
  if (!raw) return undefined
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** A cover path (`mn/naruto.jpg`) as a url. Absolute paths are left alone. */
function coverUrl(image?: string | null): string | undefined {
  const path = image?.trim()
  if (!path) return undefined
  if (/^https?:\/\//.test(path)) return path
  return `${COVER_URL}/${path.replace(/^\//, '')}`
}

/** Genres arrive as one comma-separated string rather than as a list. */
function splitGenres(genres?: string | null): string[] | undefined {
  const labels = (genres ?? '')
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)
  return labels.length > 0 ? labels : undefined
}

function toStatus(raw?: string | null): MangaStatus {
  switch (raw?.trim().toLowerCase()) {
    case 'ongoing':
      return 'ongoing'
    case 'completed':
      return 'completed'
    case 'on_hold':
    case 'on hold':
      return 'on_hiatus'
    case 'cancelled':
    case 'dropped':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

/**
 * The page files a chapter's `pages` string names, in order.
 *
 * Current chapters carry a prefix and a list of file names under it; older
 * ones carry an object keyed by page number. The keys of that object are the
 * page order, so they are sorted numerically rather than trusted as they
 * arrived.
 */
function readManifest(raw?: string | null): string[] {
  if (!raw) return []

  let manifest: PageManifest
  try {
    manifest = JSON.parse(raw) as PageManifest
  } catch {
    return []
  }

  if ('i' in manifest && Array.isArray(manifest.i)) {
    const prefix = typeof manifest.p === 'string' ? manifest.p : ''
    return manifest.i.map((file) => `${prefix}${file}`)
  }

  return Object.entries(manifest as Record<string, string | undefined>)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, file]) => file)
    .filter((file): file is string => typeof file === 'string')
}

/**
 * A value going into a GraphQL string literal.
 *
 * The queries are built as text — the API takes no variables — so a title with
 * a quote in it would otherwise end the literal and fail the whole query.
 */
function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// ---------------------------------------------------------------- filters --

function sortFilter(): Filter {
  return {
    type: 'sort',
    name: 'Sort By',
    values: SORT_VALUES.map(([label]) => label),
    state: { index: 0, ascending: false },
  }
}

function selectFilter(
  name: string,
  values: readonly (readonly [string, string])[],
): Filter {
  return { type: 'select', name, values: values.map(([label]) => label), state: 0 }
}

function readSort(filters: FilterList): string {
  for (const filter of filters) {
    if (filter.type === 'sort') {
      return SORT_VALUES[filter.state.index]?.[1] ?? 'POPULAR'
    }
  }
  return 'POPULAR'
}

function readGenre(filters: FilterList): string {
  for (const filter of filters) {
    if (filter.type === 'select' && filter.name === 'Genre') {
      return GENRE_VALUES[filter.state]?.[1] ?? 'all'
    }
  }
  return 'all'
}
