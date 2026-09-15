import { DirectFetchTransport, RateLimiter } from '../../transport/direct-fetch'
import type { HttpTransport } from '../../transport/types'
import { sanitizeChapterHtml } from '../../text/sanitize'
import type {
  ChapterDto,
  ChapterListEntryDto,
  SeriesDto,
  SeriesListResponse,
  TaxonomyDto,
  TiptapNode,
} from './dto'
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
const SITE_URL = 'https://fenrirealm.com'

/**
 * Where requests actually go.
 *
 * Fenrir Realm's API sends no `Access-Control-Allow-Origin` — checked with an
 * explicit `Origin` header on the listing endpoint, which answers 200 with no
 * CORS header at all. So, as with NovelFull and Mangadot, everything is routed
 * through the app's own origin under `/fenrirealm`, which the Worker proxies
 * (see src/routes/fenrirealm.$.ts): a same-origin request is never subject to
 * a CORS check.
 *
 * Outside a browser there is no such restriction and no proxy to speak to, so
 * the site is addressed directly. Unlike the scraping sources this one has no
 * DOM dependency of its own, so it runs under Node as-is — see
 * scripts/smoke-fenrirealm.ts.
 */
function resolveApiBase(): string {
  if (typeof location === 'undefined') return SITE_URL
  return new URL('/fenrirealm', location.origin).toString()
}

/**
 * One request a second.
 *
 * The site rate-limits: a burst of unspaced requests earns a 429, while 24
 * requests at roughly 1.3/s were all served (measured 2026-08-27). One a
 * second sits under that with room to spare, which matters more here than for
 * a source read directly — every user's traffic converges on whichever host
 * runs the proxy, so the site sees one IP rather than many.
 */
const RATE_LIMIT_PERMITS = 1
const RATE_LIMIT_PERIOD_MS = 1000

/** Enough to fill a shelf without asking for a page nobody scrolls to. */
const PER_PAGE = 24

/**
 * Listing orders, verified against the live endpoint.
 *
 * The site's own bundle also offers `views`, `rating` and `new`; all three are
 * rejected by the deployed API with "The selected sort is invalid.", so they
 * are deliberately absent.
 */
const SORT_VALUES = [
  ['Popular', 'popular'],
  ['Latest', 'latest'],
  ['Recently updated', 'updated'],
  ['Free only', 'free'],
  ['Premium', 'premium'],
] as const

/**
 * Publication states. Note `on-going`, hyphenated — `ongoing` is rejected,
 * and an invalid value is a 400 rather than an unfiltered page.
 */
const STATUS_VALUES = [
  ['Any', ''],
  ['Ongoing', 'on-going'],
  ['Completed', 'completed'],
  ['On hiatus', 'hiatus'],
  ['Dropped', 'dropped'],
] as const

/** Everything here is prose; this separates translations from originals. */
const TYPE_VALUES = [
  ['Any', ''],
  ['Novel', 'novel'],
  ['Light novel', 'light_novel'],
  ['Web novel', 'web_novel'],
] as const

interface FenrirFilterData {
  genres: TaxonomyDto[]
}

/**
 * Fenrir Realm.
 *
 * A JSON source rather than a scrape: the site is SvelteKit and renders its
 * listings client-side from a public, unauthenticated REST API under
 * `/api/new/v2`, which is what this reads. The shapes were taken from the
 * site's own route chunks and checked against live responses; see ./dto.ts.
 *
 * Two things about the site shape the code more than the endpoints do:
 *
 *  - **Chapter bodies are booby-trapped.** Every body carries a `<style>` rule
 *    naming a class that changes per request, and `aria-hidden` blocks of hash
 *    garbage between the paragraphs, plus zero-width characters sprinkled
 *    through the prose. `sanitizeChapterHtml` drops the `<style>` but keeps the
 *    `div`s — it has no way to know they are decoys — so they are stripped here
 *    first. See `stripDecoys`.
 *
 *  - **Premium chapters answer 200 with a teaser.** Reading `content` without
 *    checking the lock first would show two paragraphs as if they were the
 *    chapter. See `isLocked`.
 */
