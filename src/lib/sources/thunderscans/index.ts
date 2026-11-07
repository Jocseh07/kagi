import { parseDocument } from '../../text/document'
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
import { appOrigin } from '../app-origin'

/**
 * Where the site lives, and what "open in browser" must point at.
 *
 * Note the hyphen. `thunderscans.com` and `en.thunderscans.com` are both parked
 * domains that answer 200 with a JavaScript redirect to an advertising lander —
 * probing either concludes the source is dead. `en-thunderscans.com` is what
 * the Keiyoushi index gives as the extension's `homeUrl`, and it is the live
 * site.
 */
const SITE_URL = 'https://en-thunderscans.com'

/** The site's own directory for series. Chapters live at the root instead. */
const MANGA_DIR = '/comics'

const ICON_URL =
  'https://cdn.jsdelivr.net/gh/keiyoushi/extensions-source@main/src/en/thunderscans/res/mipmap-xhdpi/ic_launcher.png'

/**
 * Where requests actually go.
 *
 * Thunder Scans sends no `Access-Control-Allow-Origin` on anything — not the
 * HTML, not the page images — so in a browser everything is routed through the
 * app's own origin under `/thunderscans`, which the dev server proxies (see
 * vite.config.ts). A same-origin request is never subject to a CORS check.
 *
 * Unlike NovelFull this needs no curl hop: measured 2026-08-25, Node's own
 * fetch is served normally here. The site sits behind Cloudflare but not behind
 * Cloudflare's challenge, and the two are worth telling apart — spawning a
 * process per request buys nothing when a plain proxy is served.
 *
 * Outside a browser there is no restriction and no proxy to speak to, so the
 * site is addressed directly.
 */
function resolveApiBase(): string {
  if (typeof location === 'undefined') return SITE_URL
  return new URL('/thunderscans', appOrigin()).toString()
}

/**
 * Thunder Scans publishes no rate limit.
 *
 * Two requests a second matches the reasoning of the other proxied sources, and
 * matters more than for a source read directly: every user's traffic converges
 * on whichever host runs the proxy, so the site sees one IP rather than many.
 */
const RATE_LIMIT_PERMITS = 2
const RATE_LIMIT_PERIOD_MS = 1000

/**
 * Same reasoning as the Asura source: the image host is a static CDN, not the
 * rate-limited API, and this is the gap between fetch starts while the worker
 * keeps several pages in flight.
 */
const PAGE_FETCH_INTERVAL_MS = 150

/**
 * The `order` parameter's values, taken from the site's own filter form. An
 * empty value is the site's default ordering and is sent as no parameter.
 */
const SORT_VALUES = [
  ['Popular', 'popular'],
  ['Latest update', 'update'],
  ['Newest', 'latest'],
  ['A → Z', 'title'],
  ['Z → A', 'titlereverse'],
  ['Default', ''],
] as const

const STATUS_VALUES = [
  ['All', ''],
  ['Ongoing', 'ongoing'],
  ['Completed', 'completed'],
  ['Hiatus', 'hiatus'],
  ['Dropped', 'dropped'],
] as const

const TYPE_VALUES = [
  ['All', ''],
  ['Manga', 'manga'],
  ['Manhwa', 'manhwa'],
  ['Manhua', 'manhua'],
  ['Comic', 'comic'],
] as const

export interface ThunderFilterData {
  genres: Array<{ label: string; value: string }>
}

