import { DirectFetchTransport, RateLimiter } from '../../transport/direct-fetch'
import { HttpStatusError, type HttpTransport } from '../../transport/types'
import type {
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
const SITE_URL = 'https://www.webtoons.com'

/**
 * Image hosts. Covers, episode thumbnails and page images are spread across
 * several `*.pstatic.net` names and all of them hotlink-check.
 */
const IMAGE_HOST = /^[a-z-]+\.pstatic\.net$/

const ICON_URL =
  'https://cdn.jsdelivr.net/gh/keiyoushi/extensions-source@main/src/all/webtoons/res/mipmap-xhdpi/ic_launcher.png'

/**
 * Where requests actually go.
 *
 * The site sends no CORS headers, gates consent and mature titles behind
 * cookies, and serves 403 for any image fetched without a `Referer` naming it.
 * The proxy supplies all three: the site under `/webtoons`, images under
 * `/webtoonscdn/<host>`.
 */
function resolveApiBase(): string {
  if (typeof location === 'undefined') return SITE_URL
  return new URL('/webtoons', location.origin).toString()
}

function resolveImageBase(): string | null {
  if (typeof location === 'undefined') return null
  return new URL('/webtoonscdn', location.origin).toString()
}

/** The site publishes no limit. One a second: these are full page loads. */
const RATE_LIMIT_PERMITS = 1
const RATE_LIMIT_PERIOD_MS = 1000

/** The gap between page-image fetch starts. See the other comic sources. */
const PAGE_FETCH_INTERVAL_MS = 150

/**
 * An episode list is paged ten at a time and a long-running series has
 * hundreds of pages. Forty is 400 episodes, past which the list is truncated
 * rather than spending a minute of wall clock on one refresh.
 */
const MAX_LIST_PAGES = 40

/**
 * The two entry points that address a series by id alone.
 *
 * The site keeps its catalogues apart down to the routing: `/episodeList`
 * answers for a licensed Original and 404s for a reader-submitted Canvas
 * series, `/challenge/episodeList` the other way round. Nothing in an id says
 * which of the two a series belongs to, so both are tried.
 */
const ENTRY_PATHS = ['/episodeList', '/challenge/episodeList'] as const

/**
 * The four rankings, walked as pages.
 *
 * There is no single "popular" listing: the site publishes separate boards for
 * what is trending, what is popular overall, and the two catalogues. Each is
 * one screenful, so they are offered in sequence rather than merged.
 */
const RANKINGS = ['trending', 'popular', 'originals', 'canvas'] as const

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const

const GENRE_VALUES = [
  ['All', ''],
  ['Action', 'action'],
  ['Comedy', 'comedy'],
  ['Drama', 'drama'],
  ['Fantasy', 'fantasy'],
  ['Historical', 'historical'],
  ['Horror', 'horror'],
  ['Romance', 'romance'],
  ['Sci-fi', 'sf'],
  ['Slice of life', 'slice_of_life'],
  ['Superhero', 'super_hero'],
  ['Thriller', 'thriller'],
] as const

/**
 * Webtoons.
 *
 * The publisher's own site, so the catalogue is licensed rather than scanlated
 * and the markup is stable. Two structural quirks shape this source:
 *
 *  - **Episodes are paged ten at a time**, and the page links are the only
 *    record of how many there are, so the list is walked rather than requested
 *    in one call.
 *  - **Every image is lazy**, carrying its real address in `data-url` with a
 *    transparent placeholder in `src`. Reading `src` yields the same 1×1 pixel
 *    for every page in the chapter.
 */
export class Webtoons implements Source {
  readonly id = 'webtoons'
  readonly name = 'Webtoons'
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
  private readonly imageBase: string | null

  /**
   * Series id to the site's own path for it, e.g. `10036` to
   * `/en/thriller/i-dare-you`.
   *
   * The app hands this source a bare id and nothing else (see the note on
   * `seriesPath`), but the site needs the genre and name in the path to serve
   * anything but the first page of episodes. Resolving the two costs a
   * request, or two when the series turns out to be in the other catalogue,
   * and the answer does not change — so it is kept for the session.
   */
  private readonly paths = new Map<string, string>()

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
          url.pathname.startsWith('/webtoonscdn') || IMAGE_HOST.test(url.host),
        ),
      )
  }

  // ------------------------------------------------------------- browsing --

  async getPopularManga(
    page: number,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const ranking = RANKINGS[page - 1]
    if (!ranking) return { mangas: [], hasNextPage: false }

    const doc = await this.fetchDocument(
      `${this.apiBase}/${this.lang}/ranking/${ranking}`,
      signal,
    )
    return {
      mangas: this.readList(doc),
      hasNextPage: page < RANKINGS.length,
    }
  }

  /**
   * Today's releases, newest first.
   *
   * The site schedules by weekday rather than publishing a rolling feed, so
   * "latest" is the day's board. It is one page and there is no second.
   */
  async getLatestUpdates(
    page: number,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    if (page > 1) return { mangas: [], hasNextPage: false }

    const weekday = WEEKDAYS[new Date().getDay()]!
    const url = new URL(`${this.apiBase}/${this.lang}/originals/${weekday}`)
    url.searchParams.set('sortOrder', 'UPDATE')

    const doc = await this.fetchDocument(url.toString(), signal)
    return { mangas: this.readList(doc), hasNextPage: false }
  }

  /**
   * Search covers the two catalogues separately, so they are offered as two
   * pages: the licensed originals first, then the reader-submitted canvas.
   */
  async getSearchMangaList(
    page: number,
    query: string,
    filters: FilterList,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const term = query.trim()
    if (!term) return await this.browseGenre(page, filters, signal)
    if (page > 2) return { mangas: [], hasNextPage: false }

    const url = new URL(
      `${this.apiBase}/${this.lang}/search${page === 2 ? '/canvas' : ''}`,
    )
    url.searchParams.set('keyword', term)

    const doc = await this.fetchDocument(url.toString(), signal)
    return { mangas: this.readList(doc), hasNextPage: page === 1 }
  }

  private async browseGenre(
    page: number,
    filters: FilterList,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const genre = readGenre(filters)
    if (!genre) return await this.getPopularManga(page, signal)
    if (page > 1) return { mangas: [], hasNextPage: false }

    const doc = await this.fetchDocument(
      `${this.apiBase}/${this.lang}/genres/${genre}`,
      signal,
    )
    return { mangas: this.readList(doc), hasNextPage: false }
  }

  /** Every series card on a board, ranking, search result or genre page. */
  private readList(doc: Document): SManga[] {
    const mangas: SManga[] = []
    const seen = new Set<string>()

    for (const anchor of doc.querySelectorAll('a[href*="list?title_no="]')) {
      const href = anchor.getAttribute('href')
      const url = href ? seriesPath(href) : null
      if (!url || seen.has(url)) continue

      const image = anchor.querySelector('img')
      const title =
        anchor.querySelector('.subj')?.textContent?.trim() ||
        image?.getAttribute('alt')?.trim()
      if (!title) continue

      seen.add(url)
      mangas.push({
        url,
        title,
        status: 'unknown',
        thumbnailUrl: this.image(readImageUrl(image)),
        initialized: false,
      })
    }

    return mangas
  }

  // -------------------------------------------------------------- details --

  async getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
    signal?: AbortSignal,
  ): Promise<MangaUpdate> {
    const id = seriesId(manga.url)
    if (!id) throw new Error('This series has no Webtoons id.')

    const { path, document: first } = await this.resolvePath(id, signal)

    return {
      manga: opts.fetchDetails ? this.readDetails(first, manga) : manga,
      chapters: opts.fetchChapters
        ? await this.fetchChapters(first, manga, path, signal)
        : [],
    }
  }

  /**
   * The site's path for a series, and the first page of its episode list.
   *
   * The entry points in `ENTRY_PATHS` address a series by id and redirect to
   * the readable address, but they ignore `page`, so anything past the first
   * ten episodes needs the real path. The page states that path in its
   * canonical link, which is the only place it can be read from — the redirect
   * itself is followed inside the proxy and never reaches us.
   */
  private async resolvePath(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; document: Document }> {
    const known = this.paths.get(id)
    if (known) {
      const url = new URL(`${this.apiBase}${known}`)
      url.searchParams.set('title_no', id)
      return { path: known, document: await this.fetchDocument(url.toString(), signal) }
    }

    for (const entryPath of ENTRY_PATHS) {
      const entry = new URL(`${this.apiBase}${entryPath}`)
      entry.searchParams.set('titleNo', id)

      let document: Document
      try {
        document = await this.fetchDocument(entry.toString(), signal)
      } catch (error) {
        // The catalogue this series is not in answers 404, and the other one
        // is still to try. Anything else is a real failure and is the
        // caller's to report.
        if (error instanceof HttpStatusError && error.status === 404) continue
        throw error
      }

      const canonical =
        document.querySelector('link[rel="canonical"]')?.getAttribute('href') ??
        document
          .querySelector('meta[property="og:url"]')
          ?.getAttribute('content')

      const path = canonical ? listPath(canonical) : null
      if (!path) continue

      this.paths.set(id, path)
      return { path, document }
    }

    throw new Error('Webtoons did not say where this series lives.')
  }

  private readDetails(doc: Document, manga: SManga): SManga {
    const genre = doc.querySelector('h2.genre')?.textContent?.trim()
    const cover = doc
      .querySelector('meta[property="og:image"]')
      ?.getAttribute('content')

    return {
      ...manga,
      title: doc.querySelector('h1.subj')?.textContent?.trim() || manga.title,
      author: readAuthors(doc),
      description: doc.querySelector('p.summary')?.textContent?.trim(),
      genre: genre ? [genre] : undefined,
      status: toStatus(doc.querySelector('p.day_info')?.textContent),
      thumbnailUrl: cover ? this.image(cover) : manga.thumbnailUrl,
      initialized: true,
    }
  }

  /**
   * Every episode, walked page by page.
   *
   * The first page is already in hand, and its pager names the rest. Page
   * links only cover a block of ten at a time, so the highest number seen is
   * re-read after each fetch rather than taken once from the first page.
   */
  private async fetchChapters(
    first: Document,
    manga: SManga,
    path: string,
    signal?: AbortSignal,
  ): Promise<SChapter[]> {
    const id = seriesId(manga.url)!
    const chapters = readEpisodes(first, manga.url)
    const seen = new Set(chapters.map((chapter) => chapter.url))
    let lastPage = readLastPage(first)

    for (let page = 2; page <= Math.min(lastPage, MAX_LIST_PAGES); page++) {
      const url = new URL(`${this.apiBase}${path}`)
      url.searchParams.set('title_no', id)
      url.searchParams.set('page', String(page))

      const doc = await this.fetchDocument(url.toString(), signal)
      for (const chapter of readEpisodes(doc, manga.url)) {
        if (seen.has(chapter.url)) continue
        seen.add(chapter.url)
        chapters.push(chapter)
      }
      lastPage = Math.max(lastPage, readLastPage(doc))
    }

    return chapters
  }

  // ---------------------------------------------------------------- pages --

  async getPageList(
    _manga: SManga,
    chapter: SChapter,
    signal?: AbortSignal,
  ): Promise<Page[]> {
    const id = seriesId(chapter.url)
    const episode = episodeNo(chapter.url)
    if (!id || !episode) throw new Error('This episode has no Webtoons id.')

    const { path } = await this.resolvePath(id, signal)
    const url = new URL(
      `${this.apiBase}${path.replace(/\/list$/, '')}/episode-${episode}/viewer`,
    )
    url.searchParams.set('title_no', id)
    url.searchParams.set('episode_no', episode)

    const doc = await this.fetchDocument(url.toString(), signal)

    const images = [...doc.querySelectorAll('#_imageList img')]
      .map((img) => readImageUrl(img))
      .filter((src): src is string => Boolean(src))

    if (images.length === 0) {
      throw new Error('This episode has no pages on Webtoons.')
    }

    // Whole images, nothing tiled, so `Page.descramble` stays unset.
    return images.map((imageUrl, index) => ({
      index,
      imageUrl: this.image(imageUrl)!,
    }))
  }

  // -------------------------------------------------------------- filters --

  getFilterList(): FilterList {
    return [
      {
        type: 'select',
        name: 'Genre',
        values: GENRE_VALUES.map(([label]) => label),
        state: 0,
      },
    ]
  }

  // ----------------------------------------------------------------- urls --

  /**
   * Addressed by id rather than by the readable path, which this source does
   * not always hold. The site redirects it to the readable one.
   */
  getMangaWebUrl(manga: SManga): string {
    return `${SITE_URL}/episodeList?titleNo=${seriesId(manga.url) ?? ''}`
  }

  getChapterWebUrl(manga: SManga, chapter: SChapter): string {
    const id = seriesId(chapter.url)
    const episode = episodeNo(chapter.url)
    const path = id ? this.paths.get(id) : null

    // Without a resolved path there is no episode address to give, so the
    // series is offered instead rather than a link that 404s.
    if (!id || !episode || !path) return this.getMangaWebUrl(manga)

    const base = path.replace(/\/list$/, '')
    return `${SITE_URL}${base}/episode-${episode}/viewer?title_no=${id}&episode_no=${episode}`
  }

  // --------------------------------------------------------------- images --

  /** An image on one of the site's hosts, pointed at the proxy that can read it. */
  private image(url: string | null): string | undefined {
    if (!url) return undefined
    if (!this.imageBase) return url

    let parsed: URL
    try {
      parsed = new URL(url, SITE_URL)
    } catch {
      return url
    }
    if (!IMAGE_HOST.test(parsed.host)) return url

    return `${this.imageBase}/${parsed.host}${parsed.pathname}${parsed.search}`
  }

  private async fetchDocument(
    url: string,
    signal?: AbortSignal,
  ): Promise<Document> {
    const res = await this.http.fetch({ url, signal })
    return new DOMParser().parseFromString(await res.text(), 'text/html')
  }
}

