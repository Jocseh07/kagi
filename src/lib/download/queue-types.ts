/**
 * Download queue contract.
 *
 * The queue persists one row per chapter waiting to be saved offline, so a
 * reload or a crash resumes instead of starting over. This module is the shared
 * vocabulary between the persistence layer (`queue-repository.ts`) and the
 * runtime that drains the queue; it holds types and constants only.
 */

export type QueueState =
  | 'queued'
  | 'active'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled'

export const QUEUE_STATES: readonly QueueState[] = [
  'queued',
  'active',
  'paused',
  'done',
  'failed',
  'cancelled',
]

/** States a row never leaves on its own; `clearFinished` collects these. */
export const TERMINAL_QUEUE_STATES: readonly QueueState[] = [
  'done',
  'failed',
  'cancelled',
]

/** States that still represent outstanding work. */
export const PENDING_QUEUE_STATES: readonly QueueState[] = [
  'queued',
  'active',
  'paused',
]

export interface QueueItem {
  id: string
  chapterId: string
  mangaId: string
  sourceId: string
  /**
   * Title and chapter labels are denormalised onto the row so the queue view
   * renders without joining manga and chapters on every poll.
   */
  mangaTitle: string
  chapterName: string
  chapterUrl: string
  state: QueueState
  /** Sort key. Contiguous from 0 after a reorder, sparse after a removal. */
  position: number
  pagesCompleted: number
  /** 0 until the runtime has fetched the chapter's page list. */
  pagesTotal: number
  attempts: number
  lastError: string | null
  queuedAt: number
  startedAt: number | null
  finishedAt: number | null
}

/** Identity of a chapter being added to the queue; bookkeeping is the repository's. */
export interface EnqueueChapterInput {
  chapterId: string
  mangaId: string
  sourceId: string
  mangaTitle: string
  chapterName: string
  chapterUrl: string
  /** Supply when the page count is already known, otherwise it starts at 0. */
  pagesTotal?: number
}

/** Optional fields `setItemState` may write alongside the new state. */
export interface QueueItemPatch {
  pagesCompleted?: number
  pagesTotal?: number
  attempts?: number
  lastError?: string | null
  startedAt?: number | null
  finishedAt?: number | null
}

export type QueueCounts = Record<QueueState, number>

export interface QueueSummary {
  counts: QueueCounts
  /** Rows in the queue, in every state. */
  total: number
  /**
   * Quota the unfinished rows are expected to consume once saved. Only counts
   * pages the runtime already knows about, so a freshly enqueued batch reads as
   * 0 until its page lists have been fetched.
   */
  projectedBytes: number
}

/** Failed saves are retried up to this many times before the row sticks at `failed`. */
export const MAX_ATTEMPTS = 3

/**
 * Queued rows handed to Background Fetch per loop pass, by kind.
 *
 * The queue loop lives in the page, and a locked screen freezes the page, so
 * without this only the chapter already running survives a lock. Every queued
 * row is registered with the browser ahead of time; the loop adopts each
 * result when its turn comes. Priming is batched per two-second pass rather
 * than done at once because each registration first hits the source: a page
 * list lookup for a comic, and for a novel the chapter fetch itself, which the
 * browser issues outside the source's rate limiter. Once registered, the runs
 * download in parallel.
 */
export const PRIME_COMIC_BATCH = 4
export const PRIME_NOVEL_BATCH = 1

/**
 * Chapters of one series saved in parallel by default.
 *
 * The real limiter is the source's own rate limit — Asura, for instance, allows
 * 2 requests per 2 seconds — and the service worker holds every parallel
 * chapter of one host to that shared budget. Widening this spreads the same
 * rate over more chapters at once; it does not download faster. One at a time
 * therefore finishes each chapter, and makes it readable, as early as possible.
 */
export const DEFAULT_QUEUE_CONCURRENCY = 1

export const MIN_QUEUE_CONCURRENCY = 1

/**
 * Ceiling on parallel chapters within one comic series.
 *
 * Since the host's rate is fixed, every extra chapter only slows the others
 * down, so this is a generous bound rather than a recommendation: past a
 * handful the page is full of bars crawling too slowly to read.
 */
export const MAX_QUEUE_CONCURRENCY = 10

export const COMIC_CONCURRENCY_CHOICES: readonly number[] = Array.from(
  { length: MAX_QUEUE_CONCURRENCY - MIN_QUEUE_CONCURRENCY + 1 },
  (_, index) => MIN_QUEUE_CONCURRENCY + index,
)

export const SETTING_QUEUE_CONCURRENCY = 'download.queue_concurrency'

/**
 * Chapters of one novel series saved in parallel.
 *
 * A novel chapter is a single text fetch through the source's own limiter, not
 * a page list handed to the service worker, so many can be in flight without
 * the per-image pacing that bounds a comic. The choices are coarse at the top
 * end because the difference between 11 and 12 is not worth a menu entry.
 */
export const NOVEL_CONCURRENCY_CHOICES: readonly number[] = [1, 2, 3, 5, 10, 25]

export const DEFAULT_NOVEL_CONCURRENCY = 1

export const MIN_NOVEL_CONCURRENCY = NOVEL_CONCURRENCY_CHOICES[0]

export const MAX_NOVEL_CONCURRENCY =
  NOVEL_CONCURRENCY_CHOICES[NOVEL_CONCURRENCY_CHOICES.length - 1]

export const SETTING_NOVEL_CONCURRENCY = 'download.novel_concurrency'

/**
 * Series worked on in parallel by default.
 *
 * Queueing a long backlog of one series would otherwise hold up everything
 * behind it. Spreading the work across series means each one starts moving
 * straight away, which matters more than any single series finishing first.
 */
export const DEFAULT_MANGA_CONCURRENCY = 4

export const MIN_MANGA_CONCURRENCY = 1

/** Ceiling on parallel series, for the same reason as `MAX_QUEUE_CONCURRENCY`. */
export const MAX_MANGA_CONCURRENCY = 4

export const SETTING_MANGA_CONCURRENCY = 'download.manga_concurrency'

/**
 * Opt in to finished rows leaving the queue by themselves. Off unless the key
 * holds `'1'`; turning it on affects chapters that finish afterwards, never the
 * rows already sitting there.
 */
export const SETTING_AUTO_CLEAR_FINISHED = 'download.auto_clear_finished'

/** Anything unparseable or out of range falls back to the default. */
export function normaliseConcurrency(raw: string | null | number): number {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed)) return DEFAULT_QUEUE_CONCURRENCY
  return Math.min(MAX_QUEUE_CONCURRENCY, Math.max(MIN_QUEUE_CONCURRENCY, parsed))
}

/**
 * Anything unparseable or out of range falls back to the default; anything
 * between two choices snaps down to the lower one, so a value stored before
 * the list changed still names a real menu entry.
 */
export function normaliseNovelConcurrency(raw: string | null | number): number {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed)) return DEFAULT_NOVEL_CONCURRENCY
  const clamped = Math.min(
    MAX_NOVEL_CONCURRENCY,
    Math.max(MIN_NOVEL_CONCURRENCY, parsed),
  )
  let snapped = MIN_NOVEL_CONCURRENCY
  for (const choice of NOVEL_CONCURRENCY_CHOICES) {
    if (choice <= clamped) snapped = choice
  }
  return snapped
}

/** Anything unparseable or out of range falls back to the default. */
export function normaliseMangaConcurrency(raw: string | null | number): number {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed)) return DEFAULT_MANGA_CONCURRENCY
  return Math.min(MAX_MANGA_CONCURRENCY, Math.max(MIN_MANGA_CONCURRENCY, parsed))
}
