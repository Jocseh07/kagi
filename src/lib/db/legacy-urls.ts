/**
 * Series and chapter urls as older builds stored them.
 *
 * Every source now addresses a work as `/series/<slug>` and a chapter as
 * `/series/<slug>/chapter/<key>`, because the app rebuilds both from route
 * parameters alone and neither segment may carry a slash. Before that a source
 * stored the site's own path, which the route cannot carry: the slug came back
 * with its slashes intact and the series was re-addressed as
 * `/series//manga/<slug>`, which is a page on no site.
 *
 * Rows written under the old shapes are still in the database and are what
 * `V11` in migrate.ts rewrites. One generation back is all this covers — the
 * shapes written by the build immediately before the change — so a url that
 * matches nothing here is left exactly as it is.
 */

/** What one source's previous shape looked like. */
interface LegacyShape {
  /**
   * The current series url a legacy one stands for, or null when the url is
   * already current. Only ever asked about a `manga` row.
   */
  series?: (url: string) => string | null
  /**
   * The chapter key a legacy chapter url carries, or null when the url is
   * already current. The key is the last segment of the current shape.
   */
  chapterKey?: (url: string) => string | null
}

/** The first capture of `pattern`, or null. */
function capture(pattern: RegExp, url: string): string | null {
  return pattern.exec(url)?.[1] ?? null
}

/** A query parameter of a url that is a path and query only. */
function param(url: string, name: string): string | null {
  const query = url.split('?')[1]
  if (!query) return null
  return new URLSearchParams(query.split('#')[0]).get(name)
}

const LEGACY_SHAPES: Record<string, LegacyShape> = {
  /** `/manga/<slug>` and `/manga/<slug>/<key>`, the site's own paths. */
  mangakatana: {
    series: (url) => {
      const slug = capture(/^\/manga\/([^/?#]+)$/, url)
      return slug ? `/series/${slug}` : null
    },
    chapterKey: (url) => capture(/^\/manga\/[^/?#]+\/([^/?#]+)$/, url),
  },

  /** `/comic/<slug>` and `/comic/<slug>/<key>`. */
  comick: {
    series: (url) => {
      const slug = capture(/^\/comic\/([^/?#]+)$/, url)
      return slug ? `/series/${slug}` : null
    },
    chapterKey: (url) => capture(/^\/comic\/[^/?#]+\/([^/?#]+)$/, url),
  },

  /**
   * `/manga/<uuid>` and `/chapter/<uuid>`. The chapter path named no series at
   * all, so the series it belongs to is recovered from its own row rather than
   * from the url.
   */
  mangadex: {
    series: (url) => {
      const id = capture(/^\/manga\/([0-9a-f-]{36})$/i, url)
      return id ? `/series/${id}` : null
    },
    chapterKey: (url) => capture(/^\/chapter\/([0-9a-f-]{36})$/i, url),
  },

  /** `#/titles/<id>` and `#/viewer/<id>`, the site's own fragment routes. */
  mangaplus: {
    series: (url) => {
      const id = capture(/^#\/titles\/(\d+)$/, url)
      return id ? `/series/${id}` : null
    },
    chapterKey: (url) => capture(/^#\/viewer\/(\d+)$/, url),
  },

  /** `/serie/<slug>` and `/serie/<slug>/<key>`, plus the older `/webtoon/`. */
  toonily: {
    series: (url) => {
      const slug = capture(/^\/(?:serie|webtoon)\/([^/?#]+)$/, url)
      return slug ? `/series/${slug}` : null
    },
    chapterKey: (url) =>
      capture(/^\/(?:serie|webtoon)\/[^/?#]+\/([^/?#]+)$/, url),
  },

  /**
   * The site's own listing and viewer addresses, where the identity sits in
   * the query rather than the path: `/<lang>/<genre>/<name>/list?title_no=N`
   * and `/<lang>/<genre>/<name>/<ep>/viewer?title_no=N&episode_no=M`.
   */
  webtoons: {
    series: (url) => {
      const titleNo = param(url, 'title_no')
      return titleNo ? `/series/${titleNo}` : null
    },
    chapterKey: (url) => param(url, 'episode_no'),
  },

  /**
   * The series id was already the slug, but the site's path carries a title
   * segment after it (`/series/<id>/Some-Title`) that the route cannot hold.
   * Chapters were stored as the site's `/chapters/<id>`, which names no series.
   */
  weebcentral: {
    series: (url) => {
      const id = capture(/^\/series\/([A-Za-z0-9]+)\/[^?#]+$/, url)
      return id ? `/series/${id}` : null
    },
    chapterKey: (url) => capture(/^\/chapters\/([A-Za-z0-9]+)$/, url),
  },
}

// Flame Comics is deliberately absent: its series urls were already current
// and its chapters, which hung off them without `/chapter/`, are what V11 in
// migrate.ts moves.

/** The sources with anything to rewrite, for scoping the migration's reads. */
export const LEGACY_URL_SOURCE_IDS = Object.keys(LEGACY_SHAPES)

/** The current form of a stored series url, or null when it is already current. */
export function currentSeriesUrl(sourceId: string, url: string): string | null {
  return LEGACY_SHAPES[sourceId]?.series?.(url) ?? null
}

/**
 * The current form of a stored chapter url, or null when nothing changes.
 *
 * A chapter is addressed relative to its series, so both forms of the series
 * url are needed: the legacy one to recognise a chapter that was already
 * current and only needs its prefix moved, and the current one to build the
 * answer.
 */
export function currentChapterUrl(
  sourceId: string,
  legacySeriesUrl: string,
  seriesUrl: string,
  chapterUrl: string,
): string | null {
  const key = LEGACY_SHAPES[sourceId]?.chapterKey?.(chapterUrl)
  if (key) return `${seriesUrl}/chapter/${key}`

  const prefix = `${legacySeriesUrl}/chapter/`
  if (seriesUrl !== legacySeriesUrl && chapterUrl.startsWith(prefix)) {
    return `${seriesUrl}/chapter/${chapterUrl.slice(prefix.length)}`
  }

  return null
}
