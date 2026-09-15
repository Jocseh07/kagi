/**
 * The one folder the local source reads from.
 *
 * The handle is kept in IndexedDB by `lib/storage/handles`, since a
 * `FileSystemDirectoryHandle` is structured-cloneable but not serialisable and
 * so cannot live in SQLite. Permission does not necessarily survive a reload:
 * Chromium may hand the handle back in the `prompt` state, and re-requesting it
 * needs a user gesture, which is why `reconnect` is separate from `refresh`.
 */

import {
  deleteDirectoryHandle,
  getDirectoryHandle,
  pickDirectory,
  supportsFileSystemAccess,
  verifyPermission,
} from '@/lib/storage/handles'

import { clearLocalBlobUrls } from './blob-urls'
import { clearLocalMetadata } from './metadata'

export const LOCAL_LIBRARY_KEY = 'local-library'

export type LocalLibraryStatus =
  /** No File System Access API in this browser. */
  | 'unsupported'
  /** Supported, but no folder has been chosen yet. */
  | 'unset'
  /** A folder is remembered, but this browsing session may not read it yet. */
  | 'denied'
  | 'ready'

export interface LocalLibraryState {
  status: LocalLibraryStatus
  /** The chosen folder's name, once one is remembered. */
  folderName: string | null
}

const UNSUPPORTED: LocalLibraryState = {
  status: 'unsupported',
  folderName: null,
}

let state: LocalLibraryState = supportsFileSystemAccess()
  ? { status: 'unset', folderName: null }
  : UNSUPPORTED

let root: FileSystemDirectoryHandle | null = null
let loaded: Promise<LocalLibraryState> | undefined
/** Bumped by every explicit choice, so a slower load cannot overwrite one. */
let generation = 0

const listeners = new Set<() => void>()

export function supportsLocalLibrary(): boolean {
  return supportsFileSystemAccess()
}

/** Stable snapshot, safe to hand to `useSyncExternalStore`. */
export function getLocalLibraryState(): LocalLibraryState {
  return state
}

export function subscribeLocalLibrary(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function publish(next: LocalLibraryState): LocalLibraryState {
  state = next
  for (const listener of listeners) listener()
  return next
}

/** Records a state reached without going through IndexedDB, so no later load undoes it. */
function settle(next: LocalLibraryState): LocalLibraryState {
  generation++
  publish(next)
  loaded = Promise.resolve(next)
  return next
}

/**
 * Load the remembered folder once per page load.
 *
 * Called from both the UI and the source itself, so a reader opened directly on
 * a local chapter does not depend on the picker having been mounted first.
 */
export function loadLocalLibrary(): Promise<LocalLibraryState> {
  loaded ??= (async () => {
    // A folder picked while this load was in flight is the newer truth, so the
    // load stops rather than publishing what IndexedDB held a moment ago.
    const mine = generation
    const stale = () => mine !== generation

    if (!supportsFileSystemAccess()) return publish(UNSUPPORTED)

    const handle = await getDirectoryHandle(LOCAL_LIBRARY_KEY)
    if (stale()) return state
    if (!handle) return publish({ status: 'unset', folderName: null })

    // Read is all this source ever needs; asking for write here would prompt
    // for more than it uses.
    const granted = await verifyPermission(handle, 'read')
    if (stale()) return state

    if (granted) {
      root = handle
      return publish({ status: 'ready', folderName: handle.name })
    }

    return publish({ status: 'denied', folderName: handle.name })
  })()

  return loaded
}

/** Re-runs the permission check; call it from a click so a prompt can be shown. */
export async function reconnectLocalLibrary(): Promise<LocalLibraryState> {
  if (!supportsFileSystemAccess()) return publish(UNSUPPORTED)

  const handle = await getDirectoryHandle(LOCAL_LIBRARY_KEY)
  if (!handle) return publish({ status: 'unset', folderName: null })

  if (await verifyPermission(handle, 'read')) {
    root = handle
    clearCaches()
    return settle({ status: 'ready', folderName: handle.name })
  }

  return settle({ status: 'denied', folderName: handle.name })
}

/** Opens the directory picker. Must be called from a user gesture. */
export async function chooseLocalLibrary(): Promise<LocalLibraryState> {
  if (!supportsFileSystemAccess()) return publish(UNSUPPORTED)

  const handle = await pickDirectory(LOCAL_LIBRARY_KEY, 'read')
  // Null means the picker was dismissed; the current folder stays as it was.
  if (!handle) return state

  root = handle
  clearCaches()
  return settle({ status: 'ready', folderName: handle.name })
}

export async function forgetLocalLibrary(): Promise<LocalLibraryState> {
  await deleteDirectoryHandle(LOCAL_LIBRARY_KEY)
  root = null
  clearCaches()
  return settle(
    supportsFileSystemAccess() ? { status: 'unset', folderName: null } : UNSUPPORTED,
  )
}

/** The readable root, or null when none is chosen or permission is missing. */
export async function getLibraryRoot(): Promise<FileSystemDirectoryHandle | null> {
  await loadLocalLibrary()
  return root
}

/**
 * The root, or a message explaining what the user has to do about it. Used
 * where an empty list would look like an empty library rather than a missing
 * one.
 */
export async function requireLibraryRoot(): Promise<FileSystemDirectoryHandle> {
  const handle = await getLibraryRoot()
  if (handle) return handle

  const current = getLocalLibraryState()
  if (current.status === 'unsupported') {
    throw new Error(
      'This browser cannot open local folders. The File System Access API is currently Chromium-only.',
    )
  }
  if (current.status === 'denied') {
    throw new Error(
      `Permission to read "${current.folderName ?? 'the library folder'}" was not granted. Reconnect it from Browse.`,
    )
  }
  throw new Error('No local library folder has been chosen yet. Pick one from Browse.')
}

/**
 * Newest modification time seen inside a series folder, memoised per folder.
 *
 * Directory handles expose no timestamp of their own, so this samples the
 * files inside instead. It is cleared whenever the chosen folder changes; a
 * library edited on disk in the background keeps the timestamps read at first
 * listing until the page is reloaded.
 */
const timestamps = new Map<string, number>()

export function getCachedTimestamp(seriesName: string): number | undefined {
  return timestamps.get(seriesName)
}

export function cacheTimestamp(seriesName: string, value: number): void {
  timestamps.set(seriesName, value)
}

function clearCaches(): void {
  timestamps.clear()
  clearLocalMetadata()
  clearLocalBlobUrls()
}
