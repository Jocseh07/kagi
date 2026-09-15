/**
 * Writing to the sync ledger.
 *
 * Every user decision in the app calls through here, in the same transaction
 * that updates the table the screen reads. Nothing else may write a fact: the
 * ledger is only trustworthy if the set of things that can append to it is
 * small enough to list.
 *
 * The rule for what a write does to a fact:
 *
 *  - Nothing stored yet: state it, at generation zero.
 *  - The state changed, or the caller forced it: a new generation.
 *  - Same state, a further value: keep the generation, move the value. This is
 *    reading progress, which advances constantly and must never cost a new
 *    generation or it would outrun every peer.
 *  - Same state, same value, only a different label: written locally, but not
 *    queued. A label is a courtesy for devices that have not fetched the
 *    series; re-pushing every series because a source retitled a chapter is
 *    not worth a single byte of quota.
 *  - Nothing changed: no write at all. Marking a read chapter read again is
 *    the common case and it must be free.
 */

import { and, eq, gt, inArray, or, sql } from 'drizzle-orm'

import { CHUNK_SIZE, chunk } from './chunk'
import type { DbTransaction } from './client'
import {
  categories,
  chapters,
  facts,
  history,
  manga,
  mangaCategory,
} from './schema'
import type { Fact } from './schema'
import {
  HIDDEN,
  PRESENT,
  SEP,
  categoryKey,
  chapterKey,
  encodeLabel,
  memberKey,
  seriesKey,
} from '@/lib/sync/fact-kinds'
import type { FactKind } from '@/lib/sync/fact-kinds'

export interface FactWrite {
  kind: FactKind
  key: string
  /** Defaults to `PRESENT` on a first statement, otherwise to what is stored. */
  state?: number
  /** Defaults to what is stored, so an override keeps its value. */
  val?: number
  payload?: string | null
  /** Forces a new generation for a change `state` and `val` cannot express. */
  bump?: boolean
}

/** The stored facts for some keys of one kind. */
export async function readFacts(
  tx: DbTransaction,
  kind: FactKind,
  keys: readonly string[],
): Promise<Map<string, Fact>> {
  const found = new Map<string, Fact>()
  for (const group of chunk([...new Set(keys)], CHUNK_SIZE)) {
    if (group.length === 0) continue
    const rows = await tx
      .select()
      .from(facts)
      .where(and(eq(facts.kind, kind), inArray(facts.key, group)))
    for (const row of rows) found.set(row.key, row)
  }
  return found
}

/**
 * States facts, and returns how many are now waiting to be sent.
 *
 * Callers use the return value for the pending hint, so a no-op write reads as
 * zero rather than as a change nobody made.
 */
export async function assertFacts(
  tx: DbTransaction,
  writes: readonly FactWrite[],
): Promise<number> {
  if (writes.length === 0) return 0

  // One statement cannot conflict with itself twice, and a bulk mark can
  // legitimately name the same key twice; the last word wins, as it would have
  // if the writes had arrived one at a time.
  const unique = new Map<string, FactWrite>()
  for (const write of writes) unique.set(`${write.kind}\u0000${write.key}`, write)

  const byKind = new Map<FactKind, FactWrite[]>()
  for (const write of unique.values()) {
    const group = byKind.get(write.kind) ?? []
    group.push(write)
    byKind.set(write.kind, group)
  }

  let queued = 0

  for (const [kind, group] of byKind) {
    const stored = await readFacts(
      tx,
      kind,
      group.map((write) => write.key),
    )

    const rows: Fact[] = []
    for (const write of group) {
      const held = stored.get(write.key)
      const next = resolve(write, held)
      if (!next) continue
      rows.push(next)
      // Counted only where it *becomes* pending. A fact already waiting to be
      // sent is not a second thing waiting to be sent.
      if (!next.acked && (held?.acked ?? true)) queued += 1
    }
    if (rows.length === 0) continue

    for (const batch of chunk(rows, CHUNK_SIZE)) {
      await tx
        .insert(facts)
        .values(batch)
        .onConflictDoUpdate({
          target: [facts.kind, facts.key],
          // The winner is decided above, in one place, rather than half here
          // and half in an ON CONFLICT expression nobody can read.
          set: {
            gen: sql`excluded."gen"`,
            val: sql`excluded."val"`,
            state: sql`excluded."state"`,
            payload: sql`excluded."payload"`,
            acked: sql`excluded."acked"`,
          },
        })
    }
  }

  return queued
}

/** Single-fact form, for the many call sites that state exactly one thing. */
export function assertFact(
  tx: DbTransaction,
  write: FactWrite,
): Promise<number> {
  return assertFacts(tx, [write])
}

function resolve(write: FactWrite, stored: Fact | undefined): Fact | null {
  if (!stored) {
    return {
      kind: write.kind,
      key: write.key,
      gen: 0,
      val: write.val ?? 0,
      state: write.state ?? PRESENT,
      payload: write.payload ?? null,
      acked: false,
    }
  }

  const state = write.state ?? stored.state
  const payload = write.payload === undefined ? stored.payload : write.payload
  const moved = write.val !== undefined && write.val !== stored.val

  // A forced bump still has to be a change. Writing a setting back to the
  // value it already holds is not a decision, and burning a generation on it
  // would beat a peer's real edit for no reason.
  if (write.bump && !moved && state === stored.state && payload === stored.payload) {
    return null
  }

  if (write.bump || state !== stored.state) {
    return {
      ...stored,
      gen: stored.gen + 1,
      val: write.val ?? stored.val,
      state,
      payload,
      acked: false,
    }
  }

  if (write.val !== undefined && write.val > stored.val) {
    return { ...stored, val: write.val, payload, acked: false }
  }

  if (payload !== stored.payload) {
    // Locally better, not worth a push: `acked` is left exactly as it was.
    return { ...stored, payload }
  }

  return null
}

