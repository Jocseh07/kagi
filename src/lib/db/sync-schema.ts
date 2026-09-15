/**
 * The server side of sync: one table.
 *
 * A fact is one decision the reader made, addressed by the thing it is about.
 * The server stores facts and orders them; it does not model a library, does
 * not know what a chapter is, and never reconciles anything column by column.
 * Three properties follow from that, and they are the whole design:
 *
 *  1. *No identity to agree on.* A key is built from a source id and a url, so
 *     two devices that have never spoken produce the same one. The old mirror
 *     tables were keyed by per-device ULIDs, which is why the same series added
 *     on two devices could not be filed at all.
 *  2. *Nothing to merge.* A stored fact is replaced only by a strictly later
 *     generation of itself, or by the same generation reaching further. One
 *     expression, identical for every kind of fact.
 *  3. *Nothing to delete.* An override is a later generation saying something
 *     else, so a removal travels exactly like an addition and cannot be lost by
 *     arriving out of order.
 *
 * `seq` is a per-user monotonic counter the server assigns on write. Clients
 * pull with `seq > cursor`, which is why the cursor is one integer: `updatedAt`
 * came from client clocks and could not be ordered across devices. There is no
 * `updatedAt` here at all any more, and no `deviceId`: neither decided
 * anything, and both cost bytes on every row.
 */

import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
// Explicit extensions: `drizzle-kit generate` loads this file directly, outside
// the app's bundler resolution, and will not find an extensionless import. The
// client build resolves it identically either way.
import type { FactKind } from '@/lib/sync/fact-kinds.ts'

export const syncFacts = sqliteTable(
  'sync_facts',
  {
    /** From the verified token, never from the body. The only tenancy boundary. */
    userId: text('user_id').notNull(),
    kind: text('kind').$type<FactKind>().notNull(),
    key: text('key').notNull(),
    gen: integer('gen').notNull().default(0),
    val: integer('val').notNull().default(0),
    state: integer('state').notNull().default(1),
    payload: text('payload'),
    /** Server clock, assigned on write. What `?cursor=` is compared against. */
    seq: integer('seq').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.kind, t.key] }),
    index('sync_facts_cursor_idx').on(t.userId, t.seq),
  ],
)

/**
 * Per-user sequence allocator.
 *
 * D1 has no sequences, and `max(seq) + 1` is a read before every write. One row
 * per user, bumped once per batch, is one read and one write.
 */
export const syncCursor = sqliteTable('sync_cursor', {
  userId: text('user_id').primaryKey(),
  seq: integer('seq').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
})

/**
 * Who has paid for sync.
 *
 * One row per user, written by the Polar webhook and by the on-demand refresh
 * in server/polar.ts. `active` is "has at least one active Polar subscription"
 * rather than a product id, so the plan can be renamed or repriced in the
 * Polar dashboard without a deploy. A missing row means "never asked Polar",
 * which the refresh path resolves before the sync routes answer.
 */
export const syncEntitlements = sqliteTable('sync_entitlements', {
  userId: text('user_id').primaryKey(),
  active: integer('active').notNull().default(0),
  polarCustomerId: text('polar_customer_id'),
  /** JSON snapshot of the active subscription, for display. See server/polar.ts. */
  subscription: text('subscription'),
  updatedAt: integer('updated_at').notNull(),
})

export const syncSchema = {
  syncFacts,
  syncCursor,
  syncEntitlements,
}
