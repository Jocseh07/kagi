/**
 * Image URL ownership for the local sources on native.
 *
 * There are no blob URLs here: every image the sources hand out is a file in
 * app storage (an imported image, or one extracted into the cache), and its
 * URL is the file's own URI. The caches keep the same keys and API as the web
 * so the shared sources can ask "do I already have this cover?" without
 * reopening an archive.
 */

import {
  deleteIfExists,
  fileAt,
  localCacheRoot,
  localFileOf,
} from '@/lib/storage/native-files'

class FileUrlCache {
  private readonly urls = new Map<string, string>()

  /** The URI of the app-storage file behind `blob`, remembered under `key`. */
  put(key: string, blob: Blob): string {
    const existing = this.urls.get(key)
    if (existing) return existing
    const uri = localFileOf(blob).uri
    this.urls.set(key, uri)
    return uri
  }

  has(key: string): boolean {
    return this.urls.has(key)
  }

  get(key: string): string | undefined {
    return this.urls.get(key)
  }

  /** Forgets one entry, deleting it when it is a derived file in the cache. */
  drop(key: string): void {
    const uri = this.urls.get(key)
    if (!uri) return
    this.urls.delete(key)
    if (uri.startsWith(localCacheRoot().uri)) deleteIfExists(fileAt(uri))
  }

  clear(): void {
    this.urls.clear()
  }
}

export const pageUrls = new FileUrlCache()
export const coverUrls = new FileUrlCache()

/** Called when imported files change: remembered URIs may now point at stale files. */
export function clearLocalBlobUrls(): void {
  pageUrls.clear()
  coverUrls.clear()
}
