import { DirectFetchTransport, RateLimiter } from '../../transport/direct-fetch'
import type { HttpTransport } from '../../transport/types'
import type {
  ConfigurableSource,
  Filter,
  FilterList,
  MangaStatus,
  MangaUpdate,
  MangasPage,
  Page,
  SChapter,
  SManga,
  Source,
  SourcePreference,
} from '../types'
import type {
  AtHomeResponse,
  ChapterDto,
  Collection,
  Entity,
  LocalizedString,
  MangaDto,
  Relationship,
} from './dto'

/** Where the site lives, and what "open in browser" must point at. */
const SITE_URL = 'https://mangadex.org'

const API_URL = 'https://api.mangadex.org'

/** Cover art. Page images live on per-chapter hosts instead; see `getPageList`. */
const UPLOADS_URL = 'https://uploads.mangadex.org'

const ICON_URL =
  'https://cdn.jsdelivr.net/gh/keiyoushi/extensions-source@main/src/all/mangadex/res/mipmap-xhdpi/ic_launcher.png'

/**
 * Where requests actually go.
 *
 * MangaDex does not merely omit CORS headers — its published limits require
 * that a third-party client proxy every request and inject its own, and that
 * images are never hotlinked, on pain of being served the wrong bytes. So in a
 * browser the API is reached under `/mangadex`, covers under `/mdcovers`, and
 * page images under `/mdimage/<host>`, all of which also attach the honest
 * User-Agent those same limits require (see src/server/mangadex.ts).
 *
 * Outside a browser there is no proxy to speak to and the hosts are addressed
 * directly.
 */
function resolveApiBase(): string {
  if (typeof location === 'undefined') return API_URL
  return new URL('/mangadex', location.origin).toString()
}

function resolveCoverBase(): string {
  if (typeof location === 'undefined') return UPLOADS_URL
  return new URL('/mdcovers', location.origin).toString()
}

function resolveImageBase(): string | null {
  if (typeof location === 'undefined') return null
  return new URL('/mdimage', location.origin).toString()
}

/** The API's own ceiling for a manga list. */
const PER_PAGE = 20

/** The largest feed page the API will serve, and what the extension asks for. */
const FEED_PER_PAGE = 500

/**
 * A chapter list is fetched a page at a time, and a long series has thousands.
 * Six pages is 3000 chapters, past which the list is truncated rather than
 * spending a minute of someone's rate budget on one refresh.
 */
const MAX_FEED_PAGES = 6

/** The extension's budget: three requests per second. */
const RATE_LIMIT_PERMITS = 3
const RATE_LIMIT_PERIOD_MS = 1000

/**
 * MangaDex@Home is a volunteer network and asks that a client not flood a
 * node. 250 ms between fetch starts is slower than the CDN-backed sources
 * here on purpose.
 */
const PAGE_FETCH_INTERVAL_MS = 250

const SORT_VALUES = [
  ['Popular', 'followedCount'],
  ['Latest upload', 'latestUploadedChapter'],
  ['Relevance', 'relevance'],
  ['Title', 'title'],
  ['Year', 'year'],
  ['Created', 'createdAt'],
] as const

const STATUS_VALUES = [
  ['All', ''],
  ['Ongoing', 'ongoing'],
  ['Completed', 'completed'],
  ['Hiatus', 'hiatus'],
  ['Cancelled', 'cancelled'],
] as const

const DEMOGRAPHIC_VALUES = [
  ['All', ''],
  ['Shounen', 'shounen'],
  ['Shoujo', 'shoujo'],
  ['Seinen', 'seinen'],
  ['Josei', 'josei'],
] as const

/**
 * Which ratings the API is asked for, as one choice rather than four switches.
 *
 * The API takes a repeated parameter and returns nothing at all when none is
 * sent for a rating, so the levels are cumulative: picking one includes
 * everything tamer than it.
 */
const CONTENT_RATINGS = [
  { label: 'Safe only', value: 'safe', ratings: ['safe'] },
  {
    label: 'Safe and suggestive',
    value: 'suggestive',
    ratings: ['safe', 'suggestive'],
  },
  {
    label: 'Include erotica',
    value: 'erotica',
    ratings: ['safe', 'suggestive', 'erotica'],
  },
  {
    label: 'Include pornographic',
    value: 'pornographic',
    ratings: ['safe', 'suggestive', 'erotica', 'pornographic'],
  },
] as const

