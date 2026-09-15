/**
 * What the origin's storage is actually made of.
 *
 * `navigator.storage.estimate()` reports one number for the whole origin and
 * never says what is inside it. These readers account for the three things this
 * app writes deliberately; whatever the browser charges beyond their sum is
 * reported as the remainder rather than hidden, so the parts always add up to
 * the total the browser gives.
 *
 * Every reader degrades to zero on its own. A browser missing the Cache API or
 * a database that has not opened yet must cost a row, not the whole panel.
 */

import { exec } from '@/lib/db/client'
import { listSavedChapters } from '@/lib/db/repositories'
import { SHELL_CACHE, chapterBytes } from '@/lib/offline/types'

import { estimate } from './persist'

export type StorageBucketId =
  | 'saved-chapters'
  | 'library'
  | 'app-shell'
  | 'other'

export interface StorageBucket {
  id: StorageBucketId
  label: string
  /** What is in it, in the reader's terms. */
  detail: string
  bytes: number
  /** False when `bytes` is projected rather than measured. */
  exact: boolean
}

export interface StorageBreakdown {
  /** What the browser reports for the whole origin, or null if it will not say. */
  total: number | null
  buckets: StorageBucket[]
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

// ----------------------------------------------------------- saved chapters --

/**
 * Counted from what each save recorded, not by re-reading the cache: a page
 * stored opaque has no readable size, so summing the entries here would report
 * zero for exactly the chapters that cost the most.
 *
 * The database's figure is exact for a source proxied through this origin,
 * whose pages the service worker could measure as it stored them, and projected
 * at 7 MB a page for one read straight off its CDN, whose pages it could not.
 */
async function savedChapters(): Promise<StorageBucket> {
  let bytes = 0
  let count = 0
  let exact = true

  try {
    const rows = await listSavedChapters()
    count = rows.length
    for (const row of rows) {
      bytes += chapterBytes(row)
      if (row.measuredBytes === null) exact = false
    }
  } catch {
    bytes = 0
    count = 0
    exact = true
  }

  return {
    id: 'saved-chapters',
    label: 'Saved chapters',
    detail:
      count === 0
        ? 'Nothing saved for offline reading'
        : `${plural(count, 'chapter')}, readable with no network`,
    bytes,
    exact,
  }
}

// ------------------------------------------------------------------ library --

async function scalar(sql: string): Promise<number> {
  const { rows } = await exec(sql)
  const value = rows[0]?.[0]
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * The SQLite file, sized from its own page accounting rather than from OPFS.
 * The pool preallocates its files and holds exclusive access handles on them,
 * so reading their sizes off the filesystem would both overstate the database
 * and risk throwing.
 */
async function library(): Promise<StorageBucket> {
  let bytes = 0
  let detail = 'Series, reading history and settings'

  try {
    const [pageCount, pageSize] = await Promise.all([
      scalar('PRAGMA page_count'),
      scalar('PRAGMA page_size'),
    ])
    bytes = pageCount * pageSize

    const { rows } = await exec(
      `SELECT (SELECT COUNT(*) FROM manga WHERE favorite = 1),
              (SELECT COUNT(*) FROM chapters),
              (SELECT COUNT(*) FROM history)`,
    )
    const row = rows[0]
    if (row) {
      const [favourites = 0, chapters = 0, history = 0] = row.map((value) =>
        Number(value ?? 0),
      )
      detail = [
        plural(favourites, 'favourite'),
        plural(chapters, 'chapter'),
        `${history} in history`,
      ].join(' · ')
    }
  } catch {
    // The database is still opening, or failed to open at all.
  }

  return {
    id: 'library',
    label: 'Library database',
    detail,
    bytes,
    exact: true,
  }
}

// ---------------------------------------------------------------- app shell --

/**
 * The precached copy of the app itself. These are same-origin responses, so
 * unlike page images their bytes really can be counted.
 */
async function appShell(): Promise<StorageBucket> {
  let bytes = 0
  let files = 0

  try {
    if (typeof caches !== 'undefined' && (await caches.has(SHELL_CACHE))) {
      const cache = await caches.open(SHELL_CACHE)
      const requests = await cache.keys()
      files = requests.length
      for (const request of requests) {
        const response = await cache.match(request)
        if (!response) continue
        bytes += (await response.blob()).size
      }
    }
  } catch {
    // No Cache API, or the entries went away mid-count.
  }

  return {
    id: 'app-shell',
    label: 'Offline copy of the app',
    detail:
      files === 0
        ? 'Not stored yet — the app needs the network to open'
        : `${plural(files, 'file')}, so the app opens without a network`,
    bytes,
    exact: true,
  }
}

// ------------------------------------------------------------------ readers --

export async function readStorageBreakdown(): Promise<StorageBreakdown> {
  const [usage, chapters, db, shell] = await Promise.all([
    estimate(),
    savedChapters(),
    library(),
    appShell(),
  ])

  const accounted = chapters.bytes + db.bytes + shell.bytes
  const total = usage?.usage ?? null

  const other: StorageBucket = {
    id: 'other',
    label: 'Other browser data',
    detail:
      'Reader preferences, this device’s id, the folder picked for local files, and the browser’s own overhead',
    // Saved chapters are projected wherever their pages could not be counted,
    // so the sum can overshoot what the browser reports. Never show that as a
    // negative row.
    bytes: total === null ? 0 : Math.max(0, total - accounted),
    // A remainder is only as certain as the figures subtracted from it.
    exact: chapters.exact,
  }

  return { total, buckets: [chapters, db, shell, other] }
}
