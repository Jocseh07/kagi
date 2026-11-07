/**
 * Whether this device is waiting on its first sync, for the pages that would
 * otherwise draw an empty library while it runs.
 *
 * A module store rather than a hook over Clerk, for the same reason as
 * lib/profile/identity.ts: Home and Library render on keyless builds, where
 * every Clerk hook throws. `useSyncOnSignIn` writes it; on a keyless build
 * nothing does, and it stays `false`.
 */

import { useSyncExternalStore } from 'react'

let pending = false
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): boolean {
  return pending
}

export function setFirstSyncPending(next: boolean): void {
  if (pending === next) return
  pending = next
  for (const listener of [...listeners]) listener()
}

export function useFirstSyncPending(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
