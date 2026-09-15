/**
 * Shared zip.js access for the local source.
 *
 * zip.js is loaded on demand: the source registry is imported by every route,
 * and an unzipper is only needed once a CBZ is actually opened.
 *
 * `useWebWorkers: false` matches `lib/images/download`. `configure` is global,
 * so the two callers have to agree; a worker pool that only half the app
 * expected would be worse than decompressing on this thread.
 */

import type { FileEntry } from '@zip.js/zip.js'

export async function loadZip() {
  const zip = await import('@zip.js/zip.js')
  zip.configure({ useWebWorkers: false })
  return zip
}

/**
 * One named entry of an archive, as text.
 *
 * Only the central directory is read and only the matching entry is inflated,
 * so pulling a `ComicInfo.xml` out of a 200 MB chapter never touches its
 * images. Returns null when the archive has no such entry, which is the
 * common case and must stay cheap.
 */
export async function readArchiveEntryText(
  file: File,
  entryName: string,
): Promise<string | null> {
  const { BlobReader, TextWriter, ZipReader } = await loadZip()
  const reader = new ZipReader(new BlobReader(file))
  const wanted = entryName.toLowerCase()

  try {
    // Case-insensitive and root-only: an archive written on Windows may hold
    // `comicinfo.xml`, but a `chapter/ComicInfo.xml` nested inside is not the
    // chapter's own metadata.
    const entry = (await reader.getEntries()).find(
      (candidate): candidate is FileEntry =>
        !candidate.directory && candidate.filename.toLowerCase() === wanted,
    )
    if (!entry) return null

    return await entry.getData(new TextWriter())
  } finally {
    await reader.close().catch(() => undefined)
  }
}
