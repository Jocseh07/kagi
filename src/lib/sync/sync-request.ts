/**
 * The rate-limited sync request every automatic trigger goes through.
 *
 * Plain functions, free of router and Clerk imports, so the reader can ask for
 * a sync on any build. With no runner registered the request is a no-op.
 */

import { appUpdateBlocked } from '@/lib/runtime/app-update-safety'
import { isOnline } from '@/lib/offline/use-online'

/** Shortest distance between two automatic runs. */
const MIN_GAP_MS = 30_000

export type SyncReason = 'chapter-read' | 'left-reader' | 'visible' | 'online'

type Runner = () => Promise<void>

let runner: Runner | null = null
let lastStartedAt = 0
let trailing: ReturnType<typeof setTimeout> | null = null

function start(): void {
  if (!runner || appUpdateBlocked()) return
  lastStartedAt = Date.now()
  void runner()
}

/**
 * Asks for a sync soon. Runs at once when the last one is old enough,
 * otherwise once at the end of the gap, however many times it is asked.
 */
export function requestSync(_reason: SyncReason): void {
  if (!runner || appUpdateBlocked() || !isOnline()) return
  const elapsed = Date.now() - lastStartedAt
  if (elapsed >= MIN_GAP_MS) {
    start()
    return
  }
  trailing ??= setTimeout(() => {
    trailing = null
    start()
  }, MIN_GAP_MS - elapsed)
}

export function registerSyncRunner(next: Runner | null): void {
  runner = next
  if (next === null && trailing !== null) {
    clearTimeout(trailing)
    trailing = null
  }
}
