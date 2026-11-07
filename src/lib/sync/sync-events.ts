/**
 * The moments a sync fires on its own.
 *
 * Every trigger is an event a reader causes or a browser reports, never a
 * clock: finishing a chapter, leaving the reader, bringing the app back into
 * view, and the connection returning. Nothing here runs while a page is open.
 *
 * All of them pass through `requestSync`, which is what stops a burst of
 * events from becoming a burst of requests. Finishing a chapter and closing
 * the reader arrive seconds apart, and a tab that is switched to and away
 * repeatedly would otherwise hit the server on every switch. Runs are held to
 * one per `MIN_GAP_MS`; a request landing inside the gap is not dropped but
 * folded into a single run at the end of it, so the last event always lands.
 *
 * The runner itself is registered by `useSyncOnEvents` from the root layout.
 * `requestSync` is a plain function so the reader can call it without touching
 * Clerk hooks, which throw on a build with no key; on such a build there is no
 * runner and the request is a no-op.
 */

import { useEffect, useRef } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { useAuth } from '@clerk/react'

import { useDatabaseReady } from '@/lib/db/provider'
import { registerSyncRunner, requestSync } from './sync-request'
import { useSync, useSyncEntitled } from './use-sync'

/**
 * Mounted once, app-wide, beside the sign-in run. Registers the runner while
 * the session can sync and wires the browser and router events to it.
 */
export function useSyncOnEvents(): void {
  const { isLoaded, userId } = useAuth()
  const entitled = useSyncEntitled()
  const ready = useDatabaseReady()
  const { sync } = useSync()

  const canSync = isLoaded && ready && entitled && Boolean(userId)

  useEffect(() => {
    registerSyncRunner(canSync ? sync : null)
    return () => registerSyncRunner(null)
  }, [canSync, sync])

  // Only the transition into hidden matters: a run on return is what brings
  // other devices' reading down, and a tab that was never hidden has nothing
  // new to fetch.
  const wasHidden = useRef(false)
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        wasHidden.current = true
        return
      }
      if (!wasHidden.current) return
      wasHidden.current = false
      requestSync('visible')
    }
    const onOnline = () => requestSync('online')

    document.addEventListener('visibilitychange', onVisibility)
    globalThis.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      globalThis.removeEventListener('online', onOnline)
    }
  }, [])

  // Leaving the reader, not entering it. The last page write is flushed when
  // the reader unmounts, so by the time this effect sees the new path the
  // position is in the ledger and ready to go up.
  const inReader = useRouterState({
    select: (state) => state.location.pathname.startsWith('/reader/'),
  })
  const wasInReader = useRef(inReader)
  useEffect(() => {
    if (wasInReader.current && !inReader) requestSync('left-reader')
    wasInReader.current = inReader
  }, [inReader])
}
