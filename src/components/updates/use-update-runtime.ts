import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { dbKeys } from '@/lib/db/query-keys'
import { updateManager } from '@/lib/updates/update-manager'
import type { UpdateRuntimeState } from '@/lib/updates/update-manager'

/** Longest a running check may go between feed refreshes. */
const REFRESH_EVERY_MS = 4_000

/**
 * Subscribes to the update runtime and refreshes what a run changes.
 *
 * The runtime is a module singleton, so unmounting deliberately does not stop
 * it: a check started here carries on while the user reads or browses.
 *
 * Invalidation is tied to `newChapters` rather than `revision` — the run
 * publishes on every series, and the library query is expensive enough that
 * refetching it a hundred times for no new rows would be worse than the check.
 * Even then it is throttled: a run over a large library finds chapters in
 * quick succession, and refetching the feed for each one re-lays out the
 * page dozens of times. The final refresh is tied to the run finishing, so
 * nothing found in the last window is missed.
 */
export function useUpdateRuntime(): UpdateRuntimeState {
  const queryClient = useQueryClient()
  const state = useSyncExternalStore(
    updateManager.subscribe,
    updateManager.getSnapshot,
  )

  const { newChapters } = state
  const finishedAt = state.summary?.finishedAt
  const lastRefreshAt = useRef(0)
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const refresh = () => {
      lastRefreshAt.current = Date.now()
      pending.current = null
      void queryClient.invalidateQueries({ queryKey: dbKeys.updates })
      void queryClient.invalidateQueries({ queryKey: dbKeys.library })
      void queryClient.invalidateQueries({ queryKey: dbKeys.allChapters })
    }

    if (newChapters === 0) return
    if (finishedAt) {
      if (pending.current) clearTimeout(pending.current)
      refresh()
      return
    }
    if (pending.current) return

    const wait = lastRefreshAt.current + REFRESH_EVERY_MS - Date.now()
    if (wait <= 0) {
      refresh()
      return
    }
    pending.current = setTimeout(refresh, wait)
  }, [queryClient, newChapters, finishedAt])

  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current)
    },
    [],
  )

  return state
}
