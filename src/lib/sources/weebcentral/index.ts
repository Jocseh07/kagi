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
const SITE_URL = 'https://weebcentral.com'

/** Covers and page images. One host for both, and it sends no CORS headers. */
const IMAGE_URL = 'https://temp.compsci88.com'

const ICON_URL =
  'https://cdn.jsdelivr.net/gh/keiyoushi/extensions-source@main/src/en/weebcentral/res/mipmap-xhdpi/ic_launcher.png'

/**
 * Where requests actually go.
 *
 * Neither host sends `Access-Control-Allow-Origin`, so in a browser both are
 * reached through this origin — the site under `/weebcentral`, the image host
 * under `/weebcdn`. Same-origin bytes are readable, which is what keeps CBZ
 * export and real offline sizing working here.
 *
 * Outside a browser there is no CORS and no proxy to speak to, so the hosts
 * are addressed directly.
 */
function resolveApiBase(): string {
  if (typeof location === 'undefined') return SITE_URL
  return new URL('/weebcentral', location.origin).toString()
}

function resolveImageBase(): string {
  if (typeof location === 'undefined') return IMAGE_URL
  return new URL('/weebcdn', location.origin).toString()
}

/**
 * The site's own ceiling. `limit` is accepted but ignored: every request comes
 * back with 32 entries, so paging is computed from this rather than from what
 * was asked for.
 */
const PER_PAGE = 32

/** The extension's budget: one request per two seconds, images exempt. */
const RATE_LIMIT_PERMITS = 1
const RATE_LIMIT_PERIOD_MS = 2000

/**
 * Same reasoning as the other proxied comic sources: the image host is a
 * static file server rather than the paced site, and this is the gap between
 * fetch starts while the worker keeps several pages in flight.
 */
const PAGE_FETCH_INTERVAL_MS = 150

const SORT_VALUES = [
  ['Best Match', 'Best Match'],
  ['Alphabet', 'Alphabet'],
  ['Popularity', 'Popularity'],
  ['Subscribers', 'Subscribers'],
  ['Recently Added', 'Recently Added'],
  ['Latest Updates', 'Latest Updates'],
] as const

const ORDER_VALUES = [
  ['Descending', 'Descending'],
  ['Ascending', 'Ascending'],
] as const

/** The three-state filters the site models as radio groups rather than flags. */
const TRIPLE_VALUES = [
  ['Any', 'Any'],
  ['Yes', 'True'],
  ['No', 'False'],
] as const

const STATUS_VALUES = ['Ongoing', 'Complete', 'Hiatus', 'Canceled'] as const
const TYPE_VALUES = ['Manga', 'Manhwa', 'Manhua', 'OEL'] as const

/**
 * A name like `Season 2 Chapter 4` restarts its numbering, so the number in it
 * is not the chapter's position in the series. When one appears the whole list
 * is numbered by position instead, matching the extension's own fallback.
 */
const SEASON_NAME = /(Season|S)\s*\d+/i

/**
 * Weeb Central.
 *
 * Plain server-rendered HTML throughout: the search form posts to a fragment
 * endpoint, the chapter list is its own fragment, and a chapter's images are a
 * third. There is no JSON API to prefer, so unlike Asura this scrapes, and
 * therefore only runs in a browser — `DOMParser` has no Node counterpart here.
 */
export class WeebCentral implements Source {
  readonly id = 'weebcentral'
  readonly name = 'Weeb Central'
  readonly lang = 'en'
  readonly baseUrl = SITE_URL
  readonly iconUrl = ICON_URL
  readonly contentRating = 'mixed'
  readonly versionCode = 1
  readonly supportsLatest = true
  readonly isLocal = false
  readonly supportsFilterFetching = false
  readonly supportsRelatedMangas = true
  readonly pageFetchIntervalMs = PAGE_FETCH_INTERVAL_MS

  private readonly http: HttpTransport
  private readonly apiBase: string
  private readonly imageBase: string

  constructor(
    transport?: HttpTransport,
    apiBase = resolveApiBase(),
    imageBase = resolveImageBase(),
  ) {
    this.apiBase = apiBase.replace(/\/$/, '')
    this.imageBase = imageBase.replace(/\/$/, '')
    this.http =
      transport ??
      new DirectFetchTransport(
        new RateLimiter(RATE_LIMIT_PERMITS, RATE_LIMIT_PERIOD_MS, (url) =>
          // The image host is not what the budget above is protecting.
          url.pathname.startsWith('/weebcdn') ||
          url.host === new URL(IMAGE_URL).host,
        ),
      )
  }

