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
const SITE_URL = 'https://toonily.com'

/** Covers sit on `static`, page images on `data`. Both refuse a bare request. */
const IMAGE_HOST = /^(data|static)\.tnlycdn\.com$/

const ICON_URL =
  'https://cdn.jsdelivr.net/gh/keiyoushi/extensions-source@main/src/en/toonily/res/mipmap-xhdpi/ic_launcher.png'

/**
 * Where requests actually go.
 *
 * Two things make the hop mandatory here rather than merely convenient. The
 * site sends no CORS headers, and its image hosts answer 403 to any request
 * without a `Referer` naming the site — which the browser will not send, since
 * the reader and the service worker both use `no-referrer`. The proxy supplies
 * it, along with the maturity cookie the site gates half its catalogue behind.
 */
function resolveApiBase(): string {
  if (typeof location === 'undefined') return SITE_URL
  return new URL('/toonily', location.origin).toString()
}

function resolveImageBase(): string | null {
  if (typeof location === 'undefined') return null
  return new URL('/toonilycdn', location.origin).toString()
}

/** What one listing page holds. Fixed by the theme, not by a parameter. */
const PER_PAGE = 18

/** The site publishes no limit. Two a second, matching the other scrapers. */
const RATE_LIMIT_PERMITS = 2
const RATE_LIMIT_PERIOD_MS = 1000

/** The gap between page-image fetch starts. See the other comic sources. */
const PAGE_FETCH_INTERVAL_MS = 150

const SORT_VALUES = [
  ['Most views', 'views'],
  ['Trending', 'trending'],
  ['Latest', 'latest'],
  ['Newest', 'new-manga'],
  ['Rating', 'rating'],
  ['A-Z', 'alphabet'],
] as const

/**
 * A sized derivative of a cover: `…-175x238.jpg`.
 *
 * The listing serves thumbnails at the size its own grid draws them, which is
 * smaller than this app's cover tiles. Stripping the suffix asks for the
 * original, which is what the extension's cover interceptor does too.
 */
const SIZED_COVER = /-\d+x\d+(\.\w+)$/

/**
 * Toonily.
 *
 * A Madara WordPress theme, so everything is server-rendered HTML and the whole
 * chapter list ships inside the series page — no separate chapter call, which
 * matters because the theme's own chapter endpoint is a POST and the proxy
 * only forwards GET.
 *
 * Adult by default: the catalogue is mature and the site hides most of it
 * until a cookie says so. The proxy sets that cookie, and the `adult` rating
 * here is what puts the 18+ badge on the source and lets Browse hide it.
 */
export class Toonily implements Source {
  readonly id = 'toonily'
  readonly name = 'Toonily'
  readonly lang = 'en'
  readonly baseUrl = SITE_URL
  readonly iconUrl = ICON_URL
  readonly contentRating = 'adult'
  readonly versionCode = 1
  readonly supportsLatest = true
  readonly isLocal = false
  readonly supportsFilterFetching = false
  readonly supportsRelatedMangas = false
  readonly pageFetchIntervalMs = PAGE_FETCH_INTERVAL_MS