// ------------------------------------------------------------- conversion --

/**
 * An image's real address.
 *
 * Everything on the site is lazy-loaded: `src` holds a shared transparent
 * placeholder and `data-url` holds the picture. Taking `src` would give every
 * page in a chapter the same 1×1 pixel.
 */
function readImageUrl(image: Element | null | undefined): string | null {
  if (!image) return null
  return image.getAttribute('data-url') ?? image.getAttribute('src')
}

/**
 * The app addresses every source through `/series/<slug>` and
 * `/series/<slug>/chapter/<key>`, and rebuilds both from route parameters
 * alone — see `MangaDetailView` in the series route and `chapterStubOf` in
 * the reader. Neither segment may contain a slash or a query string, which
 * rules out storing the site's own address for a work.
 *
 * What is stored instead is the pair of numbers that actually identify it:
 * `title_no` as the slug, `episode_no` as the key. The genre and name in the
 * site's path are decoration it will re-derive; see `resolvePath`.
 */
function seriesPath(href: string): string | null {
  const query = href.split('?')[1]
  if (!query) return null
  const titleNo = new URLSearchParams(query.split('#')[0]).get('title_no')
  return titleNo ? `/series/${titleNo}` : null
}

function chapterPath(mangaUrl: string, href: string): string | null {
  const query = href.split('?')[1]
  if (!query) return null
  const episodeNo = new URLSearchParams(query.split('#')[0]).get('episode_no')
  return episodeNo ? `${mangaUrl}/chapter/${episodeNo}` : null
}

