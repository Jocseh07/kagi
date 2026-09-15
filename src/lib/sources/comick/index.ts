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
  BrowseComicDto,
  BrowseResponse,
  ChapterDto,
  ChapterListResponse,
  ChapterPageData,
  ComicDataDto,
  MetadataResponse,
  PhpArray,
} from './dto'

/**
 * Where the site lives, and what "open in browser" must point at.
 *
 * Not `comick.io`. That site closed in September 2025 and the domains that
 * took its name are, by Keiyoushi's own notice, impostors. `comick.live` is
 * the host the replacement extension ships with and the one checked here.
 */
const SITE_URL = 'https://comick.live'

/**
 * Image hosts. Two families are in use at once — older covers on
 * `meo*.comick.pictures`, current pages on `cdn*.comicknew.pictures` — and
 * both refuse a request that carries no `Referer`.
 */
const IMAGE_HOST = /^[a-z0-9]+\.comick(new)?\.pictures$/

const ICON_URL =
  'https://cdn.jsdelivr.net/gh/keiyoushi/extensions-source@main/src/all/comicklive/res/mipmap-xhdpi/ic_launcher.png'

/**
 * Where requests actually go.
 *
 * The site sends no CORS headers, and its image hosts additionally answer 403
 * to any request without a `Referer` naming the site. The browser cannot set
 * one — the reader and the service worker both send `no-referrer` — so the
 * proxy attaches it: the site under `/comick`, images under
 * `/comickcdn/<host>`.
 *
 * Outside a browser there is no proxy, and the `Referer` is the caller's
 * problem rather than this module's.
 */
function resolveApiBase(): string {
  if (typeof location === 'undefined') return SITE_URL
  return new URL('/comick', location.origin).toString()
}

function resolveImageBase(): string | null {
  if (typeof location === 'undefined') return null
  return new URL('/comickcdn', location.origin).toString()
}

/** The extension's budget: one request per two seconds. */
const RATE_LIMIT_PERMITS = 1
const RATE_LIMIT_PERIOD_MS = 2000

/** The gap between page-image fetch starts. See the other comic sources. */
const PAGE_FETCH_INTERVAL_MS = 150

/**
 * The top list is a ranking rather than a feed: it takes a window and a kind,
 * not a page number. Six combinations exist, so "page" walks them in the same
 * order the extension does and then stops.
 */
const TOP_PAGES = [
  { days: 7, type: 'follow' },
  { days: 30, type: 'follow' },
  { days: 90, type: 'follow' },
  { days: 7, type: 'most_follow_new' },
  { days: 30, type: 'most_follow_new' },
  { days: 90, type: 'most_follow_new' },
] as const

const SORT_VALUES = [
  ['Most followed', 'follow'],
  ['Recently uploaded', 'uploaded'],
  ['Rating', 'rating'],
  ['Title', 'title'],
  ['Created', 'created_at'],
] as const

const STATUS_VALUES = [
  ['All', ''],
  ['Ongoing', '1'],
  ['Completed', '2'],
  ['Cancelled', '3'],
  ['Hiatus', '4'],
] as const

const COUNTRY_VALUES = [
  ['All', ''],
  ['Manga (Japan)', 'jp'],
  ['Manhwa (Korea)', 'kr'],
  ['Manhua (China)', 'cn'],
] as const

export interface ComickFilterData {
  genres: { label: string; value: string }[]
  demographics: { label: string; value: string }[]
}

/**
 * Comick.
 *
 * Mostly a JSON API, with two records that are only available embedded in a
 * page: a series' full details (`#comic-data`) and a chapter's image list
 * (`#sv-data`). Those two are read out of the HTML, which is why this source
 * only runs in a browser.
 *
 * **Search is behind a bot check.** `/api/search` answers a scripted client
 * with a Cloudflare challenge rather than results. The proxy marks that
 * response as such and the transport raises `ChallengeRequiredError`, so the
 * UI can tell the reader to clear it in a tab instead of showing a dead
 * spinner. Popular, latest, details, chapters and pages are all unaffected.
 */
