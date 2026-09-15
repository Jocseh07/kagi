/**
 * Offline chapter saving.
 *
 * Page images come from CDNs that send no CORS headers. Read straight off one,
 * their bytes can never be read by JavaScript; they can still be stored as
 * *opaque* responses in the Cache API and handed back to an `<img>` by the
 * service worker, which buys offline reading but not file export or a size.
 *
 * A source proxied through this origin (see `resolveApiBase` in the Asura
 * Scans, Thunder Scans, Fenrirealm and MangaDot sources) is the readable case:
 * same-origin responses, so the worker counts them as it stores them and the
 * chapter's cost is known rather than projected.
 */

import type { ContentKind } from '@/lib/sources/types'

/** Cache holding opaque page images. Versioned so a format change can evict. */
export const PAGE_CACHE = 'page-images-v1'

/** Cache holding the precached application shell. */
export const SHELL_CACHE = 'app-shell-v1'

/**
 * Chrome inflates every cached opaque response to roughly this size for quota
 * accounting, regardless of the real byte count, so cross-origin sizes cannot
 * leak. What a chapter of such pages costs can only be projected from this.
 *
 * Only cross-origin pages are opaque. A source proxied through this origin
 * comes back readable, the service worker counts it as it stores it, and the
 * chapter carries an exact `measuredBytes` instead of anything derived here.
 */
export const OPAQUE_PADDING_BYTES = 7 * 1024 * 1024

/**
 * Sentinel for "keep everything". Saving then stops only when the browser
 * itself runs out of room, which is the honest ceiling: a fixed count deletes
 * chapters the user never asked to lose, on a device that may have plenty of
 * space left.
 */
export const SAVED_CHAPTER_LIMIT_UNLIMITED = 0

/** Upper bound on an explicit cap, so a typo cannot set an absurd one. */
export const MAX_SAVED_CHAPTER_LIMIT = 500

/** What an explicit cap starts at when one is switched on. */
export const SUGGESTED_SAVED_CHAPTER_LIMIT = 20

/** Ceiling on saved chapters before the oldest is evicted. */
export const DEFAULT_SAVED_CHAPTER_LIMIT = SAVED_CHAPTER_LIMIT_UNLIMITED

export const SETTING_SAVED_CHAPTER_LIMIT = 'offline.saved_chapter_limit'

/**
 * Opt in to a chapter's download being dropped once it has been read. Off
 * unless the key holds `'1'`, and never enabled as a side effect of the saved
 * chapter limit or of running low on room — those evict on their own terms.
 */
export const SETTING_DELETE_AFTER_READ = 'offline.delete_after_read'

/**
 * Hand downloads to the browser's Background Fetch service, so they continue
 * with the app hidden, backgrounded, or closed.
 *
 * On unless the key holds `'0'` — the opposite of the flags above, because the
 * behaviour it buys is what a user asking for a download already expects. The
 * switch exists because a background fetch is issued by the browser and so
 * escapes the per-origin pacing in `public/sw.js`: a source with a strict
 * per-IP rate limit may prefer the paced in-page path.
 */
export const SETTING_BACKGROUND_DOWNLOADS = 'offline.background_downloads'

export interface SaveProgress {
  completed: number
  total: number
  phase: 'fetching' | 'verifying'
}

/**
 * Abort reason for a save stopped because the app went to the background.
 *
 * Unlike a cancel, a suspended save keeps the pages it has already cached, so
 * the same chapter resumes from where it stopped when the app returns.
 */
export const SUSPEND_ABORT_REASON = 'suspended'

export interface SaveOptions {
  signal?: AbortSignal
  /**
   * Human label for the chapter, shown in the system download UI when the save
   * runs as a background fetch. Ignored by the in-page path.
   */
  title?: string
  /**
   * Minimum gap between page fetches, from the source's `pageFetchIntervalMs`.
   * The service worker does the fetching and so bypasses the source's own
   * limiter; omitting this leaves the worker on its conservative default.
   */
  minIntervalMs?: number
  onProgress?(progress: SaveProgress): void
}

export type SaveChapterResult =
  | {
      ok: true
      pageCount: number
      projectedBytes: number
      /**
       * Quota the save really consumed, summed from the sizes the service
       * worker read off the responses it stored. Null when any page arrived
       * opaque and so could not be counted, leaving `projectedBytes` as the
       * only number to show.
       */
      measuredBytes: number | null
    }
  | {
      ok: false
      reason:
        | 'no-pages'
        | 'no-service-worker'
        | 'quota-exceeded'
        | 'verify-failed'
        | 'network'
        | 'cancelled'
      message: string
      /** Populated when a specific page caused the failure. */
      pageIndex?: number
    }

export interface SavedChapterInfo {
  chapterId: string
  mangaId: string
  mangaTitle: string
  chapterName: string
  /** Images for a comic; the permille progress scale for a novel. */
  pageCount: number
  savedAt: number
  /** Whether the chapter has been read, which is what a cleanup sweeps on. */
  read: boolean
  /** Comic or novel, which decides how the two byte figures were arrived at. */
  contentKind: ContentKind
  /**
   * Quota cost estimate: `pageCount * OPAQUE_PADDING_BYTES` for a comic. A
   * novel's prose is readable, so it is measured rather than projected and this
   * carries the measured length instead.
   *
   * Only what to fall back to. A comic whose pages were readable carries a real
   * `measuredBytes`, and `chapterBytes` prefers it.
   */
  projectedBytes: number
  /**
   * Measured cost, or null for a chapter whose pages arrived opaque and for
   * rows saved before measuring existed.
   */
  measuredBytes: number | null
}

/** What to show for a saved chapter: the measurement if there is one. */
export function chapterBytes(entry: {
  projectedBytes: number
  measuredBytes: number | null
}): number {
  return entry.measuredBytes ?? entry.projectedBytes
}

/**
 * Quota an about-to-be-saved chapter is expected to consume.
 *
 * Assumes every page will be stored opaque, which is true of a source read
 * straight off its CDN and false of one proxied through this origin. It has no
 * way to tell them apart, so it is the pessimistic bound rather than a
 * prediction, and it is superseded by the measurement once the save lands.
 */
export function projectQuotaCost(pageCount: number): number {
  return pageCount * OPAQUE_PADDING_BYTES
}

export function supportsOfflineSave(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof caches !== 'undefined'
  )
}