/**
 * Thunder Scans.
 *
 * A MangaThemesia site, and specifically the `MangaThemesiaAlt` variant, whose
 * distinguishing feature is that series slugs carry a rotating numeric prefix:
 * `/comics/0086250808-some-series/` today, a different number after the next
 * rotation. Only some of the catalogue carries one at any moment — six of
 * thirty on the first listing page when this was written, all sharing the same
 * prefix — which is consistent with the prefix being applied in batches.
 *
 * `url` is half of `manga_source_url_unique`, so identity here is always the
 * *stripped* slug and the prefix never reaches the database; a series whose url
 * changed would become a different series and silently orphan the user's
 * library entry, history and downloads.
 *
 * The upstream extension keeps an hourly-refreshed map from stripped slug to
 * live slug, scraped from `/comics/list-mode/`. That page does not exist on
 * this deployment — it renders the advanced-search form instead — and it turns
 * out not to be needed: the site answers `/comics/<stripped-slug>/` with a 301
 * to whatever the current prefixed slug is. Following that redirect is the
 * whole mechanism, which is why there is no cache in this file.
 *
 * Chapter slugs are a separate problem and are *not* derivable. Chapter 278 of
 * one series is `/…-chapter-278/` while its chapter 1 is `/1482765166-…-1/` —
 * different prefix, different suffix, no rule. So a chapter's site slug is
 * carried verbatim as the last segment of its url, which is the only place it
 * can live: `SChapter.memo` has no column and is not persisted.
 */
export class ThunderScans implements Source {
  readonly id = 'thunderscans'
  readonly name = 'Thunder Scans'
  readonly lang = 'en'
  readonly baseUrl = SITE_URL
  readonly iconUrl = ICON_URL
  readonly contentRating = 'safe'
  readonly versionCode = 1
  readonly supportsLatest = true
  readonly isLocal = false
  /**
   * The genre ids are numeric and site-specific, so the sheet has to read them
   * off the site's own search form before it can offer them.
   */
  readonly supportsFilterFetching = true
  readonly supportsRelatedMangas = false
  readonly pageFetchIntervalMs = PAGE_FETCH_INTERVAL_MS

  private readonly http: HttpTransport
  private readonly apiBase: string
  /** Genre label to the numeric id the site filters by. */
  private readonly genreIds = new Map<string, string>()

  constructor(transport?: HttpTransport, apiBase = resolveApiBase()) {
    this.apiBase = apiBase.replace(/\/$/, '')
    this.http =
      transport ??
      new DirectFetchTransport(
        new RateLimiter(
          RATE_LIMIT_PERMITS,
          RATE_LIMIT_PERIOD_MS,
          // Covers and page images are static files, not page loads; spending
          // the budget on them would stall the reader behind its own art.
          (url) => url.pathname.includes('/wp-content/uploads/'),
        ),
      )
  }

  // ------------------------------------------------------------- browsing --

  getPopularManga(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.listing(page, new URLSearchParams({ order: 'popular' }), signal)
  }

  getLatestUpdates(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.listing(page, new URLSearchParams({ order: 'update' }), signal)
  }

  async getSearchMangaList(
    page: number,
    query: string,
    filters: FilterList,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const term = query.trim()

    // The site has two different listings. `/comics/` takes the filter
    // parameters but ignores a search term; the root takes `?s=` but no
    // filters. Sending a term to `/comics/` returns the unfiltered catalogue
    // rather than an error, so the choice has to be made here.
    if (term) {
      const url = new URL(`${this.apiBase}/`)
      url.searchParams.set('s', term)
      if (page > 1) url.searchParams.set('page', String(page))
      return await this.scrapeList(url.toString(), signal)
    }

    return await this.listing(page, paramsOf(filters, this.genreIds), signal)
  }

  private async listing(
    page: number,
    params: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const url = new URL(`${this.apiBase}${MANGA_DIR}/`)
    // `?page=1` is redirected away rather than served, so it is never sent.
    if (page > 1) url.searchParams.set('page', String(page))
    for (const [key, value] of params) {
      if (value) url.searchParams.append(key, value)
    }
    return await this.scrapeList(url.toString(), signal)
  }

  private async scrapeList(
    url: string,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const doc = await this.fetchDocument(url, signal)

    const mangas = [...doc.querySelectorAll('div.listupd div.bsx > a')]
      .map((anchor) => this.toSManga(anchor))
      .filter((manga): manga is SManga => manga !== null)

    return {
      mangas,
      // The paginator is authoritative. A full page is not: a catalogue whose
      // length is a multiple of the page size ends on a full page.
      hasNextPage: Boolean(doc.querySelector('div.hpage a.r, a.r.next')),
    }
  }

