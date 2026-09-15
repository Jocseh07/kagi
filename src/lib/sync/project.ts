/**
 * Turning facts into the rows the app draws.
 *
 * The projection is deliberately dumb. Every question of who wins was settled
 * before a fact reached the ledger, so this writes what the ledger says and
 * never compares anything: no timestamps, no monotonic guards, no per-column
 * cases. If reading position appears to move backwards here, that is a
 * deliberate reset that already won its generation.
 *
 * Two facts create rows that were not there — a series and a history entry —
 * because a device that pulls a library it has never browsed has to draw
 * something before it can reach every source. Everything else waits: a fact for
 * a chapter this device has not fetched stays in the ledger and is applied by
 * `upsertChapters` when that chapter finally appears. Nothing is ever dropped
 * for want of a parent, which is what the old orphan filter was for.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import { CHUNK_SIZE, chunk } from '@/lib/db/chunk'
import { getDeviceId } from '@/lib/db/client'
import type { DbTransaction } from '@/lib/db/client'
import {
  categories,
  chapters,
  history,
  manga,
  mangaCategory,
  settings,
} from '@/lib/db/schema'
import type { Fact } from '@/lib/db/schema'
import { contentKindOfId } from '@/lib/sources/catalog'
import {
  HIDDEN,
  PRESENT,
  categoryKey,
  chapterLabel,
  chapterKey,
  isDeviceLocalSetting,
  partsOf,
  seriesKey,
  seriesKeyOf,
  seriesLabel,
} from './fact-kinds'
import type { FactKind } from './fact-kinds'

/**
 * Writes a batch of facts into the library tables.
 *
 * Kinds are applied in the order they are declared, which is dependency order:
 * a series and a category exist before anything points at them.
 */
export async function applyFacts(
  tx: DbTransaction,
  rows: readonly Fact[],
): Promise<void> {
  if (rows.length === 0) return

  const byKind = new Map<FactKind, Fact[]>()
  for (const row of rows) {
    const group = byKind.get(row.kind) ?? []
    group.push(row)
    byKind.set(row.kind, group)
  }

  await applyLib(tx, byKind.get('lib') ?? [])
  await applyCat(tx, byKind.get('cat') ?? [])
  // Before `read` and `pos`, not after: a history entry is the only fact that
  // carries a chapter's name and number, so it is the only one that can create
  // a chapter row this device has never fetched. Run the other way round, a
  // chapter read on another device would be skipped for having nothing to mark
  // and only appear after the series was next opened.
  await applyHist(tx, byKind.get('hist') ?? [])
  await applyRead(tx, byKind.get('read') ?? [])
  await applyPos(tx, byKind.get('pos') ?? [])
  await applyMember(tx, byKind.get('member') ?? [])
  await applySet(tx, byKind.get('set') ?? [])
}

// ------------------------------------------------------------- resolvers --

interface SeriesRow {
  id: string
  sourceId: string
  url: string
}

/**
 * Series ids for a set of series keys.
 *
 * Filtered on `url` alone and matched exactly in memory: a url is distinctive
 * enough that the query reads a handful of rows, and the alternative is an OR
 * of paired conditions that no index would serve any better.
 */
async function seriesByKey(
  tx: DbTransaction,
  keys: readonly string[],
): Promise<Map<string, SeriesRow>> {
  const wanted = new Set(keys)
  const urls = [...new Set([...wanted].map((key) => partsOf(key)[1] ?? ''))]
  const found = new Map<string, SeriesRow>()

  for (const group of chunk(urls, CHUNK_SIZE)) {
    if (group.length === 0) continue
    const rows = await tx
      .select({ id: manga.id, sourceId: manga.sourceId, url: manga.url })
      .from(manga)
      .where(inArray(manga.url, group))
    for (const row of rows) {
      const key = seriesKey(row.sourceId, row.url)
      if (wanted.has(key)) found.set(key, row)
    }
  }
  return found
}