const PREF_CONTENT_RATING = 'contentRating'
const PREF_DATA_SAVER = 'dataSaver'

/**
 * MangaDex.
 *
 * A real JSON API, so nothing here is scraped and the source runs under Node
 * as well as in a browser. Two things shape the implementation:
 *
 *  - **Every host is proxied, by their rules rather than by CORS.** See
 *    `resolveApiBase` above.
 *  - **Page images live on a host chosen per chapter.** `/at-home/server`
 *    hands back a node's address that is good for a while and then is not, so
 *    the host cannot be a constant and travels in the proxy path instead.
 */
export class MangaDex implements Source, ConfigurableSource {
  readonly id = 'mangadex'
  readonly name = 'MangaDex'
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
  private readonly coverBase: string
  private readonly imageBase: string | null

  /**
   * The reader's own rating choice, distinct from `contentRating` above: that
   * is what the source is, this is what it is currently asked for.
   */
  private ratingFilter: string = 'suggestive'
  private dataSaver = false

  constructor(
    transport?: HttpTransport,
    apiBase = resolveApiBase(),
    coverBase = resolveCoverBase(),
    imageBase = resolveImageBase(),
  ) {
    this.apiBase = apiBase.replace(/\/$/, '')
    this.coverBase = coverBase.replace(/\/$/, '')
    this.imageBase = imageBase?.replace(/\/$/, '') ?? null
    this.http =
      transport ??
      new DirectFetchTransport(
        new RateLimiter(RATE_LIMIT_PERMITS, RATE_LIMIT_PERIOD_MS, (url) =>
          // Covers are static files on the upload host, not API calls.
          url.pathname.startsWith('/mdcovers') ||
          url.host === new URL(UPLOADS_URL).host,
        ),
      )
  }

  // --------------------------------------------------------- preferences --

  getPreferences(): SourcePreference[] {
    return [
      {
        key: PREF_CONTENT_RATING,
        title: 'Content rating',
        summary: 'Which ratings appear in browsing and search.',
        type: 'select',
        default: 'suggestive',
        values: CONTENT_RATINGS.map((entry) => ({
          label: entry.label,
          value: entry.value,
        })),
      },
      {
        key: PREF_DATA_SAVER,
        title: 'Data saver',
        summary: 'Load smaller, more compressed page images.',
        type: 'switch',
        default: false,
      },
    ]
  }

  setPreferences(prefs: Record<string, string | boolean>): void {
    const rating = prefs[PREF_CONTENT_RATING]
    if (typeof rating === 'string' && ratingsFor(rating).length > 0) {
      this.ratingFilter = rating
    }
    this.dataSaver = prefs[PREF_DATA_SAVER] === true
  }

  // ------------------------------------------------------------- browsing --

  getPopularManga(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.getSearchMangaList(
      page,
      '',
      [sortFilter('followedCount')],
      signal,
    )
  }

  /**
   * Newest chapters, resolved back to the series they belong to.
   *
   * Ordering manga by upload date is not something the API offers, so the
   * chapter feed is read instead and its series fetched in one follow-up —
   * two calls, which is what the extension spends here too.
   */
  async getLatestUpdates(
    page: number,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const url = new URL(`${this.apiBase}/chapter`)
    url.searchParams.set('limit', String(PER_PAGE * 5))
    url.searchParams.set('offset', String((page - 1) * PER_PAGE * 5))
    url.searchParams.set('translatedLanguage[]', this.lang)
    url.searchParams.set('order[publishAt]', 'desc')
    url.searchParams.set('includeFutureUpdates', '0')
    url.searchParams.set('includeEmptyPages', '0')
    url.searchParams.set('includeExternalUrl', '0')
    this.applyContentRating(url)

    const feed = await this.get<Collection<ChapterDto>>(url, signal)

    // One series publishes several chapters a day, so the same id comes back
    // repeatedly; the order of first appearance is the order to show.
    const ids: string[] = []
    for (const chapter of feed.data) {
      const id = relationOf(chapter.relationships, 'manga')?.id
      if (id && !ids.includes(id)) ids.push(id)
    }
    if (ids.length === 0) return { mangas: [], hasNextPage: false }

    const mangaUrl = new URL(`${this.apiBase}/manga`)
    mangaUrl.searchParams.set('limit', String(ids.length))
    mangaUrl.searchParams.set('includes[]', 'cover_art')
    for (const id of ids) mangaUrl.searchParams.append('ids[]', id)
    this.applyContentRating(mangaUrl)

    const body = await this.get<Collection<MangaDto>>(mangaUrl, signal)
    const byId = new Map(body.data.map((dto) => [dto.id, dto]))

    return {
      mangas: ids
        .map((id) => byId.get(id))
        .filter((dto): dto is MangaDto => dto !== undefined)
        .map((dto) => this.toSManga(dto)),
      hasNextPage: feed.offset + feed.data.length < feed.total,
    }
  }

