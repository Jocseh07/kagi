/**
 * Stating a library that already exists.
 *
 * Sync used to mirror rows and name them by per-device ids, so two devices
 * that had each added the same series disagreed about what it was called and
 * could never reconcile. The ledger names things by what they are, which fixes
 * that going forward but says nothing about the library sitting on the device
 * right now. This walks it once and states it.
 *
 * Every device does this, and they converge rather than duplicate: the same
 * series produces the same key everywhere, so the second device to state it is
 * saying something the first already said. That makes the migration itself the
 * repair for the duplicates the old model left behind.
 *
 * Written with `onConflictDoNothing` rather than through `assertFacts`: a fact
 * the reader has stated since this build landed is a real decision and must not
 * be overwritten by a snapshot of what the rows happened to say.
 */

import { and, eq, gt, inArray, or, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import { setPendingHint } from '@/lib/db/change-signal'
import { CHUNK_SIZE, chunk } from '@/lib/db/chunk'
import { db, getDeviceId, transact } from '@/lib/db/client'
import {
  categories,
  chapters,
  facts,
  history,
  manga,
  mangaCategory,
  settings,
} from '@/lib/db/schema'
import type { Fact } from '@/lib/db/schema'
import {
  HIDDEN,
  PRESENT,
  SEP,
  categoryKey,
  chapterKey,
  encodeLabel,
  isDeviceLocalSetting,
  memberKey,
  seriesKey,
} from './fact-kinds'

/** Set once the walk has finished. Device-local, so it never travels. */
const SEEDED = 'sync.ledger_seeded'

let running: Promise<void> | undefined

/**
 * Runs the walk once per install. Safe to call from anywhere and at any time:
 * concurrent callers share the one run, and a second install-time call after it
 * has completed is a single indexed lookup.
 */
export function seedLedger(): Promise<void> {
  running ??= seed().catch((error: unknown) => {
    // A failed seed must not take the app down with it. The library is intact
    // either way; what is missing is the statement of it, and the next boot
    // tries again because the marker was never written.
    running = undefined
    throw error
  })
  return running
}

async function seed(): Promise<void> {
  const [marker] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, SEEDED))
    .limit(1)
  if (marker) return

  const series = await seedSeries()
  await seedChapters(series)
  await seedHistory(series)
  await seedCategories()
  await seedSettings()

  // The panel would otherwise read zero until the next sync run reconciled it,
  // which is the one moment a reader most wants to see that their whole library
  // is about to go up.
  const [pending] = await db
    .select({ count: sql<number>`count(*)` })
    .from(facts)
    .where(eq(facts.acked, false))
  setPendingHint(Number(pending?.count ?? 0))

  await transact(async (tx) => {
    await tx
      .insert(settings)
      .values({
        id: ulid(),
        updatedAt: Date.now(),
        deviceId: getDeviceId(),
        key: SEEDED,
        value: '1',
      })
      .onConflictDoNothing({ target: settings.key })
  })
}

async function write(rows: readonly Fact[]): Promise<void> {
  for (const group of chunk(rows, CHUNK_SIZE)) {
    if (group.length === 0) continue
    await transact(async (tx) => {
      await tx
        .insert(facts)
        .values(group)
        .onConflictDoNothing({ target: [facts.kind, facts.key] })
    })
  }
}

function fact(row: Pick<Fact, 'kind' | 'key'> & Partial<Fact>): Fact {
  return {
    gen: 0,
    val: 0,
    state: PRESENT,
    payload: null,
    acked: false,
    ...row,
  }
}

interface SeededSeries {
  mangaId: string
  key: string
}

/**
 * The series worth stating: the ones in the library, and the ones with a
 * reading history. A series that was only ever browsed past is neither, and
 * uploading it would be uploading the fact that a page was once opened.
 */
