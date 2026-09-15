/**
 * Wire shapes for mangadot.net.
 *
 * The API is undocumented; these were read off the site's own client bundles
 * (`useChapterList-*.js`, `ChapterReaderPage-*.js`, `SearchPage-*.js`) and then
 * checked against live responses. As with Asura, anything past the identity
 * keys is optional — nullable columns come back as `null` or are dropped, and
 * a few (`authors`, `artists`) arrive double-encoded. See the notes below.
 */

export interface Pagination {
  current_page: number
  total_pages: number
  total_results: number
  per_page: number
  next_cursor?: string
}

/** One facet bucket from `/api/search?facets=1`. */
export interface FacetBucket {
  key: string
  count: number
}

export interface Facets {
  genres?: FacetBucket[]
  tags?: FacetBucket[]
  origin?: FacetBucket[]
  content_rating?: FacetBucket[]
  status?: FacetBucket[]
  year?: FacetBucket[]
  rating?: FacetBucket[]
}

/** A series as it appears in a listing. Carries enough to skip a detail call. */
export interface MangaSummaryDto {
  id: number
  title: string
  /** Site-relative, e.g. `/uploads/80f3902e….webp`. */
  photo?: string
  description?: string
  genres?: string[]
  /** `Ongoing` or `Completed`. Capitalised — the API is case-sensitive here. */
  status?: string
  /** `Yes` or `No`. Orthogonal to `status`, not one of its values. */
  hiatus?: string
  year?: number
  chapter_count?: number
  latest_chapter_number?: number
  last_chapter_date?: string
  country_of_origin?: string
  content_rating?: string
  is_adult?: number | boolean
  avg_rating?: number
  is_longstrip?: boolean
}

export interface MangaDetailDto extends MangaSummaryDto {
  /**
   * A JSON *string* holding an array, not an array: `"[\"YUJU\"]"`. Both of
   * these have to be parsed a second time before use.
   */
  authors?: string
  artists?: string
  alt_titles?: string[]
  banner_image?: string
  date_added?: string
  view_count?: number
  tracked_count?: number
}

export interface SearchResponse {
  manga_list?: MangaSummaryDto[]
  pagination?: Pagination
  facets?: Facets
  /** Echoes the `search` term back. */
  query?: string
  search_engine?: string
}

export interface MangaDetailResponse {
  manga: MangaDetailDto
  total_chapters?: number
  latest_chapter_number?: number
  first_chapter_id?: number
  first_chapter_source?: string
  status_text?: string
}

/**
 * `/api/manga/{id}/chapters/list` returns a bare array, not an envelope.
 *
 * `source` decides which endpoint serves the images and how the site links to
 * the chapter, so it has to be carried on the chapter rather than re-derived.
 */
export interface ChapterListEntry {
  id: number
  chapter_number: number
  volume_number?: number | null
  chapter_title?: string | null
  language?: string
  group_id?: number | null
  group_name?: string | null
  group_slug?: string | null
  scanlator_name?: string | null
  date_added?: string
  page_count?: number
  /** `user` or `scraper`. */
  source?: string
  uploader_username?: string
}

export interface ChapterFilterOptions {
  languages?: string[]
  groups?: { id: string; name: string; slug: string; is_scanlator: boolean }[]
}

/** Site-relative image path plus intrinsic size; `w`/`h` are 0 when unknown. */
export interface ImageDto {
  url: string
  w?: number
  h?: number
  filename?: string
}

export interface ChapterImagesResponse {
  chapter?: ChapterListEntry
  manga?: MangaSummaryDto
  images?: ImageDto[]
  prev_chapter_id?: number | null
  next_chapter_id?: number | null
  prev_source?: string | null
  next_source?: string | null
  source?: string
}