  // ------------------------------------------------------------- browsing --

  getPopularManga(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.getSearchMangaList(page, '', [sortFilter('Popularity')], signal)
  }

  getLatestUpdates(page: number, signal?: AbortSignal): Promise<MangasPage> {
    return this.getSearchMangaList(
      page,
      '',
      [sortFilter('Latest Updates')],
      signal,
    )
  }

  async getSearchMangaList(
    page: number,
    query: string,
    filters: FilterList,
    signal?: AbortSignal,
  ): Promise<MangasPage> {
    const url = new URL(`${this.apiBase}/search/data`)
    // Punctuation is not indexed and a query carrying it returns nothing, so
    // it is spaced out rather than sent — the extension does the same.
    url.searchParams.set('text', query.replace(/[!#:(),-]/g, ' ').trim())
    applyFilters(url, filters)
    url.searchParams.set('limit', String(PER_PAGE))
    url.searchParams.set('offset', String((page - 1) * PER_PAGE))
    url.searchParams.set('display_mode', 'Full Display')

    const doc = await this.fetchDocument(url.toString(), signal)
    const mangas = [...doc.querySelectorAll('article > section > a')]
      .map((anchor) => this.toSManga(anchor))
      .filter((manga): manga is SManga => manga !== null)

    return {
      mangas,
      // The fragment ends with a "load more" button only while more exists.
      hasNextPage: Boolean(doc.querySelector('button')),
    }
  }

  /** A search result anchor, or null when it carries no usable series link. */
  private toSManga(anchor: Element): SManga | null {
    const href = anchor.getAttribute('href')
    const url = href ? seriesPath(href) : null
    if (!url) return null

    const title = readTitle(anchor) ?? nameFromHref(href!)
    if (!title) return null

    return {
      url,
      title,
      status: 'unknown',
      thumbnailUrl: this.cover(anchor),
      initialized: false,
    }
  }

  // -------------------------------------------------------------- details --

  async getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
    signal?: AbortSignal,
  ): Promise<MangaUpdate> {
    const [details, chapters] = await Promise.all([
      opts.fetchDetails ? this.fetchDetails(manga, signal) : Promise.resolve(manga),
      opts.fetchChapters ? this.fetchChapters(manga, signal) : Promise.resolve([]),
    ])
    return { manga: details, chapters }
  }

  private async fetchDetails(
    manga: SManga,
    signal?: AbortSignal,
  ): Promise<SManga> {
    const doc = await this.fetchDocument(`${this.apiBase}${manga.url}`, signal)
    const fields = readFields(doc)

    const genre = [...(fields.get('type') ?? []), ...(fields.get('tags') ?? [])]

    return {
      ...manga,
      title: doc.querySelector('h1')?.textContent?.trim() || manga.title,
      author: fields.get('author')?.join(', ') || undefined,
      description: readDescription(doc),
      genre: genre.length > 0 ? genre : undefined,
      status: toStatus(fields.get('status')?.[0]),
      thumbnailUrl: this.cover(doc) ?? manga.thumbnailUrl,
      initialized: true,
    }
  }

  private async fetchChapters(
    manga: SManga,
    signal?: AbortSignal,
  ): Promise<SChapter[]> {
    const id = seriesId(manga.url)
    if (!id) throw new Error('This series has no Weeb Central path.')

    const doc = await this.fetchDocument(
      `${this.apiBase}/series/${id}/full-chapter-list`,
      signal,
    )

    // Newest first, which is the order the app expects and the order the
    // positional numbering below is counted from.
    const anchors = [...doc.querySelectorAll('div[x-data] > a')]
    const names = anchors.map(
      (anchor) => anchor.querySelector('span.grow > span')?.textContent?.trim() ?? '',
    )
    const byPosition = names.some((name) => SEASON_NAME.test(name))

    const chapters: SChapter[] = []
    anchors.forEach((anchor, index) => {
      const href = anchor.getAttribute('href')
      const url = href ? chapterPath(manga.url, href) : null
      if (!url) return

      const name = names[index] || 'Chapter'
      const stamp = anchor.querySelector('time[datetime]')?.getAttribute('datetime')
      const parsed = stamp ? Date.parse(stamp) : NaN

      chapters.push({
        url,
        name,
        chapterNumber: byPosition
          ? anchors.length - index
          : (readChapterNumber(name) ?? -1),
        dateUpload: Number.isFinite(parsed) ? parsed : undefined,
      })
    })

    return chapters
  }

  async getRelatedMangaList(manga: SManga): Promise<SManga[]> {
    const doc = await this.fetchDocument(`${this.apiBase}${manga.url}`)
    const related = [...doc.querySelectorAll('a')]
      .filter((anchor) => {
        const href = anchor.getAttribute('href')
        return Boolean(href && seriesPath(href) && seriesPath(href) !== manga.url)
      })
      .map((anchor) => this.toSManga(anchor))
      .filter((entry): entry is SManga => entry !== null)

    // The page links the same series from several places; the first mention
    // carries the cover, so later duplicates are dropped rather than merged.
    const seen = new Set<string>()
    return related.filter((entry) => {
      if (seen.has(entry.url)) return false
      seen.add(entry.url)
      return true
    })
  }

  // ---------------------------------------------------------------- pages --

  async getPageList(
    _manga: SManga,
    chapter: SChapter,
    signal?: AbortSignal,
  ): Promise<Page[]> {
    const id = chapterId(chapter.url)
    if (!id) throw new Error('This chapter has no Weeb Central path.')

    const url = new URL(`${this.apiBase}/chapters/${id}/images`)
    url.searchParams.set('is_prev', 'False')
    url.searchParams.set('reading_style', 'long_strip')

    const doc = await this.fetchDocument(url.toString(), signal)
    const images = [...doc.querySelectorAll('section img')]
      .map((img) => img.getAttribute('src'))
      .filter((src): src is string => Boolean(src))

    if (images.length === 0) {
      throw new Error('This chapter has no pages on Weeb Central.')
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
      selectFilter('Order', ORDER_VALUES),
      selectFilter('Official Translation', TRIPLE_VALUES),
      selectFilter('Anime Adaptation', TRIPLE_VALUES),
      selectFilter('Adult Content', TRIPLE_VALUES),
      {
        type: 'group',
        name: 'Status',
        state: STATUS_VALUES.map((name) => ({
          type: 'checkbox' as const,
          name,
          state: false,
        })),
      },
      {
        type: 'group',
        name: 'Type',
        state: TYPE_VALUES.map((name) => ({
          type: 'checkbox' as const,
          name,
          state: false,
        })),
      },
    ]
  }

  // ----------------------------------------------------------------- urls --

  getMangaWebUrl(manga: SManga): string {
    return `${SITE_URL}/series/${seriesId(manga.url) ?? ''}`
  }

  getChapterWebUrl(_manga: SManga, chapter: SChapter): string {
    return `${SITE_URL}/chapters/${chapterId(chapter.url) ?? ''}`
  }

  // --------------------------------------------------------------- images --

  /**
   * A cover or page image, pointed at wherever we are actually fetching.
   *
   * The site emits these as absolute urls on its image host, so a relative
   * prefix is not enough: an absolute one has to be re-pointed too, or the
   * bytes come back opaque and export and sizing are lost. A url on any other
   * host is left alone — it will be unreadable in a browser, which is visible
   * as a broken page rather than as a silent wrong image.
   */
  private image(url: string): string {
    if (url.startsWith(IMAGE_URL)) {
      return `${this.imageBase}${url.slice(IMAGE_URL.length)}`
    }
    if (/^https?:\/\//i.test(url)) return url
    return `${this.apiBase}${url.startsWith('/') ? url : `/${url}`}`
  }

  /** The best cover in a subtree: the full-size `source`, else the fallback. */
  private cover(root: ParentNode): string | undefined {
    const srcset = root.querySelector('source[srcset]')?.getAttribute('srcset')
    if (srcset) return this.image(srcset.split(' ')[0]!.replace('/small/', '/normal/'))
    const src = root.querySelector('img[src]')?.getAttribute('src')
    return src ? this.image(src) : undefined
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
  const id = /\/series\/([A-Za-z0-9]+)/.exec(href)?.[1]
  return id ? `/series/${id}` : null
}

function seriesId(url: string): string | null {
  return /^\/series\/([A-Za-z0-9]+)/.exec(url)?.[1] ?? null
}

function chapterPath(mangaUrl: string, href: string): string | null {
  const id = /\/chapters\/([A-Za-z0-9]+)/.exec(href)?.[1]
  return id ? `${mangaUrl}/chapter/${id}` : null
}

function chapterId(url: string): string | null {
  return /\/chapter\/([A-Za-z0-9]+)$/.exec(url)?.[1] ?? null
}

/**
 * The readable name a series href carries after its id.
 *
 * Only a fallback: the site drops it from some links, and it is not part of
 * the identity — `/series/<id>` alone resolves to the same page.
 */
function nameFromHref(href: string): string | undefined {
  const slug = /\/series\/[A-Za-z0-9]+\/([^/?#]+)/.exec(href)?.[1]
  return slug ? slug.replace(/-/g, ' ') : undefined
}

/**
 * A result's title.
 *
 * The cover's `alt` is `<title> cover` and is the only place the full title
 * appears untruncated; the visible label is clipped with an ellipsis in the
 * markup itself. The label is still read as a fallback for a result whose
 * cover failed to render server-side.
 */
function readTitle(anchor: Element): string | undefined {
  const alt = anchor.querySelector('img[alt]')?.getAttribute('alt')?.trim()
  if (alt) return alt.replace(/\s+cover$/i, '')
  return anchor.querySelector('div.text-ellipsis')?.textContent?.trim() || undefined
}

/**
 * The detail page's `<strong>Label:</strong> value` rows, keyed by a lowercase
 * label with its punctuation dropped (`Tags(s):` → `tags`).
 *
 * Read by walking the list rather than with a `:has()` selector, because the
 * labels are the only stable thing on the page — the classes around them are
 * utility soup that changes with the site's styling.
 */
function readFields(doc: Document): Map<string, string[]> {
  const fields = new Map<string, string[]>()

  for (const item of doc.querySelectorAll('li')) {
    const label = item.querySelector('strong')?.textContent ?? ''
    const key = label.toLowerCase().replace(/[^a-z]/g, '')
    if (!key) continue

    const values = [...item.querySelectorAll('a, span')]
      .map((node) => node.textContent?.trim().replace(/,$/, '') ?? '')
      .filter(Boolean)
    if (values.length > 0 && !fields.has(key)) fields.set(key, values)
  }

  return fields
}

function readDescription(doc: Document): string | undefined {
  for (const item of doc.querySelectorAll('li')) {
    if (!/description/i.test(item.querySelector('strong')?.textContent ?? '')) {
      continue
    }
    const text = item.querySelector('p')?.textContent?.trim()
    if (text) return text
  }
  return undefined
}

function toStatus(raw?: string): MangaStatus {
  switch (raw?.toLowerCase()) {
    case 'ongoing':
      return 'ongoing'
    case 'complete':
    case 'completed':
      return 'completed'
    case 'hiatus':
      return 'on_hiatus'
    case 'canceled':
    case 'cancelled':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

/** The number in `Chapter 1193`, or null when the name carries none. */
function readChapterNumber(name: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*$/.exec(name.trim())
  return match ? Number(match[1]) : null
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

const TRIPLE_PARAMS: Record<string, string> = {
  'Official Translation': 'official',
  'Anime Adaptation': 'anime',
  'Adult Content': 'adult',
}

function applyFilters(url: URL, filters: FilterList): void {
  for (const filter of filters) {
    switch (filter.type) {
      case 'sort': {
        url.searchParams.set('sort', SORT_VALUES[filter.state.index]![1])
        url.searchParams.set(
          'order',
          filter.state.ascending ? 'Ascending' : 'Descending',
        )
        break
      }
      case 'select': {
        if (filter.name === 'Order') {
          url.searchParams.set('order', ORDER_VALUES[filter.state]![1])
          break
        }
        const param = TRIPLE_PARAMS[filter.name]
        const value = TRIPLE_VALUES[filter.state]?.[1]
        // `Any` is the site's default and is sent as no parameter at all.
        if (param && value && value !== 'Any') url.searchParams.set(param, value)
        break
      }
      case 'group': {
        const param =
          filter.name === 'Status'
            ? 'included_status'
            : filter.name === 'Type'
              ? 'included_type'
              : null
        if (!param) break
        for (const child of filter.state) {
          if (child.type === 'checkbox' && child.state) {
            url.searchParams.append(param, child.name)
          }
        }
        break
      }
    }
  }

  // The form always submits a sort, and the endpoint orders by relevance when
  // it gets none — which is wrong for a browse tab with no query.
  if (!url.searchParams.has('sort')) {
    url.searchParams.set('sort', 'Best Match')
    url.searchParams.set('order', 'Descending')
  }
}