  private readonly http: HttpTransport
  private readonly apiBase: string
  private readonly imageBase: string | null

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
          url.pathname.startsWith('/toonilycdn') || IMAGE_HOST.test(url.host),
        ),
      )
  }

  // ------------------------------------------------------------- browsing --

  getPopularManga(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.getSearchMangaList(page, '', [sortFilter('views')], signal)
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
    const url = term ? this.searchUrl(term, page) : this.listingUrl(filters, page)

    const doc = await this.fetchDocument(url, signal)
    const mangas = [...doc.querySelectorAll('.page-item-detail')]
      .map((item) => this.toSManga(item))
      .filter((manga): manga is SManga => manga !== null)

    return {
      // The theme prints no "next" link, so a full page is taken to mean there
      // is another. A catalogue ending exactly on a full page costs one empty
      // page at the end, which is the cheaper of the two mistakes here.
      mangas,
      hasNextPage: mangas.length >= PER_PAGE,
    }
  }

  private searchUrl(term: string, page: number): string {
    const url = new URL(
      page > 1 ? `${this.apiBase}/page/${page}/` : `${this.apiBase}/`,
    )
    url.searchParams.set('s', term)
    url.searchParams.set('post_type', 'wp-manga')
    return url.toString()
  }

  private listingUrl(filters: FilterList, page: number): string {
    const url = new URL(
      page > 1
        ? `${this.apiBase}/serie/page/${page}/`
        : `${this.apiBase}/serie/`,
    )
    url.searchParams.set('m_orderby', readSort(filters))
    return url.toString()
  }

  private toSManga(item: Element): SManga | null {
    const anchor = item.querySelector('.post-title a')
    const href = anchor?.getAttribute('href')
    const url = href ? seriesPath(href) : null
    const title = anchor?.textContent?.trim()
    if (!url || !title) return null

    const cover = item.querySelector('.item-thumb img')?.getAttribute('src')

    return {
      url,
      title,
      status: 'unknown',
      thumbnailUrl: cover ? this.image(cover) : undefined,
      initialized: false,
    }
  }

  // -------------------------------------------------------------- details --

  async getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
    signal?: AbortSignal,
  ): Promise<MangaUpdate> {
    const path = sitePath(manga.url)
    if (!path) throw new Error('This series has no Toonily path.')

    // Details and the whole chapter list arrive in one document.
    const doc = await this.fetchDocument(`${this.apiBase}${path}/`, signal)

    return {
      manga: opts.fetchDetails ? this.readDetails(doc, manga) : manga,
      chapters: opts.fetchChapters ? readChapters(doc, manga.url) : [],
    }
  }

  private readDetails(doc: Document, manga: SManga): SManga {
    const cover = doc
      .querySelector('.summary_image img')
      ?.getAttribute('src')

    const genre = [...doc.querySelectorAll('.genres-content a')]
      .map((node) => node.textContent?.trim() ?? '')
      .filter(Boolean)

    return {
      ...manga,
      // The badge (`END`) sits inside the heading, so the title is read from
      // the first text node rather than from the element's whole text.
      title: readHeading(doc) || manga.title,
      author: joinLinks(doc, '.author-content a'),
      artist: joinLinks(doc, '.artist-content a'),
      description: doc.querySelector('.summary__content')?.textContent?.trim(),
      genre: genre.length > 0 ? genre : undefined,
      status: toStatus(readSummaryField(doc, 'status')),
      thumbnailUrl: cover ? this.image(cover) : manga.thumbnailUrl,
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
    if (!path) throw new Error('This chapter has no Toonily path.')

    const doc = await this.fetchDocument(`${this.apiBase}${path}/`, signal)

    const images = [...doc.querySelectorAll('img.wp-manga-chapter-img')]
      .map((img) => img.getAttribute('src')?.trim())
      // The theme injects a promo banner into the strip, served from the site
      // rather than the image host. Keeping only CDN-hosted images drops it
      // without having to match whatever id or filename it wears this week.
      .filter((src): src is string => Boolean(src) && isImageHost(src!))

    if (images.length === 0) {
      throw new Error('This chapter has no pages on Toonily.')
    }

    // Whole images, nothing tiled, so `Page.descramble` stays unset.
    return images.map((imageUrl, index) => ({
      index,
      imageUrl: this.image(imageUrl),
    }))
  }

  // -------------------------------------------------------------- filters --

  /**
   * Sort only.
   *
   * The theme's status and genre filters are part of a form this source does
   * not post, and sending their parameters on the listing url was measured to
   * change nothing. A filter that silently does not filter is worse than no
   * filter, so they are left out.
   */
  getFilterList(): FilterList {
    return [sortFilter()]
  }

  // ----------------------------------------------------------------- urls --

  getMangaWebUrl(manga: SManga): string {
    return `${SITE_URL}${sitePath(manga.url) ?? ''}/`
  }

  getChapterWebUrl(_manga: SManga, chapter: SChapter): string {
    return `${SITE_URL}${chapterSitePath(chapter.url) ?? ''}/`
  }

  // --------------------------------------------------------------- images --

  /**
   * A cover or page image, pointed at wherever we are actually fetching.
   *
   * Covers additionally have their size suffix stripped: the listing links a
   * thumbnail scaled for the site's own grid, which is smaller than the tiles
   * here and visibly soft on a phone at two columns.
   */
  private image(url: string): string {
    if (!this.imageBase) return url

    let parsed: URL
    try {
      parsed = new URL(url, SITE_URL)
    } catch {
      return url
    }
    if (!IMAGE_HOST.test(parsed.host)) return url

    const path =
      parsed.host === 'static.tnlycdn.com'
        ? parsed.pathname.replace(SIZED_COVER, '$1')
        : parsed.pathname

    return `${this.imageBase}/${parsed.host}${path}${parsed.search}`
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

function isImageHost(url: string): boolean {
  try {
    return IMAGE_HOST.test(new URL(url, SITE_URL).host)
  } catch {
    return false
  }
}

/**
 * The app addresses every source through `/series/<slug>` and
 * `/series/<slug>/chapter/<key>`, and rebuilds both from route parameters
 * alone — see `MangaDetailView` in the series route and `chapterStubOf` in
 * the reader. Both segments therefore have to carry everything needed to
 * re-address the work, and neither may contain a slash.
 */
function seriesPath(href: string): string | null {
  // Older entries are filed under `/webtoon/`; the theme serves both and the
  // canonical one is `/serie/`, which is what every current link uses.
  const match = /\/(?:serie|webtoon)\/([^/?#]+)/.exec(href)
  return match ? `/series/${match[1]}` : null
}

function chapterPath(mangaUrl: string, href: string): string | null {
  const part = /\/(?:serie|webtoon)\/[^/?#]+\/([^/?#]+)/.exec(href)?.[1]
  return part ? `${mangaUrl}/chapter/${part}` : null
}

/** The site's own path for a series, rebuilt from our slug. */
function sitePath(url: string): string | null {
  const slug = /^\/series\/([^/?#]+)/.exec(url)?.[1]
  return slug ? `/serie/${slug}` : null
}

/** The site's own path for a chapter, rebuilt from our slug and key. */
function chapterSitePath(url: string): string | null {
  const match = /^\/series\/([^/?#]+)\/chapter\/([^/?#]+)$/.exec(url)
  return match ? `/serie/${match[1]}/${match[2]}` : null
}

/** The heading's own text, without the status badge nested inside it. */
function readHeading(doc: Document): string | undefined {
  const heading = doc.querySelector('.post-title h1')
  if (!heading) return undefined

  const badge = heading.querySelector('.manga-title-badges')
  const text = badge
    ? heading.textContent?.replace(badge.textContent ?? '', '')
    : heading.textContent

  return text?.trim() || undefined
}

function joinLinks(doc: Document, selector: string): string | undefined {
  const names = [...doc.querySelectorAll(selector)]
    .map((node) => node.textContent?.trim() ?? '')
    .filter(Boolean)
  return names.length > 0 ? names.join(', ') : undefined
}

/**
 * A `summary-heading` / `summary-content` pair, matched on the heading.
 *
 * The theme gives neither half a distinguishing class, so the label is the
 * only way in — the same reason the other scrapers here walk rows rather than
 * selecting them.
 */
function readSummaryField(doc: Document, label: string): string | undefined {
  for (const item of doc.querySelectorAll('.post-content_item')) {
    const heading = item.querySelector('.summary-heading')?.textContent ?? ''
    if (!heading.toLowerCase().includes(label)) continue
    const value = item.querySelector('.summary-content')?.textContent?.trim()
    if (value) return value
  }
  return undefined
}

function readChapters(doc: Document, mangaUrl: string): SChapter[] {
  const chapters: SChapter[] = []

  for (const item of doc.querySelectorAll('li.wp-manga-chapter')) {
    const anchor = item.querySelector('a')
    const href = anchor?.getAttribute('href')
    const name = anchor?.textContent?.trim()
    if (!href || !name) continue

    const url = chapterPath(mangaUrl, href)
    if (!url) continue

    chapters.push({
      url,
      name,
      chapterNumber: readChapterNumber(url) ?? -1,
      dateUpload: parseDate(
        item.querySelector('.chapter-release-date')?.textContent,
      ),
    })
  }

  return chapters
}

/**
 * The number in a chapter key (`chapter-262`, `chapter-14-5`).
 *
 * Read from the url rather than the name: the name carries the uploader's
 * subtitle (`Chapter 262 - The End`) and the trailing token is as often a word
 * as a number.
 */
function readChapterNumber(url: string): number | null {
  const match = /chapter-(\d+)(?:-(\d+))?/.exec(url)
  if (!match) return null
  return Number(match[2] ? `${match[1]}.${match[2]}` : match[1])
}

/**
 * `Nov 27, 24`, the shape the theme prints.
 *
 * The year is two digits, which `Date.parse` reads as 1924 rather than 2024,
 * so it is widened before parsing. A relative stamp ("2 days ago", "UP") is
 * left undefined rather than approximated — the chapter list is ordered by the
 * site, so a missing date costs nothing.
 */
function parseDate(raw?: string | null): number | undefined {
  const text = raw?.trim()
  if (!text) return undefined

  const match = /^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{2})$/.exec(text)
  if (!match) return undefined

  const parsed = Date.parse(`${match[1]} ${match[2]}, 20${match[3]}`)
  return Number.isFinite(parsed) ? parsed : undefined
}

function toStatus(raw?: string): MangaStatus {
  const text = raw?.trim().toLowerCase() ?? ''
  if (text.includes('ongoing') || text.includes('on going')) return 'ongoing'
  if (text.includes('completed') || text === 'end') return 'completed'
  if (text.includes('hold') || text.includes('hiatus')) return 'on_hiatus'
  if (text.includes('cancel')) return 'cancelled'
  return 'unknown'
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

function readSort(filters: FilterList): string {
  for (const filter of filters) {
    if (filter.type === 'sort') return SORT_VALUES[filter.state.index]![1]
  }
  return 'views'
}