export class Comick implements Source {
  readonly id = 'comick'
  readonly name = 'Comick'
  readonly lang = 'en'
  readonly baseUrl = SITE_URL
  readonly iconUrl = ICON_URL
  readonly contentRating = 'mixed'
  readonly versionCode = 1
  readonly supportsLatest = true
  readonly isLocal = false
  readonly supportsFilterFetching = true
  readonly supportsRelatedMangas = false
  readonly pageFetchIntervalMs = PAGE_FETCH_INTERVAL_MS

  private readonly http: HttpTransport
  private readonly apiBase: string
  private readonly imageBase: string | null

  /** Genre label to the slug the search endpoint filters by. */
  private genreValues = new Map<string, string>()

  constructor(
    transport?: HttpTransport,
    apiBase = resolveApiBase(),
    imageBase = resolveImageBase(),
  ) {
    this.apiBase = apiBase.replace(/\/$/, '')
    this.imageBase = imageBase?.replace(/\/$/, '') ?? null
    this.http =
      transport ??
      new DirectFetchTransport(
        new RateLimiter(RATE_LIMIT_PERMITS, RATE_LIMIT_PERIOD_MS, (url) =>
          url.pathname.startsWith('/comickcdn') || IMAGE_HOST.test(url.host),
        ),
      )
  }

  // ------------------------------------------------------------- browsing --

  async getPopularManga(
    page: number,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const window = TOP_PAGES[page - 1]
    if (!window) return { mangas: [], hasNextPage: false }

    const url = new URL(`${this.apiBase}/api/comics/top`)
    url.searchParams.set('days', String(window.days))
    url.searchParams.set('type', window.type)

    const body = await this.get<BrowseResponse>(url, signal)
    return {
      mangas: asArray(body.data).map((dto) => this.toSManga(dto)),
      hasNextPage: page < TOP_PAGES.length,
    }
  }

  async getLatestUpdates(
    page: number,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const url = new URL(`${this.apiBase}/api/chapters/latest`)
    url.searchParams.set('order', 'new')
    url.searchParams.set('page', String(page))

    const body = await this.get<BrowseResponse>(url, signal)
    const data = asArray(body.data)
    const perPage = body.per_page ?? data.length

    return {
      mangas: data.map((dto) => this.toSManga(dto)),
      hasNextPage: data.length > 0 && data.length >= perPage,
    }
  }

  async getSearchMangaList(
    page: number,
    query: string,
    filters: FilterList,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const term = query.trim()
    // With neither a term nor a filter there is nothing to search for, and the
    // ranking is a better answer than an arbitrary slice of the catalogue.
    if (!term && !hasActiveFilter(filters)) {
      return await this.getPopularManga(page, signal)
    }

    const url = new URL(`${this.apiBase}/api/search`)
    url.searchParams.set('page', String(page))
    if (term) url.searchParams.set('q', term)
    applyFilters(url, filters, this.genreValues)

    const body = await this.get<BrowseResponse>(url, signal)
    const data = asArray(body.data)
    const perPage = body.per_page ?? data.length

    return {
      mangas: data.map((dto) => this.toSManga(dto)),
      hasNextPage: data.length > 0 && data.length >= perPage,
    }
  }

  // -------------------------------------------------------------- details --

