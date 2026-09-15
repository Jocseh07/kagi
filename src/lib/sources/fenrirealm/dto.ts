/**
 * Wire shapes for fenrirealm.com's `/api/new/v2` API.
 *
 * The API is undocumented and unversioned in practice; these were read off the
 * site's own SvelteKit route chunks (`/_app/immutable/nodes/*.js`) and then
 * checked against live responses. Everything past the identity keys is
 * optional: nullable columns come back as `null` rather than being dropped, so
 * most fields are typed as `T | null` rather than `T | undefined`.
 */

/** Laravel's paginator envelope. `last_page` is what ends a listing. */
export interface PaginationMeta {
  current_page: number
  from: number | null
  last_page: number
  per_page: number
  to: number | null
  total: number
}

/** A genre or tag from `/api/new/v2/taxonomies/{genres,tags}`. */
export interface TaxonomyDto {
  id: number
  name: string
  slug: string
  description?: string | null
}

/** Whoever posted the thing — a translator on a series, an uploader on a chapter. */
export interface UserDto {
  username?: string | null
  name?: string | null
}

/**
 * A series, from either the listing or the detail endpoint.
 *
 * Both return the same shape; detail adds `covers`, `banner`, `schedules`,
 * `stats` and `notices`, none of which this source reads. There is no author
 * field anywhere in the API — `user` is the translation group, which is the
 * closest thing the site publishes.
 */
export interface SeriesDto {
  id: number
  title: string
  slug: string
  alt_title?: string | null
  /** Display casing: `Ongoing`, `Completed`, `Hiatus`, `Dropped`. */
  status?: string | null
  /** An HTML fragment, not plain text. */
  description?: string | null
  /** `novel`, `light_novel` or `web_novel`. */
  type?: string | null
  genres?: TaxonomyDto[]
  tags?: TaxonomyDto[]
  /** Site-relative and unprefixed, e.g. `storage/161/1dbd….png`. */
  cover?: string | null
  user?: UserDto | null
}

export interface SeriesListResponse {
  data?: SeriesDto[]
  meta?: PaginationMeta
}

/**
 * What a chapter costs.
 *
 * `price > 0` alone does not mean locked: every premium chapter becomes free
 * eventually, and when it does the site sets `unlocked_at` and leaves the
 * price in place as a record of what it used to cost.
 */
export interface ChapterLockDto {
  price?: number | null
  unlocked_at?: string | null
  is_read_only?: boolean
}

/** One entry from `/api/new/v2/series/{slug}/chapters`, which is a bare array. */
export interface ChapterListEntryDto {
  id: number
  /** Usually the chapter number as a string; it is what the web URL uses. */
  slug: string
  /** Often prefixed with a stray space, and sometimes duplicates `title`. */
  name?: string | null
  title?: string | null
  number?: number | null
  part?: number | null
  /** Position in the ascending list. */
  index?: number | null
  type?: string | null
  has_illustration?: boolean
  locked?: ChapterLockDto | null
  user?: UserDto | null
  created_at?: string | null
  updated_at?: string | null
}

export interface ChapterDto extends ChapterListEntryDto {
  /**
   * The body, in whichever shape `content_format` names. For a still-premium
   * chapter this is a short teaser rather than the chapter, which is why the
   * lock has to be checked before the content is trusted.
   */
  content?: string | null
  /** `html` on current chapters, `json` on older ones. */
  content_format?: string | null
}

/**
 * A node of the TipTap document served when `content_format` is `json`.
 *
 * The root arrives typed `systemWindow` rather than `doc`, and unknown types
 * turn up as the site's editor gains features, so the renderer recurses on
 * anything it does not recognise instead of dropping it.
 */
export interface TiptapNode {
  type?: string
  text?: string
  content?: TiptapNode[]
  marks?: { type?: string; attrs?: Record<string, unknown> }[]
  attrs?: Record<string, unknown>
}
