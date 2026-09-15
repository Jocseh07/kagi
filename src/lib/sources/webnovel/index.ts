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
const SITE_URL = 'https://www.webnovel.com'

/**
 * Covers, which are *not* proxied.
 *
 * Unlike the pages, this host answers with `access-control-allow-origin: *`,
 * so there is no CORS check to avoid and no reason to push several hundred
 * kilobytes of cover art through the Worker.
 */
const COVER_HOST = 'https://book-pic.webnovel.com'

/**
 * Where page requests actually go.
 *
 * Webnovel sends no `Access-Control-Allow-Origin` on its pages — checked with
 * an explicit `Origin` header on a book page, which answers 200 with no CORS
 * header at all. So, as with NovelFull and Fenrir Realm, everything is routed
 * through the app's own origin under `/webnovel`, which the Worker proxies
 * (see src/routes/webnovel.$.ts): a same-origin request is never subject to a
 * CORS check.
 *
 * Outside a browser there is no such restriction and no proxy to speak to, so
 * the site is addressed directly. Note that a scraping source still cannot run
 * under Node without a DOM — see the note on `fetchDocument` below.
 */
function resolveApiBase(): string {
  if (typeof location === 'undefined') return SITE_URL
  return new URL('/webnovel', location.origin).toString()
}

/**
 * One request a second.
 *
 * The site publishes no rate limit, and it sits behind Cloudflare. One a
 * second matters more here than for a source read directly: every user's
 * traffic converges on whichever host runs the proxy, so the site sees one IP
 * rather than many. The catalogue page for a long novel is also close to two
 * megabytes, which is not a request to issue in bursts.
 */
const RATE_LIMIT_PERMITS = 1
const RATE_LIMIT_PERIOD_MS = 1000

/** Rows the site returns per page, on both the browse list and search. */
const PAGE_SIZE = 20

/**
 * Listing orders, taken from the browse form's own `orderBy` radios and
 * verified against the live endpoint.
 */
const SORT_VALUES = [
  ['Popular', '1'],
  ['Recommended', '2'],
  ['Most collections', '3'],
  ['Rating', '4'],
  ['Time updated', '5'],
] as const

/** `bookStatus`, same source. `0` is the site's own default and is omitted. */
const STATUS_VALUES = [
  ['Any', ''],
  ['Ongoing', '1'],
  ['Completed', '2'],
] as const

/**
 * `sourceType`. Everything here is prose; this separates novels translated
 * from Chinese from those written on the platform in English.
 */
const TYPE_VALUES = [
  ['Any', ''],
  ['Translated', '1'],
  ['Original', '2'],
] as const

/**
 * Webnovel.
 *
 * A scrape rather than a JSON source, and deliberately so. The site still
 * exposes `/go/pcm/chapter/get-chapter-list`, but it now answers with
 * `{"encryptType":1,"encryptKeyPool":"…","content":"<base64>"}` — reading it
 * would mean reimplementing the obfuscated `fock.js` the site loads for the
 * purpose. Every page this source reads renders the same data server-side in
 * the clear, needs no cookie and no `_csrfToken`, and is addressable by
 * numeric id with no redirect.
 *
 * Two things about the site shape the code more than the endpoints do:
 *
 *  - **Paid chapters answer 200 with a teaser.** Three paragraphs, inside a
 *    `.cha-content._lock`. Reading `.cha-words` without checking the lock
 *    first would show that as if it were the chapter. See `parseChapterText`.
 *
 *  - **There is no paginator in the markup.** The site builds its own
 *    client-side, and the search page's "About 1,000 results" is not a bound
 *    — page 50 of a search still returns twenty rows. See `hasNextPage`.
 */