  /** One listing card. Null when it carries no usable link. */
  private toSManga(anchor: Element): SManga | null {
    const slug = slugFromHref(anchor.getAttribute('href'))
    if (!slug) return null

    // The extension overrides the shared template's title selector for exactly
    // this site, because the card's own text node carries the series name and
    // the anchor's `title` attribute is the fallback rather than the source.
    const title =
      anchor.querySelector('.bigor .tt, h3 a')?.textContent?.trim() ||
      anchor.getAttribute('title')?.trim() ||
      slug

    const cover = anchor.querySelector('img')?.getAttribute('src')

    return {
      url: seriesUrl(slug),
      title,
      status: toStatus(anchor.querySelector('.status i')?.textContent),
      thumbnailUrl: cover ? this.resolve(cover) : undefined,
      initialized: false,
    }
  }

  // -------------------------------------------------------------- details --

  async getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
    signal?: AbortSignal,
  ): Promise<MangaUpdate> {
    const slug = slugOf(manga)
    // The stripped slug, not the live one: the site redirects it to whichever
    // prefixed slug is current, which is what keeps identity stable across a
    // rotation without this source having to track the prefix at all.
    const doc = await this.fetchDocument(
      `${this.apiBase}${MANGA_DIR}/${slug}/`,
      signal,
    )

    const chapters = opts.fetchChapters ? readChapters(doc, slug) : []
    if (!opts.fetchDetails) return { manga, chapters }

    return { manga: this.parseDetails(doc, slug), chapters }
  }

  private parseDetails(doc: Document, slug: string): SManga {
    const cover = doc.querySelector('.thumb img')?.getAttribute('src')
    const genre = [...doc.querySelectorAll('span.mgen a')]
      .map((a) => a.textContent?.trim() ?? '')
      .filter(Boolean)

    return {
      url: seriesUrl(slug),
      title: doc.querySelector('h1.entry-title')?.textContent?.trim() || slug,
      author:
        doc
          .querySelector('[itemprop="author"] [itemprop="name"]')
          ?.textContent?.trim() || undefined,
      description:
        doc.querySelector('[itemprop="description"]')?.textContent?.trim() ||
        undefined,
      genre,
      status: toStatus(doc.querySelector('.imptdt .status i')?.textContent),
      thumbnailUrl: cover ? this.resolve(cover) : undefined,
      initialized: true,
    }
  }

  // ---------------------------------------------------------------- pages --

  async getPageList(
    _manga: SManga,
    chapter: SChapter,
    signal?: AbortSignal,
  ): Promise<Page[]> {
    const key = chapter.url.split('/').pop() ?? ''
    if (!key) throw new Error('This chapter has no Thunder Scans path.')

    const res = await this.http.fetch({
      url: `${this.apiBase}/${key}/`,
      signal,
    })
    const images = readReaderImages(await res.text())

    if (images.length === 0) {
      throw new Error('This chapter has no pages on Thunder Scans.')
    }

    // Whole images, nothing tiled or signed, so `Page.descramble` stays unset.
    // They are served from the site's own origin rather than a separate CDN,
    // which means the proxy that makes the HTML readable makes the image bytes
    // readable too — so unlike Asura, chapters here can be exported to CBZ and
    // a saved page costs its real size rather than the ~7 MB an opaque
    // response is padded to.
    return images.map((imageUrl, index) => ({
      index,
      imageUrl: this.resolve(imageUrl),
    }))
  }

  // -------------------------------------------------------------- filters --

  async fetchFilterData(signal?: AbortSignal): Promise<ThunderFilterData> {
    const genres = await this.fetchGenres(signal)
    this.rememberGenres(genres)
    return { genres }
  }

  /**
   * The genre ids, read off the advanced-search form on the directory page.
   *
   * There is deliberately no snapshot to fall back on: the ids are numeric and
   * belong to the site's own taxonomy, so a stale one would filter to the wrong
   * genre rather than to nothing. An empty list leaves the sheet with sort,
   * status and type.
   */
  private async fetchGenres(
    signal?: AbortSignal,
  ): Promise<ThunderFilterData['genres']> {
    try {
      const doc = await this.fetchDocument(`${this.apiBase}${MANGA_DIR}/`, signal)
      return [...doc.querySelectorAll('ul.genrez li')]
        .map((li) => ({
          label:
            li.querySelector('label')?.textContent?.trim() ||
            li.textContent?.trim() ||
            '',
          value:
            li
              .querySelector('input[name="genre[]"]')
              ?.getAttribute('value')
              ?.trim() ?? '',
        }))
        .filter((genre) => genre.label && genre.value)
    } catch {
      signal?.throwIfAborted()
      return []
    }
  }

  getFilterList(data?: unknown): FilterList {
    const genres = (data as ThunderFilterData | undefined)?.genres ?? []
    // Search reads the instance map rather than this argument, which the app
    // does not thread back into `getSearchMangaList`.
    if (genres.length) this.rememberGenres(genres)

    return [
      sortFilter(),
      selectFilter('Status', STATUS_VALUES),
      selectFilter('Type', TYPE_VALUES),
      {
        type: 'group',
        name: 'Genres',
        state: genres.map((genre) => ({
          type: 'checkbox' as const,
          name: genre.label,
          state: false,
        })),
      },
    ]
  }

  private rememberGenres(genres: ThunderFilterData['genres']): void {
    for (const genre of genres) this.genreIds.set(genre.label, genre.value)
  }

  // ----------------------------------------------------------------- urls --

  getMangaWebUrl(manga: SManga): string {
    return `${SITE_URL}${MANGA_DIR}/${slugOf(manga)}/`
  }

  getChapterWebUrl(_manga: SManga, chapter: SChapter): string {
    return `${SITE_URL}/${chapter.url.split('/').pop() ?? ''}/`
  }

  // -------------------------------------------------------------- helpers --

  private async fetchDocument(
    url: string,
    signal?: AbortSignal,
  ): Promise<Document> {
    const res = await this.http.fetch({ url, signal })
    return parseDocument(await res.text(), 'text/html')
  }

  /**
   * A url from the page, pointed at wherever we are actually fetching.
   *
   * Covers and page images arrive as absolute urls on the site's own origin, so
   * unlike the other proxied sources it is not enough to prefix relative paths:
   * an absolute one has to be re-pointed at the proxy as well, or the bytes
   * come back opaque and export and descrambling become impossible again.
   */
  private resolve(url: string): string {
    if (url.startsWith(SITE_URL)) {
      return `${this.apiBase}${url.slice(SITE_URL.length)}`
    }
    if (/^https?:\/\//i.test(url)) return url
    return `${this.apiBase}${url.startsWith('/') ? url : `/${url}`}`
  }
}

