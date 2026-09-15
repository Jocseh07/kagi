/**
 * Source API, modelled on Mihon extensions-lib 1.6 (`KeiSource`).
 *
 * Deliberate divergences from the Kotlin API, all forced by the browser:
 *  - everything is async; there is no RxJava/Observable layer
 *  - `memo` is a plain JSON object rather than kotlinx JsonObject
 *  - preferences are a flat record persisted by the app, not SharedPreferences
 */

/**
 * What a source's chapters are made of.
 *
 * `comic` chapters are a list of images and read through `getPageList`;
 * `novel` chapters are prose and read through `getChapterText`. The UI branches
 * on this rather than on source id, the same way it already branches on
 * `supportsLatest` and `isLocal`.
 */
export type ContentKind = 'comic' | 'novel'

/**
 * How much adult work a source carries, mirroring the three-way rating the
 * Keiyoushi extension repository puts on every extension:
 *
 *  - `safe`  — their `SAFE`: nothing adult in the catalogue
 *  - `mixed` — their `MIXED`: a general catalogue that also hosts adult work
 *  - `adult` — their `NSFW`: an adult catalogue
 *
 * Three values rather than a boolean because the middle case is the common
 * one, and collapsing it either mislabels a general source as adult or hides
 * the fact that it carries adult work at all.
 */
export type ContentRating = 'safe' | 'mixed' | 'adult'

export type MangaStatus =
  | 'unknown'
  | 'ongoing'
  | 'completed'
  | 'licensed'
  | 'publishing_finished'
  | 'cancelled'
  | 'on_hiatus'

export interface SManga {
  /** Source-relative identity. Stable across domain changes. */
  url: string
  title: string
  artist?: string
  author?: string
  description?: string
  genre?: string[]
  status: MangaStatus
  thumbnailUrl?: string
  initialized: boolean
  /** Source-private scratch space carried between calls (e.g. randomised slugs). */
  memo?: Record<string, unknown>
}

export interface SChapter {
  url: string
  name: string
  dateUpload?: number
  chapterNumber: number
  scanlator?: string
  memo?: Record<string, unknown>
}

export interface Page {
  index: number
  imageUrl: string
  /**
   * Present when the source serves a scrambled tile grid. The image must be
   * split into `cols * rows` tiles; tile at read-order position `i` belongs at
   * destination position `tiles[i]`.
   */
  descramble?: { tiles: number[]; cols: number; rows: number }
}

/**
 * One novel chapter's prose.
 *
 * `html` is a sanitised fragment, never raw source output: sources that scrape
 * pass their HTML through `sanitizeChapterHtml`, and sources that receive a
 * structured document build the fragment from it. Either way what reaches the
 * reader is already safe to insert into the DOM.
 */
export interface ChapterText {
  html: string
  /**
   * Plain-text length, used for reading-time estimates and for the byte figure
   * shown against a saved chapter. Derived by the source; the reader does not
   * re-walk the fragment to count it.
   */
  textLength: number
}

export interface MangasPage {
  mangas: SManga[]
  hasNextPage: boolean
}

export interface MangaUpdate {
  manga: SManga
  chapters: SChapter[]
}

// ---------------------------------------------------------------- filters --

export type Filter =
  | { type: 'header'; name: string }
  | { type: 'separator' }
  | { type: 'text'; name: string; state: string }
  | { type: 'select'; name: string; values: string[]; state: number }
  | { type: 'checkbox'; name: string; state: boolean }
  /** 0 = ignore, 1 = include, 2 = exclude */
  | { type: 'tristate'; name: string; state: 0 | 1 | 2 }
  | { type: 'group'; name: string; state: Filter[] }
  | {
      type: 'sort'
      name: string
      values: string[]
      state: { index: number; ascending: boolean }
    }

export type FilterList = Filter[]

// ----------------------------------------------------------------- source --

export interface SourceInfo {
  id: string
  name: string
  lang: string
  baseUrl: string
  iconUrl?: string
  contentRating: ContentRating
  versionCode: number
  /** Comics when omitted, so an existing source needs no change to keep working. */
  contentKind?: ContentKind
}

export interface Source extends SourceInfo {
  readonly supportsLatest: boolean
  /**
   * True when the source's content already lives on this device, so there is
   * nothing to download. Such sources serve `blob:` page URLs, which the Cache
   * API cannot store — offering "save offline" for them would always fail.
   */
  readonly isLocal: boolean
  /**
   * False for a source that publishes no cover art at all.
   *
   * Not the same as a series arriving without one: `thumbnailUrl` already says
   * that per entry, and the grid falls back to a placeholder tile for it. This
   * is the catalogue-wide fact, and it is what lets Browse drop the thumbnail
   * column entirely rather than draw the same placeholder on every single row.
   *
   * Absent means the source has covers, so no existing source needs a change.
   */
  readonly hasCovers?: boolean

  /** Filter options that must be fetched from the network before rendering. */
  readonly supportsFilterFetching: boolean
  readonly supportsRelatedMangas: boolean