export class Webnovel implements Source {
  readonly id = 'webnovel'
  readonly name = 'Webnovel'
  readonly lang = 'en'
  readonly baseUrl = SITE_URL
  /**
   * A general catalogue that also hosts adult work, which is what `mixed`
   * means. The site publishes no adult *genre*, so this was checked rather
   * than assumed: a search for "erotic" returns a full page of titles sold
   * as such, alongside everything else.
   */
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
    return this.listing(new URLSearchParams({ orderBy: '1' }), page, signal)
  }

  getLatestUpdates(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.listing(new URLSearchParams({ orderBy: '5' }), page, signal)
  }

  async getSearchMangaList(
    page: number,
    query: string,
    filters: FilterList,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const term = query.trim()
    if (!term) return await this.listing(paramsFrom(filters), page, signal)

    // Search takes no filters of its own — the tabs beside the results split
    // novels from comics and fan-fic, not by status or sort — so the sheet is
    // deliberately ignored here rather than half-applied.
    const url = new URL(`${this.apiBase}/search`)
    url.searchParams.set('keywords', term)
    url.searchParams.set('pageIndex', String(page))

    const doc = await this.fetchDocument(url.toString(), signal)
    // Only the novels tab is server-rendered; the other two load by ajax, so
    // this cannot pick up a comic.
    return this.toPage(doc.querySelectorAll('ul.ser-ret > li'))
  }

  private async listing(
    params: URLSearchParams,
    page: number,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    params.set('pageIndex', String(page))

    const doc = await this.fetchDocument(
      `${this.apiBase}/stories/novel?${params.toString()}`,
      signal,
    )
    return this.toPage(doc.querySelectorAll('.j_category_wrapper li'))
  }

  /**
   * Rows to a page of results.
   *
   * `hasNextPage` is the full-page heuristic the other sources here go out of
   * their way to avoid, because Webnovel ships no paginator to read instead:
   * both lists are built client-side, and the result count the search page
   * prints is an estimate it happily paginates past. The heuristic terminates
   * correctly — a browse page beyond the end returns no rows at all, and a
   * search past the end returns a short page — at the cost of one empty final
   * page when a catalogue divides exactly by twenty.
   */
  private toPage(rows: NodeListOf<Element>): MangasPage {
    const mangas = [...rows]
      .map((row) => this.toSManga(row))
      .filter((manga): manga is SManga => manga !== null)

    return { mangas, hasNextPage: mangas.length >= PAGE_SIZE }
  }

  /** One browse or search row. Null when it carries no usable book link. */
  private toSManga(row: Element): SManga | null {
    const anchor = row.querySelector('h3 a[href*="/book/"]')
    const href = anchor?.getAttribute('href')
    if (!href) return null

    const identity = identityFromPath(href)
    if (!identity) return null

    // Browse lazy-loads its covers, so `src` there is a shared placeholder on
    // the site's static host and the real cover is in `data-original`. Search
    // loads them eagerly and only has `src`.
    const image = row.querySelector('img')
    const cover =
      image?.getAttribute('data-original') ?? image?.getAttribute('src')

    return {
      url: seriesUrl(identity.bookId),
      title: anchor?.getAttribute('title')?.trim() || identity.slug,
      description: row.querySelector('p.ells')?.textContent?.trim() || undefined,
      genre: tagsIn(row),
      status: 'unknown',
      thumbnailUrl: coverUrl(cover),
      // The row carries no author and no status, so the series page still has
      // a reason to fetch the book page.
      initialized: false,
      memo: identity,
    }
  }

  // -------------------------------------------------------------- details --

  async getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
    signal?: AbortSignal,
  ): Promise<MangaUpdate> {
    const bookId = bookIdOf(manga)

    // Two requests rather than one: the catalogue page repeats the book
    // header but carries neither the synopsis nor the tag list, so it cannot
    // stand in for the book page. Sequential rather than concurrent — the
    // limiter would space them anyway, and issuing them in order keeps a
    // cancelled details call from leaving a chapter request in flight.
    const details = opts.fetchDetails
      ? await this.fetchDetails(bookId, manga, signal)
      : null

    const chapters = opts.fetchChapters
      ? await this.fetchChapters(bookId, signal)
      : []

    return { manga: details ?? manga, chapters }
  }

  private async fetchDetails(
    bookId: string,
    previous: SManga,
    signal?: AbortSignal,
  ): Promise<SManga> {
    const doc = await this.fetchDocument(
      `${this.apiBase}/book/${encodeURIComponent(bookId)}`,
      signal,
    )

    const info = doc.querySelector('.det-info')
    const title = info?.querySelector('h1')?.textContent?.trim()
    const cover = info?.querySelector('.g_thumb img')?.getAttribute('src')

    // The headline genre is the category the book is filed under; the tags
    // below it are the rest. Both are worth carrying, the category first.
    const category = doc.querySelector('.det-hd-tag span')?.textContent?.trim()
    const tags = tagsIn(doc.body)

    return {
      url: seriesUrl(bookId),
      title: title || previous.title,
      author:
        info?.querySelector('address a')?.textContent?.trim() || undefined,
      description:
        doc.querySelector('.j_synopsis')?.textContent?.trim() || undefined,
      genre: category ? [category, ...tags.filter((t) => t !== category)] : tags,
      status: readStatus(doc),
      thumbnailUrl: coverUrl(cover) ?? previous.thumbnailUrl,
      initialized: true,
      // The slug is only needed to build a pretty "open in browser" link, and
      // a series reopened from a stored row has one where a reader stub does
      // not; keeping whichever we already had costs nothing.
      memo: { bookId, slug: slugOf(previous) },
    }
  }

  /**
   * The chapter list, from the table of contents.
   *
   * One request for the whole thing however long the novel is — every volume
   * is rendered server-side, which is why the encrypted ajax route is not
   * needed. It is not a small page: a three-thousand-chapter novel is close
   * to two megabytes of HTML.
   */
  private async fetchChapters(
    bookId: string,
    signal?: AbortSignal,
  ): Promise<SChapter[]> {
    const doc = await this.fetchDocument(
      `${this.apiBase}/book/${encodeURIComponent(bookId)}/catalog`,
      signal,
    )

    const chapters: SChapter[] = []

    // The site's own chapter numbers are what a tracker expects to see, so
    // they are preferred over position. Entries in the auxiliary volume carry
    // none, and falling back to position would collide with the numbered
    // chapters — the first auxiliary entry and chapter 1 would both be 1 —
    // so a numberless entry is placed just after the last numbered one
    // instead, the way a side story is conventionally numbered.
    let lastNumber = 0
    let gap = 0

    for (const row of doc.querySelectorAll('.volume-item li[data-cid]')) {
      const chapterId = row.getAttribute('data-cid')?.trim()
      const anchor = row.querySelector('a[href]')
      if (!chapterId || !anchor) continue

      const printed = Number(row.querySelector('._num')?.textContent?.trim())
      const numbered = Number.isFinite(printed) && printed > 0
      if (numbered) {
        lastNumber = printed
        gap = 0
      } else {
        gap += 1
      }

      chapters.push({
        url: chapterUrl(bookId, chapterId),
        name:
          row.querySelector('strong')?.textContent?.trim() ||
          anchor.getAttribute('title')?.trim() ||
          `Chapter ${chapterId}`,
        chapterNumber: numbered ? printed : lastNumber + gap / 100,
        dateUpload: relativeToTimestamp(
          row.querySelector('small')?.textContent,
        ),
        memo: {
          bookId,
          chapterSlug: slugFromChapterHref(anchor.getAttribute('href')),
          // The list marks paid chapters with a padlock. The chapter page is
          // the authority — `parseChapterText` checks it there — but carrying
          // the flag means nothing has to guess before the fetch.
          locked: isLockedRow(row),
        },
      })
    }

    return chapters
  }

  // ----------------------------------------------------------------- text --

  getPageList(): Promise<Page[]> {
    // `contentKind` is 'novel', so nothing should reach this. Throwing beats
    // returning [] silently, which would show as an empty chapter.
    return Promise.reject(
      new Error('Webnovel serves novels; chapters are read as text, not pages.'),
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

  /**
   * Both ids come from the urls rather than from the memo, because the reader
   * builds its chapter stub from the route params alone and so has no memo to
   * offer. The numeric form is addressable directly — the site answers
   * `/book/<bookId>/<chapterId>` with no redirect to the slug path.
   */
  chapterTextUrl(manga: SManga, chapter: SChapter): string {
    const bookId = bookIdOf(manga)
    const chapterId = chapterIdOf(chapter)
    return `${this.apiBase}/book/${encodeURIComponent(bookId)}/${encodeURIComponent(chapterId)}`
  }

  parseChapterText(raw: string): ChapterText {
    const doc = new DOMParser().parseFromString(raw, 'text/html')

    const content = doc.querySelector('.cha-content')
    if (!content) {
      throw new Error('Webnovel returned a page with no chapter body.')
    }

    // A paid chapter is served at status 200 with the first two or three
    // paragraphs in place, so the lock has to be read before the prose. Show
    // the teaser and it reads as a chapter that simply ends early.
    if (content.classList.contains('_lock')) {
      throw new Error(
        'This chapter is paid on Webnovel. Only the opening paragraphs are public, so it cannot be read here.',
      )
    }

    // `.cha-words` is the prose alone: the chapter heading sits above it and
    // the author's end note (`.m-thou`) below, both outside it.
    const body = content.querySelector('.cha-words')
    if (!body) {
      throw new Error('Webnovel returned a chapter with no readable text.')
    }

    const text = sanitizeChapterHtml(body.innerHTML)
    if (!text.html.trim()) {
      throw new Error('Webnovel returned an empty chapter body.')
    }
    return text
  }

  // -------------------------------------------------------------- filters --

  getFilterList(): FilterList {
    return [
      {
        type: 'sort',
        name: 'Order',
        values: SORT_VALUES.map(([label]) => label),
        state: { index: 0, ascending: false },
      },
      selectFilter('Status', STATUS_VALUES),
      selectFilter('Type', TYPE_VALUES),
    ]
  }

  // ----------------------------------------------------------------- urls --

  getMangaWebUrl(manga: SManga): string {
    return `${SITE_URL}/book/${slugOf(manga) || bookIdOf(manga)}`
  }

  /**
   * The site addresses a chapter by its slug path, but answers the numeric
   * form directly too, so the memo is preferred and the ids are the fallback
   * for a chapter rebuilt from its route key alone.
   */
  getChapterWebUrl(manga: SManga, chapter: SChapter): string {
    const book = slugOf(manga) || bookIdOf(manga)
    const memoSlug = chapter.memo?.chapterSlug
    const key =
      typeof memoSlug === 'string' && memoSlug ? memoSlug : chapterIdOf(chapter)
    return `${SITE_URL}/book/${book}/${key}`
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
}

// ------------------------------------------------------------- conversion --

function seriesUrl(bookId: string): string {
  return `/series/${bookId}`
}

function chapterUrl(bookId: string, chapterId: string): string {
  return `/series/${bookId}/chapter/${chapterId}`
}

/**
 * The numeric book id, from the url rather than the memo.
 *
 * `url` is half of `manga_source_url_unique` and the reader rebuilds a series
 * from its last segment, so the id has to be recoverable from the url alone.
 */
function bookIdOf(manga: SManga): string {
  const id = manga.url.replace(/^\/series\//, '').replace(/\/$/, '')
  if (!id) throw new Error(`Not a Webnovel series url: ${manga.url}`)
  return id
}

function chapterIdOf(chapter: SChapter): string {
  const id = chapter.url.split('/').pop() ?? ''
  if (!id) throw new Error(`Not a Webnovel chapter url: ${chapter.url}`)
  return id
}

/** The pretty slug, for "open in browser". Empty when we never saw one. */
function slugOf(manga: SManga): string {
  const memoSlug = manga.memo?.slug
  return typeof memoSlug === 'string' ? memoSlug : ''
}

/**
 * What a book path reduces to.
 *
 * `/book/shadow-slave_22196546206090805` carries both halves: the trailing
 * digits are the id every endpoint takes, and the whole segment is the
 * canonical link. The id is what identity is keyed on, because the slug is a
 * display string the site is free to renumber.
 */
function identityFromPath(
  href: string,
): { bookId: string; slug: string } | null {
  const path = href.split('?')[0]?.split('#')[0] ?? ''
  const slug = path.split('/').filter(Boolean).pop()
  if (!slug) return null

  const bookId = /^\d+$/.test(slug) ? slug : (slug.match(/_(\d+)$/)?.[1] ?? '')
  if (!bookId) return null

  return { bookId, slug }
}

/** The chapter's own slug segment, e.g. `nightmare-begins_59583457017254387`. */
function slugFromChapterHref(href: string | null): string | undefined {
  const segment = href?.split('?')[0]?.split('/').filter(Boolean).pop()
  return segment || undefined
}

/**
 * Genre tags on a row or a book page.
 *
 * The link text is shouted and hash-prefixed (`# ACTION`); its `title` is the
 * same tag written out (`Action Stories`), which is what belongs on a chip.
 */
function tagsIn(root: Element): string[] {
  const tags = [...root.querySelectorAll('a[href*="/tags/"]')]
    .map((anchor) => {
      const title = anchor.getAttribute('title')?.trim()
      if (title) return title.replace(/\s+Stories$/i, '')
      return anchor.textContent?.replace(/^#\s*/, '').trim() ?? ''
    })
    .filter(Boolean)

  return [...new Set(tags)]
}

/**
 * The publication state.
 *
 * A completed book renders a `Status` row in its header; an ongoing one
 * renders no such row at all, so absence cannot be read as "unknown" without
 * losing the common case. The page's inline `g_data` carries the same fact as
 * a number — 30 ongoing, 50 completed — and is the fallback.
 */
function readStatus(doc: Document): MangaStatus {
  for (const item of doc.querySelectorAll('.det-hd-detail strong')) {
    if (!item.querySelector('svg[title="Status"]')) continue
    return toStatus(item.textContent)
  }

  const action = doc.documentElement.innerHTML.match(/"actionStatus":(\d+)/)?.[1]
  if (action === '50') return 'completed'
  if (action === '30') return 'ongoing'
  return 'unknown'
}

function toStatus(raw?: string | null): MangaStatus {
  switch (raw?.trim().toLowerCase()) {
    case 'ongoing':
      return 'ongoing'
    case 'completed':
      return 'completed'
    default:
      return 'unknown'
  }
}

/** Whether a table-of-contents row carries the padlock that marks it paid. */
function isLockedRow(row: Element): boolean {
  return [...row.querySelectorAll('use')].some(
    (use) =>
      (use.getAttribute('xlink:href') ?? use.getAttribute('href')) ===
      '#i-lock',
  )
}

/**
 * A cover, normalised to one width and read from its own host.
 *
 * Paths arrive protocol-relative, and the width the site asks for depends on
 * which page the row came from — 150 on browse, 600 on the book page. They
 * are pinned to the same value so a series does not appear to change cover
 * when its details load, which would rewrite the stored row for nothing.
 */
function coverUrl(cover?: string | null): string | undefined {
  const path = cover?.trim()
  if (!path) return undefined

  // The lazy-load placeholder lives on the site's static host, not the cover
  // host, and is a grey box.
  if (!path.includes('book-pic.webnovel.com')) return undefined

  const absolute = path.startsWith('//') ? `https:${path}` : path
  try {
    const url = new URL(absolute, COVER_HOST)
    return url
      .toString()
      .replace(/imageMogr2\/thumbnail\/\d+x?/, 'imageMogr2/thumbnail/300x')
  } catch {
    return undefined
  }
}

/** Units the table of contents dates itself in, in milliseconds. */
const RELATIVE_UNITS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_536_000_000,
}

/**
 * "15 hours ago" as a timestamp.
 *
 * The table of contents publishes nothing else, so this is the only date
 * there is. It is coarse for old chapters — "4 years ago" lands on a day four
 * years back, not on the real one — and precise for recent ones, which is the
 * end the Updates screen actually reads.
 */
function relativeToTimestamp(raw?: string | null): number | undefined {
  const match = raw
    ?.trim()
    .toLowerCase()
    .match(/^(?:(\d+)|an?)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/)
  if (!match) return undefined

  const unit = RELATIVE_UNITS[match[2] ?? '']
  if (!unit) return undefined

  return Date.now() - (match[1] ? Number(match[1]) : 1) * unit
}

// ---------------------------------------------------------------- filters --

function selectFilter(
  name: string,
  values: readonly (readonly [string, string])[],
): Filter {
  return { type: 'select', name, values: values.map(([label]) => label), state: 0 }
}

/**
 * The query the filter sheet describes.
 *
 * Only values moved off the default are sent: the site treats an absent
 * parameter as "all", and its own form omits them the same way.
 */
function paramsFrom(filters: FilterList): URLSearchParams {
  const params = new URLSearchParams({ orderBy: '1' })

  for (const filter of filters) {
    if (filter.type === 'sort' && filter.name === 'Order') {
      params.set('orderBy', SORT_VALUES[filter.state.index]?.[1] ?? '1')
      continue
    }

    if (filter.type === 'select' && filter.name === 'Status') {
      const value = STATUS_VALUES[filter.state]?.[1]
      if (value) params.set('bookStatus', value)
      continue
    }

    if (filter.type === 'select' && filter.name === 'Type') {
      const value = TYPE_VALUES[filter.state]?.[1]
      if (value) params.set('sourceType', value)
    }
  }

  return params
}
