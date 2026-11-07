/**
 * The per-user sequence allocator.
 *
 * The D1 handle itself is the `Database` service in server/effect/database.ts;
 * what is left here is the two statements that own the sync cursor.
 */

import * as Effect from 'effect/Effect'
import { eq, sql } from 'drizzle-orm'

import { syncCursor } from '@/lib/db/sync-schema'
import { AppError } from './errors'
import { Database } from './effect/database'
import type { SyncDb } from './effect/database'

export type { SyncDb }

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
export const reserveSeqs = Effect.fn('sync.reserveSeqs')(function* (
  userId: string,
  count: number,
) {
  const db = yield* Database
  const size = Math.max(1, Math.floor(count))
  const now = Date.now()
  const [row] = yield* db.query((c) =>
    c
      .insert(syncCursor)
      .values({ userId, seq: size, updatedAt: now })
      .onConflictDoUpdate({
        target: syncCursor.userId,
        set: { seq: sql`${syncCursor.seq} + ${size}`, updatedAt: now },
      })
      .returning({ seq: syncCursor.seq }),
  )

  if (!row) return yield* Effect.fail(new AppError(500, 'Could not allocate a sequence.'))
  return row.seq
})

/** The user's current high-water mark, without reserving anything. */
export const currentSeq = Effect.fn('sync.currentSeq')(function* (userId: string) {
  const db = yield* Database
  const [row] = yield* db.query((c) =>
    c
      .select({ seq: syncCursor.seq })
      .from(syncCursor)
      .where(eq(syncCursor.userId, userId))
      .limit(1),
  )
  return row?.seq ?? 0
})
