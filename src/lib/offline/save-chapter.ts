/**
 * Saving a chapter for offline reading.
 *
 * Three steps, in order: ask the worker to cache every page URL, prove each
 * cached entry is really an image, then record the page list in the database so
 * the reader can rebuild the chapter with no network. The middle step exists
 * because a cached opaque response hides its status — a 404 page and a real
 * image look identical from here, and the only way to tell them apart is to
 * hand the URL to an `<img>` and see whether it decodes.
 */

import {
  deleteSavedChapterRows,
  getChapterPages,
  getSetting,
  listSavedChapters,
  listUnverifiedChapterIds,
  markChapterSaved,
  markChapterVerified,
  saveChapterPages,
  setChapterSavedBytes,
  setSetting,
} from '@/lib/db/repositories'
import type { Page } from '@/lib/sources/types'

import {
  backgroundFetchIdFor,
  cancelBackgroundFetch,
  runBackgroundFetch,
  supportsBackgroundFetch,
} from './background-fetch'
import { ServiceWorkerError, cachePages, deletePages, isServiceWorkerReady } from './register'
import type { CachePageOutcome } from './register'
import {
  DEFAULT_SAVED_CHAPTER_LIMIT,
  MAX_SAVED_CHAPTER_LIMIT,
  SAVED_CHAPTER_LIMIT_UNLIMITED,
  SETTING_BACKGROUND_DOWNLOADS,
  SETTING_SAVED_CHAPTER_LIMIT,
  SUSPEND_ABORT_REASON,
  projectQuotaCost,
  supportsOfflineSave,
} from './types'
import type { SaveChapterResult, SaveOptions, SaveProgress } from './types'

/**
 * Decoding every page at once stalls the main thread and makes the progress
 * counter useless; one at a time is needlessly slow on a 40 page chapter.
 */
const VERIFY_CONCURRENCY = 6

/**
 * What the save really cost, or null when any page could not be counted.
 *
 * The worker fetched these pages and so held every response; it reports each
 * one's size where it could read it. A cross-origin page arrives opaque, which
 * is unreadable and charged a fixed padding against quota regardless of what it
 * weighs, so one such page makes the chapter's total unknowable and the caller
 * falls back to `projectQuotaCost`. Sources proxied through this origin are
 * readable end to end and sum to an exact figure.
 *
 * This replaced a before/after read of `navigator.storage.estimate()`, which
 * could not survive the queue downloading four chapters at once: each save saw
 * the others' bytes, so the reading had to be discarded most of the time.
 */
function sumBytes(outcomes: readonly CachePageOutcome[]): number | null {
  let total = 0
  for (const outcome of outcomes) {
    if (outcome.bytes === null) return null
    total += outcome.bytes
  }
  return total
}

export async function saveChapter(
  chapterId: string,
  pages: readonly Page[],
  options: SaveOptions = {},
): Promise<SaveChapterResult> {
  if (pages.length === 0) {
    return {
      ok: false,
      reason: 'no-pages',
      message: 'This chapter has no pages, so there is nothing to save.',
    }
  }

  if (!supportsOfflineSave()) {
    return {
      ok: false,
      reason: 'no-service-worker',
      message:
        'This browser has no service worker or Cache API support, so chapters cannot be kept for offline reading.',
    }
  }

  if (!(await isServiceWorkerReady())) {
    return {
      ok: false,
      reason: 'no-service-worker',
      message:
        'The offline service worker is not running on this page yet. Reload and try again.',
    }
  }

  if (aborted(options.signal)) return cancelled()

  const urls = pages.map((page) => page.imageUrl)
  report(options, { phase: 'fetching', completed: 0, total: urls.length })

  return await runSave(chapterId, pages, urls, options)
}

