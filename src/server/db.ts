/**
 * The D1 handle for a request, plus the per-user sequence allocator.
 */

import { drizzle } from 'drizzle-orm/d1'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { eq, sql } from 'drizzle-orm'

import type { D1Database } from '@cloudflare/workers-types'

import { syncCursor, syncSchema } from '@/lib/db/sync-schema'
import { SyncError, cloudflareEnv } from './auth'

export type SyncDb = DrizzleD1Database<typeof syncSchema>

export function syncDb(): SyncDb {
  const env = cloudflareEnv<{ DB?: D1Database }>()
  if (!env.DB) {
    throw new SyncError(500, 'D1 binding DB is missing.')
  }
  // Cast because drizzle types the client against the ambient workers-types
  // globals, which this project deliberately does not install globally. The
  // runtime object is the same D1 binding either way.
  return drizzle(env.DB as never, { schema: syncSchema })
}

/**
 * Reserves `count` consecutive sequence numbers and returns the highest.
 *
 * One number *per row*, not one per push. A shared per-batch value looks
 * tidier, but it makes the batch indivisible: a pull that runs out of budget
 * half way through such a group has no cursor it can return that both excludes
 * the rows it delivered and includes the ones it did not, so the remainder is
 * skipped forever. Distinct numbers give every row its own cursor position, and
 * a truncated pull simply resumes at the last row it sent.
 *
 * The reserved range is `[seq - count + 1, seq]`. Callers hand the numbers out
 * in whatever order they write rows; only uniqueness and monotonicity matter.
 *
 * The upsert is a single statement so two concurrent pushes cannot both read
 * the same value and write it back — D1 serialises statements against one
 * database, and `seq + count` is evaluated there rather than here.
 */
export async function reserveSeqs(
  db: SyncDb,
  userId: string,
  count: number,
): Promise<number> {
  const size = Math.max(1, Math.floor(count))
  const now = Date.now()
  const [row] = await db
    .insert(syncCursor)
    .values({ userId, seq: size, updatedAt: now })
    .onConflictDoUpdate({
      target: syncCursor.userId,
      set: { seq: sql`${syncCursor.seq} + ${size}`, updatedAt: now },
    })
    .returning({ seq: syncCursor.seq })

  if (!row) {
    throw new SyncError(500, 'Could not allocate a sequence.')
  }
  return row.seq
}

/** The user's current high-water mark, without reserving anything. */
export async function currentSeq(db: SyncDb, userId: string): Promise<number> {
  const [row] = await db
    .select({ seq: syncCursor.seq })
    .from(syncCursor)
    .where(eq(syncCursor.userId, userId))
    .limit(1)
  return row?.seq ?? 0
}
