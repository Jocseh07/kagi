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
import {
  parseAllTitles,
  parseAllTitlesV3,
  parseRanking,
  parseTitleDetail,
  parseViewer,
  parseWebHome,
} from './proto'
import type { Chapter, Title, TitleDetail } from './proto'
import { appOrigin } from '../app-origin'

/** Where the site lives, and what "open in browser" must point at. */
const SITE_URL = 'https://mangaplus.shueisha.co.jp'

const API_URL = 'https://jumpg-webapi.tokyo-cdn.com/api'

/** Covers and page images. Numbered hosts, assigned per request. */
const IMAGE_HOST = /^[a-z0-9-]+\.tokyo-cdn\.com$/

const ICON_URL =
  'https://cdn.jsdelivr.net/gh/keiyoushi/extensions-source@main/src/all/mangaplus/res/mipmap-xhdpi/ic_launcher.png'

/**
 * Where requests actually go.
 *
 * Three separate reasons the proxy is not optional here:
 *
 *  - The API refuses every call that arrives without a `SESSION-TOKEN`,
 *    answering an "Account Banned" popup instead of data. The browser cannot
 *    mint and hold one usefully; the Worker does (see the route).
 *  - Page images are XOR-encrypted with a per-page key. An `<img>` cannot
 *    decrypt, so the bytes are unwound during the hop.
 *  - Page images also require the chapter's view token as a request header,
 *    which an `<img>` cannot set either.
 *
 * Outside a browser there is no proxy, and a caller that wants this source has
 * to supply the token itself — which is why there is no Node smoke script for
 * it.
 */
function resolveApiBase(): string {
  if (typeof location === 'undefined') return API_URL
  return new URL('/mangaplus/api', appOrigin()).toString()
}

function resolveCdnBase(): string | null {
  if (typeof location === 'undefined') return null
  return new URL('/mangapluscdn', appOrigin()).toString()
}

/** How many titles one browse page shows, since the API pages none of this. */
const PER_PAGE = 30

/** The extension's budget: one request a second on the API. */
const RATE_LIMIT_PERMITS = 1
const RATE_LIMIT_PERIOD_MS = 1000

/**
 * Page images are decrypted as they stream through the Worker, so a fetch
 * costs more than a passthrough. 200 ms keeps several in flight without
 * stacking the work.
 */
const PAGE_FETCH_INTERVAL_MS = 200

/** The API's language code for this source's `lang`. */
const API_LANG = 'eng'

const IMAGE_QUALITY_VALUES = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'high' },
  { label: 'High', value: 'super_high' },
] as const

/**
 * The publication types `all_v3` splits its catalogue by. It serves one type
 * per call and refuses a call without one, which is why the genre filter
 * carries a status alongside it.
 */
const TYPE_VALUES = [
  ['Serializing', 'serializing'],
  ['Completed', 'completed'],
  ['One-shot', 'one-shot'],
] as const

const DEFAULT_TYPE = TYPE_VALUES[0][1]

export interface MangaPlusFilterData {
  genres: { label: string; value: string }[]
}

const PREF_QUALITY = 'imageQuality'
const PREF_SPLIT = 'splitImages'
const PREF_SUBTITLE_ONLY = 'subtitleOnly'

/** What `nonAppearanceInfo` says when a series has ended, in the languages seen. */
const COMPLETED_TEXT = /completado|completed?|completo/i
const HIATUS_TEXT = /on a hiatus/i

/**
 * MANGA Plus by Shueisha.
 *
 * The official publisher, so the catalogue is licensed and free — with the
 * catch that free means a rolling window: only the first few and the latest few
 * chapters of a series are readable, and the rest report as expired. Those are
 * filtered out rather than listed, since a listed chapter that cannot open is
 * worse than one that is absent.
 *
 * Everything here is protobuf rather than JSON (see `./proto`), and the images
 * are encrypted, which the proxy undoes.
 */
