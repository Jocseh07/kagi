import { parseDocument } from '../../text/document'
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
import { appOrigin } from '../app-origin'

/** Where the site lives, and what "open in browser" must point at. */
const SITE_URL = 'https://novelping.com'

/**
 * Covers, on their own host.
 *
 * Loaded straight by `<img>` rather than through the proxy: an image element
 * needs neither CORS nor a `Referer` here, which is how `webnovel` treats its
 * cover host too.
 */
const COVER_HOST = 'https://images.novelping.com'

/**
 * Where requests actually go.
 *
 * NovelPing sends no `Access-Control-Allow-Origin` on any page, so the browser
 * build routes everything through the app's own origin under `/novelping`.
 * Outside a browser there is no such restriction, so the site is addressed
 * directly — though a scraping source still cannot run under Node without a
 * DOM, see the note on `parse` below.
 */
function resolveApiBase(): string {
  if (typeof location === 'undefined') return SITE_URL
  return new URL('/novelping', appOrigin()).toString()
}

/**
 * NovelPing publishes no rate limit. Two requests a second matches what the
 * other scraping sources here settle on, and it matters more than for a source
 * read directly: every user's traffic converges on whichever host runs the
 * proxy.
 */
const RATE_LIMIT_PERMITS = 2
const RATE_LIMIT_PERIOD_MS = 1000

/** Listings, verified against the live site. Each value is a real path. */
const LIST_VALUES = [
  ['Latest release', 'sort/updates'],
  ['Trending', 'sort/hot'],
  ['Most popular', 'sort/popular'],
  ['Completed', 'sort/complete'],
] as const

/**
 * The `?sort=` modifier, which the site accepts on both `/sort/*` and
 * `/novelping-genres/*`. Empty means "leave the listing's own order alone".
 */
const ORDER_VALUES = [
  ['Default', ''],
  ['Recently added', 'NEW'],
  ['Top (most viewed)', 'ALL_TIME'],
  ['Popular this week', 'POPULAR'],
  ['Top rated', 'RATING'],
  ['Most chapters', 'CHAPTERS'],
] as const

/** Genre archives, from the site's own genre menu. */
const GENRE_VALUES: readonly (readonly [string, string])[] = [
  ['All', ''],
  ['Action', 'action'],
  ['Adult', 'adult'],
  ['Adventure', 'adventure'],
  ['Anime & comics', 'anime-&-comics'],
  ['Comedy', 'comedy'],
  ['Drama', 'drama'],
  ['Eastern', 'eastern'],
  ['Fan-fic', 'fan-fic'],
  ['Fan-fiction', 'fan-fiction'],
  ['Fantasy', 'fantasy'],
  ['Game', 'game'],
  ['Gender bender', 'gender-bender'],
  ['Harem', 'harem'],
  ['Historical', 'historical'],
  ['Horror', 'horror'],
  ['Isekai', 'isekai'],
  ['Josei', 'josei'],
  ['LitRPG', 'litrpg'],
  ['Magic', 'magic'],
  ['Magical realism', 'magical-realism'],
  ['Martial arts', 'martial-arts'],
  ['Mature', 'mature'],
  ['Mecha', 'mecha'],
  ['Military', 'military'],
  ['Modern life', 'modern-life'],
  ['Mystery', 'mystery'],
  ['Other', 'other'],
  ['Psychological', 'psychological'],
  ['Realistic', 'realistic'],
  ['Reincarnation', 'reincarnation'],
  ['Romance', 'romance'],
  ['School life', 'school-life'],
  ['Sci-fi', 'sci-fi'],
  ['Seinen', 'seinen'],
  ['Shoujo', 'shoujo'],
  ['Shoujo ai', 'shoujo-ai'],
  ['Shounen', 'shounen'],
  ['Shounen ai', 'shounen-ai'],
  ['Slice of life', 'slice-of-life'],
  ['Smut', 'smut'],
  ['Sports', 'sports'],
  ['Supernatural', 'supernatural'],
  ['System', 'system'],
  ['Thriller', 'thriller'],
  ['Tragedy', 'tragedy'],
  ['Urban', 'urban'],
  ['Video games', 'video-games'],
  ['War', 'war'],
  ['Wuxia', 'wuxia'],
  ['Xianxia', 'xianxia'],
  ['Xuanhuan', 'xuanhuan'],
  ['Yaoi', 'yaoi'],
  ['Yuri', 'yuri'],
]