  async getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
    signal?: AbortSignal,
  ): Promise<MangaUpdate> {
    const slug = seriesSlug(manga.url)
    if (!slug) throw new Error('This series has no Comick slug.')

    const [details, chapters] = await Promise.all([
      opts.fetchDetails
        ? this.fetchDetails(slug, signal)
        : Promise.resolve(manga),
      opts.fetchChapters
        ? this.fetchChapters(slug, signal)
        : Promise.resolve([]),
    ])
    return { manga: details, chapters }
  }

  private async fetchDetails(
    slug: string,
    signal?: AbortSignal,
  ): Promise<SManga> {
    const doc = await this.fetchDocument(
      `${this.apiBase}/comic/${slug}`,
      signal,
    )
    const data = readEmbedded<ComicDataDto>(doc, 'comic-data')
    if (!data) throw new Error('Comick served no details for this series.')

    const genre = [
      ...(countryLabel(data.country) ? [countryLabel(data.country)!] : []),
      ...(data.demographic_name?.trim() ? [data.demographic_name.trim()] : []),
      ...asArray(data.md_comic_md_genres).map((entry) => entry.md_genres.name),
    ]

    return {
      url: `/series/${data.slug || slug}`,
      title: data.title,
      author: asArray(data.authors).map((a) => a.name).join(', ') || undefined,
      artist: asArray(data.artists).map((a) => a.name).join(', ') || undefined,
      description: buildDescription(data),
      genre: genre.length > 0 ? genre : undefined,
      status: toStatus(data.status, data.translation_completed),
      thumbnailUrl: data.default_thumbnail
        ? this.image(data.default_thumbnail)
        : undefined,
      initialized: true,
    }
  }

  /**
   * Every chapter in this language.
   *
   * The endpoint pages at 60 and reports how many pages there are, so the
   * whole list is walked rather than guessed at. Chapters in other languages
   * are excluded upstream by `lang`.
   */
  private async fetchChapters(
    slug: string,
    signal?: AbortSignal,
  ): Promise<SChapter[]> {
    const chapters: SChapter[] = []
    let page = 1
    let lastPage = 1

    do {
      const url = new URL(`${this.apiBase}/api/comics/${slug}/chapter-list`)
      url.searchParams.set('lang', this.lang)
      url.searchParams.set('page', String(page))

      const body = await this.get<ChapterListResponse>(url, signal)
      for (const dto of asArray(body.data)) chapters.push(toSChapter(dto, slug))

      lastPage = body.pagination?.last_page ?? page
      page += 1
    } while (page <= lastPage)

    return chapters
  }

  // ---------------------------------------------------------------- pages --

  async getPageList(
    _manga: SManga,
    chapter: SChapter,
    signal?: AbortSignal,
  ): Promise<Page[]> {
    const path = chapterSitePath(chapter.url)
    if (!path) throw new Error('This chapter has no Comick path.')

    const doc = await this.fetchDocument(`${this.apiBase}${path}`, signal)
    const data = readEmbedded<ChapterPageData>(doc, 'sv-data')
    const images = asArray(data?.chapter?.images)

    if (images.length === 0) {
      throw new Error('This chapter has no pages on Comick.')
    }

    // Whole images, nothing tiled, so `Page.descramble` stays unset.
    return images.map((image, index) => ({
      index,
      imageUrl: this.image(image.url),
    }))
  }

  // -------------------------------------------------------------- filters --

  async fetchFilterData(): Promise<ComickFilterData> {
    const body = await this.get<MetadataResponse>(
      new URL(`${this.apiBase}/api/metadata`),
    )

    const genres = asArray(body.genres)
      .filter((genre) => genre.name && genre.slug)
      .map((genre) => ({ label: genre.name, value: genre.slug }))
    const demographics = asArray(body.demographics)
      .filter((entry) => entry.name)
      .map((entry) => ({ label: entry.name, value: String(entry.id) }))

    this.rememberGenres(genres)
    return { genres, demographics }
  }

  getFilterList(data?: unknown): FilterList {
    const filterData = data as ComickFilterData | undefined
    const genres = filterData?.genres ?? []
    const demographics = filterData?.demographics ?? []

    // Search reads the instance map rather than this argument, which the app
    // does not thread back into `getSearchMangaList`.
    if (genres.length > 0) this.rememberGenres(genres)

    return [
      sortFilter(),
      selectFilter('Status', STATUS_VALUES),
      selectFilter('Type', COUNTRY_VALUES),
      {
        type: 'select',
        name: 'Demographic',
        values: ['All', ...demographics.map((entry) => entry.label)],
        state: 0,
      },
      {
        type: 'group',
        name: 'Genres',
        state: genres.map((genre) => ({
          type: 'checkbox' as const,
          name: genre.label,
          state: false,
        })),
      },
    ]
  }

  private rememberGenres(genres: ComickFilterData['genres']): void {
    for (const genre of genres) this.genreValues.set(genre.label, genre.value)
  }

  // ----------------------------------------------------------------- urls --

  getMangaWebUrl(manga: SManga): string {
    return `${SITE_URL}/comic/${seriesSlug(manga.url) ?? ''}`
  }

  getChapterWebUrl(_manga: SManga, chapter: SChapter): string {
    return `${SITE_URL}${chapterSitePath(chapter.url) ?? ''}`
  }

  // ------------------------------------------------------------ transport --

  private async get<T>(url: URL, signal?: AbortSignal): Promise<T> {
    const res = await this.http.fetch({ url: url.toString(), signal })
    return await res.json<T>()
  }

  private async fetchDocument(
    url: string,
    signal?: AbortSignal,
  ): Promise<Document> {
    const res = await this.http.fetch({ url, signal })
    return new DOMParser().parseFromString(await res.text(), 'text/html')
  }

  // --------------------------------------------------------------- images --

  /**
   * A cover or page image, pointed at wherever we are actually fetching.
   *
   * The hostname travels in the proxy path because two host families are in
   * use and both are numbered, so neither can be a fixed target. A url on any
   * other host is left alone rather than re-pointed at a route that would
   * refuse it.
   */
  private image(url: string): string {
    if (!this.imageBase) return url

    let parsed: URL
    try {
      parsed = new URL(url, SITE_URL)
    } catch {
      return url
    }

    if (IMAGE_HOST.test(parsed.host)) {
      return `${this.imageBase}/${parsed.host}${parsed.pathname}${parsed.search}`
    }
    return url
  }

  private toSManga(dto: BrowseComicDto): SManga {
    return {
      url: `/series/${dto.slug}`,
      title: dto.title,
      status: 'unknown',
      thumbnailUrl: dto.default_thumbnail
        ? this.image(dto.default_thumbnail)
        : undefined,
      initialized: false,
    }
  }
}

