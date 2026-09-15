/**
 * Object-URL ownership for the local source.
 *
 * Every blob URL the source hands out is minted here against a stable key (a
 * series folder for a cover, a chapter plus page index for a page). Asking
 * twice for the same key returns the same URL, so a React Query refetch of the
 * same chapter does not mint a second copy of bytes already in memory.
 *
 * Ownership rule: **the registry owns the URLs, not the reader.** Nothing is
 * revoked on unmount, because React Query keeps the page array cached under
 * `['reader', 'pages', ...]` for its gcTime after the reader closes, and a
 * back-navigation would then render URLs that had already been revoked.
 * Instead each cache is bounded and least-recently-used entries are revoked on
 * eviction; the whole registry is cleared when the library folder changes or is
 * forgotten. Anything still alive at that point dies with the document, which
 * the browser cleans up on unload.
 */

/** Roughly three chapters of a long webtoon held at once. */
const PAGE_CAPACITY = 600
/** Covers are small and are re-shown constantly while browsing. */
const COVER_CAPACITY = 300

class BlobUrlCache {
  private readonly capacity: number
  /** Insertion-ordered, so the first key is the least recently used. */
  private readonly urls = new Map<string, string>()

  constructor(capacity: number) {
    this.capacity = capacity
  }

  /** The URL for `key`, creating it from `blob` when this is the first ask. */
  put(key: string, blob: Blob): string {
    const existing = this.urls.get(key)
    if (existing) {
      this.urls.delete(key)
      this.urls.set(key, existing)
      return existing
    }

    const url = URL.createObjectURL(blob)
    this.urls.set(key, url)
    this.evict()
    return url
  }

  has(key: string): boolean {
    return this.urls.has(key)
  }

  get(key: string): string | undefined {
    const url = this.urls.get(key)
    if (!url) return undefined
    this.urls.delete(key)
    this.urls.set(key, url)
    return url
  }

  clear(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url)
    this.urls.clear()
  }

  private evict(): void {
    while (this.urls.size > this.capacity) {
      const oldest = this.urls.keys().next()
      if (oldest.done) return
      const url = this.urls.get(oldest.value)
      this.urls.delete(oldest.value)
      if (url) URL.revokeObjectURL(url)
    }
  }
}

export const pageUrls = new BlobUrlCache(PAGE_CAPACITY)
export const coverUrls = new BlobUrlCache(COVER_CAPACITY)

/** Called when the chosen folder changes: every URL now points at stale bytes. */
export function clearLocalBlobUrls(): void {
  pageUrls.clear()
  coverUrls.clear()
}
