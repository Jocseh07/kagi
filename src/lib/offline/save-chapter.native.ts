import { File, FileMode, Paths } from 'expo-file-system'

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
import { chapterDirectory, pageFile } from './files'

import {
  DEFAULT_SAVED_CHAPTER_LIMIT,
  MAX_SAVED_CHAPTER_LIMIT,
  SAVED_CHAPTER_LIMIT_UNLIMITED,
  SETTING_SAVED_CHAPTER_LIMIT,
} from './types'
import type { SaveChapterResult, SaveOptions, SaveProgress } from './types'
import { describeError } from '@/lib/ui/describe-error'

const PAGE_TIMEOUT_MS = 30_000
const PAGE_ATTEMPTS = 3
const RETRY_DELAY_MS = 1_500
const DEFAULT_PAGE_INTERVAL_MS = 1_100
/** Saving stops before the device is completely full, so the OS and the database keep room. */
const MIN_FREE_BYTES = 200 * 1024 * 1024

/** Next permitted fetch per host, shared by every save running at once. */
const nextSlot = new Map<string, number>()

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
  if (aborted(options.signal)) return cancelled()

  const directory = chapterDirectory(chapterId)
  try {
    if (!directory.exists) directory.create({ intermediates: true, idempotent: true })
  } catch (error) {
    return { ok: false, reason: 'network', message: `Could not create the chapter folder: ${describeError(error)}` }
  }

  const total = pages.length
  report(options, { phase: 'fetching', completed: 0, total })

  let completed = 0
  for (const [position, page] of pages.entries()) {
    if (aborted(options.signal)) return cancelled()
    const file = pageFile(chapterId, page.index)

    if (file.exists && isImageFile(file)) {
      completed += 1
      report(options, { phase: 'fetching', completed, total })
      continue
    }

    if (freeBytes() < MIN_FREE_BYTES) {
      const evicted = await evictOldestIfCapped(chapterId)
      return {
        ok: false,
        reason: 'quota-exceeded',
        message: quotaMessage(position, total, evicted),
        pageIndex: position,
      }
    }

    const fetched = await fetchPage(page.imageUrl, file, options)
    if (fetched === 'cancelled') return cancelled()
    if (fetched !== null) {
      return {
        ok: false,
        reason: 'network',
        message: `Page ${position + 1} of ${total} could not be fetched: ${fetched}`,
        pageIndex: position,
      }
    }

    if (!isImageFile(file)) {
      deleteQuietly(file)
      return {
        ok: false,
        reason: 'verify-failed',
        message:
          `Page ${position + 1} of ${total} is not a readable image. ` +
          'The host most likely returned an error page in its place, so this chapter was not saved.',
        pageIndex: position,
      }
    }

    completed += 1
    report(options, { phase: 'fetching', completed, total })
  }

  if (aborted(options.signal)) return cancelled()

  const bytes = pages.reduce((sum, page) => sum + sizeOf(pageFile(chapterId, page.index)), 0)
  await saveChapterPages(chapterId, pages)
  await markChapterSaved(chapterId, true, true)
  await setChapterSavedBytes(chapterId, bytes)
  await enforceLimit(chapterId)

  return { ok: true, pageCount: pages.length, projectedBytes: bytes, measuredBytes: bytes }
}

/** Null on success, `'cancelled'` when the caller aborted, otherwise the last error. */
async function fetchPage(
  url: string,
  file: File,
  options: SaveOptions,
): Promise<string | 'cancelled' | null> {
  let lastError = 'no response'
  for (let attempt = 1; attempt <= PAGE_ATTEMPTS; attempt += 1) {
    if (aborted(options.signal)) return 'cancelled'
    await takeTurn(url, options.minIntervalMs ?? DEFAULT_PAGE_INTERVAL_MS, options.signal)
    if (aborted(options.signal)) return 'cancelled'

    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS)
    try {
      await File.downloadFileAsync(url, file, { idempotent: true, signal: controller.signal })
      return null
    } catch (error) {
      deleteQuietly(file)
      if (aborted(options.signal)) return 'cancelled'
      lastError = controller.signal.aborted ? 'the host did not answer in time' : describeError(error)
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    if (attempt < PAGE_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt, options.signal)
  }
  return lastError
}