// ------------------------------------------------------------- conversion --

/**
 * A Comick collection as an array, whichever of its two shapes arrived.
 *
 * Keys are sorted numerically rather than trusted in insertion order, on the
 * same reasoning as Flame Comics' page list: the object's keys are the array
 * indices it was encoded from, and order is the whole meaning of that index.
 */
function asArray<T>(value: PhpArray<T> | null | undefined): T[] {
  if (Array.isArray(value)) return value
  if (!value) return []
  return Object.entries(value)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, item]) => item)
}

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
 * The site's own path for a chapter, rebuilt from our two segments.
 *
 * The key is the whole trailing segment the site uses — `<hid>-chapter-<n>-<lang>`
 * — rather than the hid alone, because a chapter addressed by hid alone is a
 * 404 there. It has no slash in it, so it survives as one route parameter.
 */
function chapterSitePath(url: string): string | null {
  const match = /^\/series\/([^/?#]+)\/chapter\/([^/?#]+)$/.exec(url)
  return match ? `/comic/${match[1]}/${match[2]}` : null
}

/**
 * One of the JSON blobs the site embeds in a page.
 *
 * `textContent` rather than `innerHTML`: the blob is character data and the
 * browser has already decoded its entities, so reading it as markup would
 * re-escape quotes inside strings and break the parse.
 */
function readEmbedded<T>(doc: Document, id: string): T | null {
  const raw = doc.getElementById(id)?.textContent
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function toSChapter(dto: ChapterDto, slug: string): SChapter {
  const number = Number(dto.chap)
  const parts: string[] = []
  if (dto.vol?.trim()) parts.push(`Vol. ${dto.vol.trim()}`)
  if (dto.chap?.trim()) parts.push(`Ch. ${dto.chap.trim()}`)

  const prefix = parts.join(' ')
  const title = dto.title?.trim()
  const published = dto.publish_at ? Date.parse(dto.publish_at) : NaN

  return {
    url: `/series/${slug}/chapter/${dto.hid}-chapter-${dto.chap ?? ''}-${dto.lang ?? 'en'}`,
    name: prefix && title ? `${prefix} - ${title}` : prefix || title || 'Oneshot',
    chapterNumber: Number.isFinite(number) ? number : -1,
    dateUpload: Number.isFinite(published) ? published : undefined,
    scanlator: asArray(dto.group_name).join(', ') || undefined,
  }
}

/** The synopsis, flattened out of HTML, with alternative titles appended. */
function buildDescription(data: ComicDataDto): string | undefined {
  const parts: string[] = []

  if (data.desc) {
    const text = new DOMParser()
      .parseFromString(data.desc, 'text/html')
      .body.textContent?.replace(/\s+\n/g, '\n')
      .trim()
    if (text) parts.push(text)
  }

  const alternatives = asArray(data.md_titles)
    .map((entry) => entry.title.trim())
    .filter((title) => Boolean(title) && title !== data.title)
  if (alternatives.length > 0) {
    parts.push(
      `Alternative titles:\n${alternatives.map((title) => `- ${title}`).join('\n')}`,
    )
  }

  return parts.length > 0 ? parts.join('\n\n') : undefined
}

/** The country code the site files a comic under, as the word readers use. */
function countryLabel(country?: string | null): string | undefined {
  switch (country) {
    case 'jp':
      return 'Manga'
    case 'kr':
      return 'Manhwa'
    case 'cn':
      return 'Manhua'
    default:
      return undefined
  }
}

/**
 * Comick's numeric status.
 *
 * `2` means the original work finished, which is not the same as the
 * translation having caught up — the site tracks both, and a reader looking at
 * a completed series wants to know which kind of completed it is.
 */
function toStatus(
  status?: number | null,
  translationCompleted?: boolean | null,
): MangaStatus {
  switch (status) {
    case 1:
      return 'ongoing'
    case 2:
      return translationCompleted ? 'completed' : 'publishing_finished'
    case 3:
      return 'cancelled'
    case 4:
      return 'on_hiatus'
    default:
      return 'unknown'
  }
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

/** Whether anything has been moved off its default, sort aside. */
function hasActiveFilter(filters: FilterList): boolean {
  return filters.some((filter) => {
    if (filter.type === 'select') return filter.state > 0
    if (filter.type === 'group') {
      return filter.state.some(
        (child) => child.type === 'checkbox' && child.state,
      )
    }
    return false
  })
}

function applyFilters(
  url: URL,
  filters: FilterList,
  genreValues: Map<string, string>,
): void {
  for (const filter of filters) {
    switch (filter.type) {
      case 'sort': {
        url.searchParams.set('order_by', SORT_VALUES[filter.state.index]![1])
        url.searchParams.set(
          'order_direction',
          filter.state.ascending ? 'asc' : 'desc',
        )
        break
      }
      case 'select': {
        if (filter.name === 'Demographic') {
          // The option list is built from fetched data, so the value is its
          // position: index 0 is "All" and sends nothing.
          if (filter.state > 0) {
            url.searchParams.set('demographic', String(filter.state))
          }
          break
        }
        const table = filter.name === 'Status' ? STATUS_VALUES : COUNTRY_VALUES
        const value = table[filter.state]?.[1]
        if (!value) break
        url.searchParams.set(
          filter.name === 'Status' ? 'status' : 'country',
          value,
        )
        break
      }
      case 'group': {
        if (filter.name !== 'Genres') break
        // The endpoint filters by slug, and a slug is not derivable from its
        // label, so a genre the map has never seen is dropped rather than
        // guessed at — a wrong slug comes back as a silently unfiltered page.
        for (const child of filter.state) {
          if (child.type !== 'checkbox' || !child.state) continue
          const slug = genreValues.get(child.name)
          if (slug) url.searchParams.append('genres', slug)
        }
        break
      }
    }
  }
}
