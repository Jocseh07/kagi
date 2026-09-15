/**
 * Accepts a batch of facts and writes them to D1.
 *
 * There is one rule, and it is the whole handler: a stored fact is replaced
 * only by a strictly later generation of itself, or by the same generation
 * reaching further. It is expressed once, in the `WHERE` of the upsert, and
 * applies to every kind of fact there is — a chapter marked read, a category
 * renamed, a series removed. The previous protocol needed a per-column merge
 * for chapters, a different one for everything else, and a matching copy of
 * both on the client; none of that exists any more.
 *
 * A tie is refused rather than resolved. Two devices can write generation two
 * of the same fact at once; the one that lands first stays, and the other
 * device adopts it on its next pull. That asymmetry — the server keeps what it
 * has, the client takes what it is given — is what makes the outcome the same
 * everywhere without anyone comparing clocks.
 *
 * Nothing is ever deleted here. A removal is a fact with `state = 0`, so it
 * travels under the same rule as everything else and cannot resurrect by
 * arriving in the wrong order.
 *
 * Every statement goes into one `db.batch()`: a batch is a single D1 call (one
 * subrequest, one implicit transaction), where issuing the statements one by
 * one would walk straight into the per-invocation subrequest ceiling on a large
 * first push.
 */

import { createFileRoute } from '@tanstack/react-router'
import { sql } from 'drizzle-orm'

import { syncFacts } from '@/lib/db/sync-schema'
import { MAX_PUSH_BATCH, isSyncFact } from '@/lib/sync/protocol'
import type { PushRequest, PushResponse, SyncFact } from '@/lib/sync/protocol'
import { SyncError, requireUserId, respondTo } from '@/server/auth'
import { currentSeq, reserveSeqs, syncDb } from '@/server/db'
import { requireSyncEntitled } from '@/server/polar'
import type { SyncDb } from '@/server/db'

/**
 * Facts per statement.
 *
 * Sized against D1's limit of 100 bound parameters per query, not SQLite's 999:
 * a fact binds seven columns, so twelve rows is eighty-four parameters and
 * inside the cap. Larger batches would be rejected by D1 rather than being
 * merely slow.
 */
const ROWS_PER_STATEMENT = 12

/** One queued-but-unexecuted drizzle statement, for `db.batch()`. */
type Statement = Parameters<SyncDb['batch']>[0][number]

function chunk<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    groups.push(items.slice(start, start + size))
  }
  return groups
}

async function push(request: Request): Promise<PushResponse> {
  const userId = await requireUserId(request)
  const db = syncDb()
  await requireSyncEntitled(db, userId)

  const body = (await request.json().catch(() => undefined)) as
    | Partial<PushRequest>
    | undefined
  const incoming = Array.isArray(body?.facts) ? body.facts : null
  if (!incoming) {
    throw new SyncError(400, 'Expected a `facts` array.')
  }
  if (incoming.length > MAX_PUSH_BATCH) {
    throw new SyncError(413, `At most ${MAX_PUSH_BATCH} facts per push.`)
  }
  if (incoming.length === 0) {
    // Nothing to write, so nothing is reserved: bumping the counter here would
    // make every idle poll a write.
    return { seq: await currentSeq(db, userId), applied: 0 }
  }

  for (const fact of incoming) {
    if (!isSyncFact(fact)) throw new SyncError(400, 'Malformed fact in batch.')
  }

  // One sequence per fact, reserved in a single statement. Sharing one value
  // across the batch would make the batch indivisible, and a pull that ran out
  // of budget inside such a group could not resume without skipping the rest.
  const top = await reserveSeqs(db, userId, incoming.length)
  let seq = top - incoming.length

  const rows = incoming.map((fact: SyncFact) => {
    seq += 1
    return {
      userId,
      kind: fact.kind,
      key: fact.key,
      gen: fact.gen,
      val: fact.val,
      state: fact.state,
      payload: fact.payload ?? null,
      seq,
    }
  })

  const statements: Statement[] = chunk(rows, ROWS_PER_STATEMENT).map(
    (group) =>
      db
        .insert(syncFacts)
        .values(group)
        .onConflictDoUpdate({
          target: [syncFacts.userId, syncFacts.kind, syncFacts.key],
          set: {
            gen: sql`excluded."gen"`,
            val: sql`excluded."val"`,
            state: sql`excluded."state"`,
            payload: sql`excluded."payload"`,
            // Only moves when the fact does. A sequence handed to a fact that
            // was refused would drag every peer back over a range holding
            // nothing they have not already seen.
            seq: sql`excluded."seq"`,
          },
          where: sql`excluded."gen" > ${syncFacts.gen} or (excluded."gen" = ${syncFacts.gen} and excluded."val" > ${syncFacts.val})`,
        }) as unknown as Statement,
  )

  if (statements.length > 0) {
    await db.batch(statements as [Statement, ...Statement[]])
  }

  return { seq: top, applied: incoming.length }
}

export const Route = createFileRoute('/api/sync/push')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          return Response.json(await push(request))
        } catch (error) {
          return respondTo(error)
        }
      },
    },
  },
})