function seriesId(url: string): string | null {
  return /^\/series\/(\d+)/.exec(url)?.[1] ?? null
}

function episodeNo(url: string): string | null {
  return /\/chapter\/(\d+)$/.exec(url)?.[1] ?? null
}

/**
 * The author line, without the info button that shares its container.
 *
 * The site nests a `<button>` inside the author area, so the container's text
 * ends with "author info" unless it is removed first.
 */
function readAuthors(doc: Document): string | undefined {
  const area = doc.querySelector('.author_area')
  if (!area) return undefined

  const button = area.querySelector('button')?.textContent ?? ''
  const text = (area.textContent ?? '').replace(button, '')

  return (
    text
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .join(', ') || undefined
  )
}

function readEpisodes(doc: Document, mangaUrl: string): SChapter[] {
  const chapters: SChapter[] = []

  for (const item of doc.querySelectorAll('li._episodeItem')) {
    const href = item.querySelector('a')?.getAttribute('href')
    const url = href ? chapterPath(mangaUrl, href) : null
    if (!url) continue

    const name = item.querySelector('.subj')?.textContent?.trim()
    const episodeNo = Number(item.getAttribute('data-episode-no'))

    chapters.push({
      url,
      name: name || `Episode ${Number.isFinite(episodeNo) ? episodeNo : ''}`.trim(),
      // The episode number is the site's own ordering and is on the row, so
      // there is nothing to parse out of a free-text name.
      chapterNumber: Number.isFinite(episodeNo) ? episodeNo : -1,
      dateUpload: parseDate(item.querySelector('.date')?.textContent),
    })
  }

  return chapters
}

