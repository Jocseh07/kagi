/**
 * The local half of sync: draining the ledger, and folding a peer's facts into
 * it.
 *
 * Three rules govern this file.
 *
 * 1. *The ledger is the outbox.* Every decision the reader makes writes a fact
 *    with `acked` cleared; push sends those and sets it once the server has
 *    them. There is no dirty flag on six tables and no tombstone table, because
 *    a removal is a fact like any other.
 *
 * 2. *Folding never queues.* A fact that arrived from the server is stored
 *    already acknowledged. Storing it as pending would push it straight back,
 *    and the two devices would trade the same fact forever.
 *
 * 3. *A fact outlives the row it describes.* Nothing is dropped for want of a
 *    series or a chapter to attach to; it stays in the ledger and
 *    `upsertChapters` applies it when the row finally exists. The old protocol
 *    filtered those out as orphans and lost them.
 */

import { and, eq, inArray, or, sql } from 'drizzle-orm'

import { chunk } from '@/lib/db/chunk'
import { db, transact } from '@/lib/db/client'
import type { DbTransaction } from '@/lib/db/client'
import { facts } from '@/lib/db/schema'
import type { Fact } from '@/lib/db/schema'
import { isFactKind, isDeviceLocalSetting, supersedes } from './fact-kinds'
import { applyFacts } from './project'
import { MAX_KEY_BYTES, MAX_PAYLOAD_BYTES } from './protocol'
import type { SyncFact } from './protocol'

/**
 * Statement width for the ledger's own reads and writes. Narrower than the
 * repositories' chunk because the acknowledgement binds four parameters per
 * fact rather than one.
 */
const CHUNK_SIZE = 50

// ------------------------------------------------------------------ push --

export interface PushPlan {
  facts: SyncFact[]
  /**
   * The exact versions that were read.
   *
   * The acknowledgement is guarded on them, so a fact the reader moved while
   * the push was in flight matches nothing, keeps its pending flag, and goes
   * out with the next run.
   */
  sent: Fact[]
}

export async function collectPending(): Promise<PushPlan> {
  const rows = await db.select().from(facts).where(eq(facts.acked, false))

  // A fact the server would refuse is dropped here rather than sent and
  // rejected. The server answers a malformed batch with a 400, which under the
  // old protocol was the shape of the bug that stopped sync permanently: one
  // unsendable row, and nothing else could ever get through behind it. Marking
  // it acknowledged is the honest outcome — it is true on this device and it is
  // never going to be true anywhere else.
  const sendable: Fact[] = []
  const refused: Fact[] = []
  for (const row of rows) {
    if (row.key.length > MAX_KEY_BYTES || (row.payload?.length ?? 0) > MAX_PAYLOAD_BYTES) {
      refused.push(row)
    } else {
      sendable.push(row)
    }
  }
  if (refused.length > 0) await acknowledge(refused)

  return {
    sent: sendable,
    facts: sendable.map((row) => ({
      kind: row.kind,
      key: row.key,
      gen: row.gen,
      val: row.val,
      state: row.state,
      payload: row.payload,
    })),
  }
}

/**
 * Marks the pushed facts acknowledged.
 *
 * Only called once *every* batch of the plan has landed. A run that stopped
 * partway acknowledges nothing and simply re-sends later; the server's rule is
 * idempotent, so a resend costs writes but never changes an answer.
 */
export function markPushed(plan: PushPlan): Promise<void> {
  return acknowledge(plan.sent)
}

async function acknowledge(rows: readonly Fact[]): Promise<void> {
  if (rows.length === 0) return
  await transact(async (tx) => {
    for (const group of chunk(rows, CHUNK_SIZE)) {
      const match = group.map((row) =>
        and(
          eq(facts.kind, row.kind),
          eq(facts.key, row.key),
          eq(facts.gen, row.gen),
          eq(facts.val, row.val),
        ),
      )
      await tx.update(facts).set({ acked: true }).where(or(...match))
    }
  })
}

// ----------------------------------------------------------------- apply --

export interface ApplyResult {
  /** Facts that were new or newer, and so were written and projected. */
  applied: number
  /**
   * Whether a series or a category came into existence in this batch.
   *
   * Facts arrive in the server's sequence order, which is when they were last
   * *written*, not the order the things they describe were created. Unfavourite
   * and re-favourite a series you have read, and its `lib` fact is rewritten
   * with a fresh sequence that now sorts after its own history. A device
   * pulling from scratch would then meet the history first, find no series to
   * hang it on, and skip it. `reprojectDeferred` is what catches that, and this
   * is the flag that says it is worth running.
   */
  created: boolean
}