  async getSearchMangaList(
    page: number,
    query: string,
    filters: FilterList,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const offset = (page - 1) * PER_PAGE
    const url = new URL(`${this.apiBase}/manga`)
    url.searchParams.set('limit', String(PER_PAGE))
    url.searchParams.set('offset', String(offset))
    url.searchParams.set('includes[]', 'cover_art')
    url.searchParams.set('availableTranslatedLanguage[]', this.lang)

    const term = query.trim()
    if (term) url.searchParams.set('title', term)
    applyFilters(url, filters, Boolean(term))
    this.applyContentRating(url)

    const body = await this.get<Collection<MangaDto>>(url, signal)

    return {
      mangas: body.data.map((dto) => this.toSManga(dto)),
      hasNextPage: offset + body.data.length < body.total,
    }
  }

  // -------------------------------------------------------------- details --

  async getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
    signal?: AbortSignal,
  ): Promise<MangaUpdate> {
    const id = mangaId(manga.url)
    if (!id) throw new Error('This series has no MangaDex id.')

    const [details, chapters] = await Promise.all([
      opts.fetchDetails ? this.fetchDetails(id, signal) : Promise.resolve(manga),
      opts.fetchChapters ? this.fetchChapters(id, signal) : Promise.resolve([]),
    ])
    return { manga: details, chapters }
  }

  private async fetchDetails(
    id: string,
    signal?: AbortSignal,
  ): Promise<SManga> {
    const url = new URL(`${this.apiBase}/manga/${id}`)
    for (const include of ['cover_art', 'author', 'artist']) {
      url.searchParams.append('includes[]', include)
    }
    const body = await this.get<Entity<MangaDto>>(url, signal)
    return this.toSManga(body.data)
  }

  /**
   * Every chapter in this language, paged until the feed is exhausted.
   *
   * Chapters that only link elsewhere are dropped rather than listed: they
   * have no page list, so a reader who opened one would get an empty chapter
   * with no way to tell why. That filtering happens here and not as
   * `includeExternalUrl=0`, which this endpoint answers with an empty
   * collection for every series — unlike `/chapter`, where it works.
   */
  private async fetchChapters(
    id: string,
    signal?: AbortSignal,
  ): Promise<SChapter[]> {
    const chapters: SChapter[] = []

    for (let page = 0; page < MAX_FEED_PAGES; page++) {
      const url = new URL(`${this.apiBase}/manga/${id}/feed`)
      url.searchParams.set('limit', String(FEED_PER_PAGE))
      url.searchParams.set('offset', String(page * FEED_PER_PAGE))
      url.searchParams.set('translatedLanguage[]', this.lang)
      url.searchParams.set('includes[]', 'scanlation_group')
      url.searchParams.set('order[volume]', 'desc')
      url.searchParams.set('order[chapter]', 'desc')
      url.searchParams.set('includeFutureUpdates', '0')
      url.searchParams.set('includeEmptyPages', '0')
      this.applyContentRating(url)

      const body = await this.get<Collection<ChapterDto>>(url, signal)

      for (const dto of body.data) {
        if (dto.attributes.externalUrl || dto.attributes.isUnavailable) continue
        chapters.push(toSChapter(dto, id))
      }

      if (body.offset + body.data.length >= body.total) break
    }

    return chapters
  }

  // ---------------------------------------------------------------- pages --

  async getPageList(
    _manga: SManga,
    chapter: SChapter,
    signal?: AbortSignal,
  ): Promise<Page[]> {
    const id = chapterId(chapter.url)
    if (!id) throw new Error('This chapter has no MangaDex id.')

    const body = await this.get<AtHomeResponse>(
      new URL(`${this.apiBase}/at-home/server/${id}`),
      signal,
    )

    const quality = this.dataSaver ? 'data-saver' : 'data'
    const files = this.dataSaver ? body.chapter.dataSaver : body.chapter.data

    if (files.length === 0) {
      throw new Error('This chapter has no pages on MangaDex.')
    }

    return files.map((file, index) => ({
      index,
      imageUrl: this.image(body.baseUrl, quality, body.chapter.hash, file),
    }))
  }

  // -------------------------------------------------------------- filters --

  getFilterList(): FilterList {
    return [
      sortFilter(),
      selectFilter('Status', STATUS_VALUES),
      selectFilter('Demographic', DEMOGRAPHIC_VALUES),
    ]
  }

  // ----------------------------------------------------------------- urls --

  getMangaWebUrl(manga: SManga): string {
    return `${SITE_URL}/title/${mangaId(manga.url) ?? ''}`
  }

  getChapterWebUrl(_manga: SManga, chapter: SChapter): string {
    return `${SITE_URL}/chapter/${chapterId(chapter.url) ?? ''}`
  }

  // ------------------------------------------------------------ transport --

  private async get<T>(url: URL, signal?: AbortSignal): Promise<T> {
    const res = await this.http.fetch({ url: url.toString(), signal })
    return await res.json<T>()
  }

  private applyContentRating(url: URL): void {
    for (const rating of ratingsFor(this.ratingFilter)) {
      url.searchParams.append('contentRating[]', rating)
    }
  }

  // --------------------------------------------------------------- images --

  /**
   * One page image on the MangaDex@Home node this chapter was assigned.
   *
   * The node's hostname changes between chapters and over time, so it travels
   * as the first path segment of the proxy route rather than being baked into
   * one. Under Node there is no proxy and the node is addressed directly.
   */
  private image(
    baseUrl: string,
    quality: string,
    hash: string,
    file: string,
  ): string {
    const path = `/${quality}/${hash}/${file}`
    if (!this.imageBase) return `${baseUrl}${path}`

    let host: string
    try {
      host = new URL(baseUrl).host
    } catch {
      return `${baseUrl}${path}`
    }
    return `${this.imageBase}/${host}${path}`
  }

  private toSManga(dto: MangaDto): SManga {
    const attributes = dto.attributes
    const cover = relationOf(dto.relationships, 'cover_art')?.attributes?.fileName

    return {
      url: `/series/${dto.id}`,
      title: readTitle(attributes) ?? dto.id,
      author: namesOf(dto.relationships, 'author') || undefined,
      artist: namesOf(dto.relationships, 'artist') || undefined,
      description: localized(attributes.description) || undefined,
      genre: readTags(dto),
      status: toStatus(attributes.status),
      // `.512.jpg` is MangaDex's own derivative size. The full-resolution
      // cover is several megabytes, which is a poor trade for a grid tile.
      thumbnailUrl: cover
        ? `${this.coverBase}/covers/${dto.id}/${cover}.512.jpg`
        : undefined,
      initialized: true,
    }
  }
}

