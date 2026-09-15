import { BlobReader, BlobWriter, ZipWriter, configure } from '@zip.js/zip.js'

import type { Page } from '../sources/types'

export type DownloadResult =
  | { ok: true; blob: Blob; filename: string; pageCount: number }
  | DownloadFailure

/**
 * Every failure carries the specific reason. The UI must never collapse these
 * into "download failed" — a CORS refusal and a 404 need different answers from
 * the user, and only one of them is fixable by retrying.
 */
export type DownloadFailure =
  | {
      ok: false
      reason: 'cors-blocked'
      host: string
      url: string
      pageIndex: number
      message: string
    }
  | {
      ok: false
      reason: 'network'
      host: string
      url: string
      pageIndex: number
      message: string
    }
  | {
      ok: false
      reason: 'http-status'
      status: number
      url: string
      pageIndex: number
      message: string
    }
  | { ok: false; reason: 'no-pages'; message: string }
  | { ok: false; reason: 'cancelled'; message: string }
  | { ok: false; reason: 'zip-failed'; message: string }

export interface DownloadOptions {
  filename?: string
  signal?: AbortSignal
  onProgress?(completed: number, total: number): void
}

/**
 * Fetch every page and pack them into a CBZ.
 *
 * This needs to *read* the image bytes, which a browser only allows for hosts
 * that send CORS headers. Sources whose CDN omits them can be displayed but not
 * downloaded, and that comes back as `reason: 'cors-blocked'`.
 */
export async function downloadChapter(
  pages: Page[],
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  if (pages.length === 0) {
    return {
      ok: false,
      reason: 'no-pages',
      message: 'This chapter has no pages to download.',
    }
  }

  // Pages are already-compressed images and deflating them again wins nothing,
  // so entries are stored. Keeping it off the worker pool keeps the bundle
  // free of a second entry point.
  configure({ useWebWorkers: false })

  const filename = options.filename ?? 'chapter.cbz'
  const zipWriter = new ZipWriter(
    new BlobWriter('application/vnd.comicbook+zip'),
  )

  try {
    for (const [position, page] of pages.entries()) {
      if (options.signal?.aborted) return cancelled()

      const fetched = await fetchPageBlob(page, position, options.signal)
      if (!fetched.ok) {
        await discard(zipWriter)
        return fetched
      }

      await zipWriter.add(
        `${String(position + 1).padStart(4, '0')}${extensionFor(page.imageUrl, fetched.blob)}`,
        new BlobReader(fetched.blob),
        { level: 0 },
      )
      options.onProgress?.(position + 1, pages.length)
    }

    const blob = await zipWriter.close()
    return { ok: true, blob, filename, pageCount: pages.length }
  } catch (error) {
    await discard(zipWriter)
    if (isAbortError(error)) return cancelled()
    return {
      ok: false,
      reason: 'zip-failed',
      message: `Could not build the CBZ: ${messageOf(error)}`,
    }
  }
}

type FetchedPage = { ok: true; blob: Blob } | DownloadFailure

async function fetchPageBlob(
  page: Page,
  pageIndex: number,
  signal?: AbortSignal,
): Promise<FetchedPage> {
  const url = page.imageUrl
  const host = hostOf(url)

  let response: Response
  try {
    response = await fetch(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal,
    })
  } catch (error) {
    if (isAbortError(error)) return cancelled()

    // A cross-origin refusal arrives as an opaque TypeError with no detail. A
    // `no-cors` probe reaching the host proves the failure was CORS policy and
    // not DNS, TLS or connectivity.
    const reachable = await fetch(url, { mode: 'no-cors', credentials: 'omit' })
      .then(() => true)
      .catch(() => false)

    if (reachable) {
      return {
        ok: false,
        reason: 'cors-blocked',
        host,
        url,
        pageIndex,
        message:
          `${host} serves page images without CORS headers. The browser will ` +
          `display them but refuses to let this page read their bytes, so a ` +
          `CBZ cannot be built.`,
      }
    }

    return {
      ok: false,
      reason: 'network',
      host,
      url,
      pageIndex,
      message: `Could not reach ${host} to fetch page ${pageIndex + 1}.`,
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: 'http-status',
      status: response.status,
      url,
      pageIndex,
      message: `${host} answered HTTP ${response.status} for page ${pageIndex + 1}.`,
    }
  }

  try {
    return { ok: true, blob: await response.blob() }
  } catch (error) {
    if (isAbortError(error)) return cancelled()
    return {
      ok: false,
      reason: 'network',
      host,
      url,
      pageIndex,
      message: `Page ${pageIndex + 1} could not be read: ${messageOf(error)}`,
    }
  }
}

/** Trigger a browser save for a finished archive. */
export function saveBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000)
}

export function cbzFilename(mangaTitle: string, chapterName: string): string {
  const safe = (value: string) =>
    value
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  return `${safe(mangaTitle) || 'manga'} - ${safe(chapterName) || 'chapter'}.cbz`
}

// ---------------------------------------------------------------- internals --

function cancelled(): DownloadFailure {
  return {
    ok: false,
    reason: 'cancelled',
    message: 'Download cancelled.',
  }
}

async function discard(zipWriter: ZipWriter<Blob>): Promise<void> {
  try {
    await zipWriter.close()
  } catch {
    // The archive is being thrown away; a close failure here is not the error
    // worth reporting.
  }
}

function extensionFor(url: string, blob: Blob): string {
  try {
    const match = new URL(url).pathname.match(/\.(jpe?g|png|webp|avif|gif)$/i)
    if (match) return `.${match[1].toLowerCase()}`
  } catch {
    // Fall through to the MIME type.
  }

  const fromType: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/gif': '.gif',
  }
  return fromType[blob.type] ?? '.jpg'
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'the image host'
  }
}
