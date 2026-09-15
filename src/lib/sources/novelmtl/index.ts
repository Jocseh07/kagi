import { DirectFetchTransport, RateLimiter } from '../../transport/direct-fetch'
import type { HttpTransport } from '../../transport/types'
import { sanitizeChapterHtml } from '../../text/sanitize'
import type { NovelDto, NovelListResponse, PageDto } from './dto'
import type {
  ChapterText,
  Filter,
  FilterList,
  MangaUpdate,
  MangasPage,
  Page,
  SChapter,
  SManga,
  Source,
} from '../types'

/**
 * Where the site lives, and what "open in browser" must point at.
 *
 * `novelmtl.com` is the name people know; it 302s to `.app`, which is the
 * origin everything is actually served from. Pointing at the canonical host
 * directly saves a redirect on every single request.
 */
const SITE_URL = 'https://novelmtl.app'

/**
 * Where requests actually go.
 *
 * NovelMTL sends no `Access-Control-Allow-Origin` on either half of what this
 * source reads — the JSON API and the server-rendered novel page are both
 * refused to a browser. So, as with NovelFull and Fenrir Realm, everything is
 * routed through the app's own origin under `/novelmtl`, which the Worker
 * proxies (see src/routes/novelmtl.$.ts): a same-origin request is never
 * subject to a CORS check at all.
 *
 * Outside a browser there is no such restriction and no proxy to speak to, so
 * the site is addressed directly. Nothing here needs a DOM — the novel page is
 * read through its hydration blob rather than parsed — so this source runs
 * under Node as-is.
 */
function resolveApiBase(): string {
  if (typeof location === 'undefined') return SITE_URL
  return new URL('/novelmtl', location.origin).toString()
}

/**
 * NovelMTL publishes no rate limit and did not 429 across roughly forty
 * requests while this source was written.
 *
 * Two a second matches NovelFull's reasoning rather than that measurement,
 * and it matters more here than for a source read directly: every user's
 * traffic converges on whichever host runs the proxy, so the site sees one IP
 * rather than many.
 */
const RATE_LIMIT_PERMITS = 2
const RATE_LIMIT_PERIOD_MS = 1000

/**
 * The API's own page size, not a preference.
 *
 * `limit` is accepted but `next_cursor` is a row offset, so the two have to
 * agree or pagination skips rows. Twenty is what the endpoint returns unasked.
 */
const PER_PAGE = 20

/**
 * Listing orders, verified against the live endpoint.
 *
 * The value is what `sortBy` takes; a bare `clicks` without the direction
 * suffix is a 400 rather than an unsorted page, so these are not guesses.
 * The site's own home page uses exactly these two, labelled "Recommend" and
 * "New today".
 */
const SORT_VALUES = [
  ['Popular', 'clicks_desc'],
  ['Latest', 'created_desc'],
] as const

/**
 * NovelMTL.
 *
 * A JSON source rather than a scrape. The site is a Quasar app with server-side
 * rendering, and it reads from an internal REST API under `/api/novels` that
 * needs no key and no session — which is what this uses for listings, search
 * and chapter bodies alike.
 *
 * Three things about the site shape the code more than the endpoints do:
 *
 *  - **There are no covers.** Not "sometimes missing" — the novel record has no
 *    cover field anywhere in the API or the page state, and the site renders
 *    its own shelves as text. So every `SManga` here has no `thumbnailUrl`, and
 *    the library grid will show this source's entries as titles on blank tiles.
 *    Nothing can be done about that from here.
 *
 *  - **A single novel cannot be fetched by slug.** `/api/novels/<slug>` is a
 *    404, a `slug=` filter on the listing is ignored, and the rendered novel
 *    page 302s to a percent-encoded path that 404s. The API only lists and
 *    searches, so `getMangaUpdate` searches the title and matches the slug.
 *    See `findBySlug`.
 *
 *  - **Chapters are numbered, not named.** The API calls them pages and gives
 *    each only a `page_number`, so there is no title to carry across and the
 *    chapter list is derived from the novel's `page_count` rather than fetched.
 *    That makes a two-thousand-chapter novel free to list.
 *
 * Everything this source serves is machine translation, lifted from elsewhere
 * — each record keeps an `original_url` pointing at its upstream. That is the
 * site's nature, not a defect in the parsing.
 */