// ------------------------------------------------------------------ keys --

/** A series as the ledger addresses it, with the label a peer would need. */
export interface SeriesKeyRow {
  mangaId: string
  key: string
  title: string
  thumbnailUrl: string | null
  dateAdded: number | null
  favorite: boolean
}

export async function seriesKeysOf(
  tx: DbTransaction,
  mangaIds: readonly string[],
): Promise<Map<string, SeriesKeyRow>> {
  const out = new Map<string, SeriesKeyRow>()
  for (const group of chunk([...new Set(mangaIds)], CHUNK_SIZE)) {
    if (group.length === 0) continue
    const rows = await tx
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
      .where(inArray(manga.id, group))
    for (const row of rows) {
      out.set(row.mangaId, { ...row, key: seriesKey(row.sourceId, row.url) })
    }
  }
  return out
}

/** A chapter as the ledger addresses it, with the label a history entry needs. */
export interface ChapterKeyRow {
  chapterId: string
  mangaId: string
  seriesKey: string
  key: string
  name: string
  chapterNumber: number
}

export async function chapterKeysOf(
  tx: DbTransaction,
  chapterIds: readonly string[],
): Promise<ChapterKeyRow[]> {
  const out: ChapterKeyRow[] = []
  for (const group of chunk([...new Set(chapterIds)], CHUNK_SIZE)) {
    if (group.length === 0) continue
    const rows = await tx
      .select({
        chapterId: chapters.id,
        mangaId: chapters.mangaId,
        chapterUrl: chapters.url,
        name: chapters.name,
        chapterNumber: chapters.chapterNumber,
        sourceId: manga.sourceId,
        mangaUrl: manga.url,
      })
      .from(chapters)
      .innerJoin(manga, eq(manga.id, chapters.mangaId))
      .where(inArray(chapters.id, group))
    for (const row of rows) {
      out.push({
        chapterId: row.chapterId,
        mangaId: row.mangaId,
        seriesKey: seriesKey(row.sourceId, row.mangaUrl),
        key: chapterKey(row.sourceId, row.mangaUrl, row.chapterUrl),
        name: row.name,
        chapterNumber: row.chapterNumber,
      })
    }
  }
  return out
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/**
 * Every chapter-level fact stored for one series, in a single query.
 *
 * A prefix match rather than a list of keys: a series can have two thousand
 * chapters, and asking by key would be thirty statements where the primary key
 * index answers this one in a single range scan.
 */
export async function chapterFactsForSeries(
  tx: DbTransaction,
  series: string,
): Promise<Fact[]> {
  const prefix = `${escapeLike(series)}${SEP}%`
  return await tx
    .select()
    .from(facts)
    .where(
      and(
        inArray(facts.kind, ['read', 'pos', 'hist']),
        sql`${facts.key} like ${prefix} escape '\\'`,
      ),
    )
}

/**
 * States everything currently true of one series.
 *
 * For writes that reach the tables directly instead of through a repository —
 * the Mihon import is the only one — where restating the merged result is both
 * simpler and more correct than trying to state each merge step. `assertFacts`
 * only ever advances, so a backup that is behind the reader says nothing new.
 */
export async function stateSeriesFacts(
  tx: DbTransaction,
  mangaId: string,
): Promise<number> {
  const series = await seriesKeysOf(tx, [mangaId])
  const row = series.get(mangaId)
  if (!row) return 0

  const writes: FactWrite[] = [
    {
      kind: 'lib',
      key: row.key,
      state: row.favorite ? PRESENT : HIDDEN,
      val: row.favorite ? (row.dateAdded ?? 0) : 0,
      payload: encodeLabel({ t: row.title, c: row.thumbnailUrl ?? undefined }),
    },
  ]

  const progressed = await tx
    .select({
      url: chapters.url,
      read: chapters.read,
      lastPageRead: chapters.lastPageRead,
    })
    .from(chapters)
    .where(
      and(
        eq(chapters.mangaId, mangaId),
        or(eq(chapters.read, true), gt(chapters.lastPageRead, 0)),
      ),
    )

  for (const chapter of progressed) {
    const key = `${row.key}${SEP}${chapter.url}`
    if (chapter.read) writes.push({ kind: 'read', key, state: PRESENT })
    if (chapter.lastPageRead > 0) {
      writes.push({ kind: 'pos', key, val: chapter.lastPageRead })
    }
  }

  const seen = await tx
    .select({
      readAt: history.readAt,
      url: chapters.url,
      name: chapters.name,
      chapterNumber: chapters.chapterNumber,
    })
    .from(history)
    .innerJoin(chapters, eq(chapters.id, history.chapterId))
    .where(eq(history.mangaId, mangaId))

  for (const entry of seen) {
    writes.push({
      kind: 'hist',
      key: `${row.key}${SEP}${entry.url}`,
      val: entry.readAt,
      payload: encodeLabel({ n: entry.name, i: entry.chapterNumber }),
    })
  }

  const links = await tx
    .select({ name: categories.name })
    .from(mangaCategory)
    .innerJoin(categories, eq(categories.id, mangaCategory.categoryId))
    .where(eq(mangaCategory.mangaId, mangaId))

  for (const link of links) {
    writes.push({
      kind: 'member',
      key: memberKey(categoryKey(link.name), row.key),
      state: PRESENT,
    })
  }

  return await assertFacts(tx, writes)
}