/**
 * The highest page the pager names.
 *
 * The pager shows a block of ten at a time, so this is the end of the current
 * block rather than of the list — which is why the caller re-reads it as it
 * goes instead of trusting the first page's answer.
 */
function readLastPage(doc: Document): number {
  let last = 1

  for (const anchor of doc.querySelectorAll('.paginate a')) {
    const page = Number(anchor.textContent?.trim())
    if (Number.isFinite(page)) last = Math.max(last, page)
  }

  return last
}

/** `/en/<genre>/<name>/list` out of an absolute canonical url. */
function listPath(canonical: string): string | null {
  try {
    const path = new URL(canonical).pathname
    return /^\/[a-z-]+\/[^/]+\/[^/]+\/list$/.test(path) ? path : null
  } catch {
    return null
  }
}

/** `Sep 7, 2026`, the only date shape the episode list prints. */
function parseDate(raw?: string | null): number | undefined {
  const text = raw?.trim()
  if (!text) return undefined
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * The schedule line doubles as the status: a running series says which day it
 * updates, a finished one says so outright.
 */
function toStatus(raw?: string | null): MangaStatus {
  const text = raw?.trim().toLowerCase() ?? ''
  if (!text) return 'unknown'
  if (text.includes('completed')) return 'completed'
  if (text.includes('hiatus')) return 'on_hiatus'
  if (text.includes('every') || text.includes('up')) return 'ongoing'
  return 'unknown'
}

// ---------------------------------------------------------------- filters --

function readGenre(filters: FilterList): string | null {
  for (const filter of filters) {
    if (filter.type === 'select' && filter.name === 'Genre') {
      return GENRE_VALUES[filter.state]?.[1] || null
    }
  }
  return null
}