// ------------------------------------------------------------- conversion --

function seriesUrl(slug: string): string {
  return `/series/${slug}`
}

function slugOf(manga: SManga): string {
  return manga.url.replace(/^\/series\//, '').replace(/\/$/, '')
}

/**
 * The rotating prefix on a series slug. Matches the upstream template's own
 * `slugRegex`, and is the reason identity is computed rather than taken.
 */
const SLUG_PREFIX = /^\d+-/

/** A listing href reduced to the identity it stands for. Null when unusable. */
function slugFromHref(href: string | null): string | null {
  if (!href) return null
  const path = href.split('?')[0]?.split('#')[0] ?? ''
  const last = path.split('/').filter(Boolean).pop()
  if (!last) return null
  return last.replace(SLUG_PREFIX, '') || null
}

/**
 * The chapter list, newest first as the page already has it.
 *
 * A locked chapter is served as a list entry whose anchor has no `href` — the
 * upstream extension renames those with a padlock and points them at a
 * `#locked-<id>` stub. They are skipped here instead: an entry that cannot be
 * opened is worse than absent once it is also sitting in the library's unread
 * count and the update feed.
 */
function readChapters(doc: Document, slug: string): SChapter[] {
  const chapters: SChapter[] = []

  for (const item of [...doc.querySelectorAll('#chapterlist li[data-num]')]) {
    const key = lastSegment(item.querySelector('a')?.getAttribute('href'))
    if (!key) continue

    const num = Number(item.getAttribute('data-num'))
    const date = item.querySelector('.chapterdate')?.textContent?.trim()
    const parsed = date ? Date.parse(date) : NaN

    chapters.push({
      // The site's own chapter slug, verbatim and whole. It cannot be rebuilt
      // from the series slug and a number — the prefixes and suffixes differ
      // from one chapter to the next — and there is nowhere else to keep it.
      url: `${seriesUrl(slug)}/chapter/${key}`,
      name:
        item.querySelector('.chapternum')?.textContent?.trim().replace(/\s+/g, ' ') ||
        key,
      chapterNumber: Number.isFinite(num) ? num : chapters.length + 1,
      dateUpload: Number.isNaN(parsed) ? undefined : parsed,
    })
  }

  return chapters
}

function lastSegment(href: string | null | undefined): string | null {
  if (!href) return null
  const path = href.split('?')[0]?.split('#')[0] ?? ''
  return path.split('/').filter(Boolean).pop() ?? null
}

/**
 * The page images, from the reader's own bootstrap call.
 *
 * MangaThemesia renders no `<img>` for the pages at all; the chapter's images
 * are a JSON blob passed to `ts_reader.run(...)` in an inline script, which is
 * why this reads the response text rather than the parsed document.
 *
 * A chapter may declare several mirrors and `defaultSource` says which the site
 * itself would have used — by **name** (`"Server 1"`), not by index, which is
 * the sort of field that silently reads as `sources[0]` for as long as the
 * default happens to be first.
 */
function readReaderImages(html: string): string[] {
  const match = /ts_reader\.run\((\{.*?\})\);/s.exec(html)
  if (!match?.[1]) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return []
  }

  const config = parsed as {
    sources?: { source?: unknown; images?: unknown }[]
    defaultSource?: unknown
  }
  const sources = config.sources ?? []
  const preferred = sources.find(
    (source) => source.source === config.defaultSource,
  )

  const images = (preferred ?? sources[0])?.images
  if (!Array.isArray(images)) return []
  return images.filter(
    (image): image is string => typeof image === 'string' && image.length > 0,
  )
}

