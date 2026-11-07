/**
 * Reads behind the home page. Read-only: nothing here changes a row.
 */

import { desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'

import type { ContentKind, MangaStatus } from '@/lib/sources/types'
import { db } from './client'
import { listHistory } from './history'
import type { HistoryItem } from './history'
import { DOWNLOADED_COUNT, FOLLOWED_SETTING_JOIN, UNREAD_COUNT } from './library'
import { chapters, manga, settings } from './schema'

const DAY_MS = 24 * 60 * 60 * 1000

/** A series read inside this window counts as being read; outside it, paused. */
export const READING_WINDOW_MS = 30 * DAY_MS

/** The chapter a "Resume" opens. */
export interface ResumeTarget {
  url: string
  name: string
  chapterNumber: number
  lastPageRead: number
  pageCount: number
  /** Whether the chapter after this one is saved on the device. */
  nextSaved: { name: string } | null
}

export interface ContinueItem {
  history: HistoryItem
  target: ResumeTarget
  contentKind: ContentKind
}

/**
 * Series read recently that still have something to read, newest first.
 *
 * The history row names the chapter last opened. While it is unread that is
 * where reading resumes; once read, it is the next unread chapter after it from
 * the same group, so an aggregator does not hand over another translation.
 */
export async function listContinueItems(
  limit = 4,
  now = Date.now(),
): Promise<ContinueItem[]> {
  const recent = (await listHistory(60)).filter(
    (item) => now - item.readAt <= READING_WINDOW_MS,
  )
  if (recent.length === 0) return []

  const ids = recent.map((item) => item.mangaId)
  const rows = await db
    .select({
      mangaId: chapters.mangaId,
      url: chapters.url,
      name: chapters.name,
      chapterNumber: chapters.chapterNumber,
      scanlator: chapters.scanlator,
      read: chapters.read,
      lastPageRead: chapters.lastPageRead,
      pageCount: chapters.pageCount,
      savedAt: chapters.savedAt,
    })
    .from(chapters)
    .where(inArray(chapters.mangaId, ids))

  const kinds = await db
    .select({ id: manga.id, contentKind: manga.contentKind })
    .from(manga)
    .where(inArray(manga.id, ids))
  const kindOf = new Map(kinds.map((row) => [row.id, row.contentKind]))

  const byManga = new Map<string, typeof rows>()
  for (const row of rows) {
    const list = byManga.get(row.mangaId)
    if (list) list.push(row)
    else byManga.set(row.mangaId, [row])
  }

  const items: ContinueItem[] = []
  for (const item of recent) {
    const group = (item.scanlator ?? '').trim()
    const sameGroup = (byManga.get(item.mangaId) ?? [])
      .filter((row) => (row.scanlator ?? '').trim() === group)
      .sort((a, b) => a.chapterNumber - b.chapterNumber)

    const current = sameGroup.find((row) => row.url === item.chapterUrl)
    const target =
      current && !current.read
        ? current
        : sameGroup.find(
            (row) => !row.read && row.chapterNumber > item.chapterNumber,
          )
    if (!target) continue

    const after = sameGroup.find(
      (row) => row.chapterNumber > target.chapterNumber,
    )
    items.push({
      history: item,
      contentKind: kindOf.get(item.mangaId) ?? 'comic',
      target: {
        url: target.url,
        name: target.name,
        chapterNumber: target.chapterNumber,
        lastPageRead: target.lastPageRead,
        pageCount: target.pageCount,
        nextSaved: after?.savedAt != null ? { name: after.name } : null,
      },
    })
    if (items.length >= limit) break
  }
  return items
}

export interface SavedSeries {
  mangaId: string
  sourceId: string
  url: string
  title: string
  thumbnailUrl: string | null
  memo: Record<string, unknown> | null
  savedCount: number
}

/** Series with chapters saved on this device, most recently saved first. */
export async function listSavedBySeries(): Promise<SavedSeries[]> {
  return db
    .select({
      mangaId: manga.id,
      sourceId: manga.sourceId,
      url: manga.url,
      title: manga.title,
      thumbnailUrl: manga.thumbnailUrl,
      memo: manga.memo,
      savedCount: sql<number>`count(*)`,
    })
    .from(chapters)
    .innerJoin(manga, eq(manga.id, chapters.mangaId))
    .where(isNotNull(chapters.savedAt))
    .groupBy(manga.id)
    .orderBy(desc(sql`max(${chapters.savedAt})`))
}

export interface LibraryProgress {
  id: string
  sourceId: string
  url: string
  title: string
  thumbnailUrl: string | null
  memo: Record<string, unknown> | null
  contentKind: ContentKind
  status: MangaStatus
  dateAdded: number | null
  lastRead: number | null
  total: number
  readCount: number
  startedCount: number
  /** The Library's badge counts, so a cover reads the same on both pages. */
  unreadCount: number
  downloadedCount: number
}

/** Every favourite with how far into it the reader is. */
export async function listLibraryProgress(): Promise<LibraryProgress[]> {
  return db
    .select({
      id: manga.id,
      sourceId: manga.sourceId,
      url: manga.url,
      title: manga.title,
      thumbnailUrl: manga.thumbnailUrl,
      memo: manga.memo,
      contentKind: manga.contentKind,
      status: manga.status,
      dateAdded: manga.dateAdded,
      lastRead: manga.lastRead,
      total: sql<number>`count(${chapters.id})`,
      readCount: sql<number>`coalesce(sum(case when ${chapters.read} = 1 then 1 else 0 end), 0)`,
      // Mihon's "started": a chapter opened past its first page, or read.
      startedCount: sql<number>`coalesce(sum(case when ${chapters.lastPageRead} > 0 or ${chapters.read} = 1 then 1 else 0 end), 0)`,
      unreadCount: UNREAD_COUNT,
      downloadedCount: DOWNLOADED_COUNT,
    })
    .from(manga)
    .leftJoin(chapters, eq(chapters.mangaId, manga.id))
    // At most one settings row per series, so the sums above are unchanged.
    .leftJoin(settings, FOLLOWED_SETTING_JOIN)
    .where(eq(manga.favorite, true))
    .groupBy(manga.id)
}

export interface LibraryGroups {
  notStarted: LibraryProgress[]
  paused: LibraryProgress[]
  caughtUp: LibraryProgress[]
}

/** Splits the library into what the home's Added tab shows, leaving out `readingIds`. */
export function groupLibraryForHome(
  rows: readonly LibraryProgress[],
  readingIds: ReadonlySet<string>,
): LibraryGroups {
  const groups: LibraryGroups = { notStarted: [], paused: [], caughtUp: [] }
  for (const row of rows) {
    if (readingIds.has(row.id)) continue
    if (row.startedCount === 0 && row.readCount === 0) groups.notStarted.push(row)
    else if (row.total > 0 && row.readCount === row.total) groups.caughtUp.push(row)
    else groups.paused.push(row)
  }
  groups.notStarted.sort((a, b) => (b.dateAdded ?? 0) - (a.dateAdded ?? 0))
  groups.paused.sort((a, b) => (b.lastRead ?? 0) - (a.lastRead ?? 0))
  groups.caughtUp.sort((a, b) => (b.lastRead ?? 0) - (a.lastRead ?? 0))
  return groups
}

/** The chapter a cover's read button opens. */
export interface ReadTarget {
  url: string
  chapterNumber: number
}

/** Unnumbered chapters (-1) sort after every numbered one. */
function byNumber(a: { chapterNumber: number }, b: { chapterNumber: number }): number {
  const left = a.chapterNumber < 0 ? Number.POSITIVE_INFINITY : a.chapterNumber
  const right = b.chapterNumber < 0 ? Number.POSITIVE_INFINITY : b.chapterNumber
  return left - right
}

/**
 * `next`: the first unread chapter, kept to the group of the furthest chapter
 * read so an aggregator does not hand over another translation. `saved`: the
 * first unread saved chapter, else the first saved one. Null when none fits.
 */
export async function findReadTarget(
  mangaId: string,
  mode: 'next' | 'saved',
): Promise<ReadTarget | null> {
  const rows = await db
    .select({
      url: chapters.url,
      chapterNumber: chapters.chapterNumber,
      scanlator: chapters.scanlator,
      read: chapters.read,
      savedAt: chapters.savedAt,
    })
    .from(chapters)
    .where(eq(chapters.mangaId, mangaId))
  rows.sort(byNumber)

  let pick: (typeof rows)[number] | undefined
  if (mode === 'saved') {
    const saved = rows.filter((row) => row.savedAt != null)
    pick = saved.find((row) => !row.read) ?? saved[0]
  } else {
    const unread = rows.filter((row) => !row.read)
    const read = rows.filter((row) => row.read)
    const furthest = read.filter((row) => row.chapterNumber >= 0).at(-1) ?? read.at(-1)
    const group = furthest ? (furthest.scanlator ?? '').trim() : null
    const sameGroup =
      group === null ? [] : unread.filter((row) => (row.scanlator ?? '').trim() === group)
    pick = sameGroup[0] ?? unread[0]
  }
  return pick ? { url: pick.url, chapterNumber: pick.chapterNumber } : null
}
