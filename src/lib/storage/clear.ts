/**
 * Freeing storage, one bucket at a time.
 *
 * Each of these mirrors a row in the Storage panel's breakdown, so what a
 * button removes is exactly what its figure counted.
 */

import { wipeDatabase } from '@/lib/db/client'
import { runMigrations } from '@/lib/db/migrate'
import { PAGE_CACHE, SHELL_CACHE } from '@/lib/offline/types'

/** IndexedDB holding the local source's folder handle; see `storage/handles`. */
const HANDLE_DB_NAME = 'kagi-handles'

/** Everything this app puts in localStorage. */
const LOCAL_STORAGE_KEYS = [
  'kagi.device-id',
  'kagi:reader-mode',
  'kagi:theme',
  'kagi:theme-active',
  'kagi:theme-catalog',
  'kagi:custom-themes',
]

/**
 * Drops the precached app.
 *
 * Costs nothing but an offline launch: the worker's stale-while-revalidate rule
 * refills the cache from the next online load onwards.
 */
export async function clearAppShell(): Promise<void> {
  if (typeof caches === 'undefined') return
  await caches.delete(SHELL_CACHE)
}

/**
 * Empties the library and rebuilds its schema.
 *
 * The page cache goes with it. Cached page images are keyed by URL and the only
 * record of which URLs belong to a saved chapter lives in the rows being
 * erased, so leaving them behind would strand bytes nothing could ever name
 * again, let alone free.
 */
export async function eraseLibrary(): Promise<void> {
  await wipeDatabase()
  if (typeof caches !== 'undefined') await caches.delete(PAGE_CACHE)
  await runMigrations()
}

/**
 * Forgets the device id, the reader's preferences and the chosen local folder.
 *
 * Reloads afterwards: the local source keeps its folder handle in memory for
 * the life of the page, and there is no way to tell it the handle is gone.
 */
export async function clearOtherData(): Promise<void> {
  for (const key of LOCAL_STORAGE_KEYS) {
    try {
      globalThis.localStorage?.removeItem(key)
    } catch {
      // Storage is blocked (private mode); there was nothing to remove.
    }
  }

  await deleteHandleDatabase()
  globalThis.location.reload()
}

/**
 * Resolves whichever way the delete goes. A `blocked` event means another tab
 * holds the database open, and waiting on it would hang this call forever.
 */
function deleteHandleDatabase(): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve()
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(HANDLE_DB_NAME)
      request.onsuccess = () => resolve()
      request.onerror = () => resolve()
      request.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}