export class MangaPlus implements Source, ConfigurableSource {
  readonly id = 'mangaplus'
  readonly name = 'MANGA Plus'
  readonly lang = 'en'
  readonly baseUrl = SITE_URL
  readonly iconUrl = ICON_URL
  readonly contentRating = 'safe'
  readonly versionCode = 1
  readonly supportsLatest = true
  readonly isLocal = false
  readonly supportsFilterFetching = true
  readonly supportsRelatedMangas = false
  readonly pageFetchIntervalMs = PAGE_FETCH_INTERVAL_MS

  private readonly http: HttpTransport
  private readonly apiBase: string
  private readonly cdnBase: string | null

  private imageQuality: string = 'super_high'
  private splitImages = true
  private subtitleOnly = false

  /** Genre label to the slug `all_v3` tags its entries with. */
  private genreValues = new Map<string, string>()

  constructor(
    transport?: HttpTransport,
    apiBase = resolveApiBase(),
    cdnBase = resolveCdnBase(),
  ) {
    this.apiBase = apiBase.replace(/\/$/, '')
    this.cdnBase = cdnBase?.replace(/\/$/, '') ?? null
    this.http =
      transport ??
      new DirectFetchTransport(
        new RateLimiter(RATE_LIMIT_PERMITS, RATE_LIMIT_PERIOD_MS, (url) =>
          url.pathname.startsWith('/mangapluscdn'),
        ),
      )
  }

  // --------------------------------------------------------- preferences --

  getPreferences(): SourcePreference[] {
    return [
      {
        key: PREF_QUALITY,
        title: 'Image quality',
        summary: 'How much detail each page is served at.',
        type: 'select',
        default: 'super_high',
        values: IMAGE_QUALITY_VALUES.map((entry) => ({ ...entry })),
      },
      {
        key: PREF_SPLIT,
        title: 'Split double pages',
        summary: 'Serve a two-page spread as two single pages.',
        type: 'switch',
        default: true,
      },
      {
        key: PREF_SUBTITLE_ONLY,
        title: 'Chapter titles only',
        summary: 'Name chapters by their title, without the issue number.',
        type: 'switch',
        default: false,
      },
    ]
  }

  setPreferences(prefs: Record<string, string | boolean>): void {
    const quality = prefs[PREF_QUALITY]
    if (
      typeof quality === 'string' &&
      IMAGE_QUALITY_VALUES.some((entry) => entry.value === quality)
    ) {
      this.imageQuality = quality
    }
    if (typeof prefs[PREF_SPLIT] === 'boolean') {
      this.splitImages = prefs[PREF_SPLIT]
    }
    this.subtitleOnly = prefs[PREF_SUBTITLE_ONLY] === true
  }

  // ------------------------------------------------------------- browsing --

  /**
   * The site's "hottest" ranking. It is one board, not a feed, so there is no
   * second page.
   */
  async getPopularManga(
    page: number,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    if (page > 1) return { mangas: [], hasNextPage: false }

    const url = new URL(`${this.apiBase}/title_list/rankingV2`)
    url.searchParams.set('lang', API_LANG)
    url.searchParams.set('type', 'hottest')
    url.searchParams.set('clang', API_LANG)

    const titles = parseRanking(await this.bytes(url, signal))
    return { mangas: this.toMangas(titles), hasNextPage: false }
  }

  async getLatestUpdates(
    page: number,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    if (page > 1) return { mangas: [], hasNextPage: false }

    const url = new URL(`${this.apiBase}/web/web_homeV4`)
    url.searchParams.set('lang', API_LANG)
    url.searchParams.set('clang', API_LANG)

    const titles = parseWebHome(await this.bytes(url, signal))
    return { mangas: this.toMangas(titles), hasNextPage: false }
  }