/** Chapter ids for chapter keys, keyed by the full chapter key. */
async function chapterIdByKey(
  tx: DbTransaction,
  keys: readonly string[],
): Promise<Map<string, string>> {
  const wanted = new Set(keys)
  const seriesKeys = [...new Set([...wanted].map((key) => seriesKeyOf(key)))]
  const series = await seriesByKey(tx, seriesKeys)
  if (series.size === 0) return new Map()

  const byId = new Map<string, string>()
  for (const [key, row] of series) byId.set(row.id, key)

  const urls = [...new Set([...wanted].map((key) => partsOf(key)[2] ?? ''))]
  const found = new Map<string, string>()

  for (const group of chunk(urls, CHUNK_SIZE)) {
    if (group.length === 0) continue
    const rows = await tx
      .select({ id: chapters.id, mangaId: chapters.mangaId, url: chapters.url })
      .from(chapters)
      .where(and(inArray(chapters.url, group), inArray(chapters.mangaId, [...byId.keys()])))
    for (const row of rows) {
      const parent = byId.get(row.mangaId)
      if (!parent) continue
      const parts = partsOf(parent)
      const key = chapterKey(parts[0] ?? '', parts[1] ?? '', row.url)
      if (wanted.has(key)) found.set(key, row.id)
    }
  }
  return found
}

// ----------------------------------------------------------------- kinds --

async function applyLib(tx: DbTransaction, rows: readonly Fact[]): Promise<void> {
  if (rows.length === 0) return
  const updatedAt = Date.now()
  const deviceId = getDeviceId()

  const values = rows.map((row) => {
    const [sourceId = '', url = ''] = partsOf(row.key)
    const label = seriesLabel(row.payload)
    return {
      id: ulid(),
      updatedAt,
      deviceId,
      sourceId,
      url,
      // The url is a poor title, and deliberately so: it is visibly a
      // placeholder, and the first fetch of the series replaces it.
      title: label.t ?? url,
      thumbnailUrl: label.c ?? null,
      contentKind: contentKindOfId(sourceId),
      favorite: row.state === PRESENT,
      dateAdded: row.val > 0 ? row.val : null,
    }
  })

  for (const group of chunk(values, CHUNK_SIZE)) {
    await tx
      .insert(manga)
      .values(group)
      .onConflictDoUpdate({
        target: [manga.sourceId, manga.url],
        set: {
          favorite: sql`excluded."favorite"`,
          // Kept, never replaced: whichever device added the series first is
          // the honest answer, and "Date added" sorts by it on every device.
          dateAdded: sql`coalesce(${manga.dateAdded}, excluded."date_added")`,
          // Source data always beats a label. The exception is a title still
          // sitting at its placeholder, which anything is better than.
          title: sql`case when ${manga.title} = ${manga.url} then excluded."title" else ${manga.title} end`,
          thumbnailUrl: sql`coalesce(${manga.thumbnailUrl}, excluded."thumbnail_url")`,
        },
      })
  }
}

async function applyCat(tx: DbTransaction, rows: readonly Fact[]): Promise<void> {
  if (rows.length === 0) return
  const updatedAt = Date.now()
  const deviceId = getDeviceId()

  // Few enough that reading them all beats a query per fact, and the match is
  // on the folded name, which no index could serve anyway.
  const stored = await tx.select().from(categories)
  const byKey = new Map(stored.map((row) => [categoryKey(row.name), row]))

  for (const row of rows) {
    const existing = byKey.get(row.key)

    if (row.state === HIDDEN) {
      // The assignments go with it through the foreign key cascade; the
      // membership facts stay in the ledger and simply have nothing to apply.
      if (existing) await tx.delete(categories).where(eq(categories.id, existing.id))
      continue
    }

    const name = row.payload ?? row.key
    if (existing) {
      await tx
        .update(categories)
        .set({ name, order: row.val, updatedAt, deviceId })
        .where(eq(categories.id, existing.id))
    } else {
      const created = { id: ulid(), updatedAt, deviceId, name, order: row.val }
      await tx.insert(categories).values(created)
      byKey.set(row.key, created)
    }
  }
}