// ------------------------------------------------------------- conversion --

/**
 * The app addresses every source through `/series/<slug>` and
 * `/series/<slug>/chapter/<key>`, rebuilding both from route parameters alone
 * (see `MangaDetailView` and `chapterStubOf`). MangaDex's two uuids are
 * therefore stored *as* those segments rather than under the site's own
 * `/manga/…` and `/chapter/…` paths, which would not survive the round trip.
 */
function mangaId(url: string): string | null {
  return /^\/series\/([0-9a-f-]{36})/i.exec(url)?.[1] ?? null
}

function chapterId(url: string): string | null {
  return /\/chapter\/([0-9a-f-]{36})$/i.exec(url)?.[1] ?? null
}

function relationOf(
  relationships: Relationship[],
  type: string,
): Relationship | undefined {
  return relationships.find((relation) => relation.type === type)
}

function namesOf(relationships: Relationship[], type: string): string {
  return relationships
    .filter((relation) => relation.type === type)
    .map((relation) => relation.attributes?.name)
    .filter((name): name is string => Boolean(name))
    .join(', ')
}

/**
 * One string out of a localised table.
 *
 * English first because that is the app's language, then the work's own
 * original language, then whatever the table happens to hold — a title that
 * exists only in Korean is still better than no title at all.
 */