/**
 * NovelPing.
 *
 * The same Bootstrap theme NovelFull runs, so the selectors are close cousins,
 * but the URL shapes are its own: series live under `/book/<slug>`, listings
 * under `/sort/<name>`, genres under `/novelping-genres/<slug>`, and the whole
 * chapter list comes from `/ajax/chapter-option?novelId=<slug>` — the slug is
 * the id, so nothing has to be looked up first.
 */
export class NovelPing implements Source {
  readonly id = 'novelping'
  readonly name = 'NovelPing'
  readonly lang = 'en'
  readonly baseUrl = SITE_URL
  readonly contentRating = 'mixed'
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
    return this.listing('sort/popular', '', page, signal)
  }

  getHotManga(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.listing('sort/hot', '', page, signal)
  }

  getLatestUpdates(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.listing('sort/updates', '', page, signal)
  }

  async getSearchMangaList(
    page: number,
    query: string,
    filters: FilterList,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const term = query.trim()
    if (term) {
      // The site's search takes neither a genre nor an order, so the filters
      // are dropped rather than encoded into a URL that ignores them.
      const url = new URL(`${this.apiBase}/search`)
      url.searchParams.set('keyword', term)
      url.searchParams.set('page', String(page))
      return await this.scrapeList(url.toString(), signal)
    }

    const order = orderOf(filters)
    const genre = genreOf(filters)
    if (genre) {
      return await this.listing(
        `novelping-genres/${encodeURIComponent(genre)}`,
        order,
        page,
        signal,
      )
    }
    return await this.listing(listingOf(filters), order, page, signal)
  }

  private async listing(
    path: string,
    order: string,
    page: number,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const url = new URL(`${this.apiBase}/${path}`)
    if (order) url.searchParams.set('sort', order)
    url.searchParams.set('page', String(page))
    return await this.scrapeList(url.toString(), signal)
  }

  private async scrapeList(
    url: string,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const doc = await this.fetchDocument(url, signal)

    const rows = [...doc.querySelectorAll('#list-page .row h3.novel-title > a')]
    const mangas = rows
      .map((anchor) => toSManga(anchor))
      .filter((manga): manga is SManga => manga !== null)

    return {
      mangas,
      // Both halves are load-bearing. The paginator alone loops forever:
      // `/sort/hot?page=99` renders zero rows and still marks `li.next`
      // enabled. A full page alone is not enough either, since a list whose
      // length is a multiple of twenty ends on a full page.
      hasNextPage:
        mangas.length > 0 &&
        Boolean(doc.querySelector('ul.pagination li.next a')),
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
      `${this.apiBase}/book/${encodeURIComponent(slug)}`,
      signal,
    )

    const chapters = opts.fetchChapters
      ? await this.fetchChapters(doc, slug, signal)
      : []

    if (!opts.fetchDetails) return { manga, chapters }

    return { manga: parseDetails(doc, slug), chapters }
  }

  /**
   * The chapter list.
   *
   * The series page carries only its first chapters, and those sit inside a
   * `<template>`, which `doc.querySelectorAll` cannot see. The ajax route
   * answers with the whole list in one request, so it leads; the template is
   * the fallback for the day that route changes shape.
   */
  private async fetchChapters(
    doc: Document,
    slug: string,
    signal?: AbortSignal,
  ): Promise<SChapter[]> {
    try {
      const list = await this.fetchDocument(
        `${this.apiBase}/ajax/chapter-option?novelId=${encodeURIComponent(slug)}`,
        signal,
      )
      const chapters = readOptionChapters(list, slug)
      if (chapters.length > 0) return chapters
    } catch {
      // Fall through to whatever the series page itself listed.
    }

    return readTemplateChapters(doc, slug)
  }

  // ----------------------------------------------------------------- text --

  getPageList(): Promise<Page[]> {
    // `contentKind` is 'novel', so nothing should reach this. Throwing beats
    // returning [] silently, which would show as an empty chapter.
    return Promise.reject(
      new Error('NovelPing serves novels; chapters are read as text, not pages.'),
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
    if (!key) throw new Error('This chapter has no NovelPing path.')
    return `${this.apiBase}/book/${slug}/${key}`
  }

  parseChapterText(raw: string): ChapterText {
    const doc = parseDocument(raw, 'text/html')

    const body = doc.querySelector('#chr-content')
    if (!body) {
      throw new Error('NovelPing returned a page with no chapter body.')
    }

    // Ad slots and navigation ride inside the body as bare `div`s. Dropping any
    // block element that contains no paragraph is the rule that separates them
    // from the prose; anything else would have to guess at class names that
    // change.
    for (const block of [...body.querySelectorAll('div, h1, h2, h3, h4, h5, h6')]) {
      if (!block.querySelector('p')) block.remove()
    }

    const text = sanitizeChapterHtml(body.innerHTML)
    if (!text.html.trim()) {
      // Also how a locked chapter surfaces: the theme ships premium badge
      // styling, and a body with nothing in it is what a paywall leaves.
      throw new Error('NovelPing returned an empty chapter body.')
    }
    return text
  }

  // -------------------------------------------------------------- filters --

  getFilterList(): FilterList {
    return [
      sortFilter(),
      selectFilter('Order', ORDER_VALUES),
      selectFilter('Genre', GENRE_VALUES),
      { type: 'header', name: 'A genre replaces the sort listing.' },
    ]
  }

  // ----------------------------------------------------------------- urls --

  getMangaWebUrl(manga: SManga): string {
    return `${SITE_URL}/book/${slugOf(manga)}`
  }

  getChapterWebUrl(manga: SManga, chapter: SChapter): string {
    const key = chapter.url.split('/').pop() ?? ''
    return `${SITE_URL}/book/${slugOf(manga)}/${key}`
  }

  // -------------------------------------------------------------- helpers --

  private async fetchDocument(
    url: string,
    signal?: AbortSignal,
  ): Promise<Document> {
    const res = await this.http.fetch({ url, signal })
    return parseDocument(await res.text(), 'text/html')
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
 * The slug a series link reduces to.
 *
 * Only `/book/<slug>` counts. The site emits absolute hrefs, and a chapter link
 * is `/book/<slug>/<chapter>`, so taking the last path segment would happily
 * turn a chapter into a series.
 */
function slugFromHref(href: string): string | null {
  try {
    const { pathname } = new URL(href, SITE_URL)
    return /^\/book\/([^/]+)\/?$/.exec(pathname)?.[1] ?? null
  } catch {
    return null
  }
}

/** One search/listing row. Null when it carries no usable link. */
function toSManga(anchor: Element): SManga | null {
  const href = anchor.getAttribute('href')
  if (!href) return null

  const slug = slugFromHref(href)
  if (!slug) return null

  // The row's own thumbnail, which saves a request per card on the shelf.
  const row = anchor.closest('.row')
  const cover = row?.querySelector('img')?.getAttribute('src')

  return {
    url: seriesUrl(slug),
    title:
      anchor.getAttribute('title')?.trim() || anchor.textContent?.trim() || slug,
    status: 'unknown',
    thumbnailUrl: coverUrl(cover),
    initialized: false,
    memo: { slug },
  }
}

function parseDetails(doc: Document, slug: string): SManga {
  const title = doc.querySelector('h3.title')?.textContent?.trim()

  return {
    url: seriesUrl(slug),
    title: title || slug,
    author: infoValues(doc, 'Author').join(', ') || undefined,
    // The id, not `.desc-text`: that class also appears inside a `<style>`
    // block, and the id is what the site's own expand toggle targets.
    description: doc
      .querySelector('#novel-description-content')
      ?.textContent?.trim(),
    genre: infoValues(doc, 'Genre'),
    status: toStatus(infoValues(doc, 'Status')[0]),
    thumbnailUrl: coverUrl(
      doc.querySelector('.books .book img')?.getAttribute('src'),
    ),
    initialized: true,
    memo: { slug },
  }
}

/**
 * The full chapter list, from `/ajax/chapter-option`.
 *
 * Each `<option>` carries the chapter key in `chapter-id` and the absolute URL
 * in `value`; the text is indented markup, so it has to be trimmed.
 */
function readOptionChapters(doc: Document, slug: string): SChapter[] {
  const chapters: SChapter[] = []

  for (const option of [...doc.querySelectorAll('select > option[value]')]) {
    const key =
      option.getAttribute('chapter-id')?.trim() ||
      (option.getAttribute('value') ?? '').split('/').filter(Boolean).pop() ||
      ''
    if (!key || key === slug) continue

    chapters.push(toChapter(option, key, slug, chapters.length + 1))
  }

  return chapters
}

/**
 * The handful of chapters the series page ships.
 *
 * They live in `template[data-first-chapter-template]`, whose contents are
 * inert — reachable only through `template.content`, never a plain query on the
 * document.
 */
function readTemplateChapters(doc: Document, slug: string): SChapter[] {
  const template = doc.querySelector<HTMLTemplateElement>('template[data-first-chapter-template]')
  if (!template?.content) return []

  const chapters: SChapter[] = []

  for (const item of [
    ...template.content.querySelectorAll('li[data-chapter-item]'),
  ]) {
    const key = item.getAttribute('data-chapter-id')?.trim()
    if (!key || key === slug) continue

    chapters.push(
      toChapter(item.querySelector('a') ?? item, key, slug, chapters.length + 1),
    )
  }

  return chapters
}

function toChapter(
  node: Element,
  key: string,
  slug: string,
  chapterNumber: number,
): SChapter {
  return {
    url: `${seriesUrl(slug)}/chapter/${key}`,
    name:
      node.getAttribute('title')?.trim() || node.textContent?.trim() || key,
    chapterNumber,
    memo: { slug },
  }
}

/**
 * A cover, pinned to one size.
 *
 * The series page serves `/novel/<slug>.jpg` and the listing rows the smaller
 * `/novel_200_89/<slug>.jpg`. They are pinned to the listing variant so a
 * series does not appear to change cover when its details load, which would
 * rewrite the stored row for nothing.
 */
function coverUrl(cover?: string | null): string | undefined {
  const path = cover?.trim()
  if (!path) return undefined

  try {
    const url = new URL(path, COVER_HOST)
    url.pathname = url.pathname.replace(/^\/novel\//, '/novel_200_89/')
    return url.toString()
  } catch {
    return undefined
  }
}

/**
 * Values from one row of the series page's info block.
 *
 * The block is a list of `li`s each headed by an `h3` — "Author:", "Genre:",
 * "Status:" — with the tag row nested one level deeper, so `div` is accepted
 * alongside.
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

    // "Publishers:" is plain text rather than a link.
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
    values: LIST_VALUES.map(([label]) => label),
    state: { index: 0, ascending: false },
  }
}

function selectFilter(
  name: string,
  values: readonly (readonly [string, string])[],
): Filter {
  return { type: 'select', name, values: values.map(([label]) => label), state: 0 }
}

function genreOf(filters: FilterList): string {
  for (const filter of filters) {
    if (filter.type !== 'select' || filter.name !== 'Genre') continue
    return GENRE_VALUES[filter.state]?.[1] ?? ''
  }
  return ''
}

function orderOf(filters: FilterList): string {
  for (const filter of filters) {
    if (filter.type !== 'select' || filter.name !== 'Order') continue
    return ORDER_VALUES[filter.state]?.[1] ?? ''
  }
  return ''
}

function listingOf(filters: FilterList): string {
  for (const filter of filters) {
    if (filter.type !== 'sort') continue
    return LIST_VALUES[filter.state.index]?.[1] ?? 'sort/updates'
  }
  return 'sort/updates'
}
