/**
 * NovelMTL's API shapes.
 *
 * Taken from live responses rather than from a published schema, which is why
 * every field that is not needed to build an `SManga` is typed as optional:
 * the site is a Quasar app whose API is internal, so nothing obliges it to keep
 * emitting any particular key.
 */

/**
 * One novel, as it appears in every listing and in the SSR state of a novel
 * page. Both carry the same shape, which is why a listing row needs no
 * follow-up request to be complete.
 *
 * There is no cover field. Not omitted here — the site has none at all; see the
 * note on `toSManga` in ./index.ts.
 */
export interface NovelDto {
  id: number
  title: string
  slug: string
  chinese_title?: string | null
  /** Where the machine translation was lifted from. Shown as nothing. */
  original_url?: string | null
  author?: string | null
  genres?: string[] | null
  description?: string | null
  clicks?: number | null
  /** Chapter count. The site calls a chapter a "page" throughout. */
  page_count?: number | null
  created_date?: string | null
}

/**
 * A listing response.
 *
 * `next_cursor` is a row offset rendered as a string, and it is null on the
 * last page — the only reliable end-of-list signal, since `items` comes back
 * full whenever the total is a multiple of the page size.
 */
export interface NovelListResponse {
  items?: NovelDto[] | null
  next_cursor?: string | null
  total?: number | null
}

/** One chapter. `content` is plain text, not HTML. */
export interface PageDto {
  id?: number
  novel_id?: number
  page_number?: number
  content?: string | null
}