async function runSave(
  chapterId: string,
  pages: readonly Page[],
  urls: string[],
  options: SaveOptions,
): Promise<SaveChapterResult> {
  let outcomes: CachePageOutcome[]
  try {
    outcomes = await fetchPages(chapterId, urls, options)
  } catch (error) {
    if (aborted(options.signal)) {
      await discardUnlessSuspended(urls, options)
      return cancelled()
    }
    return failedRequest(error)
  }

  if (aborted(options.signal)) {
    await discardUnlessSuspended(urls, options)
    return cancelled()
  }

  const stored = new Map(outcomes.map((outcome) => [outcome.url, outcome]))
  const rejected = firstRejection(urls, stored)
  if (rejected) {
    await discard(urls)
    if (rejected.quota) {
      const evicted = await evictOldestIfCapped(chapterId)
      return {
        ok: false,
        reason: 'quota-exceeded',
        message: quotaMessage(rejected.index, urls.length, evicted),
        pageIndex: rejected.index,
      }
    }
    return {
      ok: false,
      reason: 'network',
      message: `Page ${rejected.index + 1} of ${urls.length} could not be fetched: ${rejected.message}`,
      pageIndex: rejected.index,
    }
  }

  report(options, { phase: 'fetching', completed: urls.length, total: urls.length })

  // Verification needs an `<img>` to load, and a hidden document deprioritises
  // image loading — under a frozen page it does not happen at all. Failing here
  // would throw away pages that are already cached and paid for, so a save that
  // lands in the background is kept as unverified instead and checked by
  // `verifyPendingChapters` the moment the app is visible again.
  if (documentHidden()) {
    return await persist(chapterId, pages, sumBytes(outcomes), false)
  }

  report(options, { phase: 'verifying', completed: 0, total: urls.length })

  const verified = await verifyAll(urls, options)
  if (!verified.ok) {
    if (verified.cancelled) {
      await discardUnlessSuspended(urls, options)
      return cancelled()
    }
    // A document that went away mid-check proves nothing either way, so the
    // pages are kept rather than deleted on the strength of a stalled load.
    if (documentHidden()) {
      return await persist(chapterId, pages, sumBytes(outcomes), false)
    }
    await discard(urls)
    return {
      ok: false,
      reason: 'verify-failed',
      message: verified.message,
      pageIndex: verified.index,
    }
  }

  return await persist(chapterId, pages, sumBytes(outcomes), true)
}

/** Writes the rows that turn cached bytes into a chapter the reader can open. */
async function persist(
  chapterId: string,
  pages: readonly Page[],
  measuredBytes: number | null,
  verified: boolean,
): Promise<SaveChapterResult> {
  await saveChapterPages(chapterId, pages)
  await markChapterSaved(chapterId, true, verified)
  if (measuredBytes !== null) {
    await setChapterSavedBytes(chapterId, measuredBytes)
  }
  await enforceLimit(chapterId)

  return {
    ok: true,
    pageCount: pages.length,
    projectedBytes: projectQuotaCost(pages.length),
    measuredBytes,
  }
}

/**
 * Gets the pages into the cache, by whichever transport this browser has.
 *
 * Background Fetch is preferred because it is the only one that survives the
 * app being hidden, backgrounded, or closed. It is not always there — it is
 * Chromium-only — and it can refuse a registration, so a failure that is not
 * the user's own cancellation falls back to the paced in-page path rather than
 * failing the item outright.
 */
async function fetchPages(
  chapterId: string,
  urls: readonly string[],
  options: SaveOptions,
): Promise<CachePageOutcome[]> {
  const onProgress = (progress: { completed: number; total: number }): void =>
    report(options, {
      phase: 'fetching',
      completed: progress.completed,
      total: progress.total,
    })

  if (await backgroundDownloadsAvailable()) {
    try {
      return await runBackgroundFetch({
        id: backgroundFetchIdFor(chapterId),
        urls,
        title: options.title ?? 'Downloading chapter',
        signal: options.signal,
        onProgress,
      })
    } catch (error) {
      // A cancelled run is not a broken transport: the caller's abort check
      // turns the empty result into `cancelled` a few lines later.
      if (options.signal?.aborted) return []
      await cancelBackgroundFetch(backgroundFetchIdFor(chapterId))
      void error
    }
  }

  return await cachePages(urls, options.minIntervalMs, onProgress, options.signal)
}

/** Whether a save here would go through Background Fetch. */
export async function backgroundDownloadsAvailable(): Promise<boolean> {
  return supportsBackgroundFetch() && (await backgroundDownloadsEnabled())
}

/** Default on: see `SETTING_BACKGROUND_DOWNLOADS`. */
async function backgroundDownloadsEnabled(): Promise<boolean> {
  try {
    return (await getSetting(SETTING_BACKGROUND_DOWNLOADS)) !== '0'
  } catch {
    return true
  }
}

// ------------------------------------------------------ deferred verifying --

let sweeping = false

/**
 * Proves the pages of chapters that were saved while the app was hidden.
 *
 * Called when the app becomes visible. A chapter whose pages do not all decode
 * is unsaved outright: an opaque cache entry hides its status, so an error page
 * stored in place of an image is indistinguishable from the real thing until
 * something tries to draw it, and half a chapter is worse than none.
 */