  /**
   * Search over the catalogue, matched here rather than upstream.
   *
   * The API has no search endpoint; its own site filters the full title list in
   * the browser, and this does the same. The list is one call, so paging is a
   * slice.
   *
   * `allV2` is the whole catalogue regardless of publication type, so a plain
   * search keeps reading it. A chosen genre or type moves to `all_v3`, which
   * is the only endpoint that tags its entries.
   */
  async getSearchMangaList(
    page: number,
    query: string,
    filters: FilterList,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const type =
      TYPE_VALUES.find(([label]) => label === chosen(filters, 'Status'))?.[1] ??
      DEFAULT_TYPE
    const genre = this.genreValues.get(chosen(filters, 'Genre')) ?? ''

    const term = query.trim().toLowerCase()
    const titles =
      !genre && type === DEFAULT_TYPE && term
        ? parseAllTitles(
            await this.bytes(
              new URL(`${this.apiBase}/title_list/allV2`),
              signal,
            ),
          )
        : await this.catalogue(type, genre, signal)

    const matched = term
      ? titles.filter(
          (title) =>
            title.name.toLowerCase().includes(term) ||
            (title.author ?? '').toLowerCase().includes(term),
        )
      : titles

    const start = (page - 1) * PER_PAGE
    const slice = matched.slice(start, start + PER_PAGE)

    return {
      mangas: this.toMangas(slice),
      hasNextPage: start + slice.length < matched.length,
    }
  }

  /**
   * One publication type's catalogue, narrowed to a genre.
   *
   * A title appears once per genre group it belongs to in some responses, so
   * ids are de-duplicated rather than trusted.
   */
  private async catalogue(
    type: string,
    genre: string,
    signal?: AbortSignal,
  ): Promise<Title[]> {
    const { entries } = parseAllTitlesV3(
      await this.bytes(this.allTitlesUrl(type), signal),
    )

    const seen = new Set<number>()
    const titles: Title[] = []
    for (const entry of entries) {
      if (genre && !entry.genres.some((tag) => tag.slug === genre)) continue
      const { title } = entry
      if (title.titleId === 0 || seen.has(title.titleId)) continue

      seen.add(title.titleId)
      titles.push(title)
    }
    return titles
  }

  private allTitlesUrl(type: string): URL {
    const url = new URL(`${this.apiBase}/title_list/all_v3`)
    url.searchParams.set('type', type)
    url.searchParams.set('lang', API_LANG)
    url.searchParams.set('clang', API_LANG)
    return url
  }

  // -------------------------------------------------------------- details --