async function applyRead(tx: DbTransaction, rows: readonly Fact[]): Promise<void> {
  if (rows.length === 0) return
  const ids = await chapterIdByKey(tx, rows.map((row) => row.key))
  if (ids.size === 0) return

  const read: string[] = []
  const unread: string[] = []
  for (const row of rows) {
    const id = ids.get(row.key)
    if (!id) continue
    if (row.state === PRESENT) read.push(id)
    else unread.push(id)
  }

  for (const group of chunk(read, CHUNK_SIZE)) {
    if (group.length > 0) {
      await tx.update(chapters).set({ read: true }).where(inArray(chapters.id, group))
    }
  }
  for (const group of chunk(unread, CHUNK_SIZE)) {
    if (group.length > 0) {
      await tx
        .update(chapters)
        .set({ read: false, lastPageRead: 0 })
        .where(inArray(chapters.id, group))
    }
  }
}

async function applyPos(tx: DbTransaction, rows: readonly Fact[]): Promise<void> {
  if (rows.length === 0) return
  const ids = await chapterIdByKey(tx, rows.map((row) => row.key))
  if (ids.size === 0) return

  // Grouped by value so a first sync of a whole library is a statement per
  // distinct position rather than one per chapter. No `where last_page_read <`
  // guard: the ledger already decided this value wins, and a deliberate reset
  // is exactly the case that has to be allowed to move backwards.
  const byValue = new Map<number, string[]>()
  for (const row of rows) {
    const id = ids.get(row.key)
    if (!id) continue
    const group = byValue.get(row.val) ?? []
    group.push(id)
    byValue.set(row.val, group)
  }

  for (const [value, group] of byValue) {
    for (const batch of chunk(group, CHUNK_SIZE)) {
      await tx
        .update(chapters)
        .set({ lastPageRead: value })
        .where(inArray(chapters.id, batch))
    }
  }
}

async function applyHist(tx: DbTransaction, rows: readonly Fact[]): Promise<void> {
  if (rows.length === 0) return
  const updatedAt = Date.now()
  const deviceId = getDeviceId()

  const series = await seriesByKey(tx, rows.map((row) => seriesKeyOf(row.key)))
  if (series.size === 0) return

  // A history entry names a chapter this device may never have fetched, and it
  // carries the two fields needed to draw one. Creating the stub is what makes
  // a fresh device's history page real rather than empty.
  const stubs = rows
    .filter((row) => row.state === PRESENT)
    .flatMap((row) => {
      const parent = series.get(seriesKeyOf(row.key))
      const url = partsOf(row.key)[2]
      if (!parent || !url) return []
      const label = chapterLabel(row.payload)
      return [
        {
          id: ulid(),
          updatedAt,
          deviceId,
          mangaId: parent.id,
          url,
          name: label.n ?? url,
          chapterNumber: label.i ?? -1,
        },
      ]
    })

  for (const group of chunk(stubs, CHUNK_SIZE)) {
    if (group.length === 0) continue
    await tx
      .insert(chapters)
      .values(group)
      .onConflictDoUpdate({
        target: [chapters.mangaId, chapters.url],
        // The stored chapter came from the source itself and is better than any
        // label, except where it is still a placeholder for a url.
        set: {
          name: sql`case when ${chapters.name} = ${chapters.url} then excluded."name" else ${chapters.name} end`,
        },
      })
  }

  const ids = await chapterIdByKey(tx, rows.map((row) => row.key))
  if (ids.size === 0) return

  const drop: string[] = []
  const keep: { chapterId: string; mangaId: string; readAt: number }[] = []
  for (const row of rows) {
    const id = ids.get(row.key)
    const parent = series.get(seriesKeyOf(row.key))
    if (!id || !parent) continue
    if (row.state === PRESENT) {
      keep.push({ chapterId: id, mangaId: parent.id, readAt: row.val })
    } else {
      drop.push(id)
    }
  }

  for (const group of chunk(drop, CHUNK_SIZE)) {
    if (group.length > 0) {
      await tx.delete(history).where(inArray(history.chapterId, group))
    }
  }

  if (keep.length === 0) return

  // One row per chapter, matching `touchHistory`. There is no unique index to
  // conflict on, so the existing rows are read and split into updates and
  // inserts here.
  const existing = new Map<string, string>()
  for (const group of chunk(keep.map((entry) => entry.chapterId), CHUNK_SIZE)) {
    const found = await tx
      .select({ id: history.id, chapterId: history.chapterId })
      .from(history)
      .where(inArray(history.chapterId, group))
    for (const row of found) existing.set(row.chapterId, row.id)
  }

  const fresh: (typeof history.$inferInsert)[] = []
  for (const entry of keep) {
    const id = existing.get(entry.chapterId)
    if (id) {
      await tx.update(history).set({ readAt: entry.readAt }).where(eq(history.id, id))
    } else {
      fresh.push({
        id: ulid(),
        updatedAt,
        deviceId,
        mangaId: entry.mangaId,
        chapterId: entry.chapterId,
        readAt: entry.readAt,
      })
    }
  }

  for (const group of chunk(fresh, CHUNK_SIZE)) {
    if (group.length > 0) await tx.insert(history).values(group)
  }

  // What orders the library under "Last read". Derived here rather than synced
  // as a fact of its own: it is a restatement of the history that produced it.
  const latest = new Map<string, number>()
  for (const entry of keep) {
    latest.set(entry.mangaId, Math.max(latest.get(entry.mangaId) ?? 0, entry.readAt))
  }
  for (const [mangaId, readAt] of latest) {
    await tx
      .update(manga)
      .set({ lastRead: sql`max(coalesce(${manga.lastRead}, 0), ${readAt})` })
      .where(eq(manga.id, mangaId))
  }
}

