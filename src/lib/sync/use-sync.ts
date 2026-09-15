/**
 * When sync runs: once when a session signs in, whenever the user asks, and on
 * the events in lib/sync/sync-events.ts — finishing a chapter, leaving the
 * reader, the app coming back into view, the connection returning.
 *
 * Never on a timer, and never while a page is open. A device is complete on
 * its own, and nothing moves while someone reads.
 *
 * The sign-in run exists because the alternative is worse: a fresh device shows
 * an empty library and nothing on screen says a sync is what fills it. It fires
 * once per account id per session and is silent, including on failure; the
 * header button and the Sync panel report what happened.
 *
 * One run is a whole sync: `runSync` pushes every dirty row, pulls everything
 * waiting, and repeats until both sides are drained.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { useAuth } from '@clerk/react'
import { useQueryClient } from '@tanstack/react-query'

import { useEntitlement } from '@/lib/billing/use-entitlement'
import { setPendingHint } from '@/lib/db/change-signal'
import { useDatabaseReady } from '@/lib/db/provider'
import { pendingCount } from './local'
import { getSyncState, runSync, subscribeSyncState } from './client'
import type { SyncState } from './client'

/**
 * Whether this session can sync at all: signed in, and on the Sync plan.
 *
 * A signed-out device still behaves exactly as it always has, because its data
 * is complete and safe locally. The server enforces the same check; gating
 * here keeps an unsubscribed account from firing requests that would only
 * come back 402.
 *
 * The plan is `undefined` until the status query answers, which reads as "not
 * entitled" and simply disables the button until it is known.
 */
export function useSyncEntitled(): boolean {
  const { isSignedIn } = useAuth()
  const { active } = useEntitlement()
  return isSignedIn === true && active === true
}

export function useSync(): SyncState & { sync: () => Promise<void> } {
  const { userId, getToken } = useAuth()
  const entitled = useSyncEntitled()
  const queryClient = useQueryClient()
  const state = useSyncExternalStore(subscribeSyncState, getSyncState, getSyncState)

  // Held in a ref so `sync` keeps a stable identity: `getToken` is a fresh
  // function on some renders, and depending on it directly would hand every
  // caller a new callback each time.
  const latest = useRef({ entitled, userId, getToken })
  useEffect(() => {
    latest.current = { entitled, userId, getToken }
  })

  const sync = useCallback(async () => {
    const { entitled: canSync, userId: id, getToken: token } = latest.current
    if (!canSync || !id) return

    const outcome = await runSync(id, () => token())

    // Everything on screen reads the local database, so a pull that changed
    // rows has to refresh the caches over it — and only those. Source and
    // browse queries hit rate-limited hosts and must not be refetched here.
    if (outcome.pulled > 0) {
      await queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === 'db',
      })
    }
  }, [queryClient])

  return { ...state, sync }
}

/**
 * The sign-in run. Mounted once, app-wide — see the root layout's SyncRuntime.
 *
 * Keyed on the account id rather than on a boolean: signing out and back in as
 * somebody else is a new session and syncs again, while a token refresh, a
 * re-render, or Clerk handing back a fresh user object is not. The ref is set
 * before the call so a render landing mid-run cannot start a second one — and
 * `runSync` would share the run in flight anyway.
 *
 * Waits on the database as well as on Clerk: pushing before the local store is
 * open would send an empty ledger and mark nothing, and pulling into it would
 * throw. Nothing here reports; `runSync` swallows its own failures.
 */
export function useSyncOnSignIn(): void {
  const { isLoaded, userId } = useAuth()
  const entitled = useSyncEntitled()
  const ready = useDatabaseReady()
  const { sync } = useSync()

  // The hint starts at zero every load and only moves on writes made since, so
  // the header's dot would miss changes left over from the last session until
  // Settings → Sync happened to count them. Counted once here instead, as soon
  // as the database opens. A run of its own reconciles it again when it ends.
  useEffect(() => {
    if (!ready) return
    void pendingCount()
      .then(setPendingHint)
      // An unopened database only costs the dot; the count is a hint either way.
      .catch(() => {})
  }, [ready])

  const syncedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!isLoaded || !ready || !entitled || !userId) return
    if (syncedFor.current === userId) return
    syncedFor.current = userId
    void sync()
  }, [isLoaded, ready, entitled, userId, sync])
}