  async getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
    signal?: AbortSignal,
  ): Promise<MangaUpdate> {
    const id = titleId(manga.url)
    if (!id) throw new Error('This series has no MANGA Plus id.')

    // Details and the chapter list come back together, so one call answers
    // both whichever was asked for.
    const detail = await this.fetchDetail(id, signal)

    return {
      manga: opts.fetchDetails ? this.toSMangaDetailed(detail) : manga,
      chapters: opts.fetchChapters
        ? detail.chapters
            // No subtitle means the chapter has left its free window. It
            // cannot be opened, so it is not offered.
            .filter((chapter) => chapter.subTitle)
            .map((chapter) => this.toSChapter(chapter, detail.title.titleId))
            .reverse()
        : [],
    }
  }

  private async fetchDetail(
    id: string,
    signal?: AbortSignal,
  ): Promise<TitleDetail> {
    const url = new URL(`${this.apiBase}/title_detailV3`)
    url.searchParams.set('title_id', id)
    url.searchParams.set('clang', API_LANG)
    return parseTitleDetail(await this.bytes(url, signal))
  }

  // ---------------------------------------------------------------- pages --

  async getPageList(
    _manga: SManga,
    chapter: SChapter,
    signal?: AbortSignal,
  ): Promise<Page[]> {
    const id = chapterId(chapter.url)
    if (!id) throw new Error('This chapter has no MANGA Plus id.')

    const url = new URL(`${this.apiBase}/manga_viewer_v3`)
    url.searchParams.set('chapter_id', id)
    url.searchParams.set('split', this.splitImages ? 'yes' : 'no')
    url.searchParams.set('img_quality', this.imageQuality)
    url.searchParams.set('clang', API_LANG)

    const viewer = parseViewer(await this.bytes(url, signal))
    if (viewer.pages.length === 0) {
      throw new Error(
        'This chapter is no longer free to read on MANGA Plus.',
      )
    }

    // Whole images, nothing tiled, so `Page.descramble` stays unset — the
    // encryption is undone during the proxy hop rather than in the reader.
    return viewer.pages.map((page, index) => ({
      index,
      imageUrl: this.image(page.imageUrl, viewer.viewToken, page.encryptionKey),
    }))
  }

  // -------------------------------------------------------------- filters --

  /**
   * The genre vocabulary, read off the same endpoint search reads.
   *
   * A genre is a slug on an `all_v3` entry, so the two cannot disagree, which
   * is what a filter built from any other endpoint used to get wrong.
   */
  async fetchFilterData(signal?: AbortSignal): Promise<MangaPlusFilterData> {
    try {
      const { tags } = parseAllTitlesV3(
        await this.bytes(this.allTitlesUrl(DEFAULT_TYPE), signal),
      )
      const genres = tags
        .map((tag) => ({ label: tag.name.trim(), value: tag.slug.trim() }))
        .filter((genre) => genre.label && genre.value)
      this.rememberGenres(genres)
      return { genres }
    } catch {
      signal?.throwIfAborted()
      return { genres: [] }
    }
  }

  getFilterList(data?: unknown): FilterList {
    const genres = (data as MangaPlusFilterData | undefined)?.genres ?? []
    // Search reads the instance map rather than this argument, which the app
    // does not thread back into `getSearchMangaList`.
    if (genres.length) this.rememberGenres(genres)

    return [
      selectFilter('Status', TYPE_VALUES),
      selectFilter('Genre', [
        ['All', ''],
        ...genres.map((genre) => [genre.label, genre.value] as const),
      ]),
    ]
  }

  private rememberGenres(genres: MangaPlusFilterData['genres']): void {
    for (const genre of genres) this.genreValues.set(genre.label, genre.value)
  }

  // ----------------------------------------------------------------- urls --

  getMangaWebUrl(manga: SManga): string {
    return `${SITE_URL}/titles/${titleId(manga.url) ?? ''}`
  }

  getChapterWebUrl(_manga: SManga, chapter: SChapter): string {
    return `${SITE_URL}/viewer/${chapterId(chapter.url) ?? ''}`
  }

  // The two above read the site's ids back out of this app's url shape; see
  // `titleId` and `chapterId` at the bottom of this file for why the shapes
  // differ.

  // ------------------------------------------------------------ transport --

  private async bytes(url: URL, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await this.http.fetch({ url: url.toString(), signal })
    return new Uint8Array(await res.arrayBuffer())
  }

  // --------------------------------------------------------------- images --

  /**
   * One image, pointed at the proxy that can actually serve it.
   *
   * The view token and the decryption key travel as query parameters because
   * the reader fetches pages with an `<img>` and the service worker fetches
   * them with a bare `fetch`; neither can attach a header or unwind a cipher.
   * The proxy lifts them back off the query, sends the token as
   * `Plus-Vw-Token`, and XORs the body on the way through.
   *
   * A cover has no key and needs no token, so it goes through the same route
   * carrying neither.
   */
  private image(
    url: string,
    viewToken?: string,
    encryptionKey?: string,
  ): string {
    if (!this.cdnBase) {
      const direct = new URL(url)
      if (viewToken) direct.searchParams.set('vw', viewToken)
      if (encryptionKey) direct.searchParams.set('key', encryptionKey)
      return direct.toString()
    }

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return url
    }
    if (!IMAGE_HOST.test(parsed.host)) return url

    const proxied = new URL(
      `${this.cdnBase}/${parsed.host}${parsed.pathname}`,
    )
    for (const [key, value] of parsed.searchParams) {
      proxied.searchParams.set(key, value)
    }
    if (viewToken) proxied.searchParams.set('vw', viewToken)
    if (encryptionKey) proxied.searchParams.set('key', encryptionKey)

    return proxied.toString()
  }

  // -------------------------------------------------------------- mapping --

  private toMangas(titles: Title[]): SManga[] {
    // The same title appears in several ranking groups, and the catalogue
    // repeats a title once per language it exists in.
    const seen = new Set<number>()
    const mangas: SManga[] = []

    for (const title of titles) {
      if (title.titleId === 0 || seen.has(title.titleId)) continue
      seen.add(title.titleId)
      mangas.push(this.toSManga(title))
    }

    return mangas
  }

  private toSManga(title: Title): SManga {
    // The API joins a writer and an artist with a slash; the app lists names
    // with commas everywhere else.
    const author = title.author?.replace(/ \/ /g, ', ')

    return {
      url: `/series/${title.titleId}`,
      title: title.name,
      author,
      artist: author,
      status: 'unknown',
      thumbnailUrl: title.portraitImageUrl
        ? this.image(title.portraitImageUrl)
        : undefined,
      initialized: false,
    }
  }

  private toSMangaDetailed(detail: TitleDetail): SManga {
    const description = [detail.overview, detail.viewingPeriodDescription]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join('\n\n')

    return {
      ...this.toSManga(detail.title),
      description: description || undefined,
      genre: detail.genres.length > 0 ? detail.genres : undefined,
      status: toStatus(detail),
      initialized: true,
    }
  }

  private toSChapter(chapter: Chapter, mangaId: number): SChapter {
    const label = chapter.name.trim()
    const subtitle = chapter.subTitle?.trim()

    return {
      url: `/series/${mangaId}/chapter/${chapter.chapterId}`,
      name:
        this.subtitleOnly && subtitle
          ? subtitle
          : [label, subtitle].filter(Boolean).join(' - ') || 'Chapter',
      // The label is the issue number with a hash in front (`#1192`).
      chapterNumber: Number(label.replace(/^#/, '')) || -1,
      dateUpload:
        chapter.startTimeStamp && chapter.startTimeStamp > 0
          ? chapter.startTimeStamp * 1000
          : undefined,
      scanlator: 'MANGA Plus',
    }
  }
}

// ----------------------------------------------------------------- filters --

function selectFilter(
  name: string,
  values: readonly (readonly [string, string])[],
): Filter {
  return { type: 'select', name, values: values.map(([l]) => l), state: 0 }
}

/** The label a named select is sitting on, or nothing when it is absent. */
function chosen(filters: FilterList, name: string): string {
  for (const filter of filters) {
    if (filter.type !== 'select' || filter.name !== name) continue
    return filter.values[filter.state] ?? ''
  }
  return ''
}

// ------------------------------------------------------------- conversion --

/**
 * The app addresses every source through `/series/<slug>` and
 * `/series/<slug>/chapter/<key>`, and rebuilds both from route parameters
 * alone — see `MangaDetailView` and `chapterStubOf`. So the two ids this
 * source needs have to *be* those two segments; a url shaped like the site's
 * own `#/titles/…` never survives the round trip.
 */
function titleId(url: string): string | null {
  return /^\/series\/(\d+)/.exec(url)?.[1] ?? null
}

function chapterId(url: string): string | null {
  return /\/chapter\/(\d+)$/.exec(url)?.[1] ?? null
}

/**
 * The publication status, inferred from prose.
 *
 * There is no status field. What the API gives instead is a sentence for
 * readers — "on a hiatus", "completed" — in the notice fields, plus one edge
 * case: a title whose viewing period says zero chapters are viewable has
 * finished and been withdrawn. A one-shot has no ongoing state to be in.
 */
function toStatus(detail: TitleDetail): MangaStatus {
  const notice = detail.nonAppearanceInfo ?? ''
  const period = detail.viewingPeriodDescription ?? ''
  const isOneShot = detail.genres.some((genre) => /one[\s-]?shot/i.test(genre))

  if (isOneShot || COMPLETED_TEXT.test(notice) || /latest 0 chapters/i.test(period)) {
    return 'completed'
  }
  if (HIATUS_TEXT.test(notice)) return 'on_hiatus'
  return 'ongoing'
}
