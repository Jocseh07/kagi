/**
 * The slices of MangaHub's GraphQL schema this source reads.
 *
 * Everything past the keys that identify a record is optional. The API omits
 * fields rather than sending nulls for them, and the schema is stricter than
 * it looks in the other direction too: asking for a field that does not exist
 * fails the whole query, which is why nothing speculative is requested.
 */

export interface GraphqlResponse<T> {
  data?: T | null
  errors?: { message?: string }[] | null
}

/** A series as the search endpoint returns one. Less than `MangaDto` carries. */
export interface SearchRowDto {
  title: string
  slug: string
  /** A path under the cover host, e.g. `mn/naruto.jpg`. Never absolute. */
  image?: string | null
  author?: string | null
  /** Comma-separated labels, not an array. */
  genres?: string | null
  status?: string | null
}

export interface SearchResponse {
  search?: {
    rows?: SearchRowDto[] | null
    /** The whole catalogue's match count, not this page's. */
    count?: number | null
  } | null
}

export interface ChapterDto {
  /** Decimal. `700.5` is an ordinary value, not an edge case. */
  number: number
  /** Often empty, in which case the number is the only name there is. */
  title?: string | null
  date?: string | null
}

export interface MangaDto {
  title?: string | null
  slug?: string | null
  status?: string | null
  image?: string | null
  author?: string | null
  artist?: string | null
  genres?: string | null
  description?: string | null
  /** Every localised title in one string, separated by ` ; `. */
  alternativeTitle?: string | null
  chapters?: ChapterDto[] | null
}

export interface MangaResponse {
  manga?: MangaDto | null
}

export interface ChapterPagesDto {
  /**
   * The page list, as a JSON string that has to be parsed a second time. See
   * `PageManifest` for the two shapes it holds.
   */
  pages?: string | null
  /**
   * The token the site appends to every page image as `?x=`. Images serve
   * without it, but it is sent anyway so our requests look like the site's.
   */
  s?: string | null
}

export interface ChapterResponse {
  chapter?: ChapterPagesDto | null
}

/**
 * A parsed `pages` string.
 *
 * Current chapters are `{ p: "naruto/700/", i: ["1.jpg", …] }` — a shared
 * prefix and the file names under it. Older ones are a bare object keyed by
 * page number, which is why `i` is optional rather than assumed.
 */
export type PageManifest =
  | { p?: string; i: string[] }
  | Record<string, string | undefined>
