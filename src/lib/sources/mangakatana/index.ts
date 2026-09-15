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

/** Where the site lives, and what "open in browser" must point at. */
const SITE_URL = 'https://mangakatana.com'

/**
 * Page images are served from numbered hosts under the same domain
 * (`i1.`, `i2.`, …), assigned per chapter. The proxy accepts the host in the
 * path rather than carrying one route per number.
 */
const IMAGE_HOST = /^i\d*\.mangakatana\.com$/

const ICON_URL =
  'https://cdn.jsdelivr.net/gh/keiyoushi/extensions-source@main/src/en/mangakatana/res/mipmap-xhdpi/ic_launcher.png'

/**
 * Where requests actually go.
 *
 * The site sends no `Access-Control-Allow-Origin` on its HTML or its images.
 * In a browser the site is reached under `/mangakatana` and the numbered image
 * hosts under `/katanacdn/<host>/…`; outside one both are addressed directly.
 */
function resolveApiBase(): string {
  if (typeof location === 'undefined') return SITE_URL
  return new URL('/mangakatana', location.origin).toString()
}

function resolveCdnBase(): string | null {
  if (typeof location === 'undefined') return null
  return new URL('/katanacdn', location.origin).toString()
}

/** The site publishes no limit. Two a second, matching the other scrapers. */
const RATE_LIMIT_PERMITS = 2
const RATE_LIMIT_PERIOD_MS = 1000

/** The gap between page-image fetch starts. See the other comic sources. */
const PAGE_FETCH_INTERVAL_MS = 150

const SORT_VALUES = [
  ['Latest update', 'latest'],
  ['New manga', 'new'],
  ['Number of chapters', 'numc'],
  ['A-Z', 'az'],
] as const

const STATUS_VALUES = [
  ['All', ''],
  ['Ongoing', '1'],
  ['Completed', '2'],
  ['Cancelled', '0'],
] as const

const CHAPTER_COUNT_VALUES = [
  ['Any', ''],
  ['1', 'e1'],
  ['1+', '1'],
  ['5+', '5'],
  ['10+', '10'],
  ['20+', '20'],
  ['30+', '30'],
  ['50+', '50'],
  ['100+', '100'],
  ['150+', '150'],
  ['200+', '200'],
] as const

/**
 * The page-image array in a chapter's inline script.
 *
 * The variable is renamed on every request (`thzq` one call, `ytaw` the next),
 * so it is matched by shape rather than by name: a `var` holding an array of
 * quoted http urls. The page declares the same array twice under two names,
 * which is why the longest match wins rather than the first.
 */
