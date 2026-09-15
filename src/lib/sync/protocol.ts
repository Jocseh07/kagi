/**
 * The wire format, shared by the client drain loop and the Worker routes.
 *
 * Kept free of imports from either side so both can use it: the browser half
 * cannot see D1 types, and the Worker half cannot see the OPFS client.
 */

import { isFactKind } from './fact-kinds'
import type { FactKind } from './fact-kinds'

/**
 * One decision, as it travels.
 *
 * Not a row, and not an edit either. A fact is the reader's current answer
 * about one thing, and the generation is how many times they have changed that
 * answer. Nothing here is a clock, a device, or a row id, because none of the
 * three decided anything and all three cost bytes on every fact.
 */
export interface SyncFact {
  kind: FactKind
  /** Built from what the fact is about: a source id and a url, a name, a key. */
  key: string
  /** Bumped when the reader overrode what they said before. */
  gen: number
  /** The furthest-wins value within one generation: page, timestamp, order. */
  val: number
  /** 1 for stated, 0 for hidden. A removal travels exactly like an addition. */
  state: number
  /** Display label, or the value itself for a setting. */
  payload?: string | null
}

export interface PushRequest {
  facts: SyncFact[]
}

export interface PushResponse {
  /** The high-water mark after this push. */
  seq: number
  /** How many facts were accepted, not how many were sent. */
  applied: number
}

export interface PullResponse {
  facts: SyncFact[]
  /** Where the next pull resumes. */
  cursor: number
  /** True when more remain past `cursor`; the client should pull again. */
  hasMore: boolean
}

/**
 * Reads a cursor off the wire or out of local settings.
 *
 * Anything unreadable is zero, which re-pulls the account from the beginning.
 * That is cheap and safe: applying a fact twice cannot change the answer, and
 * the alternative — guessing at a position — silently skips whatever sits
 * above the guess.
 */
export function parseCursor(raw: unknown): number {
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return Math.floor(value)
}

/** Whether an untrusted value is a fact this server will store. */
export function isSyncFact(value: unknown): value is SyncFact {
  if (!value || typeof value !== 'object') return false
  const fact = value as Record<string, unknown>
  return (
    typeof fact.kind === 'string' &&
    isFactKind(fact.kind) &&
    typeof fact.key === 'string' &&
    fact.key.length > 0 &&
    fact.key.length <= MAX_KEY_BYTES &&
    isCount(fact.gen) &&
    isCount(fact.val) &&
    isCount(fact.state) &&
    (fact.payload === undefined ||
      fact.payload === null ||
      (typeof fact.payload === 'string' && fact.payload.length <= MAX_PAYLOAD_BYTES))
  )
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Facts per push.
 *
 * Bounded for three reasons at once: a Worker request body is capped, the whole
 * push becomes one `db.batch()` whose statement list should stay sane, and an
 * unbounded batch is a cheap way for a client to burn the account's daily write
 * quota.
 */
export const MAX_PUSH_BATCH = 500

/** Facts returned by one pull, for the same reasons in reverse. */
export const MAX_PULL_BATCH = 500

/** A key is a source id and a url; anything longer is not addressing a series. */
export const MAX_KEY_BYTES = 2048

/** A label, or a setting's value. Generous for a theme, far under D1's row cap. */
export const MAX_PAYLOAD_BYTES = 20_000
