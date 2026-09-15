/**
 * The slices of Comick's API and embedded page data this source reads.
 *
 * Comick answers three different shapes for what is nominally the same
 * record — the top list, the latest feed and the embedded detail blob all
 * describe a comic and none of them agree on the fields — so each is named
 * separately rather than forced into one optimistic interface.
 */

/**
 * A list as Comick's backend encodes one.
 *
 * The API is PHP, and `json_encode` turns an array whose keys are not a clean
 * `0..n` run into an object keyed by index-as-string. It happens whenever an
 * entry was filtered out upstream, which for `md_titles` is the majority of
 * series. Read these through `asArray`, never with `.map` directly.
 */
export type PhpArray<T> = T[] | Record<string, T>

/** A comic as the browse endpoints return it. */
export interface BrowseComicDto {
  id: number
  title: string
  slug: string
  /** Absolute, on one of the image hosts. */
  default_thumbnail?: string | null
  content_rating?: string | null
  country?: string | null
  chapter_count?: number | null
  demographic?: string | null
}

export interface BrowseResponse {
  data: PhpArray<BrowseComicDto>
  /** Present on the latest feed, absent on the top list. */
  per_page?: number
  next_cursor?: string | null
}

/** The `#comic-data` blob on a series page: the only full detail record. */
export interface ComicDataDto {
  hid: string
  slug: string
  title: string
  /** 1 ongoing, 2 completed, 3 cancelled, 4 hiatus. */
  status?: number | null
  /** With status 2, distinguishes "finished" from "fully translated". */
  translation_completed?: boolean | null
  country?: string | null
  content_rating?: string | null
  demographic_name?: string | null
  year?: number | null
  /** An HTML fragment, not plain text. */
  desc?: string | null
  default_thumbnail?: string | null
  authors?: PhpArray<{ name: string }> | null
  artists?: PhpArray<{ name: string }> | null
  md_comic_md_genres?: PhpArray<{ md_genres: { name: string } }> | null
  md_titles?: PhpArray<{ title: string }> | null
}

export interface ChapterDto {
  /** The site's own chapter key, and what a chapter url is addressed by. */
  hid: string
  /** A decimal string, or null on an unnumbered extra. */
  chap?: string | null
  vol?: string | null
  title?: string | null
  lang?: string | null
  publish_at?: string | null
  group_name?: PhpArray<string> | null
}

export interface ChapterListResponse {
  data: PhpArray<ChapterDto>
  pagination?: {
    current_page: number
    last_page: number
  }
}

/** The `#sv-data` blob on a chapter page: its page images, in order. */
export interface ChapterPageData {
  chapter: {
    images: PhpArray<{ url: string }>
  }
}

/** `/api/metadata`: the filter vocabulary, fetched once and cached by the app. */
export interface MetadataResponse {
  genres?: PhpArray<{ name: string; slug: string }>
  demographics?: PhpArray<{ id: number; name: string }>
  comic_type?: PhpArray<{ id: string; name: string }>
  comic_status?: PhpArray<{ id: number; name: string }>
}