function localized(
  table: LocalizedString,
  original?: string | null,
): string | undefined {
  const preferred = [
    'en',
    ...(original ? [original, `${original}-ro`] : []),
    ...Object.keys(table),
  ]
  for (const key of preferred) {
    const value = table[key]?.trim()
    if (value) return value
  }
  return undefined
}

/**
 * The title to show, English first wherever it lives.
 *
 * MangaDex files the canonical title under the work's own language, and for a
 * great many series that is the only key `title` has — Solo Leveling arrives as
 * `{ "ko-ro": "Na Honjaman Level-Up" }`. The English name is then sitting in
 * `altTitles`, so that is checked before falling back to the romanisation.
 * Showing a reader "Na Honjaman Level-Up" for a series they know by another
 * name makes the library unsearchable by the only name they have for it.
 */
function readTitle(attributes: MangaDto['attributes']): string | undefined {
  const english = attributes.title.en?.trim()
  if (english) return english

  for (const alternative of attributes.altTitles) {
    const value = alternative.en?.trim()
    if (value) return value
  }

  return localized(attributes.title, attributes.originalLanguage)
}

function readTags(dto: MangaDto): string[] | undefined {
  const tags = dto.attributes.tags
    .map((tag) => localized(tag.attributes.name))
    .filter((name): name is string => Boolean(name))

  const demographic = dto.attributes.publicationDemographic
  if (demographic) tags.unshift(capitalize(demographic))

  return tags.length > 0 ? tags : undefined
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function toSChapter(dto: ChapterDto, mangaId: string): SChapter {
  const attributes = dto.attributes
  const number = Number(attributes.chapter)
  const published = attributes.publishAt ? Date.parse(attributes.publishAt) : NaN

  return {
    url: `/series/${mangaId}/chapter/${dto.id}`,
    name: chapterName(attributes.volume, attributes.chapter, attributes.title),
    chapterNumber: Number.isFinite(number) ? number : -1,
    dateUpload: Number.isFinite(published) ? published : undefined,
    scanlator: namesOf(dto.relationships, 'scanlation_group') || undefined,
  }
}

/**
 * `Vol. 3 Ch. 12 - Title`, with every part that is missing left out.
 *
 * A oneshot carries neither volume nor chapter and only sometimes a title,
 * which is why the fallback is a word rather than an empty string.
 */
function chapterName(
  volume?: string | null,
  chapter?: string | null,
  title?: string | null,
): string {
  const parts: string[] = []
  if (volume) parts.push(`Vol. ${volume}`)
  if (chapter) parts.push(`Ch. ${chapter}`)

  const prefix = parts.join(' ')
  const suffix = title?.trim()

  if (prefix && suffix) return `${prefix} - ${suffix}`
  return prefix || suffix || 'Oneshot'
}

function toStatus(raw?: string | null): MangaStatus {
  switch (raw?.toLowerCase()) {
    case 'ongoing':
      return 'ongoing'
    case 'completed':
      return 'completed'
    case 'hiatus':
      return 'on_hiatus'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

function ratingsFor(value: string): readonly string[] {
  return CONTENT_RATINGS.find((entry) => entry.value === value)?.ratings ?? []
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

function applyFilters(url: URL, filters: FilterList, hasQuery: boolean): void {
  let ordered = false

  for (const filter of filters) {
    switch (filter.type) {
      case 'sort': {
        const key = SORT_VALUES[filter.state.index]![1]
        // `relevance` only exists as an ordering when there is a term to be
        // relevant to; sending it without one is rejected outright.
        if (key === 'relevance' && !hasQuery) break
        url.searchParams.set(
          `order[${key}]`,
          // Title and year read wrong descending by default: A-Z and oldest
          // first are what the labels promise.
          filter.state.ascending || key === 'title' ? 'asc' : 'desc',
        )
        ordered = true
        break
      }
      case 'select': {
        const table =
          filter.name === 'Status' ? STATUS_VALUES : DEMOGRAPHIC_VALUES
        const value = table[filter.state]?.[1]
        if (!value) break
        url.searchParams.append(
          filter.name === 'Status' ? 'status[]' : 'publicationDemographic[]',
          value,
        )
        break
      }
    }
  }

  if (!ordered) {
    url.searchParams.set(
      hasQuery ? 'order[relevance]' : 'order[followedCount]',
      'desc',
    )
  }
}
