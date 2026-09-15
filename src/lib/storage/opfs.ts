/**
 * Blob cache in OPFS, keyed by URL. Used for downloaded pages and covers, which
 * are far too large for SQLite rows.
 *
 * Kept in a subdirectory of its own so it never collides with the sqlite
 * opfs-sahpool VFS directory.
 */

const CACHE_DIR = 'blob-cache'

let dirPromise: Promise<FileSystemDirectoryHandle | null> | undefined

export function supportsOpfs(): boolean {
  if (typeof navigator === 'undefined') return false
  return typeof navigator.storage?.getDirectory === 'function'
}

function supportsWritable(): boolean {
  return (
    'FileSystemFileHandle' in globalThis &&
    typeof FileSystemFileHandle.prototype.createWritable === 'function'
  )
}

function cacheDir(): Promise<FileSystemDirectoryHandle | null> {
  dirPromise ??= (async () => {
    if (!supportsOpfs()) return null
    try {
      const root = await navigator.storage.getDirectory()
      return await root.getDirectoryHandle(CACHE_DIR, { create: true })
    } catch {
      return null
    }
  })()
  return dirPromise
}

function fallbackHash(key: string): string {
  // FNV-1a, 32-bit, run twice over offset halves to widen the output.
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < key.length; i++) {
    a = Math.imul(a ^ key.charCodeAt(i), 0x01000193) >>> 0
    b = Math.imul(b + key.charCodeAt(i), 0x85ebca6b) >>> 0
  }
  return (
    a.toString(16).padStart(8, '0') +
    b.toString(16).padStart(8, '0') +
    key.length.toString(16)
  )
}

async function fileName(key: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return fallbackHash(key)
  try {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(key),
    )
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return fallbackHash(key)
  }
}

export async function getBlob(url: string): Promise<Blob | null> {
  const dir = await cacheDir()
  if (!dir) return null
  try {
    const handle = await dir.getFileHandle(await fileName(url))
    return await handle.getFile()
  } catch {
    return null
  }
}

export async function hasBlob(url: string): Promise<boolean> {
  const dir = await cacheDir()
  if (!dir) return false
  try {
    await dir.getFileHandle(await fileName(url))
    return true
  } catch {
    return false
  }
}

export async function putBlob(url: string, blob: Blob): Promise<boolean> {
  const dir = await cacheDir()
  if (!dir || !supportsWritable()) return false
  try {
    const handle = await dir.getFileHandle(await fileName(url), { create: true })
    const writable = await handle.createWritable()
    await writable.write(blob)
    await writable.close()
    return true
  } catch {
    return false
  }
}

export async function deleteBlob(url: string): Promise<boolean> {
  const dir = await cacheDir()
  if (!dir) return false
  try {
    await dir.removeEntry(await fileName(url))
    return true
  } catch {
    return false
  }
}

export async function clearBlobs(): Promise<void> {
  if (!supportsOpfs()) return
  try {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(CACHE_DIR, { recursive: true })
    dirPromise = undefined
  } catch {
    // Nothing cached yet, or OPFS is unavailable.
  }
}