/** Paces fetches per host: the source's own limiter never sees page images. */
async function takeTurn(url: string, intervalMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (intervalMs <= 0) return
  const host = hostOf(url)
  const now = Date.now()
  const slot = Math.max(now, nextSlot.get(host) ?? 0)
  nextSlot.set(host, slot + intervalMs)
  if (slot > now) await sleep(slot - now, signal)
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (aborted(signal)) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

export async function backgroundDownloadsAvailable(): Promise<boolean> {
  return false
}

/** Saves always verify as they go here; this only settles rows left unverified elsewhere. */
export async function verifyPendingChapters(): Promise<void> {
  try {
    for (const chapterId of await listUnverifiedChapterIds()) {
      const pages = await getChapterPages(chapterId)
      const complete =
        pages.length > 0 && pages.every((page) => isImageFile(pageFile(chapterId, page.index)))
      if (complete) await markChapterVerified(chapterId)
      else await unsaveChapter(chapterId)
    }
  } catch {
    // Opportunistic: whatever is missed keeps its mark and is checked next time.
  }
}

export async function unsaveChapter(chapterId: string): Promise<void> {
  const directory = chapterDirectory(chapterId)
  try {
    if (directory.exists) directory.delete()
  } catch {
    // The rows still go: a folder that cannot be removed is found by the orphan sweep.
  }
  await deleteSavedChapterRows(chapterId)
}

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

async function enforceLimit(keepChapterId: string): Promise<void> {
  try {
    const limit = await getSavedChapterLimit()
    if (limit === SAVED_CHAPTER_LIMIT_UNLIMITED) return
    let saved = await listSavedChapters()
    while (saved.length > limit) {
      const oldest = saved.find((entry) => entry.chapterId !== keepChapterId)
      if (!oldest) return
      await unsaveChapter(oldest.chapterId)
      saved = saved.filter((entry) => entry.chapterId !== oldest.chapterId)
    }
  } catch {
    // The save itself succeeded; a failed trim is not worth reporting as one.
  }
}

async function evictOldestIfCapped(exceptChapterId: string): Promise<string | null> {
  try {
    if ((await getSavedChapterLimit()) === SAVED_CHAPTER_LIMIT_UNLIMITED) return null
    const saved = await listSavedChapters()
    const oldest = saved.find((entry) => entry.chapterId !== exceptChapterId)
    if (!oldest) return null
    await unsaveChapter(oldest.chapterId)
    return `${oldest.mangaTitle}, ${oldest.chapterName}`
  } catch {
    return null
  }
}

function quotaMessage(index: number, total: number, evicted: string | null): string {
  const base = `Storage ran out after ${index} of ${total} pages.`
  return evicted
    ? `${base} The oldest saved chapter (${evicted}) was removed to make room. Try again.`
    : `${base} Delete saved chapters in Downloads, then try again.`
}

/** JPEG, PNG, GIF, WebP, AVIF, HEIC and BMP, by their leading bytes. */
function isImageFile(file: File): boolean {
  try {
    if (!file.exists || file.size <= 0) return false
    const handle = file.open(FileMode.ReadOnly)
    try {
      return looksLikeImage(handle.readBytes(12))
    } finally {
      handle.close()
    }
  } catch {
    return false
  }
}

function looksLikeImage(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  const [a, b, c, d] = bytes
  if (a === 0xff && b === 0xd8 && c === 0xff) return true
  if (a === 0x89 && b === 0x50 && c === 0x4e && d === 0x47) return true
  if (a === 0x47 && b === 0x49 && c === 0x46) return true
  if (a === 0x42 && b === 0x4d) return true
  const ascii = String.fromCharCode(...bytes)
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return true
  return ascii.slice(4, 8) === 'ftyp'
}

function sizeOf(file: File): number {
  try {
    return file.exists ? file.size : 0
  } catch {
    return 0
  }
}

function freeBytes(): number {
  try {
    return Paths.availableDiskSpace
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function deleteQuietly(file: File): void {
  try {
    if (file.exists) file.delete()
  } catch {
    // Overwritten by the next attempt, or removed by the orphan sweep.
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
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


function normaliseLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed)) return DEFAULT_SAVED_CHAPTER_LIMIT
  if (parsed <= 0) return SAVED_CHAPTER_LIMIT_UNLIMITED
  return Math.min(MAX_SAVED_CHAPTER_LIMIT, parsed)
}