export class FenrirRealm implements Source {
  readonly id = 'fenrirealm'
  readonly name = 'Fenrir Realm'
  readonly lang = 'en'
  readonly baseUrl = SITE_URL
  readonly contentRating = 'safe'
  readonly versionCode = 1
  readonly contentKind = 'novel' as const
  readonly supportsLatest = true
  readonly isLocal = false
  readonly supportsFilterFetching = true
  readonly supportsRelatedMangas = false

  /**
   * Nothing to pace. This applies to page images, which the service worker
   * fetches outside the source's limiter; chapters are fetched here.
   */
  readonly pageFetchIntervalMs = 0

  private readonly http: HttpTransport
  private readonly apiBase: string

  /**
   * Genre name to genre id, learned from the taxonomy.
   *
   * The `genres[]` parameter takes ids and rejects a slug outright ("The
   * genres.0 field must be an integer"), but a `checkbox` filter carries only
   * a name — the app renders the sheet generically and has nowhere to keep a
   * value. So the mapping is remembered here, filled from whichever of
   * `fetchFilterData` or `getFilterList` sees the taxonomy first. Both run
   * before any search: the browse route builds the filter list from the
   * fetched data and only then hands it back to `getSearchMangaList`.
   */
  private readonly genreIds = new Map<string, number>()

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
    return this.listing(new URLSearchParams({ sort: 'popular' }), page, signal)
  }

  getLatestUpdates(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.listing(new URLSearchParams({ sort: 'updated' }), page, signal)
  }

  async getSearchMangaList(
    page: number,
    query: string,
    filters: FilterList,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const params = paramsFrom(filters, this.genreIds)
    const term = query.trim()
    if (term) params.set('search', term)
    return await this.listing(params, page, signal)
  }

  private async listing(
    params: URLSearchParams,
    page: number,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    params.set('page', String(page))
    params.set('per_page', String(PER_PAGE))

    const res = await this.http.fetch({
      url: `${this.apiBase}/api/new/v2/series?${params.toString()}`,
      signal,
    })
    const body = await res.json<SeriesListResponse>()

    const meta = body.meta
    return {
      mangas: (body.data ?? []).map((dto) => this.toSManga(dto)),
      // The paginator is authoritative; a full page of twenty-four is not,
      // since a catalogue whose size is a multiple of the page size ends on a
      // full page.
      hasNextPage: meta ? meta.current_page < meta.last_page : false,
    }
  }

  // -------------------------------------------------------------- details --

  async getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
    signal?: AbortSignal,
  ): Promise<MangaUpdate> {
    const slug = slugOf(manga)

    // Sequential rather than concurrent on purpose: the limiter would space
    // these anyway, and issuing them in order keeps a cancelled details call
    // from leaving a chapter request in flight.
    const details = opts.fetchDetails
      ? await this.fetchSeries(slug, signal)
      : null

    const chapters = opts.fetchChapters
      ? await this.fetchChapters(slug, signal)
      : []

    return { manga: details ? this.toSManga(details) : manga, chapters }
  }

  private async fetchSeries(
    slug: string,
    signal?: AbortSignal,
  ): Promise<SeriesDto> {
    const res = await this.http.fetch({
      url: `${this.apiBase}/api/new/v2/series/${encodeURIComponent(slug)}`,
      signal,
    })
    return await res.json<SeriesDto>()
  }

  /**
   * The whole chapter list in one request.
   *
   * The endpoint takes no paging parameters and returns a bare array however
   * long the novel is — 896 entries for `absolute-regression` — in ascending
   * order, which is the order this hands back.
   */
  private async fetchChapters(
    slug: string,
    signal?: AbortSignal,
  ): Promise<SChapter[]> {
    const res = await this.http.fetch({
      url: `${this.apiBase}/api/new/v2/series/${encodeURIComponent(slug)}/chapters`,
      signal,
    })
    const body = await res.json<ChapterListEntryDto[]>()
    if (!Array.isArray(body)) return []

    return body.map((entry, index) => toSChapter(entry, slug, index))
  }

  // ----------------------------------------------------------------- text --

  getPageList(): Promise<Page[]> {
    // `contentKind` is 'novel', so nothing should reach this. Throwing beats
    // returning [] silently, which would show as an empty chapter.
    return Promise.reject(
      new Error(
        'Fenrir Realm serves novels; chapters are read as text, not pages.',
      ),
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

  chapterTextUrl(_manga: SManga, chapter: SChapter): string {
    return `${this.apiBase}/api/new/v2/chapters/${chapterIdOf(chapter)}`
  }

  parseChapterText(payload: string): ChapterText {
    const body = JSON.parse(payload) as ChapterDto

    if (isLocked(body.locked)) {
      throw new Error(
        'This chapter is still premium on Fenrir Realm. Premium chapters unlock for free over time; this one has not yet.',
      )
    }

    const raw = body.content ?? ''
    if (!raw.trim()) {
      throw new Error('Fenrir Realm returned an empty chapter body.')
    }

    const html =
      body.content_format === 'json' ? tiptapToHtml(raw) : stripDecoys(raw)

    const text = sanitizeChapterHtml(html)
    if (!text.html.trim()) {
      throw new Error('Fenrir Realm returned a chapter with no readable text.')
    }
    return text
  }

  // -------------------------------------------------------------- filters --

  /**
   * The genre taxonomy, which the site exposes as its own endpoint.
   *
   * Tags are deliberately left out: `/taxonomies/tags` is several hundred
   * entries of long-tail trope vocabulary, which makes an unusable filter
   * sheet, and the `genres[]` parameter is the one the site's own browse page
   * leads with.
   */
  async fetchFilterData(): Promise<FenrirFilterData> {
    try {
      const res = await this.http.fetch({
        url: `${this.apiBase}/api/new/v2/taxonomies/genres`,
      })
      const genres = await res.json<TaxonomyDto[]>()
      if (Array.isArray(genres)) {
        this.rememberGenres(genres)
        return { genres }
      }
    } catch {
      // A filter sheet without genres still sorts and filters by status.
    }
    return { genres: [] }
  }

  getFilterList(data?: unknown): FilterList {
    const genres = (data as FenrirFilterData | undefined)?.genres ?? []
    this.rememberGenres(genres)

    return [
      {
        type: 'sort',
        name: 'Order',
        values: SORT_VALUES.map(([label]) => label),
        state: { index: 0, ascending: false },
      },
      selectFilter('Status', STATUS_VALUES),
      selectFilter('Type', TYPE_VALUES),
      {
        type: 'group',
        name: 'Genres',
        state: genres.map((genre) => ({
          type: 'checkbox' as const,
          name: genre.name,
          state: false,
        })),
      },
    ]
  }

  private rememberGenres(genres: TaxonomyDto[]): void {
    for (const genre of genres) {
      if (genre.name && Number.isInteger(genre.id)) {
        this.genreIds.set(genre.name, genre.id)
      }
    }
  }

  // ----------------------------------------------------------------- urls --

  getMangaWebUrl(manga: SManga): string {
    return `${SITE_URL}/series/${slugOf(manga)}`
  }

  /**
   * The site addresses a chapter by its *slug* ("896"), not by the numeric id
   * this source keys on. The id still resolves — the site answers it with a
   * 303 to the canonical path — so the memo is preferred and the id is the
   * fallback for a chapter rebuilt from its route key alone.
   */
  getChapterWebUrl(manga: SManga, chapter: SChapter): string {
    const memoSlug = chapter.memo?.chapterSlug
    const key =
      typeof memoSlug === 'string' && memoSlug ? memoSlug : chapterIdOf(chapter)
    return `${SITE_URL}/series/${slugOf(manga)}/${key}`
  }

  // -------------------------------------------------------------- helpers --

  private toSManga(dto: SeriesDto): SManga {
    return {
      // `/series/<slug>` rather than the site's own path shape: the app's route
      // params are the trailing segments of these urls, and the reader rebuilds
      // a series from the slug alone, so every source uses this shape.
      url: `/series/${dto.slug}`,
      title: dto.title,
      // The API publishes no author, only the translation group. Naming it here
      // is what puts it on the series page, where it is the useful attribution.
      author: dto.user?.username?.trim() || undefined,
      description: htmlToText(dto.description ?? '') || undefined,
      genre: (dto.genres ?? []).map((genre) => genre.name),
      status: toStatus(dto.status),
      thumbnailUrl: this.coverUrl(dto.cover),
      // Listing and detail return the same shape, so a card arrives complete
      // and the app has no reason to re-fetch it.
      initialized: true,
      memo: { slug: dto.slug },
    }
  }

  /**
   * A cover, resized by the site and fetched through the proxy.
   *
   * Paths arrive unprefixed (`storage/161/….png`). The size parameters are the
   * site's own: a full-resolution cover is several hundred kilobytes and is
   * drawn into a shelf tile either way.
   */
  private coverUrl(cover?: string | null): string | undefined {
    const path = cover?.trim()
    if (!path) return undefined
    if (/^https?:\/\//i.test(path)) return path
    return `${this.apiBase}/${path.replace(/^\/+/, '')}?width=300&height=400`
  }
}

// ------------------------------------------------------------- conversion --

function slugOf(manga: SManga): string {
  const memoSlug = manga.memo?.slug
  if (typeof memoSlug === 'string' && memoSlug) return memoSlug
  return manga.url.replace(/^\/series\//, '').replace(/\/$/, '')
}

/**
 * The numeric chapter id, from the memo when there is one and from the url
 * otherwise.
 *
 * The reader builds its chapter stub from the route key alone and so has no
 * memo to offer, which is why the url has to remain sufficient on its own.
 */
function chapterIdOf(chapter: SChapter): number {
  const memoId = chapter.memo?.id
  if (typeof memoId === 'number' && Number.isInteger(memoId)) return memoId

  const key = chapter.url.split('/').pop() ?? ''
  const parsed = Number(key)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Not a Fenrir Realm chapter url: ${chapter.url}`)
  }
  return parsed
}

/**
 * One chapter list entry.
 *
 * The url is keyed on the numeric id rather than on the site's chapter slug:
 * the id is what `/api/new/v2/chapters/{id}` takes, and it is stable, whereas
 * the slug is a renumberable display string. The slug rides along in the memo
 * so "open in browser" can still produce the canonical link.
 */
function toSChapter(
  entry: ChapterListEntryDto,
  slug: string,
  index: number,
): SChapter {
  // `name` routinely arrives with a leading space, and is occasionally empty
  // on bulk-imported chapters, where `title` carries the text instead.
  const name =
    entry.name?.trim() ||
    entry.title?.trim() ||
    `Chapter ${entry.number ?? index + 1}`

  return {
    url: `/series/${slug}/chapter/${entry.id}`,
    name,
    // Position in the list is the fallback, not the primary: the site numbers
    // its own chapters and those numbers are what a tracker expects to see.
    chapterNumber: typeof entry.number === 'number' ? entry.number : index + 1,
    dateUpload: toTimestamp(entry.created_at),
    scanlator: entry.user?.username?.trim() || undefined,
    memo: { id: entry.id, chapterSlug: entry.slug, slug },
  }
}

/**
 * Whether a chapter is still behind the paywall.
 *
 * Price alone is not the test. Every premium chapter becomes free eventually,
 * and when it does the site sets `unlocked_at` and leaves the price in place
 * as a record of what it used to cost — so reading price alone would refuse
 * most of the back catalogue of any paid novel.
 */
function isLocked(lock: ChapterDto['locked']): boolean {
  return Boolean(lock && (lock.price ?? 0) > 0 && !lock.unlocked_at)
}

function toTimestamp(value?: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function toStatus(raw?: string | null): MangaStatus {
  switch (raw?.trim().toLowerCase()) {
    case 'ongoing':
    case 'on-going':
      return 'ongoing'
    case 'completed':
      return 'completed'
    case 'hiatus':
      return 'on_hiatus'
    case 'dropped':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

// ------------------------------------------------------------ chapter text --

/**
 * Characters the site injects mid-sentence to watermark copied text.
 *
 * Invisible in the reader, but they inflate the text length behind the reading
 * estimate and break any search over the saved prose, so they go before the
 * fragment is measured. One chapter measured 1918 zero-width spaces and 1698
 * zero-width non-joiners.
 */
const INVISIBLE_CHARS = /[\u00ad\u200b-\u200f\u2060\ufeff]/g

/** `<style>…</style>`, whose rule hides the decoy blocks below. */
const STYLE_BLOCK = /<style\b[^>]*>[\s\S]*?<\/style>/gi

/**
 * A decoy block, matched on `aria-hidden` rather than on its class.
 *
 * The class name is regenerated per request (`c680ed6646416` one call,
 * `c937…` the next), so nothing may key on it. `aria-hidden="true"` is both
 * stable and correct on the merits: it is the site declaring the block is not
 * for a reader.
 */
const HIDDEN_BLOCK =
  /<(\w+)\b[^>]*\baria-hidden\s*=\s*["']?true["']?[^>]*>[\s\S]*?<\/\1\s*>/gi

/**
 * Removes the anti-scraping furniture from a chapter body.
 *
 * Deliberately string-level rather than DOM-level: `sanitizeChapterHtml` falls
 * back to stripping tags when there is no `DOMParser`, so a DOM-based version
 * of this would silently do nothing under Node and leave the smoke script
 * asserting against a case the browser never runs.
 */
function stripDecoys(html: string): string {
  let out = html.replace(STYLE_BLOCK, '')

  // Decoy blocks are not nested, but a non-greedy match consumes the run
  // between two of them if one is malformed, so the pass repeats until it
  // stops finding any. Bounded, because each pass strictly shortens the input.
  for (let pass = 0; pass < 3; pass += 1) {
    const next = out.replace(HIDDEN_BLOCK, '')
    if (next === out) break
    out = next
  }

  return out.replace(INVISIBLE_CHARS, '')
}

/** Inline marks, mapped to the tags `sanitizeChapterHtml` keeps. */
const MARK_TAGS: Record<string, string> = {
  bold: 'strong',
  strong: 'strong',
  italic: 'em',
  em: 'em',
  underline: 'u',
  strike: 's',
  strikethrough: 's',
  code: 'code',
  superscript: 'sup',
  subscript: 'sub',
}

/** Block nodes, mapped the same way. */
const BLOCK_TAGS: Record<string, string> = {
  paragraph: 'p',
  blockquote: 'blockquote',
  bulletList: 'ul',
  orderedList: 'ol',
  listItem: 'li',
  codeBlock: 'pre',
}

/**
 * Renders the TipTap document served when `content_format` is `json`.
 *
 * Older chapters use this format; current ones are HTML. The root node arrives
 * typed `systemWindow` rather than `doc`, and the site's editor keeps growing
 * node types, so an unrecognised node renders its children rather than being
 * dropped — losing a paragraph of prose to an unknown wrapper would be far
 * worse than emitting it unstyled.
 *
 * Everything is escaped on the way out and the result still goes through
 * `sanitizeChapterHtml`, so this builds no trusted markup.
 */
function tiptapToHtml(raw: string): string {
  let doc: TiptapNode
  try {
    doc = JSON.parse(raw) as TiptapNode
  } catch {
    // Mislabelled bodies are likelier than corrupt ones; treat it as HTML.
    return stripDecoys(raw)
  }

  return stripDecoys(renderNodes(doc.content ?? []))
}

function renderNodes(nodes: TiptapNode[]): string {
  return nodes.map(renderNode).join('')
}

function renderNode(node: TiptapNode): string {
  if (node.type === 'text') return renderText(node)
  if (node.type === 'hardBreak') return '<br>'
  if (node.type === 'horizontalRule') return '<hr>'

  if (node.type === 'image') {
    const src = typeof node.attrs?.src === 'string' ? node.attrs.src : ''
    if (!src) return ''
    const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : ''
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`
  }

  const children = renderNodes(node.content ?? [])

  if (node.type === 'heading') {
    const level = Number(node.attrs?.level)
    const tag = level >= 1 && level <= 6 ? `h${level}` : 'h3'
    return `<${tag}>${children}</${tag}>`
  }

  const tag = node.type ? BLOCK_TAGS[node.type] : undefined
  if (!tag) return children

  // An empty paragraph is the site's own blank line between passages, and the
  // reader's `p` spacing reproduces it; dropping it would run the prose
  // together.
  return `<${tag}>${children}</${tag}>`
}

function renderText(node: TiptapNode): string {
  let html = escapeHtml(node.text ?? '')

  for (const mark of node.marks ?? []) {
    if (mark.type === 'link') {
      const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : ''
      // The sanitiser vets the scheme and adds `rel`/`target`; a link with no
      // href would only be unwrapped there, so it is skipped here.
      if (href) html = `<a href="${escapeHtml(href)}">${html}</a>`
      continue
    }

    const tag = mark.type ? MARK_TAGS[mark.type] : undefined
    if (tag) html = `<${tag}>${html}</${tag}>`
  }

  return html
}

/**
 * An HTML fragment reduced to the plain text the series page renders.
 *
 * Descriptions arrive as markup but are shown in a `whitespace-pre-line`
 * paragraph, so block boundaries become newlines and everything else goes.
 * Regex rather than `DOMParser` for the same reason as `stripDecoys`.
 */
function htmlToText(html: string): string {
  return html
    .replace(STYLE_BLOCK, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    // Last, so an escaped entity in the source does not decode twice.
    .replace(/&amp;/gi, '&')
    .replace(INVISIBLE_CHARS, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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
 * Only values the user moved off the default are sent: the API rejects an
 * unrecognised `status` or `type` outright, and an empty one is not a value it
 * recognises.
 */
function paramsFrom(
  filters: FilterList,
  genreIds: ReadonlyMap<string, number>,
): URLSearchParams {
  const params = new URLSearchParams()
  params.set('sort', 'popular')

  for (const filter of filters) {
    if (filter.type === 'sort' && filter.name === 'Order') {
      params.set('sort', SORT_VALUES[filter.state.index]?.[1] ?? 'popular')
      continue
    }

    if (filter.type === 'select' && filter.name === 'Status') {
      const value = STATUS_VALUES[filter.state]?.[1]
      if (value) params.set('status', value)
      continue
    }

    if (filter.type === 'select' && filter.name === 'Type') {
      const value = TYPE_VALUES[filter.state]?.[1]
      if (value) params.set('type', value)
      continue
    }

    if (filter.type === 'group' && filter.name === 'Genres') {
      for (const child of filter.state) {
        if (child.type !== 'checkbox' || !child.state) continue
        // The parameter takes ids, but the filter sheet only carries names, so
        // the id is recovered from the taxonomy the sheet was built from. A
        // name with no id — a hand-edited filter URL — is dropped rather than
        // sent, since the API 400s on a non-integer and would fail the search
        // outright.
        const id = genreIds.get(child.name)
        if (id !== undefined) params.append('genres[]', String(id))
      }
    }
  }

  return params
}
