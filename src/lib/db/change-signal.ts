/**
 * In-memory signal for "the library changed on this device".
 *
 * Nothing here schedules work. This exists so the "waiting to send" count in
 * the Sync panel, and the dot on the header's sync button, can move the moment
 * a decision is recorded, without counting the ledger on every render.
 *
 * `pendingHint` is a hint, not the truth. The truth is the unacknowledged rows
 * in `facts`; the hint is seeded from it when the Sync panel opens and
 * corrected after every sync run. In between it only ever overestimates, which errs on
 * the side of showing something is outstanding.
 *
 * Only bumped by writes that can actually queue a fact. Saving a chapter
 * offline, caching a page count, or refetching a chapter list all change the
 * database and none of them is the reader's decision, so none of them belongs
 * in a count of what is waiting to be sent.
 */

type Listener = () => void

let version = 0
let pendingHint = 0
const listeners = new Set<Listener>()

function publish(): void {
  for (const listener of [...listeners]) listener()
}

/** Called after a committed write that stated something in the ledger. */
export function bumpChangeSignal(count = 1): void {
  version += 1
  pendingHint += count
  publish()
}

/** Reconciles the hint with the real count of unacknowledged facts. */
export function setPendingHint(count: number): void {
  pendingHint = Math.max(0, count)
  publish()
}

export function getChangeVersion(): number {
  return version
}

/** Roughly how many local changes are waiting to be pushed. */
export function getPendingHint(): number {
  return pendingHint
}

export function subscribeChanges(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
