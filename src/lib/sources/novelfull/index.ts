import { DirectFetchTransport, RateLimiter } from '../../transport/direct-fetch'
import type { HttpTransport } from '../../transport/types'
import { sanitizeChapterHtml } from '../../text/sanitize'
import type {
  ChapterText,
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
const SITE_URL = 'https://novelfull.com'

/**
 * Where requests actually go.
 *
 * NovelFull sends no `Access-Control-Allow-Origin` on anything — the search
 * page, the novel page and the chapter body are all refused to a browser. Like
 * Mangadot, everything is therefore routed through the app's own origin under
 * `/novelfull`, which the dev server proxies (see vite.config.ts): a same-origin
 * request is never subject to a CORS check at all.
 *
 * Outside a browser there is no such restriction and no proxy to speak to, so
 * the site is addressed directly. Note that a scraping source still cannot run
 * under Node without a DOM — see the note on `parse` below.
 */
function resolveApiBase(): string {
  if (typeof location === 'undefined') return SITE_URL
  return new URL('/novelfull', location.origin).toString()
}

/**
 * NovelFull publishes no rate limit.
 *
 * Two requests a second matches the Mangadot source's reasoning, and it matters
 * more here than for a source read directly: every user's traffic converges on
 * whichever host runs the proxy, so the site sees one IP rather than many.
 */
const RATE_LIMIT_PERMITS = 2
const RATE_LIMIT_PERIOD_MS = 1000

/**
 * Listings, verified against the live site.
 *
 * Each is a real path rather than a query parameter, so an unrecognised value
 * would 404 rather than silently returning an unsorted page.
 */
const SORT_VALUES = [
  ['Most popular', 'most-popular'],
  ['Latest release', 'latest-release-novel'],
  ['Completed', 'completed-novel'],
] as const

/**
 * NovelFull.
 *
 * Ported from the Lightnovel Crawler source of the same name — a 22-line
 * crawler over a 79-line shared template, which is almost entirely CSS
 * selectors and URL patterns. The parsing carried across; the fetching did not,
 * because lncrawl runs in Python where the same-origin policy does not exist.
 * That is what the proxy above replaces.
 *
 * Two things differ from the upstream template, both verified against the live
 * site rather than assumed:
 *  - the info block is a list of `div`s, not `li`s, so the upstream genre and
 *    author parsing finds nothing on the current deployment
 *  - the chapter body is `#chapter-content`; `#chr-content` is the older id and
 *    is kept only as a fallback
 */
export class NovelFull implements Source {
  readonly id = 'novelfull'
  readonly name = 'NovelFull'
  readonly lang = 'en'
  readonly baseUrl = SITE_URL
  readonly contentRating = 'safe'
  readonly versionCode = 1
  readonly contentKind = 'novel' as const
  readonly supportsLatest = true
  readonly isLocal = false
  readonly supportsFilterFetching = false
  readonly supportsRelatedMangas = false

  /**
   * Nothing to pace. This applies to page images, which the service worker
   * fetches outside the source's limiter; chapters are fetched here.
   */
  readonly pageFetchIntervalMs = 0

  private readonly http: HttpTransport
  private readonly apiBase: string

  constructor(transport?: HttpTransport, apiBase = resolveApiBase()) {
    this.apiBase = apiBase.replace(/\/$/, '')
    this.http =
      transport ??
      new DirectFetchTransport(
        new RateLimiter(RATE_LIMIT_PERMITS, RATE_LIMIT_PERIOD_MS),
      )
  }

  // ------------------------------------------------------------- browsing --

  getPopularManga(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.listing('most-popular', page, signal)
  }

  getLatestUpdates(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.listing('latest-release-novel', page, signal)
  }

  async getSearchMangaList(
    page: number,
    query: string,
    filters: FilterList,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const term = query.trim()
    if (!term) return await this.listing(listingOf(filters), page, signal)

    const url = new URL(`${this.apiBase}/search`)
    url.searchParams.set('keyword', term)
    url.searchParams.set('page', String(page))
    return await this.scrapeList(url.toString(), signal)
  }

  private async listing(
    path: string,
    page: number,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const url = new URL(`${this.apiBase}/${path}`)
    url.searchParams.set('page', String(page))
    return await this.scrapeList(url.toString(), signal)
  }

  private async scrapeList(
    url: string,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const doc = await this.fetchDocument(url, signal)

    const rows = [...doc.querySelectorAll("#list-page .row h3[class*='title'] > a")]
    const mangas = rows
      .map((anchor) => this.toSManga(anchor))
      .filter((manga): manga is SManga => manga !== null)

    return {
      mangas,
      // The paginator is authoritative; a full page of twenty is not, since a
      // list whose length is a multiple of the page size ends on a full page.
      hasNextPage: Boolean(
        doc.querySelector('ul.pagination li.next a, .pagination .next a'),
      ),
    }
  }

  /** One search/listing row. Null when it carries no usable link. */
  private toSManga(anchor: Element): SManga | null {
    const href = anchor.getAttribute('href')
    if (!href) return null

    const slug = slugFromPath(href)
    if (!slug) return null

    // The row's own thumbnail, which saves a request per card on the shelf.
    const row = anchor.closest('.row')
    const cover = row?.querySelector('img')?.getAttribute('src')

    return {
      url: seriesUrl(slug),
      title:
        anchor.getAttribute('title')?.trim() ||
        anchor.textContent?.trim() ||
        slug,
      status: 'unknown',
      thumbnailUrl: cover ? this.resolve(cover) : undefined,
      initialized: false,
      memo: { slug },
    }
  }

  // -------------------------------------------------------------- details --

  async getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
    signal?: AbortSignal,
  ): Promise<MangaUpdate> {
    const slug = slugOf(manga)
    const doc = await this.fetchDocument(
      `${this.apiBase}/${slug}.html`,
      signal,
    )

    const chapters = opts.fetchChapters
      ? await this.fetchChapters(doc, slug, signal)
      : []

    if (!opts.fetchDetails) return { manga, chapters }

    return { manga: this.parseDetails(doc, slug), chapters }
  }

  private parseDetails(doc: Document, slug: string): SManga {
    // `h3.title` matches twice — once beside the cover and once in the
    // description column — with the same text in both. The first will do.
    const title = doc.querySelector('h3.title')?.textContent?.trim()
    const cover = doc.querySelector('.book img')?.getAttribute('src')

    return {
      url: seriesUrl(slug),
      title: title || slug,
      author: infoValues(doc, 'Author').join(', ') || undefined,
      description: doc.querySelector('.desc-text')?.textContent?.trim(),
      genre: infoValues(doc, 'Genre'),
      status: toStatus(infoValues(doc, 'Status')[0]),
      thumbnailUrl: cover ? this.resolve(cover) : undefined,
      initialized: true,
      memo: { slug },
    }
  }

  /**
   * The chapter list.
   *
   * The novel page shows only its first fifty chapters, so the real list comes
   * from the ajax route keyed on the numeric id in `#rating[data-novel-id]` —
   * one request for the whole thing, however long the novel is. The anchors on
   * the page itself are the fallback for a deployment that stopped emitting
   * that id.
   */
  private async fetchChapters(
    doc: Document,
    slug: string,
    signal?: AbortSignal,
  ): Promise<SChapter[]> {
    const novelId = doc
      .querySelector('#rating[data-novel-id]')
      ?.getAttribute('data-novel-id')

    if (novelId) {
      // Which of the two routes answers depends on the deployment, and the
      // page says which by whether it defines `ajaxChapterOptionUrl`.
      const route = doc.documentElement.innerHTML.includes('ajaxChapterOptionUrl')
        ? 'ajax-chapter-option'
        : 'ajax/chapter-archive'

      try {
        const list = await this.fetchDocument(
          `${this.apiBase}/${route}?novelId=${encodeURIComponent(novelId)}`,
          signal,
        )
        const chapters = readChapterNodes(list, slug)
        if (chapters.length > 0) return chapters
      } catch {
        // Fall through to whatever the novel page itself listed.
      }
    }

    return readChapterNodes(doc, slug)
  }

  // ----------------------------------------------------------------- text --

  getPageList(): Promise<Page[]> {
    // `contentKind` is 'novel', so nothing should reach this. Throwing beats
    // returning [] silently, which would show as an empty chapter.
    return Promise.reject(
      new Error('NovelFull serves novels; chapters are read as text, not pages.'),
    )
  }

  async getChapterText(
    manga: SManga,
    chapter: SChapter,
    signal?: AbortSignal,
  ): Promise<ChapterText> {
    const res = await this.http.fetch({
      url: this.chapterTextUrl(manga, chapter),
      signal,
    })
    return this.parseChapterText(await res.text())
  }

  chapterTextUrl(manga: SManga, chapter: SChapter): string {
    const slug = slugOf(manga)
    const key = chapter.url.split('/').pop() ?? ''
    if (!key) throw new Error('This chapter has no NovelFull path.')
    return `${this.apiBase}/${slug}/${key}.html`
  }

  parseChapterText(raw: string): ChapterText {
    const doc = new DOMParser().parseFromString(raw, 'text/html')

    const body =
      doc.querySelector('#chapter-content') ?? doc.querySelector('#chr-content')
    if (!body) {
      throw new Error('NovelFull returned a page with no chapter body.')
    }

    // Adverts and navigation ride inside the body as bare `div`s. The upstream
    // crawler drops any block element containing no paragraph, which is the
    // rule that separates them from the prose; anything else would have to
    // guess at class names that change.
    for (const block of [...body.querySelectorAll('div, h1, h2, h3, h4, h5, h6')]) {
      if (!block.querySelector('p')) block.remove()
    }

    const text = sanitizeChapterHtml(body.innerHTML)
    if (!text.html.trim()) {
      throw new Error('NovelFull returned an empty chapter body.')
    }
    return text
  }

  // -------------------------------------------------------------- filters --

  getFilterList(): FilterList {
    return [sortFilter()]
  }

  // ----------------------------------------------------------------- urls --

  getMangaWebUrl(manga: SManga): string {
    return `${SITE_URL}/${slugOf(manga)}.html`
  }

  getChapterWebUrl(manga: SManga, chapter: SChapter): string {
    const key = chapter.url.split('/').pop() ?? ''
    return `${SITE_URL}/${slugOf(manga)}/${key}.html`
  }

  // -------------------------------------------------------------- helpers --

  /**
   * Fetches a page and parses it.
   *
   * `DOMParser` is a browser API, so this source cannot run under Node without
   * one being installed first — the reason it has no smoke script of its own.
   */
  private async fetchDocument(
    url: string,
    signal?: AbortSignal,
  ): Promise<Document> {
    const res = await this.http.fetch({ url, signal })
    return new DOMParser().parseFromString(await res.text(), 'text/html')
  }

  /** Site-relative paths resolved against the proxy, never against the site. */
  private resolve(path: string): string {
    if (/^https?:\/\//i.test(path)) return path
    return `${this.apiBase}${path.startsWith('/') ? path : `/${path}`}`
  }
}

// ------------------------------------------------------------- conversion --

function seriesUrl(slug: string): string {
  return `/series/${slug}`
}

function slugOf(manga: SManga): string {
  const memoSlug = manga.memo?.slug
  if (typeof memoSlug === 'string' && memoSlug) return memoSlug
  return manga.url.replace(/^\/series\//, '').replace(/\/$/, '')
}

/**
 * The identity a site path reduces to.
 *
 * `/some-novel.html` becomes `some-novel`. The extension is stripped rather
 * than kept because `url` is half of `manga_source_url_unique` and has to stay
 * stable: a site that drops `.html` from its paths would otherwise turn every
 * existing library entry into a different series.
 */
function slugFromPath(href: string): string | null {
  const path = href.split('?')[0]?.split('#')[0] ?? ''
  const last = path.split('/').filter(Boolean).pop()
  if (!last) return null
  return last.replace(/\.html?$/i, '') || null
}

/**
 * Chapter anchors, from either the ajax list or the novel page.
 *
 * The ajax route answers with `<option value="...">` and the novel page with
 * `<li><a href="...">`, so both are read. Deliberately not one combined
 * selector: on some deployments `select > option[value]` also matches the
 * theme-colour picker, which arrives as forty chapters named after greys.
 */
function readChapterNodes(doc: Document, slug: string): SChapter[] {
  const options = [...doc.querySelectorAll('select > option[value]')]
  const anchors = [...doc.querySelectorAll('ul.list-chapter > li > a[href]')]

  const nodes = options.length > 0 ? options : anchors
  const chapters: SChapter[] = []

  for (const node of nodes) {
    const href = node.getAttribute('value') ?? node.getAttribute('href')
    if (!href) continue

    const key = slugFromPath(href)
    // A chapter path is `/<novel>/<chapter>.html`; anything that reduces to the
    // novel's own slug is a link back to the series, not a chapter.
    if (!key || key === slug) continue

    chapters.push({
      url: `${seriesUrl(slug)}/chapter/${key}`,
      name:
        node.getAttribute('title')?.trim() ||
        node.textContent?.trim() ||
        key,
      // Position in the list, assigned after the loop so gaps in the site's own
      // numbering cannot produce duplicates.
      chapterNumber: chapters.length + 1,
      memo: { slug },
    })
  }

  return chapters
}

/**
 * Values from one row of the novel page's info block.
 *
 * The block is a list of `div`s each headed by an `h3` — "Author:", "Genre:",
 * "Status:". The upstream template looks for `li` here and finds nothing on the
 * current deployment, so both are accepted.
 */
function infoValues(doc: Document, label: string): string[] {
  const container = doc.querySelector('.info, .info-meta')
  if (!container) return []

  for (const row of [...container.querySelectorAll('div, li')]) {
    const header = row.querySelector('h3')
    if (!header?.textContent?.includes(label)) continue

    const links = [...row.querySelectorAll('a')]
      .map((a) => a.textContent?.trim() ?? '')
      .filter(Boolean)
    if (links.length > 0) return links

    // "Status:" is sometimes plain text rather than a link.
    const text = row.textContent?.replace(header.textContent ?? '', '').trim()
    return text ? [text] : []
  }

  return []
}

function toStatus(raw?: string): MangaStatus {
  switch (raw?.trim().toLowerCase()) {
    case 'ongoing':
      return 'ongoing'
    case 'completed':
      return 'completed'
    default:
      return 'unknown'
  }
}

// ---------------------------------------------------------------- filters --

function sortFilter(): Filter {
  return {
    type: 'sort',
    name: 'List',
    values: SORT_VALUES.map(([label]) => label),
    state: { index: 0, ascending: false },
  }
}

function listingOf(filters: FilterList): string {
  for (const filter of filters) {
    if (filter.type !== 'sort') continue
    return SORT_VALUES[filter.state.index]?.[1] ?? 'most-popular'
  }
  return 'most-popular'
}
