/**
 * Wire shapes for api.asurascans.com.
 *
 * Every field beyond the identity keys is optional: the API omits nullable
 * columns entirely rather than sending null (e.g. `release_year` is absent on
 * some series), so anything assumed present will throw on a real response.
 * `Meta.has_more` is the same rule applied to a boolean, and it bites harder —
 * see the note there.
 */

export interface Meta {
  total: number
  per_page: number
  /**
   * Absent on the last page rather than sent as `false`, so its absence means
   * "no answer", not "no more pages". `total` is what actually settles it.
   */
  has_more?: boolean
}

export interface GenreDto {
  id: number
  name: string
  slug: string
}

export interface SeriesDto {
  id: number
  slug: string
  title: string
  description?: string
  /** `cover` on listings, `cover_url` on recommendations. Same image. */
  cover?: string
  cover_url?: string
  banner?: string
  status?: string
  type?: string
  author?: string
  artist?: string
  release_year?: number
  rating?: number
  popularity_rank?: number
  bookmark_count?: number
  chapter_count?: number
  last_chapter_at?: string
  is_pinned?: boolean
  created_at?: string
  updated_at?: string
  /**
   * Site-relative, e.g. `/comics/shadow-slave-b60d532c`. The trailing suffix is
   * not derivable from `slug`, which is why this is worth carrying around.
   */
  public_url?: string
  source_url?: string
  genres?: GenreDto[]
  latest_chapters?: ChapterDto[]
}

export interface ChapterDto {
  id: number
  series_id: number
  number: number
  /** Scanlator's own name for the chapter, e.g. `Season 1 End`. Often absent. */
  title?: string | null
  slug: string
  page_count?: number
  is_premium?: boolean
  /** Set while a chapter is still inside its paid early-access window. */
  early_access_until?: string | null
  comments_enabled?: boolean
  published_at?: string
  created_at?: string
  view_count?: number
  series_slug?: string
}

export interface PageDto {
  url: string
}

export interface ChapterDetailDto extends ChapterDto {
  pages?: PageDto[]
}

export interface SeriesListResponse {
  data: SeriesDto[]
  meta?: Meta
}

export interface SeriesDetailResponse {
  series: SeriesDto
  recommended_series?: SeriesDto[]
}

export interface ChapterListResponse {
  data: ChapterDto[]
}

export interface ChapterDetailResponse {
  data: {
    chapter: ChapterDetailDto
    chapter_list?: ChapterDto[]
    series?: SeriesDto
    is_locked?: boolean
    /** Empty string on an open chapter; names the paywall on a closed one. */
    access_gate?: string
    unlock_time?: string | null
    /**
     * Navigation stubs. Only `number` and `slug` are populated — the rest of
     * the chapter fields come back zeroed, so these cannot stand in for a real
     * chapter record.
     */
    next_chapter?: ChapterDto
    prev_chapter?: ChapterDto
    comment_count?: number
  }
}

export interface GenresResponse {
  data: GenreDto[]
}
