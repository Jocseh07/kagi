import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ContentKind } from '@/lib/sources/types'
import { HIDDEN, PRESENT, categoryKey, memberKey } from '@/lib/sync/fact-kinds'
import { bumpChangeSignal } from './change-signal'
import { db, getDeviceId, transact } from './client'
import type { DbTransaction } from './client'
import { assertFacts, seriesKeysOf } from './facts'
import { categories, manga, mangaCategory } from './schema'
import type { Category } from './schema'

function stamp(): { updatedAt: number; deviceId: string } {
  return { updatedAt: Date.now(), deviceId: getDeviceId() }
}

/**
 * Membership facts for a set of assignments.
 *
 * A membership is addressed by the category's folded name and the series'
 * source and url, so it survives both devices having minted their own ids for
 * either end of it.
 */
async function memberFacts(
  tx: DbTransaction,
  category: string,
  mangaIds: readonly string[],
  state: number,
): Promise<{ kind: 'member'; key: string; state: number }[]> {
  const series = await seriesKeysOf(tx, mangaIds)
  const key = categoryKey(category)
  return [...series.values()].map((row) => ({
    kind: 'member' as const,
    key: memberKey(key, row.key),
    state,
  }))
}

export function listCategories(): Promise<Category[]> {
  return db
    .select()
    .from(categories)
    .orderBy(asc(categories.order), asc(categories.name))
}

export async function createCategory(name: string): Promise<Category> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('A category needs a name.')
  const { updatedAt, deviceId } = stamp()

  const created = await transact(async (tx) => {
    const [last] = await tx
      .select({ order: categories.order })
      .from(categories)
      .orderBy(desc(categories.order))
      .limit(1)

    const [row] = await tx
      .insert(categories)
      .values({
        id: ulid(),
        updatedAt,
        deviceId,
        name: trimmed,
        order: (last?.order ?? -1) + 1,
      })
      .returning()

    if (!row) throw new Error(`Could not create the category "${trimmed}".`)

    // The name is the identity, so "Reading" made on a phone and "reading" made
    // on a laptop are one category rather than the two the old id-per-device
    // model produced.
    await assertFacts(tx, [
      {
        kind: 'cat',
        key: categoryKey(trimmed),
        state: PRESENT,
        val: row.order,
        payload: trimmed,
      },
    ])
    return row
  })
  bumpChangeSignal()
  return created
}

export async function renameCategory(
  id: string,
  name: string,
): Promise<Category | null> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('A category needs a name.')
  const { updatedAt, deviceId } = stamp()

  const row = await transact(async (tx) => {
    const [before] = await tx
      .select()
      .from(categories)
      .where(eq(categories.id, id))
      .limit(1)
    if (!before) return null

    const [saved] = await tx
      .update(categories)
      .set({ name: trimmed, updatedAt, deviceId })
      .where(eq(categories.id, id))
      .returning()
    if (!saved) return null

    const from = categoryKey(before.name)
    const to = categoryKey(trimmed)

    if (from === to) {
      // Only the spelling moved, and the spelling is the payload.
      await assertFacts(tx, [
        { kind: 'cat', key: to, state: PRESENT, val: saved.order, payload: trimmed },
      ])
      return saved
    }

    // A rename is a move, because the name is the address. The old name is
    // hidden, the new one stated, and every assignment restated under it —
    // otherwise the members would follow the address into nothing.
    const links = await tx
      .select({ mangaId: mangaCategory.mangaId })
      .from(mangaCategory)
      .where(eq(mangaCategory.categoryId, id))
    const mangaIds = links.map((link) => link.mangaId)

    await assertFacts(tx, [
      { kind: 'cat', key: from, state: HIDDEN },
      { kind: 'cat', key: to, state: PRESENT, val: saved.order, payload: trimmed },
      ...(await memberFacts(tx, before.name, mangaIds, HIDDEN)),
      ...(await memberFacts(tx, trimmed, mangaIds, PRESENT)),
    ])
    return saved
  })
  if (row) bumpChangeSignal()
  return row
}

/**
 * Drops the category and every assignment to it. The series themselves stay in
 * the library; only their membership disappears.
 */
export async function deleteCategory(id: string): Promise<void> {
  await transact(async (tx) => {
    const [existing] = await tx
      .select()
      .from(categories)
      .where(eq(categories.id, id))
      .limit(1)
    if (!existing) return

    const links = await tx
      .select({ mangaId: mangaCategory.mangaId })
      .from(mangaCategory)
      .where(eq(mangaCategory.categoryId, id))

    // Stated before the rows go, while the assignments are still readable.
    const hidden = await memberFacts(
      tx,
      existing.name,
      links.map((link) => link.mangaId),
      HIDDEN,
    )

    await tx.delete(mangaCategory).where(eq(mangaCategory.categoryId, id))
    await tx.delete(categories).where(eq(categories.id, id))

    await assertFacts(tx, [
      { kind: 'cat', key: categoryKey(existing.name), state: HIDDEN },
      ...hidden,
    ])
  })
  bumpChangeSignal()
}

