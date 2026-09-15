/**
 * The library read: one grouped query that applies Mihon's filters, sorts, and
 * computes the unread/downloaded badge counts. Doing it in SQL keeps the page
 * to a single round trip to the database worker instead of one per series.
 */

import { and, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { CHAPTER_FILTERS_KEY_PREFIX } from '@/lib/chapters/filter-state'
import { findSourceIdByName } from '@/lib/sources/catalog'
import type { ContentKind, MangaStatus } from '@/lib/sources/types'
import { HIDDEN, PRESENT, categoryKey, memberKey } from '@/lib/sync/fact-kinds'
import { bumpChangeSignal } from './change-signal'
import { db, getDeviceId, transact } from './client'
import { assertFacts, chapterKeysOf, seriesKeysOf } from './facts'
import { categories, chapters, manga, mangaCategory, settings } from './schema'

/** 0 = ignore, 1 = only these, 2 = only the others. Mirrors Mihon. */
export type LibraryTriState = 0 | 1 | 2

export interface LibraryFilters {
  downloaded: LibraryTriState
  unread: LibraryTriState
  started: LibraryTriState
  bookmarked: LibraryTriState
  completed: LibraryTriState
}

export const DEFAULT_LIBRARY_FILTERS: LibraryFilters = {
  downloaded: 0,
  unread: 0,
  started: 0,
  bookmarked: 0,
  completed: 0,
}

export type LibrarySortKey =
  | 'alphabetical'
  | 'lastRead'
  | 'lastChecked'
  | 'unreadCount'
  | 'totalChapters'
  | 'latestChapter'
  | 'dateAdded'
  | 'random'

export interface LibrarySort {
  key: LibrarySortKey
  ascending: boolean
}

export const DEFAULT_LIBRARY_SORT: LibrarySort = {
  key: 'alphabetical',
  ascending: true,
}

export interface LibraryQueryOptions {
  filters?: LibraryFilters
  sort?: LibrarySort
  search?: string
  /** `null` or omitted means every favourite, whatever its categories. */
  categoryId?: string | null
  /** Omitted means comics and novels together. */
  kind?: ContentKind
  /** Keeps the `random` order stable between refetches of the same view. */
  randomSeed?: number
}

/** A favourite plus the aggregates the grid renders as badges. */
export interface LibraryEntry {
  id: string
  sourceId: string
  url: string
  title: string
  author: string | null
  artist: string | null
  description: string | null
  genres: string[] | null
  status: MangaStatus
  thumbnailUrl: string | null
  memo: Record<string, unknown> | null
  dateAdded: number | null
  lastRead: number | null
  updatedAt: number
  totalChapters: number
  unreadCount: number
  downloadedCount: number
  /** Newest chapter upload time, or null when nothing has a date. */
  latestUpload: number | null
}

// The left join produces one all-null chapter row for a series with no
// chapters, which every `case` below scores as 0 — so the counts stay honest.
const TOTAL_CHAPTERS = sql<number>`count(${chapters.id})`

/**
 * The group a series is followed from, read off the same `settings` row the
 * series page writes (see `chapterFiltersKey`), joined below. Null when no
 * group has been chosen, in which case every chapter counts.
 */
const FOLLOWED_GROUP = sql<string | null>`json_extract(${settings.value}, '$.scanlators[0]')`

/** Whether the joined chapter belongs to the followed group, or there is none. */
const IN_FOLLOWED_GROUP = sql`(${FOLLOWED_GROUP} is null or coalesce(${chapters.scanlator}, '') = ${FOLLOWED_GROUP})`

// Unread and downloaded are what the badges show, so they count the followed
// group alone: on an aggregator the other groups are copies of the same
// chapters, and counting them tells the reader about chapters they will
// never open.
const UNREAD_COUNT = sql<number>`coalesce(sum(case when ${chapters.id} is not null and ${chapters.read} = 0 and ${IN_FOLLOWED_GROUP} then 1 else 0 end), 0)`

const DOWNLOADED_COUNT = sql<number>`coalesce(sum(case when ${chapters.downloaded} = 1 and ${IN_FOLLOWED_GROUP} then 1 else 0 end), 0)`

/** Ties the series to its chapter-filter setting, if it has one. */
const FOLLOWED_SETTING_JOIN = sql`${settings.key} = ${CHAPTER_FILTERS_KEY_PREFIX} || ${manga.sourceId} || ':' || ${manga.url}`

const BOOKMARKED_COUNT = sql<number>`coalesce(sum(case when ${chapters.bookmarked} = 1 then 1 else 0 end), 0)`

/** "Started" in Mihon: at least one chapter opened past page one, or read. */
const STARTED_COUNT = sql<number>`coalesce(sum(case when ${chapters.lastPageRead} > 0 or ${chapters.read} = 1 then 1 else 0 end), 0)`

const LATEST_UPLOAD = sql<number | null>`max(${chapters.dateUpload})`

/** The columns the grid draws. See `queryLibraryCards`. */
export type LibraryCard = Pick<
  LibraryEntry,
  | 'id'
  | 'sourceId'
  | 'url'
  | 'title'
  | 'status'
  | 'thumbnailUrl'
  | 'memo'
  | 'unreadCount'
  | 'downloadedCount'
>

/**
 * The where/having/order the two reads below share.
 *
 * Both apply the same filters to the same rows; they differ only in how many
 * columns they carry back. Built once so a filter fixed in one cannot go on
 * being wrong in the other.
 */
function libraryQueryParts(options: LibraryQueryOptions) {
  const filters = options.filters ?? DEFAULT_LIBRARY_FILTERS
  const sort = options.sort ?? DEFAULT_LIBRARY_SORT

  const where: (SQL | undefined)[] = [eq(manga.favorite, true)]

  if (filters.completed === 1) where.push(eq(manga.status, 'completed'))
  if (filters.completed === 2) where.push(ne(manga.status, 'completed'))

  if (options.kind) where.push(eq(manga.contentKind, options.kind))

  if (options.categoryId) {
    where.push(
      sql`exists (select 1 from ${mangaCategory} where ${mangaCategory.mangaId} = ${manga.id} and ${mangaCategory.categoryId} = ${options.categoryId})`,
    )
  }

  where.push(...searchConditions(options.search ?? ''))

  const having: (SQL | undefined)[] = [
    triCondition(DOWNLOADED_COUNT, filters.downloaded),
    triCondition(UNREAD_COUNT, filters.unread),
    triCondition(STARTED_COUNT, filters.started),
    triCondition(BOOKMARKED_COUNT, filters.bookmarked),
  ]

  return {
    where: and(...where),
    having: and(...having),
    order: orderBy(sort, options.randomSeed ?? 1),
  }
}

/**
 * Every column of every matching favourite.
 *
 * What the update checker wants: it turns each row back into an `SManga` to
 * hand to a source, so it needs the description and genres the grid has no use
 * for. Screens that only draw tiles should call `queryLibraryCards` instead.
 */
export async function queryLibrary(
  options: LibraryQueryOptions = {},
): Promise<LibraryEntry[]> {
  const { where, having, order } = libraryQueryParts(options)

  const rows = await db
    .select({
      id: manga.id,
      sourceId: manga.sourceId,
      url: manga.url,
      title: manga.title,
      author: manga.author,
      artist: manga.artist,
      description: manga.description,
      genres: manga.genres,
      status: manga.status,
      thumbnailUrl: manga.thumbnailUrl,
      memo: manga.memo,
      dateAdded: manga.dateAdded,
      lastRead: manga.lastRead,
      updatedAt: manga.updatedAt,
      totalChapters: TOTAL_CHAPTERS,
      unreadCount: UNREAD_COUNT,
      downloadedCount: DOWNLOADED_COUNT,
      latestUpload: LATEST_UPLOAD,
    })
    .from(manga)
    .leftJoin(chapters, eq(chapters.mangaId, manga.id))
    .leftJoin(settings, FOLLOWED_SETTING_JOIN)
    .where(where)
    .groupBy(manga.id)
    .having(having)
    .orderBy(...order)

  return rows
}

/**
 * The same rows, carrying only what a tile or a compact row renders.
 *
 * Every result crosses the worker boundary by structured clone, and the
 * library re-runs this on each debounced keystroke, filter and sort. The
 * descriptions alone are the bulk of a wide row and the grid never draws one,
 * so a large library spent most of that copy on text going straight in the
 * bin. Sorting is unaffected: the columns it orders by are computed in SQL,
 * not read from the result.
 */
export async function queryLibraryCards(
  options: LibraryQueryOptions = {},
): Promise<LibraryCard[]> {
  const { where, having, order } = libraryQueryParts(options)

  const rows = await db
    .select({
      id: manga.id,
      sourceId: manga.sourceId,
      url: manga.url,
      title: manga.title,
      status: manga.status,
      thumbnailUrl: manga.thumbnailUrl,
      memo: manga.memo,
      unreadCount: UNREAD_COUNT,
      downloadedCount: DOWNLOADED_COUNT,
    })
    .from(manga)
    .leftJoin(chapters, eq(chapters.mangaId, manga.id))
    .leftJoin(settings, FOLLOWED_SETTING_JOIN)
    .where(where)
    .groupBy(manga.id)
    .having(having)
    .orderBy(...order)

  return rows
}

/**
 * Favourites regardless of filter, search or category — what the "All" tab
 * counts, and what tells an empty library apart from an empty result.
 */
export async function countFavorites(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(manga)
    .where(eq(manga.favorite, true))
  return row?.count ?? 0
}

/**
 * Favourites split by content kind, for the counts beside the Comics and
 * Novels tabs. Both keys are always present, so an empty kind reads as zero
 * rather than as a missing tab.
 */
export async function countFavoritesByKind(): Promise<
  Record<ContentKind, number>
> {
  const rows = await db
    .select({ kind: manga.contentKind, count: sql<number>`count(*)` })
    .from(manga)
    .where(eq(manga.favorite, true))
    .groupBy(manga.contentKind)

  const counts: Record<ContentKind, number> = { comic: 0, novel: 0 }
  for (const row of rows) counts[row.kind] = row.count
  return counts
}

function triCondition(
  expression: SQL<number>,
  state: LibraryTriState,
): SQL | undefined {
  if (state === 1) return sql`${expression} > 0`
  if (state === 2) return sql`${expression} = 0`
  return undefined
}

function orderBy(sort: LibrarySort, seed: number): SQL[] {
  const direction = sort.ascending ? asc : desc
  // Title then id break ties, so two refetches of the same view agree.
  return [direction(sortExpression(sort.key, seed)), asc(manga.title), asc(manga.id)]
}

function sortExpression(key: LibrarySortKey, seed: number): SQL {
  switch (key) {
    case 'alphabetical':
      return sql`${manga.title} collate nocase`
    case 'lastRead':
      return sql`coalesce(${manga.lastRead}, 0)`
    case 'lastChecked':
      return sql`${manga.updatedAt}`
    case 'unreadCount':
      return sql`${UNREAD_COUNT}`
    case 'totalChapters':
      return sql`${TOTAL_CHAPTERS}`
    case 'latestChapter':
      return sql`coalesce(${LATEST_UPLOAD}, 0)`
    case 'dateAdded':
      return sql`coalesce(${manga.dateAdded}, 0)`
    case 'random':
      return randomExpression(seed)
  }
}

/**
 * SQLite has no seeded `random()`, and an unseeded one would reshuffle on every
 * refetch. The trailing characters of a ULID are its random component, so
 * scrambling them by the caller's seed gives an order that looks arbitrary but
 * survives a refetch.
 */
function randomExpression(seed: number): SQL {
  const safeSeed = (Math.abs(Math.trunc(seed)) % 999983) + 2
  return sql`(((unicode(substr(${manga.id}, -1)) * 7919) + (unicode(substr(${manga.id}, -2, 1)) * 104729) + (unicode(substr(${manga.id}, -3, 1)) * 1299709)) * ${safeSeed}) % 100003`
}

// ------------------------------------------------------------------ search --

type SearchField = 'any' | 'title' | 'author' | 'genre' | 'source'

interface SearchTerm {
  field: SearchField
  value: string
}

/**
 * The parsed query.
 *
 * ```
 * query  := or
 * or     := and ( ("OR" | "||") and )*
 * and    := unary+                        // whitespace is an implicit AND
 * unary  := "-" unary | "(" query ")" | term
 * term   := [ field ":" ] text            // double quotes hold a phrase
 * ```
 *
 * AND binds tighter than OR, so `a b OR c` reads as `(a AND b) OR c`.
 */
type SearchNode =
  | ({ kind: 'term' } & SearchTerm)
  | { kind: 'not'; child: SearchNode }
  | { kind: 'and'; children: SearchNode[] }
  | { kind: 'or'; children: SearchNode[] }

const PREFIXES: Record<string, SearchField> = {
  title: 'title',
  author: 'author',
  genre: 'genre',
  src: 'source',
  source: 'source',
}

function searchConditions(input: string): SQL[] {
  const node = parseSearch(input)
  return node ? [nodeCondition(node)] : []
}

/** `undefined` when the input holds no terms, which matches everything. */
export function parseSearch(input: string): SearchNode | undefined {
  return parseQuery({ tokens: tokenize(input), index: 0 })
}

// -------------------------------------------------------------- tokenizing --

type Token =
  | { kind: 'text'; value: string }
  | { kind: 'or' }
  | { kind: 'not' }
  | { kind: 'open' }
  | { kind: 'close' }

/**
 * Splits on whitespace, with double quotes holding a phrase together.
 *
 * The operators only claim characters that could not belong to a term: `(`
 * opens a group at the start of a token, `-` negates at the start of a token,
 * and `)` closes a group only while one is open. So `Fate/stay` keeps its
 * slash, `spy-family` keeps its dash and `Chainsaw Man (2018)` keeps its
 * parentheses.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let current = ''
  let inQuotes = false
  let hadQuote = false
  let depth = 0

  const flush = () => {
    if (current) {
      // A quoted `"or"` is a word the reader wants to find, not an operator.
      const operator = !hadQuote && (current === '||' || current.toLowerCase() === 'or')
      tokens.push(operator ? { kind: 'or' } : { kind: 'text', value: current })
    }
    current = ''
    hadQuote = false
  }

  for (const char of input) {
    if (char === '"') {
      inQuotes = !inQuotes
      hadQuote = true
      continue
    }
    if (inQuotes) {
      current += char
      continue
    }
    if (/\s/.test(char)) {
      flush()
      continue
    }
    if (char === '(' && !current) {
      flush()
      depth += 1
      tokens.push({ kind: 'open' })
      continue
    }
    if (char === ')' && depth > 0) {
      flush()
      depth -= 1
      tokens.push({ kind: 'close' })
      continue
    }
    if (char === '-' && !current && !hadQuote) {
      tokens.push({ kind: 'not' })
      continue
    }
    current += char
  }
  flush()
  return tokens
}

// ----------------------------------------------------------------- parsing --

interface TokenCursor {
  readonly tokens: readonly Token[]
  index: number
}

function peek(cursor: TokenCursor): Token | undefined {
  return cursor.tokens[cursor.index]
}

function advance(cursor: TokenCursor): void {
  cursor.index += 1
}

/**
 * Half-written queries reach the parser on every keystroke, so nothing here
 * throws: a dangling `OR` or `-` is dropped, an unclosed `(` closes at the end
 * of the input, and a `)` with no group open never became an operator in the
 * first place — it stays part of the term.
 */
function parseQuery(cursor: TokenCursor): SearchNode | undefined {
  const children: SearchNode[] = []
  const first = parseAnd(cursor)
  if (first) children.push(first)

  while (peek(cursor)?.kind === 'or') {
    advance(cursor)
    const right = parseAnd(cursor)
    if (right) children.push(right)
  }

  if (children.length === 0) return undefined
  return children.length === 1 ? children[0] : { kind: 'or', children }
}

function parseAnd(cursor: TokenCursor): SearchNode | undefined {
  const children: SearchNode[] = []

  for (;;) {
    const token = peek(cursor)
    // `or` and `close` belong to the caller; every other token is consumed by
    // `parseUnary`, so the loop always makes progress.
    if (!token || token.kind === 'or' || token.kind === 'close') break
    const node = parseUnary(cursor)
    if (node) children.push(node)
  }

  if (children.length === 0) return undefined
  return children.length === 1 ? children[0] : { kind: 'and', children }
}

function parseUnary(cursor: TokenCursor): SearchNode | undefined {
  const token = peek(cursor)
  if (!token || token.kind === 'or' || token.kind === 'close') return undefined
  advance(cursor)

  if (token.kind === 'not') {
    const child = parseUnary(cursor)
    return child ? { kind: 'not', child } : undefined
  }
  if (token.kind === 'open') {
    const inner = parseQuery(cursor)
    if (peek(cursor)?.kind === 'close') advance(cursor)
    return inner
  }
  return { kind: 'term', ...searchTerm(token.value) }
}

function searchTerm(text: string): SearchTerm {
  const separator = text.indexOf(':')
  if (separator > 0) {
    const field = PREFIXES[text.slice(0, separator).toLowerCase()]
    const value = text.slice(separator + 1).trim()
    if (field && value) return { field, value }
  }
  return { field: 'any', value: text }
}

// -------------------------------------------------------------- conditions --

function nodeCondition(node: SearchNode): SQL {
  switch (node.kind) {
    case 'term':
      return termCondition(node)
    case 'not':
      // `like` against a null column is null, and `not null` is null — which
      // would drop the very rows a negation is meant to keep.
      return sql`not coalesce(${nodeCondition(node.child)}, 0)`
    case 'and':
      return and(...node.children.map(nodeCondition)) ?? sql`1 = 1`
    case 'or':
      return orAll(node.children.map(nodeCondition))
  }
}

function termCondition(term: SearchTerm): SQL {
  const pattern = likePattern(term.value)

  switch (term.field) {
    case 'title':
      return contains(sql`${manga.title}`, pattern)
    case 'author':
      // `author:` covers the artist too: sources disagree about which field a
      // credit belongs in, and a reader searching a name means either.
      return orAll([
        contains(sql`${manga.author}`, pattern),
        contains(sql`${manga.artist}`, pattern),
      ])
    case 'genre':
      // `genres` is a JSON array — `["Action","Dark Fantasy"]` — so searching
      // for the quoted element matches a whole genre instead of a substring of
      // the list, and `fantasy` stops hitting "Dark Fantasy".
      return contains(sql`coalesce(${manga.genres}, '')`, jsonElementPattern(term.value))
    case 'source': {
      // A display name identifies exactly one source, so resolve it to that id;
      // anything else keeps the substring match against the id itself.
      const named = findSourceIdByName(term.value)
      if (named) return eq(manga.sourceId, named)
      return contains(sql`${manga.sourceId}`, pattern)
    }
    case 'any':
      return orAll([
        contains(sql`${manga.title}`, pattern),
        contains(sql`${manga.author}`, pattern),
        contains(sql`${manga.artist}`, pattern),
      ])
  }
}

function contains(column: SQL, pattern: string): SQL {
  return sql`${column} like ${pattern} escape '\\'`
}

function orAll(conditions: SQL[]): SQL {
  return or(...conditions) ?? sql`1 = 1`
}

/** `%` and `_` in the user's text are literal, not wildcards. */
function likePattern(value: string): string {
  return `%${escapeLike(value)}%`
}

/** One complete string of a JSON array, quotes included. */
function jsonElementPattern(value: string): string {
  return `%"${escapeLike(value)}"%`
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

// --------------------------------------------------------------- mutations --

/**
 * Marks every chapter of the listed series read.
 *
 * Deliberately does not write history rows: a bulk mark is not reading, and a
 * long series would bury the history page under one entry per chapter.
 */
export async function markMangaRead(
  mangaIds: readonly string[],
  read = true,
): Promise<void> {
  if (mangaIds.length === 0) return
  const updatedAt = Date.now()
  const deviceId = getDeviceId()

  await transact(async (tx) => {
    const rows = await tx
      .select({ id: chapters.id })
      .from(chapters)
      .where(
        and(
          inArray(chapters.mangaId, [...mangaIds]),
          eq(chapters.read, !read),
        ),
      )
    if (rows.length === 0) return

    await tx
      .update(chapters)
      .set({
        read,
        updatedAt,
        deviceId,
        // Local only, for the Mihon import's forward-only merge. Sync says the
        // same thing with a new generation of the position fact below.
        ...(read ? {} : { progressResetAt: updatedAt, lastPageRead: 0 }),
      })
      .where(inArray(chapters.id, rows.map((row) => row.id)))

    const keys = await chapterKeysOf(
      tx,
      rows.map((row) => row.id),
    )
    await assertFacts(
      tx,
      keys.flatMap((key) => [
        { kind: 'read' as const, key: key.key, state: read ? PRESENT : HIDDEN },
        ...(read ? [] : [{ kind: 'pos' as const, key: key.key, val: 0, bump: true }]),
      ]),
    )
  })
  bumpChangeSignal(mangaIds.length)
}

/**
 * Bulk unfavourite. `dateAdded` is left in place so re-adding a series keeps
 * its original position under "Date added", matching `setFavorite`.
 */
export async function removeFromLibrary(
  mangaIds: readonly string[],
): Promise<void> {
  if (mangaIds.length === 0) return
  const updatedAt = Date.now()
  const deviceId = getDeviceId()

  await transact(async (tx) => {
    await tx
      .update(manga)
      .set({ favorite: false, updatedAt, deviceId })
      .where(inArray(manga.id, [...mangaIds]))

    const series = await seriesKeysOf(tx, mangaIds)

    // The assignments go too: a series out of the library is in no category.
    const links = await tx
      .select({
        mangaId: mangaCategory.mangaId,
        name: categories.name,
      })
      .from(mangaCategory)
      .innerJoin(categories, eq(categories.id, mangaCategory.categoryId))
      .where(inArray(mangaCategory.mangaId, [...mangaIds]))

    await tx
      .delete(mangaCategory)
      .where(inArray(mangaCategory.mangaId, [...mangaIds]))

    await assertFacts(tx, [
      // `val` drops to zero with the series: the date it was added is only
      // meaningful while it is kept, and a zero is what lets a peer's "still in
      // my library" win an otherwise even generation.
      ...[...series.values()].map((row) => ({
        kind: 'lib' as const,
        key: row.key,
        state: HIDDEN,
        val: 0,
      })),
      ...links.flatMap((link) => {
        const row = series.get(link.mangaId)
        if (!row) return []
        return [
          {
            kind: 'member' as const,
            key: memberKey(categoryKey(link.name), row.key),
            state: HIDDEN,
          },
        ]
      }),
    ])
  })
  bumpChangeSignal(mangaIds.length)
}
