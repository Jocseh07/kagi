/**
 * Saving a novel chapter for offline reading.
 *
 * The whole of `save-chapter.ts` exists to work around one fact: page images
 * come from CDNs that send no CORS headers, so their bytes cannot be read, only
 * parked opaquely in the Cache API and verified by handing them to an `<img>`.
 * None of that applies to prose. The text arrives as a readable string, so it is
 * fetched, sanitised and written to the database — no service worker, no
 * decode-to-verify pass, no quota measurement, and a cost equal to what the
 * chapter actually weighs rather than ~7 MB per page.
 */

import {
  deleteSavedChapterRows,
  getChapterText,
  markChapterSaved,
  saveChapterText,
  setChapterSavedBytes,
} from '@/lib/db/repositories'
import type { ChapterText, SChapter, SManga, TextSource } from '@/lib/sources/types'
import { isPrimableTextSource } from '@/lib/sources/types'

import { backgroundFetchIdFor, takeCachedBody } from './background-fetch'
import type { SaveChapterResult, SaveOptions } from './types'

/**
 * Refuses to store a chapter that came back empty.
 *
 * A site that has rate-limited or soft-blocked the reader commonly answers with
 * a valid page carrying nothing. Storing that would mark the chapter saved and
 * then show a blank reader with no way to tell it from a real empty chapter.
 *
 * Emptiness is judged on the markup, *not* on `textLength`: a novel's opening
 * illustrations are a real chapter that legitimately contains no prose at all,
 * and a text-length threshold would refuse to save one.
 */
function isEmpty(text: ChapterText): boolean {
  return !text.html.trim()
}

export async function saveChapterTextOffline(
  chapterId: string,
  source: TextSource,
  manga: SManga,
  chapter: SChapter,
  options: SaveOptions = {},
): Promise<SaveChapterResult> {
  if (options.signal?.aborted) return cancelled()

  options.onProgress?.({ phase: 'fetching', completed: 0, total: 1 })

  let text: ChapterText
  try {
    text = await fetchText(chapterId, source, manga, chapter, options.signal)
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) return cancelled()
    return {
      ok: false,
      reason: 'network',
      message: messageOf(error),
    }
  }

  if (options.signal?.aborted) return cancelled()

  if (isEmpty(text)) {
    return {
      ok: false,
      reason: 'no-pages',
      message:
        'This chapter came back empty. The source may have rate-limited the ' +
        'request or moved the chapter, so nothing was saved.',
    }
  }

  options.onProgress?.({ phase: 'fetching', completed: 1, total: 1 })

  try {
    await saveChapterText(chapterId, text)
    await markChapterSaved(chapterId, true)
    // Exact, not estimated: this is the size of the string that was stored.
    await setChapterSavedBytes(chapterId, byteLength(text.html))
  } catch (error) {
    // A half-written save would show as saved with nothing behind it.
    await deleteSavedChapterRows(chapterId).catch(() => undefined)
    return { ok: false, reason: 'network', message: messageOf(error) }
  }

  const bytes = byteLength(text.html)
  return {
    ok: true,
    // One chapter is one unit of work to the download queue; the permille
    // progress scale written onto the chapter row is a separate concern.
    pageCount: 1,
    projectedBytes: bytes,
    measuredBytes: bytes,
  }
}

/**
 * The chapter body, from a primed background run when one has landed.
 *
 * The queue hands novel chapters to Background Fetch ahead of time so they
 * download with the screen locked; the body waits in the page cache until this
 * row's turn. A miss is the ordinary case on browsers without Background Fetch
 * and falls through to the source's own paced fetch.
 */
async function fetchText(
  chapterId: string,
  source: TextSource,
  manga: SManga,
  chapter: SChapter,
  signal: AbortSignal | undefined,
): Promise<ChapterText> {
  if (isPrimableTextSource(source)) {
    const body = await takeCachedBody(
      backgroundFetchIdFor(chapterId),
      source.chapterTextUrl(manga, chapter),
    )
    if (body !== null) return source.parseChapterText(body)
  }
  return await source.getChapterText(manga, chapter, signal)
}

/** True when this chapter's prose is already stored. */
export async function hasSavedText(chapterId: string): Promise<boolean> {
  return (await getChapterText(chapterId)) !== null
}

/** UTF-8 length, since the column stores the string and not its code units. */
function byteLength(value: string): number {
  if (typeof TextEncoder === 'undefined') return value.length
  return new TextEncoder().encode(value).length
}

function cancelled(): SaveChapterResult {
  return { ok: false, reason: 'cancelled', message: 'Saving was cancelled.' }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}