async function applyMember(tx: DbTransaction, rows: readonly Fact[]): Promise<void> {
  if (rows.length === 0) return
  const updatedAt = Date.now()
  const deviceId = getDeviceId()

  const stored = await tx.select({ id: categories.id, name: categories.name }).from(categories)
  const catByKey = new Map(stored.map((row) => [categoryKey(row.name), row.id]))

  const seriesKeys = rows.map((row) => {
    const parts = partsOf(row.key)
    return seriesKey(parts[1] ?? '', parts[2] ?? '')
  })
  const series = await seriesByKey(tx, seriesKeys)

  const add: (typeof mangaCategory.$inferInsert)[] = []
  const remove: { mangaId: string; categoryId: string }[] = []

  for (const row of rows) {
    const parts = partsOf(row.key)
    const categoryId = catByKey.get(parts[0] ?? '')
    const parent = series.get(seriesKey(parts[1] ?? '', parts[2] ?? ''))
    if (!categoryId || !parent) continue

    if (row.state === PRESENT) {
      add.push({ id: ulid(), updatedAt, deviceId, mangaId: parent.id, categoryId })
    } else {
      remove.push({ mangaId: parent.id, categoryId })
    }
  }

  for (const group of chunk(add, CHUNK_SIZE)) {
    if (group.length === 0) continue
    await tx.insert(mangaCategory).values(group).onConflictDoNothing({
      target: [mangaCategory.mangaId, mangaCategory.categoryId],
    })
  }

  for (const entry of remove) {
    await tx
      .delete(mangaCategory)
      .where(
        and(
          eq(mangaCategory.mangaId, entry.mangaId),
          eq(mangaCategory.categoryId, entry.categoryId),
        ),
      )
  }
}

async function applySet(tx: DbTransaction, rows: readonly Fact[]): Promise<void> {
  if (rows.length === 0) return
  const updatedAt = Date.now()
  const deviceId = getDeviceId()

  for (const row of rows) {
    // Checked on the way in as well as on the way out: an install that synced
    // under the old protocol has cursor rows on the server, and adopting a
    // peer's would resume this device from a stranger's position.
    if (isDeviceLocalSetting(row.key)) continue
    if (row.state === HIDDEN) {
      await tx.delete(settings).where(eq(settings.key, row.key))
      continue
    }
    await tx
      .insert(settings)
      .values({ id: ulid(), updatedAt, deviceId, key: row.key, value: row.payload ?? '' })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: sql`excluded."value"` },
      })
  }
}
