import { useEffect, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { useDatabaseReady } from '@/lib/db/provider'
import { dbKeys } from '@/lib/db/query-keys'
import { queueManager } from '@/lib/download/queue-manager'
import type { QueueRuntimeState } from '@/lib/download/queue-manager'
import { acquireWakeLock, releaseWakeLock } from '@/lib/download/wake-lock'
import { verifyPendingChapters } from '@/lib/offline/save-chapter'

/**
 * Subscribes to the download runtime and keeps the queue queries fresh.
 *
 * The runtime is a module singleton, so mounting this hook starts it and
 * unmounting deliberately does not stop it: downloads carry on while the user
 * reads or browses. It stops itself when the queue drains.
 *
 * `queuedCount` restarts a runtime that wound down earlier while rows are
 * still waiting — a stopped loop only ever means `nextQueued` came back empty,
 * so this cannot ping-pong with the loop's own exit.
 */
export function useQueueRuntime(queuedCount = 0): QueueRuntimeState {
  const ready = useDatabaseReady()
  const queryClient = useQueryClient()
  const state = useSyncExternalStore(
    queueManager.subscribe,
    queueManager.getSnapshot,
    // The shell is prerendered, and this hook renders inside it now that the
    // database no longer gates the tree. Without a server snapshot React
    // throws and falls back to client rendering the whole document.
    queueManager.getServerSnapshot,
  )

  const { revision, completions, status } = state

  useEffect(() => {
    if (!ready) return
    if (status === 'stopped' && queuedCount === 0) return
    // A suspended runtime restarts itself when the app is visible again;
    // nudging it here would start downloads on a hidden page.
    if (status === 'suspended') return
    queueManager.nudge()
  }, [ready, status, queuedCount])

  // Wakes the loop the moment the app is looked at again, instead of leaving it
  // in a nap that a hidden tab's throttling stretches to a minute or more.
  useEffect(() => queueManager.watchVisibility(), [])

  // A chapter saved while the app was hidden is kept but not proved: a hidden
  // document will not load the images the check needs. This is where that debt
  // is settled, and it has to run on every return to the foreground, not only
  // on mount, because the app is usually already mounted when it is backgrounded.
  useEffect(() => {
    if (!ready) return
    const sweep = (): void => {
      if (document.visibilityState !== 'visible') return
      void verifyPendingChapters().then(() => {
        void queryClient.invalidateQueries({ queryKey: dbKeys.savedChapters })
      })
    }
    sweep()
    document.addEventListener('visibilitychange', sweep)
    return () => document.removeEventListener('visibilitychange', sweep)
  }, [ready, queryClient])

  // Only useful while the page itself is driving a download, but harmless
  // otherwise, and the browsers without Background Fetch are exactly the ones
  // that need it: there, a screen that sleeps freezes the download with it.
  useEffect(() => {
    if (status !== 'running') {
      void releaseWakeLock()
      return
    }
    const reacquire = (): void => {
      // The browser drops the lock whenever the document hides, and refuses a
      // new one until it is visible again.
      if (document.visibilityState === 'visible') void acquireWakeLock()
    }
    reacquire()
    document.addEventListener('visibilitychange', reacquire)
    return () => {
      document.removeEventListener('visibilitychange', reacquire)
      void releaseWakeLock()
    }
  }, [status])

  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: dbKeys.queue })
    void queryClient.invalidateQueries({ queryKey: dbKeys.queueSummary })
  }, [queryClient, revision])

  // Only a finished chapter changes anything outside the queue, and these are
  // the expensive reads, so they are not tied to the progress ticks.
  useEffect(() => {
    if (completions === 0) return
    void queryClient.invalidateQueries({ queryKey: dbKeys.allChapters })
    void queryClient.invalidateQueries({ queryKey: dbKeys.savedChapters })
    void queryClient.invalidateQueries({ queryKey: ['db', 'saved-chapter-ids'] })
    void queryClient.invalidateQueries({ queryKey: ['db', 'chapter-saved'] })
    void queryClient.invalidateQueries({ queryKey: dbKeys.storage })
  }, [queryClient, completions])

  return state
}