  /**
   * Minimum gap between two page-image fetches, in milliseconds.
   *
   * Page images are fetched by the service worker, which never passes through
   * this source's own `RateLimiter`, so the source has to publish the pace it
   * expects instead of enforcing it. `0` means no pacing is needed — a local
   * source reading from disk has no budget to overrun.
   */
  readonly pageFetchIntervalMs: number

  /**
   * Every network-bearing call takes an optional `signal`. It is threaded down
   * to `fetch`, so a cancelled operation stops in flight rather than at the
   * next call boundary; callers that pass nothing are unaffected.
   */
  getPopularManga(page: number, signal?: AbortSignal): Promise<MangasPage>
  getLatestUpdates(page: number, signal?: AbortSignal): Promise<MangasPage>
  getSearchMangaList(
    page: number,
    query: string,
    filters: FilterList,
    signal?: AbortSignal,
  ): Promise<MangasPage>

  /**
   * Fetch details and/or chapters in one call, mirroring 1.6's
   * `fetchMangaUpdate`. Implementations may issue a single request for both.
   */
  getMangaUpdate(
    manga: SManga,
    opts: { fetchDetails: boolean; fetchChapters: boolean },
    signal?: AbortSignal,
  ): Promise<MangaUpdate>

  /**
   * Comic sources only. A novel source throws here; nothing calls it once
   * `contentKind` says `novel`.
   */
  getPageList(
    manga: SManga,
    chapter: SChapter,
    signal?: AbortSignal,
  ): Promise<Page[]>

  /**
   * Novel sources only. Mirrors LNReader's `parseChapter`.
   *
   * Required in practice whenever `contentKind` is `novel` — optional on the
   * interface so the three comic sources need no stub. `kindOf`/`textSourceOf`
   * in the registry are how callers reach it safely.
   */
  getChapterText?(
    manga: SManga,
    chapter: SChapter,
    signal?: AbortSignal,
  ): Promise<ChapterText>

  /**
   * The two halves of `getChapterText`, for a fetch that happens elsewhere.
   *
   * The download queue hands chapter requests to Background Fetch so they
   * survive a locked screen, then parses the body the browser brought back.
   * A network novel source provides both; a local-file source has no URL to
   * hand off and provides neither.
   */
  chapterTextUrl?(manga: SManga, chapter: SChapter): string
  parseChapterText?(body: string): ChapterText

  /** Runtime-fetched filter option data, cached by the app. */
  fetchFilterData?(): Promise<unknown>
  getFilterList(data?: unknown): FilterList

  getRelatedMangaList?(manga: SManga): Promise<SManga[]>

  /** Canonical web URL, for "open in browser". */
  getMangaWebUrl(manga: SManga): string
  getChapterWebUrl(manga: SManga, chapter: SChapter): string
}

/** User-facing settings a source exposes, rendered generically by the app. */
export interface SourcePreference {
  key: string
  title: string
  summary?: string
  type: 'switch' | 'text' | 'select'
  default: string | boolean
  values?: { label: string; value: string }[]
}

export interface ConfigurableSource {
  getPreferences(): SourcePreference[]
  /** Applied by the app after loading persisted values from the database. */
  setPreferences(prefs: Record<string, string | boolean>): void
}

/** A source whose chapters are prose, narrowed so `getChapterText` is callable. */
export type TextSource = Source & {
  getChapterText: NonNullable<Source['getChapterText']>
}

export function kindOf(source: SourceInfo): ContentKind {
  return source.contentKind ?? 'comic'
}

/** True unless the source has said it publishes no covers. */
export function hasCoverArt(source: Source): boolean {
  return source.hasCovers ?? true
}

/** True for a source that carries adult work, whether or not that is all it is. */
export function isAdultRated(source: SourceInfo): boolean {
  return source.contentRating !== 'safe'
}

/**
 * True for a source that really can serve prose.
 *
 * Both halves are checked rather than trusting `contentKind` alone: a novel
 * source missing its implementation would otherwise fail deep inside the
 * reader with an unhelpful "not a function".
 */
export function isTextSource(source: Source): source is TextSource {
  return kindOf(source) === 'novel' && typeof source.getChapterText === 'function'
}

/** A text source whose chapter fetch can be handed to the browser. */
export type PrimableTextSource = TextSource & {
  chapterTextUrl: NonNullable<Source['chapterTextUrl']>
  parseChapterText: NonNullable<Source['parseChapterText']>
}

export function isPrimableTextSource(
  source: Source,
): source is PrimableTextSource {
  return (
    isTextSource(source) &&
    typeof source.chapterTextUrl === 'function' &&
    typeof source.parseChapterText === 'function'
  )
}

export function isConfigurable(s: Source): s is Source & ConfigurableSource {
  const c = s as Partial<ConfigurableSource>
  return (
    typeof c.getPreferences === 'function' &&
    typeof c.setPreferences === 'function'
  )
}