/** Renumbers every category to its position in `ids`, in one transaction. */
export async function reorderCategories(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const { updatedAt, deviceId } = stamp()

  await transact(async (tx) => {
    const stored = await tx.select().from(categories)
    const byId = new Map(stored.map((row) => [row.id, row]))

    for (const [index, id] of ids.entries()) {
      await tx
        .update(categories)
        .set({ order: index, updatedAt, deviceId })
        .where(eq(categories.id, id))
    }

    // Order is the one value that can move backwards, so a reorder cannot ride
    // the furthest-wins rule and takes a new generation instead.
    await assertFacts(
      tx,
      ids.flatMap((id, index) => {
        const row = byId.get(id)
        if (!row) return []
        return [
          {
            kind: 'cat' as const,
            key: categoryKey(row.name),
            state: PRESENT,
            val: index,
            payload: row.name,
            bump: true,
          },
        ]
      }),
    )
  })
  bumpChangeSignal(ids.length)
}

export async function getMangaCategories(mangaId: string): Promise<string[]> {
  const rows = await db
    .select({ categoryId: mangaCategory.categoryId })
    .from(mangaCategory)
    .where(eq(mangaCategory.mangaId, mangaId))
  return rows.map((row) => row.categoryId)
}

/** Assignments for a whole selection, so a picker needs one query, not N. */
export async function getCategoriesForManga(
  mangaIds: readonly string[],
): Promise<Record<string, string[]>> {
  if (mangaIds.length === 0) return {}
  const rows = await db
    .select({
      mangaId: mangaCategory.mangaId,
      categoryId: mangaCategory.categoryId,
    })
    .from(mangaCategory)
    .where(inArray(mangaCategory.mangaId, [...mangaIds]))

  const out: Record<string, string[]> = {}
  for (const row of rows) {
    const bucket = out[row.mangaId]
    if (bucket) bucket.push(row.categoryId)
    else out[row.mangaId] = [row.categoryId]
  }
  return out
}

export function setMangaCategories(
  mangaId: string,
  categoryIds: readonly string[],
): Promise<void> {
  return setCategoriesForManga([mangaId], categoryIds)
}

/** Replaces the category set of every listed series with `categoryIds`. */
export async function setCategoriesForManga(
  mangaIds: readonly string[],
  categoryIds: readonly string[],
): Promise<void> {
  if (mangaIds.length === 0) return
  const { updatedAt, deviceId } = stamp()

  await transact(async (tx) => {
    const named = await tx.select().from(categories)
    const nameOf = new Map(named.map((row) => [row.id, row.name]))

    const existing = await tx
      .select({ mangaId: mangaCategory.mangaId, categoryId: mangaCategory.categoryId })
      .from(mangaCategory)
      .where(inArray(mangaCategory.mangaId, [...mangaIds]))

    const facts: { kind: 'member'; key: string; state: number }[] = []

    if (existing.length > 0) {
      const dropped = new Map<string, string[]>()
      for (const row of existing) {
        const group = dropped.get(row.categoryId) ?? []
        group.push(row.mangaId)
        dropped.set(row.categoryId, group)
      }
      for (const [categoryId, ids] of dropped) {
        const name = nameOf.get(categoryId)
        if (name) facts.push(...(await memberFacts(tx, name, ids, HIDDEN)))
      }

      await tx
        .delete(mangaCategory)
        .where(inArray(mangaCategory.mangaId, [...mangaIds]))
    }

    if (categoryIds.length > 0) {
      const inserted = mangaIds.flatMap((mangaId) =>
        categoryIds.map((categoryId) => ({
          id: ulid(),
          updatedAt,
          deviceId,
          mangaId,
          categoryId,
        })),
      )

      // One multi-row insert: every statement is a round trip to the database
      // worker, and a large selection would otherwise crawl.
      await tx.insert(mangaCategory).values(inserted)

      for (const categoryId of categoryIds) {
        const name = nameOf.get(categoryId)
        if (name) facts.push(...(await memberFacts(tx, name, mangaIds, PRESENT)))
      }
    }

    await assertFacts(tx, facts)
  })
  bumpChangeSignal(mangaIds.length)
}

/**
 * Favourites per category, keyed by category id, for the tab bar counts.
 *
 * `kind` narrows to comics or novels so the category numbers agree with the
 * kind tab above them; omitted, it counts both.
 */
export async function getCategoryCounts(
  kind?: ContentKind,
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      categoryId: mangaCategory.categoryId,
      count: sql<number>`count(*)`,
    })
    .from(mangaCategory)
    .innerJoin(manga, eq(manga.id, mangaCategory.mangaId))
    .where(
      kind
        ? and(eq(manga.favorite, true), eq(manga.contentKind, kind))
        : eq(manga.favorite, true),
    )
    .groupBy(mangaCategory.categoryId)

  return Object.fromEntries(rows.map((row) => [row.categoryId, row.count]))
}