export class NovelMtl implements Source {
  readonly id = 'novelmtl'
  readonly name = 'NovelMTL'
  readonly lang = 'en'
  readonly baseUrl = SITE_URL
  /**
   * A general catalogue that also carries adult work: the site's own genre
   * taxonomy includes the usual adult and mature categories alongside
   * everything else, which is exactly the case `mixed` exists for.
   */
  readonly contentRating = 'mixed'
  readonly versionCode = 1
  readonly contentKind = 'novel' as const
  readonly supportsLatest = true
  readonly isLocal = false
  /** See the note on the class: the site has no cover art to serve. */
  readonly hasCovers = false
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
    return this.listing('clicks_desc', page, signal)
  }

  getLatestUpdates(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.listing('created_desc', page, signal)
  }

  async getSearchMangaList(
    page: number,
    query: string,
    filters: FilterList,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const term = query.trim()
    if (!term) return await this.listing(sortOf(filters), page, signal)

    const url = new URL(`${this.apiBase}/api/novels/search`)
    url.searchParams.set('q', term)
    applyCursor(url, page)
    return await this.fetchListing(url, signal)
  }

  private listing(
    sortBy: string,
    page: number,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const url = new URL(`${this.apiBase}/api/novels`)
    url.searchParams.set('sortBy', sortBy)
    applyCursor(url, page)
    return this.fetchListing(url, signal)
  }

  private async fetchListing(
    url: URL,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const res = await this.http.fetch({ url: url.toString(), signal })
    const body = await res.json<NovelListResponse>()

    const items = Array.isArray(body?.items) ? body.items : []

    return {
      mangas: items
        .map((item) => toSManga(item))
        .filter((manga): manga is SManga => manga !== null),
      // The cursor is authoritative; a full page of twenty is not, since a list
      // whose length is a multiple of the page size ends on a full page.
      hasNextPage: Boolean(body?.next_cursor),
    }
  }

  // -------------------------------------------------------------- details --

  /**
   * Details and chapters, without asking for a page that will not answer.
   *
   * There is no way to address one novel: `/api/novels/<slug>` is a 404, a
   * `slug=` filter on the listing is ignored outright (it answers with the
   * whole catalogue), and the rendered novel page now 302s to a percent-encoded
   * path that 404s — cached hits aside, which is the only reason it ever
   * appeared to work.
   *
   * So the record is found by searching for the novel's own title and matching
   * the slug exactly. That keeps `page_count` fresh, which is what makes new
   * chapters show up on a library update.
   *
   * When the search cannot place it, nothing is lost: a listing row already
   * carries every field this source shows, so the entry keeps the details it
   * was created with and the chapter count carried in `memo`.
   */
  async getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
    signal?: AbortSignal,
  ): Promise<MangaUpdate> {
    const slug = slugOf(manga)
    const found = await this.findBySlug(slug, manga.title, signal)

    const count = found?.page_count ?? pageCountOf(manga)
    if (!count) {
      throw new Error(
        'NovelMTL could not be asked about this novel: its search did not return it, and no chapter count was carried over from the listing.',
      )
    }

    const chapters = opts.fetchChapters ? toChapters(count, slug) : []
    if (!opts.fetchDetails || !found) return { manga, chapters }

    return { manga: toSManga(found) ?? manga, chapters }
  }

  /**
   * The one lookup by slug the API allows: search, then match.
   *
   * Only the first page of results is examined. A novel that its own title
   * cannot surface in twenty is not worth a second request — the caller falls
   * back to what the listing already knew.
   */
  private async findBySlug(
    slug: string,
    title: string,
    signal?: AbortSignal,
  ): Promise<NovelDto | null> {
    const term = searchable(title)
    if (!term) return null

    const url = new URL(`${this.apiBase}/api/novels/search`)
    url.searchParams.set('q', term)

    try {
      const res = await this.http.fetch({ url: url.toString(), signal })
      const body = await res.json<NovelListResponse>()
      const items = Array.isArray(body?.items) ? body.items : []
      return items.find((item) => item?.slug === slug) ?? null
    } catch {
      // A failed lookup is not a failed page; the fallback covers it.
      return null
    }
  }

  // ----------------------------------------------------------------- text --

  getPageList(): Promise<Page[]> {
    // `contentKind` is 'novel', so nothing should reach this. Throwing beats
    // returning [] silently, which would show as an empty chapter.
    return Promise.reject(
      new Error('NovelMTL serves novels; chapters are read as text, not pages.'),
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
   * The API route, not the reader route.
   *
   * `/novel/<slug>/read/<n>` is what a person opens, and the edge cache in
   * front of it has been seen holding a stale 302 back to a dead path for
   * individual chapters. The API path underneath it has no such entry and
   * hands back the prose without any markup to undo.
   */
  chapterTextUrl(manga: SManga, chapter: SChapter): string {
    const slug = slugOf(manga)
    const index = chapterIndexOf(chapter)
    if (!index) throw new Error('This chapter has no NovelMTL page number.')
    return `${this.apiBase}/api/novels/${encodeURIComponent(slug)}/pages/${index}`
  }

  parseChapterText(payload: string): ChapterText {
    const body = JSON.parse(payload) as PageDto

    const raw = body?.content ?? ''
    if (!raw.trim()) {
      throw new Error('NovelMTL returned an empty chapter body.')
    }

    const text = sanitizeChapterHtml(toParagraphs(raw))
    if (!text.html.trim()) {
      throw new Error('NovelMTL returned a chapter with no readable text.')
    }
    return text
  }

  // -------------------------------------------------------------- filters --

  getFilterList(): FilterList {
    return [sortFilter()]
  }

  // ----------------------------------------------------------------- urls --

  getMangaWebUrl(manga: SManga): string {
    return `${SITE_URL}/novel/${slugOf(manga)}`
  }

  getChapterWebUrl(manga: SManga, chapter: SChapter): string {
    return `${SITE_URL}/novel/${slugOf(manga)}/read/${chapterIndexOf(chapter)}`
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

/** The chapter's page number, taken from the tail of its url. */
function chapterIndexOf(chapter: SChapter): number {
  const tail = chapter.url.split('/').pop() ?? ''
  const parsed = Number.parseInt(tail, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * One novel record. Null when it carries no slug, which is the only field
 * without which nothing else can be addressed.
 *
 * No `thumbnailUrl` is set because there is nothing to set it from — see the
 * note on the class.
 */
function toSManga(dto: NovelDto | null | undefined): SManga | null {
  const slug = dto?.slug?.trim()
  if (!dto || !slug) return null

  return {
    url: seriesUrl(slug),
    title: dto.title?.trim() || slug,
    author: dto.author?.trim() || undefined,
    description: dto.description?.trim() || undefined,
    genre: Array.isArray(dto.genres)
      ? dto.genres.map((genre) => genre.trim()).filter(Boolean)
      : [],
    // The record carries no publication state at all, and a listing that is
    // sorted by recency is not evidence of one.
    status: 'unknown',
    initialized: true,
    // The chapter count rides along because a listing row is the only place
    // this source ever sees one for certain. `memo` is persisted, so an entry
    // in the library keeps it, and `getMangaUpdate` can fall back to it when
    // the search cannot place the novel again.
    memo: { slug, pageCount: dto.page_count ?? 0 },
  }
}

/**
 * Characters the search endpoint refuses.
 *
 * It answers 400 "Search query contains invalid characters" rather than
 * ignoring them, so a title carrying an apostrophe — and a great many do —
 * cannot be sent as written. Verified one character at a time against the live
 * endpoint; `!?.,:-` and `'`-free text are accepted.
 */
const SEARCH_REJECTS = /['";_()[\]{}&%$#@*+=/\\|<>~`^]/g

/**
 * A title the search endpoint will accept.
 *
 * Rejected characters become spaces rather than being deleted, because the
 * site's own slugs do the same: "Konoha's Hidden Boss" is
 * `konoha-s-hidden-boss`. Dropping the apostrophe instead would search for
 * "Konohas" and match nothing.
 */
function searchable(title: string): string {
  return title.replace(SEARCH_REJECTS, ' ').replace(/\s+/g, ' ').trim()
}

/** The chapter count a listing row left behind, if it is still there. */
function pageCountOf(manga: SManga): number {
  const stored = manga.memo?.pageCount
  return typeof stored === 'number' && Number.isFinite(stored) && stored > 0
    ? stored
    : 0
}

/**
 * The chapter list, derived rather than fetched.
 *
 * `page_count` is the whole list: chapter *n* is at page *n*, one-based. The
 * site gives chapters no titles, so the number is the name.
 */
function toChapters(count: number, slug: string): SChapter[] {
  if (!Number.isFinite(count) || count <= 0) return []

  const chapters: SChapter[] = []
  for (let index = 1; index <= count; index += 1) {
    chapters.push({
      url: `${seriesUrl(slug)}/chapter/${index}`,
      name: `Chapter ${index}`,
      chapterNumber: index,
      memo: { slug },
    })
  }
  return chapters
}

// ------------------------------------------------------------------- text --

/**
 * Chapter prose, which the API hands over as plain text.
 *
 * Blank-line-separated in places and single-newline-separated in others, so
 * every non-empty line becomes its own paragraph. The text is escaped on the
 * way in — it is not markup, and a stray `<` in the prose must not become one
 * — and the result still goes through `sanitizeChapterHtml`, which is what
 * measures it.
 */
function toParagraphs(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------- filters --

/** Page 1 is the endpoint's own default, so it is addressed by omission. */
function applyCursor(url: URL, page: number): void {
  if (page > 1) url.searchParams.set('cursor', String((page - 1) * PER_PAGE))
}

function sortFilter(): Filter {
  return {
    type: 'sort',
    name: 'Order',
    values: SORT_VALUES.map(([label]) => label),
    state: { index: 0, ascending: false },
  }
}

function sortOf(filters: FilterList): string {
  for (const filter of filters) {
    if (filter.type !== 'sort') continue
    return SORT_VALUES[filter.state.index]?.[1] ?? 'clicks_desc'
  }
  return 'clicks_desc'
}
