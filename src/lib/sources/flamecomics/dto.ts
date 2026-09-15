/**
 * The shapes Flame Comics' Next.js data routes return.
 *
 * Only the fields this source reads are named. The payloads carry a good deal
 * more — gallery blocks, blog posts, schedule objects — and naming those would
 * be inventing a contract the site never published.
 */

export interface SeriesDto {
  /** Null on a draft row, which is why every list is filtered before use. */
  series_id: number | null
  title: string
  description?: string | null
  /** Filename under the series' CDN folder, e.g. `thumbnail.webp`. */
  cover?: string | null
  /** Unix seconds. Used as a cache-buster on the cover, as the site does. */
  last_edit?: number | null
  type?: string | null
  status?: string | null
  language?: string | null
  country?: string | null
  author?: string[] | null
  artist?: string[] | null
  publisher?: string[] | null
  categories?: string[] | null
  tags?: string[] | null
  altTitles?: string[] | null
  /** 1 is the most popular. Absent on the latest-updates payload. */
  popularityRank?: number | null
  likes?: number | null
}

export interface ChapterDto {
  series_id: number
  /** The site's own chapter key, and the last segment of a chapter url. */
  token: string
  /** A decimal string, e.g. `16.00`. */
  chapter: string
  title?: string | null
  /** Unix seconds. */
  release_date: number
}

export interface BrowseResponse {
  pageProps: {
    series: SeriesDto[]
  }
}

export interface LatestResponse {
  pageProps: {
    latestEntries?: {
      blocks?: { series?: SeriesDto[] }[]
    }
  }
}

export interface SeriesDetailResponse {
  pageProps: {
    series: SeriesDto
    chapters?: ChapterDto[]
  }
}

export interface ChapterDetailResponse {
  pageProps: {
    chapter: {
      series_id: number
      token: string
      release_date: number
      /** Keyed by page index as a string, in reading order. */
      images: Record<string, { name: string }>
    }
  }
}

/** The `__NEXT_DATA__` blob on any page, read only for the build id. */
export interface NextData {
  buildId: string
}