const IMAGE_ARRAY = /var\s+\w+\s*=\s*\[\s*((?:'https?:[^']*'\s*,?\s*)+)\]/g

/**
 * MangaKatana.
 *
 * A plain server-rendered aggregator. Search has one wrinkle worth naming: a
 * query matching exactly one series is answered with a redirect to that
 * series rather than with a one-row list, so the result document is checked
 * for which of the two it is.
 */
export class MangaKatana implements Source {
  readonly id = 'mangakatana'
  readonly name = 'MangaKatana'
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
  private readonly cdnBase: string | null

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
          // Covers and page images are static files, not page loads.
          url.pathname.startsWith('/katanacdn') ||
          url.pathname.startsWith('/mangakatana/imgs/') ||
          IMAGE_HOST.test(url.host),
        ),
      )
  }

  // ------------------------------------------------------------- browsing --

  getPopularManga(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.getSearchMangaList(page, '', [sortFilter('numc')], signal)
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
    const term = query.trim()
    const url = term
      ? this.searchUrl(term, page)
      : this.listingUrl(filters, page)

    const doc = await this.fetchDocument(url, signal)

    // A search matching exactly one series is redirected straight to it, so
    // what comes back is a detail page rather than a list. Reading it as a
    // list would report "no results" for the one case that matched perfectly.
    const single = readSingleResult(doc, this.image)
    if (single) return { mangas: [single], hasNextPage: false }

    const mangas = [...doc.querySelectorAll('#book_list .item')]
      .map((item) => this.toSManga(item))
      .filter((manga): manga is SManga => manga !== null)

    return {
      mangas,
      hasNextPage: Boolean(doc.querySelector('a.next.page-numbers')),
    }
  }

  private searchUrl(term: string, page: number): string {
    const url = new URL(`${this.apiBase}/page/${page}`)
    url.searchParams.set('search', term)
    url.searchParams.set('search_by', 'book_name')
    return url.toString()
  }

  private listingUrl(filters: FilterList, page: number): string {
    const url = new URL(`${this.apiBase}/manga/page/${page}`)
    url.searchParams.set('filter', '1')
    applyFilters(url, filters)
    return url.toString()
  }

  private toSManga(item: Element): SManga | null {
    const anchor = item.querySelector('h3.title a')
    const href = anchor?.getAttribute('href')
    const url = href ? seriesPath(href) : null
    const title = anchor?.textContent?.trim()
    if (!url || !title) return null

    return {
      url,
      title,
      status: toStatus(item.querySelector('.status')?.textContent),
      thumbnailUrl: readCover(item, this.image),
      initialized: false,
    }
  }

  // -------------------------------------------------------------- details --

  async getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
    signal?: AbortSignal,
  ): Promise<MangaUpdate> {
    // Details and the whole chapter list are one document, so one fetch
    // answers both regardless of which was asked for.
    const path = sitePath(manga.url)
    if (!path) throw new Error('This series has no MangaKatana path.')
    const doc = await this.fetchDocument(`${this.apiBase}${path}`, signal)

    return {
      manga: opts.fetchDetails ? this.readDetails(doc, manga) : manga,
      chapters: opts.fetchChapters ? readChapters(doc, manga.url) : [],
    }
  }

  private readDetails(doc: Document, manga: SManga): SManga {
    const rows = readRows(doc)
    const genre = [...doc.querySelectorAll('.genres a')]
      .map((node) => node.textContent?.trim() ?? '')
      .filter(Boolean)

    return {
      ...manga,
      title: doc.querySelector('h1.heading')?.textContent?.trim() || manga.title,
      author:
        [...doc.querySelectorAll('a.author')]
          .map((node) => node.textContent?.trim())
          .filter(Boolean)
          .join(', ') || undefined,
      description: readSummary(doc),
      genre: genre.length > 0 ? genre : undefined,
      status: toStatus(rows.get('status')),
      thumbnailUrl: readCover(doc, this.image) ?? manga.thumbnailUrl,
      initialized: true,
    }
  }

  // ---------------------------------------------------------------- pages --

  async getPageList(
    _manga: SManga,
    chapter: SChapter,
    signal?: AbortSignal,
  ): Promise<Page[]> {
    const path = chapterSitePath(chapter.url)
    if (!path) throw new Error('This chapter has no MangaKatana path.')

    const res = await this.http.fetch({ url: `${this.apiBase}${path}`, signal })
    const images = readImageArray(await res.text())

    if (images.length === 0) {
      throw new Error('This chapter has no pages on MangaKatana.')
    }

    // Whole images, nothing tiled, so `Page.descramble` stays unset.
    return images.map((imageUrl, index) => ({
      index,
      imageUrl: this.image(imageUrl),
    }))
  }

  // -------------------------------------------------------------- filters --

  getFilterList(): FilterList {
    return [
      sortFilter(),
      selectFilter('Status', STATUS_VALUES),
      selectFilter('Chapters', CHAPTER_COUNT_VALUES),
    ]
  }

  // ----------------------------------------------------------------- urls --

  getMangaWebUrl(manga: SManga): string {
    return `${SITE_URL}${sitePath(manga.url) ?? ''}`
  }

  getChapterWebUrl(_manga: SManga, chapter: SChapter): string {
    return `${SITE_URL}${chapterSitePath(chapter.url) ?? ''}`
  }

  // --------------------------------------------------------------- images --

  /**
   * A cover or page image, pointed at wherever we are actually fetching.
   *
   * Covers sit on the site's own host and go through the site's proxy; page
   * images sit on numbered hosts and go through the CDN proxy, which takes the
   * host as its first path segment. Under Node there is no proxy and every url
   * is returned as it came.
   *
   * An arrow property rather than a method: it is handed to the readers below
   * as a callback, and a plain method would arrive unbound.
   */
  private readonly image = (url: string): string => {
    if (!this.cdnBase) return url

    let parsed: URL
    try {
      parsed = new URL(url, SITE_URL)
    } catch {
      return url
    }

    if (IMAGE_HOST.test(parsed.host)) {
      return `${this.cdnBase}/${parsed.host}${parsed.pathname}${parsed.search}`
    }
    if (parsed.origin === SITE_URL) {
      return `${this.apiBase}${parsed.pathname}${parsed.search}`
    }
    return url
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
 * The app addresses every source through `/series/<slug>` and
 * `/series/<slug>/chapter/<key>`, and rebuilds both from route parameters
 * alone — see `MangaDetailView` in the series route and `chapterStubOf` in
 * the reader. Both segments therefore have to carry everything needed to
 * re-address the work, and neither may contain a slash.
 */
function seriesPath(href: string): string | null {
  const match = /\/manga\/([^/?#]+)/.exec(href)
  return match ? `/series/${match[1]}` : null
}

/** The site's own path for a series, rebuilt from our slug. */
function sitePath(url: string): string | null {
  const slug = /^\/series\/([^/?#]+)/.exec(url)?.[1]
  return slug ? `/manga/${slug}` : null
}

/** A detail page reached by a redirect, read as the one result it stands for. */
function readSingleResult(
  doc: Document,
  image: (url: string) => string,
): SManga | null {
  if (doc.querySelector('#book_list')) return null

  const title = doc.querySelector('h1.heading')?.textContent?.trim()
  // The redirect is followed before the document reaches us, so the address
  // that was landed on is only recoverable from the page's own canonical link.
  const href =
    doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ??
    doc.querySelector('meta[property="og:url"]')?.getAttribute('content')
  const url = href ? seriesPath(href) : null
  if (!title || !url) return null

  return {
    url,
    title,
    status: toStatus(readRows(doc).get('status')),
    thumbnailUrl: readCover(doc, image),
    initialized: false,
  }
}

/**
 * The best cover in a subtree.
 *
 * The markup offers avif, webp and jpeg through a `<picture>`. The `<img>` is
 * taken rather than the first `<source>`: it is the format every browser
 * decodes, and the saved bytes have to open again later from the cache.
 */
function readCover(
  root: ParentNode,
  image: (url: string) => string,
): string | undefined {
  const src = root.querySelector('img[src]')?.getAttribute('src')
  return src ? image(src) : undefined
}

/**
 * The detail page's `label: value` rows, keyed by a lowercase label with its
 * punctuation dropped (`Alt name(s):` → `altnames`).
 */
function readRows(doc: Document): Map<string, string> {
  const rows = new Map<string, string>()

  for (const row of doc.querySelectorAll('.d-row-small')) {
    const label = row.querySelector('.label')?.textContent ?? ''
    const key = label.toLowerCase().replace(/[^a-z]/g, '')
    const value = row.querySelector('.value')?.textContent?.trim()
    if (key && value && !rows.has(key)) rows.set(key, value)
  }

  return rows
}

function readSummary(doc: Document): string | undefined {
  return doc.querySelector('.summary p')?.textContent?.trim() || undefined
}

function readChapters(doc: Document, mangaUrl: string): SChapter[] {
  const chapters: SChapter[] = []

  for (const row of doc.querySelectorAll('.chapters tr')) {
    const anchor = row.querySelector('.chapter a')
    const href = anchor?.getAttribute('href')
    const name = anchor?.textContent?.trim()
    if (!href || !name) continue

    const url = chapterPath(mangaUrl, href)
    if (!url) continue

    chapters.push({
      url,
      name,
      chapterNumber: readChapterNumber(url) ?? -1,
      dateUpload: parseDate(row.querySelector('.update_time')?.textContent),
    })
  }

  return chapters
}

function chapterPath(mangaUrl: string, href: string): string | null {
  const part = /\/manga\/[^/?#]+\/([^/?#]+)/.exec(href)?.[1]
  return part ? `${mangaUrl}/chapter/${part}` : null
}

/** The site's own path for a chapter, rebuilt from our slug and key. */
function chapterSitePath(url: string): string | null {
  const match = /^\/series\/([^/?#]+)\/chapter\/([^/?#]+)$/.exec(url)
  return match ? `/manga/${match[1]}/${match[2]}` : null
}

/**
 * The number a chapter url carries (`c9`, `c10.5`).
 *
 * Read from the url rather than the name because the name is free text the
 * uploader writes — `Chapter 9: A Dazzling Future` parses, `Final Arc` does
 * not, and both address a chapter the url numbers cleanly.
 */
function readChapterNumber(url: string): number | null {
  const match = /\/c(\d+(?:\.\d+)?)/.exec(url)
  return match ? Number(match[1]) : null
}

/** `May-27-2019`, the only date shape the site prints. */
function parseDate(raw?: string | null): number | undefined {
  const text = raw?.trim()
  if (!text) return undefined
  const parsed = Date.parse(text.replace(/-/g, ' '))
  return Number.isFinite(parsed) ? parsed : undefined
}

function toStatus(raw?: string | null): MangaStatus {
  const text = raw?.trim().toLowerCase() ?? ''
  if (text.includes('ongoing')) return 'ongoing'
  if (text.includes('completed')) return 'completed'
  if (text.includes('hiatus')) return 'on_hiatus'
  if (text.includes('cancel')) return 'cancelled'
  return 'unknown'
}

/** Every url in the chapter script's image array. See `IMAGE_ARRAY`. */
function readImageArray(html: string): string[] {
  let longest: string[] = []

  for (const match of html.matchAll(IMAGE_ARRAY)) {
    const urls = [...match[1]!.matchAll(/'(https?:[^']*)'/g)].map((m) => m[1]!)
    if (urls.length > longest.length) longest = urls
  }

  return longest
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

function applyFilters(url: URL, filters: FilterList): void {
  for (const filter of filters) {
    switch (filter.type) {
      case 'sort':
        url.searchParams.set('order', SORT_VALUES[filter.state.index]![1])
        break
      case 'select': {
        const table =
          filter.name === 'Status' ? STATUS_VALUES : CHAPTER_COUNT_VALUES
        const value = table[filter.state]?.[1]
        if (!value) break
        url.searchParams.set(filter.name === 'Status' ? 'status' : 'chapters', value)
        break
      }
    }
  }

  if (!url.searchParams.has('order')) url.searchParams.set('order', 'latest')
}
