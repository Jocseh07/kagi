/**
 * FileSystemDirectoryHandles live in IndexedDB, not SQLite: they are
 * structured-cloneable but not serialisable to text, so there is no way to put
 * one in a SQL column and get a working handle back.
 *
 * The File System Access API (showDirectoryPicker) is Chromium-only. Every
 * export here degrades to a null/false result elsewhere so the app still loads.
 */

import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'

export type PermissionMode = 'read' | 'readwrite'

interface DirectoryPickerOptions {
  id?: string
  mode?: PermissionMode
  startIn?: string
}

interface FileSystemAccessGlobal {
  showDirectoryPicker?: (
    options?: DirectoryPickerOptions,
  ) => Promise<FileSystemDirectoryHandle>
}

/** Non-standard, Chromium-only members not present in lib.dom. */
interface PermissionCapableHandle {
  queryPermission?: (descriptor: {
    mode: PermissionMode
  }) => Promise<PermissionState>
  requestPermission?: (descriptor: {
    mode: PermissionMode
  }) => Promise<PermissionState>
}

interface HandleDb extends DBSchema {
  handles: { key: string; value: FileSystemDirectoryHandle }
}

const DB_NAME = 'kagi-handles'
const STORE = 'handles'

let dbPromise: Promise<IDBPDatabase<HandleDb>> | undefined

export function supportsIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined'
}

export function supportsFileSystemAccess(): boolean {
  const global = globalThis as unknown as FileSystemAccessGlobal
  return typeof global.showDirectoryPicker === 'function'
}

function getDb(): Promise<IDBPDatabase<HandleDb>> | undefined {
  if (!supportsIndexedDb()) return undefined
  dbPromise ??= openDB<HandleDb>(DB_NAME, 1, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE)
      }
    },
  })
  return dbPromise
}

export async function saveDirectoryHandle(
  key: string,
  handle: FileSystemDirectoryHandle,
): Promise<boolean> {
  const database = await getDb()
  if (!database) return false
  try {
    await database.put(STORE, handle, key)
    return true
  } catch {
    // Some engines refuse to structured-clone handles; treat as unsupported.
    return false
  }
}

export async function getDirectoryHandle(
  key: string,
): Promise<FileSystemDirectoryHandle | null> {
  const database = await getDb()
  if (!database) return null
  try {
    return (await database.get(STORE, key)) ?? null
  } catch {
    return null
  }
}

export async function deleteDirectoryHandle(key: string): Promise<void> {
  const database = await getDb()
  if (!database) return
  try {
    await database.delete(STORE, key)
  } catch {
    // Nothing to clean up.
  }
}

export async function listDirectoryHandleKeys(): Promise<string[]> {
  const database = await getDb()
  if (!database) return []
  try {
    return await database.getAllKeys(STORE)
  } catch {
    return []
  }
}

/**
 * Query first, then prompt. Handles without the permission API (for instance
 * OPFS-derived ones) are already usable, so they report granted.
 */
export async function verifyPermission(
  handle: FileSystemDirectoryHandle,
  mode: PermissionMode = 'readwrite',
): Promise<boolean> {
  const capable = handle as FileSystemDirectoryHandle & PermissionCapableHandle
  if (typeof capable.queryPermission !== 'function') return true
  try {
    if ((await capable.queryPermission({ mode })) === 'granted') return true
    if (typeof capable.requestPermission !== 'function') return false
    return (await capable.requestPermission({ mode })) === 'granted'
  } catch {
    return false
  }
}

/** Opens the picker and persists the chosen directory. Null if unsupported or cancelled. */
export async function pickDirectory(
  key: string,
  mode: PermissionMode = 'readwrite',
): Promise<FileSystemDirectoryHandle | null> {
  const global = globalThis as unknown as FileSystemAccessGlobal
  const picker = global.showDirectoryPicker
  if (!picker) return null
  try {
    const handle = await picker({ id: key, mode })
    await saveDirectoryHandle(key, handle)
    return handle
  } catch {
    return null
  }
}

/** Stored handle, re-permissioned. Null when absent or permission is refused. */
export async function getUsableDirectory(
  key: string,
  mode: PermissionMode = 'readwrite',
): Promise<FileSystemDirectoryHandle | null> {
  const handle = await getDirectoryHandle(key)
  if (!handle) return null
  return (await verifyPermission(handle, mode)) ? handle : null
}
