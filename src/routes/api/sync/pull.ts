/**
 * Returns every fact in this account that changed after `?cursor=`.
 *
 * Ordered and paged by `seq`, the server-assigned counter, never by a client
 * clock: devices disagree about the time, and one running slow would write
 * facts that sort *before* a cursor its peer had already passed, so they would
 * never be pulled at all.
 *
 * One table means one cursor: a single integer, where the row-mirroring
 * protocol needed a position per table and a parser to go with it.
 *
 * Hidden facts are sent like any other. A pull that filtered them would leave
 * the peer holding things the reader removed elsewhere, which is the whole
 * failure `state` exists to prevent.
 *
 * The overwhelmingly common call is a caught-up client asking whether anything
 * changed, and the answer is no. That case exits after a single lookup — see
 * the fast path below.
 */

import { createFileRoute } from '@tanstack/react-router'
import * as Effect from 'effect/Effect'
import { and, asc, eq, gt } from 'drizzle-orm'

import { syncFacts } from '@/lib/db/sync-schema'
import { MAX_PULL_BATCH, parseCursor } from '@/lib/sync/protocol'
import type { PullResponse, SyncFact } from '@/lib/sync/protocol'
import { currentSeq } from '@/server/db'
import { Auth } from '@/server/effect/auth'
import { Database } from '@/server/effect/database'
import { runServer } from '@/server/effect/run'
import { respondTo } from '@/server/errors'
import { requireSyncEntitled } from '@/server/polar'

const pull = Effect.fn('sync.pull')(function* (request: Request) {
  const auth = yield* Auth
  const db = yield* Database
  const userId = yield* auth.requireUserId(request)
  yield* requireSyncEntitled(userId)

  const url = new URL(request.url)
  const cursor = parseCursor(url.searchParams.get('cursor'))

  // Read before the facts, not after. A write that lands between the SELECT and
  // this read would sit above a mark this pull never delivered, and jumping the
  // cursor to it would skip that fact forever. A mark taken first can only be
  // behind, which costs an extra pass and loses nothing.
  const mark = yield* currentSeq(userId)
  if (cursor >= mark) {
    return { facts: [], cursor, hasMore: false } satisfies PullResponse
  }

  const rows = yield* db.query((c) =>
    c
      .select({
        kind: syncFacts.kind,
        key: syncFacts.key,
        gen: syncFacts.gen,
        val: syncFacts.val,
        state: syncFacts.state,
        payload: syncFacts.payload,
        seq: syncFacts.seq,
      })
      .from(syncFacts)
      .where(and(eq(syncFacts.userId, userId), gt(syncFacts.seq, cursor)))
      .orderBy(asc(syncFacts.seq))
      // One extra row is the cheapest way to learn whether more remain without
      // a second COUNT over the same range.
      .limit(MAX_PULL_BATCH + 1),
  )

  const page = rows.slice(0, MAX_PULL_BATCH)
  const hasMore = rows.length > page.length

  const facts: SyncFact[] = page.map(({ seq: _seq, ...fact }) => fact)

  // Every fact carries its own sequence, so the last one delivered is a real
  // boundary and the next pass resumes at the fact after it. With nothing left,
  // the cursor jumps to the account's high-water mark so an idle client stops
  // re-reading the same empty range.
  const last = page.at(-1)?.seq
  const next = hasMore ? (last ?? cursor) : Math.max(cursor, mark)

  return { facts, cursor: next, hasMore } satisfies PullResponse
})

export const Route = createFileRoute('/api/sync/pull')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          return Response.json(await runServer(pull(request)))
        } catch (error) {
          return respondTo(error)
        }
      },
    },
  },
})