/**
 * Folds a peer's facts into the ledger and projects the winners.
 *
 * The whole batch is one transaction: a half-applied pull would leave the
 * cursor and the ledger disagreeing, and the next pull would not re-fetch what
 * was already past the cursor.
 */
export async function applyPulled(
  incoming: readonly SyncFact[],
): Promise<ApplyResult> {
  if (incoming.length === 0) return { applied: 0, created: false }

  return await transact(async (tx) => {
    const winners: Fact[] = []

    for (const group of chunk([...incoming], CHUNK_SIZE)) {
      const stored = await readStored(tx, group)

      for (const fact of group) {
        // A kind this build does not know is from a newer one. Storing it would
        // put a row in the ledger that nothing can ever project or correct.
        if (!isFactKind(fact.kind)) continue

        // Checked on both sides of the wire. An install that synced under the
        // old protocol has cursor rows sitting on the server, and adopting a
        // peer's would resume this device from a stranger's position.
        if (fact.kind === 'set' && isDeviceLocalSetting(fact.key)) continue

        const held = stored.get(`${fact.kind}\u0000${fact.key}`)
        const payload = fact.payload ?? null

        if (
          held &&
          held.gen === fact.gen &&
          held.val === fact.val &&
          held.state === fact.state &&
          held.payload === payload
        ) {
          // Already true here. This is the common case on a shared library and
          // it costs one comparison and no writes at all.
          continue
        }

        if (held && !supersedes(fact, held)) continue

        winners.push({
          kind: fact.kind,
          key: fact.key,
          gen: fact.gen,
          val: fact.val,
          state: fact.state,
          payload,
          acked: true,
        })
      }
    }

    if (winners.length === 0) return { applied: 0, created: false }

    for (const group of chunk(winners, CHUNK_SIZE)) {
      await tx
        .insert(facts)
        .values(group)
        .onConflictDoUpdate({
          target: [facts.kind, facts.key],
          set: {
            gen: sql`excluded."gen"`,
            val: sql`excluded."val"`,
            state: sql`excluded."state"`,
            payload: sql`excluded."payload"`,
            acked: sql`excluded."acked"`,
          },
        })
    }

    await applyFacts(tx, winners)
    return {
      applied: winners.length,
      created: winners.some((row) => row.kind === 'lib' || row.kind === 'cat'),
    }
  })
}

/**
 * Re-projects the facts that depend on a series or a category existing.
 *
 * Run once at the end of a pull that brought either into being, and only then,
 * which in practice means the first sync on a device and never again.
 * Projection is idempotent, so running it costs a walk of the ledger; not
 * running it costs a history entry or a category assignment that silently
 * never appears.
 *
 * `read` and `pos` are included because `hist` can create a chapter row that
 * did not exist a moment ago, and those two are what mark it.
 */
export async function reprojectDeferred(): Promise<void> {
  await transact(async (tx) => {
    const rows = await tx
      .select()
      .from(facts)
      .where(inArray(facts.kind, ['hist', 'read', 'pos', 'member']))
    for (const group of chunk(rows, CHUNK_SIZE)) {
      await applyFacts(tx, group)
    }
  })
}

async function readStored(
  tx: DbTransaction,
  group: readonly SyncFact[],
): Promise<Map<string, Fact>> {
  const held = new Map<string, Fact>()
  const kinds = [...new Set(group.map((fact) => fact.kind))]

  for (const kind of kinds) {
    const keys = group.filter((fact) => fact.kind === kind).map((fact) => fact.key)
    const rows = await tx
      .select()
      .from(facts)
      .where(and(eq(facts.kind, kind), inArray(facts.key, [...new Set(keys)])))
    for (const row of rows) held.set(`${row.kind}\u0000${row.key}`, row)
  }
  return held
}

// ---------------------------------------------------------------- status --

/**
 * How much is waiting to be sent.
 *
 * One counted index on one table, where the row-mirroring protocol had to
 * count a partial index on each of six tables and then the tombstones.
 */
export async function pendingCount(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(facts)
    .where(eq(facts.acked, false))
  return Number(row?.count ?? 0)
}