function toStatus(raw?: string | null): MangaStatus {
  switch (raw?.trim().toLowerCase()) {
    case 'ongoing':
      return 'ongoing'
    case 'completed':
      return 'completed'
    case 'hiatus':
      return 'on_hiatus'
    case 'dropped':
    case 'cancelled':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

// ---------------------------------------------------------------- filters --

function sortFilter(): Filter {
  return {
    type: 'sort',
    name: 'Order By',
    values: SORT_VALUES.map(([label]) => label),
    state: { index: 0, ascending: false },
  }
}

function selectFilter(
  name: string,
  values: readonly (readonly [string, string])[],
): Filter {
  return { type: 'select', name, values: values.map(([label]) => label), state: 0 }
}

const SELECT_PARAMS: Record<
  string,
  { param: string; table: readonly (readonly [string, string])[] }
> = {
  Status: { param: 'status', table: STATUS_VALUES },
  Type: { param: 'type', table: TYPE_VALUES },
}

function paramsOf(
  filters: FilterList,
  genreIds: Map<string, string>,
): URLSearchParams {
  const params = new URLSearchParams({ order: SORT_VALUES[0][1] })

  for (const filter of filters) {
    switch (filter.type) {
      case 'sort': {
        params.set('order', SORT_VALUES[filter.state.index]?.[1] ?? '')
        break
      }
      case 'select': {
        const mapping = SELECT_PARAMS[filter.name]
        if (!mapping) break
        const value = mapping.table[filter.state]?.[1]
        if (value) params.set(mapping.param, value)
        break
      }
      case 'group': {
        for (const child of filter.state) {
          if (child.type !== 'checkbox' || !child.state) continue
          const id = genreIds.get(child.name)
          if (id) params.append('genre[]', id)
        }
        break
      }
    }
  }

  return params
}