export async function verifyPendingChapters(): Promise<void> {
  if (sweeping || documentHidden() || !supportsOfflineSave()) return
  sweeping = true
  try {
    for (const chapterId of await listUnverifiedChapterIds()) {
      if (documentHidden()) return
      const pages = await getChapterPages(chapterId)
      if (pages.length === 0) {
        // Nothing to prove, and nothing to read either: a saved comic with no
        // page rows cannot be opened, so it is not worth keeping.
        await unsaveChapter(chapterId)
        continue
      }

      const verified = await verifyAll(
        pages.map((page) => page.imageUrl),
        {},
      )
      if (verified.ok) {
        await markChapterVerified(chapterId)
        continue
      }
      // A check interrupted by the app being hidden again decides nothing; the
      // chapter keeps its unverified mark and is picked up on the next sweep.
      if (documentHidden()) return
      await unsaveChapter(chapterId)
    }
  } catch {
    // The sweep is opportunistic. Anything it misses is still marked unverified
    // and comes round again on the next foreground.
  } finally {
    sweeping = false
  }
}

/** Drops a chapter's cached images and its saved rows. */
export async function unsaveChapter(chapterId: string): Promise<void> {
  // A background fetch outlives the page, so one may still be running for this
  // chapter even though nothing here is waiting on it.
  await cancelBackgroundFetch(backgroundFetchIdFor(chapterId))
  const pages = await getChapterPages(chapterId)
  if (pages.length > 0) {
    // A missing worker must not strand the database rows: without them the
    // chapter would show as saved forever with nothing behind it.
    await discard(pages.map((page) => page.imageUrl))
  }
  await deleteSavedChapterRows(chapterId)
}

/**
 * Drops every saved chapter. Sequential on purpose: each removal talks to the
 * service worker and then to the database, and running them at once only
 * contends for both.
 */
export async function unsaveAllChapters(): Promise<void> {
  for (const entry of await listSavedChapters()) {
    await unsaveChapter(entry.chapterId)
  }
}

export async function isChapterSaved(chapterId: string): Promise<boolean> {
  const saved = await listSavedChapters()
  return saved.some((entry) => entry.chapterId === chapterId)
}

export async function getSavedChapterLimit(): Promise<number> {
  try {
    return normaliseLimit(await getSetting(SETTING_SAVED_CHAPTER_LIMIT))
  } catch {
    return DEFAULT_SAVED_CHAPTER_LIMIT
  }
}

export async function setSavedChapterLimit(value: number): Promise<number> {
  const limit = normaliseLimit(String(value))
  await setSetting(SETTING_SAVED_CHAPTER_LIMIT, String(limit))
  return limit
}

// ------------------------------------------------------------------ verify --

type VerifyResult =
  | { ok: true }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; index: number; message: string }

interface VerifyFailure {
  index: number
  message: string
}

async function verifyAll(
  urls: readonly string[],
  options: SaveOptions,
): Promise<VerifyResult> {
  let next = 0
  let completed = 0
  let stopped = false

  const lane = async (): Promise<VerifyFailure | null> => {
    while (!stopped && !aborted(options.signal)) {
      const index = next
      next += 1
      if (index >= urls.length) return null

      const url = urls[index]
      if (url === undefined) return null

      if (await decodes(url)) {
        completed += 1
        report(options, { phase: 'verifying', completed, total: urls.length })
        continue
      }

      // One unreadable page invalidates the whole chapter, so the other lanes
      // are told to stop rather than finish work that is about to be thrown out.
      stopped = true
      return {
        index,
        message:
          `Page ${index + 1} of ${urls.length} was cached but is not a readable image. ` +
          'The host most likely returned an error page in its place, so nothing ' +
          'was kept for this chapter.',
      }
    }
    return null
  }

  const lanes = Math.min(VERIFY_CONCURRENCY, urls.length)
  const outcomes = await Promise.all(Array.from({ length: lanes }, () => lane()))
  const failures = outcomes.filter(
    (outcome): outcome is VerifyFailure => outcome !== null,
  )

  const earliest = failures.sort((a, b) => a.index - b.index)[0]
  if (earliest) {
    return {
      ok: false,
      cancelled: false,
      index: earliest.index,
      message: earliest.message,
    }
  }
  if (aborted(options.signal)) return { ok: false, cancelled: true }
  return { ok: true }
}

/**
 * True when the URL loads as an image.
 *
 * The load event rather than `decode()`, deliberately. `decode()` asks for a
 * fully rasterised frame, which a browser will not produce for a document it is
 * not painting: in a hidden tab the promise hangs or rejects with an
 * `EncodingError`, and a rejection here means a perfectly good chapter is
 * deleted for failing a check the browser declined to run. `load` only needs
 * the image parsed, which is exactly the question being asked — is this really
 * an image, or an error page the opaque response is hiding?
 *
 * `crossOrigin` is deliberately left unset: the cached response is opaque, and
 * asking for CORS would make the load fail on exactly the images that work.
 */