async function seedSeries(): Promise<SeededSeries[]> {
  const historic = await db
    .selectDistinct({ mangaId: history.mangaId })
    .from(history)
  const known = new Set(historic.map((row) => row.mangaId))

  const rows = await db
    .select({
      mangaId: manga.id,
      sourceId: manga.sourceId,
      url: manga.url,
      title: manga.title,
      thumbnailUrl: manga.thumbnailUrl,
      dateAdded: manga.dateAdded,
      favorite: manga.favorite,
    })
    .from(manga)
    .where(
      known.size > 0
        ? or(eq(manga.favorite, true), inArray(manga.id, [...known]))
        : eq(manga.favorite, true),
    )

  const seeded = rows.map((row) => ({
    mangaId: row.mangaId,
    key: seriesKey(row.sourceId, row.url),
  }))

  await write(
    rows.map((row) =>
      fact({
        kind: 'lib',
        key: seriesKey(row.sourceId, row.url),
        state: row.favorite ? PRESENT : HIDDEN,
        val: row.favorite ? (row.dateAdded ?? 0) : 0,
        payload: encodeLabel({ t: row.title, c: row.thumbnailUrl ?? undefined }),
      }),
    ),
  )

  return seeded
}

async function seedChapters(series: readonly SeededSeries[]): Promise<void> {
  const keyOf = new Map(series.map((row) => [row.mangaId, row.key]))

  for (const group of chunk([...keyOf.keys()], CHUNK_SIZE)) {
    if (group.length === 0) continue
    const rows = await db
      .select({
        mangaId: chapters.mangaId,
        url: chapters.url,
        read: chapters.read,
        lastPageRead: chapters.lastPageRead,
      })
      .from(chapters)
      .where(
        and(
          inArray(chapters.mangaId, group),
          or(eq(chapters.read, true), gt(chapters.lastPageRead, 0)),
        ),
      )

    const out: Fact[] = []
    for (const row of rows) {
      const parent = keyOf.get(row.mangaId)
      if (!parent) continue
      const key = `${parent}${SEP}${row.url}`
      if (row.read) out.push(fact({ kind: 'read', key, state: PRESENT }))
      if (row.lastPageRead > 0) {
        out.push(fact({ kind: 'pos', key, val: row.lastPageRead }))
      }
    }
    await write(out)
  }
}

async function seedHistory(series: readonly SeededSeries[]): Promise<void> {
  const keyOf = new Map(series.map((row) => [row.mangaId, row.key]))

  const rows = await db
    .select({
      mangaId: history.mangaId,
      readAt: history.readAt,
      chapterUrl: chapters.url,
      name: chapters.name,
      chapterNumber: chapters.chapterNumber,
      sourceId: manga.sourceId,
      mangaUrl: manga.url,
    })
    .from(history)
    .innerJoin(chapters, eq(chapters.id, history.chapterId))
    .innerJoin(manga, eq(manga.id, history.mangaId))

  await write(
    rows
      .filter((row) => keyOf.has(row.mangaId))
      .map((row) =>
        fact({
          kind: 'hist',
          key: chapterKey(row.sourceId, row.mangaUrl, row.chapterUrl),
          val: row.readAt,
          payload: encodeLabel({ n: row.name, i: row.chapterNumber }),
        }),
      ),
  )
}

async function seedCategories(): Promise<void> {
  const rows = await db.select().from(categories)
  if (rows.length === 0) return

  await write(
    rows.map((row) =>
      fact({
        kind: 'cat',
        key: categoryKey(row.name),
        val: row.order,
        payload: row.name,
      }),
    ),
  )

  const links = await db
    .select({
      name: categories.name,
      sourceId: manga.sourceId,
      url: manga.url,
    })
    .from(mangaCategory)
    .innerJoin(categories, eq(categories.id, mangaCategory.categoryId))
    .innerJoin(manga, eq(manga.id, mangaCategory.mangaId))

  await write(
    links.map((link) =>
      fact({
        kind: 'member',
        key: memberKey(categoryKey(link.name), seriesKey(link.sourceId, link.url)),
      }),
    ),
  )
}

async function seedSettings(): Promise<void> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)

  await write(
    rows
      .filter((row) => !isDeviceLocalSetting(row.key))
      .map((row) => fact({ kind: 'set', key: row.key, payload: row.value })),
  )
}