async function decodes(url: string): Promise<boolean> {
  if (typeof Image === 'undefined') return false
  return await new Promise<boolean>((resolve) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image.naturalWidth > 0)
    image.onerror = () => resolve(false)
    image.src = url
  })
}

function documentHidden(): boolean {
  return (
    typeof document === 'undefined' || document.visibilityState === 'hidden'
  )
}

// ------------------------------------------------------------------ eviction --

async function enforceLimit(keepChapterId: string): Promise<void> {
  try {
    const limit = await getSavedChapterLimit()
    if (limit === SAVED_CHAPTER_LIMIT_UNLIMITED) return
    let saved = await listSavedChapters()
    while (saved.length > limit) {
      // Oldest first, and never the chapter that was just saved.
      const oldest = saved.find((entry) => entry.chapterId !== keepChapterId)
      if (!oldest) return
      await unsaveChapter(oldest.chapterId)
      saved = saved.filter((entry) => entry.chapterId !== oldest.chapterId)
    }
  } catch {
    // The save itself succeeded. A failed trim is not worth reporting as one.
  }
}

/**
 * Frees the oldest saved chapter. Returns its title, if one was removed.
 *
 * Only when a cap is set. Under an unlimited limit the user has said to keep
 * everything, and quietly deleting a chapter to make room for another is the
 * behaviour that setting exists to switch off — running out of space is
 * reported instead, so the choice of what to drop stays theirs.
 */
async function evictOldestIfCapped(
  exceptChapterId: string,
): Promise<string | null> {
  try {
    if ((await getSavedChapterLimit()) === SAVED_CHAPTER_LIMIT_UNLIMITED) {
      return null
    }
    const saved = await listSavedChapters()
    const oldest = saved.find((entry) => entry.chapterId !== exceptChapterId)
    if (!oldest) return null
    await unsaveChapter(oldest.chapterId)
    return `${oldest.mangaTitle} — ${oldest.chapterName}`
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ helpers --

function firstRejection(
  urls: readonly string[],
  stored: ReadonlyMap<string, CachePageOutcome>,
): { index: number; message: string; quota: boolean } | null {
  for (const [index, url] of urls.entries()) {
    const outcome = stored.get(url)
    if (outcome?.ok) continue
    const message =
      outcome?.error ?? 'the service worker did not report on this page'
    return { index, message, quota: isQuotaError(message) }
  }
  return null
}

function isQuotaError(message: string): boolean {
  return message.toLowerCase().includes('quota')
}

function quotaMessage(
  index: number,
  total: number,
  evicted: string | null,
): string {
  // No per-page figure is quoted here. What a page really costs is measured
  // per save and shown in Settings; repeating a hardcoded projection would
  // contradict it on the browsers where the two disagree.
  const base = `Storage ran out after ${index} of ${total} pages.`
  return evicted
    ? `${base} The oldest saved chapter (${evicted}) was removed to make room. Try again.`
    : `${base} Remove saved chapters under Settings → Downloads, then try again.`
}

/**
 * A suspended save is not abandoned: its pages wait in the cache for the same
 * chapter to be picked up again, and the worker skips what is already there.
 */
async function discardUnlessSuspended(
  urls: readonly string[],
  options: SaveOptions,
): Promise<void> {
  if (options.signal?.reason === SUSPEND_ABORT_REASON) return
  await discard(urls)
}

/** Removes anything this attempt cached, so an abandoned save costs nothing. */
async function discard(urls: readonly string[]): Promise<void> {
  try {
    await deletePages(urls)
  } catch {
    // Nothing better to do: the worker is gone, and the entries it holds will
    // be evicted with the cache version.
  }
}

function failedRequest(error: unknown): SaveChapterResult {
  if (error instanceof ServiceWorkerError) {
    if (error.code === 'unsupported' || error.code === 'no-controller') {
      return { ok: false, reason: 'no-service-worker', message: error.message }
    }
    return { ok: false, reason: 'network', message: error.message }
  }
  return {
    ok: false,
    reason: 'network',
    message: error instanceof Error ? error.message : String(error),
  }
}

function cancelled(): SaveChapterResult {
  return { ok: false, reason: 'cancelled', message: 'Saving was cancelled.' }
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function report(options: SaveOptions, progress: SaveProgress): void {
  options.onProgress?.(progress)
}

/** Anything at or below zero means "keep everything"; see the sentinel. */
function normaliseLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed)) return DEFAULT_SAVED_CHAPTER_LIMIT
  if (parsed <= 0) return SAVED_CHAPTER_LIMIT_UNLIMITED
  return Math.min(MAX_SAVED_CHAPTER_LIMIT, parsed)
}
